import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigLoader } from './ConfigLoader';
import { ConnectionManager } from './ConnectionManager';
import { Uploader } from './Uploader';
import { StatusBarManager } from './StatusBarManager';
import { FileWatcher } from './FileWatcher';
import { ModifiedFilesProvider, ModifiedFileItem } from './ModifiedFilesProvider';
import { ConfigPanel } from './ConfigPanel';

let configLoader: ConfigLoader;
let connectionManager: ConnectionManager;
let uploader: Uploader;
let statusBar: StatusBarManager;
let fileWatcher: FileWatcher;
let modifiedFilesProvider: ModifiedFilesProvider;
let uploadOnSave = false;
let initialized = false;

export async function activate(context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;

    // Always create these — they work without config
    const configPanel = new ConfigPanel(workspaceRoot);
    configLoader = new ConfigLoader(workspaceRoot);
    connectionManager = new ConnectionManager();
    uploader = new Uploader(connectionManager, workspaceRoot);
    statusBar = new StatusBarManager();
    fileWatcher = new FileWatcher(workspaceRoot, [], context.workspaceState);
    modifiedFilesProvider = new ModifiedFilesProvider(fileWatcher);

    // Register tree view
    const treeView = vscode.window.createTreeView('ftpuModifiedFiles', {
        treeDataProvider: modifiedFilesProvider,
    });

    context.subscriptions.push(
        configLoader, connectionManager, uploader, statusBar,
        fileWatcher, modifiedFilesProvider, treeView,
        { dispose: () => configPanel.dispose() }
    );

    // Register ALL commands upfront — they check `initialized` internally
    context.subscriptions.push(
        vscode.commands.registerCommand('ftpu.configure', () => configPanel.show()),

        vscode.commands.registerCommand('ftpu.uploadCurrentFile', async () => {
            if (!requireConfig()) { return; }
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('FTPU: No active file to upload');
                return;
            }
            await doUpload(editor.document.uri.fsPath);
        }),

        vscode.commands.registerCommand('ftpu.uploadFile', async (item: ModifiedFileItem) => {
            if (!requireConfig()) { return; }
            if (item?.absolutePath) {
                await doUpload(item.absolutePath);
            }
        }),

        vscode.commands.registerCommand('ftpu.uploadAllModified', async () => {
            if (!requireConfig()) { return; }
            const pending = fileWatcher.getPendingFiles();
            if (pending.length === 0) {
                vscode.window.showInformationMessage('FTPU: No modified files to upload');
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'FTPU: Uploading modified files',
                    cancellable: true,
                },
                async (progress, token) => {
                    const total = pending.length;
                    let uploaded = 0;
                    for (const file of pending) {
                        if (token.isCancellationRequested) { break; }
                        progress.report({
                            message: `${uploaded + 1}/${total} — ${path.basename(file.absolutePath)}`,
                            increment: 100 / total,
                        });
                        await doUpload(file.absolutePath);
                        uploaded++;
                    }
                }
            );
        }),

        vscode.commands.registerCommand('ftpu.clearModified', () => {
            fileWatcher.clear();
        }),

        vscode.commands.registerCommand('ftpu.refreshModified', () => {
            modifiedFilesProvider.refresh();
        }),

        vscode.commands.registerCommand('ftpu.toggleUploadOnSave', () => {
            uploadOnSave = !uploadOnSave;
            statusBar.setUploadOnSave(uploadOnSave);
            vscode.window.showInformationMessage(
                `FTPU: Upload on save ${uploadOnSave ? 'enabled' : 'disabled'}`
            );
        }),

        vscode.commands.registerCommand('ftpu.connect', async () => {
            if (!requireConfig()) { return; }
            const cfg = configLoader.getConfig()!;
            try {
                await connectionManager.connect(cfg);
                vscode.window.showInformationMessage(`FTPU: Connected to ${cfg.name}`);
            } catch (err) {
                vscode.window.showErrorMessage(`FTPU: Connection failed — ${(err as Error).message}`);
            }
        }),

        vscode.commands.registerCommand('ftpu.disconnect', async () => {
            await connectionManager.disconnect();
            vscode.window.showInformationMessage('FTPU: Disconnected');
        }),

        vscode.commands.registerCommand('ftpu.uploadExplorerFile', async (uri: vscode.Uri) => {
            if (!requireConfig() || !uri) { return; }
            await doUpload(uri.fsPath);
        }),

        vscode.commands.registerCommand('ftpu.revealInFinder', (item: ModifiedFileItem) => {
            if (item?.absolutePath) {
                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.absolutePath));
            }
        }),

        vscode.commands.registerCommand('ftpu.uploadExplorerFolder', async (uri: vscode.Uri) => {
            if (!requireConfig() || !uri) { return; }
            const cfg = configLoader.getConfig()!;
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `FTPU: Uploading folder ${path.basename(uri.fsPath)}`,
                    cancellable: false,
                },
                async () => {
                    try {
                        const files = await uploader.uploadFolder(uri.fsPath, cfg);
                        vscode.window.showInformationMessage(
                            `FTPU: Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`
                        );
                    } catch (err) {
                        vscode.window.showErrorMessage(`FTPU: ${(err as Error).message}`);
                    }
                }
            );
        })
    );

    // Upload on save listener
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (!initialized || !uploadOnSave) { return; }
            await doUpload(doc.uri.fsPath);
        })
    );

    // File watcher health -> status bar
    fileWatcher.onHealthCheck((healthy) => {
        statusBar.setWatcherStatus(healthy ? 'healthy' : 'unhealthy');
    });

    // Connection status -> status bar
    connectionManager.onStatusChanged((connected) => {
        const cfg = configLoader.getConfig();
        if (connected && cfg) {
            statusBar.setConnected(cfg.name);
        } else {
            statusBar.setDisconnected();
        }
    });

    // Config changes -> update state
    configLoader.onConfigChanged((newConfig) => {
        if (newConfig) {
            initWithConfig(newConfig);
        }
    });

    // Show the Modified Files panel as soon as the extension activates
    // (workspace has .ftpu.json or user ran Configure). Config validation
    // errors shouldn't hide the entire panel.
    vscode.commands.executeCommand('setContext', 'ftpu.active', true);

    // Load config and initialize
    const config = await configLoader.load();
    if (config) {
        initWithConfig(config);
    }
}

