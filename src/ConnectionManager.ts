import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client as SshClient, ConnectConfig } from 'ssh2';
import { Client as BasicFtpClient } from 'basic-ftp';
import { FtpuConfig } from './types';
import { RemoteClient } from './RemoteClient';
import { SftpClient } from './SftpClient';
import { FtpClient } from './FtpClient';

const CONNECT_TIMEOUT = 15_000;
const KEEPALIVE_INTERVAL = 30_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2_000;

export class ConnectionManager {
    private sshClient: SshClient | null = null;
    private ftpClient: BasicFtpClient | null = null;
    private remote: RemoteClient | null = null;
    private connected = false;
    private connecting = false;
    private lastConfig: FtpuConfig | null = null;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    private readonly _onStatusChanged = new vscode.EventEmitter<boolean>();
    readonly onStatusChanged = this._onStatusChanged.event;

    async connect(config: FtpuConfig): Promise<void> {
        if (this.connecting) {
            return;
        }
        if (this.connected) {
            await this.disconnect();
        }

        this.connecting = true;
        this.lastConfig = config;

        try {
            if (config.protocol === 'sftp') {
                await this.connectSftp(config);
            } else {
                await this.connectFtp(config);
            }
            this.connected = true;
            this.reconnectAttempts = 0;
            this._onStatusChanged.fire(true);
        } catch (err) {
            this.cleanup();
            throw err;
        } finally {
            this.connecting = false;
        }
    }

    private async connectSftp(config: FtpuConfig): Promise<void> {
        this.sshClient = new SshClient();

        await new Promise<void>((resolve, reject) => {
            const connectConfig: ConnectConfig = {
                host: config.host,
                port: config.port,
                username: config.username,
                readyTimeout: CONNECT_TIMEOUT,
                keepaliveInterval: KEEPALIVE_INTERVAL,
                keepaliveCountMax: 3,
            };

            if (config.privateKeyPath) {
                const keyPath = config.privateKeyPath.replace(/^~/, os.homedir());
                const resolved = path.resolve(keyPath);
                try {
                    connectConfig.privateKey = fs.readFileSync(resolved);
                } catch (err) {
                    reject(new Error(`Cannot read private key "${resolved}": ${(err as Error).message}`));
                    return;
                }
                if (config.passphrase) {
                    connectConfig.passphrase = config.passphrase;
                }
            } else if (config.password) {
                connectConfig.password = config.password;
            } else {
                connectConfig.agent = process.env.SSH_AUTH_SOCK;
            }

            const timeout = setTimeout(() => {
                reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT / 1000}s`));
                this.sshClient?.destroy();
            }, CONNECT_TIMEOUT + 1000);

            this.sshClient!.once('ready', () => { clearTimeout(timeout); resolve(); });
            this.sshClient!.once('error', (err) => { clearTimeout(timeout); reject(err); });
            this.sshClient!.connect(connectConfig);
        });

        const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
            this.sshClient!.sftp((err, sftp) => {
                if (err) { reject(new Error(`SFTP subsystem failed: ${err.message}`)); }
                else { resolve(sftp); }
            });
        });

        this.remote = new SftpClient(sftp);

        this.sshClient.on('error', () => this.handleDisconnect(true));
        this.sshClient.on('end', () => this.handleDisconnect(true));
        this.sshClient.on('close', () => this.handleDisconnect(true));
    }

    private async connectFtp(config: FtpuConfig): Promise<void> {
        this.ftpClient = new BasicFtpClient();
        this.ftpClient.ftp.verbose = false;

        await this.ftpClient.access({
            host: config.host,
            port: config.port,
            user: config.username,
            password: config.password || 'anonymous',
            secure: config.protocol === 'ftps',
        });

        this.remote = new FtpClient(this.ftpClient);
    }

    private handleDisconnect(tryReconnect: boolean): void {
        if (!this.connected) {
            return;
        }
        this.connected = false;
        this.remote = null;
        this._onStatusChanged.fire(false);

        if (tryReconnect && !this.disposed && this.lastConfig) {
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            vscode.window.showErrorMessage(
                `FTPU: Lost connection. Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Use "FTPU: Connect" to retry.`
            );
            this.reconnectAttempts = 0;
            return;
        }

        this.reconnectAttempts++;
        const delay = RECONNECT_DELAY * this.reconnectAttempts;

        this.reconnectTimer = setTimeout(async () => {
            if (this.disposed || this.connected || !this.lastConfig) {
                return;
            }
            try {
                await this.connect(this.lastConfig);
                vscode.window.showInformationMessage('FTPU: Reconnected');
            } catch {
                // next attempt scheduled by handleDisconnect
            }
        }, delay);
    }

    private cleanup(): void {
        this.sshClient?.destroy();
        this.sshClient = null;
        this.ftpClient?.close();
        this.ftpClient = null;
        this.remote = null;
    }

    async disconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
        this.cleanup();
        if (this.connected) {
            this.connected = false;
            this._onStatusChanged.fire(false);
        }
        this.reconnectAttempts = 0;
    }

    isConnected(): boolean {
        return this.connected;
    }

    async ensureConnected(config: FtpuConfig): Promise<RemoteClient> {
        if (!this.connected || !this.remote) {
            await this.connect(config);
        }
        if (!this.remote) {
            throw new Error('Failed to establish connection');
        }
        return this.remote;
    }

    dispose(): void {
        this.disposed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        this.cleanup();
        this.connected = false;
        this._onStatusChanged.dispose();
    }
}
