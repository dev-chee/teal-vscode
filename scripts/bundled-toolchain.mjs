import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { readToolchainIdentity, verifyToolchainDistribution } from '../src/toolchainDistributionCore.cjs';

/** 读取验证器写入的单一工具链根目录，拒绝空白输入以免误打包工作目录。 */
export async function bundledToolchainPath(pathFile) {
    const source = (await readFile(pathFile, 'utf8')).trim();
    if (!source) throw new Error(`Bundled toolchain path file is empty: ${pathFile}`);
    return path.resolve(source);
}

async function requireAbsent(directory) {
    try {
        await lstat(directory);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    throw new Error(`Refusing to replace an existing bundled toolchain staging directory: ${directory}`);
}

/**
 * 将已经过完整性校验的目标工具链放入 VSIX 会包含的 `dist/toolchain`。
 *
 * 返回的清理函数只会移除本调用创建的目录；已有目录会在写入前被拒绝，避免
 * 打包过程删除开发者或并行任务的文件。
 */
export async function stageBundledToolchain(source, target, destination = path.resolve('dist/toolchain')) {
    const verifiedSource = await verifyToolchainDistribution(source, target);
    await readToolchainIdentity(verifiedSource, target);
    const output = path.resolve(destination);
    if (verifiedSource === output) throw new Error('The bundled toolchain source and staging directory must differ.');
    await mkdir(path.dirname(output), { recursive: true });
    await requireAbsent(output);
    const staging = path.join(path.dirname(output), `.toolchain-staging-${randomUUID()}`);
    let staged = false;
    try {
        await cp(verifiedSource, staging, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
        // 复制后的内容同样必须满足清单，不能只信任来源目录。
        await verifyToolchainDistribution(staging, target);
        await readToolchainIdentity(staging, target);
        await rename(staging, output);
        staged = true;
    } finally {
        if (!staged) await rm(staging, { recursive: true, force: true });
    }
    const owner = await lstat(output, { bigint: true });
    return async () => {
        if (!staged) return;
        staged = false;
        const current = await lstat(output, { bigint: true }).catch(() => undefined);
        // 若并行任务在我们结束前替换了固定暂存目录，宁可留下本轮目录也不能删除它。
        if (!current || current.dev !== owner.dev || current.ino !== owner.ino) return;
        await rm(output, { recursive: true, force: true });
    };
}
