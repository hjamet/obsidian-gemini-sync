import { App, Modal, Setting, Notice } from 'obsidian';
import GeminiSyncPlugin from '../main';

export class SetupWizardModal extends Modal {
    plugin: GeminiSyncPlugin;
    currentStep: number = 0;
    steps: Function[];

    constructor(app: App, plugin: GeminiSyncPlugin) {
        super(app);
        this.plugin = plugin;
        this.steps = [
            this.renderWelcome.bind(this),
            this.renderProjectCreation.bind(this),
            this.renderOAuthConsent.bind(this),
            this.renderCredentials.bind(this),
            this.renderAuthentication.bind(this),
            this.renderRemoteFolder.bind(this),
            this.renderCompletion.bind(this)
        ];
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.renderStep();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    renderStep() {
        const { contentEl } = this;
        contentEl.empty();

        const stepContainer = contentEl.createDiv('setup-wizard-step');

        // Progress indicator
        const progressDiv = stepContainer.createDiv('wizard-progress');
        progressDiv.createEl('small', { text: `Step ${this.currentStep + 1} of ${this.steps.length}` });
        const progressBar = progressDiv.createEl('progress');
        progressBar.setAttribute('value', (this.currentStep + 1).toString());
        progressBar.setAttribute('max', this.steps.length.toString());
        progressBar.style.width = '100%';

        this.steps[this.currentStep](stepContainer);

        // Navigation buttons
        const buttonContainer = stepContainer.createDiv('wizard-buttons');
        buttonContainer.style.marginTop = '20px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';

        if (this.currentStep > 0) {
            new Setting(buttonContainer)
                .addButton(btn => btn
                    .setButtonText('Previous')
                    .onClick(() => {
                        this.currentStep--;
                        this.renderStep();
                    }));
        } else {
            buttonContainer.createDiv(); // Spacer
        }

        if (this.currentStep < this.steps.length - 1) {
            new Setting(buttonContainer)
                .addButton(btn => btn
                    .setButtonText('Next')
                    .setCta()
                    .onClick(() => {
                        if (this.validateStep()) {
                            this.currentStep++;
                            this.renderStep();
                        }
                    }));
        } else {
            new Setting(buttonContainer)
                .addButton(btn => btn
                    .setButtonText('Finish')
                    .setCta()
                    .onClick(() => {
                        this.close();
                    }));
        }
    }

    validateStep(): boolean {
        // Add specific validation logic per step if needed
        if (this.currentStep === 3) { // Credentials step
            if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
                new Notice('Please enter Client ID and Client Secret.');
                return false;
            }
        }
        return true;
    }

    renderWelcome(container: HTMLElement) {
        container.createEl('h2', { text: 'Welcome to Gemini Sync Setup Wizard' });
        container.createEl('p', { text: 'This wizard will guide you step-by-step to configure synchronization with Google Drive.' });
        container.createEl('p', { text: 'You will need a Google account and about 5-10 minutes.' });
    }

    renderProjectCreation(container: HTMLElement) {
        container.createEl('h2', { text: '1. Google Cloud Project Creation' });
        container.createEl('p', { text: 'To start, we need to create a project on Google Cloud Platform.' });

        const list = container.createEl('ol');
        list.createEl('li').createEl('a', { text: 'Open Google Cloud Console', href: 'https://console.cloud.google.com/' });
        list.createEl('li', { text: 'Create a new project (e.g., "Obsidian Gemini Sync").' });
        list.createEl('li', { text: 'Go to "APIs & Services" > "Library".' });
        list.createEl('li', { text: 'Enable "Google Drive API".' });
        list.createEl('li', { text: 'Enable "Google Docs API".' });
    }

