import type { ManagedToolchainTarget } from './platform';
import distribution from './toolchain-targets.json';
import { createReleasePolicy } from './toolchainReleaseCore.cjs';
import { validateToolchainArchiveListing } from './toolchainDistributionCore.cjs';
import { parseSha256Digest as parseDigest, validateAssetUrl as validateUrl, verifySha256 as verifyDigest } from './toolchainTransferCore.cjs';

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

/** 每个平台只有一个包含 `teal` 和 runtime 资源的归档。 */
export function releaseAssetName(target: ManagedToolchainTarget): string {
    return releasePolicy.archiveName(target);
}

export function parseSha256Digest(digest: string | undefined): string | undefined {
    return parseDigest(digest);
}

export function verifySha256(bytes: Uint8Array, expected: string): boolean {
    return verifyDigest(bytes, expected);
}

export function validateAssetUrl(url: string): void {
    validateUrl(url);
}

export function validateArchiveListing(listing: string): void {
    validateToolchainArchiveListing(listing);
}
