interface Publication<Uri, Diagnostic> {
    uri: Uri;
    file: string;
    diagnostics: Diagnostic[];
    publish(uri: Uri, diagnostics: Diagnostic[]): void;
    visible: boolean;
}

/** 保留原始诊断，归属变化时清除旧报告，或在子会话关闭后恢复父报告。 */
export class LanguageDiagnostics<Uri extends { toString(): string }, Diagnostic> {
    private readonly reports = new Map<string, Publication<Uri, Diagnostic>>();
    private disposed = false;

    constructor(private readonly key: string, private readonly owner: (file: string) => string | undefined) {}

    update(uri: Uri, file: string, diagnostics: readonly Diagnostic[], publish: Publication<Uri, Diagnostic>['publish']): void {
        if (this.disposed) return;
        const owner = this.owner(file);
        const report = { uri, file, diagnostics: [...diagnostics], publish, visible: owner === undefined || owner === this.key };
        if (diagnostics.length) this.reports.set(uri.toString(), report);
        else this.reports.delete(uri.toString());
        publish(uri, report.visible ? report.diagnostics : []);
    }

    refresh(): void {
        for (const report of this.reports.values()) {
            const owner = this.owner(report.file);
            const visible = owner === undefined || owner === this.key;
            if (visible !== report.visible) {
                report.visible = visible;
                report.publish(report.uri, visible ? report.diagnostics : []);
            }
        }
    }

    dispose(): void { this.disposed = true; this.reports.clear(); }
}
