import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, setIcon } from 'obsidian';
import { DriveClient } from './drive/driveClient';
import { SyncManager } from './sync/syncManager';
import { ObsidianNotifier } from './notifications/obsidianNotifier';
import { SetupWizardModal } from './ui/setupWizard';
import { FolderSuggestModal } from './ui/folderSuggest';
import { LocalSyncCache } from './sync/localCache';

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
    startupDelaySeconds: number;
    enableWatchdog: boolean;
    watchDebounceSeconds: number;
    syncImages: boolean;
    syncPDFs: boolean;
    syncCanvas: boolean;
    syncInterval: number; // in minutes
    excludedFolders: string[];
    syncIndex?: SyncIndex; // Legacy only: migrated automatically out of data.json into ~/.obsidian-gemini-sync/
    // Project Sync Settings
    projectsFolderPath: string;
    enableTaskSync: boolean;
    deleteNoteOnTaskComplete: boolean;
    completionTag: string;
    taskTag: string;
}

const DEFAULT_SETTINGS: GeminiSyncSettings = {
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    remoteFolderPath: '',
    syncOnStartup: true,
    startupDelaySeconds: 30,
    enableWatchdog: true,
    watchDebounceSeconds: 60,
    syncImages: true,
    syncPDFs: true,
    syncCanvas: true,
    syncInterval: 60,
    excludedFolders: [],
    projectsFolderPath: 'Projects',
    enableTaskSync: true,
    deleteNoteOnTaskComplete: true,
    completionTag: 'projet-fini',
    taskTag: 'todo'
};

export default class GeminiSyncPlugin extends Plugin {
    settings: GeminiSyncSettings;
    driveClient: DriveClient;
    syncManager: SyncManager;
    localCache: LocalSyncCache;
    syncIntervalId: number | undefined;
    startupTimeoutId: number | undefined;
    statusBarItem: HTMLElement;
    notifier: ObsidianNotifier;

