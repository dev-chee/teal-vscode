import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ManagedToolchainTarget } from './platform';
import { parseManagedState, type ManagedState } from './managedState';
import { currentToolchainTarget } from './hostPlatform';
import { parseSha256Digest, readToolchainRelease, releaseAssetName, validateArchiveListing, validateAssetUrl, verifySha256, type ReleaseAsset } from './toolchainDownloadCore';
import { inspectToolchain, isCompleteToolchain, toolNames } from './toolchain';
import { verifyToolchainDistribution } from './toolchainDistributionCore.cjs';
import { compareToolchainVersions } from './toolchainReleaseCore.cjs';
import distribution from './toolchain-targets.json';
import { withManagedLock } from './managedLock';

const managedDirectoryName = 'managed-toolchain';
const maxAssetBytes = 512 * 1024 * 1024;
const execFileAsync = promisify(execFile);
export type ManagedToolchainStorage = Pick<vscode.ExtensionContext, 'globalStorageUri'>;

interface ReleaseInfo {
    id: number;
    tag_name: string;
    assets: ReleaseAsset[];
    draft?: boolean;
    prerelease?: boolean;
}

export { parseSha256Digest, releaseApiUrl, releaseAssetName, validateAssetUrl, verifySha256 } from './toolchainDownloadCore';

function managedRoot(context: ManagedToolchainStorage): string {
    return path.join(context.globalStorageUri.fsPath, managedDirectoryName);
}

async function fetchRelease(release: string, signal?: AbortSignal): Promise<ReleaseInfo> {
    const info = await readToolchainRelease(release, undefined, globalThis.fetch, signal) as ReleaseInfo;
    if (!Number.isSafeInteger(info.id) || info.id <= 0) throw new Error('Invalid toolchain Release ID.');
    return info;
}

