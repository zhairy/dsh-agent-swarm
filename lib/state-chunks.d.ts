/**
 * 分片状态模型：把完整状态按顶层段拆成可独立编码、哈希与持久化的分片。
 * 一次提交只重编码/重哈希/写盘“发生变化的分片”，未变分片复用缓存对象。
 * 分片值入库前深冻结；冻结后的引用身份即“内容未变”的可靠信号，配合各存储的写入口脏追踪使用。
 */
export type SegmentKind = 'list' | 'dict' | 'whole';
export interface SegmentSpec {
    readonly kind: SegmentKind;
    /** list 段的元素键；分桶段用它校验桶内元素，可省略。 */
    readonly keyOf?: (value: never) => string;
    /**
     * 分桶键：同桶元素合并进一个分片（分片 key = 桶键，值 = 该桶的元素数组）。
     * 让段内分片数按桶（例如任务）计数，而不是随历史条目线性增长。
     */
    readonly bucketOf?: (value: never) => string;
}
export type SegmentSpecs = Readonly<Record<string, SegmentSpec>>;
/**
 * 2.6.0 的扁平布局：list 段每个元素一个分片。
 * 恢复时会按日志行声明的布局选择规格，因此旧目录仍能完整回放。
 */
export declare const LEGACY_SEGMENT_SPECS: SegmentSpecs;
/** 3加入独立安全段；4加入经验治理语义围栏。旧指纹不可随新字段改变。 */
export declare const LAYOUT_VERSION = 4;
/**
 * dsh-agent-swarm 的状态分片规格；通用 state-store 不假定任何段名，
 * 调用方（feature-session）注入本规格后才会获得分片级增量收益。
 */
export declare const PRE_GUARD_SEGMENT_SPECS: SegmentSpecs;
export declare const SWARM_SEGMENT_SPECS: SegmentSpecs;
/**
 * 当前布局的完整 store 选项。
 * 「当前布局 / 旧布局 / 版本号」必须一起改：只改一半会把日志行写成与磁盘不一致的布局。
 */
export declare const SWARM_LAYOUT_OPTIONS: Readonly<{
    segments: Readonly<Record<string, SegmentSpec>>;
    legacySegments: Readonly<Record<string, SegmentSpec>>;
    legacyLayouts: {
        1: Readonly<Record<string, SegmentSpec>>;
        2: Readonly<Record<string, SegmentSpec>>;
        3: Readonly<Record<string, SegmentSpec>>;
    };
    layoutVersion: 4;
}>;
export interface Chunk {
    /** canonical JSON 编码；与整份状态中该分片的字节完全一致 */
    readonly encoded: string;
    /** sha256(encoded) */
    readonly hash: string;
    /** encoded 的 UTF-8 字节数 */
    readonly bytes: number;
    /** 深冻结的规范值；只读副本，绝不与调用方共享可变引用 */
    readonly value: unknown;
}
export interface Segment {
    readonly kind: SegmentKind;
    /** 分桶 list 段：分片值是元素数组；非分桶 list 段：分片值是单个元素。 */
    readonly bucket?: boolean;
    /** list 段的键序；dict/whole 段为 undefined */
    readonly order?: readonly string[];
    readonly chunks: ReadonlyMap<string, Chunk>;
    /** 段哈希缓存：段对象不可变（chunks/order 只读且不再修改），未变段在预览中按引用复用。 */
    hash?: string;
    /** 段 UTF-8 字节数缓存：未变段复用，变更段只在预览时重算一次。 */
    bytes?: number;
}
/** 调用方提交的增量补丁（值形态；分片编码与冻结由本模块完成）。 */
export interface StatePatch {
    /** segment → key → 新值（list 段的 key 必须与元素内标识一致） */
    readonly set?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    /** segment → 要删除的 key */
    readonly remove?: Readonly<Record<string, readonly string[]>>;
    /** list 段的新键序；省略时按旧序过滤删除项并在尾部追加新增项 */
    readonly order?: Readonly<Record<string, readonly string[]>>;
    /** 整段替换（whole 段或整体重写的小段） */
    readonly whole?: Readonly<Record<string, unknown>>;
}
export interface PreviewedChunk {
    readonly segment: string;
    readonly key: string;
    readonly chunk: Chunk;
}
export interface RemovedChunk {
    readonly segment: string;
    readonly key: string;
}
export interface StatePreview {
    readonly next: ChunkedState;
    readonly encoded: Readonly<Record<string, Readonly<Record<string, Chunk>>>>;
    readonly touched: readonly PreviewedChunk[];
    readonly removed: readonly RemovedChunk[];
    /** 补丁是否真的改变了状态；false 表示所有 set 与已提交分片逐字节一致且无实际删除/顺序变化。 */
    readonly changed: boolean;
}
/** 从已编码的分片重建 Chunk（恢复回放与日志校验共用；不重新编码）。 */
export declare const chunkFromEncoded: (encoded: string) => Chunk;
export declare class ChunkedState {
    private readonly segments;
    private readonly specs;
    private constructor();
    /** 全量分片化任意已校验的规范状态（装载、旧路径提交、快照回放后使用）。 */
    static fromState(state: unknown, specs?: SegmentSpecs, options?: {
        verified?: boolean;
    }): ChunkedState;
    static segmentFromValue(name: string, value: unknown, specs?: SegmentSpecs, verified?: boolean): Segment;
    /** 组装普通状态视图：未变分片直接复用冻结值引用，不产生深拷贝。 */
    materialize(): Record<string, unknown>;
    /** 完整 canonical 编码（快照/迁移用）；与 canonicalStateJson(materialize()) 逐字节一致。 */
    encode(): string;
    private encodeSegment;
    /** 精确的完整状态 UTF-8 字节数（与 encode() 等长）；未变段复用缓存，只做 O(段数) 求和。 */
    getStateBytes(): number;
    /** 根校验和：段哈希的规范化组合；任何分片内容或顺序变化都会改变它。 */
    rootChecksum(): string;
    /** 列表段的键序；whole/dict 段返回 undefined。增量日志必须显式记录它。 */
    order(name: string): readonly string[] | undefined;
    /** 现有段名（按段快照与诊断用）；顺序为内部 Map 顺序，不代表规范顺序。 */
    segmentNames(): readonly string[];
    /** 单个段的规范编码；与整份状态里该段逐字节一致，按段快照直接落盘。 */
    segmentEncoded(name: string): string | undefined;
    /**
     * 单个段的密码学指纹（分片哈希的规范组合）。
     * 与「整份编码的 sha256」不同：它只依赖分片，未变段的结果可直接复用缓存。
     */
    segmentFingerprint(name: string): string | undefined;
    /**
     * 预演一次增量补丁：编码新增/替换分片、合并顺序与删除，返回候选分片表与变更清单。
     * 不做校验与上限判断；失败（非法值/键不一致/顺序不完整）抛 STATE_INVALID，调用方保持原状态。
     */
    preview(patch: StatePatch): StatePreview;
    /**
     * 恢复回放：把一条日志行里的编码分片合并进当前分片表。
     * 只做结构合并与编码字符串校验；根哈希/链校验由调用方完成。
     */
    applyEncoded(changes: Readonly<Record<string, {
        readonly set?: Readonly<Record<string, string>>;
        readonly remove?: readonly string[];
        readonly order?: readonly string[];
        readonly whole?: string;
    }>>): ChunkedState;
}
/** 校验补丁结构（不编码值）；非法补丁在触碰任何状态前被拒绝。 */
export declare const normalizeStatePatch: (patch: unknown) => StatePatch;
