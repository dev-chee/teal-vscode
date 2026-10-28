import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** CI 专用 GitLab API；错误不包含凭据或响应正文。 */
export function gitlabApi(baseUrl, token, fetcher = globalThis.fetch) {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/api/v4')) {
        throw new Error('GitLab API must be an HTTPS /api/v4 URL.');
    }
    if (!token?.trim()) throw new Error('A GitLab API token is required.');
    const address = route => `${base.href}/${route}`;
    const headers = { 'PRIVATE-TOKEN': token.trim() };
    async function request(route, { method = 'GET', body, optional = false, text = false } = {}) {
        const response = await fetcher(address(route), {
            method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30_000),
        });
        if (optional && response.status === 404) return undefined;
        if (!response.ok) throw new Error(`GitLab API ${method} failed: HTTP ${response.status}.`);
        return text ? response.text() : response.json();
    }
    async function list(route) {
        const output = [];
        for (let page = 1; page <= 100; page++) {
            const values = await request(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
            if (!Array.isArray(values)) throw new Error('Invalid GitLab list response.');
            output.push(...values);
            if (values.length < 100) return output;
        }
        throw new Error('GitLab pagination exceeded 100 pages.');
    }
    async function download(route, destination, { maxBytes = 512 * 1024 * 1024 } = {}) {
        const signal = AbortSignal.timeout(300_000);
        let url = new URL(address(route));
        let response;
        // 制品可能重定向到对象存储；跨域后永远不再发送 GitLab token。
        let authenticated = true;
        for (let redirects = 0; redirects <= 5; redirects++) {
            response = await fetcher(url, { headers: authenticated ? headers : {}, redirect: 'manual', signal });
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            const location = response.headers.get('location');
            if (!location || redirects === 5) throw new Error('Invalid GitLab artifact redirect.');
            const next = new URL(location, url);
            if (next.protocol !== 'https:' || next.username || next.password) throw new Error('Unsafe GitLab artifact redirect.');
            authenticated &&= next.origin === base.origin;
            await response.body?.cancel();
            url = next;
        }
        if (!response.ok || !response.body) throw new Error(`GitLab artifact download failed: HTTP ${response.status}.`);
        const temporary = `${destination}.${randomUUID()}.partial`;
        const hash = createHash('sha256');
        let bytes = 0;
        const meter = new Transform({ transform(chunk, encoding, done) {
            bytes += chunk.length;
            if (bytes > maxBytes) return done(new Error(`GitLab artifact exceeds ${maxBytes} bytes.`));
            hash.update(chunk);
            done(null, chunk);
        } });
        try {
            await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
            await rename(temporary, destination);
            return hash.digest('hex');
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
    }
    return { request, list, download };
}
