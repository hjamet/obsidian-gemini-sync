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
    private static readonly SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024; // 5MB
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
            'https://www.googleapis.com/auth/documents',
            'https://www.googleapis.com/auth/tasks'
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
     * Returns the initialized Tasks API client.
     */
    getTasks() {
        return google.tasks({ version: 'v1', auth: this.oAuth2Client });
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
        // Determine source and target MIME types
        const sourceMimeType = mimeType === 'application/vnd.google-apps.document' ? 'text/plain' : mimeType;
        const targetMimeType = mimeType === 'application/vnd.google-apps.document' ? 'application/vnd.google-apps.document' : undefined;

        // Convert content to Blob
        let blob: Blob;
        if (Buffer.isBuffer(content)) {
            // Convert Buffer to Uint8Array for Blob compatibility
            blob = new Blob([new Uint8Array(content as any)], { type: sourceMimeType });
        } else if (typeof content === 'string') {
            blob = new Blob([content], { type: sourceMimeType });
        } else {
            blob = new Blob([JSON.stringify(content)], { type: sourceMimeType });
        }

        if (this.shouldUseResumable(blob)) {
            return this.uploadFileResumable(name, blob, sourceMimeType, parentId, targetMimeType);
        }

        return this.uploadFileMultipart(name, blob, sourceMimeType, parentId, targetMimeType);
    }

    /**
     * Updates an existing file in Google Drive.
     */
    async updateFile(fileId: string, content: any, mimeType: string): Promise<void> {
        // Determine source MIME type (no target conversion needed for updates usually, but we keep consistency)
        const sourceMimeType = mimeType === 'application/vnd.google-apps.document' ? 'text/plain' : mimeType;

        // Convert content to Blob
        let blob: Blob;
        if (Buffer.isBuffer(content)) {
            blob = new Blob([new Uint8Array(content as any)], { type: sourceMimeType });
        } else if (typeof content === 'string') {
            blob = new Blob([content], { type: sourceMimeType });
        } else {
            blob = new Blob([JSON.stringify(content)], { type: sourceMimeType });
        }

        if (this.shouldUseResumable(blob)) {
            await this.updateFileResumable(fileId, blob, sourceMimeType);
        } else {
            await this.updateFileMultipart(fileId, blob, sourceMimeType);
        }
    }

    /**
     * Helper to perform fetch with exponential backoff retry.
     */
    private async fetchWithRetry(url: string, init: RequestInit, retries = 3, backoff = 1000): Promise<Response> {
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url, init);
                if (res.ok) return res;

                // Check if retryable status code
                if (res.status === 408 || res.status === 429 || (res.status >= 500 && res.status < 600)) {
                    const txt = await res.text(); // Consume body to avoid leaks? Not strictly necessary with fetch but good for debugging if needed
                    console.warn(`Request failed with ${res.status}, retrying (${i + 1}/${retries})...`);
                    if (i === retries - 1) throw new Error(`Request failed after ${retries} retries: ${res.status} ${txt}`);

                    await new Promise(resolve => setTimeout(resolve, backoff));
                    backoff *= 2;
                    continue;
                }

                return res; // Return non-retryable error response for caller to handle
            } catch (error) {
                console.warn(`Network request failed, retrying (${i + 1}/${retries})...`, error);
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, backoff));
                backoff *= 2;
            }
        }
        throw new Error('Unreachable');
    }

    /**
     * Builds the Content-Range header required by the Drive resumable upload API.
     */
    private buildContentRange(blob: Blob): string {
        if (blob.size === 0) {
            return 'bytes */0';
        }
        const lastByteIndex = blob.size - 1;
        return `bytes 0-${lastByteIndex}/${blob.size}`;
    }

    private shouldUseResumable(blob: Blob): boolean {
        return blob.size > DriveClient.SIMPLE_UPLOAD_LIMIT;
    }

    private buildMultipartBoundary(): string {
        const rand = Math.random().toString(36).slice(2);
        return `gemini-sync-${Date.now()}-${rand}`;
    }

    private async buildMultipartBody(boundary: string, metadata: any, blob: Blob, sourceMimeType: string): Promise<ArrayBuffer> {
        const delimiter = `--${boundary}\r\n`;
        const closeDelimiter = `--${boundary}--`;
        const metadataJson = JSON.stringify(metadata);

        const bodyBlob = new Blob([
            delimiter,
            'Content-Type: application/json; charset=UTF-8\r\n\r\n',
            metadataJson,
            '\r\n',
            delimiter,
            `Content-Type: ${sourceMimeType}\r\n\r\n`,
            blob,
            '\r\n',
            closeDelimiter,
            '\r\n'
        ]);

        return bodyBlob.arrayBuffer();
    }

    private async uploadFileMultipart(name: string, blob: Blob, sourceMimeType: string, parentId?: string, targetMimeType?: string): Promise<string> {
        const tokenResponse = await this.oAuth2Client.getAccessToken();
        const accessToken = tokenResponse.token;
        if (!accessToken) throw new Error('No access token available');

        const metadata: any = { name };
        if (parentId && parentId !== 'root') metadata.parents = [parentId];
        if (targetMimeType) metadata.mimeType = targetMimeType;

        const boundary = this.buildMultipartBoundary();
        const body = await this.buildMultipartBody(boundary, metadata, blob, sourceMimeType);
        const bodyBytes = new Uint8Array(body);
        console.log(`Gemini Sync: Multipart upload for ${name}, size: ${blob.size}`);

        const res = await this.fetchWithRetry('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': bodyBytes.byteLength.toString()
            },
            body: bodyBytes
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Failed to upload file (multipart): ${res.status} ${txt}`);
        }

        const result = await res.json();
        if (!result.id) throw new Error('Upload response missing file ID');
        return result.id;
    }

    private async updateFileMultipart(fileId: string, blob: Blob, mimeType: string): Promise<void> {
        const tokenResponse = await this.oAuth2Client.getAccessToken();
        const accessToken = tokenResponse.token;
        if (!accessToken) throw new Error('No access token available');

        const metadata: any = {};
        const boundary = this.buildMultipartBoundary();
        const body = await this.buildMultipartBody(boundary, metadata, blob, mimeType);
        const bodyBytes = new Uint8Array(body);
        console.log(`Gemini Sync: Multipart update for ${fileId}, size: ${blob.size}`);

        const res = await this.fetchWithRetry(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': bodyBytes.byteLength.toString()
            },
            body: bodyBytes
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Failed to update file (multipart): ${res.status} ${txt}`);
        }
    }

    /**
     * Manual Resumable Upload using fetch to bypass googleapis issues with binary files in Electron.
     */
    async uploadFileResumable(name: string, blob: Blob, sourceMimeType: string, parentId?: string, targetMimeType?: string): Promise<string> {
        let attempt = 0;
        const maxAttempts = 3;

        while (attempt < maxAttempts) {
            try {
                attempt++;
                const tokenResponse = await this.oAuth2Client.getAccessToken();
                const accessToken = tokenResponse.token;
                if (!accessToken) throw new Error('No access token available');

                const metadata: any = { name };
                if (parentId && parentId !== 'root') metadata.parents = [parentId];
                if (targetMimeType) metadata.mimeType = targetMimeType;

                // 1. Initiate Resumable Session
                const initRes = await this.fetchWithRetry('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'X-Upload-Content-Type': sourceMimeType,
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
                const contentRange = this.buildContentRange(blob);
                const buffer = await blob.arrayBuffer();
                console.log(`Gemini Sync: Uploading content for ${name}, size: ${blob.size}, range: ${contentRange}`);
                const uploadRes = await this.fetchWithRetry(location, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Length': blob.size.toString(),
                        'Content-Type': sourceMimeType,
                        'Content-Range': contentRange
                    },
                    body: buffer
                });

                if (!uploadRes.ok) {
                    const txt = await uploadRes.text();
                    throw new Error(`Failed to upload content: ${uploadRes.status} ${txt}`);
                }

                const result = await uploadRes.json();
                return result.id;

            } catch (error: any) {
                // Check for 410 Gone specifically
                const is410 = error.message?.includes('410') || (error.code === 410) || (error.response?.status === 410);

                if (is410 && attempt < maxAttempts) {
                    console.warn(`Gemini Sync: Resumable upload session expired (410). Restarting session (attempt ${attempt + 1}/${maxAttempts})...`);
                    continue; // Retry from scratch (new session)
                }

                // If not 410 or max attempts reached, rethrow
                console.error('Manual Resumable Upload failed:', error);
                throw error;
            }
        }
        throw new Error('Upload failed unexpectedly');
    }

    /**
     * Manual Resumable Update using fetch.
     */
    async updateFileResumable(fileId: string, blob: Blob, mimeType: string): Promise<void> {
        let attempt = 0;
        const maxAttempts = 3;

        while (attempt < maxAttempts) {
            try {
                attempt++;
                const tokenResponse = await this.oAuth2Client.getAccessToken();
                const accessToken = tokenResponse.token;
                if (!accessToken) throw new Error('No access token available');

                // 1. Initiate Resumable Session (PATCH)
                const initRes = await this.fetchWithRetry(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable`, {
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
                const contentRange = this.buildContentRange(blob);
                const buffer = await blob.arrayBuffer();
                console.log(`Gemini Sync: Updating content for ${fileId}, size: ${blob.size}, range: ${contentRange}`);
                const uploadRes = await this.fetchWithRetry(location, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Length': blob.size.toString(),
                        'Content-Type': mimeType,
                        'Content-Range': contentRange
                    },
                    body: buffer
                });

                if (!uploadRes.ok) {
                    const txt = await uploadRes.text();
                    throw new Error(`Failed to update content: ${uploadRes.status} ${txt}`);
                }

                return; // Success

            } catch (error: any) {
                // Check for 410 Gone specifically
                const is410 = error.message?.includes('410') || (error.code === 410) || (error.response?.status === 410);

                if (is410 && attempt < maxAttempts) {
                    console.warn(`Gemini Sync: Resumable update session expired (410). Restarting session (attempt ${attempt + 1}/${maxAttempts})...`);
                    continue; // Retry from scratch (new session)
                }

                console.error('Manual Resumable Update failed:', error);
                throw error;
            }
        }
        throw new Error('Update failed unexpectedly');
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
     * Gets file metadata by name and parent ID.
     * Useful for checking existence and properties before upload.
     */
    async getFileMetadataByName(name: string, parentId: string): Promise<{ id: string, modifiedTime?: string, md5Checksum?: string } | null> {
        const drive = this.getDrive();
        const escapedName = name.replace(/'/g, "\\'");
        let query = `name = '${escapedName}' and trashed = false`;
        if (parentId) {
            query += ` and '${parentId}' in parents`;
        }

        try {
            const res = await drive.files.list({
                q: query,
                fields: 'files(id, modifiedTime, md5Checksum)',
                spaces: 'drive',
            });

            if (res.data.files && res.data.files.length > 0) {
                return res.data.files[0] as { id: string, modifiedTime?: string, md5Checksum?: string };
            }
            return null;
        } catch (error) {
            console.error(`Failed to get metadata for ${name}:`, error);
            return null;
        }
    }

    /**
     * Lists all files in a specific folder with their metadata.
     * Uses pagination to retrieve all files.
     * Returns a Map<filename, metadata> for efficient lookup.
     */
    async listFilesInFolder(folderId: string): Promise<Map<string, { id: string, modifiedTime?: string, md5Checksum?: string }>> {
        const drive = this.getDrive();
        const fileMap = new Map<string, { id: string, modifiedTime?: string, md5Checksum?: string }>();
        let pageToken: string | undefined = undefined;

        try {
            do {
                const res: any = await drive.files.list({
                    q: `'${folderId}' in parents and trashed = false`,
                    fields: 'nextPageToken, files(id, name, modifiedTime, md5Checksum)',
                    spaces: 'drive',
                    pageToken: pageToken,
                    pageSize: 1000 // Maximize page size to reduce requests
                });

                if (res.data.files) {
                    for (const file of res.data.files) {
                        if (file.name && file.id) {
                            fileMap.set(file.name, {
                                id: file.id,
                                modifiedTime: file.modifiedTime,
                                md5Checksum: file.md5Checksum
                            });
                        }
                    }
                }

                pageToken = res.data.nextPageToken;
            } while (pageToken);

        } catch (error) {
            console.error(`Failed to list files in folder ${folderId}:`, error);
            // We return a partial or empty map instead of throwing to avoid breaking the whole sync
            // If listing fails, smart recovery will just not work for this folder (fallback to individual checks or upload)
        }

        return fileMap;
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
