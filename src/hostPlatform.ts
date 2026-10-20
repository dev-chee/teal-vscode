import { existsSync } from 'node:fs';
import { managedToolchainTarget, type LinuxLibc, type ManagedToolchainTarget } from './platform';

/** 缺少 glibc 字段不等于 musl；未知 ABI 不参与托管下载。 */
export function linuxLibc(header: { glibcVersionRuntime?: string }, sharedObjects: readonly string[], hasMuslLoader: boolean): LinuxLibc {
    if (header.glibcVersionRuntime) return 'glibc';
    if (hasMuslLoader || sharedObjects.some((file) => /(?:^|\/)ld-musl-[^/]+\.so\.1$/.test(file))) return 'musl';
    return 'unknown';
}

export function currentToolchainTarget(): ManagedToolchainTarget | undefined {
    let libc: LinuxLibc = 'unknown';
    if (process.platform === 'linux') {
        const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] } | undefined;
        const machine = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : 'armhf';
        libc = linuxLibc(report?.header ?? {}, report?.sharedObjects ?? [], existsSync(`/lib/ld-musl-${machine}.so.1`));
    }
    const variables = process.config.variables as typeof process.config.variables & { arm_version?: number; arm_float_abi?: string };
    return managedToolchainTarget(process.platform, process.arch, {
        libc,
        armVersion: String(variables.arm_version ?? ''),
        armFloatAbi: String(variables.arm_float_abi ?? ''),
    });
}
