import * as vscode from 'vscode';
import { isSupported, requireExecution, setManagedToolchainDirectory, setToolchainPreparation } from './environment';
import { DebugAdapter, DebugConfigurations, debugFile, runFile } from './execution';
import { LanguageClients } from './languageClient';
import { disposeLanguageServerExecutables } from './languageServerExecutable';
import { currentManagedToolchainTarget, installManagedToolchain, loadManagedToolchain, updateManagedToolchain } from './managedToolchain';
import { Reporter } from './reporting';
import { isCompleteToolchain, resolveToolchain } from './toolchain';
import { ToolchainUpdates } from './toolchainUpdates';

let clients: LanguageClients | undefined;
let updates: ToolchainUpdates | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    let selectedDirectory = await loadManagedToolchain(context);
    setManagedToolchainDirectory(selectedDirectory);
    const output = vscode.window.createOutputChannel('Teal');
    const reporter = new Reporter(output);
    clients = new LanguageClients(reporter);
    const managed = clients;
    const updater = new ToolchainUpdates({
        settings: async () => {
            const config = vscode.workspace.getConfiguration('teal');
            const configured = config.get<string>('toolchain.path', '').trim();
            const fromPath = configured ? undefined : await resolveToolchain('').catch(() => undefined);
            return { trusted: vscode.workspace.isTrusted, supported: isSupported() && !!currentManagedToolchainTarget(),
                autoUpdate: config.get<boolean>('toolchain.autoUpdate', true), release: config.get<string>('toolchain.release', 'latest').trim() || 'latest',
                local: !!configured || isCompleteToolchain(fromPath) };
        },
        install: async (release, options) => {
            const target = currentManagedToolchainTarget();
            if (!target) return undefined;
            return (await updateManagedToolchain(context, release, target, options))?.directory;
        },
        apply: async directory => {
            if (selectedDirectory === directory) return;
            const restarting = selectedDirectory !== undefined;
            setManagedToolchainDirectory(directory);
            output.appendLine(`[Toolchain] Selected ${directory}`);
            await managed.refresh(restarting);
            selectedDirectory = directory;
        },
        log: error => output.appendLine(`[Toolchain update] ${String(error)}`),
    });
    updates = updater;
    setToolchainPreparation(() => updater.ready());
    const configuration = new DebugConfigurations();
    context.subscriptions.push(
        output,
        vscode.workspace.onDidGrantWorkspaceTrust(() => { void updater.configurationChanged(); }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('teal.toolchain')) void updater.configurationChanged();
        }),
        vscode.commands.registerCommand('teal.checkToolchainUpdates', () => reporter.guard(async () => {
            requireExecution();
            await updater.check(true);
            void vscode.window.showInformationMessage('Teal toolchain update check completed. Explicit paths and complete PATH toolchains keep priority.');
        })),
        vscode.commands.registerCommand('teal.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:dev-chee.teal-vscode')),
        vscode.commands.registerCommand('teal.installToolchain', () => reporter.guard(async () => {
            requireExecution();
            const target = currentManagedToolchainTarget();
            if (!target) throw new Error('No managed Teal toolchain matches this host architecture and ABI. Configure teal.toolchain.path manually.');
            const configured = vscode.workspace.getConfiguration('teal').get<string>('toolchain.path', '').trim();
            if (configured) {
                const choice = await vscode.window.showWarningMessage('teal.toolchain.path is configured and takes priority. Install a managed toolchain anyway?', 'Install anyway');
                if (choice !== 'Install anyway') return;
            }
            const release = vscode.workspace.getConfiguration('teal').get<string>('toolchain.release', 'latest');
            const installed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing Teal toolchain' }, async (progress) =>
                installManagedToolchain(context, release, target, (message) => progress.report({ message }), { canCommit: async () =>
                    vscode.workspace.isTrusted && vscode.workspace.getConfiguration('teal').get<string>('toolchain.release', 'latest') === release }));
            selectedDirectory = installed.directory;
            setManagedToolchainDirectory(installed.directory);
            await managed.refresh(true);
            void vscode.window.showInformationMessage(`Teal toolchain ${installed.release} installed for ${installed.target}.`);
        })),
        vscode.commands.registerCommand('teal.showOutput', () => output.show(true)),
        vscode.commands.registerCommand('teal.restartServer', () => reporter.guard(async () => {
            requireExecution();
            reporter.reset();
            await managed.refresh(true);
        })),
        vscode.commands.registerCommand('teal.runFile', (uri?: vscode.Uri) => reporter.guard(() => runFile(uri))),
        vscode.commands.registerCommand('teal.debugFile', (uri?: vscode.Uri) => reporter.guard(() => debugFile(uri))),
        vscode.debug.registerDebugConfigurationProvider('teal', {
            provideDebugConfigurations: () => configuration.provideDebugConfigurations(),
            resolveDebugConfiguration: (folder, config) => reporter.guard(async () => configuration.resolveDebugConfiguration(folder, config)),
            resolveDebugConfigurationWithSubstitutedVariables: (folder, config) => reporter.guard(() => configuration.resolveDebugConfigurationWithSubstitutedVariables(folder, config)),
        }),
        vscode.debug.registerDebugAdapterDescriptorFactory('teal', new DebugAdapter(reporter)),
    );
    await vscode.commands.executeCommand('setContext', 'teal.supported', isSupported());
    if (!isSupported()) output.appendLine('Teal tool execution requires a supported Windows, Linux or macOS Node.js workspace extension host.');
    updater.start();
    await managed.refresh();
}

export async function deactivate(): Promise<void> {
    await updates?.dispose();
    updates = undefined;
    setToolchainPreparation(undefined);
    await clients?.dispose();
    clients = undefined;
    await disposeLanguageServerExecutables();
}
