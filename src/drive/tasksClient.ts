import { google, tasks_v1 } from 'googleapis';
import { DriveClient } from './driveClient';

export interface TaskItem {
    id: string;
    title: string;
    notes?: string;
    due?: string; // RFC 3339 timestamp
    status: string;
}

export class TasksClient {
    private driveClient: DriveClient;

    constructor(driveClient: DriveClient) {
        this.driveClient = driveClient;
    }

    private getService(): tasks_v1.Tasks {
        return this.driveClient.getTasks();
    }

    /**
     * Lists tasks from the default list that start with [PROJET].
     * Only returns tasks that are not 'completed' (hidden).
     */
    async listProjectTasks(): Promise<TaskItem[]> {
        const service = this.getService();
        try {
            const res = await service.tasks.list({
                tasklist: '@default',
                showCompleted: false,
                maxResults: 100
            });

            if (!res.data.items) {
                return [];
            }

            // Filter for tasks containing [PROJET] (case insensitive if desired, but user said [PROJET])
            console.log('Gemini Sync: All tasks fetched:', res.data.items?.map(t => t.title));
            const projectTasks = res.data.items.filter(task =>
                task.title && task.title.includes('[PROJET]')
            );

            return projectTasks.map(t => ({
                id: t.id!,
                title: t.title!,
                notes: t.notes || '',
                due: t.due || undefined,
                status: t.status!
            }));

        } catch (error) {
            console.error('Gemini Sync: Failed to list tasks', error);
            // Fail-fast principle: propagate error if it's critical, or return empty if it's just network?
            // "Fail-Fast: Si une condition attendue n'est pas remplie, le script DOIT échouer de manière explicite"
            throw new Error(`Failed to list tasks from Google: ${error.message}`);
        }
    }

    /**
     * Marks a task as completed.
     */
    async completeTask(taskId: string): Promise<void> {
        const service = this.getService();
        try {
            await service.tasks.update({
                tasklist: '@default',
                task: taskId,
                requestBody: {
                    id: taskId,
                    status: 'completed'
                }
            });
            console.log(`Gemini Sync: Task ${taskId} marked as completed.`);
        } catch (error) {
            console.error(`Gemini Sync: Failed to complete task ${taskId}`, error);
            throw new Error(`Failed to complete task ${taskId}: ${error.message}`);
        }
    }
}
