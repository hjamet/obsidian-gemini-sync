import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { SyncIndex, SyncIndexEntry } from '../main';

interface CompactCachePayload {
    version: 2;
    entries: { [filePath: string]: [string, string, number] }; // [driveId, hash, lastModified]
}

/**
 * Stores the machine-local mtime->hash cache outside the Obsidian vault (~/.obsidian-gemini-sync/)
 * in compact tuple form so data.json stays <1 KB and Obsidian Sync never churns on cache writes.
 */
export class LocalSyncCache {
    private cacheFilePath: string;
    private entries: Map<string, SyncIndexEntry> = new Map();
    private dirty: boolean = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(vaultIdentifier: string) {
        const hash = crypto.createHash('sha256').update(vaultIdentifier, 'utf8').digest('hex').slice(0, 12);
        const cacheDir = path.join(os.homedir(), '.obsidian-gemini-sync');
        this.cacheFilePath = path.join(cacheDir, `${hash}-index.json`);
        this.loadFromDisk();
    }

    public getCacheFilePath(): string {
        return this.cacheFilePath;
    }

    private loadFromDisk(): void {
        if (!fs.existsSync(this.cacheFilePath)) return;
        const raw = fs.readFileSync(this.cacheFilePath, 'utf8');
        if (!raw.trim()) return;
        const parsed = JSON.parse(raw) as CompactCachePayload;
        if (parsed && parsed.version === 2 && parsed.entries && typeof parsed.entries === 'object') {
            for (const [filePath, tuple] of Object.entries(parsed.entries)) {
                if (Array.isArray(tuple) && tuple.length >= 3) {
                    this.entries.set(filePath, {
                        path: filePath,
                        driveId: String(tuple[0]),
                        hash: String(tuple[1]),
                        lastModified: Number(tuple[2])
                    });
                }
            }
        }
    }

    /**
     * One-time seamless migration of legacy settings.syncIndex from data.json into external cache.
     * Returns true if entries were migrated so caller can slim down data.json.
     */
    public migrateFromLegacySyncIndex(legacyIndex?: SyncIndex): boolean {
        if (!legacyIndex || typeof legacyIndex !== 'object') return false;
        const keys = Object.keys(legacyIndex);
        if (keys.length === 0) return false;

        for (const [filePath, entry] of Object.entries(legacyIndex)) {
            if (!entry || !entry.driveId || !entry.hash) continue;
            const existing = this.entries.get(filePath);
            if (!existing || (entry.lastModified || 0) >= (existing.lastModified || 0)) {
                this.entries.set(filePath, {
                    path: filePath,
                    driveId: entry.driveId,
                    hash: entry.hash,
                    lastModified: entry.lastModified || 0
                });
            }
        }
        this.dirty = true;
        this.flushSync();
        return true;
    }

    public get(filePath: string): SyncIndexEntry | undefined {
        return this.entries.get(filePath);
    }

    public set(entry: SyncIndexEntry): void {
        const prev = this.entries.get(entry.path);
        if (prev && prev.driveId === entry.driveId && prev.hash === entry.hash && prev.lastModified === entry.lastModified) {
            return;
        }
        this.entries.set(entry.path, entry);
        this.dirty = true;
    }

    public delete(filePath: string): void {
        if (this.entries.delete(filePath)) {
            this.dirty = true;
        }
    }

    public clear(): void {
        this.entries.clear();
        this.dirty = true;
        this.flushSync();
    }

    public size(): number {
        return this.entries.size;
    }

    public scheduleFlush(delayMs: number = 2000): void {
        if (!this.dirty) return;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flushSync();
        }, delayMs);
    }

    public flushSync(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (!this.dirty) return;
        const dir = path.dirname(this.cacheFilePath);
        fs.mkdirSync(dir, { recursive: true });
        const compact: { [filePath: string]: [string, string, number] } = {};
        for (const [filePath, e] of this.entries.entries()) {
            compact[filePath] = [e.driveId, e.hash, e.lastModified];
        }
        const payload: CompactCachePayload = { version: 2, entries: compact };
        const tmpPath = `${this.cacheFilePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
        fs.renameSync(tmpPath, this.cacheFilePath);
        this.dirty = false;
    }
}
