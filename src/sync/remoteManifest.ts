import { DriveClient } from '../drive/driveClient';

export interface RemoteEntry {
    path: string;
    modifiedTime: number;
    hash: string; // MD5 checksum
    driveId: string;
}

export interface RemoteManifest {
    version: number;
    lastSync: number;
    files: { [path: string]: RemoteEntry };
}

export interface ManifestLoadResult {
    manifest: RemoteManifest | null;
    deduplicatedCount: number;
}

export class ManifestManager {
    private static MANIFEST_FILE_NAME = '.gemini-sync-manifest.json';
    private driveClient: DriveClient;
    private manifestId: string | null = null;
    private duplicateIdsToTrash: string[] = [];

    constructor(driveClient: DriveClient) {
        this.driveClient = driveClient;
    }

    public reset(): void {
        this.manifestId = null;
        this.duplicateIdsToTrash = [];
    }

    public getManifestId(): string | null {
        return this.manifestId;
    }

    /**
     * Loads the remote manifest from Google Drive.
     * If duplicate .gemini-sync-manifest.json files exist, merges them deterministically
     * and trashes the duplicate files after saving the canonical merged manifest.
     */
    async loadManifest(rootFolderId: string): Promise<ManifestLoadResult> {
        const escapedName = ManifestManager.MANIFEST_FILE_NAME.replace(/'/g, "\\'");
        const query = `name = '${escapedName}' and trashed = false and '${rootFolderId}' in parents and mimeType = 'application/json'`;
        const files = await this.driveClient.listFilesByQuery(query, 'files(id, modifiedTime, size)');

        if (files.length === 0) {
            console.log('Gemini Sync: Remote manifest not found. Assuming first sync or fresh start.');
            return { manifest: null, deduplicatedCount: 0 };
        }

        if (files.length === 1) {
            this.manifestId = files[0].id;
            const content = await this.driveClient.getFileContent(files[0].id);
            if (!content) return { manifest: null, deduplicatedCount: 0 };
            return { manifest: JSON.parse(content) as RemoteManifest, deduplicatedCount: 0 };
        }

        console.warn(`Gemini Sync: ${files.length} duplicate manifest files found on Drive. Merging and cleaning duplicates...`);
        const allLoaded: Array<{ id: string; manifest: RemoteManifest; fileCount: number; modifiedTime: number }> = [];
        for (const f of files) {
            try {
                const c = await this.driveClient.getFileContent(f.id);
                if (c) {
                    const parsed = JSON.parse(c) as RemoteManifest;
                    allLoaded.push({
                        id: f.id,
                        manifest: parsed,
                        fileCount: Object.keys(parsed.files || {}).length,
                        modifiedTime: new Date(f.modifiedTime || 0).getTime()
                    });
                }
            } catch (e) {
                console.warn(`Gemini Sync: Failed to parse duplicate manifest candidate ${f.id}:`, e);
            }
        }

        if (allLoaded.length === 0) return { manifest: null, deduplicatedCount: 0 };

        allLoaded.sort((a, b) => b.fileCount - a.fileCount || b.modifiedTime - a.modifiedTime);
        const primary = allLoaded[0];
        const mergedFiles: { [path: string]: RemoteEntry } = { ...(primary.manifest.files || {}) };

        for (let i = 1; i < allLoaded.length; i++) {
            const otherFiles = allLoaded[i].manifest.files || {};
            for (const [filePath, entry] of Object.entries(otherFiles)) {
                if (!entry || !entry.driveId) continue;
                const existing = mergedFiles[filePath];
                if (!existing || (entry.modifiedTime || 0) > (existing.modifiedTime || 0)) {
                    mergedFiles[filePath] = entry;
                }
            }
        }

        primary.manifest.files = mergedFiles;
        this.manifestId = primary.id;
        this.duplicateIdsToTrash = files.map(f => f.id).filter(id => id !== primary.id);

        // Immediately persist merged manifest & trash duplicate manifest files
        await this.saveManifest(rootFolderId, primary.manifest);
        let trashed = 0;
        for (const dupId of this.duplicateIdsToTrash) {
            try {
                await this.driveClient.deleteFile(dupId, rootFolderId);
                trashed++;
                console.log(`Gemini Sync: Trashed duplicate manifest ${dupId}`);
            } catch (e) {
                console.warn(`Gemini Sync: Could not trash duplicate manifest ${dupId}:`, e);
            }
        }
        this.duplicateIdsToTrash = [];

        return { manifest: primary.manifest, deduplicatedCount: trashed };
    }

    async saveManifest(rootFolderId: string, manifest: RemoteManifest): Promise<void> {
        const content = JSON.stringify(manifest);

        if (this.manifestId) {
            try {
                await this.driveClient.updateFile(this.manifestId, content, 'application/json');
                return;
            } catch (e) {
                console.warn('Gemini Sync: Failed to update manifest by ID, falling back to search/create', e);
                this.manifestId = null;
            }
        }

        const existingId = await this.driveClient.getFileId(
            ManifestManager.MANIFEST_FILE_NAME,
            rootFolderId,
            'application/json'
        );

        if (existingId) {
            this.manifestId = existingId;
            await this.driveClient.updateFile(existingId, content, 'application/json');
        } else {
            this.manifestId = await this.driveClient.uploadFile(
                ManifestManager.MANIFEST_FILE_NAME,
                content,
                'application/json',
                rootFolderId
            );
        }
    }

    createEmptyManifest(): RemoteManifest {
        return {
            version: 1,
            lastSync: Date.now(),
            files: {}
        };
    }
}
