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
    const document = documents.find((item) => item.uri.scheme === 'file' && !item.isClosed && sameFilePath(item.uri.fsPath, program));
    if (document?.isDirty) await saveDocument(document);
}
