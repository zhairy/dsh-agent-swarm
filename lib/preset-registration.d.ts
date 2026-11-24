import type { PluginContextLike } from './host-contract.js';
/** 预设声明（@deepseek-ai/dsh-agent-preset 的 config 形状；插件行原样透传） */
interface PresetDeclarationLike {
    id: string;
    name?: string;
    description?: string;
    order?: number;
    plugins: unknown[];
}
interface LoggerLike {
    info?: (message: string) => void;
    warn: (message: string) => void;
}
/** JSON 里的 {$js} 还原成宿主 loader 的 __jsExpr 节点（loader 以鸭子类型识别并按作用域求值）。 */
export declare const revivePresetExpressions: (value: unknown) => unknown;
/** 从包内 presets/declarations.json 读取 13 个角色预设声明；文件缺失或损坏时抛出，由调用方记录诊断。 */
export declare const loadPresetDeclarations: (moduleUrl?: string | URL) => Promise<PresetDeclarationLike[]>;
/**
 * 0.2.1-alpha 起子智能体由 agentPreset 选择的预设承载 persona 与工具组合；
 * 角色预设默认不在模式列表里，这里按需注册缺失声明并绑定到插件生命周期。
 * 旧宿主（0.2.0-rc.2 及更早）不注册，保持原有的 persona/toolFilter 委派路径与干净的预设列表。
 */
export declare const registerMissingRolePresets: (scoped: PluginContextLike, logger: LoggerLike) => Promise<number>;
/** 仅在宿主提供 0.2.1-alpha 激活协议（startActivation）时注册；失败只记录诊断，不阻断宿主行。 */
export declare const ensureRolePresetsForActivationHost: (ctx: PluginContextLike, logger: LoggerLike) => void;
export {};
