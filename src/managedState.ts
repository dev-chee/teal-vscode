import { isToolchainTarget, type ManagedToolchainTarget } from './platform';

export interface ManagedState {
    directory: string;
    release: string;
    target: ManagedToolchainTarget;
    repository?: string;
    releaseId?: number;
}

/** 缓存随宿主架构和 ABI 隔离；远程环境迁移后不能复用旧平台工具。 */
export function parseManagedState(value: unknown, hostTarget: ManagedToolchainTarget | undefined): ManagedState | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const state = value as Partial<ManagedState>;
    if (typeof state.directory !== 'string' || typeof state.release !== 'string'
        || !isToolchainTarget(state.target) || state.target !== hostTarget) return undefined;
    if (state.repository !== undefined && typeof state.repository !== 'string') return undefined;
    if (state.releaseId !== undefined && (!Number.isSafeInteger(state.releaseId) || state.releaseId <= 0)) return undefined;
    return { directory: state.directory, release: state.release, target: state.target,
        ...(state.repository === undefined ? {} : { repository: state.repository }),
        ...(state.releaseId === undefined ? {} : { releaseId: state.releaseId }) };
}
