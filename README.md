# Gemini Sync — Synchronisation Obsidian vers Google Drive

Plugin Obsidian qui synchronise unidirectionnellement votre coffre local vers Google Drive, en convertissant automatiquement les fichiers Markdown en documents Google Docs pour compatibilité avec Gemini.

## Description

Ce plugin effectue une synchronisation **unidirectionnelle** (Obsidian → Google Drive uniquement) pour que votre Drive reflète l'état exact de votre coffre Obsidian local. Les fichiers Markdown sont automatiquement convertis en documents Google Docs, permettant leur utilisation avec Gemini.

## Fonctionnalités

- **Synchronisation unidirectionnelle** : Tous les fichiers du coffre Obsidian sont synchronisés vers Google Drive
- **Conversion automatique** : Les fichiers `.md` sont convertis en documents Google Docs
- **Détection des modifications** : Seuls les fichiers nouveaux ou modifiés sont synchronisés
- **Gestion des dossiers** : La structure de dossiers est préservée sur Google Drive
- **Authentification OAuth 2.0** : Sécurisée via Google Cloud

## Architecture du dépôt

```
root/
├─ src/                    # Code source du plugin (TypeScript)
│  ├─ main.ts             # Point d'entrée du plugin
│  ├─ sync/               # Logique de synchronisation
│  ├─ drive/              # Intégration Google Drive API
│  └─ convert/            # Conversion Markdown → Google Docs
├─ manifest.json          # Métadonnées du plugin Obsidian
├─ package.json           # Dépendances et scripts npm
├─ tsconfig.json          # Configuration TypeScript
└─ README.md              # Documentation principale
```

## Prérequis & Installation

### Prérequis

- **Obsidian** installé (version 0.15.0 ou supérieure)
- **Node.js** et **npm** pour le développement
- **Compte Google** avec accès à Google Drive
- **Projet Google Cloud** avec API Google Drive activée (voir section Configuration)

### Installation

1. **Cloner le dépôt** :

```bash
git clone <repository-url>
cd gemini-sync
```

2. **Installer les dépendances** :

```bash
npm install
```

*Installe toutes les dépendances listées dans `package.json` (Google APIs, Obsidian API, etc.)*

3. **Compiler le plugin** :

```bash
npm run build
```

*Compile le TypeScript en JavaScript pour Obsidian*

4. **Activer le plugin dans Obsidian** :

- Ouvrir Obsidian
- Aller dans Paramètres → Plugins communautaires
- Activer "Gemini Sync"

## Configuration

### Guide de Configuration Détaillé

Pour utiliser ce plugin, vous devez configurer un projet Google Cloud et créer des identifiants OAuth. Suivez ce guide étape par étape :

#### Étape 1 : Créer un projet Google Cloud

