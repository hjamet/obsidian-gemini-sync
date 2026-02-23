import { App, TFile, normalizePath, Notice } from 'obsidian';
import { TasksClient, TaskItem } from '../drive/tasksClient';
import { GeminiSyncSettings } from '../main';

export class ProjectManager {
    private app: App;
    private tasksClient: TasksClient;
    private settings: GeminiSyncSettings;

    constructor(app: App, tasksClient: TasksClient, settings: GeminiSyncSettings) {
        this.app = app;
        this.tasksClient = tasksClient;
        this.settings = settings;
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

            console.log(`Gemini Sync: Found ${tasks.length} active tasks to import.`);

            let importedCount = 0;

            for (const task of tasks) {
                try {
                    const created = await this.processTask(task);
                    if (created) {
                        importedCount++;

                        // 3. Ack task if configured
                        if (this.settings.deleteTaskAfterSync) {
                            await this.tasksClient.completeTask(task.id);
                        }
                    }
                } catch (taskError) {
                    console.error(`Gemini Sync: Failed to process task "${task.title}"`, taskError);
                    new Notice(`Failed to import task: ${task.title}`);
                }
            }

            if (importedCount > 0) {
                new Notice(`Gemini Sync: Imported ${importedCount} task(s) from Google Tasks.`);
            }

        } catch (error) {
            console.error('Gemini Sync: Google Tasks Sync failed', error);
            new Notice(`Google Tasks Sync failed: ${error.message}`);
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
                if (fm['googleTaskId'] && fm['status'] === 'active') {
                    const taskId = fm['googleTaskId'];
                    const remoteTask = await this.tasksClient.getTask(taskId);

                    if (remoteTask && remoteTask.status === 'completed') {
                        // Task is completed remotely, update local file
                        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                            frontmatter['status'] = 'completed';
                        });
                        console.log(`Gemini Sync: Marked local task "${file.name}" as completed.`);
                    }
                }
            }
        }
    }

    private async processTask(task: TaskItem): Promise<boolean> {
        // Parse Title: remove "[PROJET]" tag from anywhere in case it's still there
        const rawTitle = task.title.replace(/\[PROJET\]/gi, '').trim();
        // Sanitize filename
        const safeTitle = rawTitle.replace(/[\\/:*?"<>|]/g, '-');

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
        lines.push('  - tâche_venant_de_Google_Task');
        lines.push(`googleTaskId: ${task.id}`);
        lines.push(`status: active`);

        // Deadline
        if (task.due) {
            // task.due is RFC3339 usually (e.g. 2023-10-01T00:00:00.000Z)
            // Obsidian typically likes YYYY-MM-DD for dates
            try {
                const date = new Date(task.due);
                const dateStr = date.toISOString().split('T')[0];
                lines.push(`deadline: ${dateStr}`);
            } catch (e) {
                console.warn('Invalid date format in task due date', task.due);
            }
        }

        lines.push('---');
        return lines.join('\n');
    }
}
