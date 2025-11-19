import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import { DriveClient } from './drive/driveClient';
import { SyncManager } from './sync/syncManager';
import { SetupWizardModal } from './ui/setupWizard';

export interface GeminiSyncSettings {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    remoteFolderPath: string;
    syncImages: boolean;
    syncPDFs: boolean;
    syncInterval: number; // in minutes
    excludedFolders: string; // New setting: comma or newline separated list
}

const DEFAULT_SETTINGS: GeminiSyncSettings = {
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    remoteFolderPath: '',
    syncImages: true,
    syncPDFs: true,
    syncInterval: 60,
    excludedFolders: ''
}

export default class GeminiSyncPlugin extends Plugin {
    settings: GeminiSyncSettings;
    driveClient: DriveClient;
    syncManager: SyncManager;
    syncIntervalId: number | undefined;
    statusBarItem: HTMLElement;

    async onload() {
        await this.loadSettings();

        this.initializeDriveClient();

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.setText('');

        this.syncManager = new SyncManager(this.app, this.driveClient, this.settings, this.statusBarItem);

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

        this.configurePeriodicSync();
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

    configurePeriodicSync() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = undefined;
        }

        if (this.settings.syncInterval > 0) {
            // console.log(`Gemini Sync: Enabling periodic sync every ${this.settings.syncInterval} minutes.`);
            this.syncIntervalId = window.setInterval(async () => {
                console.log('Gemini Sync: Triggering periodic sync...');
                await this.syncManager.syncVault();
            }, this.settings.syncInterval * 60 * 1000);
        }
    }

    async onunload() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // Re-configure sync manager with new settings if needed (or just pass settings ref)
        // And update periodic sync
        this.configurePeriodicSync();
        if (this.syncManager) {
            this.syncManager.updateSettings(this.settings);
        }
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

        containerEl.createEl('h3', { text: 'Synchronization Options' });

        new Setting(containerEl)
            .setName('Sync Images')
            .setDesc('Include image files in synchronization.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncImages)
                .onChange(async (value) => {
                    this.plugin.settings.syncImages = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sync PDFs')
            .setDesc('Include PDF files in synchronization.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncPDFs)
                .onChange(async (value) => {
                    this.plugin.settings.syncPDFs = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sync Interval')
            .setDesc('Time in minutes between automatic synchronizations. Set to 0 to disable.')
            .addText(text => text
                .setPlaceholder('60')
                .setValue(String(this.plugin.settings.syncInterval))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.syncInterval = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Excluded Folders')
            .setDesc('List of folders to exclude from synchronization (one per line).')
            .addTextArea(text => text
                .setPlaceholder('Folder1\nFolder2/Subfolder')
                .setValue(this.plugin.settings.excludedFolders)
                .onChange(async (value) => {
                    this.plugin.settings.excludedFolders = value;
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
