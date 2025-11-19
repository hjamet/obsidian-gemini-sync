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

export class ManifestManager {
    private static MANIFEST_FILE_NAME = '.gemini-sync-manifest.json';
    private driveClient: DriveClient;
    private manifestId: string | null = null;

    constructor(driveClient: DriveClient) {
        this.driveClient = driveClient;
    }

    async loadManifest(rootFolderId: string): Promise<RemoteManifest | null> {
        try {
            // 1. Find the manifest file in the root folder
            const manifestId = await this.driveClient.getFileId(
                ManifestManager.MANIFEST_FILE_NAME, 
                rootFolderId, 
                'application/json'
            );

            if (!manifestId) {
                console.log('Remote manifest not found. Assuming first sync or fresh start.');
                return null;
            }

            this.manifestId = manifestId;

            // 2. Download content
            const content = await this.driveClient.getFileContent(manifestId);
            if (!content) return null;

            const json = JSON.parse(content);
            return json as RemoteManifest;

        } catch (error) {
            console.error('Failed to load remote manifest:', error);
            return null;
        }
    }

    async saveManifest(rootFolderId: string, manifest: RemoteManifest): Promise<void> {
        try {
            // Minified JSON for compression/size optimization
            const content = JSON.stringify(manifest);
            
            if (this.manifestId) {
                await this.driveClient.updateFile(this.manifestId, content, 'application/json');
            } else {
                // Check again just in case (rare race condition)
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
        } catch (error) {
            console.error('Failed to save remote manifest:', error);
            throw error;
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
