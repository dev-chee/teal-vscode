import * as path from 'node:path';
import * as vscode from 'vscode';

/** 让宿主用例与激活入口回归共用同一份工具链测试上下文。 */
export function toolchainTestContext(root: string, subscriptions: vscode.Disposable[]): vscode.ExtensionContext {
    const context: Pick<vscode.ExtensionContext, 'globalStorageUri' | 'extensionUri' | 'subscriptions'> = {
        globalStorageUri: vscode.Uri.file(path.join(root, 'storage')),
        extensionUri: vscode.Uri.file(root),
        subscriptions,
    };
    return context as vscode.ExtensionContext;
}