    renderOAuthConsent(container: HTMLElement) {
        container.createEl('h2', { text: '2. OAuth Consent Screen' });
        container.createEl('p', { text: 'Configure the screen that will appear during login.' });

        const list = container.createEl('ol');
        list.createEl('li', { text: 'Go to "APIs & Services" > "OAuth consent screen".' });
        list.createEl('li', { text: 'Choose "External" and create.' });
        list.createEl('li', { text: 'Fill in the app name and contact emails.' });
        list.createEl('li', { text: 'Add your Google email in the "Test users" section. This is very important!' });
    }

    renderCredentials(container: HTMLElement) {
        container.createEl('h2', { text: '3. Credentials Creation' });
        container.createEl('p', { text: 'Create keys so the plugin can connect.' });

        const list = container.createEl('ol');
        list.createEl('li', { text: 'Go to "APIs & Services" > "Credentials".' });
        list.createEl('li', { text: 'Create an "OAuth client ID" of type "Desktop app".' });
        list.createEl('li', { text: 'Copy the credentials below:' });

        new Setting(container)
            .setName('Client ID')
            .addText(text => text
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(container)
            .setName('Client Secret')
            .addText(text => text
                .setValue(this.plugin.settings.clientSecret)
                .onChange(async (value) => {
                    this.plugin.settings.clientSecret = value;
                    await this.plugin.saveSettings();
                }));
    }

    renderAuthentication(container: HTMLElement) {
        container.createEl('h2', { text: '4. Authentication' });
        container.createEl('p', { text: 'Let\'s connect the plugin to your Google account.' });

        new Setting(container)
            .setName('Generate Login Link')
            .addButton(btn => btn
                .setButtonText('Generate URL')
                .onClick(() => {
                    if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
                        new Notice('Client ID/Secret missing!');
                        return;
                    }
                    // Initialize client to ensure it has latest settings
                    this.plugin.initializeDriveClient();
                    const url = this.plugin.driveClient.generateAuthUrl();
                    window.open(url);
                }));

        new Setting(container)
            .setName('Authorization Code (or URL)')
            .setDesc('Paste the code or the full http://127.0.0.1 URL obtained after login. (It is normal if the page says "Site can\'t be reached")')
            .addText(text => text
                .setPlaceholder('Paste code or URL here')
                .onChange(async (value) => {
                    let codeToUse = value.trim();
                    if (codeToUse.startsWith('http')) {
                        try {
                            const url = new URL(codeToUse);
                            const extracted = url.searchParams.get('code');
                            if (extracted) {
                                codeToUse = extracted;
                            }
                        } catch (e) { }
                    }
                    if (!codeToUse) return;

                    try {
                        await this.plugin.driveClient.authorize(codeToUse);
                        new Notice('Authentication successful!');
                        // Refresh UI or show success indicator
                        const successMsg = container.createEl('p', { text: '✅ Connected successfully!', cls: 'gemini-sync-success' });
                        successMsg.style.color = 'green';
                    } catch (e) {
                        new Notice('Authentication error: ' + e.message);
                    }
                }));
    }

    renderRemoteFolder(container: HTMLElement) {
        container.createEl('h2', { text: '5. Destination Folder' });
        container.createEl('p', { text: 'Where do you want to store your vault on Google Drive?' });
        container.createEl('p', { text: 'By default, the vault will be synchronized to the root of your Drive. You can specify a subfolder (e.g., "Backups/MyVault").' });

        new Setting(container)
            .setName('Remote Folder Path')
            .setDesc('Leave empty for root')
            .addText(text => text
                .setPlaceholder('e.g. Obsidian/MyVault')
                .setValue(this.plugin.settings.remoteFolderPath || '')
                .onChange(async (value) => {
                    this.plugin.settings.remoteFolderPath = value;
                    await this.plugin.saveSettings();
                }));
    }

    renderCompletion(container: HTMLElement) {
        container.createEl('h2', { text: 'Configuration Complete! 🎉' });
        container.createEl('p', { text: 'Everything is ready. You can now close this wizard and start your first synchronization.' });

        if (this.plugin.settings.remoteFolderPath) {
            container.createEl('p', { text: `Destination folder: ${this.plugin.settings.remoteFolderPath}` });
        }
    }
}
