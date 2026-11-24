import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, realpath, unlink, lstat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
export class WorkspaceLeaseError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'WorkspaceLeaseError';
    }
}
// The lock key is real cwd only. Profile/root/session never splits a shared workspace lock.
const workspaces = new Map();
const workspaceId = (cwd) => createHash('sha256').update(cwd).digest('hex');
const ownerPath = (state) => join(state.ownerDirectory, 'workspace-' + state.workspaceId + '.json');
const rejectPending = (state, error) => {
    for (const waiter of state.pending.splice(0)) {
        waiter.cleanup();
        waiter.reject(error);
    }
};
// Existing owner files are never automatically reclaimed: read/unlink is not a
// cross-process compare-and-swap, and a dead PID is not a resource-stop proof.
const claimOwner = async (state, lease) => {
    await mkdir(state.ownerDirectory, { recursive: true, mode: 0o700 });
    if ((await lstat(state.ownerDirectory)).isSymbolicLink())
        throw new WorkspaceLeaseError('LEASE_INVALID', 'Owner directory cannot be a symlink');
    let handle;
    try {
        handle = await open(ownerPath(state), 'wx', 0o600);
    }
    catch (error) {
        if (error?.code === 'EEXIST')
            throw new WorkspaceLeaseError('WORKSPACE_BUSY', 'Existing workspace lease requires controlled reconciliation; automatic stale recovery is disabled');
        throw error;
    }
    try {
        await handle.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, host: hostname(), leaseId: lease.leaseId, owner: lease.owner, cwd: state.cwd }));
        await handle.sync();
    }
    finally {
        await handle.close();
    }
};
const pump = async (state) => {
    if (state.pumping || state.active !== undefined || state.mutationUnknown)
        return;
    state.pumping = true;
    try {
        while (state.pending.length > 0 && state.active === undefined && !state.mutationUnknown) {
            const waiter = state.pending.shift();
            waiter.cleanup();
            if (waiter.signal?.aborted) {
                waiter.reject(new WorkspaceLeaseError('ABORTED', 'Lease request cancelled'));
                continue;
            }
            let released = false;
            let releasing;
            const lease = {
                workspaceId: state.workspaceId, cwd: state.cwd, owner: waiter.owner, kind: waiter.kind, leaseEpoch: ++state.epoch, leaseId: randomUUID(),
                release: async (options = {}) => {
                    if (released)
                        return;
                    if (releasing !== undefined)
                        return releasing;
                    if (state.active?.leaseId !== lease.leaseId)
                        throw new WorkspaceLeaseError('LEASE_INVALID', 'Lease no longer owns this workspace');
                    if (options.confirmedStopped === false) {
                        state.mutationUnknown = true;
                        rejectPending(state, new WorkspaceLeaseError('MUTATION_UNKNOWN', 'Side-effect execution is not confirmed stopped'));
                        return;
                    }
                    // A cancelled signal is not proof that a writing child process has stopped.
                    if (waiter.signal?.aborted && options.confirmedStopped !== true && lease.kind !== 'verify') {
                        state.mutationUnknown = true;
                        rejectPending(state, new WorkspaceLeaseError('MUTATION_UNKNOWN', 'Cancelled writer must be reconciled before releasing its lease'));
                        return;
                    }
                    // Publish the single release promise before I/O. Two callers must
                    // never unlink twice across a following owner's wx acquisition.
                    releasing = (async () => {
                        await unlink(ownerPath(state));
                        state.active = undefined;
                        state.mutationUnknown = false;
                        released = true;
                        void pump(state);
                    })();
                    try {
                        await releasing;
                    }
                    catch (error) {
                        releasing = undefined;
                        throw error;
                    }
                }
            };
            try {
                await claimOwner(state, lease);
                if (waiter.signal?.aborted) {
                    await unlink(ownerPath(state));
                    waiter.reject(new WorkspaceLeaseError('ABORTED', 'Lease cancelled before execution'));
                    continue;
                }
                state.active = lease;
                waiter.resolve(lease);
            }
            catch (error) {
                waiter.reject(error);
            }
        }
    }
    finally {
        state.pumping = false;
    }
};
export const createWorkspaceLeaseManager = (options = {}) => {
    const directory = options.ownerDirectory ?? join(tmpdir(), 'dsh-agent-swarm-workspace-owners');
    const get = async (cwd) => {
        const canonical = await realpath(cwd);
        const found = workspaces.get(canonical);
        if (found !== undefined)
            return found;
        const state = { cwd: canonical, workspaceId: workspaceId(canonical), ownerDirectory: directory, epoch: 0, pending: [], pumping: false, mutationUnknown: false };
        workspaces.set(canonical, state);
        return state;
    };
    return {
        peekStatus: (cwd) => {
            let canonical;
            try {
                canonical = realpathSync.native(cwd);
            }
            catch {
                return undefined;
            }
            const state = workspaces.get(canonical);
            if (state === undefined)
                return undefined;
            return { workspaceId: state.workspaceId, busy: state.active !== undefined || state.pumping, mutationUnknown: state.mutationUnknown, ...(state.active === undefined ? {} : { owner: state.active.owner }), leaseEpoch: state.epoch };
        },
        isCurrent: (lease) => {
            let canonical;
            try {
                canonical = realpathSync.native(lease.cwd);
            }
            catch {
                return false;
            }
            const state = workspaces.get(canonical);
            return state?.active?.leaseId === lease.leaseId && state.active.owner === lease.owner
                && state.active.leaseEpoch === lease.leaseEpoch && !state.mutationUnknown;
        },
        acquire: async (cwd, owner, kind, signal, options) => {
            if (!owner || !['write', 'edit', 'verify'].includes(kind))
                throw new WorkspaceLeaseError('LEASE_INVALID', 'Invalid execution lease');
            const state = await get(cwd);
            if (signal?.aborted)
                throw new WorkspaceLeaseError('ABORTED', 'Lease request cancelled');
            if (state.mutationUnknown)
                throw new WorkspaceLeaseError('MUTATION_UNKNOWN', 'Workspace has unreconciled side effects');
            if (options?.wait === false && (state.active !== undefined || state.pumping || state.pending.length > 0))
                throw new WorkspaceLeaseError('WORKSPACE_BUSY', 'Workspace already has an active or pending owner');
            return new Promise((resolve, reject) => {
                const waiter = { owner, kind, ...(signal === undefined ? {} : { signal }), resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
                const abort = () => {
                    const index = state.pending.indexOf(waiter);
                    if (index >= 0) {
                        state.pending.splice(index, 1);
                        waiter.cleanup();
                        reject(new WorkspaceLeaseError('ABORTED', 'Lease request cancelled'));
                    }
                };
                state.pending.push(waiter);
                signal?.addEventListener('abort', abort, { once: true });
                void pump(state);
            });
        },
        getStatus: async (cwd) => {
            const state = await get(cwd);
            return { workspaceId: state.workspaceId, busy: state.active !== undefined || state.pumping, mutationUnknown: state.mutationUnknown, ...(state.active === undefined ? {} : { owner: state.active.owner }), leaseEpoch: state.epoch };
        },
        reconcile: async (cwd, owner, confirmedStopped) => {
            const state = await get(cwd);
            if (!confirmedStopped || state.active?.owner !== owner)
                throw new WorkspaceLeaseError('LEASE_INVALID', 'Reconciliation requires the active owner and verified stopped execution');
            await state.active.release({ confirmedStopped: true });
        },
        reconcileStoppedProcess: async (cwd) => {
            const state = await get(cwd);
            if (state.active !== undefined || state.pumping || state.mutationUnknown)
                return false;
            try {
                await lstat(ownerPath(state));
                return false;
            }
            catch (error) {
                if (error?.code === 'ENOENT')
                    return true;
                throw error;
            }
        }
    };
};
//# sourceMappingURL=workspace-lease.js.map