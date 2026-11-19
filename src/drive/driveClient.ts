import { Notifier } from '../notifications/notifier';

export interface DriveClientOptions {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    refreshToken?: string;
    onTokenUpdate: (token: string) => Promise<void>;
    notifier?: Notifier;
}

export interface DriveFileMetadata {
    name?: string;
    parents?: string[];
    mimeType?: string;
    trashed?: boolean;
}

export interface DriveListedFile {
    id: string;
    name?: string;
    modifiedTime?: string;
    md5Checksum?: string;
    size?: string;
    parents?: string[];
}

export class DriveHttpError extends Error {
    public status: number;
    public responseBody: string;

    constructor(message: string, status: number, responseBody: string = '') {
        super(message);
        this.name = 'DriveHttpError';
        this.status = status;
        this.responseBody = responseBody;
    }
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export class DriveClient {
    private static readonly SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024; // 5MB
    private options: DriveClientOptions;
    private refreshToken: string;
    private accessToken: string | null = null;
    private accessTokenExpiresAt: number = 0;
    private refreshInFlight: Promise<string> | null = null;
    private verifiedDescendants: Set<string> = new Set();

    constructor(options: DriveClientOptions) {
        this.options = options;
        this.refreshToken = options.refreshToken || '';
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
        const params = new URLSearchParams({
            client_id: this.options.clientId,
            redirect_uri: this.options.redirectUri,
            response_type: 'code',
            access_type: 'offline',
            prompt: 'consent',
            scope: scopes.join(' ')
        });
        return `${GOOGLE_AUTH_URL}?${params.toString()}`;
    }

    /**
     * Exchanges the authorization code for OAuth2 tokens.
     */
    async authorize(code: string): Promise<void> {
        const body = new URLSearchParams({
            code,
            client_id: this.options.clientId,
            client_secret: this.options.clientSecret,
            redirect_uri: this.options.redirectUri,
            grant_type: 'authorization_code'
        });

        const res = await fetch(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });

        if (!res.ok) {
            const txt = await res.text();
            this.options.notifier?.notify('Gemini Sync: Authentication failed. Check console for details.');
            throw new DriveHttpError(`OAuth token exchange failed: ${res.status} ${txt}`, res.status, txt);
        }

        const tokens = await res.json();
        if (tokens.access_token) {
            this.accessToken = tokens.access_token;
            const expiresIn = Number(tokens.expires_in || 3600);
            this.accessTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
        }
        if (tokens.refresh_token) {
            this.refreshToken = tokens.refresh_token;
            await this.options.onTokenUpdate(tokens.refresh_token);
            this.options.notifier?.notify('Gemini Sync: Successfully authenticated with Google Drive!');
        } else {
            console.warn('No refresh token received during authorization.');
            this.options.notifier?.notify('Gemini Sync: Authenticated, but no refresh token received. You may need to re-authorize.');
        }
    }

    /**
     * Checks if the client is ready (has refresh token credentials).
     */
    isReady(): boolean {
        return Boolean(this.refreshToken && this.options.clientId && this.options.clientSecret);
    }

    /**
     * Retrieves a valid OAuth2 access token, refreshing automatically with single-flight deduplication.
     */
    async getAccessToken(forceRefresh = false): Promise<string> {
        if (!forceRefresh && this.accessToken && Date.now() < this.accessTokenExpiresAt) {
            return this.accessToken;
        }
        if (!this.refreshToken) {
            throw new Error('Gemini Sync: No refresh token available. Please authenticate in settings.');
        }
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }

