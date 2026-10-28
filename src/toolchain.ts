import { access, stat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { executableName } from './platform';
import * as path from 'node:path';

/** 当前发行版只有一个 `teal` 产品；LSP、DAP 等能力通过其子命令启动。 */
export const toolNames = ['teal'] as const;
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
            } catch { /* 缺少 teal 时此目录不是可用工具链。 */ }
        }));
        return { directory: canonical, tools };
    } catch {
        return undefined;
    }
}

export function isCompleteToolchain(toolchain: Toolchain | undefined): toolchain is Toolchain {
    return toolchain !== undefined && toolNames.every((name) => toolchain.tools[name] !== undefined);
}

/** 显式目录优先；PATH 中选择一个包含 `teal` 的目录，不跨目录拼接。 */
export async function resolveToolchain(configuredPath: string, searchPath = process.env.PATH ?? ''): Promise<Toolchain> {
    if (configuredPath.trim()) {
        if (!path.isAbsolute(configuredPath)) throw new Error('teal.toolchain.path must be an absolute directory.');
        const result = await inspectToolchain(configuredPath);
        if (!result) throw new Error(`Toolchain directory does not exist or cannot be read: ${configuredPath}`);
        if (!isCompleteToolchain(result)) throw new Error(`Toolchain directory does not contain the teal executable: ${configuredPath}`);
        return result;
    }
    for (const value of searchPath.split(path.delimiter)) {
        const directory = value.trim().replace(/^"(.*)"$/, '$1');
        // 空或相对 PATH 项会依赖工作目录，不用于自动启动进程。
        if (!path.isAbsolute(directory)) continue;
        const candidate = await inspectToolchain(directory);
        if (!candidate) continue;
        if (isCompleteToolchain(candidate)) return candidate;
    }
    throw new Error('No Teal toolchain found. Set teal.toolchain.path to a directory containing the teal executable.');
}

/** Resolve explicit configuration first, then PATH, then verified fallback directories in order. */
export async function resolveToolchainWithFallbacks(
    configuredPath: string,
    fallbackPaths: readonly (string | undefined)[],
    searchPath = process.env.PATH ?? '',
): Promise<Toolchain> {
    if (configuredPath.trim()) return resolveToolchain(configuredPath, searchPath);

    let pathToolchain: Toolchain | undefined;
    try { pathToolchain = await resolveToolchain('', searchPath); } catch { /* try managed installation below */ }
    if (isCompleteToolchain(pathToolchain)) return pathToolchain;

    for (const directory of fallbackPaths) {
        if (!directory) continue;
        try {
            const fallback = await resolveToolchain(directory, '');
            if (isCompleteToolchain(fallback)) return fallback;
        } catch { /* Try the next verified fallback directory. */ }
    }
    throw new Error('No Teal toolchain found. Run Teal: Install Toolchain or set teal.toolchain.path to a directory containing the teal executable.');
}

/** 保留托管工具链调用面；新的回退来源由 resolveToolchainWithFallbacks 按顺序处理。 */
export async function resolveToolchainWithManaged(configuredPath: string, managedPath?: string, searchPath = process.env.PATH ?? ''): Promise<Toolchain> {
    return resolveToolchainWithFallbacks(configuredPath, [managedPath], searchPath);
}
