import { DriveClient } from './driveClient';

export interface TaskItem {
    id: string;
    title: string;
    notes?: string;
    due?: string; // RFC 3339 timestamp
    status: string;
}

const TASKS_API_BASE = 'https://tasks.googleapis.com/tasks/v1';

export class TasksClient {
    private driveClient: DriveClient;

    constructor(driveClient: DriveClient) {
        this.driveClient = driveClient;
    }

    /**
     * Lists all active tasks from the default list.
     */
    async listActiveTasks(): Promise<TaskItem[]> {
        const params = new URLSearchParams({
            showCompleted: 'false',
            maxResults: '100'
        });
        const res = await this.driveClient.authorizedFetch(`${TASKS_API_BASE}/lists/@default/tasks?${params.toString()}`);
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Failed to list tasks from Google: ${res.status} ${txt}`);
        }
        const data = await res.json();
        if (!Array.isArray(data.items)) {
            return [];
        }
        return data.items.map((t: any) => ({
            id: t.id,
            title: t.title || 'Untitled Task',
            notes: t.notes || '',
            due: t.due || undefined,
            status: t.status || 'needsAction'
        }));
    }

    /**
     * Fetches a specific task by ID.
     */
    async getTask(taskId: string): Promise<TaskItem | null> {
        const res = await this.driveClient.authorizedFetch(
            `${TASKS_API_BASE}/lists/@default/tasks/${encodeURIComponent(taskId)}`
        );
        if (res.status === 404) return null;
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Failed to get task ${taskId}: ${res.status} ${txt}`);
        }
        const t = await res.json();
        if (!t || !t.id) return null;
        return {
            id: t.id,
            title: t.title || '',
            notes: t.notes || '',
            due: t.due || undefined,
            status: t.status || 'needsAction'
        };
    }

    /**
     * Marks a task as completed.
     */
    async completeTask(taskId: string): Promise<void> {
        const res = await this.driveClient.authorizedFetch(
            `${TASKS_API_BASE}/lists/@default/tasks/${encodeURIComponent(taskId)}`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ id: taskId, status: 'completed' })
            }
        );
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Failed to complete task ${taskId}: ${res.status} ${txt}`);
        }
        console.log(`Gemini Sync: Task ${taskId} marked as completed.`);
    }
}
