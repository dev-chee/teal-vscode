import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { distribution, targets } from './toolchain-release.mjs';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
const positiveId = value => Number.isSafeInteger(value) && value > 0;

export function nextVersion(previousTag, initialVersion, occupied = []) {
    const previous = previousTag === undefined ? initialVersion : previousTag.slice(1);
    if (!stableVersion.test(previous) || previousTag !== undefined && previousTag !== `v${previous}`) throw new Error('Invalid stable extension version.');
    const parts = previous.split('.');
    if (previousTag !== undefined) parts[2] = String(BigInt(parts[2]) + 1n);
    // 一个 Marketplace 扩展共用版本空间；不能只跳过同一 minor 中已占用的 patch。
    for (const tag of occupied) {
        if (!/^v/.test(tag) || !stableVersion.test(tag.slice(1))) continue;
        const version = tag.slice(1).split('.');
        const difference = parts.map((part, index) => BigInt(part) - BigInt(version[index])).find(value => value !== 0n) ?? 0n;
        if (difference <= 0n) {
            parts.splice(0, 3, version[0], version[1], String(BigInt(version[2]) + 1n));
        }
    }
    return parts.join('.');
}

/** 对同一计划生成与 JSON 键顺序无关的指纹，供包内元数据和发布门禁共同使用。 */
export function releasePlanFingerprint(plan) {
    validateReleasePlan(plan, plan.extension.sha);
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
}

/** GitLab 重试会创建新 job；优先读取最早成功的准备制品，过期时拒绝更换来源。 */
async function preparedSnapshot(api, projectId, pipelineId, sha, apiUrl) {
    const jobs = await api.list(`projects/${projectId}/pipelines/${pipelineId}/jobs?include_retried=true&scope[]=success`);
    const first = jobs.filter(job => job.name === 'prepare_release' && job.status === 'success').sort((left, right) => left.id - right.id)[0];
    if (!first) return undefined;
    if (!positiveId(first.id) || first.pipeline?.id !== pipelineId || first.commit?.id !== sha) throw new Error('Invalid original prepare job identity.');
    const directory = await mkdtemp(path.join(tmpdir(), 'teal-release-snapshot-'));
    try {
        const file = path.join(directory, 'release.json');
        await api.download(`projects/${projectId}/jobs/${first.id}/artifacts/target/release.json`, file, { maxBytes: 64 * 1024 });
        const previous = validateReleasePlan(JSON.parse(await readFile(file, 'utf8')), sha);
        if (previous.extension.projectId !== projectId || previous.extension.pipelineId !== pipelineId || previous.source.apiUrl !== apiUrl) {
            throw new Error('Original prepare artifact belongs to another pipeline or GitLab instance.');
        }
        return previous;
    } finally { await rm(directory, { recursive: true, force: true }); }
}

/** 只选择一次最新成功构建；全部目标必须来自同一个 pipeline 和源码 SHA。 */
export async function resolveSourceBuild(api, apiUrl, project, ref) {
    const root = `projects/${encodeURIComponent(project)}`;
    const pipelines = await api.request(`${root}/pipelines?ref=${encodeURIComponent(ref)}&status=success&order_by=id&sort=desc&per_page=1`);
    const selected = pipelines?.[0];
    if (!positiveId(selected?.id) || selected.status !== 'success' || selected.ref !== ref || !shaPattern.test(selected.sha)) {
        throw new Error('No successful Teal pipeline exists for the selected ref.');
    }
    const jobs = await api.list(`${root}/pipelines/${selected.id}/jobs?scope[]=success`);
    const inputs = {};
    for (const target of targets) {
        const matches = jobs.filter(job => job.name === `build_release_${target.replaceAll('-', '_')}`);
        if (matches.length !== 1 || !positiveId(matches[0].id) || matches[0].status !== 'success'
            || matches[0].pipeline?.id !== selected.id || matches[0].commit?.id !== selected.sha || !matches[0].artifacts_file?.filename) {
            throw new Error(`Latest Teal pipeline lacks a valid ${target} artifact; refusing to mix builds.`);
        }
        inputs[target] = matches[0].id;
    }
    const cargo = await api.request(`${root}/repository/files/Cargo.toml/raw?ref=${selected.sha}`, { text: true });
    const section = /^\[package\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargo)?.[1] ?? '';
    const inherited = /^version\.workspace\s*=\s*true\s*(?:#.*)?$/m.test(section);
    const versionSection = inherited ? /^\[workspace\.package\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargo)?.[1] : section;
    const version = /^version\s*=\s*"([^"]+)"/m.exec(versionSection ?? '')?.[1];
    if (!stableVersion.test(version ?? '')) throw new Error('Teal package version is missing or unsupported.');
    return { apiUrl, project, ref, pipelineId: selected.id, sha: selected.sha, version, jobs: inputs };
}

