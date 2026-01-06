export interface CanvasNode {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    type: 'text' | 'file' | 'link' | 'group';
    color?: string;
    label?: string; // For groups
    text?: string; // For text nodes
    file?: string; // For file nodes
    url?: string; // For link nodes
}

export interface CanvasEdge {
    id: string;
    fromNode: string;
    fromSide: 'top' | 'right' | 'bottom' | 'left';
    toNode: string;
    toSide: 'top' | 'right' | 'bottom' | 'left';
    label?: string;
    color?: string;
}

export interface CanvasData {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
}
