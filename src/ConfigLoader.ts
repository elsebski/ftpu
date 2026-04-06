import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FtpuConfig, DEFAULT_CONFIG } from './types';

const CONFIG_DIR = '.vscode';
const CONFIG_FILENAME = 'ftpu.json';

export class ConfigLoader {
    private config: FtpuConfig | null = null;
    private configPath: string | null = null;
    private watcher: vscode.FileSystemWatcher | null = null;
    private readonly _onConfigChanged = new vscode.EventEmitter<FtpuConfig | null>();
    readonly onConfigChanged = this._onConfigChanged.event;

    constructor(private workspaceRoot: string) {
        this.configPath = path.join(workspaceRoot, CONFIG_DIR, CONFIG_FILENAME);
        this.setupWatcher();
    }

    private setupWatcher(): void {
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, `${CONFIG_DIR}/${CONFIG_FILENAME}`)
        );
        this.watcher.onDidChange(() => this.reload());
        this.watcher.onDidCreate(() => this.reload());
        this.watcher.onDidDelete(() => {
            this.config = null;
            this._onConfigChanged.fire(null);
        });
    }

    async load(): Promise<FtpuConfig | null> {
        if (!this.configPath) {
            return null;
        }
        try {
            const raw = await fs.promises.readFile(this.configPath, 'utf-8');
            const parsed = JSON.parse(raw);
            this.config = this.validate(parsed);
            return this.config;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                vscode.window.showErrorMessage(
                    `FTPU: Failed to load config — ${(err as Error).message}`
                );
            }
            return null;
        }
    }

    private async reload(): Promise<void> {
        const config = await this.load();
        this._onConfigChanged.fire(config);
    }

    private validate(raw: Record<string, unknown>): FtpuConfig {
        if (!raw.host || typeof raw.host !== 'string') {
            throw new Error('"host" is required');
        }
        if (!raw.username || typeof raw.username !== 'string') {
            throw new Error('"username" is required');
        }
        if (!raw.remotePath || typeof raw.remotePath !== 'string') {
            throw new Error('"remotePath" is required');
        }

        const protocol = (raw.protocol as string) || DEFAULT_CONFIG.protocol!;
        if (!['sftp', 'ftp', 'ftps'].includes(protocol)) {
            throw new Error(`Invalid protocol "${protocol}" — must be sftp, ftp, or ftps`);
        }

        return {
            name: (raw.name as string) || raw.host as string,
            protocol: protocol as FtpuConfig['protocol'],
            host: raw.host as string,
            port: typeof raw.port === 'number' ? raw.port : DEFAULT_CONFIG.port!,
            username: raw.username as string,
            password: raw.password as string | undefined,
            privateKeyPath: raw.privateKeyPath as string | undefined,
            passphrase: raw.passphrase as string | undefined,
            remotePath: raw.remotePath as string,
            uploadOnSave: typeof raw.uploadOnSave === 'boolean' ? raw.uploadOnSave : DEFAULT_CONFIG.uploadOnSave!,
            ignore: Array.isArray(raw.ignore) ? raw.ignore : DEFAULT_CONFIG.ignore!,
        };
    }

    getConfig(): FtpuConfig | null {
        return this.config;
    }

    dispose(): void {
        this.watcher?.dispose();
        this._onConfigChanged.dispose();
    }
}
