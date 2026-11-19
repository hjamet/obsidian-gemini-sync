import { App, TFile } from 'obsidian';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Notifier } from '../notifications/notifier';
import { DriveClient, DriveHttpError } from '../drive/driveClient';
import { GeminiSyncSettings } from '../main';
import { ManifestManager, RemoteManifest } from './remoteManifest';
import { pLimit } from './concurrency';
import { TasksClient } from '../drive/tasksClient';
import { ProjectManager } from './projectManager';
import { CanvasConverter } from '../convert/canvasConverter';
import { LocalSyncCache } from './localCache';

const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

const HARD_EXCLUDED_PREFIXES = [
    '.obsidian/',
    '_agents/doc_version_cas/'
];

function appendSyncAuditEvent(payload: Record<string, unknown>): void {
    try {
        const logPath = path.join(os.tmpdir(), 'obsidian-sync-audit.jsonl');
        const line = JSON.stringify({ ts: new Date().toISOString(), plugin: 'gemini-sync', ...payload }) + '\n';
        fs.appendFile(logPath, line, 'utf8', () => {});
    } catch (_) {}
}

export class SyncManager {
    app: App;
    driveClient: DriveClient;
    settings: GeminiSyncSettings;
    statusBarItem: HTMLElement | null = null;
    isSyncing: boolean = false;
    cancelRequested: boolean = false;
    manifestManager: ManifestManager;
    projectManager: ProjectManager;
    canvasConverter: CanvasConverter;
    localCache: LocalSyncCache;
    private rootFolderId: string | null = null;
    private folderIdCache: Map<string, string> = new Map();
    private activeManifest: RemoteManifest | null = null;
    private manifestLoadInFlight: Promise<RemoteManifest> | null = null;
    private manifestDirty: boolean = false;
    private manifestSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private watchTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private pendingWatchPaths: Set<string> = new Set();
    private pendingDeletePaths: Set<string> = new Set();
    private deleteFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private singleFileLimit = pLimit(2);
    onSaveSettings: () => Promise<void>;
    notifier: Notifier;

    constructor(
        app: App,
        driveClient: DriveClient,
        settings: GeminiSyncSettings,
        statusBarItem: HTMLElement | undefined,
        onSaveSettings: () => Promise<void>,
        notifier: Notifier,
        localCache: LocalSyncCache
    ) {
        this.app = app;
        this.driveClient = driveClient;
        this.settings = settings;
        this.statusBarItem = statusBarItem || null;
        this.onSaveSettings = onSaveSettings;
        this.notifier = notifier;
        this.localCache = localCache;
        this.manifestManager = new ManifestManager(driveClient);

        const tasksClient = new TasksClient(driveClient);
        this.projectManager = new ProjectManager(app, tasksClient, settings, notifier);
        this.canvasConverter = new CanvasConverter(app);
    }

    public updateSettings(settings: GeminiSyncSettings) {
        if (this.settings.remoteFolderPath !== settings.remoteFolderPath) {
            this.rootFolderId = null;
            this.folderIdCache.clear();
            this.activeManifest = null;
            this.manifestManager.reset();
        }
        this.settings = settings;
        this.projectManager.updateSettings(settings);
    }

    public updateDriveClient(driveClient: DriveClient) {
        this.driveClient = driveClient;
        this.manifestManager = new ManifestManager(driveClient);
        this.activeManifest = null;
        const tasksClient = new TasksClient(driveClient);
        this.projectManager = new ProjectManager(this.app, tasksClient, this.settings, this.notifier);
    }

    public dispose(): void {
        for (const timer of this.watchTimers.values()) {
            clearTimeout(timer);
        }
        this.watchTimers.clear();
        if (this.manifestSaveTimer) {
            clearTimeout(this.manifestSaveTimer);
            this.manifestSaveTimer = null;
        }
        if (this.deleteFlushTimer) {
            clearTimeout(this.deleteFlushTimer);
            this.deleteFlushTimer = null;
        }
        this.localCache.flushSync();
    }

