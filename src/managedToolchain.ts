import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ManagedToolchainTarget } from './platform';
import { parseManagedState, type ManagedState } from './managedState';
import { currentToolchainTarget } from './hostPlatform';
import { parseSha256Digest, readToolchainRelease, releaseAssetName, validateArchiveListing, validateAssetUrl, verifySha256, type ReleaseAsset } from './toolchainDownloadCore';
import { inspectToolchain, isCompleteToolchain, toolNames } from './toolchain';
import { verifyToolchainDistribution } from './toolchainDistributionCore.cjs';

const managedDirectoryName = 'managed-toolchain';
const maxAssetBytes = 512 * 1024 * 1024;
const execFileAsync = promisify(execFile);

interface ReleaseInfo {
    tag_name: string;
    assets: ReleaseAsset[];
    draft?: boolean;
    prerelease?: boolean;
}

export { parseSha256Digest, releaseApiUrl, releaseAssetName, validateAssetUrl, verifySha256 } from './toolchainDownloadCore';

function managedRoot(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, managedDirectoryName);
}

async function fetchRelease(release: string): Promise<ReleaseInfo> {
    return await readToolchainRelease(release) as ReleaseInfo;
}

async function downloadAsset(asset: ReleaseAsset): Promise<Uint8Array> {
    validateAssetUrl(asset.browser_download_url);
    if (asset.size !== undefined && asset.size > maxAssetBytes) throw new Error(`The Teal toolchain asset ${asset.name} is too large.`);
    const response = await fetch(asset.browser_download_url, {
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'teal-vscode-extension' },
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

async function readManagedState(context: vscode.ExtensionContext): Promise<ManagedState | undefined> {
    try {
        const value = parseManagedState(JSON.parse(await readFile(path.join(managedRoot(context), 'current.json'), 'utf8')), currentToolchainTarget());
        if (!value) return undefined;
        const toolchain = await inspectToolchain(value.directory);
        if (!isCompleteToolchain(toolchain)) return undefined;
        await verifyToolchainDistribution(toolchain.directory, value.target);
        return { directory: toolchain.directory, release: value.release, target: value.target };
    } catch {
        return undefined;
    }
}

export async function loadManagedToolchain(context: vscode.ExtensionContext): Promise<string | undefined> {
    return (await readManagedState(context))?.directory;
}

export async function installManagedToolchain(
    context: vscode.ExtensionContext,
    release: string,
    target: ManagedToolchainTarget,
    report?: (message: string) => void,
): Promise<{ directory: string; release: string; target: ManagedToolchainTarget }> {
    const root = managedRoot(context);
    const existing = await readManagedState(context);

    report?.('Reading the Teal toolchain release metadata…');
    const releaseInfo = await fetchRelease(release);
    if (existing && existing.target === target && existing.release === releaseInfo.tag_name) return existing;
    const archiveName = releaseAssetName('teal', target);
    const archive = releaseInfo.assets.find((asset) => asset.name === archiveName);
    if (!archive) throw new Error(`The release ${releaseInfo.tag_name} does not contain ${archiveName}.`);

    const staging = path.join(root, `.staging-${randomUUID()}`);
    const finalDirectory = path.join(root, releaseInfo.tag_name, target);
    try {
        await mkdir(staging, { recursive: true });
        const archivePath = path.join(staging, archive.name);
        report?.(`Downloading ${archive.name}…`);
        await writeFile(archivePath, await downloadAsset(archive));
        const extracted = path.join(staging, 'contents');
        await mkdir(extracted, { recursive: true });
        await extractArchive(archivePath, extracted);
        const toolchainRoot = await findToolchainRoot(extracted);
        if (!toolchainRoot) throw new Error(`The downloaded release did not contain a complete Teal toolchain (${toolNames.join(', ')}).`);
        // 完成与 CI 相同的分发校验后，才允许替换目录和发布 current.json。
        await verifyToolchainDistribution(toolchainRoot, target);
        await mkdir(path.dirname(finalDirectory), { recursive: true });
        await rm(finalDirectory, { recursive: true, force: true });
        await rename(toolchainRoot, finalDirectory);
        const state: ManagedState = { directory: finalDirectory, release: releaseInfo.tag_name, target };
        await writeFile(path.join(root, 'current.json'), JSON.stringify(state, null, 2), 'utf8');
        return state;
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

export function currentManagedToolchainTarget(): ManagedToolchainTarget | undefined {
    return currentToolchainTarget();
}