1. Allez sur la [Google Cloud Console](https://console.cloud.google.com/).
2. Cliquez sur le sélecteur de projet en haut à gauche (à côté du logo Google Cloud).
3. Cliquez sur **"New Project"** (Nouveau projet).
4. Donnez un nom à votre projet (ex: `Obsidian Gemini Sync`) et cliquez sur **"Create"**.
5. Attendez que le projet soit créé et sélectionnez-le.

#### Étape 2 : Activer les APIs nécessaires

1. Dans le menu de gauche, allez dans **"APIs & Services"** > **"Library"**.
2. Recherchez **"Google Drive API"**.
3. Cliquez dessus puis sur **"Enable"**.
4. Revenez à la bibliothèque ("Library").
5. Recherchez **"Google Docs API"**.
6. Cliquez dessus puis sur **"Enable"**.

#### Étape 3 : Configurer l'écran de consentement OAuth

1. Dans le menu de gauche, allez dans **"APIs & Services"** > **"OAuth consent screen"**.
2. Choisissez **"External"** (Externe) et cliquez sur **"Create"**.
3. Remplissez les informations obligatoires :
   - **App name** : `Gemini Sync` (ou autre)
   - **User support email** : Votre email
   - **Developer contact information** : Votre email
4. Cliquez sur **"Save and Continue"**.
5. **Scopes** : Vous pouvez passer cette étape ou ajouter manuellement :
   - `.../auth/drive.file`
   - `.../auth/documents`
   mais ce n'est pas strictement obligatoire ici car le plugin demandera les permissions lors de l'authentification.
6. **Test users** : Ajoutez votre adresse email Google (celle que vous utiliserez pour vous connecter). **C'est important car l'app est en mode "Testing".**
7. Cliquez sur **"Save and Continue"** jusqu'à la fin.

#### Étape 4 : Créer des identifiants (Credentials)

1. Allez dans **"APIs & Services"** > **"Credentials"**.
2. Cliquez sur **"+ CREATE CREDENTIALS"** > **"OAuth client ID"**.
3. **Application type** : Sélectionnez **"Desktop app"**.
4. **Name** : `Obsidian Plugin` (ou autre).
5. Cliquez sur **"Create"**.
6. Une fenêtre s'ouvre avec votre **Client ID** et **Client Secret**. Gardez-les sous la main (ou téléchargez le JSON).

#### Étape 5 : Configuration dans Obsidian

1. Ouvrez les paramètres du plugin **Gemini Sync** dans Obsidian.
2. Cliquez sur le bouton **"Lancer l'assistant de configuration"** pour un guide interactif, ou remplissez manuellement :
   - Copiez le **Client ID** et le **Client Secret** dans les champs correspondants.
   - Cliquez sur **"Generate URL"**.
   - Connectez-vous avec votre compte Google (celui ajouté dans les "Test users").
   - Acceptez les permissions (vous aurez probablement un écran "Google hasn't verified this app", cliquez sur "Continue" ou "Advanced" > "Go to ... (unsafe)").
   - Copiez le code d'autorisation fourni par Google.
   - Collez-le dans le champ **"Auth Code"** du plugin et validez.
3. (Optionnel) Configurez le **Dossier distant** si vous souhaitez que vos fichiers soient dans un sous-dossier spécifique de votre Drive.

## Fichiers importants

- `[src/main.ts](mdc:src/main.ts)` : Point d'entrée du plugin Obsidian
  - *Rôle* : Initialise le plugin, charge la configuration, gère les commandes
  - *Points d'attention* : Gestion du cycle de vie du plugin, hooks Obsidian
  - *Exemple* : `onload()` — *méthode appelée au chargement du plugin*

- `[src/sync/syncManager.ts](mdc:src/sync/syncManager.ts)` : Gestionnaire de synchronisation
  - *Rôle* : Orchestre la synchronisation, détecte les fichiers modifiés, gère la file d'attente
  - *Noeud central* : Coordonne Drive API et conversion
  - *Exemple* : `syncVault()` — *lance la synchronisation complète du coffre*

- `[src/drive/driveClient.ts](mdc:src/drive/driveClient.ts)` : Client Google Drive API
  - *Rôle* : Wrapper autour de l'API Google Drive, gestion de l'authentification OAuth
  - *Points d'attention* : Gestion des tokens, refresh automatique, gestion d'erreurs
  - *Exemple* : `uploadFile()` — *upload un fichier vers Google Drive*

- `[src/convert/markdownToDocs.ts](mdc:src/convert/markdownToDocs.ts)` : Conversion Markdown → Google Docs
  - *Rôle* : Convertit le contenu Markdown en format Google Docs API (insertText, formatage, etc.)
  - *Points d'attention* : Préservation de la structure (titres, listes, liens), gestion des images
  - *Exemple* : `convertToGoogleDocs()` — *convertit un fichier Markdown en requête API Google Docs*

- `[manifest.json](mdc:manifest.json)` : Métadonnées du plugin
  - *Rôle* : Définit la version, l'ID, les dépendances Obsidian minimales
  - *Points d'attention* : Mise à jour de la version à chaque release

- `[package.json](mdc:package.json)` : Dépendances et scripts
  - *Rôle* : Liste les dépendances npm (googleapis, obsidian, etc.) et les scripts de build
  - *Points d'attention* : Mises à jour des dépendances, scripts de développement

## Commandes principales

- **Installer les dépendances** :

```bash
npm install
```

*Installe toutes les dépendances listées dans `package.json`*

- **Compiler en mode développement** :

```bash
npm run build
```

*Compile le TypeScript avec watch mode pour recompiler automatiquement lors des modifications*

- **Compiler pour production** :

```bash
npm run build:prod
```

*Compile avec optimisations pour la distribution*

- **Lancer les tests** :

```bash
npm test
```

*Exécute les tests unitaires et d'intégration*

- **Linter le code** :

```bash
npm run lint
```

*Vérifie la qualité du code avec ESLint*

## Services & Bases de données

### Google Drive API

- **Service** : Google Drive (via Google Cloud)
- **Port** : HTTPS (443)
- **Endpoint** : `https://www.googleapis.com/drive/v3`
- **Authentification** : OAuth 2.0 avec refresh token
- **Local** : Pas de service local nécessaire, tout passe par l'API Google

### Google Docs API

- **Service** : Google Docs (via Google Cloud)
- **Port** : HTTPS (443)
- **Endpoint** : `https://docs.googleapis.com/v1`
- **Utilisation** : Conversion Markdown → Google Docs via API batch requests

## Variables d'environnement

Le plugin utilise la configuration Obsidian (pas de variables d'environnement système). Les credentials OAuth sont stockés dans les paramètres du plugin (chiffrés localement par Obsidian).

## Guide de déploiement / Exécution

### Développement local

1. Cloner le dépôt et installer les dépendances
2. Configurer les credentials Google Cloud (voir section Configuration)
3. Compiler avec `npm run build`
4. Créer un lien symbolique vers le dossier `.obsidian/plugins/gemini-sync` de votre coffre de test
5. Recharger Obsidian pour charger le plugin

### Distribution

1. Compiler avec `npm run build:prod`
2. Créer une release avec les fichiers compilés (`main.js`, `manifest.json`, `styles.css`)
3. Publier sur le dépôt GitHub ou la communauté Obsidian

## Comment ça fonctionne techniquement

### Approche proposée

**1. Authentification OAuth 2.0**

Le plugin utilise le flux OAuth 2.0 "Authorization Code" avec PKCE pour sécuriser l'authentification. Lors de la première utilisation, l'utilisateur est redirigé vers Google pour autoriser l'accès, puis le plugin stocke le refresh token de manière sécurisée dans les paramètres Obsidian.

**2. Synchronisation unidirectionnelle**

Le plugin maintient un index local des fichiers synchronisés (hash MD5 + timestamp) pour détecter les modifications. À chaque synchronisation :

- Parcourt récursivement le coffre Obsidian
- Compare chaque fichier avec l'index local
- Pour les fichiers nouveaux/modifiés :
  - Si `.md` : Convertit en Google Docs et upload
  - Sinon : Upload direct vers Drive
- Met à jour l'index local

**3. Conversion Markdown → Google Docs**

La conversion utilise l'API Google Docs directement (pas de Pandoc) :

- Parse le Markdown (bibliothèque comme `marked` ou `remark`)
- Génère des requêtes batch pour l'API Google Docs :
  - `insertText` pour le contenu
  - `updateParagraphStyle` pour les titres
  - `createParagraphBullets` pour les listes
  - `updateTextStyle` pour le formatage (gras, italique)
- Crée le document via `documents.create()` puis applique les modifications via `documents.batchUpdate()`

**4. Gestion de la structure**

Le plugin maintient une correspondance entre les chemins locaux et les IDs de fichiers Google Drive pour :
- Préserver la hiérarchie de dossiers
- Éviter les doublons
- Permettre les mises à jour incrémentielles

### Avantages de cette approche

- **Pas de dépendance externe** : Tout passe par les APIs Google, pas besoin de Pandoc
- **Conversion native** : Les documents créés sont de vrais Google Docs, pas des imports
- **Performance** : Synchronisation incrémentielle, seulement les fichiers modifiés
- **Fiabilité** : Gestion d'erreurs et retry automatique pour les échecs réseau

### Limitations connues

- **Images** : Les images référencées dans Markdown doivent être uploadées séparément et liées dans le Google Doc
- **Liens internes** : Les liens `[[wiki]]` Obsidian ne sont pas convertis automatiquement (peuvent être convertis en liens texte)
- **Plugins Obsidian** : Le contenu généré par d'autres plugins (ex: Dataview) n'est pas interprété

## Changelog

### Version 0.1.0 (à venir)

- Synchronisation unidirectionnelle de base
- Conversion Markdown → Google Docs
- Authentification OAuth 2.0
- Gestion des dossiers

