import * as path from 'node:path';
import distribution from './toolchain-targets.json';

export type ManagedToolchainTarget = keyof typeof distribution.targets;
export const toolchainTargets = Object.keys(distribution.targets) as ManagedToolchainTarget[];
export type LinuxLibc = 'glibc' | 'musl' | 'unknown';

export function isToolchainTarget(value: unknown): value is ManagedToolchainTarget {
    return typeof value === 'string' && Object.hasOwn(distribution.targets, value);
}

/** 此模块在工作区的 Node.js 宿主运行；远程界面类型不限制原生进程能力。 */
export function supportsExecution(platform: NodeJS.Platform, arch: string): boolean {
    return (platform === 'win32' || platform === 'darwin' || platform === 'linux')
        && (arch === 'x64' || arch === 'arm64' || (platform === 'linux' && arch === 'arm'));
}

/** 手工工具链可独立使用；自动安装必须明确 libc 和 ARM hard-float ABI。 */
export function managedToolchainTarget(
    platform: NodeJS.Platform, arch: string,
    details: { libc?: LinuxLibc; armVersion?: string; armFloatAbi?: string } = {},
): ManagedToolchainTarget | undefined {
    if (!supportsExecution(platform, arch)) return undefined;
    if (platform !== 'linux') return `${platform}-${arch}` as ManagedToolchainTarget;
    if (details.libc !== 'glibc' && details.libc !== 'musl') return undefined;
    if (arch === 'arm') {
        return details.libc === 'glibc' && Number(details.armVersion) >= 7 && details.armFloatAbi === 'hard'
            ? 'linux-armhf' : undefined;
    }
    return `${details.libc === 'musl' ? 'alpine' : 'linux'}-${arch}` as ManagedToolchainTarget;
}

export function executableName(name: string, platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32' ? `${name}.exe` : name;
}

export function sameFilePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
    return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 按宿主平台的路径规则判断包含关系，不能用字符串前缀识别工作区。 */
export function isWithinRoot(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
