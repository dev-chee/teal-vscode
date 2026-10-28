import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { gitlabApi } from './gitlab-api.mjs';
import { ensureReleaseTag, nextVersion, prepareRelease, resolveSourceBuild, sourceArchive, validateReleasePlan } from './gitlab-release-core.mjs';
import { targets } from './toolchain-release.mjs';
import { stageBundledToolchain } from './bundled-toolchain.mjs';
import { readToolchainIdentity } from '../src/toolchainDistributionCore.cjs';
import { writeRuntimeFixture } from '../tests/helpers/toolchainFixture.cjs';

const apiUrl = 'https://gitlab.example.com/api/v4';
const sourceSha = 'a'.repeat(40);
function sourceBuild() {
    return { apiUrl, project: 'group/teal', ref: 'release', pipelineId: 123, sha: sourceSha, version: '0.1.5',
        jobs: Object.fromEntries(targets.map((target, index) => [target, 1000 + index])) };
}
function plan(sha = 'b'.repeat(40)) {
    return { formatVersion: 1, extension: { projectId: 42, pipelineId: 234, ref: 'release', sha, version: '1.2.4', tag: 'v1.2.4' }, source: sourceBuild() };
}
function sourceApi() {
    const jobs = targets.map((target, index) => ({ name: `build_release_${target.replaceAll('-', '_')}`, id: 1000 + index,
        status: 'success', pipeline: { id: 123 }, commit: { id: sourceSha }, artifacts_file: { filename: 'artifacts.zip' } }));
    const calls = [];
    return { jobs, calls, async list(route) { calls.push(route); return jobs; }, async request(route) {
        calls.push(route);
        return route.includes('/pipelines?') ? [{ id: 123, ref: 'release', sha: sourceSha, status: 'success' }]
            : '[package]\nname = "teal"\nversion.workspace = true\n\n[workspace]\nmembers=[]\n\n[workspace.package]\nversion = "0.1.5"\n';
    } };
}

test('release patch increments from the last tag, avoids occupied versions, and uses the manifest only initially', () => {
    assert.equal(nextVersion(undefined, '0.1.8'), '0.1.8');
    assert.equal(nextVersion('v1.2.3', '0.1.8'), '1.2.4');
    assert.equal(nextVersion('v1.2.3', '0.1.8', ['v1.2.4', 'v1.2.5']), '1.2.6');
    for (const value of ['vlatest', 'v01.2.3', 'v1.2.3-beta']) assert.throws(() => nextVersion(value, '0.1.8'));
});

test('a new release version exceeds stable tags on every branch, including higher major versions', () => {
    assert.equal(nextVersion('v1.2.3', '0.1.8', ['v1.2.3', 'v2.0.0']), '2.0.1');
    assert.equal(nextVersion(undefined, '0.1.8', ['v2.0.9', 'v2.0.10', 'toolchain-v99.0.0']), '2.0.11');
    assert.equal(nextVersion(undefined, '3.0.0', ['v2.9.9']), '3.0.0');
});