export function validateReleasePlan(plan, expectedSha) {
    const extension = plan?.extension, source = plan?.source;
    if (plan?.formatVersion !== 1 || !shaPattern.test(extension?.sha) || extension.sha !== expectedSha
        || !positiveId(extension?.projectId) || !positiveId(extension?.pipelineId) || !/^release(\/|$)/.test(extension.ref)
        || !stableVersion.test(extension?.version) || extension.tag !== `v${extension.version}`
        || !positiveId(source?.pipelineId) || !shaPattern.test(source?.sha) || !stableVersion.test(source?.version)
        || typeof source?.project !== 'string' || !/^(?:[\w.-]+\/)+[\w.-]+$/.test(source.project) || typeof source.ref !== 'string' || !source.ref
        || targets.some(target => !positiveId(source?.jobs?.[target])) || new Set(Object.values(source.jobs)).size !== targets.length) {
        throw new Error('Invalid release plan or extension commit mismatch.');
    }
    const url = new URL(source.apiUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/v4')) {
        throw new Error('Invalid source GitLab API URL.');
    }
    return plan;
}

/** 完整历史由 CI GIT_DEPTH=0 提供；已成功打标的提交复用标注中的全部来源。 */
export async function prepareRelease({ api, apiUrl, sourceProject, sourceRef, projectId, pipelineId, ref, sha, initialVersion, cwd = process.cwd() }) {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    if (git('rev-parse', 'HEAD') !== sha || !/^release(\/|$)/.test(ref)) throw new Error('Release requires the checked-out release branch commit.');
    const all = git('tag', '--list', 'v*').split(/\r?\n/).filter(tag => stableVersion.test(tag.slice(1)));
    const exact = git('tag', '--points-at', 'HEAD', '--list', 'v*').split(/\r?\n/).filter(tag => stableVersion.test(tag.slice(1)));
    if (exact.length > 1) throw new Error('Multiple extension version tags point to this commit.');
    if (exact.length) {
        const previous = JSON.parse(git('for-each-ref', '--format=%(contents)', `refs/tags/${exact[0]}`));
        validateReleasePlan(previous, sha);
        if (previous.extension.tag !== exact[0] || previous.extension.projectId !== projectId || previous.source.apiUrl !== apiUrl) {
            throw new Error('Existing release tag provenance conflicts.');
        }
        return previous;
    }
    const prepared = await preparedSnapshot(api, projectId, pipelineId, sha, apiUrl);
    if (prepared) return prepared;
    const merged = git('tag', '--merged', 'HEAD', '--list', 'v*').split(/\r?\n/).filter(tag => stableVersion.test(tag.slice(1)));
    // resource_group 默认不保证队列顺序；后继提交已发布时不能为旧源码分配更高版本。
    for (const tag of all.filter(tag => !merged.includes(tag))) {
        const result = spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', `${tag}^{commit}`], { cwd });
        if (result.status === 0) throw new Error('Release commit was superseded by an already tagged descendant.');
        if (result.status !== 1) throw new Error('Unable to check release tag ancestry.');
    }
    const nearest = merged.length ? git('describe', '--tags', '--abbrev=0', ...merged.flatMap(tag => ['--match', tag])) : undefined;
    const version = nextVersion(nearest, initialVersion, all);
    const source = await resolveSourceBuild(api, apiUrl, sourceProject, sourceRef);
    return validateReleasePlan({ formatVersion: 1, extension: { projectId, pipelineId, ref, sha, version, tag: `v${version}` }, source }, sha);
}

/** 冲突标签不能移动；网络重试只接受相同提交和相同工具链快照。 */
export async function ensureReleaseTag(api, plan) {
    validateReleasePlan(plan, plan.extension.sha);
    const route = `projects/${plan.extension.projectId}/repository/tags`;
    const check = existing => {
        let recorded;
        try { recorded = JSON.parse(existing.message); } catch { throw new Error('Existing release tag lacks build provenance.'); }
        if (existing.commit?.id !== plan.extension.sha || recorded.extension?.tag !== plan.extension.tag
            || recorded.extension?.sha !== plan.extension.sha || releasePlanFingerprint(recorded) !== releasePlanFingerprint(plan)) {
            throw new Error('Release tag already belongs to another commit or Teal build/release plan.');
        }
    };
    const current = await api.request(`${route}/${encodeURIComponent(plan.extension.tag)}`, { optional: true });
    if (current) { check(current); return; }
    const existingTags = await api.list(route);
    if (nextVersion(undefined, plan.extension.version, existingTags.map(tag => tag.name)) !== plan.extension.version) {
        throw new Error('New release version must be greater than all existing stable tags; rebuild the release pipeline.');
    }
    try {
        const created = await api.request(route, { method: 'POST', body: { tag_name: plan.extension.tag, ref: plan.extension.sha, message: JSON.stringify(plan) } });
        check(created);
    } catch (error) {
        // POST 可能已生效但响应丢失；只回读当前标签，不覆盖或再分配版本。
        const observed = await api.request(`${route}/${encodeURIComponent(plan.extension.tag)}`, { optional: true });
        if (!observed) throw error;
        check(observed);
    }
}

export function sourceArchive(plan, target) {
    validateReleasePlan(plan, plan.extension.sha);
    if (!Object.hasOwn(distribution.targets, target)) throw new Error(`Unsupported target: ${target}`);
    const name = `teal-${plan.source.version}-${distribution.targets[target].rustTarget}${target.startsWith('win32-') ? '.zip' : '.tar.gz'}`;
    return { name, route: `projects/${encodeURIComponent(plan.source.project)}/jobs/${plan.source.jobs[target]}/artifacts/target/dist/${name}` };
}
