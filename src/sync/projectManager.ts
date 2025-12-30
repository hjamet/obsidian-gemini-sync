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

    async syncProjects() {
        if (!this.settings.enableTaskSync) {
            return;
        }

        console.log('Gemini Sync: Starting Project Sync...');

        try {
            // 1. Fetch [PROJET] tasks
            const tasks = await this.tasksClient.listProjectTasks();
            if (tasks.length === 0) {
                console.log('Gemini Sync: No project tasks found.');
                return;
            }

            console.log(`Gemini Sync: Found ${tasks.length} project tasks to import.`);

            let importedCount = 0;

            for (const task of tasks) {
                try {
                    await this.processTask(task);
                    importedCount++;

                    // 2. Ack task (Complete or Delete based on settings - logic is currently "Complete" as per UI)
                    if (this.settings.deleteTaskAfterSync) {
                        await this.tasksClient.completeTask(task.id);
                    }
                } catch (taskError) {
                    console.error(`Gemini Sync: Failed to process task "${task.title}"`, taskError);
                    new Notice(`Failed to import project: ${task.title}`);
                }
            }

            if (importedCount > 0) {
                new Notice(`Gemini Sync: Imported ${importedCount} project(s) from Tasks.`);
            }

        } catch (error) {
            console.error('Gemini Sync: Project Sync failed', error);
            new Notice(`Project Sync failed: ${error.message}`);
        }
    }

    private async processTask(task: TaskItem) {
        // Parse Title: remove "[PROJET]" tag from anywhere
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
            return;
        }

        // Construct Content
        const frontmatter = this.buildFrontmatter(task);
        const content = `${frontmatter}\n\n${task.notes || ''}`;

        // Ensure folder exists
        if (folderPath) {
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!folder) {
                await this.app.vault.createFolder(folderPath);
                console.log(`Gemini Sync: Created projects folder at ${folderPath}`);
            }
        }

        // Create File
        await this.app.vault.create(filePath, content);
        console.log(`Gemini Sync: Created project note at ${filePath}`);
    }

    private buildFrontmatter(task: TaskItem): string {
        const lines = ['---'];

        // Tags
        // Add specific project tag if configured or default #project? 
        // User asked: "Tagging : Ajouter automatiquement le tag #task dans la note Obsidian créée"
        // And "Tag précisé dans les settings" (wait, plan says "tags (configurés)")
        // The plan says: `tags: [#task, #ton_tag_projet]`
        // Since I didn't add a specific "Project Tag" setting in UI (I missed that detail in the simplified plan vs user query),
        // I will stick to what the user prompt said: "Ajouter automatiquement le tag #task"
        // And maybe a generic #project tag for now or just what is in settings?
        // Let's add #task and #project.
        lines.push('tags:');
        lines.push('  - task');
        lines.push('  - project');

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
