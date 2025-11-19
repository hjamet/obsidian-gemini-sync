import { App, TFile, Notice } from 'obsidian';
import { DriveClient } from '../drive/driveClient';
import { convertToGoogleDocs } from '../convert/markdownToDocs';
import * as CryptoJS from 'crypto-js';

interface SyncIndexEntry {
    path: string;
    driveId: string;
    hash: string;
    lastModified: number;
}

interface SyncIndex {
    [path: string]: SyncIndexEntry;
}

interface SyncSettings {
    syncImages: boolean;
    syncPDFs: boolean;
}

export class SyncManager {
    private app: App;
    private driveClient: DriveClient;
    private syncIndex: SyncIndex = {};
    private readonly INDEX_FILE = 'gemini-sync-index.json';
    private settings: SyncSettings;

    constructor(app: App, driveClient: DriveClient, settings: SyncSettings) {
        this.app = app;
        this.driveClient = driveClient;
        this.settings = settings;
    }

    updateSettings(settings: SyncSettings) {
        this.settings = settings;
    }

    async loadIndex() {
        if (await this.app.vault.adapter.exists(this.INDEX_FILE)) {
            const content = await this.app.vault.adapter.read(this.INDEX_FILE);
            this.syncIndex = JSON.parse(content);
        }
    }

    async saveIndex() {
        await this.app.vault.adapter.write(this.INDEX_FILE, JSON.stringify(this.syncIndex, null, 2));
    }

    async syncVault() {
        if (!this.driveClient.isReady()) {
            new Notice('Gemini Sync: Not authenticated. Please check settings.');
            return;
        }

        new Notice('Gemini Sync: Starting sync...');
        await this.loadIndex();

        const allFiles = this.app.vault.getFiles();
        const filesToSync = allFiles.filter(file => {
            // Filter hidden files/folders
            if (file.path.startsWith('.') || file.path.includes('/.')) {
                return false;
            }

            // Filter by type based on settings
            const ext = file.extension.toLowerCase();
            if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext) && !this.settings.syncImages) {
                return false;
            }
            if (ext === 'pdf' && !this.settings.syncPDFs) {
                return false;
            }

            const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
            const isPdf = ext === 'pdf';
            const isMd = ext === 'md';

            if (!isMd && !isImage && !isPdf) {
                return false;
            }
            return true;
        });

        const totalFiles = filesToSync.length;
        console.log(`Gemini Sync: Found ${totalFiles} files to process.`);

        let syncedCount = 0;
        let errorCount = 0;
        let processedCount = 0;
        let lastLoggedPercent = 0;

        for (const file of filesToSync) {
            processedCount++;

            // Progress logging every 10%
            const percent = Math.floor((processedCount / totalFiles) * 100);
            if (percent >= lastLoggedPercent + 10) {
                console.log(`Gemini Sync: Progress ${percent}% (${processedCount}/${totalFiles})`);
                lastLoggedPercent = percent;
            }

            try {
                const synced = await this.syncFile(file);
                if (synced) syncedCount++;
            } catch (e) {
                console.error(`Failed to sync ${file.path}`, e);
                errorCount++;
            }
        }

        await this.saveIndex();

        if (syncedCount > 0 || errorCount > 0) {
            new Notice(`Gemini Sync: Completed. Synced ${syncedCount} files. Errors: ${errorCount}.`);
        } else {
            new Notice('Gemini Sync: Completed. No changes to sync.');
        }
    }

    private async syncFile(file: TFile): Promise<boolean> {
        const entry = this.syncIndex[file.path];

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
            // Convert ArrayBuffer to Buffer for Google API if needed, or pass as is if supported.
            // Node environment usually prefers Buffer.
            content = Buffer.from(arrayBuffer);
            // MD5 for binary
            const wordChanged = CryptoJS.lib.WordArray.create(arrayBuffer as any); // crypto-js supports arraybuffer
            hash = CryptoJS.MD5(wordChanged).toString();
        }

        // Double check hash if entry exists (in case mtime changed but content didn't)
        if (entry && entry.hash === hash) {
            // Update mtime in index to avoid re-reading next time
            this.syncIndex[file.path] = {
                ...entry,
                lastModified: file.stat.mtime
            };
            return false;
        }

        const parentId = await this.ensureFolderStructure(file.parent?.path || '');
        let mimeType = 'application/octet-stream';
        if (file.extension === 'md') mimeType = 'application/vnd.google-apps.document';
        else if (file.extension === 'pdf') mimeType = 'application/pdf';
        else if (['png', 'jpg', 'jpeg', 'gif'].includes(file.extension)) mimeType = `image/${file.extension === 'jpg' ? 'jpeg' : file.extension}`;

        if (entry) {
            // Update existing
            if (file.extension === 'md') {
                await this.driveClient.updateFile(entry.driveId, content, mimeType);
            } else {
                await this.driveClient.updateFile(entry.driveId, content, mimeType);
            }

            this.syncIndex[file.path] = {
                ...entry,
                hash: hash,
                lastModified: file.stat.mtime
            };
        } else {
            // Create new
            let driveId: string;
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

            this.syncIndex[file.path] = {
                path: file.path,
                driveId: driveId,
                hash: hash,
                lastModified: file.stat.mtime
            };
        }
        return true;
    }

    private async ensureFolderStructure(path: string): Promise<string | undefined> {
        if (!path || path === '/') return undefined; // Root

        const parts = path.split('/');
        let parentId: string | undefined = undefined;

        for (const part of parts) {
            let folderId = await this.driveClient.getFileId(part, parentId);
            if (!folderId) {
                folderId = await this.driveClient.createFolder(part, parentId);
            }
            parentId = folderId;
        }
        return parentId;
    }
}