        this.refreshInFlight = (async () => {
            const body = new URLSearchParams({
                client_id: this.options.clientId,
                client_secret: this.options.clientSecret,
                refresh_token: this.refreshToken,
                grant_type: 'refresh_token'
            });

            const res = await this.fetchWithRetry(GOOGLE_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString()
            });

            if (!res.ok) {
                const txt = await res.text();
                throw new DriveHttpError(`Failed to refresh OAuth access token: ${res.status} ${txt}`, res.status, txt);
            }

            const data = await res.json();
            if (!data.access_token) {
                throw new Error('OAuth refresh response did not contain access_token');
            }

            this.accessToken = data.access_token;
            const expiresIn = Number(data.expires_in || 3600);
            this.accessTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;

            if (data.refresh_token && data.refresh_token !== this.refreshToken) {
                this.refreshToken = data.refresh_token;
                await this.options.onTokenUpdate(data.refresh_token);
            }
            return this.accessToken;
        })().finally(() => {
            this.refreshInFlight = null;
        });

        return this.refreshInFlight;
    }

    /**
     * Performs an authenticated fetch with automatic 401 refresh and exponential backoff on 403/408/429/5xx.
     */
    async authorizedFetch(url: string, init: RequestInit = {}, retries = 4): Promise<Response> {
        let backoff = 1000;
        let retriedAuth = false;

        for (let attempt = 0; attempt < retries; attempt++) {
            const token = await this.getAccessToken(false);
            const headers = new Headers(init.headers || {});
            headers.set('Authorization', `Bearer ${token}`);

            let res: Response;
            try {
                res = await fetch(url, { ...init, headers });
            } catch (networkErr) {
                if (attempt === retries - 1) throw networkErr;
                await new Promise(r => setTimeout(r, backoff));
                backoff *= 2;
                continue;
            }

            if (res.ok) return res;

            if (res.status === 401 && !retriedAuth) {
                retriedAuth = true;
                this.accessToken = null;
                this.accessTokenExpiresAt = 0;
                await this.getAccessToken(true);
                continue;
            }

            const isRetryableStatus =
                res.status === 408 ||
                res.status === 429 ||
                (res.status >= 500 && res.status < 600);

            if (isRetryableStatus || res.status === 403) {
                const txt = await res.text();
                const isRateLimit403 = res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|backendError/i.test(txt);
                if ((isRetryableStatus || isRateLimit403) && attempt < retries - 1) {
                    const jitter = Math.floor(Math.random() * 250);
                    console.warn(`Gemini Sync: HTTP ${res.status} on ${url.split('?')[0]}, retrying (${attempt + 1}/${retries}) in ${backoff + jitter}ms...`);
                    await new Promise(r => setTimeout(r, backoff + jitter));
                    backoff *= 2;
                    continue;
                }
                throw new DriveHttpError(`Google API HTTP ${res.status}: ${txt.slice(0, 300)}`, res.status, txt);
            }

            return res;
        }

        throw new Error('Gemini Sync: Request failed after max retries');
    }

    private async fetchWithRetry(url: string, init: RequestInit, retries = 3, backoff = 1000): Promise<Response> {
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url, init);
                if (res.ok) return res;

                if (res.status === 408 || res.status === 429 || (res.status >= 500 && res.status < 600)) {
                    const txt = await res.text();
                    if (i === retries - 1) {
                        throw new DriveHttpError(`Request failed after ${retries} retries: ${res.status} ${txt}`, res.status, txt);
                    }
                    await new Promise(resolve => setTimeout(resolve, backoff));
                    backoff *= 2;
                    continue;
                }
                return res;
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, backoff));
                backoff *= 2;
            }
        }
        throw new Error('Unreachable');
    }

    /**
     * Creates a folder in Google Drive.
     */
    async createFolder(name: string, parentId?: string): Promise<string> {
        const fileMetadata: DriveFileMetadata = {
            name,
            mimeType: 'application/vnd.google-apps.folder',
        };
        if (parentId && parentId !== 'root') {
            fileMetadata.parents = [parentId];
        }

        const res = await this.authorizedFetch(`${DRIVE_API_BASE}/files?fields=id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(fileMetadata)
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new DriveHttpError(`Failed to create folder "${name}": ${res.status} ${txt}`, res.status, txt);
        }

        const data = await res.json();
        if (!data.id) throw new Error(`Failed to create folder "${name}": missing ID`);
        return data.id;
    }

    /**
     * Uploads a file to Google Drive.
     */
    async uploadFile(name: string, content: string | Buffer | Record<string, unknown>, mimeType: string, parentId?: string): Promise<string> {
        const sourceMimeType = mimeType === 'application/vnd.google-apps.document' ? 'text/plain' : mimeType;
        const targetMimeType = mimeType === 'application/vnd.google-apps.document' ? 'application/vnd.google-apps.document' : undefined;
        const blob = this.toBlob(content, sourceMimeType);

        if (this.shouldUseResumable(blob)) {
            return this.uploadFileResumable(name, blob, sourceMimeType, parentId, targetMimeType);
        }
        return this.uploadFileMultipart(name, blob, sourceMimeType, parentId, targetMimeType);
    }

    /**
     * Updates an existing file in Google Drive.
     */
    async updateFile(fileId: string, content: string | Buffer | Record<string, unknown>, mimeType: string): Promise<void> {
        const sourceMimeType = mimeType === 'application/vnd.google-apps.document' ? 'text/plain' : mimeType;
        const blob = this.toBlob(content, sourceMimeType);

        if (this.shouldUseResumable(blob)) {
            await this.updateFileResumable(fileId, blob, sourceMimeType);
        } else {
            await this.updateFileMultipart(fileId, blob, sourceMimeType);
        }
    }

    /**
     * Renames and/or moves a file on Google Drive via a single lightweight metadata PATCH.
     */
    async renameOrMoveFile(fileId: string, newName: string, newParentId?: string, oldParentId?: string): Promise<void> {
        const params = new URLSearchParams({ fields: 'id,name,parents' });
        if (newParentId && oldParentId && newParentId !== oldParentId) {
            params.set('addParents', newParentId);
            params.set('removeParents', oldParentId);
        }
        const res = await this.authorizedFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({ name: newName })
        });
        if (!res.ok) {
            const txt = await res.text();
            throw new DriveHttpError(`Failed to rename/move file ${fileId}: ${res.status} ${txt}`, res.status, txt);
        }
    }

    private toBlob(content: string | Buffer | Record<string, unknown>, sourceMimeType: string): Blob {
        if (Buffer.isBuffer(content)) {
            return new Blob([new Uint8Array(content)], { type: sourceMimeType });
        }
        if (typeof content === 'string') {
            return new Blob([content], { type: sourceMimeType });
        }
        return new Blob([JSON.stringify(content)], { type: sourceMimeType });
    }

    private buildContentRange(blob: Blob): string {
        if (blob.size === 0) return 'bytes */0';
        return `bytes 0-${blob.size - 1}/${blob.size}`;
    }

    private shouldUseResumable(blob: Blob): boolean {
        return blob.size > DriveClient.SIMPLE_UPLOAD_LIMIT;
    }

    private buildMultipartBoundary(): string {
        const rand = Math.random().toString(36).slice(2);
        return `gemini-sync-${Date.now()}-${rand}`;
    }

    private async buildMultipartBody(boundary: string, metadata: DriveFileMetadata, blob: Blob, sourceMimeType: string): Promise<ArrayBuffer> {
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
        const metadata: DriveFileMetadata = { name };
        if (parentId && parentId !== 'root') metadata.parents = [parentId];
        if (targetMimeType) metadata.mimeType = targetMimeType;

        const boundary = this.buildMultipartBoundary();
        const body = await this.buildMultipartBody(boundary, metadata, blob, sourceMimeType);
        const bodyBytes = new Uint8Array(body);

        const res = await this.authorizedFetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': bodyBytes.byteLength.toString()
            },
            body: bodyBytes
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new DriveHttpError(`Failed to upload file (multipart): ${res.status} ${txt}`, res.status, txt);
        }

        const result = await res.json();
        if (!result.id) throw new Error('Upload response missing file ID');
        return result.id;
    }

    private async updateFileMultipart(fileId: string, blob: Blob, mimeType: string): Promise<void> {
        const boundary = this.buildMultipartBoundary();
        const body = await this.buildMultipartBody(boundary, {}, blob, mimeType);
        const bodyBytes = new Uint8Array(body);

        const res = await this.authorizedFetch(`${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=multipart`, {
            method: 'PATCH',
            headers: {
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': bodyBytes.byteLength.toString()
            },
            body: bodyBytes
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new DriveHttpError(`Failed to update file (multipart): ${res.status} ${txt}`, res.status, txt);
        }
    }

    async uploadFileResumable(name: string, blob: Blob, sourceMimeType: string, parentId?: string, targetMimeType?: string): Promise<string> {
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const metadata: DriveFileMetadata = { name };
                if (parentId && parentId !== 'root') metadata.parents = [parentId];
                if (targetMimeType) metadata.mimeType = targetMimeType;

                const initRes = await this.authorizedFetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=resumable`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json; charset=UTF-8',
                        'X-Upload-Content-Type': sourceMimeType,
                        'X-Upload-Content-Length': blob.size.toString()
                    },
                    body: JSON.stringify(metadata)
                });

                if (!initRes.ok) {
                    const txt = await initRes.text();
                    throw new DriveHttpError(`Failed to initiate upload: ${initRes.status} ${txt}`, initRes.status, txt);
                }

                const location = initRes.headers.get('Location');
                if (!location) throw new Error('No Location header in resumable upload response');

                const contentRange = this.buildContentRange(blob);
                const buffer = await blob.arrayBuffer();
                const uploadRes = await this.authorizedFetch(location, {
                    method: 'PUT',
                    headers: {
                        'Content-Length': blob.size.toString(),
                        'Content-Type': sourceMimeType,
                        'Content-Range': contentRange
                    },
                    body: buffer
                });

                if (!uploadRes.ok) {
                    const txt = await uploadRes.text();
                    throw new DriveHttpError(`Failed to upload content: ${uploadRes.status} ${txt}`, uploadRes.status, txt);
                }

                const result = await uploadRes.json();
                return result.id;
            } catch (error: any) {
                const is410 = error?.status === 410 || String(error?.message || '').includes('410');
                if (is410 && attempt < maxAttempts) {
                    continue;
                }
                throw error;
            }
        }
        throw new Error('Upload failed unexpectedly');
    }

    async updateFileResumable(fileId: string, blob: Blob, mimeType: string): Promise<void> {
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const initRes = await this.authorizedFetch(`${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=resumable`, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json; charset=UTF-8',
                        'X-Upload-Content-Type': mimeType,
                        'X-Upload-Content-Length': blob.size.toString()
                    },
                    body: JSON.stringify({})
                });

                if (!initRes.ok) {
                    const txt = await initRes.text();
                    throw new DriveHttpError(`Failed to initiate update: ${initRes.status} ${txt}`, initRes.status, txt);
                }

                const location = initRes.headers.get('Location');
                if (!location) throw new Error('No Location header in resumable update response');

                const contentRange = this.buildContentRange(blob);
                const buffer = await blob.arrayBuffer();
                const uploadRes = await this.authorizedFetch(location, {
                    method: 'PUT',
                    headers: {
                        'Content-Length': blob.size.toString(),
                        'Content-Type': mimeType,
                        'Content-Range': contentRange
                    },
                    body: buffer
                });

                if (!uploadRes.ok) {
                    const txt = await uploadRes.text();
                    throw new DriveHttpError(`Failed to update content: ${uploadRes.status} ${txt}`, uploadRes.status, txt);
                }
                return;
            } catch (error: any) {
                const is410 = error?.status === 410 || String(error?.message || '').includes('410');
                if (is410 && attempt < maxAttempts) {
                    continue;
                }
                throw error;
            }
        }
        throw new Error('Update failed unexpectedly');
    }

    /**
     * Soft-deletes a file or folder (moves to Google Drive Trash) after checking vault scope.
     */
    async deleteFile(fileId: string, scopeId?: string): Promise<void> {
        if (scopeId && fileId !== scopeId) {
            const isSafe = await this.isDescendant(fileId, scopeId);
            if (!isSafe) {
                console.error(`Security Block: Attempted to delete file ${fileId} which is not inside scope ${scopeId}`);
                throw new Error('Security Violation: File is outside the allowed vault scope.');
            }
        }

        const res = await this.authorizedFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({ trashed: true })
        });

        if (!res.ok && res.status !== 404) {
            const txt = await res.text();
            throw new DriveHttpError(`Failed to trash file ${fileId}: ${res.status} ${txt}`, res.status, txt);
        }
    }

    private async isDescendant(childId: string, ancestorId: string): Promise<boolean> {
        const cacheKey = `${ancestorId}:${childId}`;
        if (this.verifiedDescendants.has(cacheKey)) return true;

        let currentId = childId;
        const visited: string[] = [];
        for (let depth = 0; depth < 50; depth++) {
            const res = await this.authorizedFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(currentId)}?fields=parents`);
            if (res.status === 404) return false;
            if (!res.ok) return false;

            const data = await res.json();
            const parents: string[] = data.parents || [];
            if (parents.length === 0) return false;

            visited.push(currentId);
            if (parents.includes(ancestorId) || parents.some(p => this.verifiedDescendants.has(`${ancestorId}:${p}`))) {
                for (const id of visited) {
                    this.verifiedDescendants.add(`${ancestorId}:${id}`);
                }
                return true;
            }
            currentId = parents[0];
        }
        return false;
    }

    /**
     * Lists files matching a Drive query with automatic pagination.
     */
    async listFilesByQuery(q: string, fields: string = 'files(id, name, modifiedTime, md5Checksum, size)'): Promise<DriveListedFile[]> {
        const results: DriveListedFile[] = [];
        let pageToken: string | undefined;

        do {
            const params = new URLSearchParams({
                q,
                fields: `nextPageToken, ${fields}`,
                spaces: 'drive',
                pageSize: '1000'
            });
            if (pageToken) params.set('pageToken', pageToken);

            const res = await this.authorizedFetch(`${DRIVE_API_BASE}/files?${params.toString()}`);
            if (!res.ok) {
                const txt = await res.text();
                throw new DriveHttpError(`Drive files.list failed: ${res.status} ${txt}`, res.status, txt);
            }

            const data = await res.json();
            if (Array.isArray(data.files)) {
                results.push(...data.files);
            }
            pageToken = data.nextPageToken || undefined;
        } while (pageToken);

        return results;
    }

    /**
     * Searches for a single file by name, parent, and optional mimeType.
     */
    async getFileId(name: string, parentId?: string, mimeType?: string): Promise<string | null> {
        const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        let query = `name = '${escapedName}' and trashed = false`;
        if (parentId) query += ` and '${parentId}' in parents`;
        if (mimeType) query += ` and mimeType = '${mimeType}'`;

        const files = await this.listFilesByQuery(query, 'files(id)');
        return files.length > 0 ? files[0].id : null;
    }

    /**
     * Lists all files in a folder as a Map<filename, metadata>.
     */
    async listFilesInFolder(folderId: string): Promise<Map<string, { id: string; modifiedTime?: string; md5Checksum?: string }>> {
        const fileMap = new Map<string, { id: string; modifiedTime?: string; md5Checksum?: string }>();
        const files = await this.listFilesByQuery(
            `'${folderId}' in parents and trashed = false`,
            'files(id, name, modifiedTime, md5Checksum)'
        );
        for (const file of files) {
            if (file.name && file.id) {
                fileMap.set(file.name, {
                    id: file.id,
                    modifiedTime: file.modifiedTime,
                    md5Checksum: file.md5Checksum
                });
            }
        }
        return fileMap;
    }

    /**
     * Downloads the content of a file as text.
     */
    async getFileContent(fileId: string): Promise<string | null> {
        const res = await this.authorizedFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`);
        if (res.status === 404) return null;
        if (!res.ok) {
            const txt = await res.text();
            throw new DriveHttpError(`Failed to download content for ${fileId}: ${res.status} ${txt}`, res.status, txt);
        }
        return await res.text();
    }

    /**
     * Downloads the content of a file as an ArrayBuffer.
     */
    async getFileBuffer(fileId: string): Promise<ArrayBuffer | null> {
        const res = await this.authorizedFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`);
        if (res.status === 404) return null;
        if (!res.ok) {
            const txt = await res.text();
            throw new DriveHttpError(`Failed to download binary for ${fileId}: ${res.status} ${txt}`, res.status, txt);
        }
        return await res.arrayBuffer();
    }
}
