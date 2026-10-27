import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

let stagingDirectory: Promise<string> | undefined;
let sequence = 0;
const stagedExecutables = new Set<string>();

/**
 * Windows keeps a running executable open, which prevents Cargo from replacing
 * target/release/teal.exe during the next build. Run a private copy instead.
 */
export async function stageLanguageServerExecutable(source: string, platform: NodeJS.Platform = process.platform): Promise<string> {
    if (platform !== 'win32') return source;
    const pending = stagingDirectory ??= mkdtemp(path.join(tmpdir(), 'teal-vscode-lsp-'));
    const directory = await pending.catch((error: unknown) => {
        if (stagingDirectory === pending) stagingDirectory = undefined;
        throw error;
    });
    // Temporary-file cleanup may remove the directory between server runs.
    await mkdir(directory, { recursive: true });
    const staged = path.join(directory, `${sequence++}-teal.exe`);
    await copyFile(source, staged);
    stagedExecutables.add(staged);
    return staged;
}

/** Preserve a managed distribution's runtime resources after moving its executable. */
export async function languageServerEnvironment(
    source: string,
    platform: NodeJS.Platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv | undefined> {
    if (platform !== 'win32' || environment.TEAL_RUNTIME_DIR) return undefined;
    const runtime = path.join(path.dirname(source), 'runtime');
    try {
        if ((await stat(runtime)).isDirectory()) return { ...environment, TEAL_RUNTIME_DIR: runtime };
    } catch { /* Development target directories may use embedded runtime data. */ }
    return undefined;
}

export async function releaseLanguageServerExecutable(file: string): Promise<void> {
    if (!stagedExecutables.delete(file)) return;
    await rm(file, { force: true }).catch(() => undefined);
}

export async function disposeLanguageServerExecutables(): Promise<void> {
    const directoryPromise = stagingDirectory;
    stagingDirectory = undefined;
    const files = [...stagedExecutables];
    stagedExecutables.clear();
    await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => undefined)));
    if (directoryPromise) {
        const directory = await directoryPromise.catch(() => undefined);
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
}
