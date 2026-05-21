import * as vscode from 'vscode';
import { Client as SshClient, SFTPWrapper } from 'ssh2';
import { RemoteClient } from './RemoteClient';

const log = vscode.window.createOutputChannel('FTPU');

export class SftpClient implements RemoteClient {
    constructor(
        private sftp: SFTPWrapper,
        private ssh: SshClient
    ) {}

    async putFile(localPath: string, remotePath: string): Promise<void> {
        try {
            await this.rawPut(localPath, remotePath);
        } catch (err) {
            const msg = (err as Error).message ?? '';
            log.appendLine(`[putFile] Failed: ${msg}`);

            // Retry once after ensuring the directory exists.
            // Covers "No such file" (missing dir) and "Failure" (code 4)
            // which some servers return for the same condition.
            const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
            if (dir) {
                log.appendLine(`[putFile] Retrying after ensuring directory: ${dir}`);
                await this.ensureDir(dir);
                await this.rawPut(localPath, remotePath);
                return;
            }
            throw err;
        }
    }

    private rawPut(localPath: string, remotePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.fastPut(localPath, remotePath, (err) => {
                if (err) {
                    reject(new Error(`Upload failed: ${remotePath} — ${err.message}`));
                } else {
                    resolve();
                }
            });
        });
    }

    async ensureDir(remotePath: string): Promise<void> {
        // Phase 1: Walk every component — remove any regular files that
        //          block directory creation (broken sftp.mkdir servers
        //          can leave these behind).
        const parts = remotePath.split('/').filter(Boolean);
        let current = '';
        let needsCreation = false;
        for (const part of parts) {
            current += '/' + part;
            const info = await this.lstat(current);
            if (info === 'file') {
                log.appendLine(`[ensureDir] Removing file blocking directory: ${current}`);
                await this.unlink(current);
                needsCreation = true;
            } else if (info === 'none') {
                needsCreation = true;
            }
            // 'dir' → already exists, carry on
        }

        if (!needsCreation) { return; }

        // Phase 2: Create the full directory tree.
        //          Prefer SSH exec (works even when sftp.mkdir is broken).
        //          Fall back to sftp.mkdir for SFTP-only servers.
        try {
            await this.exec(`mkdir -p '${remotePath.replace(/'/g, "'\\''")}'`);
            log.appendLine(`[ensureDir] Created via exec: ${remotePath}`);
            return;
        } catch {
            // exec unavailable — fall back to sftp.mkdir per-component
        }

        current = '';
        for (const part of parts) {
            current += '/' + part;
            const info = await this.lstat(current);
            if (info === 'none') {
                await this.sftpMkdir(current);
            }
        }
    }

    /** Returns 'dir', 'file', or 'none' */
    private lstat(remotePath: string): Promise<'dir' | 'file' | 'none'> {
        return new Promise((resolve) => {
            this.sftp.lstat(remotePath, (err, stats) => {
                if (err) { resolve('none'); }
                else if (stats.isDirectory()) { resolve('dir'); }
                else { resolve('file'); }
            });
        });
    }

    stat(remotePath: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.sftp.stat(remotePath, (err) => {
                resolve(!err);
            });
        });
    }

    private sftpMkdir(remotePath: string): Promise<void> {
        return new Promise((resolve) => {
            this.sftp.mkdir(remotePath, () => resolve());
        });
    }

    private unlink(remotePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.unlink(remotePath, (err) => {
                if (err) { reject(new Error(`Failed to remove ${remotePath}: ${err.message}`)); }
                else { resolve(); }
            });
        });
    }

    private exec(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.ssh.exec(command, (err, stream) => {
                if (err) { reject(err); return; }
                let stdout = '';
                let stderr = '';
                stream.on('data', (data: Buffer) => { stdout += data.toString(); });
                stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
                stream.on('close', (code: number) => {
                    if (code === 0) { resolve(stdout); }
                    else { reject(new Error(`Command failed (exit ${code}): ${stderr.trim()}`)); }
                });
            });
        });
    }

    close(): void {
        // SFTP lifecycle managed by ConnectionManager's SSH client
    }
}
