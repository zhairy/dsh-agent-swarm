import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDedupStore } from './dedup-store.js';
const DEFAULT_INTERVAL_MS = 15_000;
const RECOVERY_DATABASE = /^[a-f0-9]{64}\.sqlite$/;
const getErrorText = (error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
/**
 * 只维护既有恢复作用域数据库的 claim 超时状态。
 * 该模块不申请新 claim、不执行 repair，也不触发任何模型调用。
 */
export const createRecoveryMaintenance = (options) => {
    const directory = resolve(options.directory);
    const now = options.now ?? Date.now;
    let timer;
    const reportError = (operation, error) => {
        const message = `补阙维护失败 operation=${operation} directory=${directory} error=${getErrorText(error)}`;
        try {
            options.log(message);
        }
        catch (logError) {
            console.warn(`${message} loggerError=${getErrorText(logError)}`);
        }
        return message;
    };
    const isEnabled = () => {
        try {
            return options.enabled() === true;
        }
        catch (error) {
            throw new Error(reportError('enabled-check', error), { cause: error });
        }
    };
    const scan = () => {
        let directoryState;
        try {
            directoryState = lstatSync(directory);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw new Error(`directory=${directory}: ${getErrorText(error)}`, { cause: error });
        }
        if (directoryState.isSymbolicLink())
            throw new Error(`directory symlink rejected: ${directory}`);
        if (!directoryState.isDirectory())
            throw new Error(`not a directory: ${directory}`);
        if (realpathSync.native(directory) !== directory)
            throw new Error(`directory alias rejected: ${directory}`);
        const expiresAt = now();
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!RECOVERY_DATABASE.test(entry.name))
                continue;
            const file = join(directory, entry.name);
            let fileState;
            try {
                fileState = lstatSync(file);
            }
            catch (error) {
                throw new Error(`file=${file}: ${getErrorText(error)}`, { cause: error });
            }
            if (fileState.isSymbolicLink())
                throw new Error(`file symlink rejected: ${file}`);
            if (!fileState.isFile())
                continue;
            const store = createDedupStore(file);
            try {
                const expired = store.expireStaleClaims(expiresAt);
                if (expired > 0)
                    options.log(JSON.stringify({ event: 'swarm-repair-stale-claim', file, expired, status: 'manual_required', replay: false }));
            }
            catch (error) {
                throw new Error(`file=${file}: ${getErrorText(error)}`, { cause: error });
            }
            finally {
                store.close();
            }
        }
    };
    const start = () => {
        if (timer !== undefined || !isEnabled())
            return;
        const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
            throw new Error(reportError('start', new Error(`invalid intervalMs=${String(intervalMs)}`)));
        }
        try {
            scan();
        }
        catch (error) {
            throw new Error(reportError('start-scan', error), { cause: error });
        }
        try {
            timer = setInterval(() => {
                try {
                    if (isEnabled())
                        scan();
                }
                catch (error) {
                    reportError('interval-scan', error);
                }
            }, intervalMs);
            timer.unref();
        }
        catch (error) {
            timer = undefined;
            throw new Error(reportError('timer-start', error), { cause: error });
        }
    };
    const dispose = () => {
        if (timer === undefined)
            return;
        clearInterval(timer);
        timer = undefined;
    };
    return { start, dispose };
};
//# sourceMappingURL=maintenance.js.map