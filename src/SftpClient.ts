import { SFTPWrapper } from 'ssh2';
import { RemoteClient } from './RemoteClient';

export class SftpClient implements RemoteClient {
    constructor(private sftp: SFTPWrapper) {}

    putFile(localPath: string, remotePath: string): Promise<void> {
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
        const parts = remotePath.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            const exists = await this.stat(current);
            if (!exists) {
                await this.mkdir(current);
            }
        }
    }

    stat(remotePath: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.sftp.stat(remotePath, (err) => {
                resolve(!err);
            });
        });
    }

    private mkdir(remotePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.mkdir(remotePath, (err) => {
                if (err && (err as any).code !== 4) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    close(): void {
        // SFTP lifecycle managed by ConnectionManager's SSH client
    }
}
