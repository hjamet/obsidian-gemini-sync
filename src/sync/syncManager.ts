import { App, TFile, Notice, TFolder } from 'obsidian';
import { DriveClient } from '../drive/driveClient';
import * as CryptoJS from 'crypto-js';
import { GeminiSyncSettings } from '../main';
import { ManifestManager, RemoteEntry, RemoteManifest } from './remoteManifest';
import { pLimit } from './concurrency';
import { TasksClient } from '../drive/tasksClient';
import { ProjectManager } from './projectManager';
import { CanvasConverter } from '../convert/canvasConverter';

const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

export class SyncManager {
    app: App;
    driveClient: DriveClient;
    settings: GeminiSyncSettings;
    statusBarItem: HTMLElement | null = null;
    isSyncing: boolean = false;
    cancelRequested: boolean = false;
    manifestManager: ManifestManager;
    projectManager: ProjectManager;
    canvasConverter: CanvasConverter;
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

        const tasksClient = new TasksClient(driveClient);
        this.projectManager = new ProjectManager(app, tasksClient, settings);
        this.canvasConverter = new CanvasConverter(app);
    }

    public updateSettings(settings: GeminiSyncSettings) {
        if (this.settings.remoteFolderPath !== settings.remoteFolderPath) {
            this.rootFolderId = null;
            this.folderIdCache.clear();
        }
        this.settings = settings;
        this.projectManager.updateSettings(settings);
    }

    public updateDriveClient(driveClient: DriveClient) {
        this.driveClient = driveClient;
        this.manifestManager = new ManifestManager(driveClient);
        const tasksClient = new TasksClient(driveClient);
        this.projectManager = new ProjectManager(this.app, tasksClient, this.settings);
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

            // 0. Sync Projects from Tasks
            await this.projectManager.syncProjects();

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
                if (file.extension === 'canvas') return this.settings.syncCanvas;
                if (['png', 'jpg', 'jpeg', 'gif'].includes(file.extension)) return this.settings.syncImages;
                return false;
            });

            const totalFiles = filesToSync.length;
            let processedCount = 0;

            // Set pour suivre quels fichiers distants sont toujours valides
            const keptRemotePaths = new Set<string>();

            // Concurrency Limit
            const limit = pLimit(2); // 2 concurrent uploads
            const promises: Promise<void>[] = [];

            // 3. Phase de Propagation (Local -> Drive) - Optimized Diff
            const filesToUpload: TFile[] = [];

            // Pre-calculation pass: Filter out files that don't need syncing locally
            this.updateStatus('Gemini Sync: Checking local changes...', undefined, true);

            let checkCount = 0;
            for (const file of filesToSync) {
                if (this.cancelRequested) break;

                // Yield to event loop to prevent Obsidian UI freeze during heavy hashing
                if (++checkCount % 20 === 0) {
                    await yieldToEventLoop();
                }

                // OPTIMIZATION: Check mtime to skip re-hashing
                let localHash: string;
                const cachedEntry = this.settings.syncIndex[file.path];

                if (cachedEntry && cachedEntry.lastModified === file.stat.mtime && cachedEntry.hash) {
                    // Trust the cache if mtime hasn't changed
                    localHash = cachedEntry.hash;
                } else {
                    // Calculate fresh hash
                    localHash = await this.calculateFileHash(file);
                }

                const remoteEntry = remoteManifest!.files[file.path];

                // If remote exists and hash matches, SKIP upload & API calls
                if (remoteEntry && remoteEntry.hash === localHash) {
                    // Update usage index (cache)
                    if (!this.settings.syncIndex[file.path] || this.settings.syncIndex[file.path].lastModified !== file.stat.mtime) {
                        this.settings.syncIndex[file.path] = {
                            path: file.path,
                            driveId: remoteEntry.driveId,
                            hash: localHash,
                            lastModified: file.stat.mtime
                        };
                    }
                    keptRemotePaths.add(file.path);
                    processedCount++; // Validated as "synced" (no-op)
                } else {
                    // Needs upload or check
                    filesToUpload.push(file);
                }
            }

            // Sync only what's needed
            const filesByFolder = new Map<string, TFile[]>();
            for (const file of filesToUpload) {
                const parentPath = file.parent?.path || '';
                if (!filesByFolder.has(parentPath)) {
                    filesByFolder.set(parentPath, []);
                }
                filesByFolder.get(parentPath)!.push(file);
            }

            // Incremental Save State
            let lastSaveTime = Date.now();
            let filesSinceLastSave = 0;

            if (filesToUpload.length === 0) {
                new Notice('Gemini Sync: No changes so far.');
            }

            for (const [folderPath, folderFiles] of filesByFolder) {
                if (this.cancelRequested) break;

                // Ensure folder exists and cache its ID (Only for dirty folders)
                const parentId = await this.ensureFolderStructure(folderPath);

                // Pre-fetch all files in this remote folder (Batching)
                const remoteFolderCache = await this.driveClient.listFilesInFolder(parentId);

                for (const file of folderFiles) {
                    if (this.cancelRequested) break;

                    promises.push(limit(async () => {
                        if (this.cancelRequested) return;

                        await yieldToEventLoop();

                        try {
                            processedCount++;
                            const percentage = Math.round((processedCount / totalFiles) * 100);
                            this.updateStatus(`Gemini Sync: Syncing ${processedCount}/${totalFiles} (${percentage}%)`, undefined, true);

                            // Re-calculate hash (fast, maybe cached in memory if we optimized further, but safe here)
                            // Actually we calculated it above but didn't store it for the loop. 
                            // Let's re-use cache or calc again.
                            let localHash: string;
                            const cachedEntry = this.settings.syncIndex[file.path];
                            if (cachedEntry && cachedEntry.lastModified === file.stat.mtime && cachedEntry.hash) {
                                localHash = cachedEntry.hash;
                            } else {
                                localHash = await this.calculateFileHash(file);
                            }

                            let remoteEntry = remoteManifest!.files[file.path];

                            // SMART RECOVERY (Instant check via cache for what we thought was missing)
                            if (!remoteEntry) {
                                const isDocType = file.extension === 'md' || file.extension === 'canvas';
                                const searchName = isDocType ? file.basename : file.name;
                                const existingFile = remoteFolderCache.get(searchName);

                                if (existingFile) {
                                    let isUpToDate = false;
                                    if (isDocType) {
                                        const remoteModTime = existingFile.modifiedTime ? new Date(existingFile.modifiedTime).getTime() : 0;
                                        if (remoteModTime > file.stat.mtime) isUpToDate = true;
                                    } else {
                                        if (existingFile.md5Checksum === localHash) isUpToDate = true;
                                    }

                                    if (isUpToDate) {
                                        remoteManifest!.files[file.path] = {
                                            path: file.path,
                                            driveId: existingFile.id,
                                            hash: localHash,
                                            modifiedTime: Date.now()
                                        };
                                        this.settings.syncIndex[file.path] = {
                                            path: file.path,
                                            driveId: existingFile.id,
                                            hash: localHash,
                                            lastModified: file.stat.mtime
                                        };
                                        remoteEntry = remoteManifest!.files[file.path];
                                    } else {
                                        // Force update logic
                                        remoteManifest!.files[file.path] = {
                                            path: file.path,
                                            driveId: existingFile.id,
                                            hash: 'mismatch',
                                            modifiedTime: 0
                                        };
                                        remoteEntry = remoteManifest!.files[file.path];
                                    }
                                }
                            }

                            // Décision : Upload si inexistant ou modifié
                            if (!remoteEntry || remoteEntry.hash !== localHash) {
                                await this.uploadFile(file, rootId, remoteManifest!);
                            } else {
                                // Should be caught by pre-filter, but if Smart Recovery found it just now:
                                if (!this.settings.syncIndex[file.path] || this.settings.syncIndex[file.path].lastModified !== file.stat.mtime) {
                                    this.settings.syncIndex[file.path] = {
                                        path: file.path,
                                        driveId: remoteEntry.driveId,
                                        hash: localHash,
                                        lastModified: file.stat.mtime
                                    };
                                }
                            }

                            keptRemotePaths.add(file.path);

                            // Incremental Save Check
                            filesSinceLastSave++;
                            const now = Date.now();
                            if (filesSinceLastSave >= 50 || (now - lastSaveTime > 30000)) { // Every 50 files or 30s
                                filesSinceLastSave = 0;
                                lastSaveTime = now;
                                await this.manifestManager.saveManifest(rootId, remoteManifest!);
                                await this.onSaveSettings();
                            }

                        } catch (err) {
                            console.error(`Failed to sync ${file.path}:`, err);
                            new Notice(`Failed to sync ${file.path}`);
                        }
                    }));
                }
            }

            // Wait for all file uploads to finish
            await Promise.all(promises);

            // 4. Phase de Nettoyage (Drive -> Poubelle)
            if (!this.cancelRequested) {
                this.updateStatus('Gemini Sync: Cleaning remote...', undefined, true);

                const remotePaths = Object.keys(remoteManifest.files);
                let cleanCount = 0;
                for (const remotePath of remotePaths) {
                    if (++cleanCount % 50 === 0) await yieldToEventLoop();

                    if (!keptRemotePaths.has(remotePath)) {
                        const isExcluded = excludedFolders.some(ex => remotePath === ex || remotePath.startsWith(ex + '/'));
                        if (!isExcluded) {
                            try {
                                const entry = remoteManifest.files[remotePath];
                                await this.driveClient.deleteFile(entry.driveId, rootId);
                                delete remoteManifest.files[remotePath];
                                delete this.settings.syncIndex[remotePath];
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
                // Save progress even on cancel
                await this.manifestManager.saveManifest(rootId, remoteManifest);
                await this.onSaveSettings();
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
        if (file.extension === 'md' || file.extension === 'canvas') mimeType = 'application/vnd.google-apps.document';
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
                (file.extension === 'md' || file.extension === 'canvas') ? file.basename : file.name,
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
        } else if (file.extension === 'canvas') {
            return await this.canvasConverter.generateCanvasMarkdown(file);
        } else {
            const buffer = await this.app.vault.readBinary(file);
            return Buffer.from(buffer);
        }
    }

    private async calculateFileHash(file: TFile): Promise<string> {
        if (file.extension === 'md') {
            const content = await this.app.vault.read(file);
            return CryptoJS.MD5(content).toString();
        } else if (file.extension === 'canvas') {
            // Hash the generated content so we detect changes in structure or embedded notes
            const content = await this.canvasConverter.generateCanvasMarkdown(file);
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

        // États considérés comme "finis" ou ne nécessitant pas d'attente
        const isInactive = (s: string) => ['fully_synced', 'paused', 'error'].includes(s);

        const currentStatus = getStatus();
        // Si le statut est indéfini (non chargé) ou inactif, on n'attend pas
        if (!currentStatus || isInactive(currentStatus)) return;

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

                if (isInactive(status) || checks >= maxChecks) {
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