    public shouldSyncPath(filePath: string, extension?: string): boolean {
        const norm = filePath.replace(/\\/g, '/');
        for (const prefix of HARD_EXCLUDED_PREFIXES) {
            if (norm.startsWith(prefix)) return false;
        }
        const excludedFolders = this.settings.excludedFolders || [];
        if (excludedFolders.some(ex => ex && (norm === ex || norm.startsWith(ex + '/')))) {
            return false;
        }
        const ext = (extension ?? (norm.includes('.') ? norm.split('.').pop() || '' : '')).toLowerCase();
        if (ext === 'md') return true;
        if (ext === 'pdf') return this.settings.syncPDFs;
        if (ext === 'canvas') return this.settings.syncCanvas;
        if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return this.settings.syncImages;
        return false;
    }

    /**
     * Ultra-light per-file watchdog: resets a 60s debounce timer for the modified note
     * and pushes ONLY that single file with one PATCH/POST request.
     */
    public scheduleFileSync(file: TFile): void {
        if (!this.settings.enableWatchdog) return;
        if (!this.driveClient.isReady()) return;
        if (!this.shouldSyncPath(file.path, file.extension)) return;

        const existingTimer = this.watchTimers.get(file.path);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const delayMs = Math.max(5, this.settings.watchDebounceSeconds || 60) * 1000;
        const filePath = file.path;
        const timer = setTimeout(() => {
            this.watchTimers.delete(filePath);
            if (this.isSyncing) {
                this.pendingWatchPaths.add(filePath);
                return;
            }
            void this.singleFileLimit(() => this.pushSingleFileByPath(filePath));
        }, delayMs);

        this.watchTimers.set(filePath, timer);
    }

    /**
     * Handles file renames/moves via lightweight Drive metadata PATCH instead of delete+reupload.
     */
    public async handleFileRename(file: TFile, oldPath: string): Promise<void> {
        if (!this.settings.enableWatchdog || !this.driveClient.isReady()) return;

        // Cancel pending timer on old path
        const oldTimer = this.watchTimers.get(oldPath);
        if (oldTimer) {
            clearTimeout(oldTimer);
            this.watchTimers.delete(oldPath);
        }

        const shouldNowSync = this.shouldSyncPath(file.path, file.extension);
        const cachedOld = this.localCache.get(oldPath);

        if (!shouldNowSync) {
            if (cachedOld) {
                this.scheduleFileDelete(oldPath);
            }
            return;
        }

        if (!cachedOld?.driveId) {
            this.scheduleFileSync(file);
            return;
        }

        try {
            const t0 = Date.now();
            const manifest = await this.ensureActiveManifest();
            const oldParentPath = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
            const newParentPath = file.parent?.path || '';
            const isDocType = file.extension === 'md' || file.extension === 'canvas';
            const newRemoteName = isDocType ? file.basename : file.name;

            let newParentId: string | undefined;
            let oldParentId: string | undefined;
            if (oldParentPath !== newParentPath) {
                newParentId = await this.ensureFolderStructure(newParentPath);
                oldParentId = await this.ensureFolderStructure(oldParentPath);
            }

            await this.driveClient.renameOrMoveFile(cachedOld.driveId, newRemoteName, newParentId, oldParentId);

            // Migrate cache & manifest entries
            const movedEntry = {
                path: file.path,
                driveId: cachedOld.driveId,
                hash: cachedOld.hash,
                lastModified: file.stat.mtime
            };
            this.localCache.delete(oldPath);
            this.localCache.set(movedEntry);
            this.localCache.scheduleFlush();

            delete manifest.files[oldPath];
            manifest.files[file.path] = {
                path: file.path,
                driveId: cachedOld.driveId,
                hash: cachedOld.hash,
                modifiedTime: Date.now()
            };
            this.scheduleManifestSave();
            appendSyncAuditEvent({ event: 'watchdogRename', oldPath, newPath: file.path, durationMs: Date.now() - t0 });
        } catch (err) {
            console.warn(`Gemini Sync: Fast rename failed for ${oldPath} -> ${file.path}, scheduling fallback sync`, err);
            this.localCache.delete(oldPath);
            this.scheduleFileSync(file);
        }
    }

