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
        progressDiv.createEl('small', { text: `Étape ${this.currentStep + 1} sur ${this.steps.length}` });
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
                    .setButtonText('Précédent')
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
                    .setButtonText('Suivant')
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
                    .setButtonText('Terminer')
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
                new Notice('Veuillez entrer le Client ID et le Client Secret.');
                return false;
            }
        }
        return true;
    }

    renderWelcome(container: HTMLElement) {
        container.createEl('h2', { text: 'Bienvenue dans l\'assistant de configuration Gemini Sync' });
        container.createEl('p', { text: 'Cet assistant va vous guider étape par étape pour configurer la synchronisation avec Google Drive.' });
        container.createEl('p', { text: 'Vous aurez besoin d\'un compte Google et d\'environ 5-10 minutes.' });
    }

    renderProjectCreation(container: HTMLElement) {
        container.createEl('h2', { text: '1. Création du projet Google Cloud' });
        container.createEl('p', { text: 'Pour commencer, nous devons créer un projet sur Google Cloud Platform.' });

        const list = container.createEl('ol');
        list.createEl('li').createEl('a', { text: 'Ouvrez la Google Cloud Console', href: 'https://console.cloud.google.com/' });
        list.createEl('li', { text: 'Créez un nouveau projet (ex: "Obsidian Gemini Sync").' });
        list.createEl('li', { text: 'Allez dans "APIs & Services" > "Library".' });
        list.createEl('li', { text: 'Activez "Google Drive API".' });
        list.createEl('li', { text: 'Activez "Google Docs API".' });
    }

    renderOAuthConsent(container: HTMLElement) {
        container.createEl('h2', { text: '2. Écran de consentement OAuth' });
        container.createEl('p', { text: 'Configurez l\'écran qui s\'affichera lors de la connexion.' });

        const list = container.createEl('ol');
        list.createEl('li', { text: 'Allez dans "APIs & Services" > "OAuth consent screen".' });
        list.createEl('li', { text: 'Choisissez "External" et créez.' });
        list.createEl('li', { text: 'Remplissez le nom de l\'app et les emails de contact.' });
        list.createEl('li', { text: 'Ajoutez votre email Google dans la section "Test users". C\'est très important !' });
    }

    renderCredentials(container: HTMLElement) {
        container.createEl('h2', { text: '3. Création des identifiants' });
        container.createEl('p', { text: 'Créez les clés pour que le plugin puisse se connecter.' });

        const list = container.createEl('ol');
        list.createEl('li', { text: 'Allez dans "APIs & Services" > "Credentials".' });
        list.createEl('li', { text: 'Créez un "OAuth client ID" de type "Desktop app".' });
        list.createEl('li', { text: 'Copiez les identifiants ci-dessous :' });

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
        container.createEl('h2', { text: '4. Authentification' });
        container.createEl('p', { text: 'Connectons maintenant le plugin à votre compte Google.' });

        new Setting(container)
            .setName('Générer le lien de connexion')
            .addButton(btn => btn
                .setButtonText('Générer URL')
                .onClick(() => {
                    if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
                        new Notice('Client ID/Secret manquants !');
                        return;
                    }
                    // Initialize client to ensure it has latest settings
                    this.plugin.initializeDriveClient();
                    const url = this.plugin.driveClient.generateAuthUrl();
                    window.open(url);
                }));

        new Setting(container)
            .setName('Code d\'autorisation')
            .setDesc('Collez le code obtenu après connexion')
            .addText(text => text
                .setPlaceholder('Collez le code ici')
                .onChange(async (value) => {
                    try {
                        await this.plugin.driveClient.authorize(value);
                        new Notice('Authentification réussie !');
                        // Refresh UI or show success indicator
                        const successMsg = container.createEl('p', { text: '✅ Connecté avec succès !', cls: 'gemini-sync-success' });
                        successMsg.style.color = 'green';
                    } catch (e) {
                        new Notice('Erreur d\'authentification : ' + e.message);
                    }
                }));
    }

    renderRemoteFolder(container: HTMLElement) {
        container.createEl('h2', { text: '5. Dossier de destination' });
        container.createEl('p', { text: 'Où voulez-vous stocker votre coffre sur Google Drive ?' });
        container.createEl('p', { text: 'Par défaut, le coffre sera synchronisé à la racine de votre Drive. Vous pouvez spécifier un sous-dossier (ex: "Backups/MonCoffre").' });

        new Setting(container)
            .setName('Chemin du dossier distant')
            .setDesc('Laisser vide pour la racine')
            .addText(text => text
                .setPlaceholder('Ex: Obsidian/MonCoffre')
                .setValue(this.plugin.settings.remoteFolderPath || '')
                .onChange(async (value) => {
                    this.plugin.settings.remoteFolderPath = value;
                    await this.plugin.saveSettings();
                }));
    }

    renderCompletion(container: HTMLElement) {
        container.createEl('h2', { text: 'Configuration terminée ! 🎉' });
        container.createEl('p', { text: 'Tout est prêt. Vous pouvez maintenant fermer cet assistant et lancer votre première synchronisation.' });

        if (this.plugin.settings.remoteFolderPath) {
            container.createEl('p', { text: `Dossier de destination : ${this.plugin.settings.remoteFolderPath}` });
        }
    }
}
