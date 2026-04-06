import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { minimatch } from './minimatch';

export interface ModifiedFile {
    absolutePath: string;
    relativePath: string;
    state: 'pending' | 'uploading' | 'uploaded' | 'failed';
}

interface PersistedFile {
    absolutePath: string;
    relativePath: string;
    state: 'pending' | 'failed';
}

const STORAGE_KEY = 'ftpu.modifiedFiles';

export class FileWatcher {
    private files = new Map<string, ModifiedFile>();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private saveListener: vscode.Disposable;
    private fsWatcher: vscode.FileSystemWatcher | null = null;
    private fsHealthy = true;
    private readonly _onHealthCheck = new vscode.EventEmitter<boolean>();
    readonly onHealthCheck = this._onHealthCheck.event;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private workspaceRoot: string,
        private ignorePatterns: string[],
        private storage: vscode.Memento
    ) {
        // Restore persisted files
        this.restoreState();

        // Editor save events
        this.saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
            this.trackFile(doc.uri.fsPath);
        });

        // File system watcher — catches external changes
        this.fsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, '**/*')
        );
        this.fsWatcher.onDidCreate((uri) => this.trackFile(uri.fsPath));
        this.fsWatcher.onDidChange((uri) => this.trackFile(uri.fsPath));

        // Check if OS file watching is functional
        this.checkFileWatcherHealth();
    }

    private restoreState(): void {
        const saved = this.storage.get<PersistedFile[]>(STORAGE_KEY, []);
        for (const file of saved) {
            // Only restore if the file still exists on disk
            if (fs.existsSync(file.absolutePath)) {
                this.files.set(file.absolutePath, {
                    absolutePath: file.absolutePath,
                    relativePath: file.relativePath,
                    state: file.state,
                });
            }
        }
        if (this.files.size > 0) {
            this._onDidChange.fire();
        }
    }

    private persistState(): void {
        // Debounce saves to avoid hammering storage
        if (this.saveTimer) { clearTimeout(this.saveTimer); }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            const toSave: PersistedFile[] = [];
            for (const file of this.files.values()) {
                // Only persist pending/failed — uploading/uploaded are transient
                if (file.state === 'pending' || file.state === 'failed') {
                    toSave.push({
                        absolutePath: file.absolutePath,
                        relativePath: file.relativePath,
                        state: file.state,
                    });
                }
            }
            this.storage.update(STORAGE_KEY, toSave);
        }, 500);
    }

    private checkFileWatcherHealth(): void {
        const testDir = os.tmpdir();
        const testFile = path.join(testDir, `.ftpu-healthcheck-${Date.now()}`);

        let detected = false;
        let watcher: fs.FSWatcher | null = null;

        try {
            watcher = fs.watch(testDir, (event, filename) => {
                if (filename && filename.includes('ftpu-healthcheck')) {
                    detected = true;
                }
            });

            watcher.on('error', () => {
                this.reportUnhealthyWatcher();
                watcher?.close();
            });

            setTimeout(() => {
                try {
                    fs.writeFileSync(testFile, '');
                } catch {
                    watcher?.close();
                    return;
                }

                setTimeout(() => {
                    watcher?.close();
                    try { fs.unlinkSync(testFile); } catch {}

                    if (detected) {
                        this._onHealthCheck.fire(true);
                    } else {
                        this.reportUnhealthyWatcher();
                    }
                }, 1000);
            }, 200);
        } catch {
            this.reportUnhealthyWatcher();
            try { fs.unlinkSync(testFile); } catch {}
        }
    }

    private reportUnhealthyWatcher(): void {
        if (!this.fsHealthy) { return; }
        this.fsHealthy = false;
        this._onHealthCheck.fire(false);

        vscode.window.showWarningMessage(
            'FTPU: File watching is unavailable — your system may have too many open files. ' +
            'External file changes won\'t be detected automatically. ' +
            'Try restarting your computer to fix this.',
            'More Info'
        ).then(choice => {
            if (choice === 'More Info') {
                vscode.window.showInformationMessage(
                    'Your OS has a limited number of file watchers. When too many apps hold open files, ' +
                    'the OS stops delivering file change events. This affects your editor\'s file explorer ' +
                    'and extensions that watch for changes. A reboot clears all open file handles.'
                );
            }
        });
    }

    trackFile(absolutePath: string): void {
        const rel = path.relative(this.workspaceRoot, absolutePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) { return; }

        const segments = rel.split(path.sep);

        // Always exclude .git internals regardless of config
        if (segments[0] === '.git') { return; }

        for (const pattern of this.ignorePatterns) {
            if (minimatch(rel, pattern) || segments.some(s => minimatch(s, pattern))) {
                return;
            }
        }

        const existing = this.files.get(absolutePath);
        if (existing?.state === 'uploaded' || existing?.state === 'uploading') { return; }

        this.files.set(absolutePath, { absolutePath, relativePath: rel, state: 'pending' });
        this._onDidChange.fire();
        this.persistState();
    }

    getFiles(): ModifiedFile[] {
        return Array.from(this.files.values());
    }

    getPendingFiles(): ModifiedFile[] {
        return this.getFiles().filter(f => f.state === 'pending' || f.state === 'failed');
    }

    setState(absolutePath: string, state: ModifiedFile['state']): void {
        const file = this.files.get(absolutePath);
        if (file) {
            file.state = state;
            this._onDidChange.fire();
            this.persistState();
        }
    }

    markUploading(absolutePath: string): void { this.setState(absolutePath, 'uploading'); }
    markFailed(absolutePath: string): void { this.setState(absolutePath, 'failed'); }

    markUploaded(absolutePath: string): void {
        this.setState(absolutePath, 'uploaded');
        setTimeout(() => {
            this.files.delete(absolutePath);
            this._onDidChange.fire();
            this.persistState();
        }, 2000);
    }

    clear(): void {
        this.files.clear();
        this._onDidChange.fire();
        this.persistState();
    }

    remove(absolutePath: string): void {
        this.files.delete(absolutePath);
        this._onDidChange.fire();
        this.persistState();
    }

    updateIgnorePatterns(patterns: string[]): void {
        this.ignorePatterns = patterns;
    }

    dispose(): void {
        this.saveListener.dispose();
        this.fsWatcher?.dispose();
        if (this.saveTimer) { clearTimeout(this.saveTimer); }
        this._onDidChange.dispose();
        this._onHealthCheck.dispose();
    }
}
