/** 插件内嵌的技能：随插件发布在 skills/<name>/SKILL.md，通过 ctx.skills.register 注册到百工模式 */
export declare const EMBEDDED_SKILLS: readonly ['jev-judgments', 'typesafe-ai'];
/** ctx.skills.register 接受的最小形状 */
export interface SkillRegistrationLike {
    name: string;
    description: string;
    content: string;
    source: string;
    path?: string;
}
/** ctx.skills 的最小形状 */
export interface SkillsLike {
    register: (skill: SkillRegistrationLike) => () => void;
}
/**
 * 解析 SKILL.md：读取 frontmatter 里的 name 与 description（支持 `>` 折叠块），其余作为正文
 * @param {string} text - 文件内容
 * @returns {{ name?: string; description?: string; content: string }} 解析结果
 */
export declare const ParseSkillFile: (text: string) => {
    name?: string;
    description?: string;
    content: string;
};
/**
 * 读取内嵌技能
 * @param {string} [root] - 技能目录（测试时可替换）
 * @returns {SkillRegistrationLike[]} 可注册的技能；读不到的文件跳过
 */
export declare const getEmbeddedSkills: (root?: string) => SkillRegistrationLike[];
