import { canonicalStateJson, checksumText, deepFreeze, StateStoreError } from './state-core.js';
import { types } from 'node:util';
const itemKey = (field) => (value) => {
    const key = value[field];
    if (typeof key !== 'string' || key.length === 0)
        throw new StateStoreError('STATE_INVALID', `State chunk is missing string field ${field}`);
    return key;
};
/**
 * 2.6.0 的扁平布局：list 段每个元素一个分片。
 * 恢复时会按日志行声明的布局选择规格，因此旧目录仍能完整回放。
 */
export const LEGACY_SEGMENT_SPECS = Object.freeze({
    tasks: { kind: 'list', keyOf: itemKey('taskId') },
    delegations: { kind: 'list', keyOf: itemKey('delegationId') },
    threads: { kind: 'list', keyOf: itemKey('threadId') },
    contexts: { kind: 'list', keyOf: itemKey('ref') },
    agentControls: { kind: 'list', keyOf: itemKey('childId') },
    bindings: { kind: 'dict' },
    bindingHistory: { kind: 'dict' },
    messages: { kind: 'dict' },
    messageAcks: { kind: 'dict' },
    experiences: { kind: 'dict' },
    budgets: { kind: 'dict' },
    planningBudgets: { kind: 'dict' }
});
/** 3加入独立安全段；4加入经验治理语义围栏。旧指纹不可随新字段改变。 */
export const LAYOUT_VERSION = 4;
/**
 * dsh-agent-swarm 的状态分片规格；通用 state-store 不假定任何段名，
 * 调用方（feature-session）注入本规格后才会获得分片级增量收益。
 */
export const PRE_GUARD_SEGMENT_SPECS = Object.freeze({
    tasks: { kind: 'list', keyOf: itemKey('taskId') },
    // 委派按任务分桶：段内分片数 = 任务数，而不是历史委派总数。
    delegations: { kind: 'list', keyOf: itemKey('delegationId'), bucketOf: itemKey('taskId') },
    threads: { kind: 'list', keyOf: itemKey('threadId') },
    contexts: { kind: 'list', keyOf: itemKey('ref') },
    agentControls: { kind: 'list', keyOf: itemKey('childId') },
    bindings: { kind: 'dict' },
    bindingHistory: { kind: 'dict' },
    messages: { kind: 'dict' },
    messageAcks: { kind: 'dict' },
    experiences: { kind: 'dict' },
    budgets: { kind: 'dict' },
    planningBudgets: { kind: 'dict' }
});
export const SWARM_SEGMENT_SPECS = Object.freeze({
    ...PRE_GUARD_SEGMENT_SPECS,
    runtimeControls: { kind: 'dict' },
    progressHistory: { kind: 'dict' },
    authorizationDecisions: { kind: 'dict' }
});
/**
 * 当前布局的完整 store 选项。
 * 「当前布局 / 旧布局 / 版本号」必须一起改：只改一半会把日志行写成与磁盘不一致的布局。
 */
