import * as path from 'node:path';
import { currentToolchainTarget } from './hostPlatform';
import { readToolchainIdentity, verifyToolchainDistribution } from './toolchainDistributionCore.cjs';

export interface BundledToolchain {
    directory: string;
    release: string;
}

/**
 * 返回 target VSIX 中随扩展安装的工具链目录。包内内容仍要按 manifest 校验，
 * 所以损坏或通用 VSIX 不会被当作可执行工具链。
 */
export async function resolveBundledToolchain(extensionPath: string, target = currentToolchainTarget()): Promise<BundledToolchain | undefined> {
    if (!target) return undefined;
    try {
        const directory = await verifyToolchainDistribution(path.join(extensionPath, 'dist', 'toolchain'), target);
        const identity = await readToolchainIdentity(directory, target);
        return { directory, release: identity.release };
    } catch {
        return undefined;
    }
}
