import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, readdir, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { intMutex } from './util/mutex.js';
import { StateStoreError, canonicalStateJson, checksumText, checksum, deepFreeze } from './state-core.js';
import { ChunkedState, normalizeStatePatch } from './state-chunks.js';
export { StateStoreError, canonicalStateJson } from './state-core.js';
export const getDirectoryDurability = (platform = process.platform) => platform === 'win32' ? 'windows-best-effort' : 'strict';
/** Validators return structural locations and fixed rule codes, never state values. */
const validationFailureMessage = (result) => {
    if (typeof result !== 'object' || result === null || !Array.isArray(result.issues))
        return 'State schema validation failed';
    const issues = result.issues.slice(0, 3).flatMap((issue) => {
        if (issue === null || typeof issue !== 'object' || typeof issue.path !== 'string' || typeof issue.code !== 'string'
            || issue.path.length > 192 || !/^\$(?:\.[A-Za-z][A-Za-z0-9_]{0,31}|\[\d{1,8}\])*$/.test(issue.path)
            || !/^[A-Z][A-Z0-9_]{0,63}$/.test(issue.code))
            return [];
        return [`${issue.path}: ${issue.code}`];
    });
    return 'State schema validation failed' + (issues.length === 0 ? '' : ` (${issues.join('; ')})`);
};
// Only already-validated private state reaches this copier. Validation remains at every commit boundary.
const copy = (value) => structuredClone(value);
const missing = (error) => error?.code === 'ENOENT';
/**
 * Persist a directory entry after rename. Windows rejects fsync on a directory
 * handle with EPERM even though the already-fsynced file and same-volume rename
 * succeeded. Report that known Node platform limitation explicitly instead of
 * hiding every permission error or claiming Linux-style directory durability.
 */