    async onload() {
        await this.loadSettings();

        const adapter = this.app.vault.adapter as any;
        const vaultId = typeof adapter?.getBasePath === 'function'
            ? adapter.getBasePath()
            : this.app.vault.getName();
        this.localCache = new LocalSyncCache(vaultId);

        // One-time migration: move bloated syncIndex (2.6 MB) out of data.json to external local cache
        if (this.settings.syncIndex && Object.keys(this.settings.syncIndex).length > 0) {
            const migrated = this.localCache.migrateFromLegacySyncIndex(this.settings.syncIndex);
            if (migrated) {
                delete this.settings.syncIndex;
                await this.saveData(this.settings);
                console.log(`Gemini Sync: Migrated ${this.localCache.size()} cache entries out of data.json to ${this.localCache.getCacheFilePath()}`);
            }
        }

        this.notifier = new ObsidianNotifier();
        this.initializeDriveClient();

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.setText('');

        this.syncManager = new SyncManager(
            this.app,
            this.driveClient,
            this.settings,
            this.statusBarItem,
            () => this.saveSettings(),
            this.notifier,
            this.localCache
        );

        this.addSettingTab(new GeminiSyncSettingTab(this.app, this));

        this.addCommand({
            id: 'test-auth',
            name: 'Test Authentication',
            callback: async () => {
                if (this.driveClient.isReady()) {
                    new Notice('Gemini Sync: Authenticated!');
                } else {
                    new Notice('Gemini Sync: Not authenticated. Please check settings.');
                }
            }
        });

        this.addCommand({
            id: 'sync-now',
            name: 'Sync Now',
            callback: async () => {
                await this.syncManager.syncVault({ silent: false });
            }
        });

        this.addRibbonIcon('refresh-cw', 'Gemini Sync', async () => {
            await this.syncManager.syncVault({ silent: false });
        });

        this.configurePeriodicSync();

        // Register watchdog listeners & deprioritized startup reconciliation ONLY after layout is ready
        this.app.workspace.onLayoutReady(() => {
            // Incremental per-file watchdog (60s debounce -> single PATCH for instant Mobile Gemini continuity)
            this.registerEvent(this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) this.syncManager.scheduleFileSync(file);
            }));
            this.registerEvent(this.app.vault.on('create', (file) => {
                if (file instanceof TFile) this.syncManager.scheduleFileSync(file);
            }));
            this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile) void this.syncManager.handleFileRename(file, oldPath);
            }));
            this.registerEvent(this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) this.syncManager.scheduleFileDelete(file.path);
            }));

            // Deprioritized startup reconciliation (keeps syncOnStartup=true, runs after T+30s when Obsidian has settled)
            if (this.settings.syncOnStartup) {
                const triggerSync = () => {
                    const delayMs = Math.max(5, this.settings.startupDelaySeconds || 30) * 1000;
                    this.startupTimeoutId = window.setTimeout(async () => {
                        this.startupTimeoutId = undefined;
                        await this.syncManager.syncVault({ silent: true });
                    }, delayMs);
                };

                if ((this.app.metadataCache as any).initialized) {
                    triggerSync();
                } else {
                    this.registerEvent(
                        (this.app.metadataCache as any).on('initialized', () => {
                            triggerSync();
                        })
                    );
                }
            }
        });
    }

    initializeDriveClient() {
        this.driveClient = new DriveClient({
            clientId: this.settings.clientId,
            clientSecret: this.settings.clientSecret,
            redirectUri: 'http://127.0.0.1',
            refreshToken: this.settings.refreshToken,
            onTokenUpdate: async (token) => {
                this.settings.refreshToken = token;
                await this.saveSettings();
            },
            notifier: this.notifier
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
            this.syncIntervalId = window.setInterval(async () => {
                await this.syncManager.syncVault({ silent: true });
            }, this.settings.syncInterval * 60 * 1000);
        }
    }

    async onunload() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = undefined;
        }
        if (this.startupTimeoutId) {
            window.clearTimeout(this.startupTimeoutId);
            this.startupTimeoutId = undefined;
        }
        if (this.syncManager) {
            this.syncManager.dispose();
        }
    }

    async loadSettings() {
        const loadedData = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

        if (typeof this.settings.excludedFolders === 'string') {
            const oldString = this.settings.excludedFolders as unknown as string;
            if (oldString.trim() === '') {
                this.settings.excludedFolders = [];
            } else {
                this.settings.excludedFolders = oldString
                    .split(/[\n,]+/)
                    .map(s => s.trim())
                    .filter(s => s.length > 0);
            }
            await this.saveData(this.settings);
        }
    }

    async saveSettings() {
        // Never persist legacy syncIndex back into data.json
        const { syncIndex: _ignored, ...cleanSettings } = this.settings;
        await this.saveData(cleanSettings);
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
            .setName('Enable Incremental Watchdog (Real-time Mobile Sync)')
            .setDesc('Automatically push only the modified note after a short debounce so Gemini Mobile stays up to date with near-zero CPU usage.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableWatchdog)
                .onChange(async (value) => {
                    this.plugin.settings.enableWatchdog = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Watchdog Debounce (seconds)')
            .setDesc('Wait time after the last edit on a note before sending a single PATCH to Google Drive (default: 60s).')
            .addText(text => text
                .setPlaceholder('60')
                .setValue(String(this.plugin.settings.watchDebounceSeconds || 60))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 5) {
                        this.plugin.settings.watchDebounceSeconds = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Sync on Startup (Low-Priority Reconciliation)')
            .setDesc('Run a fast incremental reconciliation after Obsidian starts.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncOnStartup)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnStartup = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Startup Sync Delay (seconds)')
            .setDesc('Delay before running startup reconciliation so Obsidian loads smoothly first (default: 30s).')
            .addText(text => text
                .setPlaceholder('30')
                .setValue(String(this.plugin.settings.startupDelaySeconds || 30))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 5) {
                        this.plugin.settings.startupDelaySeconds = num;
                        await this.plugin.saveSettings();
                    }
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

        containerEl.createEl('h3', { text: 'Google Tasks Sync Options' });

        new Setting(containerEl)
            .setName('Enable Task Sync')
            .setDesc('Create notes from active Google Tasks.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTaskSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableTaskSync = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.enableTaskSync) {
            new Setting(containerEl)
                .setName('Tasks Folder')
                .setDesc('Folder where new Task notes will be created.')
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
                .setName('Delete Note on Completion')
                .setDesc('When a task is marked as Done in Google Tasks, delete the corresponding Obsidian note from the vault.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.deleteNoteOnTaskComplete)
                    .onChange(async (value) => {
                        this.plugin.settings.deleteNoteOnTaskComplete = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Task Tag')
                .setDesc('Tag added to newly created task notes (e.g. todo). Do not include the #.')
                .addText(text => text
                    .setPlaceholder('todo')
                    .setValue(this.plugin.settings.taskTag || 'todo')
                    .onChange(async (value) => {
                        this.plugin.settings.taskTag = value.trim().replace(/^#/, '');
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Completion Tag')
                .setDesc('Tag that indicates a project is completed locally (e.g. projet-fini). Do not include the #.')
                .addText(text => text
                    .setPlaceholder('projet-fini')
                    .setValue(this.plugin.settings.completionTag)
                    .onChange(async (value) => {
                        this.plugin.settings.completionTag = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName('Sync Interval')
            .setDesc('Time in minutes between full reconciliation sweeps. Set to 0 to disable.')
            .addText(text => text
                .setPlaceholder('60')
                .setValue(String(this.plugin.settings.syncInterval))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.syncInterval = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // --- Excluded Folders Section ---
        containerEl.createEl('h3', { text: 'Excluded Folders' });

        new Setting(containerEl)
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
                            this.display();
                        } else {
                            new Notice('Folder already excluded');
                        }
                    }).open();
                }));

        if (this.plugin.settings.excludedFolders.length > 0) {
            const listContainer = containerEl.createDiv('gemini-sync-excluded-list');
            listContainer.style.marginTop = '10px';

            this.plugin.settings.excludedFolders.forEach((folderPath, index) => {
                const itemContainer = listContainer.createDiv('gemini-sync-excluded-item');
                itemContainer.style.display = 'flex';
                itemContainer.style.alignItems = 'center';
                itemContainer.style.justifyContent = 'space-between';
                itemContainer.style.marginBottom = '5px';
                itemContainer.style.padding = '5px 10px';
                itemContainer.style.backgroundColor = 'var(--background-secondary)';
                itemContainer.style.borderRadius = '5px';

                itemContainer.createSpan({ text: folderPath });

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
                    this.plugin.initializeDriveClient();
                    const url = this.plugin.driveClient.generateAuthUrl();
                    window.open(url);
                }));

        let authCode = '';
        new Setting(containerEl)
            .setName('Step 2: Enter Auth Code (or URL)')
            .setDesc('Paste the code or the full http://127.0.0.1 URL received from Google here.')
            .addText(text => text
                .setPlaceholder('Paste code or URL here')
                .onChange(async (value) => {
                    authCode = value.trim();
                    if (authCode.startsWith('http')) {
                        try {
                            const url = new URL(authCode);
                            const extracted = url.searchParams.get('code');
                            if (extracted) authCode = extracted;
                        } catch (e) {}
                    }
                }))
            .addButton(button => button
                .setButtonText('Authenticate')
                .setCta()
                .onClick(async () => {
                    if (!authCode) {
                        new Notice('Please paste the code or URL first.');
                        return;
                    }
                    try {
                        await this.plugin.driveClient.authorize(authCode);
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
