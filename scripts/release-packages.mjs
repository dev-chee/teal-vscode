import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { open } from 'yauzl';
import { targets } from './toolchain-release.mjs';
import { releasePlanFingerprint, validateReleasePlan } from './gitlab-release-core.mjs';

function requirePlannedIdentity(identity, plan, target) {
    const source = identity?.source;
    if (identity?.target !== target || identity.repository !== `${new URL(plan.source.apiUrl).origin}/${plan.source.project}`
        || identity.release !== `gitlab-pipeline-${plan.source.pipelineId}-${plan.source.sha}`
        || source?.kind !== 'gitlab' || source.pipelineId !== plan.source.pipelineId || source.jobId !== plan.source.jobs[target]
        || source.sha !== plan.source.sha || !/^[a-f0-9]{64}$/.test(source.archiveSha256)) {
        throw new Error(`VSIX toolchain source does not match the release plan: ${target}`);
    }
}

/** 只修改打包暂存副本；将完整准备计划绑定到 VSIX 内的工具链清单。 */
export async function stampBundledRelease(directory, plan, target) {
    const fingerprint = releasePlanFingerprint(plan);
    const file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    requirePlannedIdentity(manifest.identity, plan, target);
    await writeFile(file, JSON.stringify({ ...manifest, releasePlanFingerprint: fingerprint }));
}

/** 仅读取两份发布元数据；限制解压大小并拒绝重复条目，不解压工具链载荷。 */
async function readMetadata(file) {
    const limits = new Map([
        ['extension/package.json', 256 * 1024],
        ['extension/dist/toolchain/manifest.json', 8 * 1024 * 1024],
    ]);
    const zip = await new Promise((resolve, reject) => open(file, { lazyEntries: true, strictFileNames: true }, (error, archive) => error ? reject(error) : resolve(archive)));
    return new Promise((resolve, reject) => {
        const entries = new Map();
        let completed = false, active, count = 0;
        const fail = error => {
            if (completed) return;
            completed = true;
            active?.destroy();
            zip.close();
            reject(error);
        };
        zip.once('error', fail);
        zip.once('end', () => {
            if (completed) return;
            completed = true;
            resolve(entries);
        });
        zip.on('entry', entry => {
            if (++count > 100_000) return fail(new Error('VSIX contains too many entries.'));
            const name = entry.fileName.toLowerCase();
            const limit = limits.get(name);
            if (!limit) { zip.readEntry(); return; }
            if (entries.has(name) || entry.uncompressedSize > limit) return fail(new Error(`Duplicate or oversized VSIX metadata: ${name}`));
            entries.set(name, undefined);
            zip.openReadStream(entry, (error, stream) => {
                if (error) return fail(error);
                if (completed) { stream.destroy(); return; }
                active = stream;
                let size = 0;
                const chunks = [];
                stream.once('error', fail);
                stream.on('data', chunk => {
                    size += chunk.length;
                    if (size > limit) return fail(new Error(`Oversized VSIX metadata: ${name}`));
                    chunks.push(chunk);
                });
                stream.once('end', () => {
                    if (completed) return;
                    active = undefined;
                    entries.set(name, Buffer.concat(chunks));
                    zip.readEntry();
                });
            });
        });
        zip.readEntry();
    });
}

/** 打 tag 和调用 Marketplace 前均验证九包，不能用相同文件名掩盖旧快照或混包。 */
export async function verifyReleasePackages(plan, cwd = process.cwd()) {
    validateReleasePlan(plan, plan.extension.sha);
    const fingerprint = releasePlanFingerprint(plan);
    const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
    if (manifest.version !== plan.extension.version) throw new Error('Apply the planned package version before verifying VSIX files.');
    const files = [];
    for (const target of targets) {
        const file = path.join(cwd, 'target', `${manifest.name}-${manifest.version}-${target}.vsix`);
        const entries = await readMetadata(file);
        const packageBytes = entries.get('extension/package.json');
        const toolchainBytes = entries.get('extension/dist/toolchain/manifest.json');
        if (!packageBytes || !toolchainBytes) throw new Error(`Missing VSIX release metadata: ${target}`);
        const packaged = JSON.parse(packageBytes.toString('utf8'));
        const bundled = JSON.parse(toolchainBytes.toString('utf8'));
        if (packaged.name !== manifest.name || packaged.publisher !== manifest.publisher || packaged.version !== plan.extension.version
            || bundled.releasePlanFingerprint !== fingerprint) {
            throw new Error(`VSIX release plan fingerprint or extension version mismatch: ${target}`);
        }
        requirePlannedIdentity(bundled.identity, plan, target);
        files.push(file);
    }
    return files;
}
