/**
 * Protocol-agnostic interface for remote file operations.
 * Implemented by SftpClient and FtpClient.
 */
export interface RemoteClient {
    putFile(localPath: string, remotePath: string): Promise<void>;
    ensureDir(remotePath: string): Promise<void>;
    stat(remotePath: string): Promise<boolean>;
    close(): void;
}