test('retrying preparation restores the first successful prepare artifact before consulting latest builds or tags', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-prepare-retry-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
        git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
        git('config', 'commit.gpgsign', 'false');
        await writeFile(path.join(root, 'input'), 'same source'); git('add', 'input'); git('commit', '-qm', 'source');
        const sha = git('rev-parse', 'HEAD');
        const original = plan(sha);
        const requests = [];
        const api = {
            async list(route) {
                requests.push(route);
                return [901, 900].map(id => ({ id, name: 'prepare_release', status: 'success', pipeline: { id: 234 }, commit: { id: sha } }));
            },
            async download(route, destination) { requests.push(route); await writeFile(destination, JSON.stringify(original)); },
            async request() { throw new Error('latest must not be re-resolved on prepare retry'); },
        };
        const input = { api, apiUrl, sourceProject: 'group/teal', sourceRef: 'release', projectId: 42, pipelineId: 234,
            ref: 'release', sha, initialVersion: '0.1.8', cwd: root };
        assert.deepEqual(await prepareRelease(input), original);
        assert.match(requests[0], /projects\/42\/pipelines\/234\/jobs\?.*include_retried=true/);
        assert.match(requests[1], /jobs\/900\/artifacts\/target\/release.json$/);
        api.download = async () => { throw new Error('fixed prepare artifact expired'); };
        await assert.rejects(prepareRelease(input), /fixed prepare artifact expired/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('latest source snapshot binds all nine target artifacts to one successful pipeline and source SHA', async () => {
    const api = sourceApi();
    assert.deepEqual(await resolveSourceBuild(api, apiUrl, 'group/teal', 'release'), sourceBuild());
    assert.match(api.calls[0], /status=success&order_by=id&sort=desc&per_page=1/);
    assert.match(api.calls[2], new RegExp(`ref=${sourceSha}$`));
    assert.match(sourceArchive(plan(), 'win32-arm64').route, /jobs\/1001\/artifacts\/target\/dist\/teal-0.1.5-aarch64-pc-windows-msvc.zip$/);
    for (const mutate of [jobs => jobs.pop(), jobs => jobs.push(jobs[0]), jobs => { jobs[0].commit.id = 'c'.repeat(40); },
        jobs => { jobs[0].status = 'failed'; }, jobs => { jobs[0].pipeline.id = 999; }]) {
        const broken = sourceApi(); mutate(broken.jobs);
        await assert.rejects(resolveSourceBuild(broken, apiUrl, 'group/teal', 'release'), /refusing to mix builds/);
    }
    assert.throws(() => validateReleasePlan(plan(), 'f'.repeat(40)), /commit mismatch/);
});

test('retrying the same successful commit reuses its annotated version and source snapshot without resolving latest again', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-release-history-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
        git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
        git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
        await writeFile(path.join(root, 'input'), 'first'); git('add', 'input'); git('commit', '-qm', 'initial'); git('tag', 'v1.2.3');
        await writeFile(path.join(root, 'input'), 'second'); git('commit', '-qam', 'next');
        const sha = git('rev-parse', 'HEAD');
        const input = { api: sourceApi(), apiUrl, sourceProject: 'group/teal', sourceRef: 'release',
            projectId: 42, pipelineId: 234, ref: 'release', sha, initialVersion: '0.1.8', cwd: root };
        const first = await prepareRelease(input);
        assert.equal(first.extension.tag, 'v1.2.4');
        assert.equal(git('tag', '--points-at', 'HEAD'), '', 'preparation must not tag an unbuilt commit');
        git('tag', '-a', first.extension.tag, '-m', JSON.stringify(first));
        const retried = await prepareRelease({ ...input, api: { request() { throw new Error('must not resolve latest'); } } });
        assert.deepEqual(retried, first);
        await writeFile(path.join(root, 'input'), 'third'); git('commit', '-qam', 'another');
        const next = await prepareRelease({ ...input, sha: git('rev-parse', 'HEAD'), pipelineId: 235 });
        assert.equal(next.extension.tag, 'v1.2.5');
        git('tag', '-a', next.extension.tag, '-m', JSON.stringify(next));
        git('tag', '-d', first.extension.tag);
        git('checkout', '-q', sha);
        await assert.rejects(prepareRelease(input), /superseded/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('tagging is idempotent after an uncertain POST and refuses another commit or source build', async () => {
    const release = plan();
    let current, posts = 0;
    const api = { async list() { return []; }, async request(route, options) {
        if (options.method === 'POST') {
            posts++;
            current = { commit: { id: release.extension.sha }, message: options.body.message };
            throw new Error('response lost after remote effect');
        }
        return current;
    } };
    await ensureReleaseTag(api, release);
    await ensureReleaseTag(api, release);
    assert.equal(posts, 1);
    await assert.rejects(ensureReleaseTag(api, { ...release, extension: { ...release.extension, sha: 'c'.repeat(40) } }), /another commit/);
    await assert.rejects(ensureReleaseTag(api, { ...release, source: { ...release.source, pipelineId: 999 } }), /another commit or Teal build/);
    await assert.rejects(ensureReleaseTag(api, { ...release, extension: { ...release.extension, pipelineId: 235 } }), /release plan/);
});

test('a stale prepared version cannot create a lower tag after another branch has published', async () => {
    let writes = 0;
    const api = { async list() { return [{ name: 'v2.0.0' }]; }, async request(route, options) {
        if (options.method === 'POST') writes++;
        return undefined;
    } };
    await assert.rejects(ensureReleaseTag(api, plan()), /greater than all existing stable tags/);
    assert.equal(writes, 0);
});

test('GitLab artifact redirects never send the API token to object storage and streamed bytes retain a digest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-gitlab-download-'));
    const calls = [];
    try {
        const bytes = Buffer.from('fixture archive');
        const api = gitlabApi(apiUrl, 'synthetic-secret', async (url, options) => {
            calls.push({ url: String(url), headers: options.headers });
            return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.example.com/archive' } })
                : new Response(bytes);
        });
        const file = path.join(root, 'archive');
        assert.equal(await api.download('projects/42/jobs/100/artifacts/file', file), createHash('sha256').update(bytes).digest('hex'));
        assert.equal(calls[0].headers['PRIVATE-TOKEN'], 'synthetic-secret');
        assert.equal(calls[1].headers['PRIVATE-TOKEN'], undefined);
        assert.deepEqual(await readFile(file), bytes);
        assert.throws(() => gitlabApi('http://gitlab.example.com/api/v4', 'secret'), /HTTPS/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('fixed job artifacts are verified and bundled with GitLab provenance instead of a forged public Release', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-gitlab-bundle-'));
    try {
        const bundle = path.join(root, 'bundle');
        await mkdir(bundle);
        const files = [];
        for (const name of ['teal', 'toolchain.json']) {
            const content = Buffer.from(name === 'teal' ? '#!/bin/sh\nexit 0\n' : '{}');
            await writeFile(path.join(bundle, name), content);
            files.push({ path: name, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
        }
        await chmod(path.join(bundle, 'teal'), 0o755);
        await writeRuntimeFixture(bundle, files);
        await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ formatVersion: 1, files }));
        const archive = path.join(root, 'fixture.tar.gz');
        assert.equal(spawnSync('tar', ['-czf', archive, '-C', root, 'bundle']).status, 0);
        await mkdir(path.join(root, 'target'));
        await writeFile(path.join(root, 'target/release.json'), JSON.stringify(plan()));
        const preload = path.join(root, 'fetch.mjs');
        await writeFile(preload, `import { readFileSync } from 'node:fs'; globalThis.fetch = async url => {
            if (!String(url).includes('/jobs/1002/artifacts/target/dist/teal-0.1.5-x86_64-unknown-linux-gnu.tar.gz')) throw new Error('unpinned URL');
            return new Response(readFileSync(process.env.FIXTURE_ARCHIVE));
        };`);
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
            fileURLToPath(new URL('./gitlab-toolchain.mjs', import.meta.url)), '--target', 'linux-x64'], {
            cwd: root, encoding: 'utf8', env: { ...process.env, CI_API_V4_URL: apiUrl, CI_COMMIT_SHA: plan().extension.sha, TEAL_GITLAB_READ_TOKEN: 'fixture', FIXTURE_ARCHIVE: archive },
        });
        assert.equal(result.status, 0, result.stderr);
        const directory = await readFile(path.join(root, 'target/toolchain-path.txt'), 'utf8');
        const destination = path.join(root, 'dist', 'toolchain');
        const cleanup = await stageBundledToolchain(directory, 'linux-x64', destination);
        assert.equal((await readToolchainIdentity(destination, 'linux-x64')).release, `gitlab-pipeline-123-${sourceSha}`);
        await cleanup();
        await writeFile(path.join(directory, 'teal'), 'corrupted');
        await assert.rejects(stageBundledToolchain(directory, 'linux-x64', destination), /digest mismatch/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
