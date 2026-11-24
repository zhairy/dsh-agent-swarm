export declare const OUTPUT_LANGUAGES: readonly ['zh-CN', 'en', 'zh-TW', 'ja', 'ko'];
export type OutputLanguage = typeof OUTPUT_LANGUAGES[number];
export declare const isOutputLanguage: (value: unknown) => value is OutputLanguage;
export declare const getOutputLanguage: (value: unknown) => OutputLanguage;
export declare const LANGUAGE_NAMES: Readonly<Record<OutputLanguage, string>>;
/** 预设 persona 里的语言占位符：runtime 行每次组装系统提示时替换为设置页选择的语言名称 */
export declare const LANGUAGE_PLACEHOLDER = "{$language}";
/** Supersedes earlier implicit preferences without erasing history or overriding explicit user requests. */
export declare const RELAXED_LANGUAGE_INSTRUCTION = "Expert language policy: provider default. Earlier implicit language preferences injected by this plugin do not apply to this expert request. Use the model's normal language behavior; preserve explicit user or task language requests, code, identifiers and schema keys.";
/** Provider IDs are opaque catalog keys; keep saved offline entries and reject unsafe/unbounded values. */
export declare const getLanguageExclusions: (value: unknown) => string[];
/** A visible-output contract, never a model capability/health signal or retry reason. */
export declare const getLanguageInstruction: (value: unknown, explicit?: boolean) => string;
