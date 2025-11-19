import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Notice } from 'obsidian';

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
        if (parentId) {
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
    async uploadFile(name: string, content: string, mimeType: string, parentId?: string): Promise<string> {
        const drive = this.getDrive();
        const fileMetadata: any = {
            name: name,
        };
        if (parentId) {
            fileMetadata.parents = [parentId];
        }
        if (mimeType === 'application/vnd.google-apps.document') {
            fileMetadata.mimeType = mimeType; // Convert to Google Doc
        }

        const media = {
            mimeType: mimeType === 'application/vnd.google-apps.document' ? 'text/markdown' : mimeType,
            body: content,
        };

        const res = await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id',
        });

        if (!res.data.id) throw new Error('Failed to upload file');
        return res.data.id;
    }

    /**
     * Updates an existing file in Google Drive.
     */
    async updateFile(fileId: string, content: string, mimeType: string): Promise<void> {
        const drive = this.getDrive();

        // If it's a Google Doc, we might need to use the Docs API for content updates if we want to preserve formatting,
        // but for simple overwrite (or if we treat it as a new revision), we can use drive.files.update.
        // However, for Google Docs, drive.files.update with media might not work as expected for "converting" content again.
        // For now, let's assume we are updating the content.

        const media = {
            mimeType: mimeType === 'application/vnd.google-apps.document' ? 'text/markdown' : mimeType,
            body: content,
        };

        await drive.files.update({
            fileId: fileId,
            media: media,
        });
    }

    /**
     * Searches for a file by name and parent.
     */
    async getFileId(name: string, parentId?: string): Promise<string | null> {
        const drive = this.getDrive();
        let query = `name = '${name}' and trashed = false`;
        if (parentId) {
            query += ` and '${parentId}' in parents`;
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
}
