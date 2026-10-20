import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { archiveName, distribution, readRelease, targets } from './toolchain-release.mjs';
import { verifyToolchainDistribution } from '../src/toolchainDistributionCore.cjs';

const exec = promisify(execFile);
const { values } = parseArgs({ options: { target: { type: 'string' }, release: { type: 'string', default: 'latest' }, resolve: { type: 'boolean' } } });
const release = await readRelease(values.release);
if (values.resolve) {
    const include = targets.map((target) => ({ target, ...distribution.targets[target] }));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${release.tag_name}\nmatrix=${JSON.stringify({ include })}\n`);
    console.log(`Selected ${distribution.repository}@${release.tag_name}: all ${targets.length} desktop targets`);
} else {
    const target = values.target;
    const name = archiveName(target);
    const asset = release.assets.find((asset) => asset.name === name);
    if (!/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? '')) throw new Error(`${name} is missing a GitHub SHA-256 digest.`);
    if (new URL(asset.browser_download_url).protocol !== 'https:') throw new Error('Asset URL must use HTTPS.');
    if (asset.size > 512 * 1024 * 1024) throw new Error(`${name} is too large.`);
    const response = await fetch(asset.browser_download_url);
    if (!response.ok) throw new Error(`Download ${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 512 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== asset.digest.slice(7).toLowerCase()) throw new Error(`${name}: SHA-256 verification failed.`);
    const root = path.resolve('target/toolchains', target);
    await mkdir(root, { recursive: true });
    const archive = path.join(root, name);
    await writeFile(archive, bytes);
    const listing = await exec('tar', ['-tf', archive], { maxBuffer: 4 * 1024 * 1024 });
    for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
        const normalized = entry.replaceAll('\\', '/');
        if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) throw new Error(`Unsafe archive path: ${entry}`);
    }
    const extracted = path.join(root, 'contents');
    await mkdir(extracted, { recursive: true });
    await exec('tar', ['-xf', archive, '-C', extracted], { maxBuffer: 4 * 1024 * 1024 });
    const directories = (await readdir(extracted, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (directories.length !== 1) throw new Error('Expected exactly one distribution root.');
    const directory = await verifyToolchainDistribution(path.join(extracted, directories[0].name), target);
    await writeFile('target/toolchain-path.txt', directory);
    if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `TEAL_TOOLCHAIN_PATH=${directory}\n`);
    console.log(`Verified ${release.tag_name} / ${target}: ${directory}`);
}
