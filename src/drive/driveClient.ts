import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Notice } from 'obsidian';
// Stream imports removed as we use Blob for Electron/Browser environment

export interface DriveClientOptions {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    refreshToken?: string;
    onTokenUpdate: (token: string) => Promise<void>;
}

export class DriveClient {
    private oAuth2Client: OAuth2Client;
    private options: DriveClientOptions;

    constructor(options: DriveClientOptions) {
        this.options = options;
        this.oAuth2Client = new google.auth.OAuth2(
            options.clientId,
            options.clientSecret,
            options.redirectUri
        );

        if (options.refreshToken) {
            this.oAuth2Client.setCredentials({
                refresh_token: options.refreshToken
            });
        }

        // Listen for token updates (refresh)
        this.oAuth2Client.on('tokens', (tokens) => {
            if (tokens.refresh_token) {
                console.log('New refresh token received');
                this.options.onTokenUpdate(tokens.refresh_token);
            }
        });
    }

    /**
     * Generates the URL for the user to authorize the app.
     */
    generateAuthUrl(): string {
        const scopes = [
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/documents'
        ];

        return this.oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent' // Force consent to ensure we get a refresh token
        });
    }

    /**
     * Exchanges the authorization code for tokens.
     */
    async authorize(code: string): Promise<void> {
        try {
            const { tokens } = await this.oAuth2Client.getToken(code);
            this.oAuth2Client.setCredentials(tokens);

            if (tokens.refresh_token) {
                await this.options.onTokenUpdate(tokens.refresh_token);
                new Notice('Gemini Sync: Successfully authenticated with Google Drive!');
            } else {
                console.warn('No refresh token received during authorization.');
                new Notice('Gemini Sync: Authenticated, but no refresh token received. You may need to re-authorize.');
            }
        } catch (error) {
            console.error('Error retrieving access token', error);
            new Notice('Gemini Sync: Authentication failed. Check console for details.');
            throw error;
        }
    }

    /**
     * Returns the initialized Drive API client.
     */
    getDrive() {
        return google.drive({ version: 'v3', auth: this.oAuth2Client });
    }

    /**
     * Returns the initialized Docs API client.
     */
    getDocs() {
        return google.docs({ version: 'v1', auth: this.oAuth2Client });
    }

    /**
     * Checks if the client is ready (has credentials).
     */
    isReady(): boolean {
        return !!this.oAuth2Client.credentials.refresh_token;
    }

    /**
     * Creates a folder in Google Drive.
     * @returns The ID of the created folder.
     */
    async createFolder(name: string, parentId?: string): Promise<string> {
        const drive = this.getDrive();
        const fileMetadata: any = {
            name: name,
            mimeType: 'application/vnd.google-apps.folder',
        };
        if (parentId && parentId !== 'root') {
            fileMetadata.parents = [parentId];
        }

        const res = await drive.files.create({
            requestBody: fileMetadata,
            fields: 'id',
        });

        if (!res.data.id) throw new Error('Failed to create folder');
        return res.data.id;
    }

    /**
     * Uploads a file to Google Drive.
     * @returns The ID of the uploaded file.
     */
    async uploadFile(name: string, content: any, mimeType: string, parentId?: string): Promise<string> {
        const drive = this.getDrive();
        const fileMetadata: any = {
            name: name,
        };
        if (parentId && parentId !== 'root') {
            fileMetadata.parents = [parentId];
        }
        if (mimeType === 'application/vnd.google-apps.document') {
            fileMetadata.mimeType = mimeType; // Convert to Google Doc
        }

        let body = content;

        // Handle Buffer specifically by converting to Blob
        if (Buffer.isBuffer(content)) {
            const blob = new Blob([content], { type: mimeType });
            return this.uploadFileResumable(name, blob, mimeType, parentId);
        }

        const media = {
            mimeType: mimeType === 'application/vnd.google-apps.document' ? 'text/markdown' : mimeType,
            body: body,
        };

        try {
            const res = await drive.files.create({
                requestBody: fileMetadata,
                media: media,
                fields: 'id',
            });

            if (!res.data.id) throw new Error('Failed to upload file');
            return res.data.id;
        } catch (error) {
            console.error('Failed to upload file:', error);
            throw error;
        }
    }

    /**
     * Updates an existing file in Google Drive.
     */
    async updateFile(fileId: string, content: any, mimeType: string): Promise<void> {
        // Handle Buffer specifically
        if (Buffer.isBuffer(content)) {
            const blob = new Blob([content], { type: mimeType });
            await this.updateFileResumable(fileId, blob, mimeType);
            return;
        }

        const drive = this.getDrive();
        let body = content;

        const media = {
            mimeType: mimeType === 'application/vnd.google-apps.document' ? 'text/markdown' : mimeType,
            body: body,
        };

        try {
            await drive.files.update({
                fileId: fileId,
                media: media,
            });
        } catch (error) {
            console.error(`Failed to update file ${fileId}:`, error);
            throw error;
        }
    }

    /**
     * Manual Resumable Upload using fetch to bypass googleapis issues with binary files in Electron.
     */
    async uploadFileResumable(name: string, blob: Blob, mimeType: string, parentId?: string): Promise<string> {
        try {
            const tokenResponse = await this.oAuth2Client.getAccessToken();
            const accessToken = tokenResponse.token;
            if (!accessToken) throw new Error('No access token available');

            const metadata: any = { name };
            if (parentId && parentId !== 'root') metadata.parents = [parentId];

            // 1. Initiate Resumable Session
            const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Upload-Content-Type': mimeType,
                    'X-Upload-Content-Length': blob.size.toString()
                },
                body: JSON.stringify(metadata)
            });

            if (!initRes.ok) {
                const txt = await initRes.text();
                throw new Error(`Failed to initiate upload: ${initRes.status} ${txt}`);
            }

            const location = initRes.headers.get('Location');
            if (!location) throw new Error('No Location header in resumable upload response');

            // 2. Upload File Content
            const uploadRes = await fetch(location, {
                method: 'PUT',
                headers: {
                    'Content-Length': blob.size.toString(),
                    'Content-Type': mimeType
                },
                body: blob
            });

            if (!uploadRes.ok) {
                const txt = await uploadRes.text();
                throw new Error(`Failed to upload content: ${uploadRes.status} ${txt}`);
            }

            const result = await uploadRes.json();
            return result.id;

        } catch (error) {
            console.error('Manual Resumable Upload failed:', error);
            throw error;
        }
    }

    /**
     * Manual Resumable Update using fetch.
     */
    async updateFileResumable(fileId: string, blob: Blob, mimeType: string): Promise<void> {
        try {
            const tokenResponse = await this.oAuth2Client.getAccessToken();
            const accessToken = tokenResponse.token;
            if (!accessToken) throw new Error('No access token available');

            // 1. Initiate Resumable Session (PATCH)
            const initRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Upload-Content-Type': mimeType,
                    'X-Upload-Content-Length': blob.size.toString()
                },
                body: JSON.stringify({}) // Empty metadata update, just content
            });

            if (!initRes.ok) {
                const txt = await initRes.text();
                throw new Error(`Failed to initiate update: ${initRes.status} ${txt}`);
            }

            const location = initRes.headers.get('Location');
            if (!location) throw new Error('No Location header in resumable update response');

            // 2. Upload File Content
            const uploadRes = await fetch(location, {
                method: 'PUT',
                headers: {
                    'Content-Length': blob.size.toString(),
                    'Content-Type': mimeType
                },
                body: blob
            });

            if (!uploadRes.ok) {
                const txt = await uploadRes.text();
                throw new Error(`Failed to update content: ${uploadRes.status} ${txt}`);
            }

        } catch (error) {
            console.error('Manual Resumable Update failed:', error);
            throw error;
        }
    }

    /**
     * Deletes a file or folder from Google Drive (moves to trash for safety).
     * @param fileId The ID of the file to delete.
     * @param scopeId Optional. If provided, ensures the file is within this folder (or is the folder itself) before deleting.
     */
    async deleteFile(fileId: string, scopeId?: string): Promise<void> {
        const drive = this.getDrive();

        // 1. Scope Validation (Security Check)
        if (scopeId && fileId !== scopeId) {
            const isSafe = await this.isDescendant(fileId, scopeId);
            if (!isSafe) {
                console.error(`Security Block: Attempted to delete file ${fileId} which is not inside scope ${scopeId}`);
                throw new Error('Security Violation: File is outside the allowed vault scope.');
            }
        }

        // 2. Soft Delete (Move to Trash)
        // We use update with trashed=true instead of delete to allow recovery
        await drive.files.update({
            fileId: fileId,
            requestBody: {
                trashed: true
            }
        });
    }

    /**
     * Checks if a file is a descendant of a specific folder.
     */
    private async isDescendant(childId: string, ancestorId: string): Promise<boolean> {
        const drive = this.getDrive();
        let currentId = childId;
        let depth = 0;
        const MAX_DEPTH = 50; // Prevent infinite loops

        while (depth < MAX_DEPTH) {
            try {
                const res = await drive.files.get({
                    fileId: currentId,
                    fields: 'parents'
                });

                if (!res.data.parents || res.data.parents.length === 0) {
                    return false; // Reached root/orphan without finding ancestor
                }

                if (res.data.parents.includes(ancestorId)) {
                    return true; // Found it!
                }

                // Move up to the first parent
                currentId = res.data.parents[0];
                depth++;
            } catch (e) {
                console.error('Error traversing parents:', e);
                return false;
            }
        }
        return false;
    }

    /**
     * Searches for a file by name and parent.
     */
    async getFileId(name: string, parentId?: string, mimeType?: string): Promise<string | null> {
        const drive = this.getDrive();
        // Escape single quotes in filename to prevent query syntax errors
        const escapedName = name.replace(/'/g, "\\'");
        let query = `name = '${escapedName}' and trashed = false`;
        if (parentId) {
            query += ` and '${parentId}' in parents`;
        }
        if (mimeType) {
            query += ` and mimeType = '${mimeType}'`;
        }

        const res = await drive.files.list({
            q: query,
            fields: 'files(id)',
            spaces: 'drive',
        });

        if (res.data.files && res.data.files.length > 0) {
            return res.data.files[0].id || null;
        }
        return null;
    }

    /**
     * Downloads the content of a file as text.
     */
    async getFileContent(fileId: string): Promise<string | null> {
        const drive = this.getDrive();
        try {
            const res = await drive.files.get({
                fileId: fileId,
                alt: 'media',
            });

            if (typeof res.data === 'string') return res.data;
            if (typeof res.data === 'object') return JSON.stringify(res.data);
            return String(res.data);
        } catch (error) {
            console.error(`Failed to download content for ${fileId}:`, error);
            return null;
        }
    }

    /**
     * Downloads the content of a file as an ArrayBuffer (for binary files).
     */
    async getFileBuffer(fileId: string): Promise<ArrayBuffer | null> {
        const drive = this.getDrive();
        try {
            const res = await drive.files.get({
                fileId: fileId,
                alt: 'media',
            }, {
                responseType: 'arraybuffer'
            });

            return res.data as any as ArrayBuffer;
        } catch (error) {
            console.error(`Failed to download binary for ${fileId}:`, error);
            return null;
        }
    }
}
