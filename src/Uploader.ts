import * as path from 'path';
import * as fs from 'fs';
import { FtpuConfig } from './types';
import { ConnectionManager } from './ConnectionManager';
import { minimatch } from './minimatch';

interface QueueItem {
    localPath: string;
    config: FtpuConfig;
    resolve: () => void;
    reject: (err: Error) => void;
}

export class Uploader {
    private queue: QueueItem[] = [];
    private processing = false;
    private knownDirs = new Set<string>();

    constructor(
        private connectionManager: ConnectionManager,
        private workspaceRoot: string
    ) {}

    uploadFile(localPath: string, config: FtpuConfig): Promise<void> {
        return new Promise((resolve, reject) => {
            const relativePath = path.relative(this.workspaceRoot, localPath);
            if (this.isIgnored(relativePath, config.ignore)) {
                resolve();
                return;
            }
            this.queue.push({ localPath, config, resolve, reject });
            this.processQueue();
        });
    }

    async uploadFolder(localDir: string, config: FtpuConfig): Promise<string[]> {
        const files = await this.collectFiles(localDir, config.ignore);
        const results: string[] = [];
        for (const file of files) {
            await this.uploadFile(file, config);
            results.push(file);
        }
        return results;
    }

    private async collectFiles(dir: string, ignorePatterns: string[]): Promise<string[]> {
        const files: string[] = [];
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(this.workspaceRoot, fullPath);
            if (this.isIgnored(relativePath, ignorePatterns)) {
                continue;
            }
            if (entry.isDirectory()) {
                files.push(...await this.collectFiles(fullPath, ignorePatterns));
            } else if (entry.isFile()) {
                files.push(fullPath);
            }
        }
        return files;
    }

    private async processQueue(): Promise<void> {
        if (this.processing) {
            return;
        }
        this.processing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift()!;
            try {
                await this.doUpload(item.localPath, item.config);
                item.resolve();
            } catch (err) {
                item.reject(err as Error);
            }
        }

        this.processing = false;
    }

    private async doUpload(localPath: string, config: FtpuConfig): Promise<void> {
        const relativePath = path.relative(this.workspaceRoot, localPath);
        const remotePath = path.posix.join(
            config.remotePath,
            relativePath.split(path.sep).join('/')
        );

        const remote = await this.connectionManager.ensureConnected(config);
        const remoteDir = path.posix.dirname(remotePath);

        if (!this.knownDirs.has(remoteDir)) {
            await remote.ensureDir(remoteDir);
            this.knownDirs.add(remoteDir);
        }

        await remote.putFile(localPath, remotePath);
    }

    private isIgnored(relativePath: string, ignorePatterns: string[]): boolean {
        const segments = relativePath.split(path.sep);
        for (const pattern of ignorePatterns) {
            if (minimatch(relativePath, pattern)) {
                return true;
            }
            if (segments.some(seg => minimatch(seg, pattern))) {
                return true;
            }
        }
        return false;
    }

    clearDirCache(): void {
        this.knownDirs.clear();
    }

    dispose(): void {
        for (const item of this.queue) {
            item.reject(new Error('Uploader disposed'));
        }
        this.queue = [];
    }
}
