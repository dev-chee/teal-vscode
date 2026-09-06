import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import * as vscode from 'vscode';
import { executable, Reporter, requireExecution, stringArray } from './environment';

async function sourceFile(uri?: vscode.Uri): Promise<vscode.TextDocument> {
    requireExecution();
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== 'teal' || document.uri.scheme !== 'file') {
        throw new Error('Open and save a local Teal file before running or debugging.');
    }
    if (!await document.save()) throw new Error('The Teal file could not be saved.');
    return document;
}

export async function runFile(uri?: vscode.Uri): Promise<vscode.TaskExecution> {
    const document = await sourceFile(uri);
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cwd = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const command = await executable('teal', document.uri);
    const config = vscode.workspace.getConfiguration('teal', document.uri);
    const options = stringArray(config.get('run.options', []), 'teal.run.options');
    const args = stringArray(config.get('run.args', []), 'teal.run.args');
    if (options.includes('--')) throw new Error('Use teal.run.args for program arguments; teal.run.options must not contain --.');
    const task = new vscode.Task(
        { type: 'teal', program: document.uri.fsPath }, folder ?? vscode.TaskScope.Global,
        `Run ${path.basename(document.uri.fsPath)}`, 'Teal',
        new vscode.ProcessExecution(command, ['run', ...options, document.uri.fsPath, '--', ...args], { cwd }), [],
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: true, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    return vscode.tasks.executeTask(task);
}

export async function debugFile(uri?: vscode.Uri): Promise<boolean> {
    const document = await sourceFile(uri);
    return vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(document.uri), {
        type: 'teal', name: 'Teal: Current File', request: 'launch',
        program: document.uri.fsPath, console: 'integratedTerminal',
    });
}

const arrayFields = [
    'args', 'allowCapabilities', 'allowReadFiles', 'allowReadDirectories',
    'allowWriteFiles', 'allowWriteDirectories', 'allowExecutables', 'allowEnvironment',
    'allow', 'warn', 'deny', 'forbid',
];
const pathFields = ['allowReadFiles', 'allowReadDirectories', 'allowWriteFiles', 'allowWriteDirectories', 'allowExecutables'];

export class DebugConfigurations implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [{ type: 'teal', request: 'launch', name: 'Teal: Current File', program: '${file}', console: 'integratedTerminal' }];
    }

    resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration {
        requireExecution();
        if (!config.type && !config.request && !config.name) {
            config = this.provideDebugConfigurations()[0];
        }
        if (config.request === 'launch') {
            config.program ??= '${file}';
            config.console ??= 'integratedTerminal';
        }
        return config;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration> {
        requireExecution();
        if (config.noDebug) throw new Error('Use Teal: Run Current File to run without debugging.');
        if (config.request === 'attach') {
            const host: unknown = config.host ?? '127.0.0.1';
            if (typeof host !== 'string' || !isIP(host.replace(/^\[|\]$/g, ''))) throw new Error('Teal attach host must be an IP address.');
            const plain = host.replace(/^\[|\]$/g, '');
            config.host = isIP(plain) === 6 ? `[${plain}]` : plain;
            if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Teal attach port must be between 1 and 65535.');
            if (typeof config.token !== 'string' || !config.token) throw new Error('Teal attach requires a nonempty token.');
            return config;
        }
        if (config.request !== 'launch') throw new Error('Teal supports launch and attach debug requests.');
        for (const field of ['entry', 'entryPoints', 'features', 'extensions', 'allowModules', 'env']) {
            if (field in config) throw new Error(`Teal launch does not support ${field}.`);
        }
        if (typeof config.program !== 'string' || !config.program) throw new Error('Teal launch requires program.');
        const base = folder?.uri.fsPath ?? path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '');
        config.program = path.resolve(base, config.program);
        if (path.extname(config.program).toLowerCase() !== '.tl' || !(await stat(config.program)).isFile()) {
            throw new Error('Teal launch program must be a local .tl file.');
        }
        const document = vscode.workspace.textDocuments.find((item) => item.uri.fsPath.toLowerCase() === config.program.toLowerCase());
        if (document?.isDirty && !await document.save()) throw new Error('The Teal program could not be saved.');
        if (config.cwd !== undefined && typeof config.cwd !== 'string') throw new Error('Teal launch cwd must be a directory path.');
        config.cwd = config.cwd === undefined ? (folder?.uri.fsPath ?? path.dirname(config.program)) : path.resolve(base, config.cwd);
        if (!(await stat(config.cwd)).isDirectory()) throw new Error('Teal launch cwd must be a directory.');
        if (!['integratedTerminal', 'externalTerminal'].includes(config.console)) throw new Error('Teal console must be integratedTerminal or externalTerminal.');
        if (config.runtimeProfile !== undefined && !['core', 'native', 'web'].includes(config.runtimeProfile)) throw new Error('Unknown Teal runtimeProfile.');
        for (const field of ['compilerDebug', 'stopOnEntry']) {
            if (config[field] !== undefined && typeof config[field] !== 'boolean') throw new Error(`Teal ${field} must be a boolean.`);
        }
        for (const field of arrayFields) {
            if (config[field] !== undefined) config[field] = stringArray(config[field], `Teal ${field}`);
        }
        for (const field of pathFields) {
            if (config[field] !== undefined) config[field] = (config[field] as string[]).map((value) => path.resolve(config.cwd, value));
        }
        return config;
    }
}

export class DebugAdapter implements vscode.DebugAdapterDescriptorFactory {
    constructor(private readonly reporter: Reporter) {}

    async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor | undefined> {
        try {
            const resource = session.workspaceFolder?.uri
                ?? (session.configuration.request === 'launch' ? vscode.Uri.file(session.configuration.program) : undefined);
            const command = await executable('teal-dap', resource);
            return new vscode.DebugAdapterExecutable(command, [], { cwd: session.configuration.cwd ?? session.workspaceFolder?.uri.fsPath ?? path.dirname(command) });
        } catch (error) {
            this.reporter.report(error);
            return undefined;
        }
    }
}
