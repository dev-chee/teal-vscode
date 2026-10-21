import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleasePolicy } from '../src/toolchainReleaseCore.cjs';
import distribution from '../src/toolchain-targets.json';
import { selectToolchainRelease } from '../src/toolchainDownloadCore';

const policy = createReleasePolicy(distribution);
const complete = { tag_name: 'toolchain-v2.0.0', assets: policy.targets.map(target => ({ name: policy.archiveName(target) })) };
const partial = { tag_name: 'toolchain-v3.0.0', assets: [{ name: policy.archiveName('linux-x64') }] };

test('installer and CI use the same complete stable Release rule and pagination', async () => {
    assert.equal(selectToolchainRelease([partial, complete]), complete);
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher: typeof fetch = async (input, options) => {
        const url = String(input);
        requests.push({ url, headers: Object.fromEntries(new Headers(options?.headers).entries()) });
        return Response.json(url.endsWith('page=1') ? Array(100).fill(partial) : [complete]);
    };
    const release = await policy.readRelease(' LATEST ', undefined, fetcher);
    assert.deepEqual(release, complete);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.authorization, undefined, 'extension metadata reads do not inherit environment credentials');
    assert.match(requests[1].url, /per_page=100&page=2$/);
});

test('pinned incomplete, draft and prerelease toolchains fail instead of bypassing the gate', async () => {
    for (const release of [partial, { ...complete, draft: true }, { ...complete, prerelease: true }]) {
        await assert.rejects(policy.readRelease(complete.tag_name, undefined, async () => Response.json(release)), /all 9 desktop archives/);
    }
    assert.equal(policy.selectRelease([null, {}, partial, complete]), complete);
});

test('latest compares semantic versions across all pages and ignores unrelated releases', async () => {
    const newer = { ...complete, tag_name: 'toolchain-v10.0.0' };
    const older = { ...complete, tag_name: 'toolchain-v9.9.9' };
    const unrelated = { ...complete, tag_name: 'v99.0.0' };
    const selected = await policy.readRelease('latest', undefined, async url => Response.json(String(url).endsWith('page=1')
        ? [older, unrelated, ...Array(98).fill(partial)] : [newer]));
    assert.equal(selected.tag_name, newer.tag_name);
});
