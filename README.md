# Gemini Sync — Obsidian to Google Drive Synchronization

Obsidian plugin that unidirectionally synchronizes your local vault to Google Drive, automatically converting Markdown files to Google Docs for Gemini compatibility.

## Description

This plugin performs **unidirectional** synchronization (Obsidian → Google Drive only) so that your Drive reflects the exact state of your local Obsidian vault. Markdown files are automatically converted to Google Docs, enabling their use with Gemini.

## Features

- **Unidirectional synchronization** : All files in the Obsidian vault are synchronized to Google Drive
- **Startup synchronization** : Configurable option to launch synchronization when Obsidian opens
- **Restart resilience** : Synchronization state is saved locally to avoid unnecessary re-uploads after restart
- **Force Resync** : Emergency button to completely reset synchronization and clean the remote folder
- **Automatic conversion** : `.md` files are converted to Google Docs
- **Binary support** : Reliable synchronization of PDFs and images (PDF, PNG, JPG, GIF)
- **Change detection** : Only new or modified files are synchronized
- **Cancellation** : Ability to cancel an ongoing synchronization via the status bar
- **Folder management** : Folder structure is preserved on Google Drive
- **OAuth 2.0 authentication** : Secured via Google Cloud

## Repository Architecture

```
root/
├─ src/                    # Plugin source code (TypeScript)
│  ├─ main.ts             # Plugin entry point
│  ├─ sync/               # Synchronization logic
│  ├─ drive/              # Google Drive API integration
│  └─ convert/            # Markdown → Google Docs conversion
├─ manifest.json          # Obsidian plugin metadata
├─ package.json           # npm dependencies and scripts
├─ tsconfig.json          # TypeScript configuration
└─ README.md              # Main documentation
```

## Prerequisites & Installation

### Prerequisites

- **Obsidian** installed (version 0.15.0 or higher)
- **Node.js** and **npm** for development
- **Google account** with Google Drive access
- **Google Cloud project** with Google Drive API enabled (see Configuration section)

### Installation

1. **Clone the repository** :

```bash
git clone <repository-url>
cd gemini-sync
```

2. **Install dependencies** :

```bash
npm install
```

*Installs all dependencies listed in `package.json` (Google APIs, Obsidian API, etc.)*

3. **Build the plugin** :

```bash
npm run build
```

*Compiles TypeScript to JavaScript for Obsidian*

4. **Enable the plugin in Obsidian** :

- Open Obsidian
- Go to Settings → Community plugins
- Enable "Gemini Sync"

## Configuration

### Detailed Configuration Guide

To use this plugin, you need to configure a Google Cloud project and create OAuth credentials. Follow this step-by-step guide:

#### Step 1: Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click on the project selector at the top left (next to the Google Cloud logo).
3. Click **"New Project"**.
4. Give your project a name (e.g., `Obsidian Gemini Sync`) and click **"Create"**.
5. Wait for the project to be created and select it.

#### Step 2: Enable Required APIs

1. In the left menu, go to **"APIs & Services"** > **"Library"**.
2. Search for **"Google Drive API"**.
3. Click on it and then click **"Enable"**.
4. Return to the library ("Library").
5. Search for **"Google Docs API"**.
6. Click on it and then click **"Enable"**.

#### Step 3: Configure OAuth Consent Screen

1. In the left menu, go to **"APIs & Services"** > **"OAuth consent screen"**.
2. Choose **"External"** and click **"Create"**.
3. Fill in the required information:
   - **App name** : `Gemini Sync` (or other)
   - **User support email** : Your email
   - **Developer contact information** : Your email
4. Click **"Save and Continue"**.
5. **Scopes** : You can skip this step or add manually:
   - `.../auth/drive.file`
   - `.../auth/documents`
   but this is not strictly required here as the plugin will request permissions during authentication.
6. **Test users** : Add your Google email address (the one you will use to log in). **This is important because the app is in "Testing" mode.**
7. Click **"Save and Continue"** until the end.

#### Step 4: Create Credentials

1. Go to **"APIs & Services"** > **"Credentials"**.
2. Click **"+ CREATE CREDENTIALS"** > **"OAuth client ID"**.
3. **Application type** : Select **"Desktop app"**.
4. **Name** : `Obsidian Plugin` (or other).
5. Click **"Create"**.
6. A window opens with your **Client ID** and **Client Secret**. Keep them handy (or download the JSON).

#### Step 5: Configuration in Obsidian

1. Open the **Gemini Sync** plugin settings in Obsidian.
2. Click the **"Start Wizard"** button for an interactive guide, or fill in manually:
   - Copy the **Client ID** and **Client Secret** into the corresponding fields.
   - Click **"Generate URL"**.
   - Log in with your Google account (the one added in "Test users").
   - Accept the permissions (you will probably see a "Google hasn't verified this app" screen, click "Continue" or "Advanced" > "Go to ... (unsafe)").
   - Copy the authorization code provided by Google.
   - Paste it in the **"Auth Code"** field of the plugin and validate.
3. (Optional) Configure the **Remote Folder** if you want your files to be in a specific subfolder of your Drive.

## Important Files

- `[src/main.ts](mdc:src/main.ts)` : Obsidian plugin entry point
  - *Role* : Initializes the plugin, loads configuration, manages commands
  - *Points of attention* : Plugin lifecycle management, Obsidian hooks
  - *Example* : `onload()` — *method called when the plugin loads*