export const SWARM_LAYOUT_OPTIONS = Object.freeze({
    segments: SWARM_SEGMENT_SPECS,
    legacySegments: LEGACY_SEGMENT_SPECS,
    legacyLayouts: { 1: LEGACY_SEGMENT_SPECS, 2: PRE_GUARD_SEGMENT_SPECS, 3: SWARM_SEGMENT_SPECS },
    layoutVersion: LAYOUT_VERSION
});
const chunkOf = (value) => {
    if (value === undefined)
        throw new StateStoreError('STATE_INVALID', 'State chunk value must not be undefined');
    try {
        return chunkFromEncoded(canonicalStateJson(value));
    }
    catch (error) {
        if (!(error instanceof StateStoreError))
            throw error;
        // 内存态记录可能带 undefined 字段或类原型：与旧的全量提交一致，回退到一次 JSON 往返。
        try {
            return chunkFromEncoded(canonicalStateJson(JSON.parse(JSON.stringify(value))));
        }
        catch (nested) {
            // 回退也失败（例如循环引用）：统一成 STATE_INVALID，而不是把 TypeError 泄露给调用方。
            if (nested instanceof StateStoreError)
                throw nested;
            throw new StateStoreError('STATE_INVALID', 'State chunk value is not serialisable: ' + (nested instanceof Error ? nested.message : String(nested)));
        }
    }
};
// 只缓存内容已规范校验且整棵图不可变的对象；浅冻结并不证明后代不会被验证器修改。
// WeakMap 随状态引用释放，缓存不持有会话或无限增长的编码字符串索引。
const immutableEncodings = new WeakMap();
const isDeeplyFrozen = (value, depth = 0) => {
    if (value === null || typeof value !== 'object')
        return true;
    // Proxy 可在冻结后被撤销；连同嵌套 Proxy 一并排除，保留每次访问时的拒绝语义。
    if (depth > 64 || types.isProxy(value) || !Object.isFrozen(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
        return false;
    return Reflect.ownKeys(value).every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && 'value' in descriptor && isDeeplyFrozen(descriptor.value, depth + 1);
    });
};
/** 已规范化的值保留原引用；重复恢复只复用不可变内容的编码，不省略容器/键校验。 */
const chunkOfVerified = (value) => {
    const object = value !== null && typeof value === 'object' ? value : undefined;
    const cached = object === undefined ? undefined : immutableEncodings.get(object);
    if (cached !== undefined)
        return { ...cached, value };
    // 必须在编码前证明整棵图已冻结，不能依赖 deepFreeze 对外部浅冻结值的短路。
    const immutable = object !== undefined && isDeeplyFrozen(object);
    const encoded = canonicalStateJson(value);
    const content = { encoded, hash: checksumText(encoded), bytes: Buffer.byteLength(encoded, 'utf8') };
    if (immutable)
        immutableEncodings.set(object, Object.freeze(content));
    return { ...content, value: deepFreeze(value) };
};
/** 从已编码的分片重建 Chunk（恢复回放与日志校验共用；不重新编码）。 */
export const chunkFromEncoded = (encoded) => ({
    encoded,
    hash: checksumText(encoded),
    bytes: Buffer.byteLength(encoded, 'utf8'),
    value: deepFreeze(JSON.parse(encoded))
});
const segmentHash = (segment) => {
    if (segment.hash !== undefined)
        return segment.hash;
    const entries = [];
    if (segment.kind === 'whole')
        entries.push(['', segment.chunks.get('')?.hash ?? '']);
    else if (segment.kind === 'list')
        for (const key of segment.order ?? [])
            entries.push([key, segment.chunks.get(key)?.hash ?? '']);
    else
        for (const key of [...segment.chunks.keys()].sort())
            entries.push([key, segment.chunks.get(key).hash]);
    segment.hash = checksumText(canonicalStateJson(entries));
    return segment.hash;
};
/** 分桶段的桶值编码去掉外层方括号后的长度；用于精确累计整份状态字节数。 */
const bucketInnerBytes = (chunk) => chunk === undefined ? 0 : Math.max(0, chunk.bytes - 2);
/** 重建 list 段时保留该段是否为分桶段；分桶标记丢失会让 materialize 不再展开桶值。 */
const listSegment = (order, chunks, bucket) => bucket === true ? { kind: 'list', bucket: true, order, chunks } : { kind: 'list', order, chunks };
const segmentBytes = (name, segment) => {
    if (segment.bytes !== undefined)
        return segment.bytes;
    let inner = 2;
    if (segment.kind === 'whole')
        inner = segment.chunks.get('')?.bytes ?? 0;
    else if (segment.kind === 'list') {
        const keys = segment.order ?? [];
        if (segment.bucket === true) {
            let buckets = 0;
            for (const key of keys) {
                const bytes = bucketInnerBytes(segment.chunks.get(key));
                if (bytes === 0)
                    continue;
                inner += bytes + (buckets === 0 ? 0 : 1);
                buckets++;
            }
        }
        else
            for (const [index, key] of keys.entries())
                inner += (segment.chunks.get(key)?.bytes ?? 0) + (index === 0 ? 0 : 1);
    }
    else {
        const keys = [...segment.chunks.keys()].sort();
        for (const [index, key] of keys.entries())
            inner += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + segment.chunks.get(key).bytes + (index === 0 ? 0 : 1);
    }
    segment.bytes = Buffer.byteLength(JSON.stringify(name), 'utf8') + 1 + inner;
    return segment.bytes;
};
export class ChunkedState {
    segments;
    specs;
    constructor(segments, specs = {}) {
        this.segments = segments;
        this.specs = specs;
    }
    /** 全量分片化任意已校验的规范状态（装载、旧路径提交、快照回放后使用）。 */
    static fromState(state, specs = {}, options = {}) {
        if (state === null || typeof state !== 'object' || Array.isArray(state))
            throw new StateStoreError('STATE_INVALID', 'State must be a plain object');
        const segments = new Map();
        for (const [name, value] of Object.entries(state))
            segments.set(name, ChunkedState.segmentFromValue(name, value, specs, options.verified === true));
        return new ChunkedState(segments, specs);
    }
    static segmentFromValue(name, value, specs = {}, verified = false) {
        const toChunk = verified ? chunkOfVerified : chunkOf;
        const spec = specs[name];
        if (spec?.kind === 'list') {
            if (!Array.isArray(value))
                throw new StateStoreError('STATE_INVALID', `State segment ${name} must be an array`);
            if (spec.bucketOf !== undefined) {
                // 分桶段：同桶元素合并为一个分片，桶间顺序 = 首次出现顺序，桶内保持原顺序。
                const buckets = new Map();
                const order = [];
                for (const item of value) {
                    const bucket = spec.bucketOf(item);
                    if (spec.keyOf !== undefined)
                        spec.keyOf(item);
                    let items = buckets.get(bucket);
                    if (items === undefined) {
                        items = [];
                        buckets.set(bucket, items);
                        order.push(bucket);
                    }
                    items.push(item);
                }
                const chunks = new Map();
                for (const [bucket, items] of buckets)
                    chunks.set(bucket, toChunk(items));
                return { kind: 'list', bucket: true, order, chunks };
            }
            const chunks = new Map();
            const order = [];
            for (const item of value) {
                const key = spec.keyOf(item);
                if (chunks.has(key))
                    throw new StateStoreError('STATE_INVALID', `State segment ${name} has duplicate key`);
                chunks.set(key, toChunk(item));
                order.push(key);
            }
            return { kind: 'list', order, chunks };
        }
        if (spec?.kind === 'dict') {
            if (value === null || typeof value !== 'object' || Array.isArray(value))
                throw new StateStoreError('STATE_INVALID', `State segment ${name} must be an object`);
            const chunks = new Map();
            for (const [key, item] of Object.entries(value))
                chunks.set(key, toChunk(item));
            return { kind: 'dict', chunks };
        }
        return { kind: 'whole', chunks: new Map([['', toChunk(value)]]) };
    }
    /** 组装普通状态视图：未变分片直接复用冻结值引用，不产生深拷贝。 */
    materialize() {
        const result = {};
        for (const [name, segment] of this.segments) {
            if (segment.kind === 'whole')
                result[name] = segment.chunks.get('')?.value;
            else if (segment.kind === 'list') {
                if (segment.bucket === true) {
                    const flat = [];
                    for (const key of segment.order ?? []) {
                        const chunk = segment.chunks.get(key);
                        if (chunk !== undefined)
                            flat.push(...chunk.value);
                    }
                    result[name] = flat;
                }
                else
                    result[name] = (segment.order ?? []).map((key) => segment.chunks.get(key)?.value);
            }
            else {
                const value = {};
                for (const key of [...segment.chunks.keys()].sort())
                    value[key] = segment.chunks.get(key).value;
                result[name] = value;
            }
        }
        return result;
    }
    /** 完整 canonical 编码（快照/迁移用）；与 canonicalStateJson(materialize()) 逐字节一致。 */
    encode() {
        const parts = [...this.segments.keys()].sort().map((name) => JSON.stringify(name) + ':' + this.encodeSegment(this.segments.get(name)));
        return '{' + parts.join(',') + '}';
    }
    encodeSegment(segment) {
        if (segment.kind === 'whole')
            return segment.chunks.get('')?.encoded ?? 'null';
        if (segment.kind === 'list') {
            if (segment.bucket === true) {
                // 分桶段的分片值是数组：去掉外层方括号后按扁平顺序拼接，与 materialize 的展开一致。
                const parts = [];
                for (const key of segment.order ?? []) {
                    const encoded = segment.chunks.get(key)?.encoded;
                    if (encoded === undefined || encoded === '[]')
                        continue;
                    parts.push(encoded.slice(1, -1));
                }
                return '[' + parts.join(',') + ']';
            }
            return '[' + (segment.order ?? []).map((key) => segment.chunks.get(key)?.encoded ?? 'null').join(',') + ']';
        }
        return '{' + [...segment.chunks.keys()].sort().map((key) => JSON.stringify(key) + ':' + segment.chunks.get(key).encoded).join(',') + '}';
    }
    /** 精确的完整状态 UTF-8 字节数（与 encode() 等长）；未变段复用缓存，只做 O(段数) 求和。 */
    getStateBytes() {
        let total = 2;
        const names = [...this.segments.keys()].sort();
        for (const [index, name] of names.entries())
            total += segmentBytes(name, this.segments.get(name)) + (index === 0 ? 0 : 1);
        return total;
    }
    /** 根校验和：段哈希的规范化组合；任何分片内容或顺序变化都会改变它。 */
    rootChecksum() {
        const names = [...this.segments.keys()].sort();
        return checksumText(canonicalStateJson(names.map((name) => [name, segmentHash(this.segments.get(name))])));
    }
    /** 列表段的键序；whole/dict 段返回 undefined。增量日志必须显式记录它。 */
    order(name) { return this.segments.get(name)?.order; }
    /** 现有段名（按段快照与诊断用）；顺序为内部 Map 顺序，不代表规范顺序。 */
    segmentNames() { return [...this.segments.keys()]; }
    /** 单个段的规范编码；与整份状态里该段逐字节一致，按段快照直接落盘。 */
    segmentEncoded(name) {
        const segment = this.segments.get(name);
        return segment === undefined ? undefined : this.encodeSegment(segment);
    }
    /**
     * 单个段的密码学指纹（分片哈希的规范组合）。
     * 与「整份编码的 sha256」不同：它只依赖分片，未变段的结果可直接复用缓存。
     */
    segmentFingerprint(name) {
        const segment = this.segments.get(name);
        return segment === undefined ? undefined : segmentHash(segment);
    }
    /**
     * 预演一次增量补丁：编码新增/替换分片、合并顺序与删除，返回候选分片表与变更清单。
     * 不做校验与上限判断；失败（非法值/键不一致/顺序不完整）抛 STATE_INVALID，调用方保持原状态。
     */
    preview(patch) {
        const segments = new Map(this.segments);
        const encoded = {};
        const touched = [];
        const removed = [];
        let changed = false;
        const recordChunk = (segment, key, chunk) => {
            ;
            (encoded[segment] ??= {})[key] = chunk;
            touched.push({ segment, key, chunk });
        };
        for (const [name, value] of Object.entries(patch.whole ?? {})) {
            const current = segments.get(name);
            // 已声明为 list/dict 的段即使当前缺席也拒绝整段写入：否则段类型会被固化成 whole，
            // 同段后续的分片补丁被拒，且相同字节会因布局不同得到不同根哈希。
            const kind = current?.kind ?? this.specs[name]?.kind ?? 'whole';
            if (kind !== 'whole')
                throw new StateStoreError('STATE_INVALID', `State segment ${name} is not a whole segment; use set/remove for declared segments`);
            const chunk = chunkOf(value);
            const previous = current?.chunks.get('');
            if (previous !== undefined && previous.hash === chunk.hash) {
                // 内容未变：保留已提交分片，但仍登记编码，使同批次里其它段变化时补丁仍然完整。
                ;
                (encoded[name] ??= {})[''] = previous;
                continue;
            }
            segments.set(name, { kind: 'whole', chunks: new Map([['', chunk]]) });
            recordChunk(name, '', chunk);
            changed = true;
        }
        for (const [name, keys] of Object.entries(patch.remove ?? {})) {
            const current = segments.get(name);
            if (current === undefined)
                continue;
            const chunks = new Map(current.chunks);
            const removeKeys = new Set(keys);
            let removedAny = false;
            for (const key of keys) {
                if (!chunks.has(key))
                    continue;
                chunks.delete(key);
                removed.push({ segment: name, key });
                removedAny = true;
            }
            if (!removedAny)
                continue;
            segments.set(name, current.kind === 'list'
                ? listSegment((current.order ?? []).filter((key) => !removeKeys.has(key)), chunks, current.bucket)
                : { kind: 'dict', chunks });
            changed = true;
        }
        for (const [name, entries] of Object.entries(patch.set ?? {})) {
            const current = segments.get(name);
            const spec = this.specs[name];
            const kind = current?.kind ?? spec?.kind ?? 'dict';
            if (kind === 'whole')
                throw new StateStoreError('STATE_INVALID', `State segment ${name} is a whole segment; declare SegmentSpecs for it or write it via whole`);
            const chunks = new Map(current?.chunks ?? []);
            const order = kind === 'list' ? [...(current?.order ?? [])] : undefined;
            const orderKeys = order === undefined ? undefined : new Set(order);
            let segmentChanged = false;
            for (const [key, value] of Object.entries(entries)) {
                if (value === undefined)
                    throw new StateStoreError('STATE_INVALID', `State segment ${name} set.${key} must not be undefined`);
                // 分桶段的键是桶键，值必须是该桶的元素数组：否则会在 materialize 时才暴露出类型错位。
                if (spec?.bucketOf !== undefined && !Array.isArray(value))
                    throw new StateStoreError('STATE_INVALID', `State segment ${name} set.${key} must be an array of bucket items`);
                // 非分桶 list 段要求 set 的键与元素身份一致；分桶段的键是桶键，不对应元素字段。
                if (spec?.keyOf !== undefined && spec.bucketOf === undefined && spec.keyOf(value) !== key)
                    throw new StateStoreError('STATE_INVALID', `State segment ${name} key does not match the value identity`);
                const existing = chunks.get(key);
                const chunk = chunkOf(value);
                if (existing !== undefined && existing.hash === chunk.hash) {
                    // 与已提交分片逐字节一致：不记入触碰清单，但保留编码供同一批次写入。
                    ;
                    (encoded[name] ??= {})[key] = existing;
                    continue;
                }
                chunks.set(key, chunk);
                if (order !== undefined && orderKeys !== undefined && !orderKeys.has(key)) {
                    order.push(key);
                    orderKeys.add(key);
                }
                recordChunk(name, key, chunk);
                segmentChanged = true;
                changed = true;
            }
            if (segmentChanged)
                segments.set(name, kind === 'list'
                    ? listSegment(order ?? [], chunks, current?.bucket ?? spec?.bucketOf !== undefined)
                    : { kind: 'dict', chunks });
        }
        for (const [name, order] of Object.entries(patch.order ?? {})) {
            const current = segments.get(name);
            if (current === undefined)
                throw new StateStoreError('STATE_INVALID', `State order references missing segment ${name}`);
            if (current.kind !== 'list')
                throw new StateStoreError('STATE_INVALID', `State segment ${name} is not a list segment`);
            if (new Set(order).size !== order.length)
                throw new StateStoreError('STATE_INVALID', `State segment ${name} order contains duplicate keys`);
            for (const key of order)
                if (!current.chunks.has(key))
                    throw new StateStoreError('STATE_INVALID', `State segment ${name} order references missing key`);
            const requested = new Set(order);
            for (const key of current.chunks.keys())
                if (!requested.has(key))
                    throw new StateStoreError('STATE_INVALID', `State segment ${name} has chunk missing from order`);
            const previous = current.order ?? [];
            if (previous.length === order.length && order.every((key, index) => previous[index] === key))
                continue;
            segments.set(name, listSegment([...order], current.chunks, current.bucket));
            changed = true;
        }
        return { next: new ChunkedState(segments, this.specs), encoded, touched, removed, changed };
    }
    /**
     * 恢复回放：把一条日志行里的编码分片合并进当前分片表。
     * 只做结构合并与编码字符串校验；根哈希/链校验由调用方完成。
     */
    applyEncoded(changes) {
        const segments = new Map(this.segments);
        const chunkList = (entries) => {
            if (entries === undefined)
                return [];
            return Object.entries(entries).map(([key, encoded]) => {
                if (typeof encoded !== 'string')
                    throw new StateStoreError('STATE_INVALID', 'State journal chunk must be an encoded string');
                return [key, chunkFromEncoded(encoded)];
            });
        };
        for (const [name, change] of Object.entries(changes)) {
            if (/^(?:api[_-]?key|password|authorization|credentials|private[_-]?key)$/i.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))
                throw new StateStoreError('STATE_INVALID', 'State journal contains an unsafe segment name');
            if (change === null || typeof change !== 'object')
                throw new StateStoreError('STATE_INVALID', `State journal segment ${name} must be an object`);
            if (change.whole !== undefined) {
                segments.set(name, { kind: 'whole', chunks: new Map([['', chunkFromEncoded(change.whole)]]) });
                continue;
            }
            const current = segments.get(name);
            const spec = this.specs[name];
            // 与 preview 对称：段首次出现时按其声明类型创建；既未声明又不在当前状态里的段仍然拒绝。
            if (current === undefined && spec === undefined)
                throw new StateStoreError('STATE_INVALID', `State journal references unknown segment ${name} without a whole chunk`);
            const kind = current?.kind ?? spec.kind;
            const chunks = new Map(current?.chunks ?? []);
            const removeKeys = new Set(change.remove ?? []);
            for (const key of removeKeys)
                chunks.delete(key);
            const order = kind === 'list' ? [...(current?.order ?? [])].filter((key) => !removeKeys.has(key)) : undefined;
            const orderKeys = order === undefined ? undefined : new Set(order);
            for (const [key, chunk] of chunkList(change.set)) {
                chunks.set(key, chunk);
                if (order !== undefined && orderKeys !== undefined && !orderKeys.has(key)) {
                    order.push(key);
                    orderKeys.add(key);
                }
            }
            if (kind === 'list') {
                const finalOrder = change.order === undefined ? order ?? [] : [...change.order];
                if (new Set(finalOrder).size !== finalOrder.length)
                    throw new StateStoreError('STATE_INVALID', `State journal segment ${name} order contains duplicate keys`);
                const finalOrderKeys = new Set(finalOrder);
                for (const key of finalOrder)
                    if (!chunks.has(key))
                        throw new StateStoreError('STATE_INVALID', `State journal segment ${name} order references missing key`);
                for (const key of chunks.keys())
                    if (!finalOrderKeys.has(key))
                        throw new StateStoreError('STATE_INVALID', `State journal segment ${name} has chunk missing from order`);
                // 按该段自身（或声明）的布局决定是否分桶；回放不得依赖“上一层调用方传了什么”。
                segments.set(name, listSegment(finalOrder, chunks, current?.bucket ?? spec?.bucketOf !== undefined));
            }
            else {
                segments.set(name, { kind: 'dict', chunks });
            }
        }
        return new ChunkedState(segments, this.specs);
    }
}
/** 校验补丁结构（不编码值）；非法补丁在触碰任何状态前被拒绝。 */
export const normalizeStatePatch = (patch) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
        throw new StateStoreError('STATE_INVALID', 'State patch must be an object');
    const raw = patch;
    if (Object.keys(raw).some((key) => !['set', 'remove', 'order', 'whole'].includes(key)))
        throw new StateStoreError('STATE_INVALID', 'State patch contains unknown fields');
    const table = (value, label) => {
        if (value === undefined)
            return {};
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            throw new StateStoreError('STATE_INVALID', `State patch ${label} must be an object`);
        for (const name of Object.keys(value)) {
            if (/^(?:api[_-]?key|password|authorization|credentials|private[_-]?key)$/i.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))
                throw new StateStoreError('STATE_INVALID', 'State patch contains an unsafe segment name');
        }
        return value;
    };
    const strings = (value, label) => {
        const result = {};
        for (const [name, list] of Object.entries(table(value, label))) {
            if (!Array.isArray(list) || list.some((key) => typeof key !== 'string' || key.length === 0))
                throw new StateStoreError('STATE_INVALID', `State patch ${label}.${name} must be a string array`);
            result[name] = [...list];
        }
        return result;
    };
    const sets = table(raw.set, 'set');
    for (const [name, entries] of Object.entries(sets)) {
        if (entries === null || typeof entries !== 'object' || Array.isArray(entries))
            throw new StateStoreError('STATE_INVALID', `State patch set.${name} must be an object`);
        for (const key of Object.keys(entries))
            if (key.length === 0)
                throw new StateStoreError('STATE_INVALID', `State patch set.${name} contains an empty key`);
    }
    return { set: sets, remove: strings(raw.remove, 'remove'), order: strings(raw.order, 'order'), whole: table(raw.whole, 'whole') };
};
//# sourceMappingURL=state-chunks.js.map