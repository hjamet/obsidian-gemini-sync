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
            
            // Si manifestId est connu, on tente l'update
            if (this.manifestId) {
                try {
                    await this.driveClient.updateFile(this.manifestId, content, 'application/json');
                    return;
                } catch (e) {
                    console.warn('Failed to update manifest by ID, falling back to search/create', e);
                    // Si l'update échoue (ex: fichier supprimé entre temps), on reset l'ID et on repart sur la logique de recherche/création
                    this.manifestId = null;
                }
            }

            // Logique de secours : Recherche ou Création
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
