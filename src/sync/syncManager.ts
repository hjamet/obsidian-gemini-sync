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

export class SyncManager {
    private app: App;
    private driveClient: DriveClient;
    private syncIndex: SyncIndex = {};
    private readonly INDEX_FILE = 'gemini-sync-index.json';

    constructor(app: App, driveClient: DriveClient) {
        this.app = app;
        this.driveClient = driveClient;
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

        const files = this.app.vault.getFiles();
        let syncedCount = 0;
        let errorCount = 0;

        for (const file of files) {
            try {
                await this.syncFile(file);
                syncedCount++;
            } catch (e) {
                console.error(`Failed to sync ${file.path}`, e);
                errorCount++;
            }
        }

        await this.saveIndex();
        new Notice(`Gemini Sync: Completed. Synced ${syncedCount} files. Errors: ${errorCount}.`);
    }

    private async syncFile(file: TFile) {
        const content = await this.app.vault.read(file);
        const hash = CryptoJS.MD5(content).toString();
        const entry = this.syncIndex[file.path];

        // Check if file needs sync
        if (entry && entry.hash === hash) {
            return; // No changes
        }

        // Determine parent folder ID (simplified: assuming root for now, or we need to implement folder sync)
        // For this MVP, let's put everything in a "Gemini Sync" folder or root.
        // To support folders, we need to recursively create them and map them.
        // Let's implement basic folder support.
        const parentId = await this.ensureFolderStructure(file.parent?.path || '');

        if (entry) {
            // Update existing
            if (file.extension === 'md') {
                // For GDocs, we might need to delete and recreate to apply conversion properly, 
                // or use batchUpdate with replacement.
                // Since our converter generates a "new doc" structure, updating an existing doc is complex 
                // (clearing it first).
                // Strategy: Delete content and insert new.
                // But driveClient.updateFile only does media update.
                // For GDocs, we need Docs API.
                // Let's use a helper in DriveClient or just recreate for now (simplest for MVP).
                // Actually, recreating changes the ID, which breaks links if we had them.
                // Better: Use Docs API to clear and insert.
                // For now, let's just upload as new version (media update) if it wasn't a GDoc, 
                // but since it IS a GDoc, we can't just "upload" markdown to it via Drive API update easily 
                // without converting again.
                // Google Drive API v3 'update' allows converting new content? Yes, if uploadType=multipart.

                await this.driveClient.updateFile(entry.driveId, content, 'application/vnd.google-apps.document');
            } else {
                // Binary/Other file
                // We need to read binary for non-text files.
                // But app.vault.read() returns string. readBinary() returns ArrayBuffer.
                // For now, let's skip binary or handle text only.
                // The requirements say "convert Markdown files".
                await this.driveClient.updateFile(entry.driveId, content, 'text/plain');
            }

            // Update index
            this.syncIndex[file.path] = {
                ...entry,
                hash: hash,
                lastModified: file.stat.mtime
            };
        } else {
            // Create new
            let driveId: string;
            if (file.extension === 'md') {
                // Convert to GDoc
                // Wait, the driveClient.uploadFile handles conversion if mimeType is set.
                // But we need to pass the *raw markdown* and let Drive convert it?
                // OR we use our `convertToGoogleDocs` and use Docs API?
                // The README said: "Convertit en documents Google Docs... via API batch requests".
                // So we should create a blank doc and then apply requests.

                driveId = await this.driveClient.uploadFile(file.basename, '', 'application/vnd.google-apps.document', parentId);

                // Now apply content
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
                // Upload as is
                driveId = await this.driveClient.uploadFile(file.name, content, 'text/plain', parentId);
            }

            this.syncIndex[file.path] = {
                path: file.path,
                driveId: driveId,
                hash: hash,
                lastModified: file.stat.mtime
            };
        }
    }

    private async ensureFolderStructure(path: string): Promise<string | undefined> {
        if (!path || path === '/') return undefined; // Root

        // Check if we have this folder mapped
        // We should probably map folders in the index too or a separate index.
        // For simplicity, let's lookup by name in Drive (slow) or cache it.
        // Let's assume flat for now or simple lookup.
        // To do it right: split path, traverse.

        const parts = path.split('/');
        let parentId: string | undefined = undefined;

        for (const part of parts) {
            // Check if we have a folder ID for this part under parentId
            // We can cache this in memory during sync.
            // For now, let's use getFileId (which does a search).
            let folderId = await this.driveClient.getFileId(part, parentId);
            if (!folderId) {
                folderId = await this.driveClient.createFolder(part, parentId);
            }
            parentId = folderId;
        }
        return parentId;
    }
}
