import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import { DriveClient } from './drive/driveClient';
import { SyncManager } from './sync/syncManager';
import { SetupWizardModal } from './ui/setupWizard';

interface GeminiSyncSettings {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    remoteFolderPath: string;
}

const DEFAULT_SETTINGS: GeminiSyncSettings = {
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    remoteFolderPath: ''
}

export default class GeminiSyncPlugin extends Plugin {
    settings: GeminiSyncSettings;
    driveClient: DriveClient;
    syncManager: SyncManager;

    async onload() {
        await this.loadSettings();

        this.initializeDriveClient();

        this.syncManager = new SyncManager(this.app, this.driveClient);

        this.addSettingTab(new GeminiSyncSettingTab(this.app, this));

        // Command to test auth
        this.addCommand({
            id: 'test-auth',
            name: 'Test Authentication',
            callback: async () => {
                if (this.driveClient.isReady()) {
                    new Notice('Authenticated!');
                } else {
                    new Notice('Not authenticated. Please check settings.');
                }
            }
        });

        // Command to Sync
        this.addCommand({
            id: 'sync-now',
            name: 'Sync Now',
            callback: async () => {
                await this.syncManager.syncVault();
            }
        });

        // Ribbon Icon
        this.addRibbonIcon('refresh-cw', 'Gemini Sync', async () => {
            await this.syncManager.syncVault();
        });
    }

    initializeDriveClient() {
        this.driveClient = new DriveClient({
            clientId: this.settings.clientId,
            clientSecret: this.settings.clientSecret,
            redirectUri: 'urn:ietf:wg:oauth:2.0:oob', // Manual copy-paste flow
            refreshToken: this.settings.refreshToken,
            onTokenUpdate: async (token) => {
                this.settings.refreshToken = token;
                await this.saveSettings();
            }
        });
    }

    async onunload() {

    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class GeminiSyncSettingTab extends PluginSettingTab {
    plugin: GeminiSyncPlugin;

    constructor(app: App, plugin: GeminiSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl('h2', { text: 'Gemini Sync Settings' });

        // Wizard Button
        new Setting(containerEl)
            .setName('Setup Wizard')
            .setDesc('Launch the step-by-step guide to configure the plugin.')
            .addButton(button => button
                .setButtonText('Start Wizard')
                .setCta()
                .onClick(() => {
                    new SetupWizardModal(this.app, this.plugin).open();
                }));


        new Setting(containerEl)
            .setName('Remote Folder')
            .setDesc('Path to the folder on Google Drive (e.g. Backups/MyVault). Leave empty for root.')
            .addText(text => text
                .setPlaceholder('e.g. Obsidian/MyVault')
                .setValue(this.plugin.settings.remoteFolderPath)
                .onChange(async (value) => {
                    this.plugin.settings.remoteFolderPath = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('hr');
        containerEl.createEl('h3', { text: 'Manual Configuration' });

        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('OAuth 2.0 Client ID from Google Cloud Console')
            .addText(text => text
                .setPlaceholder('Enter your Client ID')
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Client Secret')
            .setDesc('OAuth 2.0 Client Secret')
            .addText(text => text
                .setPlaceholder('Enter your Client Secret')
                .setValue(this.plugin.settings.clientSecret)
                .onChange(async (value) => {
                    this.plugin.settings.clientSecret = value;
                    await this.plugin.saveSettings();
                }));



        containerEl.createEl('h3', { text: 'Authentication' });

        new Setting(containerEl)
            .setName('Step 1: Generate Auth URL')
            .setDesc('Click to open the authentication page in your browser.')
            .addButton(button => button
                .setButtonText('Generate URL')
                .onClick(() => {
                    if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
                        new Notice('Please enter Client ID and Secret first.');
                        return;
                    }
                    // Re-initialize client with new settings if needed
                    this.plugin.initializeDriveClient();

                    const url = this.plugin.driveClient.generateAuthUrl();
                    window.open(url);
                }));

        let authCode = '';
        new Setting(containerEl)
            .setName('Step 2: Enter Auth Code')
            .setDesc('Paste the code received from Google here.')
            .addText(text => text
                .setPlaceholder('Paste code here')
                .onChange(async (value) => {
                    authCode = value;
                }))
            .addButton(button => button
                .setButtonText('Authenticate')
                .setCta()
                .onClick(async () => {
                    if (!authCode) {
                        new Notice('Please paste the code first.');
                        return;
                    }
                    try {
                        await this.plugin.driveClient.authorize(authCode);
                        // Refresh settings view to show status (optional, or just show notice)
                        this.display();
                    } catch (e) {
                        new Notice('Authentication failed.');
                    }
                }));

        if (this.plugin.settings.refreshToken) {
            containerEl.createEl('p', { text: '✅ Currently authenticated', cls: 'gemini-sync-success' });

            new Setting(containerEl)
                .setName('Disconnect')
                .setDesc('Remove stored credentials')
                .addButton(button => button
                    .setButtonText('Disconnect')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.refreshToken = '';
                        await this.plugin.saveSettings();
                        this.display();
                        new Notice('Disconnected.');
                    }));
        }
    }
}
