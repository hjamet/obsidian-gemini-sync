import { App, TFile, Notice } from 'obsidian';
import { DriveClient } from '../drive/driveClient';
import { convertToGoogleDocs } from '../convert/markdownToDocs';
import * as CryptoJS from 'crypto-js';
import { GeminiSyncSettings, SyncIndex } from '../main';

export class SyncManager {
    app: App;
    driveClient: DriveClient;
    settings: GeminiSyncSettings;
    statusBarItem: HTMLElement | null = null;
    isSyncing: boolean = false;
    cancelRequested: boolean = false;
    private rootFolderId: string | null = null;
    private folderIdCache: Map<string, string> = new Map();
    onSaveSettings: () => Promise<void>;

    constructor(app: App, driveClient: DriveClient, settings: GeminiSyncSettings, statusBarItem: HTMLElement | undefined, onSaveSettings: () => Promise<void>) {
        this.app = app;
        this.driveClient = driveClient;
        this.settings = settings;
        this.statusBarItem = statusBarItem || null;
        this.onSaveSettings = onSaveSettings;
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
            // 1. Find root folder (ensure we look at root to avoid ambiguity)
            const rootName = this.settings.remoteFolderPath || this.app.vault.getName();
            const rootId = await this.driveClient.getFileId(rootName, 'root', 'application/vnd.google-apps.folder');

            if (rootId) {
                // 2. Delete it (soft delete with scope check)
                // We pass rootId as scopeId, which allows deleting the root itself
                await this.driveClient.deleteFile(rootId, rootId);
                new Notice('Remote folder deleted.');
            }

            // Clear cache
            this.rootFolderId = null;
            this.folderIdCache.clear();

            // 3. Clear local index
            this.settings.syncIndex = {};
            await this.onSaveSettings();

            // 4. Restart sync
            this.isSyncing = false; // syncVault checks this
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
                btn.style.color = 'var(--text-error)'; // Make it look like a cancel action
                btn.setText("Cancel");
                btn.setAttribute('aria-label', 'Cancel Sync');

                btn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.cancelSync();
                };
            }

            if (timeout) {
                setTimeout(() => {
                    // Only clear if the message hasn't changed
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
            new Notice('Gemini Sync: Not authenticated. Please check settings.');
            return;
        }

        this.isSyncing = true;
        this.cancelRequested = false;
        this.folderIdCache.clear(); // Clear folder cache at start of sync

        try {
            new Notice('Gemini Sync: Starting synchronization...');
            this.updateStatus('Gemini Sync: Starting...', undefined, true);

            const files = this.app.vault.getFiles();

            // Parse excluded folders
            const excludedFolders = Array.isArray(this.settings.excludedFolders)
                ? this.settings.excludedFolders
                : [];

            console.log('Gemini Sync: Starting sync with excluded folders:', excludedFolders);

            const filesToSync = files.filter(file => {
                // Check if file is in an excluded folder (strict match or subfolder)
                if (excludedFolders.some(excluded =>
                    file.path === excluded || file.path.startsWith(excluded + '/')
                )) {
                    return false;
                }

                // Check file types based on settings
                if (file.extension === 'md') return true;
                if (file.extension === 'pdf') return this.settings.syncPDFs;
                if (['png', 'jpg', 'jpeg', 'gif'].includes(file.extension)) return this.settings.syncImages;

                return false; // Skip other types
            });

            const totalFiles = filesToSync.length;
            let processedFiles = 0;
            this.updateStatus(`Gemini Sync: 0/${totalFiles} (0%)`, undefined, true);

            for (const file of filesToSync) {
                if (this.cancelRequested) {
                    new Notice('Gemini Sync: Synchronization cancelled.');
                    this.updateStatus('Gemini Sync: Cancelled', 5000);
                    return;
                }

                try {
                    await this.syncFile(file);
                } catch (error) {
                    console.error(`Failed to sync file ${file.path}:`, error);
                    new Notice(`Failed to sync ${file.path}`);
                } finally {
                    processedFiles++;
                    const percent = Math.round((processedFiles / totalFiles) * 100);
                    if (!this.cancelRequested) {
                        this.updateStatus(`Gemini Sync: ${processedFiles}/${totalFiles} (${percent}%)`, undefined, true);
                    }
                }
            }

            new Notice('Gemini Sync: Synchronization complete!');
            this.updateStatus('Gemini Sync: Ready', 5000);
        } finally {
            this.isSyncing = false;
            // Save settings (including sync index) at the end of sync
            await this.onSaveSettings();
        }
    }

    private async syncFile(file: TFile): Promise<boolean> {
        const entry = this.settings.syncIndex[file.path];

        // Optimization: Check mtime first
        if (entry && entry.lastModified === file.stat.mtime) {
            return false; // No changes based on mtime
        }

        let content: any;
        let hash: string;

        if (file.extension === 'md') {
            content = await this.app.vault.read(file);
            hash = CryptoJS.MD5(content).toString();
        } else {
            // Binary file
            const arrayBuffer = await this.app.vault.readBinary(file);
            // Convert ArrayBuffer to Buffer for Google API
            content = Buffer.from(arrayBuffer);
            // MD5 for binary
            const wordChanged = CryptoJS.lib.WordArray.create(arrayBuffer as any);
            hash = CryptoJS.MD5(wordChanged).toString();
        }

        // Double check hash if entry exists
        if (entry && entry.hash === hash) {
            // Update mtime in index to avoid re-reading next time
            this.settings.syncIndex[file.path] = {
                ...entry,
                lastModified: file.stat.mtime
            };
            // We rely on the final save at the end of syncVault
            return false;
        }

        const parentId = await this.ensureFolderStructure(file.parent?.path || '');
        let mimeType = 'application/octet-stream';
        if (file.extension === 'md') mimeType = 'application/vnd.google-apps.document';
        else if (file.extension === 'pdf') mimeType = 'application/pdf';
        else if (['png', 'jpg', 'jpeg', 'gif'].includes(file.extension)) mimeType = `image/${file.extension === 'jpg' ? 'jpeg' : file.extension}`;

        if (entry) {
            // Update existing
            await this.driveClient.updateFile(entry.driveId, content, mimeType);

            this.settings.syncIndex[file.path] = {
                ...entry,
                hash: hash,
                lastModified: file.stat.mtime
            };
        } else {
            // File not in local index. Check if it exists on Drive to avoid duplicates.
            let driveId = await this.driveClient.getFileId(file.name, parentId, mimeType);

            if (driveId) {
                // Found on Drive! Update it instead of creating new.
                console.log(`Found existing file on Drive: ${file.path} -> ${driveId}`);
                await this.driveClient.updateFile(driveId, content, mimeType);
            } else {
                // Not found, create new.
                if (file.extension === 'md') {
                    driveId = await this.driveClient.uploadFile(file.basename, '', mimeType, parentId);
                    const requests = convertToGoogleDocs(content);
                    if (requests.length > 0) {
                        const docs = this.driveClient.getDocs();
                        await docs.documents.batchUpdate({
                            documentId: driveId,
                            requestBody: {
                                requests: requests
                            }
                        });
                    }
                } else {
                    driveId = await this.driveClient.uploadFile(file.name, content, mimeType, parentId);
                }
            }

            this.settings.syncIndex[file.path] = {
                path: file.path,
                driveId: driveId!, // driveId is definitely assigned here
                hash: hash,
                lastModified: file.stat.mtime
            };
        }
        return true;
    }

    private async getVaultRoot(): Promise<string> {
        if (this.rootFolderId) return this.rootFolderId;

        const rootName = this.settings.remoteFolderPath || this.app.vault.getName();
        // Check if root folder exists
        // Explicitly search in 'root' to avoid finding subfolders with the same name (prevents infinite recursion)
        let rootId = await this.driveClient.getFileId(rootName, 'root', 'application/vnd.google-apps.folder');
        if (!rootId) {
            rootId = await this.driveClient.createFolder(rootName);
        }
        this.rootFolderId = rootId;
        return rootId;
    }

    private async ensureFolderStructure(path: string): Promise<string> {
        let parentId = await this.getVaultRoot();

        if (!path || path === '/') return parentId;

        // Optimization: Check cache first to avoid repeated API calls for files in same folder
        if (this.folderIdCache.has(path)) {
            return this.folderIdCache.get(path)!;
        }

        const parts = path.split('/');
        let currentPath = '';

        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;

            // Check cache for this specific level
            if (this.folderIdCache.has(currentPath)) {
                parentId = this.folderIdCache.get(currentPath)!;
                continue;
            }

            // Check if we have a folder ID for this part under parentId
            let folderId = await this.driveClient.getFileId(part, parentId, 'application/vnd.google-apps.folder');
            if (!folderId) {
                folderId = await this.driveClient.createFolder(part, parentId);
            }
            parentId = folderId;

            // Cache this level
            this.folderIdCache.set(currentPath, folderId);
        }
        return parentId;
    }
}
