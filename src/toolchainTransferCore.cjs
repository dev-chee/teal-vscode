const { createHash, randomUUID } = require('node:crypto');
const { open, rename, rm } = require('node:fs/promises');
const path = require('node:path');

const maxAssetBytes = 512 * 1024 * 1024;

function parseSha256Digest(digest) {
    if (!digest) return undefined;
    const normalized = digest.trim().toLowerCase();
    const value = normalized.startsWith('sha256:') ? normalized.slice('sha256:'.length) : normalized;
    return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function verifySha256(bytes, expected) {
    return createHash('sha256').update(bytes).digest('hex') === expected.toLowerCase();
}

function validateAssetUrl(url) {
    const parsed = new globalThis.URL(url);
    if (parsed.protocol !== 'https:') throw new Error('The Teal toolchain asset URL must use HTTPS.');
}

async function* responseChunks(body) {
    if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                yield globalThis.Buffer.from(value);
            }
        } finally {
            reader.releaseLock();
        }
    }
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
        for await (const value of body) yield globalThis.Buffer.from(value);
        return;
    }
    throw new Error('The Teal toolchain asset response has no readable body.');
}

function downloadSignal(signal, timeoutMs) {
    const timeout = globalThis.AbortSignal.timeout(timeoutMs);
    return signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 将已发布资产流式写入同目录临时文件，并在摘要核验后原子发布。
 * 调用方必须在独立暂存目录提供 destination；失败不会留下可消费的目标文件。
 */
async function downloadVerifiedAsset(asset, destination, options = {}) {
    const maximum = options.maxBytes ?? maxAssetBytes;
    validateAssetUrl(asset.browser_download_url);
    if (asset.size !== undefined && asset.size > maximum) throw new Error(`The Teal toolchain asset ${asset.name} is too large.`);
    const digest = parseSha256Digest(asset.digest);
    if (!digest) throw new Error(`The Teal toolchain asset ${asset.name} has no valid SHA-256 digest.`);

    const signal = downloadSignal(options.signal, options.timeoutMs ?? 300_000);
    const response = await (options.fetcher ?? globalThis.fetch)(asset.browser_download_url, {
        headers: options.headers,
        signal,
    });
    if (!response.ok) throw new Error(`Unable to download ${asset.name} (${response.status} ${response.statusText}).`);

    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.partial`);
    let file;
    let bytes = 0;
    const hash = createHash('sha256');
    try {
        file = await open(temporary, 'wx', 0o600);
        for await (const chunk of responseChunks(response.body)) {
            signal.throwIfAborted();
            bytes += chunk.byteLength;
            if (bytes > maximum) throw new Error(`The Teal toolchain asset ${asset.name} is too large.`);
            hash.update(chunk);
            await file.writeFile(chunk);
        }
        await file.sync();
        await file.close();
        file = undefined;
        if (hash.digest('hex') !== digest) throw new Error(`The SHA-256 digest for ${asset.name} does not match.`);
        await rename(temporary, destination);
        return { bytes };
    } catch (error) {
        if (file) await file.close().catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

module.exports = { downloadVerifiedAsset, maxAssetBytes, parseSha256Digest, validateAssetUrl, verifySha256 };