function initWithConfig(config: import('./types').FtpuConfig) {
    initialized = true;
    uploadOnSave = config.uploadOnSave;
    statusBar.setUploadOnSave(uploadOnSave);
    fileWatcher.updateIgnorePatterns(config.ignore);
}

function requireConfig(): boolean {
    if (!initialized || !configLoader.getConfig()) {
        vscode.window.showWarningMessage('FTPU: No .vscode/ftpu.json found. Run "FTPU: Configure" to set up.');
        return false;
    }
    return true;
}

async function doUpload(filePath: string) {
    const cfg = configLoader.getConfig();
    if (!cfg) {
        vscode.window.showErrorMessage('FTPU: No .vscode/ftpu.json config found');
        return;
    }

    const filename = path.basename(filePath);
    statusBar.showUploading(filename);
    fileWatcher.markUploading(filePath);

    try {
        await uploader.uploadFile(filePath, cfg);
        statusBar.showUploadSuccess();
        fileWatcher.markUploaded(filePath);
        setTimeout(() => {
            if (connectionManager.isConnected()) {
                statusBar.setConnected(cfg.name);
            }
        }, 2100);
    } catch (err) {
        statusBar.showUploadFailed();
        fileWatcher.markFailed(filePath);
        vscode.window.showErrorMessage(`FTPU: ${(err as Error).message}`);
        setTimeout(() => {
            if (connectionManager.isConnected()) {
                statusBar.setConnected(cfg.name);
            } else {
                statusBar.setDisconnected();
            }
        }, 3100);
    }
}

export function deactivate() {
    // Disposables handled by context.subscriptions
}
