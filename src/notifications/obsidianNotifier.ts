import { Notice } from 'obsidian';
import { Notifier } from './notifier';

export class ObsidianNotifier implements Notifier {
    notify(message: string): void {
        new Notice(message);
    }
}
