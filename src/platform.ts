import * as path from 'node:path';

/** 工具进程必须与工作区处于同一宿主，WSL 窗口中的 Windows UI 宿主不能代替 Linux。 */
export function supportsExecution(platform: NodeJS.Platform, arch: string, remoteName: string | undefined, desktop: boolean): boolean {
    return desktop && arch === 'x64' && (
        (platform === 'win32' && !remoteName)
        || (platform === 'linux' && remoteName === 'wsl')
    );
}

export function executableName(name: string, platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32' ? `${name}.exe` : name;
}

export function sameFilePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
    return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 按宿主平台的路径规则判断包含关系，不能用字符串前缀识别工作区。 */
export function isWithinRoot(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
