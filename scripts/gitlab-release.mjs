import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gitlabApi } from './gitlab-api.mjs';
import { ensureReleaseTag, prepareRelease, validateReleasePlan } from './gitlab-release-core.mjs';
import { verifyReleasePackages } from './release-packages.mjs';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const sha = process.env.CI_COMMIT_SHA;
const command = process.argv[2];
if (command === 'prepare') {
    const plan = await prepareRelease({
        api: gitlabApi(process.env.CI_API_V4_URL, process.env.TEAL_GITLAB_READ_TOKEN),
        apiUrl: process.env.CI_API_V4_URL, sourceProject: process.env.TEAL_SOURCE_PROJECT, sourceRef: process.env.TEAL_SOURCE_REF,
        projectId: Number(process.env.CI_PROJECT_ID), pipelineId: Number(process.env.CI_PIPELINE_ID),
        ref: process.env.CI_COMMIT_BRANCH, sha, initialVersion: manifest.version,
    });
    await mkdir('target', { recursive: true });
    await writeFile('target/release.json', JSON.stringify(plan, null, 2));
    console.log(`${plan.extension.tag}: Teal pipeline ${plan.source.pipelineId} / ${plan.source.sha}`);
} else if (command === 'apply-version' || command === 'tag') {
    const plan = validateReleasePlan(JSON.parse(await readFile('target/release.json', 'utf8')), sha);
    if (plan.extension.projectId !== Number(process.env.CI_PROJECT_ID)) throw new Error('Release plan belongs to another extension project.');
    if (plan.source.apiUrl !== process.env.CI_API_V4_URL) throw new Error('Release plan belongs to another GitLab instance.');
    if (command === 'apply-version') {
        // 只修改 CI 检出副本，不创建版本提交；后续版本由已成功构建的 tag 推导。
        await writeFile('package.json', `${JSON.stringify({ ...manifest, version: plan.extension.version }, null, 2)}\n`);
    } else {
        if (manifest.version !== plan.extension.version) throw new Error('Apply the planned version before tagging.');
        await verifyReleasePackages(plan);
        await ensureReleaseTag(gitlabApi(process.env.CI_API_V4_URL, process.env.GITLAB_RELEASE_TOKEN), plan);
        console.log(`Tagged successful build ${plan.extension.tag}`);
    }
} else {
    throw new Error('Expected prepare, apply-version or tag.');
}
