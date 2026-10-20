import { sameFilePath } from './platform';

export interface SourceDocument {
    readonly uri: { readonly scheme: string; readonly fsPath: string };
    readonly isClosed: boolean;
    readonly isDirty: boolean;
    save(): PromiseLike<boolean>;
}

export function isLocalTealDocument(document: { uri: { scheme: string }; languageId: string; isClosed: boolean }): boolean {
    return document.uri.scheme === 'file' && document.languageId === 'teal' && !document.isClosed;
}

export async function saveDocument(document: SourceDocument): Promise<void> {
    if (!await document.save()) throw new Error('The Teal file could not be saved.');
}

/** 同路径的 Git 历史文档和已关闭文档不代表磁盘上将执行的程序。 */
export async function saveProgram(program: string, documents: readonly SourceDocument[]): Promise<void> {
    // 精确路径优先；只有同一磁盘文件的别名才参与回退匹配。
    const candidates = documents.filter(item => item.uri.scheme === 'file' && !item.isClosed);
    let document = candidates.find(item => item.uri.fsPath === program);
    if (!document) {
        for (const candidate of candidates) {
            if (await sameFilePath(candidate.uri.fsPath, program)) { document = candidate; break; }
        }
    }
    if (document?.isDirty) {
        await saveDocument(document);
        // 编辑器可能通过原子替换保存；硬链接别名不再对应同一文件时必须中止。
        if (!await sameFilePath(document.uri.fsPath, program)) throw new Error('The saved document no longer identifies the launch program.');
    }
}
