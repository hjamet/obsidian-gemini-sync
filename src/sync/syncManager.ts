import { App, TFile, Notice, TFolder } from 'obsidian';
import { DriveClient } from '../drive/driveClient';
import * as CryptoJS from 'crypto-js';
import { GeminiSyncSettings } from '../main';
import { ManifestManager, RemoteEntry, RemoteManifest } from './remoteManifest';

export class SyncManager {
    app: App;
    driveClient: DriveClient;
    settings: GeminiSyncSettings;
    statusBarItem: HTMLElement | null = null;
    isSyncing: boolean = false;
    cancelRequested: boolean = false;
    manifestManager: ManifestManager;
    private rootFolderId: string | null = null;
    private folderIdCache: Map<string, string> = new Map();
    onSaveSettings: () => Promise<void>;

    constructor(app: App, driveClient: DriveClient, settings: GeminiSyncSettings, statusBarItem: HTMLElement | undefined, onSaveSettings: () => Promise<void>) {
        this.app = app;
        this.driveClient = driveClient;
        this.settings = settings;
        this.statusBarItem = statusBarItem || null;
        this.onSaveSettings = onSaveSettings;
        this.manifestManager = new ManifestManager(driveClient);
    }

    public updateSettings(settings: GeminiSyncSettings) {
        if (this.settings.remoteFolderPath !== settings.remoteFolderPath) {
            this.rootFolderId = null;
            this.folderIdCache.clear();
        }
        this.settings = settings;
    }

    public cancelSync() {
        if (this.isSyncing) {
            this.cancelRequested = true;
            this.updateStatus('Gemini Sync: Cancelling...', undefined, false);
            new Notice('Gemini Sync: Cancellation requested...');
        }
    }

    public async forceResync() {
        if (this.isSyncing) {
            new Notice('Sync in progress, please wait.');
            return;
        }

        this.isSyncing = true;
        try {
            this.updateStatus('Gemini Sync: Deleting remote folder...', undefined, false);
            const rootName = this.settings.remoteFolderPath || this.app.vault.getName();
            const rootId = await this.driveClient.getFileId(rootName, 'root', 'application/vnd.google-apps.folder');

            if (rootId) {
                await this.driveClient.deleteFile(rootId, rootId);
                new Notice('Remote folder deleted.');
            }

            this.rootFolderId = null;
            this.folderIdCache.clear();
            this.settings.syncIndex = {};
            await this.onSaveSettings();

            this.isSyncing = false;
            await this.syncVault();

        } catch (e) {
            console.error('Force Resync failed:', e);
            new Notice('Force Resync failed.');
            this.isSyncing = false;
        }
    }

