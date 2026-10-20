import { createHash } from 'node:crypto';
import type { ManagedToolchainTarget } from './platform';
import distribution from './toolchain-targets.json';
import { createReleasePolicy } from './toolchainReleaseCore.cjs';

const releasePolicy = createReleasePolicy(distribution);
export const selectToolchainRelease = releasePolicy.selectRelease;
export const readToolchainRelease = releasePolicy.readRelease;

export interface ReleaseAsset {
    name: string;
    browser_download_url: string;
    digest?: string;
    size?: number;
}

export function releaseApiUrl(release: string): string {
    return releasePolicy.apiUrl(release);
}

export function releaseAssetName(tool: string, target: ManagedToolchainTarget): string {
    void tool;
    return releasePolicy.archiveName(target);
}

export function parseSha256Digest(digest: string | undefined): string | undefined {
    if (!digest) return undefined;
    const normalized = digest.trim().toLowerCase();
    const value = normalized.startsWith('sha256:') ? normalized.slice('sha256:'.length) : normalized;
    return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

export function verifySha256(bytes: Uint8Array, expected: string): boolean {
    return createHash('sha256').update(bytes).digest('hex') === expected.toLowerCase();
}

export function validateAssetUrl(url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('The Teal toolchain asset URL must use HTTPS.');
}

export function validateArchiveListing(listing: string): void {
    for (const entry of listing.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        const normalized = entry.replaceAll('\\', '/');
        if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
            throw new Error(`The Teal toolchain archive contains an unsafe path: ${entry}`);
        }
    }
}