- `[src/sync/syncManager.ts](mdc:src/sync/syncManager.ts)` : Synchronization manager
  - *Role* : Orchestrates synchronization, detects modified files, manages queue
  - *Central node* : Coordinates Drive API and conversion
  - *Example* : `syncVault()` — *launches complete vault synchronization*

- `[src/drive/driveClient.ts](mdc:src/drive/driveClient.ts)` : Google Drive API client
  - *Role* : Wrapper around Google Drive API, OAuth authentication management
  - *Points of attention* : Token management, automatic refresh, error handling
  - *Example* : `uploadFile()` — *uploads a file to Google Drive*

- `[src/convert/markdownToDocs.ts](mdc:src/convert/markdownToDocs.ts)` : Markdown → Google Docs conversion
  - *Role* : Converts Markdown content to Google Docs API format (insertText, formatting, etc.)
  - *Points of attention* : Structure preservation (headings, lists, links), image handling
  - *Example* : `convertToGoogleDocs()` — *converts a Markdown file to Google Docs API request*

- `[manifest.json](mdc:manifest.json)` : Plugin metadata
  - *Role* : Defines version, ID, minimum Obsidian dependencies
  - *Points of attention* : Version update on each release

- `data.json` : Local configuration and state
  - *Role* : Stores OAuth tokens (sensitive) and synchronization index.
  - *Points of attention* : **NEVER COMMIT THIS FILE**. It is added to `.gitignore`.

- `[package.json](mdc:package.json)` : Dependencies and scripts
  - *Role* : Lists npm dependencies (googleapis, obsidian, etc.) and build scripts
  - *Points of attention* : Dependency updates, development scripts

## Main Commands

- **Install dependencies** :

```bash
npm install
```

*Installs all dependencies listed in `package.json`*

- **Build in development mode** :

```bash
npm run build
```

*Compiles TypeScript with watch mode to automatically recompile on changes*

- **Build for production** :

```bash
npm run build:prod
```

*Compiles with optimizations for distribution*

- **Run tests** :

```bash
npm test
```

*Executes unit and integration tests*

- **Lint code** :

```bash
npm run lint
```

*Checks code quality with ESLint*

## Services & Databases

### Google Drive API

- **Service** : Google Drive (via Google Cloud)
- **Port** : HTTPS (443)
- **Endpoint** : `https://www.googleapis.com/drive/v3`
- **Authentication** : OAuth 2.0 with refresh token
- **Local** : No local service required, everything goes through Google API

### Google Docs API

- **Service** : Google Docs (via Google Cloud)
- **Port** : HTTPS (443)
- **Endpoint** : `https://docs.googleapis.com/v1`
- **Usage** : Markdown → Google Docs conversion via API batch requests

## Environment Variables

The plugin uses Obsidian configuration (no system environment variables). OAuth credentials are stored in plugin settings (locally encrypted by Obsidian).

## Deployment / Execution Guide

### Local Development

1. Clone the repository and install dependencies
2. Configure Google Cloud credentials (see Configuration section)
3. Build with `npm run build`
4. Create a symbolic link to the `.obsidian/plugins/gemini-sync` folder of your test vault
5. Reload Obsidian to load the plugin

### Distribution

1. Build with `npm run build:prod`
2. Create a release with compiled files (`main.js`, `manifest.json`, `styles.css`)
3. Publish to GitHub repository or Obsidian community

## How It Works Technically

### Proposed Approach

**1. OAuth 2.0 Authentication**

The plugin uses the OAuth 2.0 "Authorization Code" flow with PKCE to secure authentication. On first use, the user is redirected to Google to authorize access, then the plugin stores the refresh token securely in Obsidian settings.

**2. Unidirectional Synchronization**

The plugin maintains a local index of synchronized files (MD5 hash + timestamp + Drive ID) saved in `data.json` to persist state between restarts. On each synchronization:

- Recursively traverses the Obsidian vault
- Compares each file with the local index
- If the file is not in the local index, checks its existence on Drive by name to avoid duplicates (state recovery)
- For new/modified files:
  - If `.md` : Converts to Google Docs and uploads
  - Otherwise : Direct upload to Drive
- Updates the local index

**3. Markdown → Google Docs Conversion**

The conversion uses the Google Docs API directly (no Pandoc):

- Parses Markdown (library like `marked` or `remark`)
- Generates batch requests for the Google Docs API:
  - `insertText` for content
  - `updateParagraphStyle` for headings
  - `createParagraphBullets` for lists
  - `updateTextStyle` for formatting (bold, italic)
- Creates the document via `documents.create()` then applies modifications via `documents.batchUpdate()`

**4. Structure Management**

The plugin maintains a mapping between local paths and Google Drive file IDs to:
- Preserve folder hierarchy
- Avoid duplicates
- Enable incremental updates

### Advantages of This Approach

- **No external dependency** : Everything goes through Google APIs, no need for Pandoc
- **Native conversion** : Created documents are real Google Docs, not imports
- **Performance** : Incremental synchronization, only modified files
- **Reliability** : Error handling and automatic retry for network failures

### Known Limitations

- **Images** : Images referenced in Markdown must be uploaded separately and linked in the Google Doc
- **Internal links** : Obsidian `[[wiki]]` links are not automatically converted (can be converted to text links)
- **Obsidian plugins** : Content generated by other plugins (e.g., Dataview) is not interpreted

## Changelog

### Version 0.1.0 (upcoming)

- Basic unidirectional synchronization
- Markdown → Google Docs conversion
- OAuth 2.0 authentication
- Folder management

