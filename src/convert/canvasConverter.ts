import { App, TFile } from 'obsidian';
import { CanvasData, CanvasNode, CanvasEdge } from './canvasTypes';

export class CanvasConverter {
    app: App;

    constructor(app: App) {
        this.app = app;
    }

    async generateCanvasMarkdown(canvasFile: TFile): Promise<string> {
        const content = await this.app.vault.read(canvasFile);

        let data: CanvasData;
        try {
            data = JSON.parse(content);
        } catch (e) {
            console.error('Failed to parse canvas file:', e);
            return `Error parsing canvas file: ${e.message}`;
        }

        const lines: string[] = [];

        // Title
        lines.push(`# Canvas: ${canvasFile.basename}`);
        lines.push('');

        // 1. Structure Overview
        lines.push('## Structure Overview');
        lines.push('');

        // Groups
        const groups = data.nodes.filter(n => n.type === 'group');
        if (groups.length > 0) {
            lines.push('### Groups');
            for (const group of groups) {
                lines.push(`- **Group** (${group.id})`);
                // Find nodes legally inside this group (simple bounding box check)
                const children = data.nodes.filter(n =>
                    n.type !== 'group' &&
                    n.x >= group.x && n.x + n.width <= group.x + group.width &&
                    n.y >= group.y && n.y + n.height <= group.y + group.height
                );

                if (children.length > 0) {
                    for (const child of children) {
                        lines.push(`  - ${this.getStructureLabel(child)}`);
                    }
                }
            }
            lines.push('');
        }

        // Connections
        if (data.edges && data.edges.length > 0) {
            lines.push('### Connections');
            for (const edge of data.edges) {
                const fromNode = data.nodes.find(n => n.id === edge.fromNode);
                const toNode = data.nodes.find(n => n.id === edge.toNode);

                const fromLabel = fromNode ? this.getStructureLabel(fromNode) : `(unknown) ${edge.fromNode}`;
                const toLabel = toNode ? this.getStructureLabel(toNode) : `(unknown) ${edge.toNode}`;

                const label = edge.label ? ` --[${edge.label}]--> ` : ' --> ';

                lines.push(`- ${fromLabel}${label}${toLabel}`);
            }
            lines.push('');
        }

        // 2. Node Contents
        lines.push('## Content');
        lines.push('');

        // We process non-group nodes
        const contentNodes = data.nodes.filter(n => n.type !== 'group');

        for (const node of contentNodes) {
            lines.push(`<--- ${node.id} --->`);
            lines.push('');

            if (node.type === 'text') {
                lines.push(node.text || '');
            } else if (node.type === 'file') {
                if (node.file) {
                    await this.appendFileContent(lines, node.file);
                } else {
                    lines.push('*File reference is missing*');
                }
            } else if (node.type === 'link') {
                lines.push(`Link: ${node.url}`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    private getStructureLabel(node: CanvasNode): string {
        return `(${node.type}) ${node.id}`;
    }

    private async appendFileContent(lines: string[], filePath: string) {
        const file = this.app.metadataCache.getFirstLinkpathDest(filePath, '');
        if (!file) {
            lines.push(`*File not found: ${filePath}*`);
            return;
        }

        if (file.extension === 'md') {
            try {
                const content = await this.app.vault.read(file);
                lines.push('#### File Content');
                lines.push(content);
            } catch (e) {
                lines.push(`*Error reading file: ${e.message}*`);
            }
        } else {
            lines.push(`*Attachment: ${filePath} (Non-markdown files are not embedded)*`);
        }
    }
}
