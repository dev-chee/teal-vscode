import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { isWithinRoot } from './platform';

function key(file: string): string {
    const normalized = path.normalize(file);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function mapLimit<T, Result>(values: readonly T[], limit: number, action: (value: T) => Promise<Result>): Promise<Result[]> {
    const output = new Array<Result>(values.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= values.length) return;
            output[index] = await action(values[index]);
        }
    });
    await Promise.all(workers);
    return output;
}

export type ResolvedDocumentPaths = ReadonlyMap<string, string | undefined>;

function uniqueDocuments(documents: readonly { path: string }[]): Map<string, string> {
    const unique = new Map<string, string>();
    for (const document of documents) unique.set(key(document.path), unique.get(key(document.path)) ?? document.path);
    return unique;
}

/** 解析一份打开文档快照；多个工作区根可复用同一结果。 */
export async function resolveDocumentPaths(documents: readonly { path: string }[]): Promise<ResolvedDocumentPaths> {
    const unique = uniqueDocuments(documents);
    return new Map(await mapLimit([...unique.entries()], 16, async ([documentKey, document]) => [
        documentKey,
        await realpath(document).catch(() => undefined),
    ] as const));
}

/** 服务端使用规范路径；编辑器仍使用原工作区及已打开文档的路径。 */
export class LanguagePaths {
    private readonly canonical = new Map<string, string>();
    private readonly editor = new Map<string, string>();

    private constructor(private readonly root: string, private readonly canonicalRoot: string) {}

    static async create(root: string, documents: readonly { path: string }[], resolvedPaths?: ResolvedDocumentPaths): Promise<LanguagePaths> {
        const result = new LanguagePaths(root, await realpath(root).catch(() => root));
        // 分组文档先于跨根快照列出；保留该优先级，同时避免同一路径重复访问远程文件系统。
        const unique = uniqueDocuments(documents);
        const resolved = resolvedPaths ?? await resolveDocumentPaths(documents);
        for (const [documentKey, document] of unique) {
            const canonical = resolved.has(documentKey) ? resolved.get(documentKey) ?? result.toCanonical(document)
                : await realpath(document).catch(() => result.toCanonical(document));
            result.canonical.set(documentKey, canonical);
            if (!result.editor.has(key(canonical))) result.editor.set(key(canonical), document);
        }
        return result;
    }

    toCanonical(file: string): string {
        return this.canonical.get(key(file)) ?? (isWithinRoot(this.root, file)
            ? path.join(this.canonicalRoot, path.relative(this.root, file)) : file);
    }

    toEditor(file: string): string {
        return this.editor.get(key(file)) ?? (isWithinRoot(this.canonicalRoot, file)
            ? path.join(this.root, path.relative(this.canonicalRoot, file)) : file);
    }
}
