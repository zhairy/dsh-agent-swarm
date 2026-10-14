export const OUTPUT_LANGUAGES = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko'] as const
export type OutputLanguage = typeof OUTPUT_LANGUAGES[number]
export const isOutputLanguage = (value: unknown): value is OutputLanguage => OUTPUT_LANGUAGES.some(language => language === value)
export const getOutputLanguage = (value: unknown): OutputLanguage => isOutputLanguage(value) ? value : 'zh-CN'
const names: Record<OutputLanguage, string> = { 'zh-CN': '简体中文', en: 'English', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어' }
/** A visible-output contract, never a model capability/health signal or retry reason. */
export const getLanguageInstruction = (value: unknown, explicit = false): string => {
  const language = getOutputLanguage(value)
  return `OUTPUT LANGUAGE: ${names[language]} (${language}). Use this language for visible explanations, summaries and unresolved items. ${explicit ? 'This is the explicit language for this delegation.' : 'A user\'s explicit language request for this turn takes precedence over this default.'} Preserve JSON field names, identifiers, code, formulas, quotations and evidence paths exactly; follow the required output schema.`
}