export const syncDirectory = async (directory, options = {}) => {
    const platform = options.platform ?? process.platform;
    const handle = await (options.openDirectory ?? open)(directory, 'r');
    try {
        await handle.sync();
        return { status: 'synced' };
    }
    catch (error) {
        const code = error?.code;
        const syscall = error?.syscall;
        if (platform === 'win32' && ['EPERM', 'EINVAL', 'ENOTSUP'].includes(code ?? '') && (syscall === undefined || syscall === 'fsync')) {
            return { status: 'unsupported', ...(code === undefined ? {} : { code }) };
        }
        throw error;
    }
    finally {
        await handle.close();
    }
};
export const atomicStateFile = async (directory, name, content) => {
    if (!/^[a-z][a-z0-9.-]*$/i.test(name))
        throw new StateStoreError('STATE_INVALID', 'Unsafe state filename');
    const temporary = join(directory, '.' + name + '.' + randomUUID() + '.tmp');
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    }
    catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
    finally {
        await handle.close();
    }
    try {
        await rename(temporary, join(directory, name));
        await syncDirectory(directory);
    }
    catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
};
/** Conservative local stopped-owner handshake; remote/NFS owners and reused live PIDs are never stolen. */
export const reconcileStoppedStateOwner = async (directory) => {
    const path = join(directory, 'owner.json');
    let raw;
    try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2048)
            return false;
        raw = await readFile(path, 'utf8');
    }
    catch (error) {
        if (missing(error))
            return true;
        throw error;
    }
    let owner;
    try {
        owner = JSON.parse(raw);
    }
    catch {
        return false;
    }
    if (owner.schemaVersion !== 1 || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        return false;
    try {
        process.kill(owner.pid, 0);
        return false;
    }
    catch (error) {
        if (error?.code !== 'ESRCH')
            return false;
    }
    if (await readFile(path, 'utf8') !== raw)
        return false;
    await unlink(path);
    await syncDirectory(directory);
    return true;
};
const snapshotValid = (value) => {
    if (value === null || typeof value !== 'object')
        return false;
    const record = value;
    return record.schemaVersion === 1 && Number.isSafeInteger(record.sequence) && record.sequence >= 0 && typeof record.checksum === 'string' && record.checksum === checksum(record.state);
};
/** 行/快照声明的布局版本：数字版本号才是当前格式；2.6.0 写的是布局哈希，一律视为 legacy。 */
const readStoredLayout = (raw) => typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
/** 旧布局（行里没有数字版本号）在内存中的占位版本；只用于与 `currentLayout` 比较。 */
const LEGACY_LAYOUT = 0;
/** 段布局指纹：段名 + 类型 + 是否分桶。版本号决定「能否续写」，指纹决定「规格是否真的对得上」。 */
const layoutFingerprintOf = (specs) => checksumText(canonicalStateJson(Object.entries(specs).sort(([left], [right]) => left < right ? -1 : 1).map(([name, spec]) => [name, spec.kind, spec.bucketOf !== undefined])));
/** 2.6.0 的布局指纹算法（只含段名与类型）；旧行把它直接写在 `layout` 字段里。 */
const legacyLayoutHashOf = (specs) => checksumText(canonicalStateJson(Object.entries(specs).sort(([left], [right]) => left < right ? -1 : 1).map(([name, spec]) => [name, spec.kind])));
const journalShape = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return Number.isSafeInteger(record.sequence) && record.sequence >= 0 && typeof record.type === 'string'
        && typeof record.previousChecksum === 'string' && typeof record.checksum === 'string' && typeof record.entryChecksum === 'string'
        && (record.schemaVersion === undefined || record.schemaVersion === 1 || record.schemaVersion === 2);
};
/** Complete committed states form the journal. Auditing/redacted ledgers are never recovery inputs. */
export const createDurableStateStore = async (options) => {
    const localDurable = options.enabled !== false;
    const journalDurable = options.beforeCommit !== undefined;
    const maxStateBytes = options.maxStateBytes ?? 4 * 1024 * 1024;
    const maxJournalBytes = options.maxJournalBytes ?? 64 * 1024 * 1024;
    // 增量日志下 journal 增长缓慢：较大周期只会摊薄整份快照成本，不改变恢复正确性。
    const snapshotEvery = options.snapshotEvery ?? 64;
    if (![maxStateBytes, maxJournalBytes, snapshotEvery].every((n) => Number.isSafeInteger(n) && n > 0))
        throw new StateStoreError('STATE_INVALID', 'Invalid state resource limits');
    const validateFull = (value) => {
        const encoded = canonicalStateJson(value);
        const bytes = Buffer.byteLength(encoded, 'utf8');
        if (bytes > maxStateBytes)
            throw new StateStoreError('STATE_TOO_LARGE', 'State exceeds byte limit');
        if (options.validate !== undefined) {
            const result = options.validate(value);
            if (result !== true && (typeof result !== 'object' || result === null || result.ok !== true))
                throw new StateStoreError('STATE_INVALID', validationFailureMessage(result));
        }
        return { value: JSON.parse(encoded), encoded, bytes };
    };
    const assertValidation = (result) => {
        if (result !== true && (typeof result !== 'object' || result === null || result.ok !== true))
            throw new StateStoreError('STATE_INVALID', validationFailureMessage(result));
    };
    const initial = validateFull(options.initialState);
    const segmentSpecs = options.segments ?? {};
    const legacySpecs = options.legacySegments ?? segmentSpecs;
    const currentLayout = options.layoutVersion ?? 1;
    if (!Number.isSafeInteger(currentLayout) || currentLayout < 1)
        throw new StateStoreError('STATE_INVALID', 'Invalid state layout version');
    const currentFingerprint = layoutFingerprintOf(segmentSpecs);
    const legacyLayoutHash = legacyLayoutHashOf(legacySpecs);
    const specsForLayout = (layout) => layout === currentLayout ? segmentSpecs : options.legacyLayouts?.[layout ?? LEGACY_LAYOUT] ?? legacySpecs;
    const fingerprintForLayout = (layout) => layoutFingerprintOf(specsForLayout(layout));
    /** 行声明的布局是否与期望规格一致：新行比对指纹，2.6.0 行比对它自带的布局哈希。 */
    const layoutMatches = (entryLayout, fingerprint, rawLayout) => {
        if (entryLayout === currentLayout)
            return fingerprint === currentFingerprint;
        if (options.legacyLayouts !== undefined && options.legacyLayouts[entryLayout ?? LEGACY_LAYOUT] === undefined)
            return false;
        if (fingerprint !== undefined)
            return fingerprint === layoutFingerprintOf(specsForLayout(entryLayout));
        return rawLayout === legacyLayoutHash;
    };
    // 用旧布局打开的目录在下一次写入时补一条当前布局的全量行；之后的写入才是增量行。
    let needsLayoutCommit = false;
    /** chunked 当前实际使用的布局；迁移前是 LEGACY_LAYOUT，迁移行之后是 currentLayout。 */
    let chunkedLayout = currentLayout;
    let chunked = ChunkedState.fromState(initial.value, segmentSpecs, { verified: true });
    let state = deepFreeze(chunked.materialize());
    let stateBytes = chunked.getStateBytes();
    let stateChecksum = chunked.rootChecksum();
    let sequence = options.journalOnly === true ? options.initialSequence ?? 0 : 0;
    let journalBytes = 0;
    let closed = false;
    let failed = false;
    let directory = resolve(options.directory);
    let ownerPath;
    let ownerIdentity;
    const clearOwnOwner = async () => {
        if (ownerPath === undefined || ownerIdentity === undefined)
            return;
        try {
            const metadata = await lstat(ownerPath, { bigint: true });
            if (!metadata.isFile() || metadata.dev !== ownerIdentity.dev || metadata.ino !== ownerIdentity.ino)
                return;
            await unlink(ownerPath);
            await syncDirectory(directory);
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
    };
    const mutex = intMutex();
    const snapshotDirectory = join(directory, 'snapshot');
    const snapshotSegmentFile = (name, fingerprint) => `${name}.${fingerprint.slice(0, 16)}.json`;
    const pathWithin = (parent, name) => {
        if (!/^[A-Za-z][A-Za-z0-9._-]*\.json$/.test(name))
            throw new StateStoreError('STATE_INVALID', 'Unsafe snapshot file name');
        return join(parent, name);
    };
    const existingFile = async (path) => lstat(path).then(() => true, () => false);
    /** 旧格式：单个 snapshot.json 承载整份状态。只读兼容，不再写入。 */
    const readWholeSnapshot = async () => {
        const snapshotPath = join(directory, 'snapshot.json');
        let raw;
        try {
            const metadata = await lstat(snapshotPath);
            if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxStateBytes + 1024)
                throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot file is invalid');
            raw = await readFile(snapshotPath, 'utf8');
        }
        catch (error) {
            if (missing(error))
                return undefined;
            throw error;
        }
        if (Buffer.byteLength(raw) > maxStateBytes + 1024)
            throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot size is invalid');
        const parsed = JSON.parse(raw);
        if (!snapshotValid(parsed))
            throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot checksum/schema mismatch');
        return parsed;
    };
    /**
     * 按段快照：段文件按内容指纹命名并复用，因此一次快照只写发生变化的分片段，
     * 未变段直接沿用上一次的文件；`meta.json` 最后原子替换，读取方只会看到完整的一代。
     */
    const readSegmentedSnapshot = async () => {
        const metaPath = join(snapshotDirectory, 'meta.json');
        let raw;
        try {
            const metadata = await lstat(metaPath);
            if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
                throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot metadata is invalid');
            raw = await readFile(metaPath, 'utf8');
        }
        catch (error) {
            if (missing(error))
                return undefined;
            throw error;
        }
        let meta;
        try {
            meta = JSON.parse(raw);
        }
        catch {
            throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot metadata is not valid JSON');
        }
        if (meta.schemaVersion !== 1 || !Number.isSafeInteger(meta.sequence) || meta.sequence < 0
            || typeof meta.checksum !== 'string' || meta.segments === null || typeof meta.segments !== 'object' || Array.isArray(meta.segments)) {
            throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot metadata is invalid');
        }
        const metadata = await lstat(snapshotDirectory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
            throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot directory is invalid');
        const state = {};
        for (const [name, entry] of Object.entries(meta.segments)) {
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
                throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot entry is invalid');
            const file = entry.file;
            if (typeof file !== 'string')
                throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot entry is invalid');
            const filePath = pathWithin(snapshotDirectory, file);
            const fileMetadata = await lstat(filePath);
            if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink() || fileMetadata.size > maxStateBytes + 1024)
                throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot segment file is invalid');
            const segmentRaw = await readFile(filePath, 'utf8');
            if (Buffer.byteLength(segmentRaw) > maxStateBytes + 1024)
                throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot segment size is invalid');
            state[name] = JSON.parse(segmentRaw);
        }
        return { sequence: meta.sequence, layout: meta.layout, layoutFingerprint: meta.layoutFingerprint, checksum: meta.checksum, state };
    };
    /** 写一代按段快照；只落盘指纹变化的段文件，然后原子替换 meta.json 并清理上一代的孤儿文件。 */
    const writeSnapshot = async (atSequence) => {
        await mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });
        const directoryMetadata = await lstat(snapshotDirectory);
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink())
            throw new StateStoreError('STATE_INVALID', 'Snapshot directory must be a private directory, not a symlink');
        const segments = {};
        const keep = new Set(['meta.json']);
        for (const name of chunked.segmentNames()) {
            const fingerprint = chunked.segmentFingerprint(name);
            const encoded = chunked.segmentEncoded(name);
            const file = snapshotSegmentFile(name, fingerprint);
            keep.add(file);
            segments[name] = { file, fingerprint };
            if (!await existingFile(join(snapshotDirectory, file)))
                await atomicStateFile(snapshotDirectory, file, encoded);
        }
        await atomicStateFile(snapshotDirectory, 'meta.json', canonicalStateJson({
            schemaVersion: 1, sequence: atSequence, layout: chunkedLayout,
            layoutFingerprint: fingerprintForLayout(chunkedLayout),
            checksum: chunked.rootChecksum(), segments
        }));
        for (const entry of await readdir(snapshotDirectory)) {
            if (!entry.endsWith('.json') || keep.has(entry))
                continue;
            await unlink(join(snapshotDirectory, entry)).catch(() => undefined);
        }
        // 按段快照是同一份数据的更细表示：保留旧整份快照既浪费空间，也会让恢复路径读到过期状态。
        await unlink(join(directory, 'snapshot.json')).catch(() => undefined);
    };
    const clearJournal = async () => { await atomicStateFile(directory, 'journal.jsonl', ''); journalBytes = 0; };
    if (options.enabled !== false) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if ((await lstat(directory)).isSymbolicLink())
            throw new StateStoreError('STATE_INVALID', 'State directory cannot be a symlink');
        directory = await realpath(directory);
        ownerPath = join(directory, 'owner.json');
        try {
            let owner;
            try {
                owner = await open(ownerPath, 'wx', 0o600);
            }
            catch (error) {
                if (error?.code !== 'EEXIST')
                    throw error;
                if (!await reconcileStoppedStateOwner(directory))
                    throw new StateStoreError('OWNER_ACTIVE', 'State owner exists; explicit stopped-owner reconciliation is required');
                try {
                    owner = await open(ownerPath, 'wx', 0o600);
                }
                catch {
                    throw new StateStoreError('OWNER_ACTIVE', 'Another owner won stopped-owner reconciliation');
                }
            }
            try {
                const identity = await owner.stat({ bigint: true });
                ownerIdentity = { dev: identity.dev, ino: identity.ino };
                await owner.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, host: hostname(), ownerId: randomUUID() }));
                await owner.sync();
            }
            finally {
                await owner.close();
            }
            await syncDirectory(directory);
            if (options.journalOnly === true) {
                const validated = validateFull(initial.value);
                chunked = ChunkedState.fromState(validated.value, segmentSpecs, { verified: true });
                chunkedLayout = currentLayout;
                needsLayoutCommit = false;
                state = deepFreeze(chunked.materialize());
                stateBytes = chunked.getStateBytes();
                stateChecksum = chunked.rootChecksum();
            }
            else {
                let snapshot;
                try {
                    // 优先按段快照；没有才回退旧整份快照。两条路径都会在读取后按声明布局重建分片。
                    const segmented = await readSegmentedSnapshot();
                    let loadedState;
                    let loadedLayout;
                    let loadedChecksum;
                    let loadedFingerprint;
                    if (segmented !== undefined) {
                        loadedState = segmented.state;
                        loadedLayout = readStoredLayout(segmented.layout);
                        loadedChecksum = segmented.checksum;
                        loadedFingerprint = segmented.layoutFingerprint;
                        sequence = segmented.sequence;
                    }
                    else {
                        const whole = await readWholeSnapshot();
                        if (whole !== undefined) {
                            loadedState = whole.state;
                            loadedLayout = readStoredLayout(whole.layout);
                            loadedChecksum = whole.checksum;
                            loadedFingerprint = whole.layoutFingerprint;
                            sequence = whole.sequence;
                        }
                    }
                    if (loadedState !== undefined) {
                        if (loadedLayout !== undefined && loadedLayout > currentLayout) {
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot was written by a newer layout version');
                        }
                        if (loadedLayout !== undefined && !layoutMatches(loadedLayout, loadedFingerprint, undefined)) {
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot was written with a different chunk layout');
                        }
                        const validated = validateFull(loadedState);
                        const useCurrent = loadedLayout === currentLayout;
                        chunked = ChunkedState.fromState(validated.value, specsForLayout(loadedLayout), { verified: true });
                        const rebuiltChecksum = chunked.rootChecksum();
                        // 按段快照的校验和是分片根哈希；旧整份快照的是整份编码的 sha256，两者都在此逐字节重建后复核。
                        if (loadedChecksum !== undefined && loadedChecksum !== rebuiltChecksum && loadedChecksum !== checksumText(validated.encoded)) {
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot checksum/schema mismatch');
                        }
                        chunkedLayout = loadedLayout ?? LEGACY_LAYOUT;
                        needsLayoutCommit = !useCurrent;
                        state = deepFreeze(chunked.materialize());
                        stateBytes = chunked.getStateBytes();
                        stateChecksum = rebuiltChecksum;
                        snapshot = { schemaVersion: 1, sequence, checksum: loadedChecksum ?? rebuiltChecksum, state: validated.value, layout: loadedLayout };
                    }
                }
                catch (error) {
                    if (!missing(error))
                        throw error;
                }
                // 旧格式（v1）行的链值不是分片根哈希；单独跟踪，升级后新行一律使用 v2 根哈希链。
                let legacyChecksum = snapshot?.checksum ?? checksumText(initial.encoded);
                let sawUpgradedEntry = false;
                let journal = '';
                let journalPresent = false;
                try {
                    const journalPath = join(directory, 'journal.jsonl');
                    const metadata = await lstat(journalPath);
                    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxJournalBytes)
                        throw new StateStoreError('RECOVERY_REQUIRED', 'Journal file is invalid');
                    journal = await readFile(journalPath, 'utf8');
                    journalPresent = true;
                }
                catch (error) {
                    if (!missing(error))
                        throw error;
                }
                journalBytes = Buffer.byteLength(journal);
                if (journalBytes > maxJournalBytes)
                    throw new StateStoreError('RECOVERY_REQUIRED', 'Journal is oversized');
                // 末尾未换行的是未确认的写入：丢弃这一条尾部记录，已提交记录仍然有效。
                // 磁盘上的残片要在已提交前缀校验通过后原子重写掉，否则下一次追加会与它拼成坏行。
                const tornTail = journal !== '' && !journal.endsWith('\n');
                if (tornTail)
                    journal = journal.slice(0, journal.lastIndexOf('\n') + 1);
                journalBytes = Buffer.byteLength(journal);
                for (const line of journal.split('\n').filter(Boolean)) {
                    const raw = JSON.parse(line);
                    if (!journalShape(raw))
                        throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum/schema mismatch');
                    const entry = raw;
                    const { entryChecksum, ...payload } = entry;
                    if (entryChecksum !== checksumText(canonicalStateJson(payload)))
                        throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum/schema mismatch');
                    if (entry.sequence <= sequence) {
                        // 与快照同序号的行可能来自升级前的 v1 写入（例如压缩时快照已落盘、日志清空未完成的崩溃窗口）：
                        // 它的链值是整份状态的校验和，而不是分片根哈希，必须按代际选择比较基准。
                        const expectedChecksum = entry.schemaVersion === 2 ? stateChecksum : legacyChecksum;
                        if (entry.sequence === sequence && entry.checksum !== expectedChecksum)
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot and journal disagree');
                        continue;
                    }
                    if (entry.sequence !== sequence + 1)
                        throw new StateStoreError('RECOVERY_REQUIRED', 'Journal sequence or ancestry mismatch');
                    if (entry.schemaVersion === 2) {
                        const entryLayout = readStoredLayout(entry.layout);
                        // 目录比代码新：拒绝打开，避免用旧布局改写并破坏后续兼容。
                        if (entryLayout !== undefined && entryLayout > currentLayout) {
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal was written by a newer layout version');
                        }
                        // 版本号只决定能否续写；指纹决定这套规格是否真的对得上目录，防止用错规格静默读出错误状态。
                        if (!layoutMatches(entryLayout, entry.layoutFingerprint, entry.layout)) {
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal was written with a different chunk layout');
                        }
                        const isCurrentLayout = entryLayout === currentLayout;
                        // 当前布局的增量行只能出现在迁移行之后；否则说明日志被人为拼接。
                        if ((entryLayout ?? LEGACY_LAYOUT) !== chunkedLayout && entry.changes !== undefined) {
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal continues incremental entries before the layout migration record');
                        }
                        if (!isCurrentLayout)
                            needsLayoutCommit = true;
                        if (entry.previousChecksum !== stateChecksum)
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal sequence or ancestry mismatch');
                        let next;
                        if (entry.state !== undefined) {
                            next = ChunkedState.fromState(entry.state, specsForLayout(entryLayout), { verified: true });
                        }
                        else if (entry.changes !== null && typeof entry.changes === 'object' && !Array.isArray(entry.changes)) {
                            next = chunked.applyEncoded(entry.changes);
                        }
                        else
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal entry carries neither state nor changes');
                        if (next.rootChecksum() !== entry.checksum)
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum mismatch');
                        if (next.getStateBytes() > maxStateBytes)
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal state exceeds byte limit');
                        chunked = next;
                        chunkedLayout = entryLayout ?? LEGACY_LAYOUT;
                        stateBytes = chunked.getStateBytes();
                        stateChecksum = entry.checksum;
                        sawUpgradedEntry = true;
                    }
                    else {
                        if (sawUpgradedEntry)
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal mixes legacy entries after upgraded entries');
                        if (!snapshotValid(entry))
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum/schema mismatch');
                        if (entry.previousChecksum !== legacyChecksum)
                            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal sequence or ancestry mismatch');
                        const validated = validateFull(entry.state);
                        chunked = ChunkedState.fromState(validated.value, legacySpecs, { verified: true });
                        chunkedLayout = LEGACY_LAYOUT;
                        needsLayoutCommit = true;
                        stateBytes = chunked.getStateBytes();
                        stateChecksum = chunked.rootChecksum();
                        legacyChecksum = entry.checksum;
                    }
                    sequence = entry.sequence;
                }
                // 恢复循环只依赖分片与链校验值；全部行验证通过后再发布最终冻结视图，
                // 避免每条增量重复分配/遍历完整状态。失败路径不发布任何中间状态。
                if (sawUpgradedEntry || sequence > (snapshot?.sequence ?? 0))
                    state = deepFreeze(chunked.materialize());
                if (snapshot === undefined && sequence === 0)
                    await writeSnapshot(0);
                if (tornTail)
                    await atomicStateFile(directory, 'journal.jsonl', journal);
                // The first journal directory entry must be durable before any committed append is acknowledged.
                if (!journalPresent)
                    await clearJournal();
            }
        }
        catch (error) {
            await clearOwnOwner().catch(() => undefined);
            if (error instanceof StateStoreError)
                throw error;
            throw new StateStoreError('RECOVERY_REQUIRED', 'Cannot recover trusted state: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    const appendJournal = async (fields) => {
        const payload = canonicalStateJson(fields);
        const line = canonicalStateJson({ ...fields, entryChecksum: checksumText(payload) }) + '\n';
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (lineBytes > maxJournalBytes)
            throw new StateStoreError('STATE_TOO_LARGE', 'One committed state exceeds the journal capacity');
        try {
            if (journalBytes + lineBytes > maxJournalBytes) {
                await writeSnapshot(sequence);
                await clearJournal();
            }
            const journalPath = join(directory, 'journal.jsonl');
            try {
                if ((await lstat(journalPath)).isSymbolicLink())
                    throw new StateStoreError('STATE_INVALID', 'Journal cannot be a symlink');
            }
            catch (error) {
                if (!missing(error))
                    throw error;
            }
            const handle = await open(journalPath, 'a', 0o600);
            try {
                await handle.writeFile(line, 'utf8');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            journalBytes += lineBytes;
        }
        catch (error) {
            failed = true;
            throw new StateStoreError('RECOVERY_REQUIRED', 'Durable commit failed: ' + (error instanceof Error ? error.message : String(error)));
        }
    };
    const observeJournalCommit = async (observation) => {
        if (options.beforeCommit === undefined)
            return;
        try {
            await options.beforeCommit(observation);
        }
        catch (error) {
            failed = true;
            throw new StateStoreError('RECOVERY_REQUIRED', 'Authoritative event commit failed: ' + (error instanceof Error ? error.message : String(error)));
        }
    };
    const compactIfDue = async () => {
        if (!localDurable || options.journalOnly === true || sequence % snapshotEvery !== 0)
            return;
        try {
            await writeSnapshot(sequence);
            await clearJournal();
        }
        catch {
            failed = true;
        }
    };
    /**
     * 旧布局目录的首次写入：用当前布局重建全部段并补一条全量行。
     * 增量行的分片键依赖布局，因此必须先把当前状态以新布局落盘，后续增量才有意义。
     */
    const migrateLayout = async () => {
        const nextChunked = ChunkedState.fromState(state, segmentSpecs, { verified: true });
        const nextChecksum = nextChunked.rootChecksum();
        if (journalDurable)
            await observeJournalCommit({ kind: 'snapshot', type: 'state/layout-migrated', sequence: sequence + 1,
                previousChecksum: stateChecksum, checksum: nextChecksum, state: copy(state) });
        if (localDurable && options.journalOnly !== true) {
            await appendJournal({ schemaVersion: 2, layout: currentLayout, layoutFingerprint: currentFingerprint, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type: 'state/layout-migrated', state });
        }
        chunked = nextChunked;
        chunkedLayout = currentLayout;
        stateBytes = nextChunked.getStateBytes();
        stateChecksum = nextChecksum;
        sequence++;
        needsLayoutCommit = false;
    };
    const buildChanges = (patch, preview) => {
        const { encoded, next } = preview;
        const changes = {};
        const segments = new Set([...Object.keys(patch.set ?? {}), ...Object.keys(patch.remove ?? {}), ...Object.keys(patch.order ?? {}), ...Object.keys(patch.whole ?? {})]);
        for (const segment of segments) {
            const out = {};
            // 列表段的键序必须显式入日志：canonical JSON 按键名排序对象字段，回放不能依赖 set 的键序。
            const order = next.order(segment);
            if (order !== undefined)
                out.order = [...order];
            const remove = patch.remove?.[segment];
            if (remove !== undefined)
                out.remove = [...remove];
            if (patch.whole !== undefined && segment in patch.whole)
                out.whole = encoded[segment]?.['']?.encoded ?? (() => { throw new StateStoreError('STATE_INVALID', 'Missing encoded whole chunk'); })();
            const set = patch.set?.[segment];
            if (set !== undefined)
                out.set = Object.fromEntries(Object.keys(set).map((key) => {
                    const chunk = encoded[segment]?.[key];
                    if (chunk === undefined)
                        throw new StateStoreError('STATE_INVALID', 'Missing encoded chunk');
                    return [key, chunk.encoded];
                }));
            changes[segment] = out;
        }
        return changes;
    };
    const store = {
        directory, durable: localDurable, recoveryDurable: localDurable || journalDurable, journalOnly: options.journalOnly === true,
        directoryDurability: getDirectoryDurability(), maxStateBytes,
        getStateBytes: () => stateBytes,
        getRootChecksum: () => stateChecksum,
        read: () => { if (closed)
            throw new StateStoreError('STORE_CLOSED', 'State store is closed'); return copy(state); },
        readPath: (path) => {
            if (closed)
                throw new StateStoreError('STORE_CLOSED', 'State store is closed');
            if (path.length > 64)
                throw new StateStoreError('STATE_INVALID', 'State projection path exceeds nesting limit');
            let selected = state;
            for (const key of path) {
                if ((typeof key !== 'string' && (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0)) || ['__proto__', 'constructor', 'prototype'].includes(String(key)))
                    throw new StateStoreError('STATE_INVALID', 'Unsafe state projection path');
                if (selected === null || typeof selected !== 'object')
                    return undefined;
                const descriptor = Object.getOwnPropertyDescriptor(selected, key);
                if (descriptor === undefined)
                    return undefined;
                selected = descriptor.value;
            }
            return copy(selected);
        },
        readFields: (keys) => {
            if (closed)
                throw new StateStoreError('STORE_CLOSED', 'State store is closed');
            const projected = {};
            if (state === null || typeof state !== 'object')
                return projected;
            for (const key of keys) {
                if ((typeof key !== 'string' && typeof key !== 'number') || ['__proto__', 'constructor', 'prototype'].includes(String(key)))
                    throw new StateStoreError('STATE_INVALID', 'Unsafe state projection field');
                const descriptor = Object.getOwnPropertyDescriptor(state, key);
                if (descriptor !== undefined)
                    projected[String(key)] = descriptor.value;
            }
            return copy(projected);
        },
        getSequence: () => sequence,
        commit: (type, mutate) => mutex.run(async () => {
            if (closed)
                throw new StateStoreError('STORE_CLOSED', 'State store is closed');
            if (failed)
                throw new StateStoreError('RECOVERY_REQUIRED', 'A previous durable write failed; reconcile before further commits');
            if (typeof type !== 'string' || type.length < 1 || type.length > 120)
                throw new StateStoreError('STATE_INVALID', 'Invalid event type');
            if (needsLayoutCommit)
                await migrateLayout();
            const draft = copy(state);
            const returned = await mutate(draft);
            const next = validateFull(returned === undefined ? draft : returned);
            const nextChunked = ChunkedState.fromState(next.value, segmentSpecs, { verified: true });
            const nextChecksum = nextChunked.rootChecksum();
            if (journalDurable)
                await observeJournalCommit({ kind: 'snapshot', type, sequence: sequence + 1,
                    previousChecksum: stateChecksum, checksum: nextChecksum, state: copy(next.value) });
            if (localDurable && options.journalOnly !== true)
                await appendJournal({ schemaVersion: 2, layout: currentLayout, layoutFingerprint: currentFingerprint, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type, state: next.value });
            chunked = nextChunked;
            state = deepFreeze(chunked.materialize());
            stateBytes = chunked.getStateBytes();
            stateChecksum = nextChecksum;
            sequence++;
            await compactIfDue();
            return copy(state);
        }),
        update: (type, write) => mutex.run(async () => {
            if (closed)
                throw new StateStoreError('STORE_CLOSED', 'State store is closed');
            if (failed)
                throw new StateStoreError('RECOVERY_REQUIRED', 'A previous durable write failed; reconcile before further commits');
            if (typeof type !== 'string' || type.length < 1 || type.length > 120)
                throw new StateStoreError('STATE_INVALID', 'Invalid event type');
            if (needsLayoutCommit)
                await migrateLayout();
            // build 形式在互斥区内求值：调用方读到的就是本次提交的基线，读-改-写不再有竞态窗口。
            const normalized = normalizeStatePatch('build' in write ? await write.build(state) : write.patch);
            const preview = chunked.preview(normalized);
            // 与已提交分片逐字节一致的补丁不写日志、不消耗序列号：重复提交同一内容保持幂等。
            if (!preview.changed)
                return { sequence, changed: false };
            const nextBytes = preview.next.getStateBytes();
            if (nextBytes > maxStateBytes)
                throw new StateStoreError('STATE_TOO_LARGE', 'State exceeds byte limit');
            // 校验与提交使用同一个冻结视图：校验器看到的字节与被提交的状态完全一致。
            const view = deepFreeze(preview.next.materialize());
            const changed = [...new Map([...preview.removed, ...preview.touched.map(({ segment, key }) => ({ segment, key }))]
                    .map((entry) => [entry.segment + '\u0000' + entry.key, entry])).values()];
            if (options.validateIncremental !== undefined)
                assertValidation(options.validateIncremental(view, changed));
            else if (options.validate !== undefined)
                assertValidation(options.validate(view));
            const nextChecksum = preview.next.rootChecksum();
            const changes = buildChanges(normalized, preview);
            if (journalDurable)
                await observeJournalCommit({ kind: 'patch', type, sequence: sequence + 1,
                    previousChecksum: stateChecksum, checksum: nextChecksum, changes: copy(changes) });
            if (localDurable && options.journalOnly !== true)
                await appendJournal({ schemaVersion: 2, layout: currentLayout, layoutFingerprint: currentFingerprint, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type, changes });
            chunked = preview.next;
            state = view;
            stateBytes = nextBytes;
            stateChecksum = nextChecksum;
            sequence++;
            await compactIfDue();
            return { sequence, changed: true };
        }),
        dispose: () => mutex.run(async () => {
            if (closed)
                return;
            closed = true;
            await clearOwnOwner();
        })
    };
    if (options.recover !== undefined && sequence > 0) {
        try {
            const recovered = validateFull(options.recover(copy(state)));
            if (recovered.encoded !== chunked.encode())
                await store.commit('state/recovered', () => copy(recovered.value));
        }
        catch (error) {
            closed = true;
            await clearOwnOwner().catch(() => undefined);
            throw error;
        }
    }
    return store;
};
//# sourceMappingURL=state-store.js.map