    private updateStatus(message: string, timeout?: number, showCancel: boolean = false) {
        if (this.statusBarItem) {
            this.statusBarItem.empty();
            const msgSpan = this.statusBarItem.createEl('span', { text: message });

            if (showCancel) {
                const btn = this.statusBarItem.createEl('span', { cls: 'status-bar-item-segment' });
                btn.style.marginLeft = '10px';
                btn.style.cursor = 'pointer';
                btn.style.color = 'var(--text-error)';
                btn.setText("Cancel");
                btn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.cancelSync();
                };
            }

            if (timeout) {
                setTimeout(() => {
                    if (this.statusBarItem?.getText() === message) {
                        this.statusBarItem.setText('');
                    }
                }, timeout);
            }
        }
    }

    public async syncVault() {
        if (this.isSyncing) {
            new Notice('Gemini Sync: Already in progress.');
            return;
        }

        if (!this.driveClient.isReady()) {
            new Notice('Gemini Sync: Not authenticated.');
            return;
        }

        this.isSyncing = true;
        this.cancelRequested = false;
        this.folderIdCache.clear();

        try {
            new Notice('Gemini Sync: Starting strict mirror sync...');
            this.updateStatus('Gemini Sync: Initializing...', undefined, true);

            // Wait for Obsidian Sync to finish if active
            await this.waitForObsidianSync();

            const rootId = await this.getVaultRoot();

            // 1. Charger le Manifeste Distant (État actuel du Drive)
            let remoteManifest = await this.manifestManager.loadManifest(rootId);
            if (!remoteManifest) {
                remoteManifest = this.manifestManager.createEmptyManifest();
            }

            // 2. Préparer la liste des fichiers locaux (Source de Vérité)
            const localFiles = this.app.vault.getFiles();
            const excludedFolders = this.settings.excludedFolders || [];

            // Filtrer les fichiers exclus
            const filesToSync = localFiles.filter(file => {
                if (excludedFolders.some(ex => file.path === ex || file.path.startsWith(ex + '/'))) return false;
                if (file.extension === 'md') return true;
                if (file.extension === 'pdf') return this.settings.syncPDFs;
                if (['png', 'jpg', 'jpeg', 'gif'].includes(file.extension)) return this.settings.syncImages;
                return false;
            });

            const totalFiles = filesToSync.length;
            let processedCount = 0;

            // Set pour suivre quels fichiers distants sont toujours valides
            const keptRemotePaths = new Set<string>();

            // 3. Phase de Propagation (Local -> Drive)
            for (const file of filesToSync) {
                if (this.cancelRequested) break;
                processedCount++;
                this.updateStatus(`Gemini Sync: Syncing ${processedCount}/${totalFiles}`, undefined, true);

                try {
                    // Calculer le hash local
                    const localHash = await this.calculateFileHash(file);
                    const remoteEntry = remoteManifest.files[file.path];

                    // Décision : Upload si inexistant ou modifié
                    if (!remoteEntry || remoteEntry.hash !== localHash) {
                        // if (!remoteEntry) console.log(`[Sync] New file: ${file.path}`);
                        // else console.log(`[Sync] Modified file: ${file.path}`);

                        await this.uploadFile(file, rootId, remoteManifest);
                    } else {
                        // Identique : on garde l'entrée telle quelle
                        // (Optionnel : mettre à jour mtime si besoin, mais pas critique pour le miroir)
                    }

                    // Marquer comme "vu et conservé"
                    keptRemotePaths.add(file.path);

                } catch (err) {
                    console.error(`Failed to sync ${file.path}:`, err);
                    new Notice(`Failed to sync ${file.path}`);
                }
            }

            // 4. Phase de Nettoyage (Drive -> Poubelle)
            // On supprime du Drive tout ce qui est dans le manifeste mais PAS dans keptRemotePaths
            if (!this.cancelRequested) {
                this.updateStatus('Gemini Sync: Cleaning remote...', undefined, true);

                const remotePaths = Object.keys(remoteManifest.files);
                for (const remotePath of remotePaths) {
                    // Si le fichier n'a pas été vu lors du scan local...
                    if (!keptRemotePaths.has(remotePath)) {

                        // Sécurité : vérifier si le fichier est dans un dossier exclu
                        // (Si on a exclu le dossier localement, on ne veut peut-être pas le supprimer du Drive ?)
                        // Dans une logique "Miroir Strict", on devrait le supprimer. 
                        // Mais si on veut juste "ignorer", on ajoute cette condition :
                        const isExcluded = excludedFolders.some(ex => remotePath === ex || remotePath.startsWith(ex + '/'));

                        if (!isExcluded) {
                            // console.log(`[Sync] Deleting remote orphan: ${remotePath}`);
                            try {
                                const entry = remoteManifest.files[remotePath];
                                // Pass rootId as scopeId to enable security check (prevents deletion outside vault folder)
                                await this.driveClient.deleteFile(entry.driveId, rootId);
                                // Retirer du manifeste
                                delete remoteManifest.files[remotePath];
                                delete this.settings.syncIndex[remotePath]; // Nettoyer l'index local aussi
                            } catch (e) {
                                console.error(`Failed to delete remote file ${remotePath}:`, e);
                            }
                        }
                    }
                }

                // 5. Sauvegarder le nouvel état
                remoteManifest.lastSync = Date.now();
                await this.manifestManager.saveManifest(rootId, remoteManifest);
                await this.onSaveSettings();

                new Notice('Gemini Sync: Mirroring complete!');
                this.updateStatus('Gemini Sync: Ready', 5000);
            } else {
                new Notice('Gemini Sync: Cancelled.');
                this.updateStatus('Gemini Sync: Cancelled', 5000);
            }

        } catch (globalError) {
            console.error('Gemini Sync Fatal Error:', globalError);
            new Notice('Gemini Sync Failed. See console.');
            this.updateStatus('Gemini Sync: Failed', undefined);
        } finally {
            this.isSyncing = false;
        }
    }

    private async uploadFile(file: TFile, rootId: string, manifest: RemoteManifest) {
        const content = await this.getFileContent(file);
        const hash = await this.calculateFileHash(file);

        let mimeType = 'application/octet-stream';
        if (file.extension === 'md') mimeType = 'application/vnd.google-apps.document';
        else if (file.extension === 'pdf') mimeType = 'application/pdf';
        else if (['png', 'jpg', 'jpeg', 'gif'].includes(file.extension)) mimeType = `image/${file.extension === 'jpg' ? 'jpeg' : file.extension}`;

        const parentId = await this.ensureFolderStructure(file.parent?.path || '');

        const existingEntry = manifest.files[file.path];
        let driveId: string;

        if (existingEntry) {
            await this.driveClient.updateFile(existingEntry.driveId, content, mimeType);
            driveId = existingEntry.driveId;
        } else {
            // Check if file exists on drive to avoid dups (stale manifest case)
            // Or just upload new. Trust manifest? 
            // Let's trust manifest for speed, but maybe check if ID is null
            driveId = await this.driveClient.uploadFile(
                file.extension === 'md' ? file.basename : file.name,
                content,
                mimeType,
                parentId
            );
        }

        // Update Manifest
        manifest.files[file.path] = {
            path: file.path,
            driveId: driveId,
            hash: hash,
            modifiedTime: Date.now()
        };

        // Update Local Index
        this.settings.syncIndex[file.path] = {
            path: file.path,
            driveId: driveId,
            hash: hash,
            lastModified: file.stat.mtime
        };
    }

    private async getFileContent(file: TFile): Promise<any> {
        if (file.extension === 'md') {
            return await this.app.vault.read(file);
        } else {
            const buffer = await this.app.vault.readBinary(file);
            return Buffer.from(buffer);
        }
    }

    private async calculateFileHash(file: TFile): Promise<string> {
        if (file.extension === 'md') {
            const content = await this.app.vault.read(file);
            return CryptoJS.MD5(content).toString();
        } else {
            const buffer = await this.app.vault.readBinary(file);
            const word = CryptoJS.lib.WordArray.create(buffer as any);
            return CryptoJS.MD5(word).toString();
        }
    }

    private async getVaultRoot(): Promise<string> {
        if (this.rootFolderId) return this.rootFolderId;

        const rootPath = this.settings.remoteFolderPath || this.app.vault.getName();

        // Use ensureFolderStructure logic to resolve the full path
        // We treat the rootPath as a folder structure we need to find/create starting from Drive root
        const rootId = await this.resolveRemoteRoot(rootPath);

        this.rootFolderId = rootId;
        return rootId;
    }

    private async resolveRemoteRoot(path: string): Promise<string> {
        if (!path || path === '/') return 'root';

        const parts = path.split('/').filter(p => p.length > 0);
        let parentId = 'root';

        for (const part of parts) {
            let folderId = await this.driveClient.getFileId(part, parentId, 'application/vnd.google-apps.folder');
            if (!folderId) {
                folderId = await this.driveClient.createFolder(part, parentId);
            }
            parentId = folderId;
        }
        return parentId;
    }

    private async ensureFolderStructure(path: string): Promise<string> {
        let parentId = await this.getVaultRoot();
        if (!path || path === '/') return parentId;

        if (this.folderIdCache.has(path)) return this.folderIdCache.get(path)!;

        const parts = path.split('/');
        let currentPath = '';

        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (this.folderIdCache.has(currentPath)) {
                parentId = this.folderIdCache.get(currentPath)!;
                continue;
            }
            let folderId = await this.driveClient.getFileId(part, parentId, 'application/vnd.google-apps.folder');
            if (!folderId) {
                folderId = await this.driveClient.createFolder(part, parentId);
            }
            parentId = folderId;
            this.folderIdCache.set(currentPath, folderId);
        }
        return parentId;
    }

    private async waitForObsidianSync(): Promise<void> {
        // Access internal API safely
        const internalPlugins = (this.app as any).internalPlugins;
        if (!internalPlugins) return;

        const syncPlugin = internalPlugins.plugins['sync'];
        if (!syncPlugin || !syncPlugin.enabled) return;

        // Check if sync instance exists and has status
        const syncInstance = syncPlugin.instance;
        if (!syncInstance) return;

        // Helper to get status
        const getStatus = () => {
            // status can be 'fully_synced', 'syncing', 'error', 'paused'
            // We might need to inspect the DOM or internal state if 'status' property isn't directly exposed
            // But usually syncInstance.status is the way.
            return syncInstance.status;
        };

        if (getStatus() !== 'syncing') return;

        this.updateStatus('Waiting for Obsidian Sync...', undefined, true);
        // console.log('Gemini Sync: Waiting for Obsidian Sync to finish...');

        return new Promise<void>((resolve) => {
            let checks = 0;
            const maxChecks = 30; // 30 seconds timeout

            const interval = window.setInterval(() => {
                checks++;
                const status = getStatus();

                if (this.cancelRequested) {
                    clearInterval(interval);
                    resolve();
                    return;
                }

                if (status !== 'syncing' || checks >= maxChecks) {
                    clearInterval(interval);
                    if (checks >= maxChecks) {
                        new Notice('Gemini Sync: Timed out waiting for Obsidian Sync. Proceeding...');
                        // console.log('Gemini Sync: Timed out waiting for Obsidian Sync.');
                    } else {
                        // console.log('Gemini Sync: Obsidian Sync finished.');
                    }
                    resolve();
                }
            }, 1000);
        });
    }
}
