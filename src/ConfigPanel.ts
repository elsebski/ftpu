import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FtpuConfig, DEFAULT_CONFIG } from './types';

export class ConfigPanel {
    private panel: vscode.WebviewPanel | null = null;

    constructor(private workspaceRoot: string) {}

    async show(): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'ftpuConfig',
            'FTPU: Configure',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        const existing = await this.loadExisting();
        this.panel.webview.html = this.getHtml(existing);

        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'save') {
                await this.saveConfig(msg.config);
                vscode.window.showInformationMessage('FTPU: Configuration saved');
                this.panel?.dispose();
            } else if (msg.type === 'testConnection') {
                await this.testConnection(msg.config);
            } else if (msg.type === 'browseKey') {
                const result = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    defaultUri: vscode.Uri.file(path.join(require('os').homedir(), '.ssh')),
                    title: 'Select SSH Private Key',
                });
                if (result?.[0]) {
                    this.panel?.webview.postMessage({
                        type: 'keyPath',
                        path: result[0].fsPath,
                    });
                }
            } else if (msg.type === 'importSftp') {
                const config = await this.importSftpConfig();
                if (config) {
                    this.panel?.webview.postMessage({ type: 'importedConfig', config });
                } else {
                    vscode.window.showWarningMessage('FTPU: No .vscode/sftp.json found in this workspace');
                }
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = null;
        });
    }

    private async loadExisting(): Promise<Partial<FtpuConfig>> {
        const configPath = path.join(this.workspaceRoot, '.vscode', 'ftpu.json');
        try {
            const raw = await fs.promises.readFile(configPath, 'utf-8');
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    private async importSftpConfig(): Promise<Partial<FtpuConfig> | null> {
        // Look for sftp.json in common locations
        const candidates = [
            path.join(this.workspaceRoot, '.vscode', 'sftp.json'),
            path.join(this.workspaceRoot, 'sftp.json'),
            path.join(this.workspaceRoot, '.sftp.json'),
        ];

        for (const candidate of candidates) {
            try {
                const raw = await fs.promises.readFile(candidate, 'utf-8');
                const sftp = JSON.parse(raw);

                // Map SFTP fields to FTPU
                const config: Partial<FtpuConfig> = {};
                if (sftp.name) { config.name = sftp.name; }
                if (sftp.host) { config.host = sftp.host; }
                if (sftp.port) { config.port = sftp.port; }
                if (sftp.protocol) { config.protocol = sftp.protocol; }
                if (sftp.username) { config.username = sftp.username; }
                if (sftp.password) { config.password = sftp.password; }
                if (sftp.remotePath) { config.remotePath = sftp.remotePath; }
                if (sftp.privateKeyPath) { config.privateKeyPath = sftp.privateKeyPath; }
                if (sftp.passphrase) { config.passphrase = sftp.passphrase; }
                if (sftp.uploadOnSave !== undefined) { config.uploadOnSave = sftp.uploadOnSave; }
                if (sftp.ignore) { config.ignore = sftp.ignore; }

                return config;
            } catch {
                continue;
            }
        }

        return null;
    }

    private async saveConfig(config: Record<string, unknown>): Promise<void> {
        const cleaned: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(config)) {
            if (value !== '' && value !== undefined && value !== null) {
                cleaned[key] = value;
            }
        }

        if (!cleaned.protocol) { cleaned.protocol = DEFAULT_CONFIG.protocol; }
        if (!cleaned.port) { cleaned.port = DEFAULT_CONFIG.port; }
        if (cleaned.uploadOnSave === undefined) { cleaned.uploadOnSave = DEFAULT_CONFIG.uploadOnSave; }
        if (!cleaned.ignore) { cleaned.ignore = DEFAULT_CONFIG.ignore; }

        const configDir = path.join(this.workspaceRoot, '.vscode');
        await fs.promises.mkdir(configDir, { recursive: true });
        const configPath = path.join(configDir, 'ftpu.json');
        await fs.promises.writeFile(configPath, JSON.stringify(cleaned, null, 4) + '\n');
    }

    private async testConnection(config: Record<string, unknown>): Promise<void> {
        const { Client } = require('ssh2') as typeof import('ssh2');
        const os = require('os') as typeof import('os');

        const client = new Client();
        const timeout = setTimeout(() => {
            client.destroy();
            this.panel?.webview.postMessage({ type: 'testResult', success: false, message: 'Connection timed out (10s)' });
        }, 10_000);

        try {
            await new Promise<void>((resolve, reject) => {
                const connectConfig: Record<string, unknown> = {
                    host: config.host as string,
                    port: (config.port as number) || 22,
                    username: config.username as string,
                    readyTimeout: 10_000,
                };

                const keyPath = config.privateKeyPath as string;
                if (keyPath) {
                    const resolved = keyPath.replace(/^~/, os.homedir());
                    try {
                        connectConfig.privateKey = fs.readFileSync(path.resolve(resolved));
                    } catch (err) {
                        reject(new Error(`Cannot read key: ${(err as Error).message}`));
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

                client.once('ready', () => resolve());
                client.once('error', (err: Error) => reject(err));
                client.connect(connectConfig);
            });

            clearTimeout(timeout);
            client.end();
            this.panel?.webview.postMessage({ type: 'testResult', success: true, message: 'Connection successful!' });
        } catch (err) {
            clearTimeout(timeout);
            client.destroy();
            this.panel?.webview.postMessage({ type: 'testResult', success: false, message: (err as Error).message });
        }
    }

    private getHtml(existing: Partial<FtpuConfig>): string {
        const v = (key: keyof FtpuConfig, fallback = '') => {
            const val = existing[key];
            if (val === undefined || val === null) { return fallback; }
            if (typeof val === 'boolean') { return val ? 'true' : 'false'; }
            if (Array.isArray(val)) { return val.join(', '); }
            return String(val);
        };

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family, system-ui, sans-serif);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px 0;
    }
    .container {
        max-width: 520px;
        margin: 0 auto;
        padding: 0 20px;
    }

    /* Header */
    .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(255,255,255,0.1)));
    }
    .header-left h1 {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 2px;
    }
    .header-left .subtitle {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    .import-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
        white-space: nowrap;
    }
    .import-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
    }

    /* Sections */
    .section {
        margin-bottom: 20px;
    }
    .section-title {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 12px;
        font-weight: 600;
    }

    /* Fields */
    .field {
        margin-bottom: 14px;
    }
    label {
        display: block;
        margin-bottom: 4px;
        font-size: 12px;
        color: var(--vscode-foreground);
    }
    input, select, textarea {
        width: 100%;
        padding: 5px 8px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
        font-family: inherit;
        font-size: 13px;
        outline: none;
        line-height: 20px;
    }
    input:focus, select:focus, textarea:focus {
        border-color: var(--vscode-focusBorder);
    }
    input::placeholder, textarea::placeholder {
        color: var(--vscode-input-placeholderForeground);
    }
    textarea { resize: vertical; min-height: 64px; }
    select { cursor: pointer; }

    /* Layout helpers */
    .row {
        display: flex;
        gap: 10px;
    }
    .row > .field { flex: 1; }
    .row > .field.small { flex: 0 0 90px; }
    .key-row {
        display: flex;
        gap: 6px;
    }
    .key-row input { flex: 1; }
    .key-row button {
        flex-shrink: 0;
        padding: 5px 10px;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none;
        border-radius: 2px;
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
    }

    /* Auth tabs */
    .auth-tabs {
        display: flex;
        gap: 0;
        margin-bottom: 14px;
        background: var(--vscode-input-background);
        border-radius: 2px;
        padding: 2px;
    }
    .auth-tab {
        flex: 1;
        padding: 5px 10px;
        text-align: center;
        cursor: pointer;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        border: none;
        font-size: 12px;
        font-family: inherit;
        border-radius: 2px;
        transition: background 0.1s, color 0.1s;
    }
    .auth-tab:hover {
        color: var(--vscode-foreground);
    }
    .auth-tab.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .auth-panel { display: none; }
    .auth-panel.active { display: block; }

    /* Toggle */
    .toggle-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .toggle-row input[type="checkbox"] {
        width: auto;
        accent-color: var(--vscode-button-background);
    }
    .toggle-row label { margin: 0; }

    /* Hint text */
    .hint {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-top: 4px;
    }

    /* Actions */
    .actions {
        display: flex;
        gap: 8px;
        margin-top: 24px;
        padding-top: 16px;
        border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(255,255,255,0.1)));
    }
    .btn {
        padding: 6px 16px;
        border: none;
        border-radius: 2px;
        cursor: pointer;
        font-size: 13px;
        font-family: inherit;
    }
    .btn-primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
    }

    /* Test result */
    .test-result {
        margin-top: 12px;
        padding: 8px 10px;
        border-radius: 2px;
        font-size: 12px;
        display: none;
    }
    .test-result.success {
        display: block;
        background: var(--vscode-inputValidation-infoBackground, rgba(78,201,176,0.1));
        border: 1px solid var(--vscode-inputValidation-infoBorder, #4ec9b0);
        color: var(--vscode-foreground);
    }
    .test-result.error {
        display: block;
        background: var(--vscode-inputValidation-errorBackground, rgba(244,71,71,0.1));
        border: 1px solid var(--vscode-inputValidation-errorBorder, #f44747);
        color: var(--vscode-foreground);
    }
    .test-result.pending {
        display: block;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        color: var(--vscode-descriptionForeground);
    }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <div class="header-left">
            <h1>FTPU Configuration</h1>
            <span class="subtitle">Saved to .vscode/ftpu.json</span>
        </div>
        <button class="import-btn" onclick="importSftp()">Import from SFTP</button>
    </div>

    <div class="section">
        <div class="section-title">Server</div>
        <div class="field">
            <label for="name">Connection Name</label>
            <input type="text" id="name" placeholder="My Server" value="${v('name')}">
        </div>
        <div class="row">
            <div class="field">
                <label for="host">Host</label>
                <input type="text" id="host" placeholder="server.example.com" value="${v('host')}">
            </div>
            <div class="field small">
                <label for="port">Port</label>
                <input type="number" id="port" placeholder="22" value="${v('port', '22')}">
            </div>
        </div>
        <div class="field">
            <label for="protocol">Protocol</label>
            <select id="protocol">
                <option value="sftp" ${v('protocol', 'sftp') === 'sftp' ? 'selected' : ''}>SFTP</option>
                <option value="ftp" ${v('protocol') === 'ftp' ? 'selected' : ''}>FTP</option>
                <option value="ftps" ${v('protocol') === 'ftps' ? 'selected' : ''}>FTPS</option>
            </select>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Authentication</div>
        <div class="field">
            <label for="username">Username</label>
            <input type="text" id="username" placeholder="deploy" value="${v('username')}">
        </div>
        <div class="auth-tabs">
            <button class="auth-tab ${v('privateKeyPath') || !v('password') ? 'active' : ''}" data-tab="key">SSH Key</button>
            <button class="auth-tab ${!v('privateKeyPath') && v('password') ? 'active' : ''}" data-tab="password">Password</button>
            <button class="auth-tab" data-tab="agent">SSH Agent</button>
        </div>
        <div class="auth-panel ${v('privateKeyPath') || !v('password') ? 'active' : ''}" data-panel="key">
            <div class="field">
                <label for="privateKeyPath">Private Key Path</label>
                <div class="key-row">
                    <input type="text" id="privateKeyPath" placeholder="~/.ssh/id_ed25519" value="${v('privateKeyPath')}">
                    <button onclick="browseKey()">Browse</button>
                </div>
            </div>
            <div class="field">
                <label for="passphrase">Passphrase <span class="hint" style="display:inline">(optional)</span></label>
                <input type="password" id="passphrase" placeholder="Key passphrase" value="${v('passphrase')}">
            </div>
        </div>
        <div class="auth-panel ${!v('privateKeyPath') && v('password') ? 'active' : ''}" data-panel="password">
            <div class="field">
                <label for="password">Password</label>
                <input type="password" id="password" placeholder="Server password" value="${v('password')}">
                <div class="hint">Stored in plain text in .vscode/ftpu.json — prefer SSH keys for production</div>
            </div>
        </div>
        <div class="auth-panel" data-panel="agent">
            <div class="hint" style="padding: 8px 0;">Uses your system SSH agent (SSH_AUTH_SOCK). No additional configuration needed.</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Paths</div>
        <div class="field">
            <label for="remotePath">Remote Path</label>
            <input type="text" id="remotePath" placeholder="/var/www/myproject" value="${v('remotePath')}">
        </div>
    </div>

    <div class="section">
        <div class="section-title">Options</div>
        <div class="field toggle-row">
            <input type="checkbox" id="uploadOnSave" ${v('uploadOnSave') === 'true' ? 'checked' : ''}>
            <label for="uploadOnSave">Upload on Save</label>
        </div>
        <div class="field" style="margin-top: 14px;">
            <label for="ignore">Ignore Patterns</label>
            <textarea id="ignore" placeholder=".git, node_modules, .env">${v('ignore', '.git, .vscode, node_modules, .env, .DS_Store')}</textarea>
            <div class="hint">Comma-separated glob patterns</div>
        </div>
    </div>

    <div id="testResult" class="test-result"></div>

    <div class="actions">
        <button class="btn btn-primary" onclick="save()">Save</button>
        <button class="btn btn-secondary" onclick="testConn()">Test Connection</button>
    </div>
</div>

<script>
    const vscode = acquireVsCodeApi();

    // Auth tabs
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.querySelector('[data-panel="' + tab.dataset.tab + '"]').classList.add('active');
        });
    });

    function getConfig() {
        const activeTab = document.querySelector('.auth-tab.active').dataset.tab;
        const config = {
            name: document.getElementById('name').value,
            protocol: document.getElementById('protocol').value,
            host: document.getElementById('host').value,
            port: parseInt(document.getElementById('port').value) || 22,
            username: document.getElementById('username').value,
            remotePath: document.getElementById('remotePath').value,
            uploadOnSave: document.getElementById('uploadOnSave').checked,
            ignore: document.getElementById('ignore').value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean),
        };
        if (activeTab === 'key') {
            config.privateKeyPath = document.getElementById('privateKeyPath').value;
            const pp = document.getElementById('passphrase').value;
            if (pp) config.passphrase = pp;
        } else if (activeTab === 'password') {
            config.password = document.getElementById('password').value;
        }
        return config;
    }

    function populateForm(config) {
        if (config.name) document.getElementById('name').value = config.name;
        if (config.host) document.getElementById('host').value = config.host;
        if (config.port) document.getElementById('port').value = config.port;
        if (config.protocol) document.getElementById('protocol').value = config.protocol;
        if (config.username) document.getElementById('username').value = config.username;
        if (config.remotePath) document.getElementById('remotePath').value = config.remotePath;
        if (config.uploadOnSave) document.getElementById('uploadOnSave').checked = config.uploadOnSave;
        if (config.ignore) {
            const patterns = Array.isArray(config.ignore) ? config.ignore.join(', ') : config.ignore;
            document.getElementById('ignore').value = patterns;
        }

        // Set auth tab
        if (config.privateKeyPath) {
            document.getElementById('privateKeyPath').value = config.privateKeyPath;
            if (config.passphrase) document.getElementById('passphrase').value = config.passphrase;
            switchAuthTab('key');
        } else if (config.password) {
            document.getElementById('password').value = config.password;
            switchAuthTab('password');
        }
    }

    function switchAuthTab(tabName) {
        document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
        document.querySelector('[data-tab="' + tabName + '"]').classList.add('active');
        document.querySelector('[data-panel="' + tabName + '"]').classList.add('active');
    }

    function save() {
        const config = getConfig();
        if (!config.host || !config.username || !config.remotePath) {
            showResult(false, 'Host, username, and remote path are required');
            return;
        }
        vscode.postMessage({ type: 'save', config });
    }

    function testConn() {
        const config = getConfig();
        if (!config.host || !config.username) {
            showResult(false, 'Host and username are required');
            return;
        }
        showResult(null, 'Connecting...');
        vscode.postMessage({ type: 'testConnection', config });
    }

    function browseKey() {
        vscode.postMessage({ type: 'browseKey' });
    }

    function importSftp() {
        vscode.postMessage({ type: 'importSftp' });
    }

    function showResult(success, message) {
        const el = document.getElementById('testResult');
        el.textContent = message;
        if (success === null) {
            el.className = 'test-result pending';
        } else {
            el.className = 'test-result ' + (success ? 'success' : 'error');
        }
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'testResult') {
            showResult(msg.success, msg.message);
        } else if (msg.type === 'keyPath') {
            document.getElementById('privateKeyPath').value = msg.path;
        } else if (msg.type === 'importedConfig') {
            populateForm(msg.config);
            showResult(true, 'Imported from sftp.json — review and save');
        }
    });
</script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
