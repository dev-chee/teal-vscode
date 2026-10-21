import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { isWithinRoot } from './platform';

function key(file: string): string {
    const normalized = path.normalize(file);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 服务端使用规范路径；编辑器仍使用原工作区及已打开文档的路径。 */
export class LanguagePaths {
    private readonly canonical = new Map<string, string>();
    private readonly editor = new Map<string, string>();

    private constructor(private readonly root: string, private readonly canonicalRoot: string) {}

    static async create(root: string, documents: readonly { path: string }[]): Promise<LanguagePaths> {
        const result = new LanguagePaths(root, await realpath(root).catch(() => root));
        for (const document of documents) {
            const canonical = await realpath(document.path).catch(() => result.toCanonical(document.path));
            result.canonical.set(key(document.path), canonical);
            if (!result.editor.has(key(canonical))) result.editor.set(key(canonical), document.path);
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
