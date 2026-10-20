import { readFileSync } from 'node:fs';
import { createReleasePolicy } from '../src/toolchainReleaseCore.cjs';

export const distribution = JSON.parse(readFileSync(new URL('../src/toolchain-targets.json', import.meta.url), 'utf8'));
const policy = createReleasePolicy(distribution);
export const { targets, archiveName, selectRelease } = policy;
export const readRelease = (tag = 'latest') => policy.readRelease(tag, process.env.GITHUB_TOKEN);
