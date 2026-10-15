import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { isIP } from 'node:net';
import { stringArray } from './configuration';
import { saveProgram, type SourceDocument } from './documents';

export const runtimeTiers = ['embedded', 'hosted', 'agentic'] as const;

/** 在读取程序或启动适配器前拒绝已移除的协议字段，避免旧授权被静默忽略。 */
export function validateLaunchOptions(config: Record<string, unknown>): void {
    if ('runtimeProfile' in config) throw new Error('Teal runtimeProfile was removed; use tier (embedded, hosted, agentic).');
    for (const field of [
        'allowCapabilities', 'allowReadFiles', 'allowReadDirectories', 'allowWriteFiles',
        'allowWriteDirectories', 'allowExecutables', 'allowEnvironment', 'allowModules',
    ]) {
        if (field in config) throw new Error(`Teal ${field} was removed; use permissionFile.`);
    }
    for (const field of ['entry', 'entryPoints', 'features', 'extensions', 'env']) {
        if (field in config) throw new Error(`Teal launch does not support ${field}.`);
    }
    if ('tier' in config && !runtimeTiers.some((tier) => tier === config.tier)) {
        throw new Error('Teal tier must be embedded, hosted, or agentic.');
    }
    if ('permissionFile' in config && (typeof config.permissionFile !== 'string' || !config.permissionFile.trim())) {
        throw new Error('Teal permissionFile must be a nonempty file path.');
    }
    for (const field of ['compilerDebug', 'stopOnEntry']) {
        if (config[field] !== undefined && typeof config[field] !== 'boolean') throw new Error(`Teal ${field} must be a boolean.`);
    }
    for (const field of ['args', 'allow', 'warn', 'deny', 'forbid']) {
        if (config[field] !== undefined) stringArray(config[field], `Teal ${field}`);
    }
}

/** 相对权限文件按调试工作目录解析；TOML 内容和权限规则由工具链校验。 */
export async function resolvePermissionFile(value: string, cwd: string): Promise<string> {
    const file = path.resolve(cwd, value);
    if (!await stat(file).then((info) => info.isFile(), () => false)) {
        throw new Error(`Teal permissionFile must be an existing local file: ${file}`);
    }
    return file;
}

export interface DebugConfiguration {
    type: string;
    name: string;
    request: string;
    [key: string]: unknown;
}

export interface DebugContext {
    baseDirectory: string;
    workspaceDirectory?: string;
    documents: readonly SourceDocument[];
}

export interface LaunchConfiguration extends DebugConfiguration {
    request: 'launch';
    program: string;
    cwd: string;
    console: 'integratedTerminal' | 'externalTerminal';
}

export interface AttachConfiguration extends DebugConfiguration {
    request: 'attach';
    host: string;
    port: number;
    token: string;
}

/** 完整校验后才保存源码；返回新配置，失败不会留下半解析的输入。 */
export async function prepareDebugConfiguration(
    config: DebugConfiguration, context: DebugContext,
): Promise<LaunchConfiguration | AttachConfiguration> {
    if (config.noDebug) throw new Error('Use Teal: Run Current File to run without debugging.');
    if (config.request === 'attach') {
        const host = config.host ?? '127.0.0.1';
        if (typeof host !== 'string') throw new Error('Teal attach host must be an IP address.');
        const plain = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
        if (!isIP(plain)) throw new Error('Teal attach host must be an IP address.');
        const port = config.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Teal attach port must be between 1 and 65535.');
        const token = config.token;
        if (typeof token !== 'string' || !token) throw new Error('Teal attach requires a nonempty token.');
        return { ...config, request: 'attach', host: isIP(plain) === 6 ? `[${plain}]` : plain, port, token };
    }
    if (config.request !== 'launch') throw new Error('Teal supports launch and attach debug requests.');
    validateLaunchOptions(config);
    if (typeof config.program !== 'string' || !config.program) throw new Error('Teal launch requires program.');
    const program = path.resolve(context.baseDirectory, config.program);
    if (path.extname(program).toLowerCase() !== '.tl' || !(await stat(program)).isFile()) throw new Error('Teal launch program must be a local .tl file.');
    if (config.cwd !== undefined && typeof config.cwd !== 'string') throw new Error('Teal launch cwd must be a directory path.');
    const cwd = config.cwd === undefined ? (context.workspaceDirectory ?? path.dirname(program)) : path.resolve(context.baseDirectory, config.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Teal launch cwd must be a directory.');
    const console = config.console ?? 'integratedTerminal';
    if (console !== 'integratedTerminal' && console !== 'externalTerminal') throw new Error('Teal console must be integratedTerminal or externalTerminal.');
    const result: LaunchConfiguration = { ...config, request: 'launch', program, cwd, console };
    if (typeof config.permissionFile === 'string') result.permissionFile = await resolvePermissionFile(config.permissionFile, cwd);
    for (const field of ['args', 'allow', 'warn', 'deny', 'forbid']) {
        if (config[field] !== undefined) result[field] = stringArray(config[field], `Teal ${field}`);
    }
    await saveProgram(program, context.documents);
    return result;
}
