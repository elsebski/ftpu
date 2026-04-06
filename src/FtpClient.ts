import { Client as BasicFtpClient } from 'basic-ftp';
import { RemoteClient } from './RemoteClient';

export class FtpClient implements RemoteClient {
    constructor(private client: BasicFtpClient) {}

    async putFile(localPath: string, remotePath: string): Promise<void> {
        await this.client.uploadFrom(localPath, remotePath);
    }

    async ensureDir(remotePath: string): Promise<void> {
        await this.client.ensureDir(remotePath);
    }

    async stat(remotePath: string): Promise<boolean> {
        try {
            await this.client.size(remotePath);
            return true;
        } catch {
            return false;
        }
    }

    close(): void {
        this.client.close();
    }
}
