import { access, stat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { executableName } from './platform';
import * as path from 'node:path';

export const toolNames = ['teal', 'teal-lsp', 'teal-dap'] as const;
export type ToolName = typeof toolNames[number];
export interface Toolchain {
    directory: string;
    tools: Partial<Record<ToolName, string>>;
}

export async function inspectToolchain(directory: string): Promise<Toolchain | undefined> {
    try {
        if (!(await stat(directory)).isDirectory()) return undefined;
        const canonical = await realpath(directory);
        const tools: Toolchain['tools'] = {};
        await Promise.all(toolNames.map(async (name) => {
            const executable = path.join(canonical, executableName(name));
            try {
                if (!(await stat(executable)).isFile()) return;
                if (process.platform !== 'win32') await access(executable, constants.X_OK);
                tools[name] = executable;
            } catch { /* 缺少某个工具不影响同目录其他功能。 */ }
        }));
        return { directory: canonical, tools };
    } catch {
        return undefined;
    }
}

export function isCompleteToolchain(toolchain: Toolchain | undefined): toolchain is Toolchain {
    return toolchain !== undefined && toolNames.every((name) => toolchain.tools[name] !== undefined);
}

/** 显式目录优先；PATH 中选一个目录，始终不跨目录拼接工具。 */
export async function resolveToolchain(configuredPath: string, searchPath = process.env.PATH ?? ''): Promise<Toolchain> {
    if (configuredPath.trim()) {
        if (!path.isAbsolute(configuredPath)) throw new Error('teal.toolchain.path must be an absolute directory.');
        const result = await inspectToolchain(configuredPath);
        if (!result) throw new Error(`Toolchain directory does not exist or cannot be read: ${configuredPath}`);
        return result;
    }
    let partial: Toolchain | undefined;
    for (const value of searchPath.split(path.delimiter)) {
        const directory = value.trim().replace(/^"(.*)"$/, '$1');
        // 空或相对 PATH 项会依赖工作目录，不用于自动启动进程。
        if (!path.isAbsolute(directory)) continue;
        const candidate = await inspectToolchain(directory);
        if (!candidate) continue;
        const count = Object.keys(candidate.tools).length;
        if (count === toolNames.length) return candidate;
        if (count && !partial) partial = candidate;
    }
    if (partial) return partial;
    throw new Error('No Teal toolchain found. Set teal.toolchain.path to a directory containing the Teal executables.');
}

/** Resolve explicit configuration first, then PATH, then the managed installation. */
export async function resolveToolchainWithManaged(configuredPath: string, managedPath?: string, searchPath = process.env.PATH ?? ''): Promise<Toolchain> {
    if (configuredPath.trim()) return resolveToolchain(configuredPath, searchPath);

    let pathToolchain: Toolchain | undefined;
    try { pathToolchain = await resolveToolchain('', searchPath); } catch { /* try managed installation below */ }
    if (isCompleteToolchain(pathToolchain)) return pathToolchain;

    if (managedPath) {
        try {
            const managed = await resolveToolchain(managedPath, '');
            if (isCompleteToolchain(managed)) return managed;
        } catch { /* retain the existing PATH error below */ }
    }
    if (pathToolchain) return pathToolchain;
    throw new Error('No Teal toolchain found. Run Teal: Install Toolchain or set teal.toolchain.path to a directory containing the Teal executables.');
}
