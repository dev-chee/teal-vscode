import * as vscode from 'vscode';
import { isSupported, requireExecution, setManagedToolchainDirectory } from './environment';
import { DebugAdapter, DebugConfigurations, debugFile, runFile } from './execution';
import { LanguageClients } from './languageClient';
import { currentManagedToolchainTarget, installManagedToolchain, loadManagedToolchain } from './managedToolchain';
import { Reporter } from './reporting';

let clients: LanguageClients | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    setManagedToolchainDirectory(await loadManagedToolchain(context));
    const output = vscode.window.createOutputChannel('Teal');
    const reporter = new Reporter(output);
    clients = new LanguageClients(reporter);
    const managed = clients;
    const configuration = new DebugConfigurations();
    context.subscriptions.push(
        output,
        vscode.commands.registerCommand('teal.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:dev-chee.teal-vscode')),
        vscode.commands.registerCommand('teal.installToolchain', () => reporter.guard(async () => {
            requireExecution();
            const target = currentManagedToolchainTarget();
            if (!target) throw new Error('Managed Teal toolchain installation is only available in supported desktop Windows or WSL Linux hosts.');
            const configured = vscode.workspace.getConfiguration('teal').get<string>('toolchain.path', '').trim();
            if (configured) {
                const choice = await vscode.window.showWarningMessage('teal.toolchain.path is configured and takes priority. Install a managed toolchain anyway?', 'Install anyway');
                if (choice !== 'Install anyway') return;
            }
            const release = vscode.workspace.getConfiguration('teal').get<string>('toolchain.release', 'latest');
            const installed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing Teal toolchain' }, async (progress) =>
                installManagedToolchain(context, release, target, (message) => progress.report({ message })));
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
    if (!isSupported()) output.appendLine('Teal tool execution requires a local Windows x64 or WSL Linux x64 workspace extension host.');
    await managed.refresh();
}

export async function deactivate(): Promise<void> {
    await clients?.dispose();
    clients = undefined;
}
