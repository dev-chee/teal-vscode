import assert from 'node:assert/strict';
import test from 'node:test';
import { LanguageDiagnostics } from '../src/languageDiagnostics';

const uri = { toString: () => 'file:///child/main.tl' };

test('diagnostics preserve owned and external reports while clearing reports owned by another session', () => {
    let owner: string | undefined = 'child';
    const reports: string[][] = [];
    const diagnostics = new LanguageDiagnostics<typeof uri, string>('child', () => owner);
    const publish = (_uri: typeof uri, items: string[]) => { reports.push(items); };
    diagnostics.update(uri, '/child/main.tl', ['current error'], publish);
    owner = 'parent';
    diagnostics.update(uri, '/child/main.tl', ['foreign error'], publish);
    owner = undefined;
    diagnostics.update(uri, '/external/lib.tl', ['dependency error'], publish);
    assert.deepEqual(reports, [['current error'], [], ['dependency error']]);
});

test('ownership changes clear already published parent reports and restore the latest hidden report', () => {
    let owner = 'parent';
    const reports: string[][] = [];
    const diagnostics = new LanguageDiagnostics<typeof uri, string>('parent', () => owner);
    const publish = (_uri: typeof uri, items: string[]) => { reports.push(items); };
    diagnostics.update(uri, '/child/main.tl', ['old disk error'], publish);
    owner = 'child';
    diagnostics.refresh();
    diagnostics.refresh();
    diagnostics.update(uri, '/child/main.tl', ['new disk error'], publish);
    owner = 'parent';
    diagnostics.refresh();
    assert.deepEqual(reports, [['old disk error'], [], [], ['new disk error']]);
});

test('a server clear removes hidden reports so ownership changes cannot resurrect old errors', () => {
    let owner = 'child';
    const reports: string[][] = [];
    const diagnostics = new LanguageDiagnostics<typeof uri, string>('parent', () => owner);
    const publish = (_uri: typeof uri, items: string[]) => { reports.push(items); };
    diagnostics.update(uri, '/child/main.tl', ['old error'], publish);
    diagnostics.update(uri, '/child/main.tl', [], publish);
    owner = 'parent';
    diagnostics.refresh();
    assert.deepEqual(reports, [[], []]);
});

test('disposed diagnostic owners never publish cached reports again', () => {
    let owner = 'child';
    const reports: string[][] = [];
    const diagnostics = new LanguageDiagnostics<typeof uri, string>('parent', () => owner);
    diagnostics.update(uri, '/child/main.tl', ['old error'], (_uri, items) => { reports.push(items); });
    diagnostics.dispose();
    diagnostics.update(uri, '/child/main.tl', ['late error'], (_uri, items) => { reports.push(items); });
    owner = 'parent';
    diagnostics.refresh();
    assert.deepEqual(reports, [[]]);
});
