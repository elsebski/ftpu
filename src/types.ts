export interface FtpuConfig {
    name: string;
    protocol: 'sftp' | 'ftp' | 'ftps';
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKeyPath?: string;
    passphrase?: string;
    remotePath: string;
    uploadOnSave: boolean;
    ignore: string[];
}

export const DEFAULT_CONFIG: Partial<FtpuConfig> = {
    protocol: 'sftp',
    port: 22,
    uploadOnSave: false,
    ignore: ['.git', '.vscode', 'node_modules', '.env', '.DS_Store'],
};
