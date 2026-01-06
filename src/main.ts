import { App, Plugin, PluginSettingTab, Setting, Notice, setIcon } from 'obsidian';
import { DriveClient } from './drive/driveClient';
import { SyncManager } from './sync/syncManager';
import { SetupWizardModal } from './ui/setupWizard';
import { FolderSuggestModal } from './ui/folderSuggest';

export interface SyncIndexEntry {
    path: string;
    driveId: string;
    hash: string;
    lastModified: number;
}

export interface SyncIndex {
    [path: string]: SyncIndexEntry;
}

export interface GeminiSyncSettings {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    remoteFolderPath: string;
    syncOnStartup: boolean;
    syncImages: boolean;
    syncPDFs: boolean;
    syncCanvas: boolean;
    syncInterval: number; // in minutes
    excludedFolders: string[];
    syncIndex: SyncIndex;
    // Project Sync Settings
    projectsFolderPath: string;
    enableTaskSync: boolean;
    deleteTaskAfterSync: boolean;
}

const DEFAULT_SETTINGS: GeminiSyncSettings = {
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    remoteFolderPath: '',
    syncOnStartup: true,
    syncImages: true,
    syncPDFs: true,
    syncCanvas: true,
    syncInterval: 60,
    excludedFolders: [],
    syncIndex: {},
    projectsFolderPath: 'Projects', // Default folder
    enableTaskSync: true,
    deleteTaskAfterSync: true
}

export default class GeminiSyncPlugin extends Plugin {
    settings: GeminiSyncSettings;
    driveClient: DriveClient;
    syncManager: SyncManager;
    syncIntervalId: number | undefined;
    statusBarItem: HTMLElement;

    async onload() {
        console.log('Gemini Sync: Loading v1.8.0 with Canvas Support');
        await this.loadSettings();

        this.initializeDriveClient();

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.setText('');

        this.syncManager = new SyncManager(this.app, this.driveClient, this.settings, this.statusBarItem, () => this.saveSettings());

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

        // Trigger sync on startup if enabled
        if (this.settings.syncOnStartup) {
            this.app.workspace.onLayoutReady(async () => {
                // console.log('Gemini Sync: Triggering startup sync...');
                await this.syncManager.syncVault();
            });
        }
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

        if (this.syncManager) {
            this.syncManager.updateDriveClient(this.driveClient);
        }
    }

    configurePeriodicSync() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = undefined;
        }

        if (this.settings.syncInterval > 0) {
            // console.log(`Gemini Sync: Enabling periodic sync every ${this.settings.syncInterval} minutes.`);
            this.syncIntervalId = window.setInterval(async () => {
                // console.log('Gemini Sync: Triggering periodic sync...');
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
        const loadedData = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

        // Migration: Convert string excludedFolders to array if needed
        if (typeof this.settings.excludedFolders === 'string') {
            const oldString = this.settings.excludedFolders as string;
            if (oldString.trim() === '') {
                this.settings.excludedFolders = [];
            } else {
                this.settings.excludedFolders = oldString
                    .split(/[\n,]+/)
                    .map(s => s.trim())
                    .filter(s => s.length > 0);
            }
            await this.saveSettings();
        }
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
            .setName('Sync on Startup')
            .setDesc('Automatically sync when Obsidian starts.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncOnStartup)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnStartup = value;
                    await this.plugin.saveSettings();
                }));

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
            .setName('Sync Canvas')
            .setDesc('Convert and sync .canvas files as Google Docs.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncCanvas)
                .onChange(async (value) => {
                    this.plugin.settings.syncCanvas = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Project Sync Options' });

        new Setting(containerEl)
            .setName('Enable Task Sync')
            .setDesc('Create Project notes from Google Tasks starting with [PROJET].')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTaskSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableTaskSync = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide dependent settings
                }));

        if (this.plugin.settings.enableTaskSync) {
            new Setting(containerEl)
                .setName('Projects Folder')
                .setDesc('Folder where new Project notes will be created.')
                .addButton(button => button
                    .setButtonText(this.plugin.settings.projectsFolderPath || 'Select Folder')
                    .onClick(() => {
                        new FolderSuggestModal(this.app, async (folder) => {
                            this.plugin.settings.projectsFolderPath = folder.path;
                            await this.plugin.saveSettings();
                            this.display();
                        }).open();
                    }));

            new Setting(containerEl)
                .setName('Complete Tasks After Sync')
                .setDesc('Mark tasks as completed in Google Tasks after creating the note.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.deleteTaskAfterSync)
                    .onChange(async (value) => {
                        this.plugin.settings.deleteTaskAfterSync = value;
                        await this.plugin.saveSettings();
                    }));
        }

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

        // --- Excluded Folders Section ---
        containerEl.createEl('h3', { text: 'Excluded Folders' });

        const excludedFoldersSetting = new Setting(containerEl)
            .setName('Manage Excluded Folders')
            .setDesc('Folders added here will be ignored during synchronization.')
            .addButton(button => button
                .setButtonText('Add Folder')
                .setCta()
                .onClick(() => {
                    new FolderSuggestModal(this.app, async (folder) => {
                        if (!this.plugin.settings.excludedFolders.includes(folder.path)) {
                            this.plugin.settings.excludedFolders.push(folder.path);
                            await this.plugin.saveSettings();
                            this.display(); // Refresh settings to show new folder
                        } else {
                            new Notice('Folder already excluded');
                        }
                    }).open();
                }));

        // List of excluded folders
        if (this.plugin.settings.excludedFolders.length > 0) {
            const listContainer = containerEl.createDiv('gemini-sync-excluded-list');
            listContainer.style.marginTop = '10px';

            this.plugin.settings.excludedFolders.forEach((path, index) => {
                const itemContainer = listContainer.createDiv('gemini-sync-excluded-item');
                itemContainer.style.display = 'flex';
                itemContainer.style.alignItems = 'center';
                itemContainer.style.justifyContent = 'space-between';
                itemContainer.style.marginBottom = '5px';
                itemContainer.style.padding = '5px 10px';
                itemContainer.style.backgroundColor = 'var(--background-secondary)';
                itemContainer.style.borderRadius = '5px';

                itemContainer.createSpan({ text: path });

                const removeBtn = itemContainer.createEl('button', { cls: 'clickable-icon' });
                removeBtn.style.background = 'transparent';
                removeBtn.style.boxShadow = 'none';
                removeBtn.style.padding = '0';
                removeBtn.style.height = 'fit-content';

                setIcon(removeBtn, 'cross');
                removeBtn.onclick = async () => {
                    this.plugin.settings.excludedFolders.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.display();
                };
            });
        } else {
            containerEl.createDiv({
                text: 'No folders excluded.',
                cls: 'setting-item-description',
                attr: { style: 'margin-bottom: 18px; font-style: italic;' }
            });
        }


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

            containerEl.createEl('hr');

            const div = containerEl.createDiv();
            div.style.display = 'flex';
            div.style.justifyContent = 'center';
            div.style.marginTop = '20px';

            new Setting(div)
                .setName('Danger Zone')
                .setDesc('')
                .addButton(button => button
                    .setButtonText('FORCE RESYNC (Delete Remote & Restart)')
                    .setWarning()
                    .onClick(async () => {
                        if (confirm('Are you sure? This will DELETE the remote folder and re-upload everything. This action cannot be undone.')) {
                            new Notice('Starting Force Resync...');
                            await this.plugin.syncManager.forceResync();
                            new Notice('Force Resync completed.');
                        }
                    }));
        }
    }
}
