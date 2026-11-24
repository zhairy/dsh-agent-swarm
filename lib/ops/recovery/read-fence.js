import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, openSync, closeSync, fstatSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
const installations = new WeakMap();
const within = (root, target) => { const rel = relative(root, target); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const pin = (scope, target) => {
    scope.assertCurrent();
    if (target === null || typeof target !== 'object' || typeof target.targetKey !== 'string')
        throw new Error('RECOVERY_READ_TARGET_UNVERIFIED');
    const key = target.targetKey;
    if (!isAbsolute(key))
        throw new Error('RECOVERY_READ_TARGET_UNVERIFIED');
    // Linux O_PATH 只锚定 inode，不打开设备/FIFO做数据 I/O；NOFOLLOW 保留 symlink 本身供拒绝。
    const fd = openSync(key, 0x200000 | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(fd), path = `/proc/self/fd/${fd}`;
        if (!stat.isFile())
            throw new Error('RECOVERY_READ_OUTSIDE_PROJECT');
        const actual = realpathSync.native(path);
        if (!within(scope.root, actual) || scope.deniedRoots.some(root => within(root, actual)))
            throw new Error('RECOVERY_READ_OUTSIDE_PROJECT');
        scope.assertCurrent();
        scope.reads++;
        let closed = false;
        const close = () => { if (!closed) {
            closed = true;
            scope.closers.delete(close);
            closeSync(fd);
        } };
        scope.closers.add(close);
        return { target: { ...target, targetKey: path }, close, isOpen: () => !closed };
    }
    catch (error) {
        closeSync(fd);
        throw error;
    }
};
/** 仅修复 AsyncLocalStorage 范围使用 inode 句柄，原 FS 的 UTF-8/字节上限语义原样保留。 */
export const createRecoveryReadFence = (filesystem) => {
    const io = filesystem;
    if (process.platform !== 'linux' || !existsSync('/proc/self/fd') || typeof io.readText !== 'function' || typeof io.processPathFromHostPath !== 'function')
        throw new Error('ISOLATION_UNAVAILABLE: atomic local read seam missing');
    let installation = installations.get(filesystem);
    if (installation === undefined) {
        const record = { storage: new AsyncLocalStorage(), original: new Map(), descriptors: new Map(), wrappers: new Map(), refs: 0, active: 0 };
        try {
            for (const name of ['readText', 'readBytes', 'readByteRange', 'streamText']) {
                if (typeof io[name] !== 'function')
                    continue;
                const original = io[name];
                const wrapped = async function (target, ...args) {
                    const scope = record.storage.getStore();
                    if (scope === undefined)
                        return original.call(this, target, ...args);
                    const pinned = pin(scope, target);
                    if (name === 'streamText') {
                        try {
                            const stream = await original.call(this, pinned.target, ...args);
                            return { async *[Symbol.asyncIterator]() { try {
                                    if (!pinned.isOpen())
                                        throw new Error('RECOVERY_READ_SCOPE_ENDED');
                                    for await (const chunk of stream) {
                                        if (!pinned.isOpen())
                                            throw new Error('RECOVERY_READ_SCOPE_ENDED');
                                        scope.assertCurrent();
                                        yield chunk;
                                    }
                                }
                                finally {
                                    pinned.close();
                                } } };
                        }
                        catch (error) {
                            pinned.close();
                            throw error;
                        }
                    }
                    try {
                        const value = await original.call(this, pinned.target, ...args);
                        scope.assertCurrent();
                        return value;
                    }
                    finally {
                        pinned.close();
                    }
                };
                record.original.set(name, original);
                record.descriptors.set(name, Object.getOwnPropertyDescriptor(io, name));
                record.wrappers.set(name, wrapped);
                io[name] = wrapped;
            }
        }
        catch (error) {
            for (const name of record.original.keys()) {
                const descriptor = record.descriptors.get(name);
                if (descriptor === undefined)
                    delete io[name];
                else
                    Object.defineProperty(io, name, descriptor);
            }
            throw error;
        }
        installations.set(filesystem, record);
        installation = record;
    }
    const record = installation;
    record.refs++;
    let disposed = false;
    const restore = () => {
        if (record.refs !== 0 || record.active !== 0)
            return;
        for (const name of record.original.keys())
            if (io[name] === record.wrappers.get(name)) {
                const descriptor = record.descriptors.get(name);
                if (descriptor === undefined)
                    delete io[name];
                else
                    Object.defineProperty(io, name, descriptor);
            }
        installations.delete(filesystem);
    };
    return {
        run: async (root, assertCurrent, next, deniedRoots = []) => {
            if (disposed || realpathSync.native(root) !== root || io.processPathFromHostPath.call(filesystem, root) !== root
                || [...record.wrappers].some(([name, wrapper]) => io[name] !== wrapper))
                throw new Error('ISOLATION_UNAVAILABLE: read seam drift or unsupported world');
            const scope = { root, deniedRoots: deniedRoots.map(path => realpathSync.native(path)), assertCurrent, reads: 0, closers: new Set() };
            record.active++;
            try {
                return await record.storage.run(scope, async () => { assertCurrent(); const value = await next(); assertCurrent(); if (scope.reads === 0)
                    throw new Error('RECOVERY_READ_WITNESS_MISSING'); return value; });
            }
            finally {
                try {
                    for (const close of scope.closers)
                        close();
                }
                finally {
                    record.active--;
                    restore();
                }
            }
        },
        dispose: () => { if (!disposed) {
            disposed = true;
            record.refs--;
            restore();
        } }
    };
};
//# sourceMappingURL=read-fence.js.map