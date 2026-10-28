import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { gitlabApi } from './gitlab-api.mjs';
import { sourceArchive, validateReleasePlan } from './gitlab-release-core.mjs';
import { validateToolchainArchiveListing, validateToolchainArchiveTypes, verifyToolchainDistribution } from '../src/toolchainDistributionCore.cjs';

const { values: { target } } = parseArgs({ options: { target: { type: 'string' } } });
const plan = validateReleasePlan(JSON.parse(await readFile('target/release.json', 'utf8')), process.env.CI_COMMIT_SHA);
if (plan.source.apiUrl !== process.env.CI_API_V4_URL) throw new Error('Source build belongs to another GitLab instance.');
const { name, route } = sourceArchive(plan, target);
const api = gitlabApi(plan.source.apiUrl, process.env.TEAL_GITLAB_READ_TOKEN);
const root = path.resolve('target/toolchains', target);
await mkdir(root, { recursive: true });
const staging = await mkdtemp(path.join(root, 'verification-'));
const exec = promisify(execFile);
let publicationAttempted = false;
try {
    const archive = path.join(staging, name);
    const archiveSha256 = await api.download(route, archive);
    validateToolchainArchiveListing((await exec('tar', ['-tf', archive], { maxBuffer: 4 * 1024 * 1024 })).stdout);
    validateToolchainArchiveTypes((await exec('tar', ['-tvf', archive], { maxBuffer: 4 * 1024 * 1024 })).stdout);
    const extracted = path.join(staging, 'contents');
    await mkdir(extracted);
    await exec('tar', ['-xf', archive, '-C', extracted]);
    const entries = await readdir(extracted, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error('Expected one Teal distribution root.');
    const directory = await verifyToolchainDistribution(path.join(extracted, entries[0].name), target);
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    manifest.identity = {
        repository: `${new URL(plan.source.apiUrl).origin}/${plan.source.project}`, target,
        release: `gitlab-pipeline-${plan.source.pipelineId}-${plan.source.sha}`,
        source: { kind: 'gitlab', pipelineId: plan.source.pipelineId, jobId: plan.source.jobs[target], sha: plan.source.sha, archiveSha256 },
    };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await rm(archive);
    const selection = path.join(staging, 'selection.txt');
    await writeFile(selection, directory);
    publicationAttempted = true;
    await rename(selection, path.resolve('target/toolchain-path.txt'));
    console.log(`Verified Teal pipeline ${plan.source.pipelineId} / ${target} / ${archiveSha256}`);
} catch (error) {
    if (!publicationAttempted) await rm(staging, { recursive: true, force: true });
    throw error;
}
