import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { ZipFile } from 'yazl';
import { targets } from './toolchain-release.mjs';
import { releasePlanFingerprint } from './gitlab-release-core.mjs';
import { stampBundledRelease, verifyReleasePackages } from './release-packages.mjs';
import { publishDesktopPackages } from './publishing.mjs';

function plan() {
    return { formatVersion: 1, extension: { projectId: 42, pipelineId: 234, ref: 'release', sha: 'b'.repeat(40), version: '1.2.4', tag: 'v1.2.4' },
        source: { apiUrl: 'https://gitlab.example.com/api/v4', project: 'group/teal', ref: 'release', pipelineId: 123,
            sha: 'a'.repeat(40), version: '0.1.5', jobs: Object.fromEntries(targets.map((target, i) => [target, 1000 + i])) } };
}
function identity(release, target) {
    return { repository: `https://gitlab.example.com/${release.source.project}`, target,
        release: `gitlab-pipeline-${release.source.pipelineId}-${release.source.sha}`,
        source: { kind: 'gitlab', pipelineId: release.source.pipelineId, jobId: release.source.jobs[target], sha: release.source.sha, archiveSha256: 'c'.repeat(64) } };
}
const manifest = release => ({ name: 'fixture', publisher: 'fixture-publisher', version: release.extension.version });
// 使用真实 ZIP 压缩流，独立验证发布元数据门禁；完整分发文件由 bundled-toolchain 测试覆盖。
async function archive(root, target, release, change = () => {}, duplicate = false) {
    const metadata = { packaged: manifest(release), bundled: { identity: identity(release, target), releasePlanFingerprint: releasePlanFingerprint(release) } };
    change(metadata);
    const file = path.join(root, 'target', `fixture-${release.extension.version}-${target}.vsix`);
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(metadata.packaged)), 'extension/package.json');
    zip.addBuffer(Buffer.from(JSON.stringify(metadata.bundled)), 'extension/dist/toolchain/manifest.json');
    if (duplicate) zip.addBuffer(Buffer.from('{}'), 'extension/package.json');
    const written = pipeline(zip.outputStream, createWriteStream(file));
    zip.end();
    await written;
    return file;
}
async function fixture(release) {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-release-packages-'));
    await mkdir(path.join(root, 'target'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest(release)));
    for (const target of targets) await archive(root, target, release);
    return root;
}

test('all nine packages must carry one canonical plan fingerprint and the planned target identity', async () => {
    const release = plan(), root = await fixture(release), target = targets[0];
    try {
        assert.equal((await verifyReleasePackages(release, root)).length, 9);
        const reordered = { ...release, source: { ...release.source, jobs: Object.fromEntries(Object.entries(release.source.jobs).reverse()) } };
        assert.equal(releasePlanFingerprint(reordered), releasePlanFingerprint(release));
        for (const mutate of [
            metadata => { metadata.bundled.releasePlanFingerprint = '0'.repeat(64); },
            metadata => { delete metadata.bundled.releasePlanFingerprint; },
            metadata => { metadata.bundled.identity.source.jobId++; },
            metadata => { metadata.bundled.identity.target = targets[1]; },
            metadata => { metadata.packaged.version = '0.0.1'; },
            metadata => { metadata.packaged.publisher = 'other-publisher'; },
        ]) {
            await archive(root, target, release, mutate);
            await assert.rejects(verifyReleasePackages(release, root), /release plan|toolchain source/);
        }
        await archive(root, target, release);
        await rm(path.join(root, 'target', `fixture-${release.extension.version}-${targets.at(-1)}.vsix`));
        await assert.rejects(verifyReleasePackages(release, root), /ENOENT/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('mixed prepare snapshots stop before tag creation and before any Marketplace side effect', async () => {
    const release = plan(), root = await fixture(release);
    const stale = { ...release, source: { ...release.source, pipelineId: 122, sha: 'd'.repeat(40) } };
    try {
        await archive(root, targets[0], stale);
        await writeFile(path.join(root, 'target/release.json'), JSON.stringify(release));
        let publishes = 0;
        await assert.rejects(publishDesktopPackages(async () => { publishes++; }, 'fixture-token', root, release), /fingerprint/);
        assert.equal(publishes, 0);
        const marker = path.join(root, 'tag-effect.json'), preload = path.join(root, 'api.mjs');
        await writeFile(preload, `import { writeFileSync } from 'node:fs'; globalThis.fetch = async (url, options) => {
            if (options.method === 'POST') { const body = JSON.parse(options.body); writeFileSync(process.env.TAG_MARKER, body.message); return Response.json({ commit: { id: body.ref }, message: body.message }); }
            return String(url).includes('?') ? Response.json([]) : new Response(null, { status: 404 });
        };`);
        const tag = () => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./gitlab-release.mjs', import.meta.url)), 'tag'], {
            cwd: root, encoding: 'utf8', env: { ...process.env, CI_COMMIT_SHA: release.extension.sha, CI_PROJECT_ID: '42', CI_API_V4_URL: release.source.apiUrl, GITLAB_RELEASE_TOKEN: 'fixture', TAG_MARKER: marker },
        });
        const refused = tag();
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /fingerprint/);
        await assert.rejects(access(marker), /ENOENT/);
        await archive(root, targets[0], release);
        const accepted = tag();
        assert.equal(accepted.status, 0, accepted.stderr);
        assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), release);
        await publishDesktopPackages(async files => { assert.equal(files.length, 9); publishes++; }, 'fixture-token', root, release);
        assert.equal(publishes, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('duplicate, oversized and malformed ZIP metadata cannot pass the release gate', async () => {
    const release = plan(), root = await fixture(release), target = targets[0];
    try {
        const file = await archive(root, target, release, () => {}, true);
        await assert.rejects(verifyReleasePackages(release, root), /Duplicate/);
        await archive(root, target, release, metadata => { metadata.bundled.padding = 'x'.repeat(8 * 1024 * 1024); });
        await assert.rejects(verifyReleasePackages(release, root), /oversized/);
        await writeFile(file, 'not a ZIP archive');
        await assert.rejects(verifyReleasePackages(release, root));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaging stamps only the plan matching the verified staged distribution', async () => {
    const release = plan(), root = await mkdtemp(path.join(tmpdir(), 'teal-release-stamp-')), target = targets[0];
    try {
        const file = path.join(root, 'manifest.json');
        await writeFile(file, JSON.stringify({ identity: identity(release, target) }));
        await stampBundledRelease(root, release, target);
        assert.equal(JSON.parse(await readFile(file, 'utf8')).releasePlanFingerprint, releasePlanFingerprint(release));
        const changed = { ...release, source: { ...release.source, pipelineId: 999 } };
        await assert.rejects(stampBundledRelease(root, changed, target), /toolchain source/);
        assert.equal(JSON.parse(await readFile(file, 'utf8')).releasePlanFingerprint, releasePlanFingerprint(release));
    } finally { await rm(root, { recursive: true, force: true }); }
});
