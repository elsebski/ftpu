import * as vscode from 'vscode';
import { FileWatcher, ModifiedFile } from './FileWatcher';

export class ModifiedFilesProvider implements vscode.TreeDataProvider<ModifiedFileItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ModifiedFileItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private fileWatcher: FileWatcher) {
        fileWatcher.onDidChange(() => this._onDidChangeTreeData.fire());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ModifiedFileItem): vscode.TreeItem {
        return element;
    }

    getChildren(): ModifiedFileItem[] {
        return this.fileWatcher.getFiles().map(f => new ModifiedFileItem(f));
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

const STATE_LABELS: Record<ModifiedFile['state'], string> = {
    pending: 'pending upload',
    uploading: 'uploading…',
    uploaded: 'uploaded ✓',
    failed: 'upload failed',
};

const STATE_ICONS: Record<ModifiedFile['state'], vscode.ThemeIcon> = {
    pending: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow')),
    uploading: new vscode.ThemeIcon('loading~spin'),
    uploaded: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
    failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')),
};

export class ModifiedFileItem extends vscode.TreeItem {
    public readonly absolutePath: string;
    public readonly state: ModifiedFile['state'];

    constructor(file: ModifiedFile) {
        super(file.relativePath, vscode.TreeItemCollapsibleState.None);
        this.absolutePath = file.absolutePath;
        this.state = file.state;
        this.iconPath = STATE_ICONS[file.state];
        this.description = STATE_LABELS[file.state];
        this.tooltip = `${file.relativePath} — ${STATE_LABELS[file.state]}`;
        this.contextValue = file.state;

        this.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [vscode.Uri.file(file.absolutePath)],
        };
    }
}
