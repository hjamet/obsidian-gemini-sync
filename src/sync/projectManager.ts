import { App, TFile, normalizePath } from 'obsidian';
import { TasksClient, TaskItem } from '../drive/tasksClient';
import { Notifier } from '../notifications/notifier';
import { GeminiSyncSettings } from '../main';

export class ProjectManager {
    private app: App;
    private tasksClient: TasksClient;
    private settings: GeminiSyncSettings;
    private notifier: Notifier;

    constructor(app: App, tasksClient: TasksClient, settings: GeminiSyncSettings, notifier: Notifier) {
        this.app = app;
        this.tasksClient = tasksClient;
        this.settings = settings;
        this.notifier = notifier;
    }

    updateSettings(settings: GeminiSyncSettings) {
        this.settings = settings;
    }

    async syncTasks() {
        if (!this.settings.enableTaskSync) {
            return;
        }

        console.log('Gemini Sync: Starting Google Tasks Sync...');

        try {
            // 1. Check local tasks for remote completion
            await this.checkCompletedTasks();

            // 2. Fetch all active tasks
            const tasks = await this.tasksClient.listActiveTasks();
            if (tasks.length === 0) {
                console.log('Gemini Sync: No active tasks found to import.');
                return;
            }

            console.log(`Gemini Sync: Found ${tasks.length} active tasks potentially to import.`);

            let importedCount = 0;
            for (const task of tasks) {
                try {

                    const created = await this.processTask(task);
                    if (created) {
                        importedCount++;
                    }
                } catch (taskError) {
                    console.error(`Gemini Sync: Failed to process task "${task.title}"`, taskError);
                    this.notifier.notify(`Failed to import task: ${task.title}`);
                }
            }

            if (importedCount > 0) {
                this.notifier.notify(`Gemini Sync: Imported ${importedCount} task(s) from Google Tasks.`);
            }

        } catch (error) {
            console.error('Gemini Sync: Google Tasks Sync failed', error);
            this.notifier.notify(`Google Tasks Sync failed: ${error.message}`);
        }
    }

    private async checkCompletedTasks() {
        const folderPath = this.settings.projectsFolderPath || '';
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) return;

        const files = this.app.vault.getFiles().filter(f => f.path.startsWith(folderPath) && f.extension === 'md');

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter) {
                const fm = cache.frontmatter;
                if (fm['g_task_id']) {
                    const taskId = fm['g_task_id'];
                    const status = fm['status'] || 'active'; // Default to active if missing
                    const tags = fm['tags'] || [];

                    if (status === 'active') {
                        const remoteTask = await this.tasksClient.getTask(taskId);
                        if (remoteTask && remoteTask.status === 'completed') {
                            // Task is completed remotely
                            if (this.settings.deleteNoteOnTaskComplete) {
                                await this.app.vault.trash(file, true);
                                console.log(`Gemini Sync: Trashed local task note "${file.name}" (Sync G->O).`);
                            } else {
                                await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                                    frontmatter['status'] = 'completed';
                                });
                                console.log(`Gemini Sync: Marked local task "${file.name}" as completed (Sync G->O).`);
                            }
                        }
                    } else if (status === 'completed' || tags.includes(this.settings.completionTag || 'projet-fini')) {
                        // Bidirectional: Obsidian -> Google
                        const remoteTask = await this.tasksClient.getTask(taskId);
                        if (remoteTask && remoteTask.status !== 'completed') {
                            await this.tasksClient.completeTask(taskId);
                            console.log(`Gemini Sync: Marked remote task for "${file.name}" as completed (Sync O->G).`);
                        }
                    }
                }
            }
        }
    }

    private async processTask(task: TaskItem): Promise<boolean> {
        // Parse Title: clean spaces and sanitize filename
        const safeTitle = task.title.trim().replace(/[\\/:*?"<>|]/g, '-');

        const folderPath = this.settings.projectsFolderPath || '';
        const filePath = normalizePath(`${folderPath}/${safeTitle}.md`);

        // Check if file already exists
        const existingFile = this.app.vault.getAbstractFileByPath(filePath);
        if (existingFile) {
            console.log(`Gemini Sync: File "${filePath}" already exists. Skipping creation to avoid overwrite.`);
            // Potentially we could append or update, but for now safe skip
            return false;
        }

        // Construct Content
        const frontmatter = this.buildFrontmatter(task);
        const content = `${frontmatter}\n\n${task.notes || ''}`;

        // Ensure folder exists
        if (folderPath) {
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!folder) {
                await this.app.vault.createFolder(folderPath);
                console.log(`Gemini Sync: Created tasks folder at ${folderPath}`);
            }
        }

        // Create File
        await this.app.vault.create(filePath, content);
        console.log(`Gemini Sync: Created task note at ${filePath}`);
        return true;
    }

    private buildFrontmatter(task: TaskItem): string {
        const lines = ['---'];

        lines.push('tags:');
        lines.push('  - gtask');
        lines.push('  - project');
        lines.push(`g_task_id: ${task.id}`);
        lines.push('status: active');

        if (task.due) {
            const dateOnly = task.due.split('T')[0];
            lines.push(`due: "${dateOnly}"`);
        }

        lines.push('---');
        return lines.join('\n');
    }
}