    /**
     * Debounces file deletions before trashing on Drive.
     */
    public scheduleFileDelete(filePath: string): void {
        if (!this.settings.enableWatchdog || !this.driveClient.isReady()) return;

        const pendingTimer = this.watchTimers.get(filePath);
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.watchTimers.delete(filePath);
        }

        if (!this.localCache.get(filePath) && !this.activeManifest?.files[filePath]) {
            return;
        }

        this.pendingDeletePaths.add(filePath);
        if (this.deleteFlushTimer) clearTimeout(this.deleteFlushTimer);
        this.deleteFlushTimer = setTimeout(() => {
            this.deleteFlushTimer = null;
            void this.flushPendingDeletes();
        }, 10000);
    }

    private async flushPendingDeletes(): Promise<void> {
        if (this.isSyncing || this.pendingDeletePaths.size === 0) return;
        const paths = Array.from(this.pendingDeletePaths);
        this.pendingDeletePaths.clear();

        try {
            const rootId = await this.getVaultRoot();
            const manifest = await this.ensureActiveManifest();
            let deletedCount = 0;

            for (const filePath of paths) {
                if (this.app.vault.getAbstractFileByPath(filePath)) continue; // recreated in the meantime
                const driveId = manifest.files[filePath]?.driveId || this.localCache.get(filePath)?.driveId;
                if (driveId) {
                    await this.driveClient.deleteFile(driveId, rootId);
                    deletedCount++;
                }
                delete manifest.files[filePath];
                this.localCache.delete(filePath);
            }

            if (deletedCount > 0) {
                this.localCache.scheduleFlush();
                this.scheduleManifestSave();
                appendSyncAuditEvent({ event: 'watchdogDelete', deletedCount });
            }
        } catch (err) {
            console.error('Gemini Sync: Failed flushing watchdog deletes:', err);
        }
    }

    private async pushSingleFileByPath(filePath: string): Promise<void> {
        const abstract = this.app.vault.getAbstractFileByPath(filePath);
        if (!(abstract instanceof TFile)) return;
        if (!this.shouldSyncPath(abstract.path, abstract.extension)) return;

        const t0 = Date.now();
        try {
            const content = await this.getFileContent(abstract);
            const hash = this.calculateHashFromContent(content);
            const cached = this.localCache.get(abstract.path);

            // Fast no-op exit when file was touched without changing content
            if (cached && cached.hash === hash) {
                if (cached.lastModified !== abstract.stat.mtime) {
                    this.localCache.set({
                        path: abstract.path,
                        driveId: cached.driveId,
                        hash,
                        lastModified: abstract.stat.mtime
                    });
                    this.localCache.scheduleFlush();
                }
                return;
            }

            const mimeType = this.getMimeTypeForFile(abstract);
            let driveId = cached?.driveId || this.activeManifest?.files[abstract.path]?.driveId || null;
            let action: 'patch' | 'create' = 'patch';

            if (driveId) {
                try {
                    await this.driveClient.updateFile(driveId, content, mimeType);
                } catch (err: any) {
                    if (err instanceof DriveHttpError && err.status === 404) {
                        driveId = null; // deleted remotely -> recreate
                    } else {
                        throw err;
                    }
                }
            }

            if (!driveId) {
                action = 'create';
                const parentId = await this.ensureFolderStructure(abstract.parent?.path || '');
                const remoteName = (abstract.extension === 'md' || abstract.extension === 'canvas') ? abstract.basename : abstract.name;
                driveId = await this.driveClient.uploadFile(remoteName, content, mimeType, parentId);
            }

            this.localCache.set({
                path: abstract.path,
                driveId,
                hash,
                lastModified: abstract.stat.mtime
            });
            this.localCache.scheduleFlush();

            const manifest = await this.ensureActiveManifest();
            manifest.files[abstract.path] = {
                path: abstract.path,
                driveId,
                hash,
                modifiedTime: Date.now()
            };
            this.scheduleManifestSave();

            const durationMs = Date.now() - t0;
            this.updateStatus(`Gemini Sync: ↑ ${abstract.basename}`, 4000, false);
            appendSyncAuditEvent({ event: 'watchdogPush', action, path: abstract.path, durationMs });
        } catch (err: any) {
            console.error(`Gemini Sync Watchdog failed for ${filePath}:`, err);
            appendSyncAuditEvent({ event: 'watchdogError', path: filePath, error: String(err?.message || err).slice(0, 180) });
        }
    }

    private async ensureActiveManifest(): Promise<RemoteManifest> {
        if (this.activeManifest) return this.activeManifest;
        if (this.manifestLoadInFlight) return this.manifestLoadInFlight;

        this.manifestLoadInFlight = (async () => {
            const rootId = await this.getVaultRoot();
            const { manifest } = await this.manifestManager.loadManifest(rootId);
            this.activeManifest = manifest || this.manifestManager.createEmptyManifest();
            return this.activeManifest;
        })().finally(() => {
            this.manifestLoadInFlight = null;
        });

        return this.manifestLoadInFlight;
    }

    private scheduleManifestSave(): void {
        this.manifestDirty = true;
        if (this.manifestSaveTimer) clearTimeout(this.manifestSaveTimer);
        this.manifestSaveTimer = setTimeout(async () => {
            this.manifestSaveTimer = null;
            if (!this.manifestDirty || this.isSyncing || !this.activeManifest) return;
            try {
                const rootId = await this.getVaultRoot();
                this.activeManifest.lastSync = Date.now();
                await this.manifestManager.saveManifest(rootId, this.activeManifest);
                this.manifestDirty = false;
            } catch (err) {
                console.error('Gemini Sync: Failed saving debounced manifest:', err);
            }
        }, 15000);
    }

    public cancelSync() {
        if (this.isSyncing) {
            this.cancelRequested = true;
            this.updateStatus('Gemini Sync: Cancelling...', undefined, false);
            this.notifier.notify('Gemini Sync: Cancellation requested...');
        }
    }

    public async forceResync() {
        if (this.isSyncing) {
            this.notifier.notify('Sync in progress, please wait.');
            return;
        }

        this.isSyncing = true;
        try {
            this.updateStatus('Gemini Sync: Deleting remote folder...', undefined, false);
            const rootName = this.settings.remoteFolderPath || this.app.vault.getName();
            const rootId = await this.driveClient.getFileId(rootName, 'root', 'application/vnd.google-apps.folder');

            if (rootId) {
                await this.driveClient.deleteFile(rootId, rootId);
                this.notifier.notify('Remote folder deleted.');
            }

            this.rootFolderId = null;
            this.folderIdCache.clear();
            this.activeManifest = null;
            this.manifestManager.reset();
            this.localCache.clear();
            this.settings.syncIndex = {};
            await this.onSaveSettings();

            this.isSyncing = false;
            await this.syncVault({ silent: false });
        } catch (e) {
            console.error('Force Resync failed:', e);
            this.notifier.notify('Force Resync failed.');
            this.isSyncing = false;
        }
    }

    private updateStatus(message: string, timeout?: number, showCancel: boolean = false) {
        if (this.statusBarItem) {
            this.statusBarItem.empty();
            this.statusBarItem.createEl('span', { text: message });

            if (showCancel) {
                const btn = this.statusBarItem.createEl('span', { cls: 'status-bar-item-segment' });
                btn.style.marginLeft = '10px';
                btn.style.cursor = 'pointer';
                btn.style.color = 'var(--text-error)';
                btn.setText('Cancel');
                btn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.cancelSync();
                };
            }

            if (timeout) {
                setTimeout(() => {
                    if (this.statusBarItem?.getText() === message) {
                        this.statusBarItem.setText('');
                    }
                }, timeout);
            }
        }
    }

    public async syncVault(options: { silent?: boolean } = {}) {
        const silent = Boolean(options.silent);
        if (this.isSyncing) {
            if (!silent) this.notifier.notify('Gemini Sync: Already in progress.');
            return;
        }

        if (!this.driveClient.isReady()) {
            if (!silent) this.notifier.notify('Gemini Sync: Not authenticated.');
            return;
        }

        const startedAt = Date.now();
        this.isSyncing = true;
        this.cancelRequested = false;
        this.folderIdCache.clear();

        let uploadedCount = 0;
        let recoveredCount = 0;
        let deletedCount = 0;
        let deduplicatedManifests = 0;
        let manifestSaved = false;

        try {
            if (!silent) this.notifier.notify('Gemini Sync: Starting strict mirror sync...');
            this.updateStatus('Gemini Sync: Initializing...', undefined, true);

            // 0. Sync Tasks from Google Tasks
            await this.projectManager.syncTasks();

            // Wait for Obsidian Sync to finish if active
            await this.waitForObsidianSync();

            const rootId = await this.getVaultRoot();

            // 1. Load & automatically deduplicate remote manifest
            const loadRes = await this.manifestManager.loadManifest(rootId);
            deduplicatedManifests = loadRes.deduplicatedCount;
            const remoteManifest = loadRes.manifest || this.manifestManager.createEmptyManifest();
            this.activeManifest = remoteManifest;

            let isManifestDirty = !loadRes.manifest;

            // 2. Filter eligible local files
            const localFiles = this.app.vault.getFiles();
            const excludedFolders = this.settings.excludedFolders || [];
            const filesToSync = localFiles.filter(file => this.shouldSyncPath(file.path, file.extension));

            const totalFiles = filesToSync.length;
            let processedCount = 0;
            const keptRemotePaths = new Set<string>();
            const limit = pLimit(2);
            const promises: Promise<void>[] = [];
            const filesToUpload: TFile[] = [];

            // 3. Fast RAM-first diff pass (O(1) mtime lookup against external cache)
            this.updateStatus('Gemini Sync: Checking local changes...', undefined, true);

            let checkCount = 0;
            for (const file of filesToSync) {
                if (this.cancelRequested) break;
                if (++checkCount % 40 === 0) {
                    await yieldToEventLoop();
                }

                const remoteEntry = remoteManifest.files[file.path];
                if (!remoteEntry) {
                    filesToUpload.push(file);
                    continue;
                }

                let localHash: string;
                const cachedEntry = this.localCache.get(file.path);
                if (cachedEntry && cachedEntry.lastModified === file.stat.mtime && cachedEntry.hash) {
                    localHash = cachedEntry.hash;
                } else {
                    localHash = await this.calculateFileHash(file);
                }

                if (remoteEntry.hash === localHash) {
                    this.localCache.set({
                        path: file.path,
                        driveId: remoteEntry.driveId,
                        hash: localHash,
                        lastModified: file.stat.mtime
                    });
                    keptRemotePaths.add(file.path);
                    processedCount++;
                } else {
                    filesToUpload.push(file);
                }
            }

            // Group dirty files by folder
            const filesByFolder = new Map<string, TFile[]>();
            for (const file of filesToUpload) {
                const parentPath = file.parent?.path || '';
                if (!filesByFolder.has(parentPath)) {
                    filesByFolder.set(parentPath, []);
                }
                filesByFolder.get(parentPath)!.push(file);
            }

            let lastSaveTime = Date.now();
            let filesSinceLastSave = 0;

            for (const [folderPath, folderFiles] of filesByFolder) {
                if (this.cancelRequested) break;

                const parentId = await this.ensureFolderStructure(folderPath);
                const needsSmartRecovery = folderFiles.some(f => !remoteManifest.files[f.path]);
                const remoteFolderCache = needsSmartRecovery
                    ? await this.driveClient.listFilesInFolder(parentId)
                    : new Map();

                for (const file of folderFiles) {
                    if (this.cancelRequested) break;

                    promises.push(limit(async () => {
                        if (this.cancelRequested) return;
                        await yieldToEventLoop();

                        try {
                            processedCount++;
                            const percentage = Math.round((processedCount / Math.max(1, totalFiles)) * 100);
                            this.updateStatus(`Gemini Sync: Syncing ${processedCount}/${totalFiles} (${percentage}%)`, undefined, true);

                            let localHash: string;
                            const cachedEntry = this.localCache.get(file.path);
                            if (cachedEntry && cachedEntry.lastModified === file.stat.mtime && cachedEntry.hash) {
                                localHash = cachedEntry.hash;
                            } else {
                                localHash = await this.calculateFileHash(file);
                            }

                            let remoteEntry = remoteManifest.files[file.path];

                            // Smart recovery when file already exists on Drive but wasn't in manifest
                            if (!remoteEntry) {
                                const isDocType = file.extension === 'md' || file.extension === 'canvas';
                                const searchName = isDocType ? file.basename : file.name;
                                const existingFile = remoteFolderCache.get(searchName);

                                if (existingFile) {
                                    let isUpToDate = false;
                                    if (isDocType) {
                                        const remoteModTime = existingFile.modifiedTime ? new Date(existingFile.modifiedTime).getTime() : 0;
                                        if (remoteModTime > file.stat.mtime) isUpToDate = true;
                                    } else {
                                        if (existingFile.md5Checksum === localHash) isUpToDate = true;
                                    }

                                    if (isUpToDate) {
                                        remoteManifest.files[file.path] = {
                                            path: file.path,
                                            driveId: existingFile.id,
                                            hash: localHash,
                                            modifiedTime: Date.now()
                                        };
                                        this.localCache.set({
                                            path: file.path,
                                            driveId: existingFile.id,
                                            hash: localHash,
                                            lastModified: file.stat.mtime
                                        });
                                        remoteEntry = remoteManifest.files[file.path];
                                        recoveredCount++;
                                        isManifestDirty = true;
                                    } else {
                                        remoteManifest.files[file.path] = {
                                            path: file.path,
                                            driveId: existingFile.id,
                                            hash: 'mismatch',
                                            modifiedTime: 0
                                        };
                                        remoteEntry = remoteManifest.files[file.path];
                                    }
                                }
                            }

                            if (!remoteEntry || remoteEntry.hash !== localHash) {
                                await this.uploadFile(file, rootId, remoteManifest);
                                uploadedCount++;
                                isManifestDirty = true;
                            } else {
                                this.localCache.set({
                                    path: file.path,
                                    driveId: remoteEntry.driveId,
                                    hash: localHash,
                                    lastModified: file.stat.mtime
                                });
                            }

                            keptRemotePaths.add(file.path);

                            // Incremental checkpoint save every 50 uploads or 30s
                            filesSinceLastSave++;
                            const now = Date.now();
                            if (isManifestDirty && (filesSinceLastSave >= 50 || (now - lastSaveTime > 30000))) {
                                filesSinceLastSave = 0;
                                lastSaveTime = now;
                                await this.manifestManager.saveManifest(rootId, remoteManifest);
                                this.localCache.flushSync();
                                manifestSaved = true;
                            }
                        } catch (err) {
                            console.error(`Failed to sync ${file.path}:`, err);
                        }
                    }));
                }
            }

            await Promise.all(promises);

            // 4. Clean remote deleted files
            if (!this.cancelRequested) {
                const remotePaths = Object.keys(remoteManifest.files);
                const toDelete: string[] = [];
                for (const remotePath of remotePaths) {
                    if (!keptRemotePaths.has(remotePath)) {
                        const isExcluded = excludedFolders.some(ex => ex && (remotePath === ex || remotePath.startsWith(ex + '/')));
                        if (!isExcluded) {
                            toDelete.push(remotePath);
                        }
                    }
                }

                if (toDelete.length > 0) {
                    this.updateStatus(`Gemini Sync: Cleaning ${toDelete.length} remote file(s)...`, undefined, true);
                    let cleanCount = 0;
                    for (const remotePath of toDelete) {
                        if (++cleanCount % 50 === 0) await yieldToEventLoop();
                        try {
                            const entry = remoteManifest.files[remotePath];
                            await this.driveClient.deleteFile(entry.driveId, rootId);
                            delete remoteManifest.files[remotePath];
                            this.localCache.delete(remotePath);
                            deletedCount++;
                            isManifestDirty = true;
                        } catch (e) {
                            console.error(`Failed to delete remote file ${remotePath}:`, e);
                        }
                    }
                }

                // 5. Only upload manifest if something ACTUALLY changed!
                if (isManifestDirty) {
                    remoteManifest.lastSync = Date.now();
                    await this.manifestManager.saveManifest(rootId, remoteManifest);
                    manifestSaved = true;
                    this.manifestDirty = false;
                }
                this.localCache.flushSync();

                const durMs = Date.now() - startedAt;
                appendSyncAuditEvent({
                    event: 'syncVault',
                    silent,
                    durationMs: durMs,
                    totalFiles,
                    uploadedCount,
                    recoveredCount,
                    deletedCount,
                    deduplicatedManifests,
                    manifestSaved
                });

                if (!silent) {
                    const summary = uploadedCount === 0 && deletedCount === 0
                        ? 'Gemini Sync: Already up to date.'
                        : `Gemini Sync: ${uploadedCount} uploaded, ${deletedCount} cleaned.`;
                    this.notifier.notify(summary);
                }
                this.updateStatus(
                    uploadedCount > 0 || deletedCount > 0
                        ? `Gemini Sync: ✓ ${uploadedCount}↑ ${deletedCount}×`
                        : 'Gemini Sync: ✓',
                    5000
                );
            } else {
                this.notifier.notify('Gemini Sync: Cancelled.');
                this.updateStatus('Gemini Sync: Cancelled', 5000);
                if (isManifestDirty) {
                    await this.manifestManager.saveManifest(rootId, remoteManifest);
                }
                this.localCache.flushSync();
            }
        } catch (globalError: any) {
            console.error('Gemini Sync Fatal Error:', globalError);
            appendSyncAuditEvent({
                event: 'syncVaultError',
                silent,
                durationMs: Date.now() - startedAt,
                error: String(globalError?.message || globalError).slice(0, 200)
            });
            this.notifier.notify('Gemini Sync Failed. See console.');
            this.updateStatus('Gemini Sync: Failed', undefined);
        } finally {
            this.isSyncing = false;
            // Drain any watchdog events that fired while full sync was running
            if (this.pendingWatchPaths.size > 0) {
                const queued = Array.from(this.pendingWatchPaths);
                this.pendingWatchPaths.clear();
                for (const p of queued) {
                    void this.singleFileLimit(() => this.pushSingleFileByPath(p));
                }
            }
            if (this.pendingDeletePaths.size > 0) {
                void this.flushPendingDeletes();
            }
        }
    }

    private getMimeTypeForFile(file: TFile): string {
        if (file.extension === 'md' || file.extension === 'canvas') return 'application/vnd.google-apps.document';
        if (file.extension === 'pdf') return 'application/pdf';
        if (['png', 'jpg', 'jpeg', 'gif'].includes(file.extension)) {
            return `image/${file.extension === 'jpg' ? 'jpeg' : file.extension}`;
        }
        return 'application/octet-stream';
    }

    private calculateHashFromContent(content: string | ArrayBuffer | Buffer): string {
        const hash = crypto.createHash('md5');
        if (typeof content === 'string') {
            hash.update(content, 'utf8');
        } else if (Buffer.isBuffer(content)) {
            hash.update(content);
        } else {
            hash.update(new Uint8Array(content));
        }
        return hash.digest('hex');
    }

    private async uploadFile(file: TFile, rootId: string, manifest: RemoteManifest) {
        const maxRetries = 3;
        let delay = 1000;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const content = await this.getFileContent(file);
                const hash = this.calculateHashFromContent(content);
                const mimeType = this.getMimeTypeForFile(file);
                const parentId = await this.ensureFolderStructure(file.parent?.path || '');

                const existingEntry = manifest.files[file.path];
                let driveId: string;

                if (existingEntry) {
                    try {
                        await this.driveClient.updateFile(existingEntry.driveId, content, mimeType);
                        driveId = existingEntry.driveId;
                    } catch (err: any) {
                        if (err instanceof DriveHttpError && err.status === 404) {
                            driveId = await this.driveClient.uploadFile(
                                (file.extension === 'md' || file.extension === 'canvas') ? file.basename : file.name,
                                content,
                                mimeType,
                                parentId
                            );
                        } else {
                            throw err;
                        }
                    }
                } else {
                    driveId = await this.driveClient.uploadFile(
                        (file.extension === 'md' || file.extension === 'canvas') ? file.basename : file.name,
                        content,
                        mimeType,
                        parentId
                    );
                }

                manifest.files[file.path] = {
                    path: file.path,
                    driveId,
                    hash,
                    modifiedTime: Date.now()
                };

                this.localCache.set({
                    path: file.path,
                    driveId,
                    hash,
                    lastModified: file.stat.mtime
                });
                return;
            } catch (err: any) {
                const status = err?.status || 0;
                const isTransient = status === 403 || status === 429 || status >= 500 || (err?.message && /rate|quota|timeout|econnreset/i.test(err.message));
                if (isTransient && attempt < maxRetries) {
                    console.warn(`Gemini Sync: Transient error uploading ${file.path} (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`, err);
                    await new Promise((r) => setTimeout(r, delay));
                    delay *= 2;
                } else {
                    throw err;
                }
            }
        }
    }

    private async getFileContent(file: TFile): Promise<string | Buffer> {
        if (file.extension === 'md') {
            return await this.app.vault.read(file);
        }
        if (file.extension === 'canvas') {
            return await this.canvasConverter.generateCanvasMarkdown(file);
        }
        const buffer = await this.app.vault.readBinary(file);
        return Buffer.from(buffer);
    }

    private async calculateFileHash(file: TFile): Promise<string> {
        const content = await this.getFileContent(file);
        return this.calculateHashFromContent(content);
    }

    private async getVaultRoot(): Promise<string> {
        if (this.rootFolderId) return this.rootFolderId;
        const rootPath = this.settings.remoteFolderPath || this.app.vault.getName();
        const rootId = await this.resolveRemoteRoot(rootPath);
        this.rootFolderId = rootId;
        return rootId;
    }

    private async resolveRemoteRoot(remotePath: string): Promise<string> {
        if (!remotePath || remotePath === '/') return 'root';
        const parts = remotePath.split('/').filter(p => p.length > 0);
        let parentId = 'root';

        for (const part of parts) {
            let folderId = await this.driveClient.getFileId(part, parentId, 'application/vnd.google-apps.folder');
            if (!folderId) {
                folderId = await this.driveClient.createFolder(part, parentId);
            }
            parentId = folderId;
        }
        return parentId;
    }

    private async ensureFolderStructure(folderPath: string): Promise<string> {
        let parentId = await this.getVaultRoot();
        if (!folderPath || folderPath === '/') return parentId;

        if (this.folderIdCache.has(folderPath)) return this.folderIdCache.get(folderPath)!;

        const parts = folderPath.split('/');
        let currentPath = '';

        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (this.folderIdCache.has(currentPath)) {
                parentId = this.folderIdCache.get(currentPath)!;
                continue;
            }
            let folderId = await this.driveClient.getFileId(part, parentId, 'application/vnd.google-apps.folder');
            if (!folderId) {
                folderId = await this.driveClient.createFolder(part, parentId);
            }
            parentId = folderId;
            this.folderIdCache.set(currentPath, folderId);
        }
        return parentId;
    }

    private async waitForObsidianSync(): Promise<void> {
        const internalPlugins = (this.app as any).internalPlugins;
        if (!internalPlugins) return;

        const syncPlugin = internalPlugins.plugins['sync'];
        if (!syncPlugin || !syncPlugin.enabled) return;

        const syncInstance = syncPlugin.instance;
        if (!syncInstance) return;

        const getStatus = () => syncInstance.status;
        const isInactive = (s: string) => ['fully_synced', 'paused', 'error'].includes(s);

        const currentStatus = getStatus();
        if (!currentStatus || isInactive(currentStatus)) return;

        this.updateStatus('Waiting for Obsidian Sync...', undefined, true);

        return new Promise<void>((resolve) => {
            let checks = 0;
            const maxChecks = 30;

            const interval = window.setInterval(() => {
                checks++;
                const status = getStatus();

                if (this.cancelRequested || isInactive(status) || checks >= maxChecks) {
                    clearInterval(interval);
                    resolve();
                }
            }, 1000);
        });
    }
}