async function downloadAsset(asset: ReleaseAsset, signal?: AbortSignal): Promise<Uint8Array> {
    validateAssetUrl(asset.browser_download_url);
    if (asset.size !== undefined && asset.size > maxAssetBytes) throw new Error(`The Teal toolchain asset ${asset.name} is too large.`);
    const response = await fetch(asset.browser_download_url, {
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'teal-vscode-extension' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`Unable to download ${asset.name} (${response.status} ${response.statusText}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxAssetBytes) throw new Error(`The Teal toolchain asset ${asset.name} is too large.`);
    const digest = parseSha256Digest(asset.digest);
    if (!digest) throw new Error(`The Teal toolchain asset ${asset.name} has no valid SHA-256 digest.`);
    if (!verifySha256(bytes, digest)) throw new Error(`The SHA-256 digest for ${asset.name} does not match.`);
    return bytes;
}

async function extractArchive(archive: string, destination: string): Promise<void> {
    const listed = await execFileAsync('tar', ['-tf', archive], { maxBuffer: 4 * 1024 * 1024 });
    validateArchiveListing(listed.stdout);
    await execFileAsync('tar', ['-xf', archive, '-C', destination], { maxBuffer: 4 * 1024 * 1024 });
}

async function findToolchainRoot(root: string): Promise<string | undefined> {
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    while (queue.length) {
        const current = queue.shift()!;
        const candidate = await inspectToolchain(current.directory);
        if (isCompleteToolchain(candidate)) return candidate.directory;
        if (current.depth >= 4) continue;
        const entries = await readdir(current.directory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== '.' && entry.name !== '..') {
                queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
            }
        }
    }
    return undefined;
}

async function readManagedRecords(context: ManagedToolchainStorage): Promise<ManagedState[]> {
    try {
        const value = JSON.parse(await readFile(path.join(managedRoot(context), 'current.json'), 'utf8'));
        const records = [value, ...(Array.isArray(value?.previous) ? value.previous : [])];
        const seen = new Set<string>();
        const target = currentToolchainTarget();
        return records.map(record => parseManagedState(record, target)).filter((record): record is ManagedState => {
            if (!record || seen.has(record.directory)) return false;
            seen.add(record.directory);
            return true;
        });
    } catch { return []; }
}

async function readManagedState(context: ManagedToolchainStorage, release = 'latest', excluded: readonly string[] = []): Promise<ManagedState | undefined> {
    const tag = release.trim() || 'latest';
    for (const value of await readManagedRecords(context)) try {
        if (excluded.includes(value.directory) || tag.toLowerCase() !== 'latest' && value.release !== tag) continue;
        const toolchain = await inspectToolchain(value.directory);
        if (!isCompleteToolchain(toolchain)) continue;
        await verifyToolchainDistribution(toolchain.directory, value.target);
        return { ...value, directory: toolchain.directory };
    } catch { /* 失败代次或损坏缓存不能阻止恢复较旧的已校验安装。 */ }
    return undefined;
}

export async function loadManagedToolchain(context: ManagedToolchainStorage, release = 'latest', excluded: readonly string[] = []): Promise<string | undefined> {
    return (await readManagedState(context, release, excluded))?.directory;
}

export async function installManagedToolchain(
    context: ManagedToolchainStorage,
    release: string,
    target: ManagedToolchainTarget,
    report?: (message: string) => void,
    options: InstallOptions = {},
): Promise<ManagedState> {
    return withManagedLock(managedRoot(context), signal => installLocked(context, release, target, report, { ...options, signal }), options.signal);
}

export interface InstallOptions {
    signal?: AbortSignal;
    /** 配置、信任或扩展生命周期发生变化时，提交前取消候选安装。 */
    canCommit?: () => Promise<boolean>;
}

async function checkCommit(options: InstallOptions): Promise<void> {
    options.signal?.throwIfAborted();
    if (options.canCommit && !await options.canCommit()) throw new Error('Toolchain update cancelled because configuration or workspace trust changed.');
    options.signal?.throwIfAborted();
}

/** 检查时间和安装事务共用锁，避免其他窗口重复下载或以旧结果覆盖新版本。 */
export async function updateManagedToolchain(
    context: ManagedToolchainStorage, release: string, target: ManagedToolchainTarget,
    options: InstallOptions & { force?: boolean; intervalMs?: number } = {},
): Promise<ManagedState | undefined> {
    const root = managedRoot(context);
    return withManagedLock(root, async signal => {
        const settings = { ...options, signal };
        await checkCommit(settings);
        const existing = await readManagedState(context);
        const identity = (state: ManagedState | undefined) => state ? `${state.directory}|${state.repository ?? ''}|${state.releaseId ?? ''}` : '';
        const latest = (release.trim() || 'latest').toLowerCase() === 'latest';
        if (!options.force) {
            if (!latest && existing?.release === release && existing.repository === distribution.repository && existing.releaseId) return existing;
            const stamp = await readFile(path.join(root, 'last-check.json'), 'utf8').then(value => JSON.parse(value)).catch(() => undefined);
            if (existing && stamp?.repository === distribution.repository && stamp.release === release && stamp.target === target
                && typeof stamp.time === 'number' && Date.now() >= stamp.time && Date.now() - stamp.time < (options.intervalMs ?? 6 * 60 * 60_000)
                && stamp.installation === identity(existing)) return existing;
        }
        const time = Date.now();
        const record = async (state: ManagedState) => {
            const temporary = path.join(root, `.check-${randomUUID()}`);
            try {
                await writeFile(temporary, JSON.stringify({ repository: distribution.repository, release, target, time, installation: identity(state) }));
                await rename(temporary, path.join(root, 'last-check.json'));
            } finally { await rm(temporary, { force: true }); }
        };
        const installed = await installLocked(context, release, target, undefined, settings);
        // 安装已提交；节流记录清理失败不能把成功的安装报告为失败。
        await record(installed).catch(() => {});
        return installed;
    }, options.signal);
}

async function installLocked(
    context: ManagedToolchainStorage, release: string, target: ManagedToolchainTarget,
    report: ((message: string) => void) | undefined, options: InstallOptions,
): Promise<ManagedState> {
    const root = managedRoot(context);
    await checkCommit(options);
    report?.('Reading the Teal toolchain release metadata…');
    const releaseInfo = await fetchRelease(release, options.signal);
    const existing = await readManagedState(context);
    await checkCommit(options);
    const latest = (release.trim() || 'latest').toLowerCase() === 'latest';
    if (existing && existing.target === target && (latest && compareToolchainVersions(existing.release, releaseInfo.tag_name) === 1
        || existing.release === releaseInfo.tag_name && existing.repository === distribution.repository && existing.releaseId === releaseInfo.id)) return existing;
    const archiveName = releaseAssetName('teal', target);
    const archive = releaseInfo.assets.find((asset) => asset.name === archiveName);
    if (!archive) throw new Error(`The release ${releaseInfo.tag_name} does not contain ${archiveName}.`);

    const installationId = randomUUID();
    const staging = path.join(root, `.staging-${installationId}`);
    // 每次安装独立成代，避免修复同标签时删除仍被其他窗口或进程使用的目录。
    const finalDirectory = path.join(root, 'installations', `${target}-${installationId}`);
    const state: ManagedState = { directory: finalDirectory, release: releaseInfo.tag_name, target, repository: distribution.repository, releaseId: releaseInfo.id };
    let publicationAttempted = false;
    let committed = false;
    try {
        await mkdir(staging, { recursive: true });
        const archivePath = path.join(staging, archive.name);
        report?.(`Downloading ${archive.name}…`);
        await writeFile(archivePath, await downloadAsset(archive, options.signal));
        const extracted = path.join(staging, 'contents');
        await mkdir(extracted, { recursive: true });
        await extractArchive(archivePath, extracted);
        const toolchainRoot = await findToolchainRoot(extracted);
        if (!toolchainRoot) throw new Error(`The downloaded release did not contain a complete Teal toolchain (${toolNames.join(', ')}).`);
        // 完成与 CI 相同的分发校验后，才允许替换目录和发布 current.json。
        await verifyToolchainDistribution(toolchainRoot, target);
        await checkCommit(options);
        await mkdir(path.dirname(finalDirectory), { recursive: true });
        await rename(toolchainRoot, finalDirectory);
        const temporaryState = path.join(staging, 'selection.json');
        const file = await open(temporaryState, 'wx', 0o600);
        try {
            // 选择与历史引用一次原子发布，供旧窗口固定版本及 LSP 失败回滚使用。
            const previous = (await readManagedRecords(context)).filter(record => record.directory !== state.directory);
            await file.writeFile(JSON.stringify({ ...state, previous }, null, 2), 'utf8');
            await file.sync();
        } catch (error) {
            try { await file.close(); }
            catch (closeError) { throw new AggregateError([error, closeError], `State write failed: ${String(error)}; closing the state file also failed.`, { cause: closeError }); }
            throw error;
        }
        await file.close();
        await checkCommit(options);
        publicationAttempted = true;
        try {
            await rename(temporaryState, path.join(root, 'current.json'));
        } catch (error) {
            // I/O 报错可能发生在替换生效之后；读回确认，不能删除可能已被选中的代次。
            const selected = await readFile(path.join(root, 'current.json'), 'utf8')
                .then(value => parseManagedState(JSON.parse(value), target)).catch(() => undefined);
            if (selected?.directory !== state.directory || selected.release !== state.release) throw error;
        }
        committed = true;
        return state;
    } catch (error) {
        const cleanupErrors: unknown[] = [];
        // 发布之前的候选代次从未可见，可以安全回滚；发布结果不确定时保留数据。
        if (!publicationAttempted) {
            await rm(finalDirectory, { recursive: true, force: true }).catch(cleanup => cleanupErrors.push(cleanup));
        }
        await rm(staging, { recursive: true, force: true }).catch(cleanup => cleanupErrors.push(cleanup));
        if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], `Toolchain installation failed: ${String(error)}; cleanup also failed.`, { cause: error });
        throw error;
    } finally {
        // 提交之后的临时文件清理失败不能把已成功的安装报告为失败。
        if (committed) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
}

export function currentManagedToolchainTarget(): ManagedToolchainTarget | undefined {
    return currentToolchainTarget();
}
