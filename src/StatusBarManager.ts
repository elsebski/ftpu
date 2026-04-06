import * as vscode from 'vscode';

export class StatusBarManager {
    private sepLeft: vscode.StatusBarItem;
    private settingsItem: vscode.StatusBarItem;
    private connectionItem: vscode.StatusBarItem;
    private uploadModeItem: vscode.StatusBarItem;
    private watcherItem: vscode.StatusBarItem;
    private uploadingTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        this.sepLeft = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
        this.sepLeft.text = '\u2595';
        this.sepLeft.show();

        this.settingsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
        this.settingsItem.text = '$(gear)';
        this.settingsItem.tooltip = 'FTPU: Open Settings';
        this.settingsItem.command = 'ftpu.configure';
        this.settingsItem.show();

        this.connectionItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.connectionItem.command = 'ftpu.connect';
        this.setDisconnected();
        this.connectionItem.show();

        this.uploadModeItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            99
        );
        this.uploadModeItem.command = 'ftpu.toggleUploadOnSave';
        this.setUploadOnSave(false);
        this.uploadModeItem.show();

        this.watcherItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            98
        );
        this.setWatcherStatus('checking');
        this.watcherItem.show();
    }

    setConnected(serverName: string): void {
        this.connectionItem.text = `$(cloud) FTPU: ${serverName}`;
        this.connectionItem.tooltip = `Connected to ${serverName} — click to disconnect`;
        this.connectionItem.command = 'ftpu.disconnect';
    }

    setDisconnected(): void {
        this.connectionItem.text = '$(cloud-offline) FTPU: Disconnected';
        this.connectionItem.tooltip = 'Click to connect';
        this.connectionItem.command = 'ftpu.connect';
    }

    setUploadOnSave(enabled: boolean): void {
        if (enabled) {
            this.uploadModeItem.text = '$(sync) Auto';
            this.uploadModeItem.tooltip = 'Upload on save: ON — click to toggle';
        } else {
            this.uploadModeItem.text = '$(sync-ignored) Manual';
            this.uploadModeItem.tooltip = 'Upload on save: OFF — click to toggle';
        }
    }

    showUploading(filename: string): void {
        if (this.uploadingTimeout) {
            clearTimeout(this.uploadingTimeout);
        }
        this.connectionItem.text = `$(loading~spin) Uploading ${filename}...`;
    }

    showUploadSuccess(): void {
        this.connectionItem.text = '$(check) Uploaded';
        this.uploadingTimeout = setTimeout(() => {
            this.uploadingTimeout = null;
        }, 2000);
    }

    showUploadFailed(): void {
        this.connectionItem.text = '$(error) Upload failed';
        this.uploadingTimeout = setTimeout(() => {
            this.uploadingTimeout = null;
        }, 3000);
    }

    setWatcherStatus(status: 'healthy' | 'unhealthy' | 'checking'): void {
        switch (status) {
            case 'healthy':
                this.watcherItem.text = '$(circle-filled)\u2595';
                this.watcherItem.tooltip = 'File watcher: active — external changes will be detected';
                this.watcherItem.color = '#4ec94e';
                break;
            case 'unhealthy':
                this.watcherItem.text = '$(circle-filled)\u2595';
                this.watcherItem.tooltip = 'File watcher: unavailable — too many open files. Restart your computer to fix.';
                this.watcherItem.color = '#e54e4e';
                break;
            case 'checking':
                this.watcherItem.text = '$(circle-filled)\u2595';
                this.watcherItem.tooltip = 'File watcher: checking…';
                this.watcherItem.color = '#cccc44';
                break;
        }
    }

    dispose(): void {
        if (this.uploadingTimeout) {
            clearTimeout(this.uploadingTimeout);
        }
        this.sepLeft.dispose();
        this.settingsItem.dispose();
        this.connectionItem.dispose();
        this.uploadModeItem.dispose();
        this.watcherItem.dispose();
    }
}
