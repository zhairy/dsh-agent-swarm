export const OUTPUT_LANGUAGES = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko'] as const
export type OutputLanguage = typeof OUTPUT_LANGUAGES[number]
export const isOutputLanguage = (value: unknown): value is OutputLanguage => OUTPUT_LANGUAGES.some(language => language === value)
export const getOutputLanguage = (value: unknown): OutputLanguage => isOutputLanguage(value) ? value : 'zh-CN'
export const LANGUAGE_NAMES: Readonly<Record<OutputLanguage, string>> = { 'zh-CN': '简体中文', en: 'English', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어' }

/** 预设 persona 里的语言占位符：runtime 行每次组装系统提示时替换为设置页选择的语言名称 */
export const LANGUAGE_PLACEHOLDER = '{$language}'

/** 用目标语言本身书写语言要求：英文写的「请用中文」对多数模型约束力弱，思考过程尤其容易回到英文 */
const RULES: Readonly<Record<OutputLanguage, (explicit: boolean) => string>> = {
  'zh-CN': (explicit) => `输出语言：简体中文（zh-CN）。思考与推理过程、计划、工具调用说明、进度汇报和最终回复一律使用简体中文；代码、标识符、命令、文件路径、JSON 键、公式、引文与专业术语保持原文。${explicit ? '这是本次委派明确指定的语言。' : '用户本轮明确要求其他语言时以用户为准。'}`,
  en: (explicit) => `Output language: English (en). Think, reason, plan, explain tool calls, report progress and write final answers in English; keep code, identifiers, commands, file paths, JSON keys, formulas, quotations and technical terms verbatim. ${explicit ? 'This language was set explicitly for this delegation.' : 'An explicit language request from the user in this turn takes precedence.'}`,
  'zh-TW': (explicit) => `輸出語言：繁體中文（zh-TW）。思考與推理過程、計畫、工具呼叫說明、進度匯報與最終回覆一律使用繁體中文；程式碼、識別字、命令、檔案路徑、JSON 鍵、公式、引文與專業術語保留原文。${explicit ? '這是本次委派明確指定的語言。' : '使用者本輪明確要求其他語言時以使用者為準。'}`,
  ja: (explicit) => `出力言語：日本語（ja）。思考・推論の過程、計画、ツール呼び出しの説明、進捗報告、最終回答はすべて日本語で書くこと。コード、識別子、コマンド、ファイルパス、JSON キー、数式、引用、専門用語は原文のまま残すこと。${explicit ? 'これはこの委任で明示された言語です。' : 'ユーザーがこのターンで別の言語を明示した場合はそれに従うこと。'}`,
  ko: (explicit) => `출력 언어: 한국어(ko). 사고와 추론 과정, 계획, 도구 호출 설명, 진행 보고와 최종 답변은 모두 한국어로 작성합니다. 코드, 식별자, 명령어, 파일 경로, JSON 키, 수식, 인용문과 전문 용어는 원문 그대로 유지합니다. ${explicit ? '이번 위임에서 명시적으로 지정한 언어입니다.' : '사용자가 이번 턴에 다른 언어를 명시하면 그에 따릅니다.'}`
}

/** A visible-output contract, never a model capability/health signal or retry reason. */
export const getLanguageInstruction = (value: unknown, explicit = false): string => RULES[getOutputLanguage(value)](explicit)
