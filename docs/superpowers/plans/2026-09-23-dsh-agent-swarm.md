# dsh-agent-swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建可安装到 DSH 0.1.7-alpha.2 的 `dsh-agent-swarm` bundle：13 个中文角色预设、衡鉴（规则 + Jev）分流、统一委派工具、证据账本与质量门禁、按订阅配置的模型路由与运行中回退，并通过沙箱中的真实 DSH 集成测试。

**Architecture:** 宿主行 `swarm-core` 提供 `agentSwarm` 服务（配置、路由、策略、Jev、账本、守卫）；预设行 `dsh-agent-swarm/tools` 只挂在天枢预设上，注册 4 个工具；预设行 `dsh-agent-swarm/runtime` 挂在全部 13 个预设上，在预设作用域内处理 `agent/request` 与 `agent/request-error` 的路由改写和回退。角色委派走 `ctx.subagents.start('spawn', …)`，带 persona、toolFilter、agentOptions、outputSchema；原生 Codex/Claude 作为可选升级通道。

**Tech Stack:** TypeScript 5（NodeNext ESM，编译到 `lib/`）、`@deepseek-ai/schemastery`（Config）、vitest + @vitest/coverage-v8、`yaml`（预设生成脚本）、DSH 0.1.7-alpha.2（仅在沙箱 `.sandbox/` 中安装）。

**Spec:** `docs/superpowers/specs/2026-09-23-dsh-agent-swarm-design.md`（以 §13 的沙箱验证结果为准，见下文「已验证宿主事实」）

## Global Constraints

- 目标宿主版本：`0.1.7-alpha.2`；`package.json` 中 `dsh.minVersion: "0.1.7-alpha.2"`，`dsh.testedVersions: ["0.1.7-alpha.2"]`。
- 绝不改动用户本机 DSH（0.1.5-alpha.1）与 `~/.dsh`；所有 DSH 运行都用 `.sandbox/` 下的独立 `DSH_HOME`。
- 绝不读取或打印任何密钥值；doctor 只报告凭据引用是否存在。
- 路由默认值：`qwen-token-plan-cn` 有的模型排在同模型的 `opencode-go` 之前；DeepSeek 官方 provider id 为 `deepseek-official`，模型为 `deepseek-v4-pro` / `deepseek-flash`。
- 代码风格：箭头函数、命名导出、无分号、2 空格、中文 JSDoc 注释；函数前缀 `get/Add/Del/Find/int/Update/Validate`；常量全大写；配置对象类型以 `Info` 结尾。
- 单元测试覆盖率 ≥ 80%（lines/functions/statements），branches ≥ 75%。
- 用编辑工具修改文件；不要用 PowerShell `Set-Content` 改 UTF-8 文件（会按 ANSI 读写导致中文乱码）。
- 提交信息用 conventional commits，并以 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 结尾。

## 已验证宿主事实（沙箱实测，覆盖 spec 中的推测）

| 项 | 实测结果 |
|---|---|
| 工具名 | `read`、`read_image`、`write`、`edit`、`glob`、`grep`、`pwsh`（Windows）/ `bash`、`web_search`、`web_fetch`、`skill`、`subagent`、`workflow` … |
| `tools.restrict` | 未知工具名抛错；作用域内注册的工具名也不能 restrict |
| 子智能体 `toolFilter.allow` | 在 web 式组合（工具全部预设作用域注册）下同样生效，还会隐藏预设作用域工具 |
| `tools.schemas(agent)` | 返回该 agent 可见的工具 schema，用于计算白名单交集 |
| `tools.guard(fn)` | 存在；`fn(execution)` 返回字符串即拒绝；execution 含 `name/arguments/agent` |
| outputSchema | spawn 子智能体获得 `structured_output` 工具；结果在 `run.result.structured` |
| 预设作用域事件 | `agent/request` / `agent/request-error` 能收到根会话和其 spawn 子智能体的事件；子智能体 `session.header.parentSession` 为父会话 id，`agentPreset` 与父会话相同 |
| 回退 | `agent/request-error` 监听返回 `{kind:'retry'}` 后，下一次 `agent/request` 可改写 `provider/model` |
| `run.id` | 等于子会话 id；`start()` 在子智能体首个请求之前 resolve |
| 服务可用时机 | `credentials` 在插件 apply 时尚不可用，运行时 `ctx.get('credentials')` 可用；`attachments.saveImages` 可用 |
| `profileContext` | `{ name, dir, home, startedBundles[] … }` |
| 从 link 安装的包 import `@deepseek-ai/schemastery` | 失败，必须在本包 `dependencies` 中声明 |
| 会话标题请求 | 走主会话模型，`GenerateOptions.purpose = 'session-title'` |
| DeepSeek 官方模型 | `deepseek-flash`（文本+图片）、`deepseek-v4-pro` |
| 预设 id | 仅 `[a-z0-9-]`；声明行 id 约定为 `preset-<id>` |

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` / `tsconfig.json` / `vitest.config.ts` / `vitest.integration.config.ts` / `.gitignore` | 工程配置 |
| `src/host-contract.ts` | 对宿主的全部假设：服务名、工具候选名、宿主对象的最小类型 |
| `src/util/errors.ts` | `SwarmError` 与错误文本 |
| `src/util/live.ts` | volatile 配置读取 |
| `src/util/json-schema.ts` | JSON Schema 子集校验 |
| `src/util/mutex.ts` | 串行锁 |
| `src/util/git.ts` | git 状态快照与改动差集 |
| `src/tool-shape.ts` | 本地 defineTool 等价实现 |
| `src/role-registry.ts` | 13 角色定义、persona、工具需求 |
| `src/contracts.ts` | 各角色 outputSchema、结构化结果校验、证据抽取 |
| `src/routes.ts` | 模型目录、默认路由链、家族、可用性预检、失败分类 |
| `src/policy.ts` | 任务卡校验、门禁规则、Jev 追加门禁、门禁满足判定、预算 |
| `src/jev.ts` | Jev 客户端（脱敏、超时、重试） |
| `src/evidence.ts` | 任务/委派存储、状态机、JSONL 账本 |
| `src/config.ts` | Config schema（volatile）与合并默认值 |
| `src/vision.ts` | 图片路径校验与入库 |
| `src/route-state.ts` | 运行中路由改写与回退状态 |
| `src/delegate.ts` | 委派执行（spawn / 原生后端） |
| `src/service.ts` | `SwarmService`：组合以上模块 |
| `src/index.ts` | 宿主插件：provide 服务、注册守卫 |
| `src/tools.ts` | 预设插件：4 个工具 |
| `src/runtime.ts` | 预设插件：作用域事件监听 |
| `src/preset-builder.ts` | 从 standard 预设派生 13 个预设声明 |
| `scripts/gen-presets.mjs` | 生成 `presets/*.patch.yml` 并更新 `dsh.bundle.patch` |
| `scripts/sandbox.mjs` | 沙箱安装 DSH、建 profile、运行 dsh |
| `scripts/doctor.mjs` / `scripts/sync-dsh.mjs` | 用户侧检查、升级适配 |
| `cordis.patch.yml` / `presets/*.patch.yml` / `locale/*.json` | bundle 内容 |
| `tests/unit/*.test.ts` | 单元测试 |
| `tests/integration/driver/*` / `tests/integration/*.test.ts` | 沙箱集成测试（mock LLM 驱动） |
| `docs/*.md`、`config/*.example.yaml`、`tests/fixtures/*` | 文档、示例、评测样例 |

代码块信息串中的 `file=<路径>` 表示该代码块就是该文件的完整内容。

---

### Task 1: 工程骨架与基础工具

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.integration.config.ts`, `.gitignore`
- Create: `src/host-contract.ts`, `src/util/errors.ts`, `src/util/live.ts`, `src/util/json-schema.ts`, `src/util/mutex.ts`, `src/tool-shape.ts`
- Test: `tests/unit/util.test.ts`, `tests/unit/tool-shape.test.ts`

**Interfaces:**
- Produces: `readLive<T>(value)`, `readLiveObject(raw)`, `ValidateJsonValue(schema, value, path?)`, `JsonSchemaObject`, `SwarmError(code, message)`, `getErrorText(error)`, `intMutex()` → `{ run(task) }`, `getToolDefinition(spec)` → `ToolDefinitionLike`, 宿主最小类型（`AgentLike`、`SubagentsLike`、`LlmLike`、`ToolsLike`、`AttachmentsLike`、`CredentialsLike`、`LlmFailureLike`、`CallConfigLike`、`ContentBlockLike`、`ToolExecutionLike`、`RequestErrorPayloadLike`、`RequestErrorActionLike`、`PluginContextLike`）、常量 `SWARM_SERVICE`、`SPAWN_PROVIDER`、`STRUCTURED_OUTPUT_TOOL`、`CAPABILITY_TOOL_CANDIDATES`、`WRITE_TOOL_NAMES`、`getAgentHeader(agent)`。

- [ ] **Step 1: 写工程配置文件**

````json file=package.json
{
  "name": "dsh-agent-swarm",
  "version": "2.0.0",
  "description": "DSH 中文多智能体插件：13 个中文角色、衡鉴分流、统一委派、证据门禁与模型回退",
  "type": "module",
  "license": "MIT",
  "engines": {
    "node": ">=22.19.0"
  },
  "exports": {
    ".": "./lib/index.js",
    "./tools": "./lib/tools.js",
    "./runtime": "./lib/runtime.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "presets",
    "locale",
    "config",
    "docs",
    "scripts/doctor.mjs",
    "README.md"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "coverage": "vitest run --coverage",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "gen:presets": "node scripts/gen-presets.mjs",
    "sandbox": "node scripts/sandbox.mjs",
    "doctor": "node scripts/doctor.mjs",
    "sync-dsh": "node scripts/sync-dsh.mjs"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "~3.18.4"
  },
  "dsh": {
    "minVersion": "0.1.7-alpha.2",
    "testedVersions": [
      "0.1.7-alpha.2"
    ]
  }
}
````

````json file=tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "lib",
    "rootDir": "src",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src"]
}
````

````ts file=vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 75 }
    }
  }
})
````

````ts file=vitest.integration.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 180000,
    hookTimeout: 900000,
    fileParallelism: false
  }
})
````

````text file=.gitignore
node_modules/
lib/
coverage/
.sandbox/
*.tgz
````

- [ ] **Step 2: 安装开发依赖**

Run: `npm install` 然后 `npm install -D typescript vitest @vitest/coverage-v8 @types/node yaml`
Expected: `node_modules/@deepseek-ai/schemastery` 与 `node_modules/vitest` 存在，`package.json` 出现 `devDependencies`。

- [ ] **Step 3: 写失败的测试**

````ts file=tests/unit/util.test.ts
import { describe, expect, it } from 'vitest'
import { readLive, readLiveObject } from '../../src/util/live.js'
import { ValidateJsonValue } from '../../src/util/json-schema.js'
import { SwarmError, getErrorText } from '../../src/util/errors.js'
import { intMutex } from '../../src/util/mutex.js'
import { getAgentHeader } from '../../src/host-contract.js'

describe('readLive', () => {
  it('解开带 get() 的 volatile 引用，普通值原样返回', () => {
    expect(readLive({ get: () => 3 })).toBe(3)
    expect(readLive('x')).toBe('x')
    expect(readLive(null)).toBe(null)
  })

  it('readLiveObject 逐字段解开，非对象返回空对象', () => {
    expect(readLiveObject({ a: { get: () => 1 }, b: 2 })).toEqual({ a: 1, b: 2 })
    expect(readLiveObject(undefined)).toEqual({})
  })
})

describe('ValidateJsonValue', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const },
      count: { type: 'number' as const },
      ok: { type: 'boolean' as const },
      tags: { type: 'array' as const, items: { type: 'string' as const } },
      level: { type: 'string' as const, enum: ['a', 'b'] }
    },
    required: ['name'],
    additionalProperties: false
  }

  it('合法值无错误', () => {
    expect(ValidateJsonValue(schema, { name: 'n', count: 1, ok: true, tags: ['x'], level: 'a' })).toEqual([])
  })

  it('报告缺失、多余、类型与枚举错误', () => {
    const errors = ValidateJsonValue(schema, { count: 'x', ok: 1, tags: [1], level: 'c', extra: 1 })
    expect(errors).toContain('$.name 缺失')
    expect(errors).toContain('$.extra 不是允许的字段')
    expect(errors).toContain('$.count 必须是数字')
    expect(errors).toContain('$.ok 必须是布尔值')
    expect(errors).toContain('$.tags[0] 必须是字符串')
    expect(errors).toContain('$.level 必须是 a / b 之一')
  })

  it('非对象与非数组报错', () => {
    expect(ValidateJsonValue(schema, 'x')).toEqual(['$ 必须是对象'])
    expect(ValidateJsonValue({ type: 'array' }, {})).toEqual(['$ 必须是数组'])
    expect(ValidateJsonValue({}, 42)).toEqual([])
  })
})

describe('errors', () => {
  it('SwarmError 携带错误码', () => {
    const error = new SwarmError('UNKNOWN_TASK', '未知任务')
    expect(error.code).toBe('UNKNOWN_TASK')
    expect(getErrorText(error)).toBe('未知任务')
    expect(getErrorText('plain')).toBe('plain')
  })
})

describe('intMutex', () => {
  it('串行执行，前一个失败不阻塞后一个', async () => {
    const mutex = intMutex()
    const order: string[] = []
    const slow = mutex.run(async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push('slow')
      throw new Error('boom')
    })
    const fast = mutex.run(async () => {
      order.push('fast')
      return 1
    })
    await expect(slow).rejects.toThrow('boom')
    await expect(fast).resolves.toBe(1)
    expect(order).toEqual(['slow', 'fast'])
  })
})

describe('getAgentHeader', () => {
  it('缺失时返回空对象', () => {
    expect(getAgentHeader(undefined)).toEqual({})
    expect(getAgentHeader({ id: 'a', session: { header: { parentSession: 'p' } } })).toEqual({ parentSession: 'p' })
  })
})
````

````ts file=tests/unit/tool-shape.test.ts
import { describe, expect, it } from 'vitest'
import { getToolDefinition } from '../../src/tool-shape.js'

const spec = {
  name: 'demo_tool',
  description: '演示',
  parameters: {
    type: 'object' as const,
    properties: { role: { type: 'string' as const } },
    required: ['role'],
    additionalProperties: false
  },
  execute: async (args: { role: string }) => ({ echoed: args.role }),
  render: (_args: { role: string }, value: { echoed: string }) => `echo:${value.echoed}`,
  isConcurrencySafe: (args: { role: string }) => args.role === 'read'
}

describe('getToolDefinition', () => {
  it('生成宿主工具形状并渲染文本块', async () => {
    const tool = getToolDefinition(spec)
    expect(tool.name).toBe('demo_tool')
    const value = await tool.execute({ role: 'read' }, { signal: new AbortController().signal })
    expect(value).toEqual({ echoed: 'read' })
    expect(tool.output.render({ role: 'read' }, value)).toEqual([{ type: 'text', text: 'echo:read' }])
  })

  it('参数不合法时抛 INVALID_ARGS', async () => {
    const tool = getToolDefinition(spec)
    await expect(tool.execute({}, { signal: new AbortController().signal })).rejects.toThrow('参数不合法')
  })

  it('isConcurrencySafe 对非法参数返回 false', () => {
    const tool = getToolDefinition(spec)
    expect(tool.isConcurrencySafe?.({ role: 'read' })).toBe(true)
    expect(tool.isConcurrencySafe?.({ role: 'edit' })).toBe(false)
    expect(tool.isConcurrencySafe?.({})).toBe(false)
  })

  it('未声明 isConcurrencySafe 与 timeoutMs 时不输出这两个字段', () => {
    const tool = getToolDefinition({ ...spec, isConcurrencySafe: undefined })
    expect('isConcurrencySafe' in tool).toBe(false)
    expect('timeoutMs' in tool).toBe(false)
    expect(getToolDefinition({ ...spec, timeoutMs: 5 }).timeoutMs).toBe(5)
  })
})
````

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run tests/unit/util.test.ts tests/unit/tool-shape.test.ts`
Expected: FAIL，报 `Failed to load url ../../src/util/live.js`（模块不存在）

- [ ] **Step 5: 写实现**

````ts file=src/host-contract.ts
/**
 * 宿主契约：dsh-agent-swarm 对 DSH 宿主的全部假设集中在此文件
 * 升级 DSH 时优先核对本文件与集成测试（tests/integration）
 */

/** 已验证兼容的最低 DSH 版本 */
export const DSH_MIN_VERSION = '0.1.7-alpha.2'

/** 宿主行提供给预设行的服务名 */
export const SWARM_SERVICE = 'agentSwarm'

/** dsh-base 注册的进程内子智能体后端 */
export const SPAWN_PROVIDER = 'spawn'

/** spawn 在请求 outputSchema 时注入给子智能体的结构化提交工具 */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/** 能力 → 宿主工具候选名（0.1.7-alpha.2 实测） */
export const CAPABILITY_TOOL_CANDIDATES = {
  read: ['read', 'read_image'],
  search: ['glob', 'grep'],
  edit: ['write', 'edit'],
  shell: ['pwsh', 'bash'],
  web: ['web_search', 'web_fetch']
} as const satisfies Record<string, readonly string[]>

/** 角色能力名 */
export type Capability = keyof typeof CAPABILITY_TOOL_CANDIDATES

/** 视为写文件的工具名，守卫据此拒绝只读类角色 */
export const WRITE_TOOL_NAMES: readonly string[] = CAPABILITY_TOOL_CANDIDATES.edit

/** 会话头中本插件读取的字段 */
export interface SessionHeaderLike {
  parentSession?: string
  agentPreset?: string
  cwd?: string
}

/** Agent 的最小形状 */
export interface AgentLike {
  id: string
  session?: { header?: SessionHeaderLike }
}

/** LLM 失败信息 */
export interface LlmFailureLike {
  code?: string
  status?: number
  message?: string
}

/** 一次模型调用的路由配置 */
export interface CallConfigLike {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
  [key: string]: unknown
}

/** 消息内容块 */
export interface ContentBlockLike {
  type: string
  text?: string
  [key: string]: unknown
}

/** 子智能体结果 */
export interface SubagentResultLike {
  output: ContentBlockLike[]
  structured?: unknown
  diagnostic?: string
  stopReason: string
}

/** 子智能体运行句柄 */
export interface SubagentRunLike {
  id: string
  result: Promise<SubagentResultLike>
  dispose: () => Promise<void>
}

/** 一次性子智能体启动请求 */
export interface SubagentStartRequestLike {
  label?: string
  prompt: ContentBlockLike[]
  parent: AgentLike
  signal: AbortSignal
  agentOptions?: { provider: string; model: string; reasoningEffort?: string }
  outputSchema?: object
  maxDepth?: number
  toolFilter?: { allow?: string[]; deny?: string[] }
  persona?: string
}

/** ctx.subagents 的最小形状 */
export interface SubagentsLike {
  start: (name: string, request: SubagentStartRequestLike) => Promise<SubagentRunLike>
  getProvider: (name: string) => { capabilities?: Record<string, boolean> } | undefined
  list: () => string[]
}

/** ctx.llm 的最小形状 */
export interface LlmLike {
  listProviders: () => Array<{ id: string }>
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<{ inputModalities?: readonly string[] }>
}

/** 工具守卫看到的执行信息 */
export interface ToolExecutionLike {
  name: string
  arguments?: unknown
  agent?: AgentLike
}

/** ctx.tools 的最小形状 */
export interface ToolsLike {
  register: (definition: unknown) => () => void
  schemas: (scope?: unknown) => Array<{ name: string }>
  guard: (guard: (execution: ToolExecutionLike) => string | undefined) => () => void
}

/** ctx.attachments 的最小形状 */
export interface AttachmentsLike {
  saveImages: (inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }>) => Promise<readonly unknown[]>
}

/** ctx.credentials 的最小形状 */
export interface CredentialsLike {
  resolve: (ref: string) => Promise<{ value: string } | undefined>
}

/** agent/request-error 的载荷 */
export interface RequestErrorPayloadLike {
  agent: AgentLike
  provider: string
  failure: LlmFailureLike
}

/** agent/request-error 的动作；undefined 表示失败终止 */
export type RequestErrorActionLike = { kind: string } | undefined

/** Cordis 插件上下文中本插件用到的部分 */
export interface PluginContextLike {
  get: (name: string) => unknown
  provide: (name: string, value?: unknown) => () => void
  effect: (execute: () => () => void) => unknown
  on: (name: string, listener: (...args: never[]) => unknown) => unknown
  logger?: (name: string) => { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

/**
 * 读取 agent 会话头
 * @param {AgentLike | undefined} agent - 宿主 agent
 * @returns {SessionHeaderLike} 会话头，缺失时为空对象
 */
export const getAgentHeader = (agent: AgentLike | undefined): SessionHeaderLike => agent?.session?.header ?? {}
````

````ts file=src/util/errors.ts
/** 插件内部错误码 */
export type SwarmErrorCode =
  | 'INVALID_ARGS'
  | 'UNKNOWN_TASK'
  | 'UNKNOWN_ROLE'
  | 'INVALID_TRANSITION'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'UNSUPPORTED_IMAGE'
  | 'SERVICE_UNAVAILABLE'

/** 带稳定错误码的插件错误，工具层把它转成模型可读的错误结果 */
export class SwarmError extends Error {
  readonly code: SwarmErrorCode

  constructor(code: SwarmErrorCode, message: string) {
    super(message)
    this.name = 'SwarmError'
    this.code = code
  }
}

/**
 * 取错误的可读文本
 * @param {unknown} error - 任意抛出值
 * @returns {string} 错误消息
 */
export const getErrorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
````

````ts file=src/util/live.ts
/** 判断是否为 volatile 配置引用（DSH 0.1.7 起 Config 字段值带 get()） */
const isLiveRef = (value: unknown): value is { get: () => unknown } =>
  value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'

/**
 * 读取 volatile 字段的当前值；旧宿主给的普通值原样返回
 * @param {unknown} value - 配置字段值
 * @returns {T} 当前值
 */
export const readLive = <T = unknown>(value: unknown): T => (isLiveRef(value) ? value.get() : value) as T

/**
 * 逐字段读取配置对象的当前值，每次调用都重新读取以便设置页修改即时生效
 * @param {unknown} raw - 插件收到的 Config
 * @returns {Record<string, unknown>} 普通对象
 */
export const readLiveObject = (raw: unknown): Record<string, unknown> => {
  if (raw === null || typeof raw !== 'object') return {}
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, readLive(value)]))
}
````

````ts file=src/util/json-schema.ts
/** 本插件使用的 JSON Schema 子集（同时用作 DSH outputSchema，避免使用宿主可能不支持的关键字） */
export interface JsonSchemaObject {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean'
  description?: string
  properties?: Record<string, JsonSchemaObject>
  required?: readonly string[]
  additionalProperties?: boolean
  items?: JsonSchemaObject
  enum?: readonly string[]
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const ValidateObject = (schema: JsonSchemaObject, value: unknown, path: string): string[] => {
  if (!isPlainObject(value)) return [`${path} 必须是对象`]
  const properties = schema.properties ?? {}
  const missing = (schema.required ?? [])
    .filter((key) => value[key] === undefined)
    .map((key) => `${path}.${key} 缺失`)
  const extra = schema.additionalProperties === false
    ? Object.keys(value).filter((key) => !(key in properties)).map((key) => `${path}.${key} 不是允许的字段`)
    : []
  const nested = Object.entries(properties)
    .filter(([key]) => value[key] !== undefined)
    .flatMap(([key, child]) => ValidateJsonValue(child, value[key], `${path}.${key}`))
  return [...missing, ...extra, ...nested]
}

/**
 * 按 JSON Schema 子集校验值
 * @param {JsonSchemaObject} schema - 校验规则
 * @param {unknown} value - 待校验值
 * @param {string} [path='$'] - 错误信息中的路径前缀
 * @returns {string[]} 违规描述，空数组表示通过
 */
export const ValidateJsonValue = (schema: JsonSchemaObject, value: unknown, path = '$'): string[] => {
  if (schema.enum !== undefined && !schema.enum.includes(value as string)) {
    return [`${path} 必须是 ${schema.enum.join(' / ')} 之一`]
  }
  switch (schema.type) {
    case 'object':
      return ValidateObject(schema, value, path)
    case 'array': {
      if (!Array.isArray(value)) return [`${path} 必须是数组`]
      const items = schema.items
      return items === undefined ? [] : value.flatMap((item, index) => ValidateJsonValue(items, item, `${path}[${index}]`))
    }
    case 'string':
      return typeof value === 'string' ? [] : [`${path} 必须是字符串`]
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [`${path} 必须是数字`]
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} 必须是布尔值`]
    default:
      return []
  }
}
````

````ts file=src/util/mutex.ts
/** 串行锁：同一时刻只执行一个任务 */
export interface MutexInfo {
  run: <T>(task: () => Promise<T>) => Promise<T>
}

/**
 * 创建串行锁；前一个任务失败不会阻塞后续任务
 * @returns {MutexInfo} 锁
 */
export const intMutex = (): MutexInfo => {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run: <T>(task: () => Promise<T>): Promise<T> => {
      const result = tail.then(task, task)
      tail = result.catch(() => undefined)
      return result
    }
  }
}
````

````ts file=src/tool-shape.ts
import type { AgentLike, ContentBlockLike } from './host-contract.js'
import { SwarmError } from './util/errors.js'
import { ValidateJsonValue, type JsonSchemaObject } from './util/json-schema.js'

/** 工具执行上下文中本插件用到的字段 */
export interface ToolExecLike {
  agent?: AgentLike
  signal: AbortSignal
  callId?: string
}

/** 本插件声明工具的方式 */
export interface ToolSpecInfo<A, R> {
  name: string
  description: string
  parameters: JsonSchemaObject
  execute: (args: A, exec: ToolExecLike) => Promise<R>
  render: (args: A, value: R) => string
  isConcurrencySafe?: (args: A) => boolean
  timeoutMs?: number
}

/** 交给 ctx.tools.register 的工具定义（DSH 0.1.7 形状） */
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: JsonSchemaObject
  output: { schema: JsonSchemaObject; render: (args: unknown, value: unknown) => ContentBlockLike[] }
  execute: (args: unknown, exec: ToolExecLike) => Promise<unknown>
  isConcurrencySafe?: (args: unknown) => boolean
  timeoutMs?: number
}

/**
 * 把工具声明转换为宿主工具定义：执行前按参数 schema 校验，结果渲染为文本块
 * 不依赖宿主内部包 @deepseek-ai/dsh-tools，避免第三方包的解析问题
 * @param {ToolSpecInfo<A, R>} spec - 工具声明
 * @returns {ToolDefinitionLike} 可注册的工具定义
 */
export const getToolDefinition = <A, R>(spec: ToolSpecInfo<A, R>): ToolDefinitionLike => {
  const concurrency = spec.isConcurrencySafe
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: spec.render(args as A, value as R) }]
    },
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    ...(concurrency === undefined
      ? {}
      : {
          isConcurrencySafe: (args: unknown) =>
            ValidateJsonValue(spec.parameters, args).length === 0 && concurrency(args as A)
        }),
    execute: async (args, exec) => {
      const violations = ValidateJsonValue(spec.parameters, args)
      if (violations.length > 0) throw new SwarmError('INVALID_ARGS', `参数不合法：${violations.join('；')}`)
      return spec.execute(args as A, exec)
    }
  }
}
````

- [ ] **Step 6: 运行测试确认通过，并通过类型检查**

Run: `npx vitest run tests/unit/util.test.ts tests/unit/tool-shape.test.ts` 然后 `npm run typecheck`
Expected: 全部 PASS；typecheck 无错误输出

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts vitest.integration.config.ts .gitignore src tests
git commit -m "feat: scaffold project with host contract and shared utilities"
```

---

### Task 2: 角色注册表与交付契约

**Files:**
- Create: `src/role-registry.ts`, `src/contracts.ts`
- Test: `tests/unit/role-registry.test.ts`, `tests/unit/contracts.test.ts`

**Interfaces:**
- Consumes: `CAPABILITY_TOOL_CANDIDATES`、`Capability`（Task 1）、`JsonSchemaObject`、`ValidateJsonValue`（Task 1）
- Produces:
  - `ROLE_IDS`、`RoleId`、`DelegableRoleId`、`PermissionLevel`、`WebPolicy`、`SuanHengMode`、`RoleInfo`、`ROLE_INFO_LIST`
  - `isRoleId(v)`、`isDelegableRoleId(v)`、`getRoleInfo(id)`、`FindRoleByPresetId(presetId)`、`getDelegableRoleIds()`、`isEditRole(id)`、`isWriteAllowed(id)`、`getPermissionLabel(id)`、`getWantedTools(id, { allowWeb? })`、`getRoleTag(id)`、`ROLE_TAG_PATTERN`、`getChildPersona(id, mode?)`、`getPresetPersona(id)`、`getRoleCatalogText()`
  - `COMMAND_KINDS`、`SEVERITIES`、`getOutputSchema(role)`、`ValidateStructuredOutput(role, value, mode?)`、`EvidenceItem`、`getEvidenceFromOutput(role, value)`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/role-registry.test.ts
import { describe, expect, it } from 'vitest'
import {
  FindRoleByPresetId,
  ROLE_IDS,
  ROLE_INFO_LIST,
  ROLE_TAG_PATTERN,
  getChildPersona,
  getDelegableRoleIds,
  getPermissionLabel,
  getPresetPersona,
  getRoleCatalogText,
  getRoleInfo,
  getWantedTools,
  isDelegableRoleId,
  isEditRole,
  isRoleId,
  isWriteAllowed
} from '../../src/role-registry.js'

describe('角色注册表', () => {
  it('恰好 13 个角色，id 与预设 id 唯一且预设 id 合法', () => {
    expect(ROLE_INFO_LIST).toHaveLength(13)
    expect(new Set(ROLE_INFO_LIST.map((r) => r.id)).size).toBe(13)
    expect(new Set(ROLE_INFO_LIST.map((r) => r.presetId)).size).toBe(13)
    for (const role of ROLE_INFO_LIST) {
      expect(role.presetId).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(role.presetId).toBe(role.id.replace(/_/g, '-'))
      expect(role.deliverables.length).toBeGreaterThan(0)
      expect(role.triggers.length).toBeGreaterThan(0)
    }
    expect([...ROLE_IDS]).toEqual(ROLE_INFO_LIST.map((r) => r.id))
  })

  it('中文名与 V2 设计稿一致', () => {
    expect(ROLE_INFO_LIST.map((r) => r.name)).toEqual([
      '天枢', '谋定', '枢机', '算衡', '探微', '博闻', '观象', '铸剑', '行舟', '疾风', '御史', '复核', '妙笔'
    ])
  })

  it('权限：只读角色不含 edit/shell，编辑角色含 edit', () => {
    for (const role of ROLE_INFO_LIST) {
      if (role.permission === 'read') {
        expect(role.capabilities).not.toContain('edit')
        expect(role.capabilities).not.toContain('shell')
      }
      if (role.permission === 'workspace-edit') expect(role.capabilities).toContain('edit')
      if (role.permission === 'limited-exec' || role.permission === 'verify') {
        expect(role.capabilities).toContain('shell')
        expect(role.capabilities).not.toContain('edit')
      }
    }
    expect(isEditRole('zhu_jian')).toBe(true)
    expect(isEditRole('fu_he')).toBe(false)
    expect(isWriteAllowed('tian_shu')).toBe(true)
    expect(isWriteAllowed('yu_shi')).toBe(false)
    expect(getPermissionLabel('fu_he')).toBe('验证')
  })

  it('web 策略：博闻始终开放，枢机按需，御史永不', () => {
    expect(getWantedTools('bo_wen')).toContain('web_search')
    expect(getWantedTools('shu_ji')).not.toContain('web_search')
    expect(getWantedTools('shu_ji', { allowWeb: true })).toContain('web_fetch')
    expect(getWantedTools('yu_shi', { allowWeb: true })).not.toContain('web_search')
    expect(getWantedTools('fu_he')).toEqual(expect.arrayContaining(['read', 'glob', 'grep', 'pwsh', 'bash']))
    expect(getWantedTools('fu_he')).not.toContain('write')
  })

  it('查询函数', () => {
    expect(isRoleId('fu_he')).toBe(true)
    expect(isRoleId('nobody')).toBe(false)
    expect(isDelegableRoleId('tian_shu')).toBe(false)
    expect(isDelegableRoleId('miao_bi')).toBe(true)
    expect(getDelegableRoleIds()).toHaveLength(12)
    expect(FindRoleByPresetId('yu-shi')?.id).toBe('yu_shi')
    expect(FindRoleByPresetId(undefined)).toBeUndefined()
    expect(FindRoleByPresetId('standard')).toBeUndefined()
    expect(() => getRoleInfo('nobody' as never)).toThrow('未知角色')
  })

  it('子智能体 persona 带角色标签与交付要求，算衡区分模式', () => {
    const persona = getChildPersona('fu_he')
    expect(persona).toContain('「复核」')
    expect(persona).toContain('structured_output')
    expect(ROLE_TAG_PATTERN.exec(persona)?.[1]).toBe('fu_he')
    expect(getChildPersona('suan_heng', 'verify')).toContain('当前模式：验算')
    expect(getChildPersona('suan_heng')).toContain('当前模式：研算')
    expect(persona).not.toMatch(/\{\{/)
  })

  it('预设 persona：天枢含工作协议与角色目录，其余含职责；只允许 {{model}} 变量', () => {
    const tianShu = getPresetPersona('tian_shu')
    expect(tianShu).toContain('swarm_task_card')
    expect(tianShu).toContain('swarm_accept')
    expect(tianShu).toContain('fu_he 复核')
    expect(getPresetPersona('miao_bi')).toContain('「妙笔」')
    for (const role of ROLE_INFO_LIST) {
      const vars = getPresetPersona(role.id).match(/\{\{[^}]*\}\}/g) ?? []
      expect(vars.every((v) => v === '{{model}}')).toBe(true)
    }
    expect(getRoleCatalogText().split('\n')).toHaveLength(12)
  })
})
````

````ts file=tests/unit/contracts.test.ts
import { describe, expect, it } from 'vitest'
import { getDelegableRoleIds } from '../../src/role-registry.js'
import { ValidateStructuredOutput, getEvidenceFromOutput, getOutputSchema } from '../../src/contracts.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

describe('交付契约', () => {
  it('每个可委派角色都有对象型 schema，且要求 summary 与 unresolved', () => {
    for (const role of getDelegableRoleIds()) {
      const schema = getOutputSchema(role)
      expect(schema.type).toBe('object')
      expect(schema.required).toEqual(expect.arrayContaining(['summary', 'unresolved']))
      expect(schema.additionalProperties).toBe(false)
    }
  })

  it('每个角色的样例结果都通过校验', () => {
    for (const role of getDelegableRoleIds()) {
      const mode = role === 'suan_heng' ? 'research' : undefined
      expect(ValidateStructuredOutput(role, VALID_OUTPUTS[role], mode), role).toEqual([])
    }
  })

  it('复核：pass 必须有命令且全部退出码为 0', () => {
    const base = VALID_OUTPUTS.fu_he as Record<string, unknown>
    expect(ValidateStructuredOutput('fu_he', { ...base, commands: [] })).toContain('复核判定通过时必须至少记录 1 条实际运行的命令')
    const failing = { ...base, commands: [{ command: 'npm test', exitCode: 1, kind: 'unit', summary: '1 失败' }] }
    expect(ValidateStructuredOutput('fu_he', failing)).toContain('复核判定通过，但存在非零退出码的命令')
    expect(ValidateStructuredOutput('fu_he', { ...failing, verdict: 'fail' })).toEqual([])
  })

  it('妙笔候选数、算衡模式、博闻 URL 的语义检查', () => {
    const miaoBi = VALID_OUTPUTS.miao_bi as { candidates: unknown[] }
    expect(ValidateStructuredOutput('miao_bi', { ...miaoBi, candidates: miaoBi.candidates.slice(0, 1) })).toContain('妙笔必须给出 2–3 个候选')
    expect(ValidateStructuredOutput('suan_heng', VALID_OUTPUTS.suan_heng, 'verify')).toContain('算衡模式应为 verify')
    const verify = { ...(VALID_OUTPUTS.suan_heng as object), mode: 'verify', claims: [] }
    expect(ValidateStructuredOutput('suan_heng', verify, 'verify')).toContain('验算必须至少检验 1 条结论')
    const boWen = VALID_OUTPUTS.bo_wen as { sources: Array<Record<string, unknown>> }
    const badSource = { ...boWen, sources: [{ ...boWen.sources[0], url: 'ftp://x' }] }
    expect(ValidateStructuredOutput('bo_wen', badSource)).toContain('博闻的来源必须是 http(s) URL')
  })

  it('结构不合法时只返回 schema 错误', () => {
    expect(ValidateStructuredOutput('yu_shi', { summary: 's' })[0]).toContain('缺失')
    expect(ValidateStructuredOutput('yu_shi', null)).toEqual(['$ 必须是对象'])
  })

  it('从结构化结果抽取证据', () => {
    expect(getEvidenceFromOutput('fu_he', VALID_OUTPUTS.fu_he)[0]).toMatchObject({ kind: 'command', ref: 'npm test', exitCode: 0, commandKind: 'unit' })
    expect(getEvidenceFromOutput('yu_shi', VALID_OUTPUTS.yu_shi)[0]).toMatchObject({ kind: 'finding', severity: 'medium' })
    expect(getEvidenceFromOutput('bo_wen', VALID_OUTPUTS.bo_wen)[0]).toMatchObject({ kind: 'source', ref: 'https://example.com/rfc' })
    expect(getEvidenceFromOutput('xing_zhou', VALID_OUTPUTS.xing_zhou)[0]).toMatchObject({ kind: 'step', exitCode: 0 })
    expect(getEvidenceFromOutput('ji_feng', VALID_OUTPUTS.ji_feng)[0]).toMatchObject({ kind: 'command' })
    expect(getEvidenceFromOutput('guan_xiang', VALID_OUTPUTS.guan_xiang)[0]).toMatchObject({ kind: 'observation' })
    expect(getEvidenceFromOutput('suan_heng', VALID_OUTPUTS.suan_heng)[0]).toMatchObject({ kind: 'claim' })
    expect(getEvidenceFromOutput('tan_wei', VALID_OUTPUTS.tan_wei)[0]).toMatchObject({ kind: 'finding' })
    expect(getEvidenceFromOutput('zhu_jian', VALID_OUTPUTS.zhu_jian)[0]).toMatchObject({ kind: 'file-change' })
    expect(getEvidenceFromOutput('miao_bi', VALID_OUTPUTS.miao_bi)).toEqual([])
    expect(getEvidenceFromOutput('fu_he', undefined)).toEqual([])
  })
})
````

````json file=tests/fixtures/valid-outputs.json
{
  "mou_ding": {
    "summary": "拆成两步", "unresolved": [], "constraints": ["保持 API 兼容"],
    "options": [{ "name": "方案A", "summary": "增量改造", "pros": ["风险低"], "cons": ["耗时"] }],
    "decisions": [{ "point": "是否重写", "recommendation": "不重写", "reason": "收益不足" }], "dependencies": []
  },
  "shu_ji": {
    "summary": "边界清晰", "unresolved": [], "boundaries": ["ws 层"],
    "interfaces": [{ "name": "publish", "contract": "幂等" }],
    "failureScenarios": [{ "scenario": "断线", "impact": "丢消息", "mitigation": "重放" }], "migration": "无", "rollback": "回滚到上一版本"
  },
  "suan_heng": {
    "summary": "增量与全量等价", "unresolved": [], "mode": "research", "premises": ["K 线按时间有序"], "definitions": ["分型"],
    "invariants": ["已确认笔不回改"], "claims": [{ "statement": "增量=全量", "status": "proved", "proofOrCounterexample": "归纳" }],
    "complexity": "O(n)", "numericError": "无浮点累积", "reproducible": [{ "description": "差分脚本", "program": "python diff.py" }]
  },
  "tan_wei": {
    "summary": "找到入口", "unresolved": [],
    "findings": [{ "path": "src/a.ts", "symbol": "run", "callChain": ["main", "run"], "evidence": "L10 调用" }]
  },
  "bo_wen": {
    "summary": "RFC 支持", "unresolved": [],
    "sources": [{ "url": "https://example.com/rfc", "title": "RFC", "date": "2026-01-01", "version": "v2", "points": ["要点"] }]
  },
  "guan_xiang": {
    "summary": "按钮偏移", "unresolved": [], "observations": [{ "region": "右上角", "element": "保存按钮", "evidence": "与网格错位 4px" }],
    "inferences": ["可能是 padding"], "uncertainties": []
  },
  "zhu_jian": { "summary": "实现完成", "unresolved": [], "changedFiles": ["src/a.ts"], "assumptions": [], "toVerify": ["单测"] },
  "xing_zhou": { "summary": "构建成功", "unresolved": [], "steps": [{ "command": "npm run build", "cwd": ".", "exitCode": 0, "artifacts": ["lib/"] }] },
  "ji_feng": { "summary": "改好了", "unresolved": [], "changedFiles": ["hello.txt"], "localChecks": [{ "command": "node -e 1", "exitCode": 0 }] },
  "yu_shi": {
    "summary": "一处中危", "unresolved": [],
    "findings": [{ "severity": "medium", "location": "src/a.ts:10", "issue": "缺少超时", "repro": "断网", "suggestion": "加超时" }]
  },
  "fu_he": {
    "summary": "测试通过", "unresolved": [], "plan": ["跑单测"],
    "commands": [{ "command": "npm test", "exitCode": 0, "kind": "unit", "summary": "12 passed" }], "coverage": "单元测试", "failures": [], "verdict": "pass"
  },
  "miao_bi": {
    "summary": "两个候选", "unresolved": [],
    "candidates": [{ "text": "保存", "scenario": "表单" }, { "text": "存储", "scenario": "设置页" }],
    "recommendation": "保存", "rationale": "最短"
  }
}
````

````ts file=tests/fixtures/valid-outputs.ts
import { readFileSync } from 'node:fs'
import type { DelegableRoleId } from '../../src/role-registry.js'

/** 每个可委派角色一份符合契约的结构化结果；JSON 源同时被集成测试的 mock 驱动读取 */
export const VALID_OUTPUTS: Record<DelegableRoleId, unknown> = JSON.parse(
  readFileSync(new URL('./valid-outputs.json', import.meta.url), 'utf8')
)
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/role-registry.test.ts tests/unit/contracts.test.ts`
Expected: FAIL，模块 `src/role-registry.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/role-registry.ts
import { CAPABILITY_TOOL_CANDIDATES, type Capability } from './host-contract.js'

/** 13 个角色的稳定 ASCII ID（天枢 + 12 个可委派角色） */
export const ROLE_IDS = [
  'tian_shu', 'mou_ding', 'shu_ji', 'suan_heng', 'tan_wei', 'bo_wen', 'guan_xiang',
  'zhu_jian', 'xing_zhou', 'ji_feng', 'yu_shi', 'fu_he', 'miao_bi'
] as const

export type RoleId = typeof ROLE_IDS[number]
export type DelegableRoleId = Exclude<RoleId, 'tian_shu'>
export type PermissionLevel = 'orchestrator' | 'read' | 'limited-exec' | 'verify' | 'workspace-edit'
export type WebPolicy = 'always' | 'on-request' | 'never'
export type SuanHengMode = 'research' | 'verify'

/** 角色定义：职责、边界、触发、交付、权限与工具能力 */
export interface RoleInfo {
  id: RoleId
  presetId: string
  name: string
  title: string
  duty: string
  boundaries: readonly string[]
  triggers: readonly string[]
  deliverables: readonly string[]
  permission: PermissionLevel
  capabilities: readonly Capability[]
  web: WebPolicy
  needsVision: boolean
  concurrencySafe: boolean
  order: number
}

export const ROLE_INFO_LIST: readonly RoleInfo[] = Object.freeze([
  {
    id: 'tian_shu', presetId: 'tian-shu', name: '天枢', title: '主持与验收', order: 0,
    duty: '定义验收标准，控制委派与预算，依据证据裁决是否验收。',
    boundaries: ['硬门槛不得跳过', '不以「模型都认为正确」代替证据'],
    triggers: ['每个主任务'],
    deliverables: ['任务卡', '选用角色与理由', '验收结论', '未解决问题'],
    permission: 'orchestrator', capabilities: ['read', 'search', 'edit', 'shell', 'web'], web: 'always',
    needsVision: false, concurrencySafe: false
  },
  {
    id: 'mou_ding', presetId: 'mou-ding', name: '谋定', title: '需求与方案', order: 1,
    duty: '分解需求，整理约束，提出候选方案并标出决策点与任务依赖。',
    boundaries: ['只读，不修改任何文件', '确定功能约束；界面文案与表达交给妙笔'],
    triggers: ['多目标或需求模糊'],
    deliverables: ['约束表', '候选方案', '决策点', '任务依赖'],
    permission: 'read', capabilities: ['read', 'search'], web: 'never', needsVision: false, concurrencySafe: true
  },
  {
    id: 'shu_ji', presetId: 'shu-ji', name: '枢机', title: '架构与边界', order: 2,
    duty: '梳理跨模块架构、故障边界、并发与数据流，给出接口、故障场景与迁移/回退方案。',
    boundaries: ['只读，不修改任何文件', '结论指向具体模块与接口'],
    triggers: ['跨模块架构、并发、数据流'],
    deliverables: ['边界与接口', '故障场景', '迁移/回退方案'],
    permission: 'read', capabilities: ['read', 'search', 'web'], web: 'on-request', needsVision: false, concurrencySafe: true
  },
  {
    id: 'suan_heng', presetId: 'suan-heng', name: '算衡', title: '数学与算法', order: 3,
    duty: '完成数学建模与算法分析：前提、定义、不变量、证明义务、反例、复杂度与数值误差。',
    boundaries: [
      '只读，不运行命令：数值验证程序写入 reproducible，交由复核实际运行',
      '验算模式独立完成，不参考研算结论',
      '搜索只用于获取定义、论文与标准，不能用搜索摘要代替推导'
    ],
    triggers: ['数学定义、算法、性能与语义权衡'],
    deliverables: ['前提', '定义', '不变量', '结论与证明或反例', '复杂度', '数值误差', '未覆盖范围'],
    permission: 'read', capabilities: ['read', 'search', 'web'], web: 'on-request', needsVision: false, concurrencySafe: true
  },
  {
    id: 'tan_wei', presetId: 'tan-wei', name: '探微', title: '代码探索', order: 4,
    duty: '定位代码位置、符号与调用链，并给出可核对的证据。',
    boundaries: ['只读，不修改任何文件', '每条发现附路径与证据片段'],
    triggers: ['不清楚代码位置或调用链'],
    deliverables: ['路径', '符号', '调用链', '证据'],
    permission: 'read', capabilities: ['read', 'search'], web: 'never', needsVision: false, concurrencySafe: true
  },
  {
    id: 'bo_wen', presetId: 'bo-wen', name: '博闻', title: '外部资料', order: 5,
    duty: '检索外部文档、论文、RFC 与版本资料，给出来源、日期、适用版本与可验证要点。',
    boundaries: ['只读，不修改任何文件', '优先原始文档', '每条结论附来源 URL 与日期'],
    triggers: ['需要最新外部事实、RFC 或论文'],
    deliverables: ['来源', '日期', '适用版本', '可验证要点'],
    permission: 'read', capabilities: ['read', 'search', 'web'], web: 'always', needsVision: false, concurrencySafe: true
  },
  {
    id: 'guan_xiang', presetId: 'guan-xiang', name: '观象', title: '视觉观察', order: 6,
    duty: '解读截图、图表、设计稿与视觉回归差异，输出可核对的观察。',
    boundaries: [
      '只陈述图片中可见的事实与位置，实现方案由铸剑决定',
      '文字识别结果须与原图核对，无法确认的写入 uncertainties',
      '没有图片输入时不得臆测'
    ],
    triggers: ['有截图、设计稿、图表或视觉回归产物'],
    deliverables: ['观察到的区域与元素', '可见证据', '推断', '不确定性'],
    permission: 'read', capabilities: ['read'], web: 'never', needsVision: true, concurrencySafe: true
  },
  {
    id: 'zhu_jian', presetId: 'zhu-jian', name: '铸剑', title: '复杂实现', order: 7,
    duty: '实现复杂代码与重构，给出最小充分改动、实现说明与待验证假设。',
    boundaries: ['只改任务范围内的文件', '不宣称测试通过：验证交给复核', '不引入没有测量依据的缓存、并发或多级抽象'],
    triggers: ['跨文件实现、重构、困难修复'],
    deliverables: ['改动文件', '实现说明', '待验证假设'],
    permission: 'workspace-edit', capabilities: ['read', 'search', 'edit', 'shell'], web: 'never', needsVision: false, concurrencySafe: false
  },
  {
    id: 'xing_zhou', presetId: 'xing-zhou', name: '行舟', title: '命令执行', order: 8,
    duty: '按既定步骤执行命令、构建、迁移演练与批处理，记录命令、环境、退出码与产物。',
    boundaries: ['不改写业务逻辑与源文件', '写入、迁移或删除类高风险命令先给出演练与影响清单', '未执行的步骤写明原因'],
    triggers: ['已确认的步骤需要执行'],
    deliverables: ['命令', '环境', '退出码', '产物', '未执行原因'],
    permission: 'limited-exec', capabilities: ['read', 'search', 'shell'], web: 'never', needsVision: false, concurrencySafe: false
  },
  {
    id: 'ji_feng', presetId: 'ji-feng', name: '疾风', title: '局部小改', order: 9,
    duty: '完成独立、低风险的局部改动，并做局部验证。',
    boundaries: ['只做小范围改动，需要跨模块修改时停止并说明', '不宣称整体测试通过：验证交给复核'],
    triggers: ['独立的小改动'],
    deliverables: ['改动文件', '局部验证'],
    permission: 'workspace-edit', capabilities: ['read', 'search', 'edit', 'shell'], web: 'never', needsVision: false, concurrencySafe: false
  },
  {
    id: 'yu_shi', presetId: 'yu-shi', name: '御史', title: '独立审查', order: 10,
    duty: '独立审查工程质量、安全、可维护性与性能回退，按严重度分级给出问题、复现途径与建议。',
    boundaries: ['只读，不修改任何文件', '独立判断，不以实现者的说明代替核查'],
    triggers: ['代码高风险或实现完成'],
    deliverables: ['严重度分级问题', '位置', '复现途径', '具体建议'],
    permission: 'read', capabilities: ['read', 'search'], web: 'never', needsVision: false, concurrencySafe: true
  },
  {
    id: 'fu_he', presetId: 'fu-he', name: '复核', title: '验证与证据', order: 11,
    duty: '制定并执行验证计划：实际运行测试、类型检查、构建与基准，归集证据并解释失败。',
    boundaries: ['不修改业务文件，只允许产生测试临时产物', '结论必须来自真实命令与退出码，不能口述替代', '无法运行的验证写明原因与覆盖缺口'],
    triggers: ['代码改动、算法改动、发布前复查'],
    deliverables: ['验证计划', '实际运行的命令与退出码', '覆盖范围', '失败解释', '判定'],
    permission: 'verify', capabilities: ['read', 'search', 'shell'], web: 'never', needsVision: false, concurrencySafe: false
  },
  {
    id: 'miao_bi', presetId: 'miao-bi', name: '妙笔', title: '文案与表达', order: 12,
    duty: '为界面文案、命名、帮助说明与交互提示提供受约束的候选与推荐理由。',
    boundaries: ['只读，不修改任何文件', '给出 2–3 个候选及适用场景', '行情/交易术语交由业务角色复核'],
    triggers: ['UI 文案、命名、说明、创意'],
    deliverables: ['2–3 个候选', '适用场景', '推荐与理由'],
    permission: 'read', capabilities: ['read', 'search', 'web'], web: 'on-request', needsVision: false, concurrencySafe: true
  }
] satisfies RoleInfo[])

const ROLE_INDEX = new Map<string, RoleInfo>(ROLE_INFO_LIST.map((role) => [role.id, role]))
const PRESET_INDEX = new Map<string, RoleInfo>(ROLE_INFO_LIST.map((role) => [role.presetId, role]))

const PERMISSION_LABEL: Readonly<Record<PermissionLevel, string>> = {
  orchestrator: '主持',
  read: '只读',
  'limited-exec': '限范围执行',
  verify: '验证',
  'workspace-edit': '可编辑工作区'
}

const COMMON_CHILD_BOUNDARIES = [
  '你不能再委派其他智能体，也不能向用户提问；缺少的信息写入 unresolved。',
  '只提交实际核实过的内容，推测必须标明。'
]

const MODE_TEXT: Readonly<Record<SuanHengMode, string>> = {
  research: '当前模式：研算。在实现之前定义语义，提出候选算法，给出不变量、复杂度与数值误差分析。',
  verify: '当前模式：验算。独立检验给定的实现或规格：寻找反例，核对不变量与数值误差，不要假定任何已有结论正确。'
}

/** 子智能体 persona 中的机器可读角色标签 */
export const ROLE_TAG_PATTERN = /\[\[swarm:role=([a-z_]+)\]\]/

export const isRoleId = (value: unknown): value is RoleId => typeof value === 'string' && ROLE_INDEX.has(value)

export const isDelegableRoleId = (value: unknown): value is DelegableRoleId => isRoleId(value) && value !== 'tian_shu'

/**
 * 按 ID 取角色定义
 * @param {RoleId} id - 角色 ID
 * @returns {RoleInfo} 角色定义
 */
export const getRoleInfo = (id: RoleId): RoleInfo => {
  const role = ROLE_INDEX.get(id)
  if (role === undefined) throw new Error(`未知角色：${String(id)}`)
  return role
}

/**
 * 按预设 ID 查找角色
 * @param {string | undefined} presetId - 会话头中的 agentPreset
 * @returns {RoleInfo | undefined} 角色定义，非 swarm 预设返回 undefined
 */
export const FindRoleByPresetId = (presetId: string | undefined): RoleInfo | undefined =>
  presetId === undefined ? undefined : PRESET_INDEX.get(presetId)

export const getDelegableRoleIds = (): DelegableRoleId[] =>
  ROLE_INFO_LIST.map((role) => role.id).filter(isDelegableRoleId)

export const isEditRole = (id: RoleId): boolean => getRoleInfo(id).permission === 'workspace-edit'

export const isWriteAllowed = (id: RoleId): boolean => {
  const { permission } = getRoleInfo(id)
  return permission === 'orchestrator' || permission === 'workspace-edit'
}

export const getPermissionLabel = (id: RoleId): string => PERMISSION_LABEL[getRoleInfo(id).permission]

/**
 * 计算角色希望使用的宿主工具名（调用时再与实际可见工具求交集）
 * @param {RoleId} id - 角色 ID
 * @param {{ allowWeb?: boolean }} [options] - 本次委派是否开放 web
 * @returns {string[]} 候选工具名
 */
export const getWantedTools = (id: RoleId, options: { allowWeb?: boolean } = {}): string[] => {
  const role = getRoleInfo(id)
  const webOpen = role.web === 'always' || (role.web === 'on-request' && options.allowWeb === true)
  const capabilities = role.capabilities.filter((cap) => cap !== 'web' || webOpen)
  return [...new Set(capabilities.flatMap((cap) => [...CAPABILITY_TOOL_CANDIDATES[cap]]))]
}

export const getRoleTag = (id: RoleId): string => `[[swarm:role=${id}]]`

const toBullets = (items: readonly string[]): string => items.map((item) => `- ${item}`).join('\n')

/**
 * 生成被委派子智能体的 persona
 * @param {DelegableRoleId} id - 角色 ID
 * @param {SuanHengMode} [mode] - 算衡模式
 * @returns {string} persona 文本
 */
export const getChildPersona = (id: DelegableRoleId, mode?: SuanHengMode): string => {
  const role = getRoleInfo(id)
  return [
    `你是「${role.name}」（${role.title}），dsh-agent-swarm 多智能体系统中的专家，由主持者「天枢」委派完成一项任务。你看不到天枢与用户的对话，只依据收到的任务说明工作。`,
    `职责：${role.duty}`,
    `边界：\n${toBullets([...role.boundaries, ...COMMON_CHILD_BOUNDARIES])}`,
    ...(id === 'suan_heng' ? [MODE_TEXT[mode ?? 'research']] : []),
    `交付：完成后调用 structured_output 工具提交结构化结果（${role.deliverables.join('、')}）。summary 用中文写结论，unresolved 列出未解决或未核实的事项。`,
    getRoleTag(id)
  ].join('\n\n')
}

/**
 * 生成天枢工具说明中使用的角色目录（每行一个可委派角色）
 * @returns {string} 角色目录文本
 */
export const getRoleCatalogText = (): string =>
  ROLE_INFO_LIST
    .filter((role) => role.id !== 'tian_shu')
    .map((role) => `- ${role.id} ${role.name}：${role.title}（${PERMISSION_LABEL[role.permission]}）— ${role.triggers.join('；')}`)
    .join('\n')

const TIAN_SHU_PERSONA = [
  '你是「天枢」，dsh-agent-swarm 的主持者，运行于 {{model}} 模型。你负责把用户需求变成可验收的结果：定义约束、委派专家、依据证据裁决。',
  '',
  '工作协议：',
  '1. 先调用 swarm_task_card 建立任务卡：目标、验收标准、范围、风险标志与性能预算（未知的性能参数写「待测」）。返回的 requiredGates 是硬门槛，不能跳过。',
  '2. 通过 swarm_delegate 委派专家。只读探索、资料检索、独立审查可以在同一条消息里并行发起；会修改文件或运行命令的委派（铸剑、疾风、行舟、复核）一次只发一个。',
  '3. 委派的 prompt 必须自包含：专家看不到本对话。写清目标、相关文件路径、约束与交付要求。',
  '4. 代码改动之后必须委派复核实际运行验证；复核的结论来自真实命令与退出码。',
  '5. 用 swarm_status 查看门禁与证据，再用 swarm_accept 验收。返回 blocked 时按 missing 补齐证据或修复；自动修复最多两轮，超过即向用户说明阻塞原因。',
  '6. 按风险分层调度，不要每次拉起所有角色：微小低风险改动 = 疾风 + 复核；一般代码任务 = 铸剑或疾风 + 复核；架构、并发、算法 = 另加御史；交易/量化核心 = 另加算衡研算与验算、差分/性质测试。',
  '7. 行舟只在有明确执行步骤时参与；观象只在有图片或视觉产物时参与；妙笔只在文案与表达需要时参与。',
  '8. 不把「模型都觉得对」当作通过；证据不足时如实报告未完成。',
  '',
  '可委派的专家（swarm_delegate 的 role 参数）：',
  getRoleCatalogText(),
  '',
  '最终回复包含：任务卡摘要、使用的角色与理由、改动文件、验证证据、验收结论与未解决问题。'
].join('\n')

/**
 * 生成预设（用户直接选用的会话）的 persona 前缀
 * @param {RoleId} id - 角色 ID
 * @returns {string} persona 文本，只使用 {{model}} 变量
 */
export const getPresetPersona = (id: RoleId): string => {
  if (id === 'tian_shu') return TIAN_SHU_PERSONA
  const role = getRoleInfo(id)
  return [
    `你是「${role.name}」（${role.title}），dsh-agent-swarm 的专用角色会话，运行于 {{model}} 模型。用户直接与你协作。`,
    `职责：${role.duty}`,
    `边界：\n${toBullets(role.boundaries)}`,
    `典型触发：${role.triggers.join('；')}`,
    `交付要求：${role.deliverables.join('、')}。先给结论，再列证据与未解决问题。`
  ].join('\n\n')
}
````

````ts file=src/contracts.ts
import type { DelegableRoleId, SuanHengMode } from './role-registry.js'
import { ValidateJsonValue, type JsonSchemaObject } from './util/json-schema.js'

/** 复核命令类别 */
export const COMMAND_KINDS = ['unit', 'integration', 'typecheck', 'lint', 'build', 'benchmark', 'differential', 'property', 'e2e', 'other'] as const
/** 御史发现的严重度 */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const

const str = (description?: string): JsonSchemaObject => ({ type: 'string', ...(description === undefined ? {} : { description }) })
const num = (): JsonSchemaObject => ({ type: 'number' })
const oneOf = (values: readonly string[]): JsonSchemaObject => ({ type: 'string', enum: values })
const strList = (description?: string): JsonSchemaObject => ({ type: 'array', items: { type: 'string' }, ...(description === undefined ? {} : { description }) })
const listOf = (items: JsonSchemaObject): JsonSchemaObject => ({ type: 'array', items })
const obj = (properties: Record<string, JsonSchemaObject>, required: string[]): JsonSchemaObject =>
  ({ type: 'object', properties, required, additionalProperties: false })

/** 所有角色共享 summary 与 unresolved 字段 */
const withCommon = (properties: Record<string, JsonSchemaObject>, required: string[]): JsonSchemaObject =>
  obj({ summary: str('中文结论摘要'), unresolved: strList('未解决或未核实的事项'), ...properties }, ['summary', 'unresolved', ...required])

const SCHEMAS: Readonly<Record<DelegableRoleId, JsonSchemaObject>> = {
  mou_ding: withCommon({
    constraints: strList('约束表'),
    options: listOf(obj({ name: str(), summary: str(), pros: strList(), cons: strList() }, ['name', 'summary'])),
    decisions: listOf(obj({ point: str(), recommendation: str(), reason: str() }, ['point', 'recommendation'])),
    dependencies: strList('任务依赖')
  }, ['constraints', 'options', 'decisions']),
  shu_ji: withCommon({
    boundaries: strList(),
    interfaces: listOf(obj({ name: str(), contract: str() }, ['name', 'contract'])),
    failureScenarios: listOf(obj({ scenario: str(), impact: str(), mitigation: str() }, ['scenario', 'mitigation'])),
    migration: str(),
    rollback: str()
  }, ['boundaries', 'interfaces', 'failureScenarios', 'rollback']),
  suan_heng: withCommon({
    mode: oneOf(['research', 'verify']),
    premises: strList(),
    definitions: strList(),
    invariants: strList(),
    claims: listOf(obj({ statement: str(), status: oneOf(['proved', 'refuted', 'unverified']), proofOrCounterexample: str() }, ['statement', 'status'])),
    complexity: str(),
    numericError: str(),
    reproducible: listOf(obj({ description: str(), program: str() }, ['description', 'program']))
  }, ['mode', 'premises', 'invariants', 'claims']),
  tan_wei: withCommon({
    findings: listOf(obj({ path: str(), symbol: str(), callChain: strList(), evidence: str() }, ['path', 'evidence']))
  }, ['findings']),
  bo_wen: withCommon({
    sources: listOf(obj({ url: str(), title: str(), date: str(), version: str(), points: strList() }, ['url', 'points']))
  }, ['sources']),
  guan_xiang: withCommon({
    observations: listOf(obj({ region: str(), element: str(), evidence: str() }, ['region', 'element', 'evidence'])),
    inferences: strList(),
    uncertainties: strList()
  }, ['observations', 'uncertainties']),
  zhu_jian: withCommon({ changedFiles: strList(), assumptions: strList(), toVerify: strList() }, ['changedFiles', 'toVerify']),
  xing_zhou: withCommon({
    steps: listOf(obj({ command: str(), cwd: str(), exitCode: num(), artifacts: strList(), notRunReason: str() }, ['command']))
  }, ['steps']),
  ji_feng: withCommon({
    changedFiles: strList(),
    localChecks: listOf(obj({ command: str(), exitCode: num() }, ['command', 'exitCode']))
  }, ['changedFiles', 'localChecks']),
  yu_shi: withCommon({
    findings: listOf(obj({ severity: oneOf(SEVERITIES), location: str(), issue: str(), repro: str(), suggestion: str() }, ['severity', 'location', 'issue', 'suggestion']))
  }, ['findings']),
  fu_he: withCommon({
    plan: strList('验证计划'),
    commands: listOf(obj({ command: str(), exitCode: num(), kind: oneOf(COMMAND_KINDS), summary: str() }, ['command', 'exitCode', 'kind', 'summary'])),
    coverage: str('覆盖范围与缺口'),
    failures: listOf(obj({ command: str(), explanation: str() }, ['command', 'explanation'])),
    verdict: oneOf(['pass', 'fail', 'partial'])
  }, ['plan', 'commands', 'coverage', 'failures', 'verdict']),
  miao_bi: withCommon({
    candidates: listOf(obj({ text: str(), scenario: str() }, ['text', 'scenario'])),
    recommendation: str(),
    rationale: str()
  }, ['candidates', 'recommendation', 'rationale'])
}

/**
 * 角色的 outputSchema（传给 spawn，并用于宿主侧校验）
 * @param {DelegableRoleId} role - 角色 ID
 * @returns {JsonSchemaObject} schema
 */
export const getOutputSchema = (role: DelegableRoleId): JsonSchemaObject => SCHEMAS[role]

interface CommandRow { command: string; exitCode: number; kind: string; summary: string }
interface StepRow { command: string; exitCode?: number; artifacts?: string[]; notRunReason?: string }
interface FindingRow { severity: string; location: string; issue: string }
interface SourceRow { url: string; date?: string; version?: string }
interface ObservationRow { region: string; element: string; evidence: string }
interface ClaimRow { statement: string; status: string }
interface LocationRow { path: string; evidence: string }

const getList = <T>(value: unknown, key: string): T[] => {
  const field = (value as Record<string, unknown> | null | undefined)?.[key]
  return Array.isArray(field) ? (field as T[]) : []
}

/**
 * 在 schema 校验之上做角色级语义检查
 * @param {DelegableRoleId} role - 角色 ID
 * @param {unknown} value - 子智能体提交的结构化结果
 * @param {SuanHengMode} [mode] - 算衡本次委派的模式
 * @returns {string[]} 违规描述
 */
export const ValidateStructuredOutput = (role: DelegableRoleId, value: unknown, mode?: SuanHengMode): string[] => {
  const schemaErrors = ValidateJsonValue(SCHEMAS[role], value)
  if (schemaErrors.length > 0) return schemaErrors
  const record = value as Record<string, unknown>
  const errors: string[] = []
  if (role === 'fu_he' && record.verdict === 'pass') {
    const commands = getList<CommandRow>(value, 'commands')
    if (commands.length === 0) errors.push('复核判定通过时必须至少记录 1 条实际运行的命令')
    if (commands.some((row) => row.exitCode !== 0)) errors.push('复核判定通过，但存在非零退出码的命令')
  }
  if (role === 'miao_bi') {
    const count = getList(value, 'candidates').length
    if (count < 2 || count > 3) errors.push('妙笔必须给出 2–3 个候选')
  }
  if (role === 'suan_heng' && mode !== undefined && record.mode !== mode) errors.push(`算衡模式应为 ${mode}`)
  if (role === 'suan_heng' && record.mode === 'verify' && getList(value, 'claims').length === 0) errors.push('验算必须至少检验 1 条结论')
  if (role === 'bo_wen' && getList<SourceRow>(value, 'sources').some((row) => !/^https?:\/\//.test(row.url))) {
    errors.push('博闻的来源必须是 http(s) URL')
  }
  return errors
}

/** 可核对的证据条目 */
export interface EvidenceItem {
  kind: 'command' | 'step' | 'finding' | 'source' | 'observation' | 'claim' | 'file-change'
  ref: string
  detail?: string
  exitCode?: number
  commandKind?: string
  severity?: string
}

/**
 * 从结构化结果中抽取证据条目
 * @param {DelegableRoleId} role - 角色 ID
 * @param {unknown} value - 结构化结果
 * @returns {EvidenceItem[]} 证据
 */
export const getEvidenceFromOutput = (role: DelegableRoleId, value: unknown): EvidenceItem[] => {
  switch (role) {
    case 'fu_he':
      return getList<CommandRow>(value, 'commands').map((row) => ({ kind: 'command', ref: row.command, exitCode: row.exitCode, commandKind: row.kind, detail: row.summary }))
    case 'xing_zhou':
      return getList<StepRow>(value, 'steps').map((row) => ({
        kind: 'step',
        ref: row.command,
        ...(typeof row.exitCode === 'number' ? { exitCode: row.exitCode } : {}),
        detail: row.notRunReason ?? (row.artifacts ?? []).join(', ')
      }))
    case 'ji_feng':
      return getList<CommandRow>(value, 'localChecks').map((row) => ({ kind: 'command', ref: row.command, exitCode: row.exitCode }))
    case 'yu_shi':
      return getList<FindingRow>(value, 'findings').map((row) => ({ kind: 'finding', ref: row.location, severity: row.severity, detail: row.issue }))
    case 'bo_wen':
      return getList<SourceRow>(value, 'sources').map((row) => ({ kind: 'source', ref: row.url, detail: [row.date, row.version].filter(Boolean).join(' ') }))
    case 'guan_xiang':
      return getList<ObservationRow>(value, 'observations').map((row) => ({ kind: 'observation', ref: row.region, detail: `${row.element}：${row.evidence}` }))
    case 'suan_heng':
      return getList<ClaimRow>(value, 'claims').map((row) => ({ kind: 'claim', ref: row.statement, detail: row.status }))
    case 'tan_wei':
      return getList<LocationRow>(value, 'findings').map((row) => ({ kind: 'finding', ref: row.path, detail: row.evidence }))
    case 'zhu_jian':
      return getList<string>(value, 'changedFiles').map((path) => ({ kind: 'file-change', ref: path }))
    default:
      return []
  }
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/role-registry.test.ts tests/unit/contracts.test.ts` 然后 `npm run typecheck`
Expected: PASS；typecheck 无错误

- [ ] **Step 5: 提交**

```bash
git add src/role-registry.ts src/contracts.ts tests/unit/role-registry.test.ts tests/unit/contracts.test.ts tests/fixtures/valid-outputs.ts tests/fixtures/valid-outputs.json
git commit -m "feat: add 13-role registry, personas and delivery contracts"
```

---

### Task 3: 模型目录、默认路由与失败分类

**Files:**
- Create: `src/routes.ts`
- Test: `tests/unit/routes.test.ts`

**Interfaces:**
- Consumes: `RoleId`、`SuanHengMode`（Task 2）、`LlmFailureLike`、`LlmLike`（Task 1）、`getErrorText`（Task 1）
- Produces:
  - 常量 `PROVIDER_QWEN`、`PROVIDER_GO`、`PROVIDER_DS`、`QWEN_TOKEN_PLAN_MODELS`、`OPENCODE_GO_MODELS`、`DEEPSEEK_OFFICIAL_MODELS`、`QWEN_PREFERRED_MODELS`、`DEFAULT_ROUTE_CHAINS`、`DEFAULT_ESCALATION`
  - 类型 `RouteInfo { provider; model; reasoningEffort? }`、`RouteKey`、`ModelFamily`、`EscalationKind = 'codex' | 'claude'`、`RouteProbe`、`RouteProbeResult`、`RouteSelection`、`FailureClass`
  - 函数 `getRouteKey(role, mode?)`、`getRouteLabel(route)`、`isSameRoute(a, b)`、`getModelFamily(model)`、`getCatalogVision(route)`、`FindUsableRoutes(chain, { probe, requireVision?, avoidFamilies? })`、`getFailureClass(failure)`、`isSwitchWorthy(cls, exhausted)`、`intRouteProbe(getLlm)`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/routes.test.ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ESCALATION,
  DEFAULT_ROUTE_CHAINS,
  FindUsableRoutes,
  OPENCODE_GO_MODELS,
  PROVIDER_DS,
  PROVIDER_GO,
  PROVIDER_QWEN,
  QWEN_PREFERRED_MODELS,
  QWEN_TOKEN_PLAN_MODELS,
  getCatalogVision,
  getFailureClass,
  getModelFamily,
  getRouteKey,
  getRouteLabel,
  intRouteProbe,
  isSameRoute,
  isSwitchWorthy,
  type RouteInfo,
  type RouteProbe
} from '../../src/routes.js'
import { ROLE_IDS } from '../../src/role-registry.js'

describe('默认路由表', () => {
  it('每个路由键都有非空链，且覆盖全部角色（算衡分研算/验算）', () => {
    for (const role of ROLE_IDS) {
      if (role === 'suan_heng') continue
      expect(DEFAULT_ROUTE_CHAINS[role].length).toBeGreaterThan(0)
    }
    expect(DEFAULT_ROUTE_CHAINS['suan_heng:research'][0]).toEqual({ provider: PROVIDER_QWEN, model: 'deepseek-v4-pro', reasoningEffort: 'max' })
    expect(DEFAULT_ROUTE_CHAINS['suan_heng:verify'].length).toBeGreaterThan(0)
  })

  it('qwen 优先：链中凡是 qwen 目录有的模型，qwen 路由都排在同模型 go 路由之前', () => {
    for (const [key, chain] of Object.entries(DEFAULT_ROUTE_CHAINS)) {
      chain.forEach((route, index) => {
        if (route.provider !== PROVIDER_GO || !(route.model in QWEN_TOKEN_PLAN_MODELS)) return
        const qwenIndex = chain.findIndex((r) => r.provider === PROVIDER_QWEN && r.model === route.model)
        expect(qwenIndex, `${key} ${route.model}`).toBeGreaterThanOrEqual(0)
        expect(qwenIndex, `${key} ${route.model}`).toBeLessThan(index)
      })
    }
  })

  it('链中的模型都存在于对应 provider 的内置目录', () => {
    const catalogs: Record<string, Record<string, unknown>> = {
      [PROVIDER_QWEN]: QWEN_TOKEN_PLAN_MODELS,
      [PROVIDER_GO]: OPENCODE_GO_MODELS,
      [PROVIDER_DS]: { 'deepseek-flash': 1, 'deepseek-v4-pro': 1 }
    }
    for (const chain of Object.values(DEFAULT_ROUTE_CHAINS)) {
      for (const route of chain) expect(catalogs[route.provider]?.[route.model], getRouteLabel(route)).toBeDefined()
    }
  })

  it('观象链只含支持图片的模型；御史与铸剑、验算与研算首选家族不同', () => {
    for (const route of DEFAULT_ROUTE_CHAINS.guan_xiang) expect(getCatalogVision(route)).toBe(true)
    expect(getModelFamily(DEFAULT_ROUTE_CHAINS.yu_shi[0].model)).not.toBe(getModelFamily(DEFAULT_ROUTE_CHAINS.zhu_jian[0].model))
    expect(getModelFamily(DEFAULT_ROUTE_CHAINS['suan_heng:verify'][0].model))
      .not.toBe(getModelFamily(DEFAULT_ROUTE_CHAINS['suan_heng:research'][0].model))
  })

  it('交集与升级通道', () => {
    expect(QWEN_PREFERRED_MODELS).toEqual(expect.arrayContaining(['deepseek-v4-pro', 'qwen3.8-max', 'kimi-k2.7-code', 'glm-5.2']))
    expect(QWEN_PREFERRED_MODELS).not.toContain('MiniMax-M2.5')
    expect(DEFAULT_ESCALATION.zhu_jian).toBe('claude')
    expect(DEFAULT_ESCALATION.fu_he).toBeUndefined()
  })
})

describe('路由工具函数', () => {
  it('路由键、标签、相等', () => {
    expect(getRouteKey('suan_heng')).toBe('suan_heng:research')
    expect(getRouteKey('suan_heng', 'verify')).toBe('suan_heng:verify')
    expect(getRouteKey('fu_he')).toBe('fu_he')
    expect(getRouteLabel({ provider: 'p', model: 'm' })).toBe('p/m')
    expect(isSameRoute({ provider: 'p', model: 'm', reasoningEffort: 'high' }, { provider: 'p', model: 'm' })).toBe(true)
    expect(isSameRoute({ provider: 'p', model: 'm' }, { provider: 'q', model: 'm' })).toBe(false)
  })

  it('模型家族', () => {
    expect(getModelFamily('deepseek-v4-pro')).toBe('deepseek')
    expect(getModelFamily('qwen3.8-max')).toBe('qwen')
    expect(getModelFamily('kimi-k2.7-code')).toBe('kimi')
    expect(getModelFamily('glm-5.3')).toBe('glm')
    expect(getModelFamily('MiniMax-M2.5')).toBe('minimax')
    expect(getModelFamily('mimo-v2.5-pro')).toBe('mimo')
    expect(getModelFamily('gpt-5.6-luna')).toBe('gpt')
    expect(getModelFamily('codex-native')).toBe('gpt')
    expect(getModelFamily('claude-native')).toBe('claude')
    expect(getModelFamily('grok-4.6')).toBe('grok')
    expect(getModelFamily('hy4-preview')).toBe('hunyuan')
    expect(getModelFamily('longcat-2.0')).toBe('longcat')
    expect(getModelFamily('mystery')).toBe('other')
  })

  it('目录视觉能力', () => {
    expect(getCatalogVision({ provider: PROVIDER_QWEN, model: 'qwen3.8-max' })).toBe(true)
    expect(getCatalogVision({ provider: PROVIDER_GO, model: 'deepseek-v4-pro' })).toBe(false)
    expect(getCatalogVision({ provider: PROVIDER_DS, model: 'deepseek-flash' })).toBe(true)
    expect(getCatalogVision({ provider: 'other', model: 'x' })).toBeUndefined()
  })
})

describe('FindUsableRoutes', () => {
  const chain: RouteInfo[] = [
    { provider: 'a', model: 'deepseek-v4-pro' },
    { provider: 'b', model: 'qwen3.8-max' },
    { provider: 'c', model: 'glm-5.2' }
  ]
  const probe: RouteProbe = async (route) =>
    route.provider === 'a' ? { ok: false, reason: 'provider-not-configured' } : { ok: true, vision: route.provider === 'b' }

  it('跳过不可用路由并记录原因', async () => {
    const result = await FindUsableRoutes(chain, { probe })
    expect(result.usable.map(getRouteLabel)).toEqual(['b/qwen3.8-max', 'c/glm-5.2'])
    expect(result.skipped).toEqual([{ route: chain[0], reason: 'provider-not-configured' }])
    expect(result.independence).toBe('n/a')
  })

  it('要求视觉时过滤纯文本模型', async () => {
    const result = await FindUsableRoutes(chain, { probe, requireVision: true })
    expect(result.usable.map(getRouteLabel)).toEqual(['b/qwen3.8-max'])
    expect(result.skipped.map((s) => s.reason)).toContain('vision-unsupported')
  })

  it('独立性：优先不同家族，做不到时标注 not-achieved', async () => {
    const achieved = await FindUsableRoutes(chain, { probe, avoidFamilies: ['qwen'] })
    expect(achieved.usable.map(getRouteLabel)).toEqual(['c/glm-5.2'])
    expect(achieved.independence).toBe('achieved')
    expect(achieved.skipped.map((s) => s.reason)).toContain('same-family')
    const notAchieved = await FindUsableRoutes(chain, { probe, avoidFamilies: ['qwen', 'glm'] })
    expect(notAchieved.usable).toHaveLength(2)
    expect(notAchieved.independence).toBe('not-achieved')
    const empty = await FindUsableRoutes([chain[0]], { probe, avoidFamilies: ['glm'] })
    expect(empty.usable).toEqual([])
    expect(empty.independence).toBe('n/a')
  })
})

describe('失败分类', () => {
  it('路由致命、认证、瞬时、其他', () => {
    expect(getFailureClass({ code: 'QUOTA', status: 429 })).toBe('route-fatal')
    expect(getFailureClass({ code: 'NO_ADAPTER' })).toBe('route-fatal')
    expect(getFailureClass({ code: 'X', message: 'Usage limit reached' })).toBe('route-fatal')
    expect(getFailureClass({ code: 'X', status: 404 })).toBe('route-fatal')
    expect(getFailureClass({ code: 'INVALID_CREDENTIAL' })).toBe('auth')
    expect(getFailureClass({ status: 401 })).toBe('auth')
    expect(getFailureClass({ code: 'RATE_LIMIT', status: 429 })).toBe('transient')
    expect(getFailureClass({ status: 503 })).toBe('transient')
    expect(getFailureClass({ code: 'WEIRD' })).toBe('other')
    expect(getFailureClass(undefined)).toBe('other')
  })

  it('是否值得换路由', () => {
    expect(isSwitchWorthy('route-fatal', false)).toBe(true)
    expect(isSwitchWorthy('auth', false)).toBe(true)
    expect(isSwitchWorthy('transient', false)).toBe(false)
    expect(isSwitchWorthy('transient', true)).toBe(true)
    expect(isSwitchWorthy('other', true)).toBe(true)
  })
})

describe('intRouteProbe', () => {
  const llm = {
    listProviders: () => [{ id: 'p' }],
    resolveModelInfo: async (_p: string, model: string) => {
      if (model === 'bad') throw new Error('unknown model')
      return model === 'img' ? { inputModalities: ['text', 'image'] } : {}
    }
  }

  it('按 provider 注册与模型解析给出结果', async () => {
    const probe = intRouteProbe(() => llm)
    expect(await probe({ provider: 'x', model: 'm' })).toEqual({ ok: false, reason: 'provider-not-configured' })
    expect(await probe({ provider: 'p', model: 'img' })).toEqual({ ok: true, vision: true })
    expect(await probe({ provider: 'p', model: 'plain' })).toEqual({ ok: true, vision: false })
    expect(await probe({ provider: 'p', model: 'bad' })).toEqual({ ok: false, reason: 'model-unavailable: unknown model' })
    expect(await intRouteProbe(() => undefined)({ provider: 'p', model: 'm' })).toEqual({ ok: false, reason: 'llm-service-unavailable' })
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/routes.test.ts`
Expected: FAIL，模块 `src/routes.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/routes.ts
import type { LlmFailureLike, LlmLike } from './host-contract.js'
import type { RoleId, SuanHengMode } from './role-registry.js'
import { getErrorText } from './util/errors.js'

export const PROVIDER_QWEN = 'qwen-token-plan-cn'
export const PROVIDER_GO = 'opencode-go'
export const PROVIDER_DS = 'deepseek-official'

/** 一条模型路由 */
export interface RouteInfo {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 路由表的键：算衡按模式拆成两条 */
export type RouteKey = Exclude<RoleId, 'suan_heng'> | 'suan_heng:research' | 'suan_heng:verify'
export type EscalationKind = 'codex' | 'claude'
export type ModelFamily = 'deepseek' | 'qwen' | 'kimi' | 'glm' | 'minimax' | 'mimo' | 'gpt' | 'grok' | 'claude' | 'hunyuan' | 'longcat' | 'other'

type CatalogInfo = Readonly<Record<string, { vision: boolean }>>

/** pi-ai 0.85.1（随 DSH 0.1.7-alpha.2）内置的 qwen-token-plan-cn 目录 */
export const QWEN_TOKEN_PLAN_MODELS: CatalogInfo = {
  'MiniMax-M2.5': { vision: false },
  'deepseek-v3.2': { vision: false },
  'deepseek-v4-flash': { vision: false },
  'deepseek-v4-flash-0731': { vision: false },
  'deepseek-v4-pro': { vision: false },
  'deepseek-v4-pro-0813': { vision: false },
  'glm-5': { vision: false },
  'glm-5.1': { vision: false },
  'glm-5.2': { vision: false },
  'kimi-k2.5': { vision: true },
  'kimi-k2.6': { vision: true },
  'kimi-k2.7-code': { vision: true },
  'qwen3.6-flash': { vision: true },
  'qwen3.6-plus': { vision: true },
  'qwen3.7-max': { vision: false },
  'qwen3.7-plus': { vision: true },
  'qwen3.8-flash': { vision: true },
  'qwen3.8-max': { vision: true }
}

/** pi-ai 0.85.1 内置的 opencode-go 目录 */
export const OPENCODE_GO_MODELS: CatalogInfo = {
  'minimax-m3': { vision: true },
  'qwen3.8-flash': { vision: true },
  'deepseek-v4-flash': { vision: false },
  'deepseek-v4-flash-vision-exp': { vision: true },
  'deepseek-v4-pro': { vision: false },
  'glm-5.1': { vision: false },
  'glm-5.2': { vision: false },
  'glm-5.3': { vision: false },
  'glm-5.3-flash': { vision: true },
  'hy3': { vision: false },
  'hy4-preview': { vision: false },
  'kimi-k2.6': { vision: true },
  'kimi-k2.7-code': { vision: true },
  'kimi-k3': { vision: true },
  'longcat-2.0': { vision: false },
  'mimo-v2.5': { vision: true },
  'mimo-v2.5-pro': { vision: false },
  'minimax-m2.7': { vision: false },
  'omen-alpha': { vision: true },
  'qwen3.6-plus': { vision: true },
  'qwen3.7-max': { vision: false },
  'qwen3.7-plus': { vision: true },
  'qwen3.8-max': { vision: true },
  'gpt-5.6-luna': { vision: true },
  'grok-4.6': { vision: true },
  'muse-spark-1.2-contributor': { vision: true },
  'muse-spark-1.3-contributor': { vision: true }
}

/** DSH 0.1.7-alpha.2 原生 DeepSeek 适配器目录 */
export const DEEPSEEK_OFFICIAL_MODELS: CatalogInfo = {
  'deepseek-flash': { vision: true },
  'deepseek-v4-pro': { vision: false }
}

/** 两个订阅都有的模型：一律 qwen-token-plan-cn 优先、opencode-go 备用 */
export const QWEN_PREFERRED_MODELS: readonly string[] = Object.keys(QWEN_TOKEN_PLAN_MODELS).filter((model) => model in OPENCODE_GO_MODELS)

const q = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_QWEN, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const g = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_GO, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const d = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_DS, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })

/** 默认路由链（首选 → 备用），见 spec §7.1 */
export const DEFAULT_ROUTE_CHAINS: Readonly<Record<RouteKey, readonly RouteInfo[]>> = {
  tian_shu: [q('deepseek-v4-pro'), g('deepseek-v4-pro'), d('deepseek-v4-pro')],
  mou_ding: [q('qwen3.8-max'), g('qwen3.8-max'), q('deepseek-v4-pro'), d('deepseek-v4-pro')],
  shu_ji: [q('deepseek-v4-pro'), g('deepseek-v4-pro'), q('glm-5.2'), d('deepseek-v4-pro')],
  'suan_heng:research': [q('deepseek-v4-pro', 'max'), g('deepseek-v4-pro', 'max'), d('deepseek-v4-pro', 'max')],
  'suan_heng:verify': [q('qwen3.8-max', 'xhigh'), g('qwen3.8-max', 'xhigh'), g('glm-5.3', 'max')],
  tan_wei: [g('mimo-v2.5-pro'), q('kimi-k2.7-code'), g('kimi-k2.7-code'), q('qwen3.8-flash')],
  bo_wen: [q('kimi-k2.6'), g('kimi-k2.6'), g('minimax-m3')],
  guan_xiang: [q('qwen3.8-max'), g('qwen3.8-max'), q('kimi-k2.6'), g('deepseek-v4-flash-vision-exp'), d('deepseek-flash')],
  zhu_jian: [q('kimi-k2.7-code'), g('kimi-k2.7-code'), q('deepseek-v4-pro'), g('deepseek-v4-pro')],
  xing_zhou: [q('deepseek-v4-flash'), g('deepseek-v4-flash'), q('qwen3.8-flash'), d('deepseek-flash')],
  ji_feng: [q('deepseek-v4-flash'), g('deepseek-v4-flash'), q('qwen3.8-flash'), d('deepseek-flash')],
  yu_shi: [q('glm-5.2'), g('glm-5.2'), g('glm-5.3')],
  fu_he: [q('qwen3.8-flash'), g('qwen3.8-flash'), q('deepseek-v4-flash'), g('deepseek-v4-flash')],
  miao_bi: [q('qwen3.8-max'), g('qwen3.8-max'), q('kimi-k2.6'), g('kimi-k2.6')]
}

/** 默认升级通道：只在显式要求或 nativeEscalation=auto 且高风险时使用 */
export const DEFAULT_ESCALATION: Readonly<Partial<Record<RouteKey, EscalationKind>>> = {
  mou_ding: 'codex',
  shu_ji: 'claude',
  'suan_heng:research': 'codex',
  'suan_heng:verify': 'codex',
  zhu_jian: 'claude',
  yu_shi: 'codex'
}

export const getRouteKey = (role: RoleId, mode?: SuanHengMode): RouteKey =>
  role === 'suan_heng' ? `suan_heng:${mode ?? 'research'}` : role

export const getRouteLabel = (route: RouteInfo): string => `${route.provider}/${route.model}`

export const isSameRoute = (a: RouteInfo, b: RouteInfo): boolean => a.provider === b.provider && a.model === b.model

const FAMILY_RULES: ReadonlyArray<readonly [RegExp, ModelFamily]> = [
  [/^deepseek/, 'deepseek'],
  [/^qwen/, 'qwen'],
  [/^kimi/, 'kimi'],
  [/^glm/, 'glm'],
  [/^minimax/, 'minimax'],
  [/^mimo/, 'mimo'],
  [/^gpt|codex/, 'gpt'],
  [/^grok/, 'grok'],
  [/claude/, 'claude'],
  [/^hy\d/, 'hunyuan'],
  [/^longcat/, 'longcat']
]

/**
 * 按模型 ID 判断模型家族，用于实现者与审查者的独立性检查
 * @param {string} model - 模型 ID
 * @returns {ModelFamily} 家族
 */
export const getModelFamily = (model: string): ModelFamily => {
  const lower = model.toLowerCase()
  return FAMILY_RULES.find(([pattern]) => pattern.test(lower))?.[1] ?? 'other'
}

const CATALOG_BY_PROVIDER: Readonly<Record<string, CatalogInfo>> = {
  [PROVIDER_QWEN]: QWEN_TOKEN_PLAN_MODELS,
  [PROVIDER_GO]: OPENCODE_GO_MODELS,
  [PROVIDER_DS]: DEEPSEEK_OFFICIAL_MODELS
}

/**
 * 按内置目录判断路由是否支持图片；未知 provider 返回 undefined
 * @param {RouteInfo} route - 路由
 * @returns {boolean | undefined} 是否支持图片
 */
export const getCatalogVision = (route: RouteInfo): boolean | undefined =>
  CATALOG_BY_PROVIDER[route.provider]?.[route.model]?.vision

export type RouteProbeResult = { ok: true; vision: boolean } | { ok: false; reason: string }
export type RouteProbe = (route: RouteInfo) => Promise<RouteProbeResult>

/** 路由选择结果 */
export interface RouteSelection {
  usable: RouteInfo[]
  skipped: Array<{ route: RouteInfo; reason: string }>
  independence: 'achieved' | 'not-achieved' | 'n/a'
}

/**
 * 在链上筛出可用路由：先做可用性与视觉预检，再按独立性优先不同家族
 * @param {readonly RouteInfo[]} chain - 路由链
 * @param {{ probe: RouteProbe; requireVision?: boolean; avoidFamilies?: readonly ModelFamily[] }} options - 预检函数与约束
 * @returns {Promise<RouteSelection>} 可用路由与跳过原因
 */
export const FindUsableRoutes = async (
  chain: readonly RouteInfo[],
  options: { probe: RouteProbe; requireVision?: boolean; avoidFamilies?: readonly ModelFamily[] }
): Promise<RouteSelection> => {
  const skipped: RouteSelection['skipped'] = []
  const available: RouteInfo[] = []
  for (const route of chain) {
    const result = await options.probe(route)
    if (!result.ok) {
      skipped.push({ route, reason: result.reason })
      continue
    }
    if (options.requireVision === true && !result.vision) {
      skipped.push({ route, reason: 'vision-unsupported' })
      continue
    }
    available.push(route)
  }
  const avoid = options.avoidFamilies ?? []
  if (avoid.length === 0 || available.length === 0) return { usable: available, skipped, independence: 'n/a' }
  const independent = available.filter((route) => !avoid.includes(getModelFamily(route.model)))
  if (independent.length === 0) return { usable: available, skipped, independence: 'not-achieved' }
  const sameFamily = available.filter((route) => !independent.includes(route)).map((route) => ({ route, reason: 'same-family' }))
  return { usable: independent, skipped: [...skipped, ...sameFamily], independence: 'achieved' }
}

export type FailureClass = 'route-fatal' | 'auth' | 'transient' | 'other'

const ROUTE_FATAL_CODES = new Set(['NO_ADAPTER', 'UNKNOWN_MODEL', 'UNKNOWN_PROVIDER', 'MISSING_CREDENTIAL', 'QUOTA', 'UNSUPPORTED_OPTION', 'IMAGE_UNSUPPORTED'])
const AUTH_CODES = new Set(['INVALID_CREDENTIAL', 'UNAUTHORIZED', 'FORBIDDEN'])
const TRANSIENT_CODES = new Set(['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'OVERLOADED', 'SERVER_ERROR'])
const QUOTA_MESSAGE = /usage limit|quota|insufficient (balance|quota)|余额不足|额度/i

/**
 * 对模型请求失败分类，决定是否换路由
 * @param {LlmFailureLike | undefined} failure - 失败信息
 * @returns {FailureClass} 分类
 */
export const getFailureClass = (failure: LlmFailureLike | undefined): FailureClass => {
  if (failure === undefined) return 'other'
  const code = String(failure.code ?? '').toUpperCase()
  const status = failure.status ?? 0
  if (AUTH_CODES.has(code) || status === 401 || status === 403) return 'auth'
  if (ROUTE_FATAL_CODES.has(code) || QUOTA_MESSAGE.test(failure.message ?? '')) return 'route-fatal'
  if (TRANSIENT_CODES.has(code) || status === 408 || status === 429 || status >= 500) return 'transient'
  if (status === 400 || status === 404 || status === 422) return 'route-fatal'
  return 'other'
}

/**
 * 是否值得切换到下一条路由：致命与认证失败立即切换；瞬时/其他失败在宿主重试用尽后切换
 * @param {FailureClass} failureClass - 失败分类
 * @param {boolean} exhausted - 宿主是否已放弃（request-error 的 next() 返回 undefined）
 * @returns {boolean} 是否切换
 */
export const isSwitchWorthy = (failureClass: FailureClass, exhausted: boolean): boolean =>
  failureClass === 'route-fatal' || failureClass === 'auth' || exhausted

/**
 * 基于 ctx.llm 的路由预检：provider 已注册且模型可解析
 * @param {() => LlmLike | undefined} getLlm - 取 LLM 服务
 * @returns {RouteProbe} 预检函数
 */
export const intRouteProbe = (getLlm: () => LlmLike | undefined): RouteProbe => async (route) => {
  const llm = getLlm()
  if (llm === undefined) return { ok: false, reason: 'llm-service-unavailable' }
  if (!llm.listProviders().some((provider) => provider.id === route.provider)) return { ok: false, reason: 'provider-not-configured' }
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const vision = info.inputModalities === undefined ? (getCatalogVision(route) ?? false) : info.inputModalities.includes('image')
    return { ok: true, vision }
  } catch (error) {
    return { ok: false, reason: `model-unavailable: ${getErrorText(error)}` }
  }
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/routes.test.ts` 然后 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/routes.ts tests/unit/routes.test.ts
git commit -m "feat: add model catalogs, qwen-first default routes and failure classes"
```

---

### Task 4: 任务卡、门禁规则、门禁判定与预算

**Files:**
- Create: `src/policy.ts`
- Test: `tests/unit/policy.test.ts`

**Interfaces:**
- Consumes: `DelegableRoleId`、`SuanHengMode`、`getRoleInfo`（Task 2）
- Produces:
  - `GATE_IDS`、`GateId`、`FLAG_KEYS`、`FlagKey`、`TaskFlags`、`PerfInfo`、`TaskCard`、`GateSource`、`GateRequirement { gate; role; mode?; reason; source }`、`GATE_ROLE`
  - `ValidateTaskCard(input)` → `{ card?: TaskCard; errors: string[] }`
  - `hasPerfBudget(perf)`、`getRuleGates(card)`、`isTriageUseful(card, gates)`
  - `TriageAnswers { mathTask?: { choice; confidence }; needBenchmark?: number; novelty?: { score; confidence } }`、`TriageThresholdsInfo`、`DEFAULT_TRIAGE_THRESHOLDS`、`AddTriageGates(gates, card, triage: { answers?: TriageAnswers; failed: boolean; reason?: string }, thresholds)`
  - `getSuggestedRoles(card, gates)` → `Array<{ role; reason }>`
  - 门禁判定所需的委派视图 `GateDelegationView { delegationId; role; mode?; status; structured?; finishedAt?; independence }`、`FindingResolution { delegationId; index; resolution }`、`GateStatus`、`getEffectiveGates(gates, delegations)`、`getGateStatus(gate, delegations, resolutions)`、`getAcceptanceCheck(gates, delegations, resolutions)` → `{ ok; statuses; missing }`
  - `BudgetInfo`、`DEFAULT_BUDGETS`、`ValidateDelegationBudget(delegations, role, budgets)` → `string | undefined`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/policy.test.ts
import { describe, expect, it } from 'vitest'
import {
  AddTriageGates,
  DEFAULT_BUDGETS,
  DEFAULT_TRIAGE_THRESHOLDS,
  ValidateDelegationBudget,
  ValidateTaskCard,
  getAcceptanceCheck,
  getEffectiveGates,
  getGateStatus,
  getRuleGates,
  getSuggestedRoles,
  hasPerfBudget,
  isTriageUseful,
  type GateDelegationView,
  type TaskCard
} from '../../src/policy.js'

const makeCard = (flags: Partial<TaskCard['flags']> = {}, extra: Partial<TaskCard> = {}): TaskCard => {
  const result = ValidateTaskCard({ title: '任务', goal: '目标', acceptance: ['通过测试'], scope: ['src/a.ts'], flags, ...extra })
  if (result.card === undefined) throw new Error(result.errors.join(';'))
  return result.card
}

const done = (partial: Partial<GateDelegationView> & Pick<GateDelegationView, 'role'>): GateDelegationView => ({
  delegationId: `D-${partial.role}-${partial.finishedAt ?? 1}`,
  status: 'completed',
  startedAt: partial.finishedAt ?? 1,
  finishedAt: 1,
  independence: 'n/a',
  ...partial
})

describe('ValidateTaskCard', () => {
  it('填充缺省标志并保留字段', () => {
    const card = makeCard({ changesCode: true }, { perf: { p95Ms: 50 }, constraints: { apiCompat: '保持' } })
    expect(card.flags.changesCode).toBe(true)
    expect(card.flags.hasVisualInput).toBe(false)
    expect(card.perf).toEqual({ p95Ms: 50 })
    expect(card.constraints).toEqual({ apiCompat: '保持' })
  })

  it('报告非法输入', () => {
    expect(ValidateTaskCard('x').errors).toEqual(['任务卡必须是对象'])
    const result = ValidateTaskCard({ title: '', goal: 1, acceptance: [], scope: 'x', flags: { nope: true, changesCode: 'y' }, perf: { p95Ms: {} }, constraints: { apiCompat: 1 } })
    expect(result.card).toBeUndefined()
    expect(result.errors).toEqual(expect.arrayContaining([
      'title 必须是非空字符串',
      'goal 必须是非空字符串',
      'acceptance 至少包含 1 条验收标准',
      'scope 必须是字符串数组',
      '未知风险标志 nope',
      'flags.changesCode 必须是布尔值',
      'perf.p95Ms 必须是数字或「待测」',
      'constraints.apiCompat 必须是字符串'
    ]))
  })

  it('性能预算：数字才算，「待测」不算', () => {
    expect(hasPerfBudget(undefined)).toBe(false)
    expect(hasPerfBudget({ p95Ms: '待测' })).toBe(false)
    expect(hasPerfBudget({ p99Ms: 20 })).toBe(true)
    expect(hasPerfBudget({ throughput: '1k/s' })).toBe(true)
  })
})

describe('规则门禁', () => {
  it('代码改动 → 复核', () => {
    expect(getRuleGates(makeCard({ changesCode: true })).map((g) => g.gate)).toEqual(['G_VERIFY'])
  })

  it('量化核心算法改动触发全套门禁', () => {
    const gates = getRuleGates(makeCard({ changesCode: true, changesAlgorithm: true, touchesFinancialLogic: true }, { perf: { p95Ms: 50 } }))
    expect(gates.map((g) => g.gate).sort()).toEqual(['G_BENCH', 'G_DIFF_TEST', 'G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_REVIEW', 'G_VERIFY'])
    expect(gates.every((g) => g.source === 'rule')).toBe(true)
    expect(gates.find((g) => g.gate === 'G_MATH_VERIFY')).toMatchObject({ role: 'suan_heng', mode: 'verify' })
  })

  it('视觉输入 → 观象；纯文案无门禁', () => {
    expect(getRuleGates(makeCard({ hasVisualInput: true })).map((g) => g.gate)).toEqual(['G_VISION'])
    expect(getRuleGates(makeCard({ uiCopy: true }))).toEqual([])
  })

  it('何时值得调用 Jev', () => {
    expect(isTriageUseful(makeCard({ uiCopy: true }), [])).toBe(false)
    const card = makeCard({ changesCode: true })
    expect(isTriageUseful(card, getRuleGates(card))).toBe(true)
    const full = makeCard({ changesCode: true, changesAlgorithm: true, touchesFinancialLogic: true }, { perf: { p95Ms: 1 } })
    expect(isTriageUseful(full, getRuleGates(full))).toBe(false)
  })
})

describe('AddTriageGates', () => {
  const card = makeCard({ changesCode: true, changesAlgorithm: true })
  const base = getRuleGates(makeCard({ changesCode: true }))
  const th = DEFAULT_TRIAGE_THRESHOLDS

  it('Jev 只增加门禁', () => {
    const gates = AddTriageGates(base, card, { failed: false, answers: { mathTask: { choice: 'research', confidence: 0.9 }, needBenchmark: 0.7, novelty: { score: 1.6, confidence: 0.8 } } }, th)
    expect(gates.map((g) => g.gate).sort()).toEqual(['G_BENCH', 'G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_REVIEW', 'G_VERIFY'])
    expect(gates.filter((g) => g.source === 'jev')).toHaveLength(4)
  })

  it('ordinary 与低分不加门禁', () => {
    const gates = AddTriageGates(base, card, { failed: false, answers: { mathTask: { choice: 'ordinary', confidence: 0.9 }, needBenchmark: 0.1, novelty: { score: 0.2, confidence: 0.9 } } }, th)
    expect(gates.map((g) => g.gate)).toEqual(['G_VERIFY'])
  })

  it('失败或置信度低时，改算法任务走严格路径', () => {
    const failed = AddTriageGates(base, card, { failed: true, reason: 'http-529' }, th)
    expect(failed.filter((g) => g.source === 'jev-fallback').map((g) => g.gate).sort()).toEqual(['G_MATH_VERIFY', 'G_REVIEW'])
    expect(failed.find((g) => g.source === 'jev-fallback')?.reason).toContain('http-529')
    const lowConfidence = AddTriageGates(base, card, { failed: false, answers: { mathTask: { choice: 'invariant', confidence: 0.3 } } }, th)
    expect(lowConfidence.some((g) => g.gate === 'G_MATH_VERIFY' && g.source === 'jev-fallback')).toBe(true)
    const plain = makeCard({ changesCode: true })
    expect(AddTriageGates(base, plain, { failed: true }, th).map((g) => g.gate)).toEqual(['G_VERIFY'])
  })
})

describe('建议角色', () => {
  it('按标志与门禁给出建议且不重复', () => {
    const card = makeCard({ ambiguousRequirements: true, changesCode: true, needsExternalFacts: true, uiCopy: true, hasExecSteps: true, hasVisualInput: true, crossModuleArchitecture: true }, { scope: [] })
    const roles = getSuggestedRoles(card, getRuleGates(card)).map((s) => s.role)
    expect(roles).toEqual(expect.arrayContaining(['mou_ding', 'shu_ji', 'tan_wei', 'bo_wen', 'guan_xiang', 'miao_bi', 'zhu_jian', 'xing_zhou', 'fu_he', 'yu_shi']))
    expect(new Set(roles).size).toBe(roles.length)
    expect(getSuggestedRoles(makeCard({ changesCode: true }), []).map((s) => s.role)).toContain('ji_feng')
  })
})

describe('门禁判定', () => {
  const fuHePass = { verdict: 'pass', commands: [{ command: 'npm test', exitCode: 0, kind: 'unit', summary: 'ok' }] }

  it('G_VERIFY 需要在最后一次编辑之后的通过复核', () => {
    const edit = done({ role: 'ji_feng', finishedAt: 10 })
    expect(getGateStatus('G_VERIFY', [edit, done({ role: 'fu_he', finishedAt: 5, structured: fuHePass })], []).satisfied).toBe(false)
    expect(getGateStatus('G_VERIFY', [edit, done({ role: 'fu_he', finishedAt: 20, structured: fuHePass })], []).satisfied).toBe(true)
    expect(getGateStatus('G_VERIFY', [edit, done({ role: 'fu_he', startedAt: 10, finishedAt: 10, structured: fuHePass })], []).satisfied).toBe(true)
    expect(getGateStatus('G_VERIFY', [edit, done({ role: 'fu_he', startedAt: 9, finishedAt: 30, structured: fuHePass })], []).satisfied).toBe(false)
    expect(getGateStatus('G_VERIFY', [done({ role: 'fu_he', finishedAt: 20, structured: { ...fuHePass, verdict: 'fail' } })], []).satisfied).toBe(false)
  })

  it('G_DIFF_TEST 与 G_BENCH 需要对应类别的命令', () => {
    const diff = done({ role: 'fu_he', structured: { verdict: 'pass', commands: [{ command: 'diff', exitCode: 0, kind: 'differential', summary: '0 mismatch' }] } })
    expect(getGateStatus('G_DIFF_TEST', [diff], []).satisfied).toBe(true)
    expect(getGateStatus('G_BENCH', [diff], []).satisfied).toBe(false)
    const bench = done({ role: 'fu_he', structured: { verdict: 'pass', commands: [{ command: 'bench', exitCode: 0, kind: 'benchmark', summary: 'p95=12ms' }] } })
    expect(getGateStatus('G_BENCH', [bench], []).satisfied).toBe(true)
  })

  it('G_REVIEW 要求处理全部 critical/high 发现', () => {
    const review = done({ role: 'yu_shi', delegationId: 'D-r', structured: { findings: [{ severity: 'high', location: 'a', issue: 'x', suggestion: 'y' }, { severity: 'low', location: 'b', issue: 'x', suggestion: 'y' }] } })
    const missing = getGateStatus('G_REVIEW', [review], [])
    expect(missing.satisfied).toBe(false)
    expect(missing.missing).toContain('D-r#0')
    expect(getGateStatus('G_REVIEW', [review], [{ delegationId: 'D-r', index: 0, resolution: '已修复' }]).satisfied).toBe(true)
  })

  it('算衡与观象门禁', () => {
    const research = done({ role: 'suan_heng', mode: 'research', structured: { invariants: ['x'], complexity: 'O(n)' } })
    expect(getGateStatus('G_MATH_RESEARCH', [research], []).satisfied).toBe(true)
    expect(getGateStatus('G_MATH_RESEARCH', [done({ role: 'suan_heng', mode: 'research', structured: { invariants: [] } })], []).satisfied).toBe(false)
    const verify = done({ role: 'suan_heng', mode: 'verify', independence: 'not-achieved' })
    const status = getGateStatus('G_MATH_VERIFY', [verify], [])
    expect(status.satisfied).toBe(true)
    expect(status.notes.join('')).toContain('独立性未实现')
    expect(getGateStatus('G_VISION', [done({ role: 'guan_xiang', status: 'blocked' })], []).satisfied).toBe(false)
    expect(getGateStatus('G_VISION', [done({ role: 'guan_xiang' })], []).satisfied).toBe(true)
  })

  it('getEffectiveGates 在出现编辑委派后补上 G_VERIFY；验收汇总缺失项', () => {
    const gates = getEffectiveGates([], [done({ role: 'zhu_jian' })])
    expect(gates.map((g) => g.gate)).toEqual(['G_VERIFY'])
    expect(getEffectiveGates(gates, [done({ role: 'zhu_jian' })])).toHaveLength(1)
    const check = getAcceptanceCheck(gates, [done({ role: 'zhu_jian' })], [])
    expect(check.ok).toBe(false)
    expect(check.missing[0]).toContain('G_VERIFY')
    expect(getAcceptanceCheck([], [], []).ok).toBe(true)
  })
})

describe('预算', () => {
  it('任务总数与角色次数上限', () => {
    const many = Array.from({ length: DEFAULT_BUDGETS.maxDelegationsPerTask }, () => done({ role: 'tan_wei' }))
    expect(ValidateDelegationBudget(many, 'fu_he', DEFAULT_BUDGETS)).toContain('上限')
    const four = Array.from({ length: 4 }, () => done({ role: 'fu_he' }))
    expect(ValidateDelegationBudget(four, 'fu_he', DEFAULT_BUDGETS)).toContain('「复核」')
    expect(ValidateDelegationBudget(four, 'zhu_jian', DEFAULT_BUDGETS)).toBeUndefined()
    const blocked = Array.from({ length: 4 }, () => done({ role: 'fu_he', status: 'blocked' }))
    expect(ValidateDelegationBudget(blocked, 'fu_he', DEFAULT_BUDGETS)).toBeUndefined()
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/policy.test.ts`
Expected: FAIL，模块 `src/policy.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/policy.ts
import { getRoleInfo, type DelegableRoleId, type SuanHengMode } from './role-registry.js'

export const GATE_IDS = ['G_VERIFY', 'G_REVIEW', 'G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_DIFF_TEST', 'G_BENCH', 'G_VISION'] as const
export type GateId = typeof GATE_IDS[number]

export const FLAG_KEYS = [
  'changesCode', 'changesAlgorithm', 'touchesFinancialLogic', 'timeSeriesOrBacktest', 'stateMachine',
  'numericPrecision', 'sharedStateConcurrency', 'crossModuleArchitecture', 'securitySensitive',
  'hasVisualInput', 'uiCopy', 'hasExecSteps', 'needsExternalFacts', 'ambiguousRequirements'
] as const
export type FlagKey = typeof FLAG_KEYS[number]
export type TaskFlags = Record<FlagKey, boolean>

/** 性能预算；未知参数写「待测」 */
export interface PerfInfo {
  p95Ms?: number | string
  p99Ms?: number | string
  throughput?: string
  dataScale?: string
}

/** 经校验的任务卡 */
export interface TaskCard {
  title: string
  goal: string
  acceptance: string[]
  scope: string[]
  constraints?: { apiCompat?: string; environment?: string; resourceLimits?: string }
  perf?: PerfInfo
  flags: TaskFlags
}

export type GateSource = 'rule' | 'jev' | 'jev-fallback'

/** 一条必需门禁 */
export interface GateRequirement {
  gate: GateId
  role: DelegableRoleId
  mode?: SuanHengMode
  reason: string
  source: GateSource
}

/** 门禁 → 负责角色 */
export const GATE_ROLE: Readonly<Record<GateId, { role: DelegableRoleId; mode?: SuanHengMode; label: string }>> = {
  G_VERIFY: { role: 'fu_he', label: '复核实际运行验证' },
  G_REVIEW: { role: 'yu_shi', label: '御史独立审查' },
  G_MATH_RESEARCH: { role: 'suan_heng', mode: 'research', label: '算衡·研算' },
  G_MATH_VERIFY: { role: 'suan_heng', mode: 'verify', label: '算衡·验算（与研算不同模型家族）' },
  G_DIFF_TEST: { role: 'fu_he', label: '差分/性质测试' },
  G_BENCH: { role: 'fu_he', label: '可重复基准测试' },
  G_VISION: { role: 'guan_xiang', label: '观象视觉核对' }
}

const PERF_NUMBER_KEYS = ['p95Ms', 'p99Ms'] as const
const PERF_TEXT_KEYS = ['throughput', 'dataScale'] as const
const CONSTRAINT_KEYS = ['apiCompat', 'environment', 'resourceLimits'] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const getStringList = (value: unknown, key: string, errors: string[]): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${key} 必须是字符串数组`)
    return []
  }
  return value as string[]
}

const getFlags = (raw: unknown, errors: string[]): TaskFlags => {
  const flags = Object.fromEntries(FLAG_KEYS.map((key) => [key, false])) as TaskFlags
  if (raw === undefined) return flags
  if (!isPlainObject(raw)) {
    errors.push('flags 必须是对象')
    return flags
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(FLAG_KEYS as readonly string[]).includes(key)) errors.push(`未知风险标志 ${key}`)
    else if (typeof value !== 'boolean') errors.push(`flags.${key} 必须是布尔值`)
    else flags[key as FlagKey] = value
  }
  return flags
}

const getPerf = (raw: unknown, errors: string[]): PerfInfo | undefined => {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    errors.push('perf 必须是对象')
    return undefined
  }
  for (const key of PERF_NUMBER_KEYS) {
    const value = raw[key]
    if (value !== undefined && typeof value !== 'number' && value !== '待测') errors.push(`perf.${key} 必须是数字或「待测」`)
  }
  for (const key of PERF_TEXT_KEYS) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') errors.push(`perf.${key} 必须是字符串`)
  }
  return raw as PerfInfo
}

const getConstraints = (raw: unknown, errors: string[]): TaskCard['constraints'] => {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    errors.push('constraints 必须是对象')
    return undefined
  }
  for (const key of CONSTRAINT_KEYS) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') errors.push(`constraints.${key} 必须是字符串`)
  }
  return raw as TaskCard['constraints']
}

/**
 * 校验并规范化任务卡输入
 * @param {unknown} input - swarm_task_card 的参数
 * @returns {{ card?: TaskCard; errors: string[] }} 规范化后的任务卡或错误列表
 */
export const ValidateTaskCard = (input: unknown): { card?: TaskCard; errors: string[] } => {
  if (!isPlainObject(input)) return { errors: ['任务卡必须是对象'] }
  const errors: string[] = []
  const getText = (key: 'title' | 'goal'): string => {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    errors.push(`${key} 必须是非空字符串`)
    return ''
  }
  const title = getText('title')
  const goal = getText('goal')
  const acceptance = getStringList(input.acceptance, 'acceptance', errors)
  if (acceptance.length === 0) errors.push('acceptance 至少包含 1 条验收标准')
  const scope = getStringList(input.scope, 'scope', errors)
  const flags = getFlags(input.flags, errors)
  const perf = getPerf(input.perf, errors)
  const constraints = getConstraints(input.constraints, errors)
  if (errors.length > 0) return { errors }
  return {
    card: {
      title, goal, acceptance, scope, flags,
      ...(perf === undefined ? {} : { perf }),
      ...(constraints === undefined ? {} : { constraints })
    },
    errors: []
  }
}

/**
 * 是否声明了真实的性能预算（「待测」不算）
 * @param {PerfInfo | undefined} perf - 性能预算
 * @returns {boolean} 是否需要基准门禁
 */
export const hasPerfBudget = (perf: PerfInfo | undefined): boolean =>
  perf !== undefined && Object.values(perf).some((value) => value !== undefined && value !== '' && value !== '待测')

const AddGate = (gates: GateRequirement[], gate: GateId, reason: string, source: GateSource): void => {
  if (gates.some((item) => item.gate === gate)) return
  const { role, mode } = GATE_ROLE[gate]
  gates.push({ gate, role, ...(mode === undefined ? {} : { mode }), reason, source })
}

const getFlagReason = (card: TaskCard, keys: readonly FlagKey[]): string =>
  keys.filter((key) => card.flags[key]).join('、')

/**
 * 确定性规则给出的强制门禁（先于 Jev，且不能被 Jev 移除）
 * @param {TaskCard} card - 任务卡
 * @returns {GateRequirement[]} 门禁列表
 */
export const getRuleGates = (card: TaskCard): GateRequirement[] => {
  const f = card.flags
  const gates: GateRequirement[] = []
  if (f.changesCode) AddGate(gates, 'G_VERIFY', '任务涉及代码改动', 'rule')
  const reviewKeys: FlagKey[] = ['crossModuleArchitecture', 'sharedStateConcurrency', 'changesAlgorithm', 'securitySensitive', 'touchesFinancialLogic', 'timeSeriesOrBacktest']
  if (reviewKeys.some((key) => f[key])) AddGate(gates, 'G_REVIEW', `高风险标志：${getFlagReason(card, reviewKeys)}`, 'rule')
  if (f.changesAlgorithm) AddGate(gates, 'G_MATH_RESEARCH', '改变算法语义，需在实现前定义不变量与复杂度', 'rule')
  const mathKeys: FlagKey[] = ['touchesFinancialLogic', 'timeSeriesOrBacktest', 'stateMachine', 'numericPrecision', 'sharedStateConcurrency']
  if (mathKeys.some((key) => f[key])) AddGate(gates, 'G_MATH_VERIFY', `强制验算：${getFlagReason(card, mathKeys)}`, 'rule')
  if ((f.touchesFinancialLogic || f.timeSeriesOrBacktest) && f.changesAlgorithm) AddGate(gates, 'G_DIFF_TEST', '量化核心算法改动需要差分/性质测试', 'rule')
  if (hasPerfBudget(card.perf)) AddGate(gates, 'G_BENCH', '任务声明了性能预算', 'rule')
  if (f.hasVisualInput) AddGate(gates, 'G_VISION', '任务包含截图、设计稿或视觉产物', 'rule')
  return gates
}

/**
 * 是否值得调用 Jev：只在涉及代码/算法/性能且规则尚未覆盖全部可加门禁时调用
 * @param {TaskCard} card - 任务卡
 * @param {GateRequirement[]} gates - 规则门禁
 * @returns {boolean} 是否调用
 */
export const isTriageUseful = (card: TaskCard, gates: GateRequirement[]): boolean => {
  const relevant = card.flags.changesCode || card.flags.changesAlgorithm || hasPerfBudget(card.perf)
  if (!relevant) return false
  const present = new Set(gates.map((item) => item.gate))
  const addable: GateId[] = ['G_REVIEW', 'G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_BENCH']
  return addable.some((gate) => !present.has(gate))
}

/** Jev 答案中本插件读取的字段 */
export interface TriageAnswers {
  mathTask?: { choice: string; confidence: number }
  needBenchmark?: number
  novelty?: { score: number; confidence: number }
}

/** Jev 分流阈值（保守默认值，可按本地标注集校准） */
export interface TriageThresholdsInfo {
  mathConfidence: number
  benchmarkNoul: number
  noveltyScore: number
  noveltyConfidence: number
}

export const DEFAULT_TRIAGE_THRESHOLDS: TriageThresholdsInfo = {
  mathConfidence: 0.6,
  benchmarkNoul: 0.5,
  noveltyScore: 1,
  noveltyConfidence: 0.5
}

const AddStrictGates = (gates: GateRequirement[], card: TaskCard, reason: string): void => {
  if (!card.flags.changesAlgorithm) return
  AddGate(gates, 'G_MATH_VERIFY', `衡鉴按严格路径：${reason}`, 'jev-fallback')
  AddGate(gates, 'G_REVIEW', `衡鉴按严格路径：${reason}`, 'jev-fallback')
}

/**
 * 按 Jev 答案追加门禁；Jev 失败或置信度低时走严格路径。只增不减
 * @param {GateRequirement[]} gates - 已有门禁
 * @param {TaskCard} card - 任务卡
 * @param {{ answers?: TriageAnswers; failed: boolean; reason?: string }} triage - Jev 结果
 * @param {TriageThresholdsInfo} thresholds - 阈值
 * @returns {GateRequirement[]} 新的门禁列表
 */
export const AddTriageGates = (
  gates: GateRequirement[],
  card: TaskCard,
  triage: { answers?: TriageAnswers; failed: boolean; reason?: string },
  thresholds: TriageThresholdsInfo
): GateRequirement[] => {
  const out = gates.map((item) => ({ ...item }))
  const answers = triage.answers
  if (triage.failed || answers === undefined) {
    AddStrictGates(out, card, triage.reason ?? 'Jev 不可用')
    return out
  }
  const mathTask = answers.mathTask
  if (mathTask !== undefined && mathTask.confidence < thresholds.mathConfidence) {
    AddStrictGates(out, card, `math_task 置信度 ${mathTask.confidence} 低于阈值 ${thresholds.mathConfidence}`)
  } else if (mathTask !== undefined && ['invariant', 'equivalence', 'research'].includes(mathTask.choice)) {
    AddGate(out, 'G_MATH_VERIFY', `Jev：数学检查类型 ${mathTask.choice}（置信度 ${mathTask.confidence}）`, 'jev')
    if (mathTask.choice === 'research') AddGate(out, 'G_MATH_RESEARCH', 'Jev：需要设计新算法', 'jev')
  }
  if ((answers.needBenchmark ?? 0) >= thresholds.benchmarkNoul) AddGate(out, 'G_BENCH', `Jev：需要基准（概率 ${answers.needBenchmark}）`, 'jev')
  const novelty = answers.novelty
  if (novelty !== undefined && novelty.score >= thresholds.noveltyScore && novelty.confidence >= thresholds.noveltyConfidence) {
    AddGate(out, 'G_REVIEW', `Jev：算法变化程度 ${novelty.score}`, 'jev')
  }
  return out
}

/**
 * 根据任务卡与门禁建议参与的角色（天枢据此决策，不强制）
 * @param {TaskCard} card - 任务卡
 * @param {GateRequirement[]} gates - 门禁
 * @returns {Array<{ role: DelegableRoleId; reason: string }>} 建议
 */
export const getSuggestedRoles = (card: TaskCard, gates: GateRequirement[]): Array<{ role: DelegableRoleId; reason: string }> => {
  const out: Array<{ role: DelegableRoleId; reason: string }> = []
  const push = (role: DelegableRoleId, reason: string): void => {
    if (!out.some((item) => item.role === role)) out.push({ role, reason })
  }
  const f = card.flags
  if (f.ambiguousRequirements) push('mou_ding', '需求模糊或多目标，先分解约束与方案')
  if (f.crossModuleArchitecture || f.sharedStateConcurrency) push('shu_ji', '跨模块或共享状态边界需要先梳理')
  if (f.changesCode && card.scope.length === 0) push('tan_wei', '未给出代码范围，先定位代码与调用链')
  if (f.needsExternalFacts) push('bo_wen', '需要外部资料')
  if (f.hasVisualInput) push('guan_xiang', '有图片或视觉产物')
  if (f.uiCopy) push('miao_bi', '涉及文案与表达')
  if (f.changesCode) push(f.changesAlgorithm || f.crossModuleArchitecture ? 'zhu_jian' : 'ji_feng', f.changesAlgorithm || f.crossModuleArchitecture ? '跨文件或算法实现' : '局部低风险改动')
  if (f.hasExecSteps) push('xing_zhou', '有明确的执行步骤')
  for (const item of gates) push(item.role, `门禁 ${item.gate}：${GATE_ROLE[item.gate].label}`)
  return out
}

/** 门禁判定需要的委派字段 */
export interface GateDelegationView {
  delegationId: string
  role: DelegableRoleId
  mode?: SuanHengMode
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked'
  structured?: unknown
  startedAt?: number
  finishedAt?: number
  independence: 'achieved' | 'not-achieved' | 'n/a'
}

/** 天枢对御史发现的处理说明 */
export interface FindingResolution {
  delegationId: string
  index: number
  resolution: string
}

/** 单个门禁的判定结果 */
export interface GateStatus {
  gate: GateId
  satisfied: boolean
  by?: string
  missing?: string
  notes: string[]
}

const EDIT_ROLES: readonly DelegableRoleId[] = ['zhu_jian', 'ji_feng']

const getLastEditTime = (delegations: GateDelegationView[]): number =>
  Math.max(0, ...delegations.filter((d) => EDIT_ROLES.includes(d.role) && d.status === 'completed').map((d) => d.finishedAt ?? 0))

/** 在 after 时刻之后才开始的已完成委派（验证必须开始于最后一次编辑结束之后），按完成时间倒序 */
const getCompletedAfter = (delegations: GateDelegationView[], role: DelegableRoleId, after: number, mode?: SuanHengMode): GateDelegationView[] =>
  delegations
    .filter((d) => d.role === role && d.status === 'completed' && (d.startedAt ?? d.finishedAt ?? 0) >= after && (mode === undefined || d.mode === mode))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))

interface CommandView { exitCode?: unknown; kind?: unknown; summary?: unknown }

const getCommands = (d: GateDelegationView): CommandView[] => {
  const commands = (d.structured as { commands?: unknown } | undefined)?.commands
  return Array.isArray(commands) ? (commands as CommandView[]) : []
}

const hasPassedCommand = (d: GateDelegationView, kinds?: readonly string[]): boolean =>
  getCommands(d).some((c) => c.exitCode === 0 && (kinds === undefined || kinds.includes(String(c.kind))) && (kinds === undefined || String(c.summary ?? '') !== ''))

const isVerdictPass = (d: GateDelegationView): boolean =>
  (d.structured as { verdict?: unknown } | undefined)?.verdict === 'pass' && getCommands(d).some((c) => typeof c.exitCode === 'number')

const getSatisfied = (gate: GateId, by: GateDelegationView | undefined, missing: string, notes: string[] = []): GateStatus =>
  by === undefined ? { gate, satisfied: false, missing, notes } : { gate, satisfied: true, by: by.delegationId, notes }

const getReviewStatus = (delegations: GateDelegationView[], resolutions: FindingResolution[], after: number): GateStatus => {
  const review = getCompletedAfter(delegations, 'yu_shi', after)[0]
  if (review === undefined) return getSatisfied('G_REVIEW', undefined, '缺少最后一次代码改动之后的御史审查')
  const findings = (review.structured as { findings?: Array<{ severity?: string }> } | undefined)?.findings ?? []
  const unresolved = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.severity === 'critical' || finding.severity === 'high')
    .filter(({ index }) => !resolutions.some((r) => r.delegationId === review.delegationId && r.index === index && r.resolution.trim() !== ''))
    .map(({ index }) => `${review.delegationId}#${index}`)
  if (unresolved.length > 0) return { gate: 'G_REVIEW', satisfied: false, missing: `御史的严重/高危发现未给出处理：${unresolved.join(', ')}`, notes: [] }
  return getSatisfied('G_REVIEW', review, '', review.independence === 'not-achieved' ? ['审查者与实现者模型家族相同（独立性未实现）'] : [])
}

/**
 * 判定单个门禁是否已由证据满足
 * @param {GateId} gate - 门禁
 * @param {GateDelegationView[]} delegations - 本任务的委派
 * @param {FindingResolution[]} resolutions - 天枢对御史发现的处理
 * @returns {GateStatus} 判定结果
 */
export const getGateStatus = (gate: GateId, delegations: GateDelegationView[], resolutions: FindingResolution[]): GateStatus => {
  const lastEdit = getLastEditTime(delegations)
  const fuHe = getCompletedAfter(delegations, 'fu_he', lastEdit)
  switch (gate) {
    case 'G_VERIFY':
      return getSatisfied(gate, fuHe.find(isVerdictPass), '缺少最后一次代码改动之后、判定为通过且带退出码的复核结果')
    case 'G_DIFF_TEST':
      return getSatisfied(gate, fuHe.find((d) => hasPassedCommand(d, ['differential', 'property'])), '复核结果中没有通过的差分/性质测试命令')
    case 'G_BENCH':
      return getSatisfied(gate, fuHe.find((d) => hasPassedCommand(d, ['benchmark'])), '复核结果中没有通过且带数值摘要的基准命令')
    case 'G_REVIEW':
      return getReviewStatus(delegations, resolutions, lastEdit)
    case 'G_MATH_RESEARCH': {
      const research = getCompletedAfter(delegations, 'suan_heng', 0, 'research').find((d) => {
        const s = d.structured as { invariants?: unknown[]; complexity?: string } | undefined
        return (s?.invariants?.length ?? 0) > 0 && (s?.complexity ?? '').trim() !== ''
      })
      return getSatisfied(gate, research, '缺少含不变量与复杂度的算衡·研算结果')
    }
    case 'G_MATH_VERIFY': {
      const verify = getCompletedAfter(delegations, 'suan_heng', 0, 'verify')[0]
      return getSatisfied(gate, verify, '缺少算衡·验算结果', verify?.independence === 'not-achieved' ? ['验算与研算模型家族相同（独立性未实现）'] : [])
    }
    case 'G_VISION':
      return getSatisfied(gate, getCompletedAfter(delegations, 'guan_xiang', 0)[0], '缺少观象的视觉观察结果')
  }
}

/**
 * 实际生效的门禁：出现过编辑委派时自动补上 G_VERIFY
 * @param {GateRequirement[]} gates - 任务卡门禁
 * @param {GateDelegationView[]} delegations - 本任务的委派
 * @returns {GateRequirement[]} 生效门禁
 */
export const getEffectiveGates = (gates: GateRequirement[], delegations: GateDelegationView[]): GateRequirement[] => {
  const out = gates.map((item) => ({ ...item }))
  if (delegations.some((d) => EDIT_ROLES.includes(d.role) && d.status === 'completed')) {
    AddGate(out, 'G_VERIFY', '任务中出现过代码改动委派', 'rule')
  }
  return out
}

/**
 * 汇总全部门禁的判定结果
 * @param {GateRequirement[]} gates - 生效门禁
 * @param {GateDelegationView[]} delegations - 本任务的委派
 * @param {FindingResolution[]} resolutions - 发现处理
 * @returns {{ ok: boolean; statuses: GateStatus[]; missing: string[] }} 是否可验收
 */
export const getAcceptanceCheck = (gates: GateRequirement[], delegations: GateDelegationView[], resolutions: FindingResolution[]) => {
  const statuses = gates.map((item) => getGateStatus(item.gate, delegations, resolutions))
  const missing = statuses.filter((s) => !s.satisfied).map((s) => `${s.gate}：${s.missing ?? '未满足'}`)
  return { ok: missing.length === 0, statuses, missing }
}

/** 调用预算 */
export interface BudgetInfo {
  maxDelegationsPerTask: number
  maxCallsPerRole: number
  maxCallsZhuJian: number
  maxAutoFixRounds: number
  delegationTimeoutMs: number
}

export const DEFAULT_BUDGETS: BudgetInfo = {
  maxDelegationsPerTask: 20,
  maxCallsPerRole: 4,
  maxCallsZhuJian: 6,
  maxAutoFixRounds: 2,
  delegationTimeoutMs: 30 * 60 * 1000
}

/**
 * 检查本次委派是否超出预算；被预算拦下的 blocked 委派不计数
 * @param {GateDelegationView[]} delegations - 本任务已有委派
 * @param {DelegableRoleId} role - 本次角色
 * @param {BudgetInfo} budgets - 预算
 * @returns {string | undefined} 超出原因
 */
export const ValidateDelegationBudget = (delegations: GateDelegationView[], role: DelegableRoleId, budgets: BudgetInfo): string | undefined => {
  const counted = delegations.filter((d) => d.status !== 'blocked')
  if (counted.length >= budgets.maxDelegationsPerTask) return `任务委派数已达上限 ${budgets.maxDelegationsPerTask}`
  const limit = role === 'zhu_jian' ? budgets.maxCallsZhuJian : budgets.maxCallsPerRole
  if (counted.filter((d) => d.role === role).length >= limit) return `角色「${getRoleInfo(role).name}」在本任务的调用次数已达上限 ${limit}`
  return undefined
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/policy.test.ts` 然后 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/policy.ts tests/unit/policy.test.ts
git commit -m "feat: add task card validation, gate rules, triage gates and budgets"
```

---

### Task 5: Jev 客户端（衡鉴）

**Files:**
- Create: `src/jev.ts`
- Test: `tests/unit/jev.test.ts`

**Interfaces:**
- Consumes: `TaskCard`、`TriageAnswers`（Task 4）
- Produces: `JevConfigInfo`、`DEFAULT_JEV_CONFIG`、`JEV_PATH`、`JEV_QUESTIONS`、`getRedactedText(text)`、`getJevState(card)`、`ParseJevAnswers(body)`、`JevOutcome = { ok: true; answers; attempts } | { ok: false; reason; attempts }`、`intJevClient(config, deps: { fetch; getApiKey; sleep? })` → `{ triage(card, signal?) }`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/jev.test.ts
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_JEV_CONFIG, JEV_PATH, JEV_QUESTIONS, ParseJevAnswers, getJevState, getRedactedText, intJevClient } from '../../src/jev.js'
import { ValidateTaskCard, type TaskCard } from '../../src/policy.js'

const card = ValidateTaskCard({
  title: '优化增量笔 key=sk-abcdefghijklmnop',
  goal: '降低延迟，token: secret123',
  acceptance: ['差分测试通过'],
  scope: ['src/bi.ts'],
  flags: { changesAlgorithm: true, touchesFinancialLogic: true },
  perf: { p95Ms: 50 }
}).card as TaskCard

const okBody = {
  model: 'jev-1.13.0',
  answers: {
    math_task: { type: 'choice', choice: 'equivalence', probabilities: {}, confidence: 0.82 },
    need_benchmark: { type: 'noul', noul: 0.91 },
    novelty: { type: 'score', score: 1.2, legend: [], probabilities: [], confidence: 0.7 }
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('脱敏与请求体', () => {
  it('去除密钥样式内容并截断', () => {
    expect(getRedactedText('key=sk-abcdefghijklmnop')).not.toContain('sk-abcdefghijklmnop')
    expect(getRedactedText('Authorization: Bearer abc.def')).toContain('[已脱敏]')
    expect(getRedactedText('x'.repeat(600)).length).toBeLessThanOrEqual(500)
  })

  it('state 只含结构化摘要，不含源码与密钥', () => {
    const state = getJevState(card)
    expect(state.task).not.toContain('sk-abc')
    expect(state.goal).not.toContain('secret123')
    expect(state.flags).toMatchObject({ changesAlgorithm: true })
    expect(state).toMatchObject({ acceptance_count: 1, scope_count: 1, profile: { p95Ms: 50 } })
    expect(Object.keys(JEV_QUESTIONS)).toEqual(['math_task', 'need_benchmark', 'novelty'])
  })

  it('解析答案：noul 没有 confidence', () => {
    expect(ParseJevAnswers(okBody)).toEqual({ mathTask: { choice: 'equivalence', confidence: 0.82 }, needBenchmark: 0.91, novelty: { score: 1.2, confidence: 0.7 } })
    expect(ParseJevAnswers({})).toEqual({})
    expect(ParseJevAnswers(null)).toEqual({})
  })
})

describe('intJevClient', () => {
  const sleep = async () => undefined

  it('成功调用：发送 Bearer 与 JSON，返回答案', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody))
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as unknown as typeof fetch, getApiKey: async () => 'k1', sleep })
    const outcome = await client.triage(card)
    expect(outcome).toEqual({ ok: true, attempts: 1, answers: ParseJevAnswers(okBody) })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.typesafe.ai${JEV_PATH}`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k1')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'jev-latest', questions: { need_benchmark: { type: 'noul' } } })
  })

  it('未启用或没有密钥时不调用', async () => {
    const fetchMock = vi.fn()
    const disabled = intJevClient({ ...DEFAULT_JEV_CONFIG, enabled: false }, { fetch: fetchMock as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await disabled.triage(card)).toEqual({ ok: false, reason: 'disabled', attempts: 0 })
    const noKey = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as unknown as typeof fetch, getApiKey: async () => undefined, sleep })
    expect(await noKey.triage(card)).toEqual({ ok: false, reason: 'missing-api-key', attempts: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('429/529 退避重试，超过次数后失败', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(529, {}))
      .mockResolvedValueOnce(jsonResponse(200, okBody))
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect((await client.triage(card)).attempts).toBe(3)
    const always = vi.fn(async () => jsonResponse(529, {}))
    const failing = intJevClient(DEFAULT_JEV_CONFIG, { fetch: always as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await failing.triage(card)).toEqual({ ok: false, reason: 'http-529', attempts: 3 })
  })

  it('401/422 不重试；网络错误与格式错误', async () => {
    const unauthorized = vi.fn(async () => jsonResponse(401, {}))
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: unauthorized as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await client.triage(card)).toEqual({ ok: false, reason: 'http-401', attempts: 1 })
    const network = vi.fn(async () => { throw new TypeError('fetch failed') })
    const net = intJevClient({ ...DEFAULT_JEV_CONFIG, maxRetries: 0 }, { fetch: network as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await net.triage(card)).toEqual({ ok: false, reason: 'network', attempts: 1 })
    const malformed = vi.fn(async () => jsonResponse(200, { answers: {} }))
    const bad = intJevClient(DEFAULT_JEV_CONFIG, { fetch: malformed as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await bad.triage(card)).toEqual({ ok: false, reason: 'malformed-response', attempts: 1 })
  })

  it('超时视为可重试失败', async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const client = intJevClient({ ...DEFAULT_JEV_CONFIG, timeoutMs: 5, maxRetries: 1 }, { fetch: hanging as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await client.triage(card)).toEqual({ ok: false, reason: 'timeout', attempts: 2 })
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/jev.test.ts`
Expected: FAIL，模块 `src/jev.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/jev.ts
import type { TaskCard, TriageAnswers } from './policy.js'

/** Jev 调用配置 */
export interface JevConfigInfo {
  enabled: boolean
  apiKeyEnv: string
  baseUrl: string
  model: string
  timeoutMs: number
  maxRetries: number
  maxCallsPerSession: number
}

export const DEFAULT_JEV_CONFIG: JevConfigInfo = {
  enabled: true,
  apiKeyEnv: 'TYPESAFE_API_KEY',
  baseUrl: 'https://api.typesafe.ai',
  model: 'jev-latest',
  timeoutMs: 10000,
  maxRetries: 2,
  maxCallsPerSession: 20
}

export const JEV_PATH = '/v1/systemone'

/** V2 设计稿 §4 定义的三道分流题 */
export const JEV_QUESTIONS = {
  math_task: {
    type: 'choice',
    instructions: '选择此任务需要的数学检查类型；按最高必要强度选择',
    criteria: {
      ordinary: '只改变工程实现，不改变算法语义',
      invariant: '需要检查边界条件、状态不变量或数值精度',
      equivalence: '增量和全量实现需要语义等价验证',
      research: '需要设计新算法并比较复杂度、正确性和性能'
    }
  },
  need_benchmark: {
    type: 'noul',
    instructions: '是否有性能目标或关键数据规模要求，需做可重复基准测试'
  },
  novelty: {
    type: 'score',
    instructions: '算法变化的程度',
    criteria: ['行为不变的局部调整', '改变状态或边界处理', '提出新算法或语义']
  }
} as const

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi
]

const MAX_TEXT = 500

/**
 * 去掉密钥样式内容并截断，保证发往 Jev 的只有脱敏摘要
 * @param {string} text - 原文
 * @returns {string} 脱敏文本
 */
export const getRedactedText = (text: string): string =>
  SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[已脱敏]'), text).slice(0, MAX_TEXT)

/**
 * 构造 Jev 的 state：只含任务卡的结构化摘要，不含源码、路径内容与密钥
 * @param {TaskCard} card - 任务卡
 * @returns {object} state
 */
export const getJevState = (card: TaskCard) => ({
  task: getRedactedText(card.title),
  goal: getRedactedText(card.goal),
  flags: card.flags,
  profile: card.perf ?? {},
  acceptance_count: card.acceptance.length,
  scope_count: card.scope.length
})

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

/**
 * 只读取程序需要的字段：math_task.choice/confidence、need_benchmark.noul、novelty.score/confidence
 * @param {unknown} body - Jev 响应体
 * @returns {TriageAnswers} 解析结果
 */
export const ParseJevAnswers = (body: unknown): TriageAnswers => {
  const answers = asRecord(asRecord(body).answers)
  const mathTask = asRecord(answers.math_task)
  const benchmark = asRecord(answers.need_benchmark)
  const novelty = asRecord(answers.novelty)
  return {
    ...(typeof mathTask.choice === 'string' && typeof mathTask.confidence === 'number'
      ? { mathTask: { choice: mathTask.choice, confidence: mathTask.confidence } }
      : {}),
    ...(typeof benchmark.noul === 'number' ? { needBenchmark: benchmark.noul } : {}),
    ...(typeof novelty.score === 'number' && typeof novelty.confidence === 'number'
      ? { novelty: { score: novelty.score, confidence: novelty.confidence } }
      : {})
  }
}

export type JevOutcome =
  | { ok: true; answers: TriageAnswers; attempts: number }
  | { ok: false; reason: string; attempts: number }

/** Jev 客户端依赖 */
export interface JevDepsInfo {
  fetch: typeof fetch
  getApiKey: () => Promise<string | undefined>
  sleep?: (ms: number) => Promise<void>
}

type PostResult = { kind: 'ok'; body: unknown } | { kind: 'http'; status: number } | { kind: 'timeout' } | { kind: 'network' }

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 创建 Jev 客户端
 * @param {JevConfigInfo} config - 调用配置
 * @param {JevDepsInfo} deps - fetch、密钥读取与等待函数
 * @returns {{ triage: (card: TaskCard, signal?: AbortSignal) => Promise<JevOutcome> }} 客户端
 */
export const intJevClient = (config: JevConfigInfo, deps: JevDepsInfo) => {
  const sleep = deps.sleep ?? defaultSleep

  const postOnce = async (body: string, key: string, signal?: AbortSignal): Promise<PostResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await deps.fetch(`${config.baseUrl.replace(/\/$/, '')}${JEV_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal
      })
      if (!response.ok) return { kind: 'http', status: response.status }
      return { kind: 'ok', body: await response.json() }
    } catch {
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const triage = async (card: TaskCard, signal?: AbortSignal): Promise<JevOutcome> => {
    if (!config.enabled) return { ok: false, reason: 'disabled', attempts: 0 }
    const key = await deps.getApiKey()
    if (key === undefined || key === '') return { ok: false, reason: 'missing-api-key', attempts: 0 }
    const body = JSON.stringify({ model: config.model, state: getJevState(card), questions: JEV_QUESTIONS })
    for (let attempt = 1; ; attempt++) {
      const result = await postOnce(body, key, signal)
      if (result.kind === 'ok') {
        const answers = ParseJevAnswers(result.body)
        if (Object.keys(answers).length === 0) return { ok: false, reason: 'malformed-response', attempts: attempt }
        return { ok: true, answers, attempts: attempt }
      }
      const retryable = result.kind !== 'http' || RETRYABLE_STATUS.has(result.status)
      const reason = result.kind === 'http' ? `http-${result.status}` : result.kind
      if (!retryable || attempt > config.maxRetries) return { ok: false, reason, attempts: attempt }
      await sleep(500 * 2 ** (attempt - 1))
    }
  }

  return { triage }
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/jev.test.ts` 然后 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/jev.ts tests/unit/jev.test.ts
git commit -m "feat: add Jev triage client with redaction, timeout and retry"
```

---

### Task 6: 任务与委派存储、状态机、证据账本

**Files:**
- Create: `src/evidence.ts`
- Test: `tests/unit/evidence.test.ts`

**Interfaces:**
- Consumes: `TaskCard`、`GateRequirement`、`TriageAnswers`、`GateDelegationView`（Task 4）、`EvidenceItem`（Task 2）、`RouteInfo`（Task 3）、`SwarmError`（Task 1）
- Produces:
  - `DelegationStatus`、`BackendKind = 'spawn' | 'codex' | 'codex-edit' | 'claude-plan' | 'claude-edit'`、`RouteAttempt { route; backend; outcome; reason? }`、`DelegationRecord`（扩展 `GateDelegationView`）、`TriageRecord`、`AcceptanceRecord`、`TaskRecord`
  - `ValidateTransition(from, to)`、`intTaskStore()` → `TaskStore { AddTask; getTask; UpdateTask; AddDelegation; UpdateDelegation; getDelegation; getTaskDelegations; getTasks }`
  - `LedgerEventType`、`LedgerEvent`、`getLedgerPath(dir, sessionId)`、`getRedactedValue(value)`、`intLedger(dir, sessionId, onError?)` → `Ledger { path; AddLedgerEvent(event) }`、`getLedgerEvents(path)`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/evidence.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ValidateTransition,
  getLedgerEvents,
  getLedgerPath,
  getRedactedValue,
  intLedger,
  intTaskStore,
  type DelegationRecord,
  type TaskRecord
} from '../../src/evidence.js'
import { ValidateTaskCard, type TaskCard } from '../../src/policy.js'

const card = ValidateTaskCard({ title: 't', goal: 'g', acceptance: ['a'] }).card as TaskCard

const makeTask = (taskId = 'T-1'): TaskRecord => ({
  taskId, sessionId: 's', card, gates: [], triage: { source: 'rules', rulesApplied: [] },
  delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1
})

const makeDelegation = (delegationId = 'D-1'): DelegationRecord => ({
  delegationId, taskId: 'T-1', role: 'fu_he', roleName: '复核', status: 'queued', summary: '', evidence: [],
  attempts: [], independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: 1
})

describe('状态机', () => {
  it('只允许合法迁移，终态不可再变', () => {
    expect(ValidateTransition('queued', 'running')).toBe(true)
    expect(ValidateTransition('queued', 'blocked')).toBe(true)
    expect(ValidateTransition('running', 'completed')).toBe(true)
    expect(ValidateTransition('completed', 'running')).toBe(false)
    expect(ValidateTransition('failed', 'completed')).toBe(false)
  })
})

describe('intTaskStore', () => {
  it('任务与委派的增改查，记录不可变更新', () => {
    const store = intTaskStore()
    store.AddTask(makeTask())
    const before = store.getTask('T-1')
    store.UpdateTask('T-1', { rounds: 1 })
    expect(before?.rounds).toBe(0)
    expect(store.getTask('T-1')?.rounds).toBe(1)
    store.AddDelegation(makeDelegation())
    expect(store.getTask('T-1')?.delegationIds).toEqual(['D-1'])
    const running = store.UpdateDelegation('D-1', { status: 'running' })
    expect(running.status).toBe('running')
    store.UpdateDelegation('D-1', { status: 'completed', summary: 'ok' })
    expect(store.getTaskDelegations('T-1').map((d) => d.summary)).toEqual(['ok'])
    expect(store.getTasks()).toHaveLength(1)
    expect(store.getDelegation('nope')).toBeUndefined()
  })

  it('非法迁移与未知对象抛错', () => {
    const store = intTaskStore()
    store.AddTask(makeTask())
    store.AddDelegation(makeDelegation())
    store.UpdateDelegation('D-1', { status: 'blocked' })
    expect(() => store.UpdateDelegation('D-1', { status: 'running' })).toThrow('不允许')
    expect(() => store.UpdateDelegation('D-x', { summary: '' })).toThrow('未知委派')
    expect(() => store.UpdateTask('T-x', { rounds: 1 })).toThrow('未知任务')
    expect(() => store.AddDelegation({ ...makeDelegation('D-2'), taskId: 'T-x' })).toThrow('未知任务')
  })
})

describe('账本', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('脱敏后追加 JSONL，可读回；坏行被跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-ledger-'))
    dirs.push(dir)
    const ledger = intLedger(join(dir, 'nested'), 'session:1/x')
    expect(ledger.path).toBe(getLedgerPath(join(dir, 'nested'), 'session:1/x'))
    expect(ledger.path.endsWith('session_1_x.jsonl')).toBe(true)
    ledger.AddLedgerEvent({ type: 'task/card', taskId: 'T-1', data: { note: 'Bearer abc.def', list: ['sk-abcdefghijk'] } })
    ledger.AddLedgerEvent({ type: 'delegation/queued', taskId: 'T-1', delegationId: 'D-1', data: {} })
    writeFileSync(ledger.path, `${readFileSync(ledger.path, 'utf8')}not-json\n`)
    const events = getLedgerEvents(ledger.path)
    expect(events.map((e) => e.type)).toEqual(['task/card', 'delegation/queued'])
    expect(JSON.stringify(events[0])).not.toContain('abc.def')
    expect(events[0]?.sessionId).toBe('session:1/x')
    expect(getLedgerEvents(join(dir, 'missing.jsonl'))).toEqual([])
  })

  it('写入失败时调用 onError 而不抛出', () => {
    const errors: unknown[] = []
    const base = mkdtempSync(join(tmpdir(), 'swarm-ledger-'))
    dirs.push(base)
    const file = join(base, 'file')
    writeFileSync(file, 'x')
    const ledger = intLedger(join(file, 'sub'), 's', (error) => errors.push(error))
    ledger.AddLedgerEvent({ type: 'jev/call', data: {} })
    expect(errors).toHaveLength(1)
  })

  it('getRedactedValue 深度处理并截断长字符串', () => {
    const value = getRedactedValue({ a: ['token=abc'], b: { c: 'x'.repeat(3000) }, n: 1 }) as { a: string[]; b: { c: string }; n: number }
    expect(value.a[0]).toContain('[已脱敏]')
    expect(value.b.c.length).toBeLessThanOrEqual(2000)
    expect(value.n).toBe(1)
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/evidence.test.ts`
Expected: FAIL，模块 `src/evidence.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/evidence.ts
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvidenceItem } from './contracts.js'
import type { FindingResolution, GateDelegationView, GateRequirement, TaskCard, TriageAnswers } from './policy.js'
import type { RouteInfo } from './routes.js'
import { SwarmError } from './util/errors.js'

export type DelegationStatus = GateDelegationView['status']
export type BackendKind = 'spawn' | 'codex' | 'codex-edit' | 'claude-plan' | 'claude-edit'

/** 一次路由尝试的记录 */
export interface RouteAttempt {
  route: string
  backend: BackendKind
  outcome: 'skipped' | 'failed' | 'used' | 'fallback'
  reason?: string
}

/** 一次委派的完整记录 */
export interface DelegationRecord extends GateDelegationView {
  taskId: string
  roleName: string
  gate?: string
  summary: string
  evidence: EvidenceItem[]
  route?: RouteInfo
  backend?: BackendKind
  attempts: RouteAttempt[]
  hardIsolation: boolean
  changedFiles?: string[]
  changeTracking?: 'git' | 'unavailable'
  unresolved: string[]
  childId?: string
  error?: string
  startedAt: number
  durationMs?: number
}

/** 衡鉴分流记录 */
export interface TriageRecord {
  source: 'rules' | 'rules+jev' | 'rules+jev-fallback'
  answers?: TriageAnswers
  fallbackReason?: string
  rulesApplied: string[]
}

/** 验收记录 */
export interface AcceptanceRecord {
  decision: 'accept' | 'reject' | 'incomplete'
  status: 'accepted' | 'blocked' | 'recorded'
  summary: string
  missing: string[]
  unresolved: string[]
  stopReason: string
  resolutions: FindingResolution[]
  at: number
}

/** 任务记录 */
export interface TaskRecord {
  taskId: string
  sessionId: string
  card: TaskCard
  gates: GateRequirement[]
  triage: TriageRecord
  delegationIds: string[]
  rounds: number
  acceptance?: AcceptanceRecord
  createdAt: number
  updatedAt: number
}

const TRANSITIONS: Readonly<Record<DelegationStatus, readonly DelegationStatus[]>> = {
  queued: ['running', 'blocked', 'failed'],
  running: ['completed', 'failed', 'blocked'],
  completed: [],
  failed: [],
  blocked: []
}

/**
 * 委派状态是否允许从 from 迁移到 to（终态不可再变）
 * @param {DelegationStatus} from - 当前状态
 * @param {DelegationStatus} to - 目标状态
 * @returns {boolean} 是否允许
 */
export const ValidateTransition = (from: DelegationStatus, to: DelegationStatus): boolean => TRANSITIONS[from].includes(to)

/** 单个根会话内的任务与委派存储 */
export interface TaskStore {
  AddTask: (task: TaskRecord) => void
  getTask: (taskId: string) => TaskRecord | undefined
  UpdateTask: (taskId: string, patch: Partial<TaskRecord>) => TaskRecord
  AddDelegation: (record: DelegationRecord) => void
  UpdateDelegation: (delegationId: string, patch: Partial<DelegationRecord>) => DelegationRecord
  getDelegation: (delegationId: string) => DelegationRecord | undefined
  getTaskDelegations: (taskId: string) => DelegationRecord[]
  getTasks: () => TaskRecord[]
}

/**
 * 创建内存存储；更新总是替换为新对象，旧引用保持不变
 * @returns {TaskStore} 存储
 */
export const intTaskStore = (): TaskStore => {
  const tasks = new Map<string, TaskRecord>()
  const delegations = new Map<string, DelegationRecord>()

  const UpdateTask = (taskId: string, patch: Partial<TaskRecord>): TaskRecord => {
    const current = tasks.get(taskId)
    if (current === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${taskId}`)
    const next = { ...current, ...patch, updatedAt: Date.now() }
    tasks.set(taskId, next)
    return next
  }

  const AddDelegation = (record: DelegationRecord): void => {
    const task = tasks.get(record.taskId)
    if (task === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${record.taskId}`)
    delegations.set(record.delegationId, record)
    UpdateTask(record.taskId, { delegationIds: [...task.delegationIds, record.delegationId] })
  }

  const UpdateDelegation = (delegationId: string, patch: Partial<DelegationRecord>): DelegationRecord => {
    const current = delegations.get(delegationId)
    if (current === undefined) throw new SwarmError('UNKNOWN_TASK', `未知委派：${delegationId}`)
    if (patch.status !== undefined && patch.status !== current.status && !ValidateTransition(current.status, patch.status)) {
      throw new SwarmError('INVALID_TRANSITION', `委派 ${delegationId} 不允许从 ${current.status} 变为 ${patch.status}`)
    }
    const next = { ...current, ...patch }
    delegations.set(delegationId, next)
    return next
  }

  return {
    AddTask: (task) => { tasks.set(task.taskId, task) },
    getTask: (taskId) => tasks.get(taskId),
    UpdateTask,
    AddDelegation,
    UpdateDelegation,
    getDelegation: (delegationId) => delegations.get(delegationId),
    getTaskDelegations: (taskId) =>
      (tasks.get(taskId)?.delegationIds ?? []).map((id) => delegations.get(id)).filter((d): d is DelegationRecord => d !== undefined),
    getTasks: () => [...tasks.values()]
  }
}

export type LedgerEventType =
  | 'task/card' | 'delegation/queued' | 'delegation/running' | 'delegation/completed' | 'delegation/failed'
  | 'delegation/blocked' | 'route/skipped' | 'route/fallback' | 'jev/call' | 'native/call' | 'accept/decision'

/** 账本事件（一行 JSON） */
export interface LedgerEvent {
  ts: string
  type: LedgerEventType
  sessionId: string
  taskId?: string
  delegationId?: string
  data: Record<string, unknown>
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi
]
const MAX_LEDGER_TEXT = 2000

/**
 * 深度脱敏：字符串去除密钥样式内容并截断
 * @param {unknown} value - 任意值
 * @returns {unknown} 脱敏后的新值
 */
export const getRedactedValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[已脱敏]'), value).slice(0, MAX_LEDGER_TEXT)
  }
  if (Array.isArray(value)) return value.map(getRedactedValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, getRedactedValue(item)]))
  }
  return value
}

/**
 * 账本文件路径：会话 id 中的非安全字符替换为下划线
 * @param {string} dir - 账本目录
 * @param {string} sessionId - 根会话 id
 * @returns {string} 文件路径
 */
export const getLedgerPath = (dir: string, sessionId: string): string =>
  join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)

/** 账本句柄 */
export interface Ledger {
  path: string
  AddLedgerEvent: (event: Omit<LedgerEvent, 'ts' | 'sessionId'>) => void
}

/**
 * 创建追加写入的 JSONL 账本；写入失败只回调 onError，不影响任务执行
 * @param {string} dir - 账本目录
 * @param {string} sessionId - 根会话 id
 * @param {(error: unknown) => void} [onError] - 写入失败回调
 * @returns {Ledger} 账本
 */
export const intLedger = (dir: string, sessionId: string, onError?: (error: unknown) => void): Ledger => {
  const path = getLedgerPath(dir, sessionId)
  return {
    path,
    AddLedgerEvent: (event) => {
      try {
        mkdirSync(dir, { recursive: true })
        const line: LedgerEvent = { ts: new Date().toISOString(), sessionId, ...event, data: getRedactedValue(event.data) as Record<string, unknown> }
        appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8')
      } catch (error) {
        onError?.(error)
      }
    }
  }
}

/**
 * 读回账本事件，跳过无法解析的行
 * @param {string} path - 账本文件
 * @returns {LedgerEvent[]} 事件列表
 */
export const getLedgerEvents = (path: string): LedgerEvent[] => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').filter((line) => line.trim() !== '').flatMap((line) => {
    try {
      return [JSON.parse(line) as LedgerEvent]
    } catch {
      return []
    }
  })
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/evidence.test.ts` 然后 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/evidence.ts tests/unit/evidence.test.ts
git commit -m "feat: add task store, delegation state machine and JSONL ledger"
```

---

### Task 7: Config（volatile 设置项）与合并默认值

**Files:**
- Create: `src/config.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Consumes: `readLiveObject`（Task 1）、`DEFAULT_ROUTE_CHAINS`、`DEFAULT_ESCALATION`、`RouteInfo`、`RouteKey`、`EscalationKind`（Task 3）、`DEFAULT_BUDGETS`、`DEFAULT_TRIAGE_THRESHOLDS`、`BudgetInfo`、`TriageThresholdsInfo`（Task 4）、`DEFAULT_JEV_CONFIG`、`JevConfigInfo`（Task 5）
- Produces: `Config`（schemastery schema，字段均 `.volatile()`）、`ROUTE_KEYS`、`NativeConfigInfo`、`DEFAULT_NATIVE_CONFIG`、`RoleRouteInfo { chain; escalation? }`、`SwarmConfigInfo { routes; rootFallback; nativeEscalation; native; jev; thresholds; budgets; ledgerDir }`、`getSwarmConfig(raw)`、`getRoleRoute(config, key)`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/config.test.ts
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_NATIVE_CONFIG, ROUTE_KEYS, getRoleRoute, getSwarmConfig } from '../../src/config.js'
import { DEFAULT_BUDGETS, DEFAULT_TRIAGE_THRESHOLDS } from '../../src/policy.js'
import { DEFAULT_JEV_CONFIG } from '../../src/jev.js'
import { DEFAULT_ROUTE_CHAINS } from '../../src/routes.js'

describe('Config schema', () => {
  it('空配置解析出 volatile 引用，合并后等于默认值', () => {
    const parsed = Config({})
    expect(typeof (parsed as unknown as { rootFallback: { get: () => unknown } }).rootFallback.get).toBe('function')
    const config = getSwarmConfig(parsed)
    expect(config.rootFallback).toBe(true)
    expect(config.nativeEscalation).toBe('manual')
    expect(config.native).toEqual(DEFAULT_NATIVE_CONFIG)
    expect(config.jev).toEqual(DEFAULT_JEV_CONFIG)
    expect(config.thresholds).toEqual(DEFAULT_TRIAGE_THRESHOLDS)
    expect(config.budgets).toEqual(DEFAULT_BUDGETS)
    expect(config.routes).toEqual({})
    expect(config.ledgerDir).toBe('')
  })

  it('覆盖值生效，嵌套字段按默认补齐', () => {
    const parsed = Config({
      rootFallback: false,
      nativeEscalation: 'auto',
      jev: { enabled: false, mathConfidence: 0.8 },
      budgets: { maxAutoFixRounds: 1 },
      routes: { fu_he: { chain: [{ provider: 'p', model: 'm' }] } }
    })
    const config = getSwarmConfig(parsed)
    expect(config.rootFallback).toBe(false)
    expect(config.nativeEscalation).toBe('auto')
    expect(config.jev.enabled).toBe(false)
    expect(config.jev.timeoutMs).toBe(10000)
    expect(config.thresholds.mathConfidence).toBe(0.8)
    expect(config.budgets.maxAutoFixRounds).toBe(1)
    expect(config.budgets.maxCallsPerRole).toBe(4)
    expect(config.routes.fu_he?.chain).toEqual([{ provider: 'p', model: 'm' }])
  })
})

describe('getSwarmConfig', () => {
  it('接受普通对象，丢弃非法路由覆盖', () => {
    const config = getSwarmConfig({
      routes: {
        nobody: { chain: [{ provider: 'p', model: 'm' }] },
        fu_he: { chain: [{ provider: 'p' }] },
        yu_shi: { chain: [{ provider: 'p', model: 'm', reasoningEffort: 'high' }], escalation: 'claude' },
        tan_wei: 'x'
      },
      nativeEscalation: 'weird',
      budgets: { maxCallsPerRole: 'many' }
    })
    expect(Object.keys(config.routes)).toEqual(['yu_shi'])
    expect(config.routes.yu_shi).toEqual({ chain: [{ provider: 'p', model: 'm', reasoningEffort: 'high' }], escalation: 'claude' })
    expect(config.nativeEscalation).toBe('manual')
    expect(config.budgets.maxCallsPerRole).toBe(4)
    expect(getSwarmConfig(undefined).rootFallback).toBe(true)
  })

  it('getRoleRoute：覆盖优先，空链回退到默认，并带默认升级通道', () => {
    const config = getSwarmConfig({ routes: { yu_shi: { chain: [{ provider: 'p', model: 'm' }] }, fu_he: { chain: [] } } })
    expect(getRoleRoute(config, 'yu_shi')).toEqual({ chain: [{ provider: 'p', model: 'm' }], escalation: 'codex' })
    expect(getRoleRoute(config, 'fu_he')).toEqual({ chain: [...DEFAULT_ROUTE_CHAINS.fu_he] })
    expect(ROUTE_KEYS).toContain('suan_heng:verify')
    expect(ROUTE_KEYS).not.toContain('suan_heng')
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL，模块 `src/config.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/config.ts
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_JEV_CONFIG, type JevConfigInfo } from './jev.js'
import { DEFAULT_BUDGETS, DEFAULT_TRIAGE_THRESHOLDS, type BudgetInfo, type TriageThresholdsInfo } from './policy.js'
import { DEFAULT_ESCALATION, DEFAULT_ROUTE_CHAINS, type EscalationKind, type RouteInfo, type RouteKey } from './routes.js'
import { readLiveObject } from './util/live.js'

const RouteSchema = Schema.object({
  provider: Schema.string().required().description('provider 路由名，例如 qwen-token-plan-cn'),
  model: Schema.string().required().description('模型 ID'),
  reasoningEffort: Schema.string().description('推理强度（可选）')
})

const RoleRouteSchema = Schema.object({
  chain: Schema.array(RouteSchema).default([]).description('路由链：首选 → 备用'),
  escalation: Schema.union(['codex', 'claude']).description('升级通道（可选）')
})

/** swarm-core 行的 Config；DSH 0.1.7 设置页从 volatile 字段生成表单并写回 profile 补丁 */
export const Config = Schema.object({
  routes: Schema.dict(RoleRouteSchema).default({})
    .description('按角色覆盖路由链；键为角色 ID（算衡用 suan_heng:research / suan_heng:verify）；留空使用内置默认').volatile(),
  rootFallback: Schema.boolean().default(true).description('主会话模型致命失败时按角色链回退').volatile(),
  nativeEscalation: Schema.union(['manual', 'auto']).default('manual')
    .description('原生 Codex/Claude 升级：manual 仅在显式要求时使用；auto 在高风险任务上自动使用').volatile(),
  native: Schema.object({
    codexProvider: Schema.string().default('swarm-codex'),
    codexEditProvider: Schema.string().default('swarm-codex-edit'),
    claudePlanProvider: Schema.string().default('swarm-claude-plan'),
    claudeEditProvider: Schema.string().default('swarm-claude-edit'),
    maxCallsPerSession: Schema.natural().default(3)
  }).default({}).description('原生后端实例名与每会话调用上限').volatile(),
  jev: Schema.object({
    enabled: Schema.boolean().default(true),
    apiKeyEnv: Schema.string().default('TYPESAFE_API_KEY'),
    baseUrl: Schema.string().default('https://api.typesafe.ai'),
    model: Schema.string().default('jev-latest'),
    timeoutMs: Schema.natural().default(10000),
    maxRetries: Schema.natural().default(2),
    maxCallsPerSession: Schema.natural().default(20),
    mathConfidence: Schema.number().default(0.6),
    benchmarkNoul: Schema.number().default(0.5),
    noveltyScore: Schema.number().default(1),
    noveltyConfidence: Schema.number().default(0.5)
  }).default({}).description('衡鉴 Jev 分流').volatile(),
  budgets: Schema.object({
    maxDelegationsPerTask: Schema.natural().default(20),
    maxCallsPerRole: Schema.natural().default(4),
    maxCallsZhuJian: Schema.natural().default(6),
    maxAutoFixRounds: Schema.natural().default(2),
    delegationTimeoutMs: Schema.natural().default(1800000)
  }).default({}).description('预算').volatile(),
  ledgerDir: Schema.string().default('').description('账本目录；留空为 <DSH_HOME>/share/dsh-agent-swarm/ledger').volatile()
})

/** 原生后端实例配置 */
export interface NativeConfigInfo {
  codexProvider: string
  codexEditProvider: string
  claudePlanProvider: string
  claudeEditProvider: string
  maxCallsPerSession: number
}

export const DEFAULT_NATIVE_CONFIG: NativeConfigInfo = {
  codexProvider: 'swarm-codex',
  codexEditProvider: 'swarm-codex-edit',
  claudePlanProvider: 'swarm-claude-plan',
  claudeEditProvider: 'swarm-claude-edit',
  maxCallsPerSession: 3
}

/** 某角色的路由 */
export interface RoleRouteInfo {
  chain: RouteInfo[]
  escalation?: EscalationKind
}

/** 合并默认值后的完整配置 */
export interface SwarmConfigInfo {
  routes: Partial<Record<RouteKey, RoleRouteInfo>>
  rootFallback: boolean
  nativeEscalation: 'manual' | 'auto'
  native: NativeConfigInfo
  jev: JevConfigInfo
  thresholds: TriageThresholdsInfo
  budgets: BudgetInfo
  ledgerDir: string
}

export const ROUTE_KEYS: readonly RouteKey[] = Object.keys(DEFAULT_ROUTE_CHAINS) as RouteKey[]

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** 按默认值的类型逐字段取值，类型不符时使用默认值 */
const getMerged = <T extends object>(defaults: T, raw: unknown): T => {
  const source = asRecord(raw)
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, typeof source[key] === typeof fallback ? source[key] : fallback])
  ) as T
}

const isRoute = (value: unknown): value is RouteInfo => {
  const record = asRecord(value)
  return typeof record.provider === 'string' && record.provider !== '' && typeof record.model === 'string' && record.model !== ''
    && (record.reasoningEffort === undefined || typeof record.reasoningEffort === 'string')
}

const getRouteOverrides = (raw: unknown): Partial<Record<RouteKey, RoleRouteInfo>> => {
  const entries = Object.entries(asRecord(raw)).flatMap(([key, value]): Array<[RouteKey, RoleRouteInfo]> => {
    if (!(ROUTE_KEYS as readonly string[]).includes(key)) return []
    const record = asRecord(value)
    if (!Array.isArray(record.chain) || !record.chain.every(isRoute)) return []
    const chain = record.chain.map((route: RouteInfo) => ({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort })
    }))
    const escalation = record.escalation === 'codex' || record.escalation === 'claude' ? record.escalation : undefined
    return [[key as RouteKey, escalation === undefined ? { chain } : { chain, escalation }]]
  })
  return Object.fromEntries(entries)
}

/**
 * 读取 Config 当前值并合并默认值；每次调用都重新读取，设置页修改即时生效
 * @param {unknown} raw - 插件收到的 Config（volatile 引用或普通对象）
 * @returns {SwarmConfigInfo} 完整配置
 */
export const getSwarmConfig = (raw: unknown): SwarmConfigInfo => {
  const plain = readLiveObject(raw)
  return {
    routes: getRouteOverrides(plain.routes),
    rootFallback: typeof plain.rootFallback === 'boolean' ? plain.rootFallback : true,
    nativeEscalation: plain.nativeEscalation === 'auto' ? 'auto' : 'manual',
    native: getMerged(DEFAULT_NATIVE_CONFIG, plain.native),
    jev: getMerged(DEFAULT_JEV_CONFIG, plain.jev),
    thresholds: getMerged(DEFAULT_TRIAGE_THRESHOLDS, plain.jev),
    budgets: getMerged(DEFAULT_BUDGETS, plain.budgets),
    ledgerDir: typeof plain.ledgerDir === 'string' ? plain.ledgerDir : ''
  }
}

/**
 * 取某路由键的有效路由：用户覆盖（非空链）优先，否则用内置默认；升级通道同理
 * @param {SwarmConfigInfo} config - 配置
 * @param {RouteKey} key - 路由键
 * @returns {RoleRouteInfo} 路由
 */
export const getRoleRoute = (config: SwarmConfigInfo, key: RouteKey): RoleRouteInfo => {
  const override = config.routes[key]
  const chain = override !== undefined && override.chain.length > 0 ? override.chain : [...DEFAULT_ROUTE_CHAINS[key]]
  const escalation = override?.escalation ?? DEFAULT_ESCALATION[key]
  return escalation === undefined ? { chain } : { chain, escalation }
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/config.test.ts` 然后 `npm run typecheck`
Expected: PASS。若 typecheck 报 schemastery 默认导入问题，改为 `import * as SchemaModule from '@deepseek-ai/schemastery'` 并 `const Schema = (SchemaModule as unknown as { default?: typeof SchemaModule }).default ?? SchemaModule`，保持运行时行为不变后重跑。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat: add volatile Config schema and defaults merging"
```

---

### Task 8: 视觉准入与 git 改动追踪

**Files:**
- Create: `src/vision.ts`, `src/util/git.ts`
- Test: `tests/unit/vision.test.ts`, `tests/unit/git.test.ts`

**Interfaces:**
- Consumes: `AttachmentsLike`、`ContentBlockLike`（Task 1）、`SwarmError`（Task 1）
- Produces:
  - `IMAGE_MEDIA_TYPES`、`ImagePathInfo { path; absolute; mediaType }`、`ValidateImagePaths(paths, workspaceRoot)` → `{ ok; resolved; errors }`、`getImageBlocks(images, { readFile; attachments? })` → `Promise<ContentBlockLike[]>`
  - `CommandRunner`、`runCommand`、`GitStatusInfo = Map<string, string>`、`ParseGitStatus(stdout)`、`getGitStatus(cwd, run?)`、`getChangedFiles(before, after)`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/vision.test.ts
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ValidateImagePaths, getImageBlocks } from '../../src/vision.js'

const root = resolve('/workspace/project')

describe('ValidateImagePaths', () => {
  it('接受工作区内的常见图片格式', () => {
    const result = ValidateImagePaths(['shots/a.png', 'b.JPG', join(root, 'c.webp')], root)
    expect(result.ok).toBe(true)
    expect(result.resolved.map((r) => r.mediaType)).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(result.resolved[0]?.absolute).toBe(join(root, 'shots', 'a.png'))
  })

  it('拒绝越界路径与不支持的格式', () => {
    const result = ValidateImagePaths(['../outside.png', 'doc.pdf', resolve('/elsewhere/x.png')], root)
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toContain('不在工作区内')
    expect(result.errors[1]).toContain('不支持的图片格式')
  })

  it('空列表视为不合法', () => {
    expect(ValidateImagePaths([], root)).toMatchObject({ ok: false, errors: ['image_paths 不能为空'] })
  })
})

describe('getImageBlocks', () => {
  it('读取文件并通过附件服务入库，返回图片块', async () => {
    const saveImages = vi.fn(async (inputs: unknown[]) => inputs.map((_, index) => ({ id: `ref-${index}` })))
    const blocks = await getImageBlocks(
      [{ path: 'a.png', absolute: '/w/a.png', mediaType: 'image/png' }],
      { readFile: async () => new Uint8Array([1, 2, 3]), attachments: { saveImages } }
    )
    expect(blocks).toEqual([{ type: 'image', attachment: { id: 'ref-0' } }])
    expect(saveImages).toHaveBeenCalledWith([{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'a.png' }])
  })

  it('附件服务不可用时抛错', async () => {
    await expect(getImageBlocks([{ path: 'a.png', absolute: '/w/a.png', mediaType: 'image/png' }], { readFile: async () => new Uint8Array() }))
      .rejects.toThrow('附件服务不可用')
  })
})
````

````ts file=tests/unit/git.test.ts
import { describe, expect, it } from 'vitest'
import { ParseGitStatus, getChangedFiles, getGitStatus, runCommand } from '../../src/util/git.js'

describe('ParseGitStatus', () => {
  it('解析 -z 输出，含重命名', () => {
    const map = ParseGitStatus(' M src/a.ts\0?? new.txt\0R  moved.ts\0old.ts\0')
    expect([...map.entries()]).toEqual([['src/a.ts', ' M'], ['new.txt', '??'], ['moved.ts', 'R ']])
    expect(ParseGitStatus('').size).toBe(0)
  })
})

describe('getChangedFiles', () => {
  it('返回状态新增或改变的路径（排序）', () => {
    const before = new Map([['a.ts', ' M'], ['b.ts', '??']])
    const after = new Map([['a.ts', ' M'], ['b.ts', 'A '], ['c.ts', '??']])
    expect(getChangedFiles(before, after)).toEqual(['b.ts', 'c.ts'])
  })
})

describe('getGitStatus', () => {
  it('非零退出码返回 undefined，成功时解析输出', async () => {
    expect(await getGitStatus('/x', async () => ({ code: 128, stdout: '' }))).toBeUndefined()
    const map = await getGitStatus('/x', async (_cmd, args) => {
      expect(args).toEqual(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      return { code: 0, stdout: '?? z.txt\0' }
    })
    expect(map?.get('z.txt')).toBe('??')
  })

  it('runCommand 对不存在的命令返回非零码', async () => {
    const result = await runCommand('definitely-not-a-command-xyz', [], process.cwd())
    expect(result.code).not.toBe(0)
    const ok = await runCommand(process.execPath, ['-e', 'process.stdout.write("hi")'], process.cwd())
    expect(ok).toEqual({ code: 0, stdout: 'hi' })
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/vision.test.ts tests/unit/git.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

````ts file=src/vision.ts
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import type { AttachmentsLike, ContentBlockLike } from './host-contract.js'
import { SwarmError } from './util/errors.js'

/** DSH 附件服务支持的源图片格式 */
export const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** 通过校验的图片路径 */
export interface ImagePathInfo {
  path: string
  absolute: string
  mediaType: string
}

/**
 * 校验图片路径：必须位于工作区内且格式受支持
 * @param {string[]} paths - 相对工作区或绝对路径
 * @param {string} workspaceRoot - 工作区根目录
 * @returns {{ ok: boolean; resolved: ImagePathInfo[]; errors: string[] }} 校验结果
 */
export const ValidateImagePaths = (paths: string[], workspaceRoot: string) => {
  if (paths.length === 0) return { ok: false, resolved: [] as ImagePathInfo[], errors: ['image_paths 不能为空'] }
  const errors: string[] = []
  const resolved: ImagePathInfo[] = []
  for (const path of paths) {
    const absolute = resolve(workspaceRoot, path)
    const rel = relative(workspaceRoot, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      errors.push(`${path} 不在工作区内`)
      continue
    }
    const mediaType = IMAGE_MEDIA_TYPES[extname(absolute).toLowerCase()]
    if (mediaType === undefined) {
      errors.push(`${path} 是不支持的图片格式（支持 png/jpg/jpeg/webp/gif）`)
      continue
    }
    resolved.push({ path, absolute, mediaType })
  }
  return { ok: errors.length === 0, resolved, errors }
}

/**
 * 读取图片并通过附件服务入库，得到可放入 prompt 的图片块
 * @param {ImagePathInfo[]} images - 已校验的图片
 * @param {{ readFile: (path: string) => Promise<Uint8Array>; attachments?: AttachmentsLike }} deps - 文件读取与附件服务
 * @returns {Promise<ContentBlockLike[]>} 图片块
 */
export const getImageBlocks = async (
  images: ImagePathInfo[],
  deps: { readFile: (path: string) => Promise<Uint8Array>; attachments?: AttachmentsLike }
): Promise<ContentBlockLike[]> => {
  const attachments = deps.attachments
  if (attachments === undefined) throw new SwarmError('SERVICE_UNAVAILABLE', '附件服务不可用，无法把图片交给观象')
  const inputs = await Promise.all(images.map(async (image) => ({
    data: await deps.readFile(image.absolute),
    mediaType: image.mediaType,
    name: basename(image.absolute)
  })))
  const refs = await attachments.saveImages(inputs)
  return refs.map((attachment) => ({ type: 'image', attachment }))
}
````

````ts file=src/util/git.ts
import { execFile } from 'node:child_process'

/** 命令执行器（便于测试替换） */
export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>

/**
 * 执行命令并收集标准输出；失败时返回非零码而不抛出
 * @param {string} command - 命令
 * @param {string[]} args - 参数
 * @param {string} cwd - 工作目录
 * @returns {Promise<{ code: number; stdout: string }>} 退出码与输出
 */
export const runCommand: CommandRunner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })

/** 路径 → git 状态码（XY） */
export type GitStatusInfo = Map<string, string>

/**
 * 解析 `git status --porcelain=v1 -z` 输出；重命名/复制条目后紧跟的原路径被跳过
 * @param {string} stdout - 命令输出
 * @returns {GitStatusInfo} 状态表
 */
export const ParseGitStatus = (stdout: string): GitStatusInfo => {
  const entries = stdout.split('\0').filter((entry) => entry !== '')
  const map: GitStatusInfo = new Map()
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as string
    const status = entry.slice(0, 2)
    map.set(entry.slice(3), status)
    if (status.includes('R') || status.includes('C')) index++
  }
  return map
}

/**
 * 读取工作区 git 状态；不是 git 仓库或 git 不可用时返回 undefined
 * @param {string} cwd - 工作区
 * @param {CommandRunner} [run] - 命令执行器
 * @returns {Promise<GitStatusInfo | undefined>} 状态表
 */
export const getGitStatus = async (cwd: string, run: CommandRunner = runCommand): Promise<GitStatusInfo | undefined> => {
  const result = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd)
  return result.code === 0 ? ParseGitStatus(result.stdout) : undefined
}

/**
 * 委派前后状态的差集：新出现或状态改变的路径。委派前已脏且内容再次变化的文件无法识别（已知限制）
 * @param {GitStatusInfo} before - 委派前
 * @param {GitStatusInfo} after - 委派后
 * @returns {string[]} 改动路径（排序）
 */
export const getChangedFiles = (before: GitStatusInfo, after: GitStatusInfo): string[] =>
  [...after.entries()].filter(([path, status]) => before.get(path) !== status).map(([path]) => path).sort()
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/vision.test.ts tests/unit/git.test.ts` 然后 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/vision.ts src/util/git.ts tests/unit/vision.test.ts tests/unit/git.test.ts
git commit -m "feat: add vision admission and git change tracking"
```

---

### Task 9: 运行中路由改写与回退

**Files:**
- Create: `src/route-state.ts`
- Test: `tests/unit/route-state.test.ts`

**Interfaces:**
- Consumes: `getAgentHeader`、`AgentLike`、`CallConfigLike`、`LlmFailureLike`、`RequestErrorPayloadLike`、`RequestErrorActionLike`（Task 1）、`RoleId`（Task 2）、`getFailureClass`、`isSwitchWorthy`、`getRouteKey`、`getRouteLabel`、`RouteInfo`（Task 3）、`getRoleRoute`、`SwarmConfigInfo`（Task 7）
- Produces: `FallbackEventInfo { agentId; from; to; failure; scope }`、`RouteStateRegistry { AddChild; getChild; getChildRole; DelAgent; getRequestOverride; getErrorAction }`、`intRouteStateRegistry(onRootFallback?)`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/route-state.test.ts
import { describe, expect, it } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intRouteStateRegistry, type FallbackEventInfo } from '../../src/route-state.js'
import { DEFAULT_ROUTE_CHAINS } from '../../src/routes.js'

const config = getSwarmConfig({})
const child = { id: 'c1', session: { header: { parentSession: 'root' } } }
const root = { id: 'root', session: { header: {} } }
const chain = [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2', reasoningEffort: 'high' }, { provider: 'a', model: 'm3' }]

describe('子智能体路由', () => {
  it('请求时套用当前路由并去掉继承的推理强度', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain, role: 'fu_he' })
    expect(registry.getRequestOverride(child, { provider: 'x', model: 'y', reasoningEffort: 'max', maxTokens: 10 }, undefined))
      .toEqual({ provider: 'a', model: 'm1', maxTokens: 10 })
    expect(registry.getChildRole('c1')).toBe('fu_he')
  })

  it('致命失败切到下一条并回调；链尽后交回宿主动作', () => {
    const events: FallbackEventInfo[] = []
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain, role: 'fu_he', onFallback: (event) => events.push(event) })
    registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)
    const action = registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'QUOTA' } }, undefined, undefined, config)
    expect(action).toEqual({ kind: 'retry' })
    expect(events[0]).toMatchObject({ scope: 'child', from: { model: 'm1' }, to: { model: 'm2' } })
    expect(registry.getRequestOverride(child, { provider: 'a', model: 'm1' }, undefined)).toEqual({ provider: 'b', model: 'm2', reasoningEffort: 'high' })
    expect(registry.getErrorAction({ agent: child, provider: 'b', failure: { code: 'QUOTA' } }, undefined, undefined, config)).toEqual({ kind: 'retry' })
    registry.getRequestOverride(child, { provider: 'b', model: 'm2' }, undefined)
    expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'QUOTA' } }, undefined, undefined, config)).toBeUndefined()
    expect(registry.getChild('c1')).toMatchObject({ route: { model: 'm3' }, role: 'fu_he', switches: 3 })
  })

  it('认证失败跳过同 provider 路由；瞬时失败且宿主仍在重试时不干预', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain: [chain[0], chain[2], chain[1]], role: 'fu_he' })
    registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)
    const hostRetry = { kind: 'retry' }
    expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'RATE_LIMIT', status: 429 } }, hostRetry, undefined, config)).toBe(hostRetry)
    expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { status: 401 } }, undefined, undefined, config)).toEqual({ kind: 'retry' })
    expect(registry.getChild('c1')?.route).toEqual({ provider: 'b', model: 'm2', reasoningEffort: 'high' })
  })

  it('DelAgent 清理状态', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain, role: 'fu_he' })
    registry.DelAgent('c1')
    expect(registry.getChild('c1')).toBeUndefined()
    expect(registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)).toEqual({ provider: 'x', model: 'y' })
  })
})

describe('根会话回退', () => {
  it('选择器路由致命失败时按角色链回退，跳过已失败路由', () => {
    const events: FallbackEventInfo[] = []
    const registry = intRouteStateRegistry((event) => events.push(event))
    const first = DEFAULT_ROUTE_CHAINS.tian_shu[0]
    registry.getRequestOverride(root, { provider: first.provider, model: first.model }, 'tian_shu')
    expect(registry.getErrorAction({ agent: root, provider: first.provider, failure: { code: 'QUOTA' } }, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(events[0]?.to).toEqual(DEFAULT_ROUTE_CHAINS.tian_shu[1])
    expect(registry.getRequestOverride(root, { provider: 'p', model: 'q' }, 'tian_shu')).toMatchObject({ model: DEFAULT_ROUTE_CHAINS.tian_shu[1].model })
  })

  it('关闭 rootFallback、非 swarm 预设、未跟踪的子会话都不干预', () => {
    const registry = intRouteStateRegistry()
    const off = getSwarmConfig({ rootFallback: false })
    const failure = { agent: root, provider: 'x', failure: { code: 'QUOTA' } }
    expect(registry.getErrorAction(failure, undefined, 'tian_shu', off)).toBeUndefined()
    expect(registry.getErrorAction(failure, undefined, undefined, config)).toBeUndefined()
    expect(registry.getErrorAction({ ...failure, agent: { id: 'fork', session: { header: { parentSession: 'root' } } } }, undefined, 'tian_shu', config)).toBeUndefined()
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/route-state.test.ts`
Expected: FAIL，模块 `src/route-state.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/route-state.ts
import { getRoleRoute, type SwarmConfigInfo } from './config.js'
import {
  getAgentHeader,
  type AgentLike,
  type CallConfigLike,
  type LlmFailureLike,
  type RequestErrorActionLike,
  type RequestErrorPayloadLike
} from './host-contract.js'
import type { RoleId } from './role-registry.js'
import { getFailureClass, getRouteKey, getRouteLabel, isSwitchWorthy, type FailureClass, type RouteInfo } from './routes.js'

/** 一次路由回退 */
export interface FallbackEventInfo {
  agentId: string
  from: RouteInfo
  to: RouteInfo
  failure: LlmFailureLike
  scope: 'child' | 'root'
}

interface ChildStateInfo {
  chain: RouteInfo[]
  index: number
  role: RoleId
  tried: ReadonlySet<string>
  onFallback?: (event: FallbackEventInfo) => void
}

interface RootStateInfo {
  override?: RouteInfo
  tried: ReadonlySet<string>
}

/** 路由状态注册表：spawn 子智能体按链回退，swarm 预设的根会话按角色链回退 */
export interface RouteStateRegistry {
  AddChild: (agentId: string, state: { chain: RouteInfo[]; role: RoleId; onFallback?: (event: FallbackEventInfo) => void }) => void
  getChild: (agentId: string) => { route: RouteInfo | undefined; role: RoleId; switches: number } | undefined
  getChildRole: (agentId: string) => RoleId | undefined
  DelAgent: (agentId: string) => void
  getRequestOverride: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined) => CallConfigLike
  getErrorAction: (
    payload: RequestErrorPayloadLike,
    action: RequestErrorActionLike,
    presetRole: RoleId | undefined,
    config: SwarmConfigInfo
  ) => RequestErrorActionLike
}

/** 换路由时丢弃继承的推理强度，避免把上一模型的强度套到新模型上 */
const getRoutedConfig = (resolved: CallConfigLike, route: RouteInfo): CallConfigLike => {
  const { reasoningEffort: _inherited, ...rest } = resolved
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort })
  }
}

/** 从 start 起找第一条未试过的路由；认证失败时跳过同一 provider */
const FindNextIndex = (chain: RouteInfo[], start: number, tried: ReadonlySet<string>, failed: RouteInfo, failureClass: FailureClass): number | undefined => {
  for (let index = start; index < chain.length; index++) {
    const route = chain[index] as RouteInfo
    if (tried.has(getRouteLabel(route))) continue
    if (failureClass === 'auth' && route.provider === failed.provider) continue
    return index
  }
  return undefined
}

/**
 * 创建路由状态注册表
 * @param {(event: FallbackEventInfo) => void} [onRootFallback] - 根会话回退时的回调（记日志）
 * @returns {RouteStateRegistry} 注册表
 */
export const intRouteStateRegistry = (onRootFallback?: (event: FallbackEventInfo) => void): RouteStateRegistry => {
  const children = new Map<string, ChildStateInfo>()
  const roots = new Map<string, RootStateInfo>()
  const lastRoutes = new Map<string, RouteInfo>()

  const getChildFallback = (agentId: string, state: ChildStateInfo, failure: LlmFailureLike, failureClass: FailureClass, action: RequestErrorActionLike): RequestErrorActionLike => {
    const current = state.chain[state.index] as RouteInfo
    const tried = new Set([...state.tried, getRouteLabel(current)])
    const next = FindNextIndex(state.chain, state.index + 1, tried, current, failureClass)
    if (next === undefined) {
      children.set(agentId, { ...state, tried })
      return action
    }
    const to = state.chain[next] as RouteInfo
    children.set(agentId, { ...state, index: next, tried })
    state.onFallback?.({ agentId, from: current, to, failure, scope: 'child' })
    return { kind: 'retry' }
  }

  const getRootFallback = (payload: RequestErrorPayloadLike, presetRole: RoleId, failureClass: FailureClass, action: RequestErrorActionLike, config: SwarmConfigInfo): RequestErrorActionLike => {
    const agentId = payload.agent.id
    const failed = lastRoutes.get(agentId) ?? { provider: payload.provider, model: '' }
    const previous = roots.get(agentId)
    const tried = new Set([...(previous?.tried ?? []), getRouteLabel(failed)])
    const chain = getRoleRoute(config, getRouteKey(presetRole)).chain
    const next = FindNextIndex(chain, 0, tried, failed, failureClass)
    if (next === undefined) {
      roots.set(agentId, { ...previous, tried })
      return action
    }
    const to = chain[next] as RouteInfo
    roots.set(agentId, { override: to, tried })
    onRootFallback?.({ agentId, from: failed, to, failure: payload.failure, scope: 'root' })
    return { kind: 'retry' }
  }

  return {
    AddChild: (agentId, state) => {
      children.set(agentId, { chain: state.chain, index: 0, role: state.role, tried: new Set(), ...(state.onFallback === undefined ? {} : { onFallback: state.onFallback }) })
    },
    getChild: (agentId) => {
      const state = children.get(agentId)
      return state === undefined ? undefined : { route: state.chain[state.index], role: state.role, switches: state.tried.size }
    },
    getChildRole: (agentId) => children.get(agentId)?.role,
    DelAgent: (agentId) => {
      children.delete(agentId)
      roots.delete(agentId)
      lastRoutes.delete(agentId)
    },
    getRequestOverride: (agent, resolved) => {
      const child = children.get(agent.id)
      const route = child === undefined ? roots.get(agent.id)?.override : child.chain[child.index]
      const next = route === undefined ? resolved : getRoutedConfig(resolved, route)
      lastRoutes.set(agent.id, { provider: next.provider, model: next.model })
      return next
    },
    getErrorAction: (payload, action, presetRole, config) => {
      const failureClass = getFailureClass(payload.failure)
      if (!isSwitchWorthy(failureClass, action === undefined)) return action
      const child = children.get(payload.agent.id)
      if (child !== undefined) return getChildFallback(payload.agent.id, child, payload.failure, failureClass, action)
      if (!config.rootFallback || presetRole === undefined) return action
      if (getAgentHeader(payload.agent).parentSession !== undefined) return action
      return getRootFallback(payload, presetRole, failureClass, action, config)
    }
  }
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/route-state.test.ts` 然后 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/route-state.ts tests/unit/route-state.test.ts
git commit -m "feat: add in-run route override and fallback registry"
```

---

### Task 10: 委派执行（spawn 与原生后端）

**Files:**
- Create: `src/delegate.ts`
- Test: `tests/unit/delegate.test.ts`

**Interfaces:**
- Consumes: Task 1–9 的全部导出；尤其 `ValidateStructuredOutput`、`getEvidenceFromOutput`、`getOutputSchema`（Task 2）、`FindUsableRoutes`、`getModelFamily`、`getRouteKey`、`getRouteLabel`（Task 3）、`ValidateDelegationBudget`、`GATE_IDS`（Task 4）、`TaskStore`、`Ledger`、`DelegationRecord`、`RouteAttempt`、`BackendKind`（Task 6）、`getRoleRoute`、`SwarmConfigInfo`（Task 7）、`ValidateImagePaths`、`getImageBlocks`、`getChangedFiles`、`GitStatusInfo`（Task 8）、`RouteStateRegistry`（Task 9）、`MutexInfo`（Task 1）
- Produces:
  - `DELEGATE_BACKENDS`、`DelegateInput`、`ValidateDelegateInput(raw)` → `{ input?; errors }`
  - `NATIVE_READ_ROLES`、`NATIVE_EDIT_ROLES`、`getNativeKind(role, choice)`、`getNativeProviderName(kind, config)`
  - `getToolFilter(role, visibleNames, allowWeb)`、`getTaskBrief(task, input, delegationId)`、`getChildPromptText(...)`、`getNativePromptText(...)`、`ParseNativeOutput(text)`、`getOutputText(result)`、`getAvoidFamilies(role, mode, delegations)`
  - `DelegateSessionInfo { sessionId; store; ledger; editLock; counters: { native: number } }`、`DelegateExecInfo { agent; signal }`、`DelegateDepsInfo`、`intDelegator(deps)` → `{ delegate(raw, exec, session): Promise<DelegationRecord> }`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/delegate.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig, type SwarmConfigInfo } from '../../src/config.js'
import {
  ParseNativeOutput,
  ValidateDelegateInput,
  getAvoidFamilies,
  getNativeKind,
  getOutputText,
  getToolFilter,
  intDelegator,
  type DelegateDepsInfo,
  type DelegateSessionInfo
} from '../../src/delegate.js'
import { getLedgerEvents, intLedger, intTaskStore, type DelegationRecord } from '../../src/evidence.js'
import type { SubagentResultLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { ValidateTaskCard, type TaskCard } from '../../src/policy.js'
import { intRouteStateRegistry } from '../../src/route-state.js'
import type { RouteProbe } from '../../src/routes.js'
import { intMutex } from '../../src/util/mutex.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const WORKSPACE = resolve('/workspace/project')
const VISIBLE = ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'pwsh', 'web_search', 'web_fetch', 'swarm_delegate', 'skill']
const agent = { id: 'root', session: { header: { cwd: WORKSPACE } } }

interface FakeRunPlan {
  result: SubagentResultLike
  onStarted?: (id: string) => void
  startError?: string
}

const makeHarness = (overrides: Partial<DelegateDepsInfo> & { config?: SwarmConfigInfo; plans?: FakeRunPlan[]; providers?: string[] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-delegate-'))
  const store = intTaskStore()
  const card = ValidateTaskCard({ title: '修复', goal: '修好', acceptance: ['测试通过'], scope: ['src/a.ts'], flags: { changesCode: true } }).card as TaskCard
  store.AddTask({ taskId: 'T-1', sessionId: 'root', card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1 })
  const session: DelegateSessionInfo = { sessionId: 'root', store, ledger: intLedger(dir, 'root'), editLock: intMutex(), counters: { native: 0 } }
  const requests: Array<{ name: string; request: SubagentStartRequestLike }> = []
  const plans = [...(overrides.plans ?? [])]
  const providers = new Set(['spawn', ...(overrides.providers ?? [])])
  let seq = 0
  const routeState = intRouteStateRegistry()
  const subagents = {
    list: () => [...providers],
    getProvider: (name: string) => (providers.has(name) ? { capabilities: {} } : undefined),
    start: vi.fn(async (name: string, request: SubagentStartRequestLike) => {
      requests.push({ name, request })
      const plan = plans.shift() ?? { result: { output: [], structured: VALID_OUTPUTS.fu_he, stopReason: 'completed' } }
      if (plan.startError !== undefined) throw new Error(plan.startError)
      const id = `child-${++seq}`
      // 模拟宿主：子智能体的首个请求发生在 start() resolve 之后
      setTimeout(() => plan.onStarted?.(id), 0)
      return { id, result: new Promise<SubagentResultLike>((r) => setTimeout(() => r(plan.result), 5)), dispose: vi.fn(async () => undefined) }
    })
  }
  const probe: RouteProbe = async () => ({ ok: true, vision: true })
  let clock = 1000
  const deps: DelegateDepsInfo = {
    getConfig: () => overrides.config ?? getSwarmConfig({}),
    getSubagents: () => subagents,
    getTools: () => ({ register: () => () => undefined, schemas: () => VISIBLE.map((name) => ({ name })), guard: () => () => undefined }),
    getAttachments: () => ({ saveImages: async (inputs) => inputs.map((_, i) => ({ ref: i })) }),
    probe,
    routeState,
    readFile: async () => new Uint8Array([1]),
    gitStatus: async () => undefined,
    now: () => (clock += 10),
    newId: (prefix) => `${prefix}-${++seq}`,
    ...overrides
  }
  return { dir, session, deps, requests, subagents, routeState, delegator: intDelegator(deps) }
}

const exec = () => ({ agent, signal: new AbortController().signal })
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const track = <T extends { dir: string }>(h: T): T => { dirs.push(h.dir); return h }

describe('ValidateDelegateInput', () => {
  it('接受合法输入', () => {
    expect(ValidateDelegateInput({ task_id: 'T-1', role: 'fu_he', prompt: '跑测试' }).input?.role).toBe('fu_he')
    expect(ValidateDelegateInput({ task_id: 'T-1', role: 'suan_heng', mode: 'verify', prompt: 'x', allow_web: true }).errors).toEqual([])
  })

  it('拒绝非法组合', () => {
    const errors = (raw: unknown) => ValidateDelegateInput(raw).errors.join('|')
    expect(errors('x')).toContain('参数必须是对象')
    expect(errors({ task_id: 'T-1', role: 'tian_shu', prompt: 'x' })).toContain('role 必须是可委派角色')
    expect(errors({ task_id: '', role: 'fu_he', prompt: '' })).toContain('task_id')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', mode: 'verify' })).toContain('mode 只适用于 suan_heng')
    expect(errors({ task_id: 'T', role: 'suan_heng', prompt: 'x', mode: 'guess' })).toContain('mode 必须是 research 或 verify')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', image_paths: ['a.png'] })).toContain('image_paths 只适用于 guan_xiang')
    expect(errors({ task_id: 'T', role: 'yu_shi', prompt: 'x', allow_web: true })).toContain('不开放 web')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', gate: 'G_X' })).toContain('gate')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', backend: 'gpt' })).toContain('backend')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', context_paths: [1] })).toContain('context_paths')
  })
})

describe('纯函数', () => {
  it('工具白名单与可见工具求交集；无交集时改用 deny', () => {
    expect(getToolFilter('fu_he', VISIBLE, false)).toEqual({ allow: ['read', 'read_image', 'glob', 'grep', 'pwsh'] })
    expect(getToolFilter('bo_wen', VISIBLE, false)?.allow).toContain('web_search')
    expect(getToolFilter('shu_ji', VISIBLE, false)?.allow).not.toContain('web_search')
    expect(getToolFilter('shu_ji', VISIBLE, true)?.allow).toContain('web_fetch')
    expect(getToolFilter('fu_he', ['swarm_delegate', 'structured_output'], false)).toEqual({ deny: ['swarm_delegate'] })
    expect(getToolFilter('fu_he', [], false)).toBeUndefined()
  })

  it('原生后端种类', () => {
    expect(getNativeKind('zhu_jian', 'claude')).toBe('claude-edit')
    expect(getNativeKind('zhu_jian', 'codex')).toBe('codex-edit')
    expect(getNativeKind('yu_shi', 'codex')).toBe('codex')
    expect(getNativeKind('shu_ji', 'claude')).toBe('claude-plan')
    expect(getNativeKind('fu_he', 'codex')).toBeUndefined()
  })

  it('解析原生输出：取最后一个 json 代码块，退化为花括号片段', () => {
    expect(ParseNativeOutput('a\n```json\n{"x":1}\n```\n```json\n{"x":2}\n```')).toEqual({ x: 2 })
    expect(ParseNativeOutput('结果 {"y":3} 完')).toEqual({ y: 3 })
    expect(ParseNativeOutput('没有 JSON')).toBeUndefined()
    expect(getOutputText({ output: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }], stopReason: 'completed' })).toBe('a\nb')
  })

  it('独立性：御史避开实现者家族，验算避开研算家族', () => {
    const done = (role: DelegationRecord['role'], model: string, mode?: 'research'): DelegationRecord => ({
      delegationId: role, taskId: 'T-1', role, roleName: role, status: 'completed', summary: '', evidence: [], attempts: [],
      independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: 1, route: { provider: 'p', model }, ...(mode ? { mode } : {})
    })
    expect(getAvoidFamilies('yu_shi', undefined, [done('zhu_jian', 'kimi-k2.7-code'), done('tan_wei', 'mimo-v2.5-pro')])).toEqual(['kimi'])
    expect(getAvoidFamilies('suan_heng', 'verify', [done('suan_heng', 'deepseek-v4-pro', 'research')])).toEqual(['deepseek'])
    expect(getAvoidFamilies('fu_he', undefined, [done('zhu_jian', 'kimi-k2.7-code')])).toEqual([])
  })
})

describe('intDelegator.delegate', () => {
  let harness: ReturnType<typeof makeHarness>
  beforeEach(() => { harness = track(makeHarness()) })

  it('复核：spawn 请求带路由、白名单、schema、persona 与深度上限，结果完成并写账本', async () => {
    const record = await harness.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: '运行 npm test', context_paths: ['src/a.ts'], gate: 'G_VERIFY' }, exec(), harness.session)
    expect(record.status).toBe('completed')
    expect(record.summary).toBe('测试通过')
    expect(record.evidence[0]).toMatchObject({ kind: 'command', exitCode: 0 })
    expect(record.route).toEqual({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' })
    expect(record.attempts).toContainEqual({ route: 'qwen-token-plan-cn/qwen3.8-flash', backend: 'spawn', outcome: 'used' })
    const { name, request } = harness.requests[0] as { name: string; request: SubagentStartRequestLike }
    expect(name).toBe('spawn')
    expect(request.agentOptions).toEqual({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' })
    expect(request.maxDepth).toBe(1)
    expect(request.toolFilter?.allow).not.toContain('write')
    expect(request.persona).toContain('[[swarm:role=fu_he]]')
    expect(request.outputSchema).toMatchObject({ type: 'object' })
    const text = String(request.prompt[0]?.text)
    expect(text).toContain('T-1')
    expect(text).toContain('src/a.ts')
    expect(text).toContain('G_VERIFY')
    expect(text).toContain('运行 npm test')
    const types = getLedgerEvents(harness.session.ledger.path).map((e) => e.type)
    expect(types).toEqual(['delegation/queued', 'delegation/running', 'delegation/completed'])
    expect(harness.routeState.getChild('child-1')).toBeUndefined()
  })

  it('未知任务抛错；参数非法抛错', async () => {
    await expect(harness.delegator.delegate({ task_id: 'T-9', role: 'fu_he', prompt: 'x' }, exec(), harness.session)).rejects.toThrow('未知任务')
    await expect(harness.delegator.delegate({ task_id: 'T-1', role: 'nobody', prompt: 'x' }, exec(), harness.session)).rejects.toThrow('role')
  })

  it('超出预算时 blocked', async () => {
    const h = track(makeHarness({ config: getSwarmConfig({ budgets: { maxCallsPerRole: 1 } }) }))
    await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), h.session)
    const second = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), h.session)
    expect(second.status).toBe('blocked')
    expect(second.error).toContain('上限')
  })

  it('没有可用路由时 blocked；观象链无视觉模型时给出 vision-unsupported', async () => {
    const none = track(makeHarness({ probe: async () => ({ ok: false, reason: 'provider-not-configured' }) }))
    const blocked = await none.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), none.session)
    expect(blocked.status).toBe('blocked')
    expect(blocked.error).toContain('no-usable-route')
    expect(blocked.attempts.every((a) => a.outcome === 'skipped')).toBe(true)
    const text = track(makeHarness({ probe: async () => ({ ok: true, vision: false }) }))
    const vision = await text.delegator.delegate({ task_id: 'T-1', role: 'guan_xiang', prompt: '看图' }, exec(), text.session)
    expect(vision.status).toBe('blocked')
    expect(vision.error).toContain('vision-unsupported')
  })

  it('子智能体失败、未提交结构化结果、结果不符合契约', async () => {
    const h = track(makeHarness({ plans: [
      { result: { output: [{ type: 'text', text: '部分' }], stopReason: 'error', diagnostic: 'QUOTA' } },
      { result: { output: [], stopReason: 'completed' } },
      { result: { output: [], structured: { summary: 's' }, stopReason: 'completed' } }
    ] }))
    const failed = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(failed).toMatchObject({ status: 'failed', error: 'error：QUOTA', summary: '部分' })
    const missing = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(missing.error).toContain('没有提交结构化结果')
    const invalid = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(invalid.error).toContain('不符合契约')
  })

  it('首条路由启动失败时尝试下一条', async () => {
    const h = track(makeHarness({ plans: [{ startError: 'route rejected', result: { output: [], stopReason: 'error' } }, { result: { output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' } }] }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(record.status).toBe('completed')
    expect(record.attempts[0]).toMatchObject({ outcome: 'failed', reason: 'start: route rejected' })
    expect(record.route?.model).toBe('kimi-k2.7-code')
  })

  it('运行中回退：记录 fallback 并以最终路由为准', async () => {
    const config = getSwarmConfig({})
    let registry = intRouteStateRegistry()
    const h = track(makeHarness({ plans: [{
      result: { output: [], structured: VALID_OUTPUTS.fu_he, stopReason: 'completed' },
      onStarted: (id) => {
        registry.getRequestOverride({ id }, { provider: 'x', model: 'y' }, undefined)
        registry.getErrorAction({ agent: { id }, provider: 'qwen-token-plan-cn', failure: { code: 'QUOTA' } }, undefined, undefined, config)
      }
    }] }))
    registry = h.routeState
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), h.session)
    expect(record.route).toEqual({ provider: 'opencode-go', model: 'qwen3.8-flash' })
    expect(record.attempts.some((a) => a.outcome === 'fallback' && a.reason?.includes('QUOTA'))).toBe(true)
    expect(getLedgerEvents(h.session.ledger.path).some((e) => e.type === 'route/fallback')).toBe(true)
  })

  it('原生后端：实例缺失时退回 spawn；存在时解析文本结果并标注无硬隔离', async () => {
    const missing = await harness.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', backend: 'codex' }, exec(), harness.session)
    expect(missing.attempts[0]).toMatchObject({ backend: 'codex', outcome: 'skipped', reason: 'native-unavailable' })
    expect(missing.backend).toBe('spawn')
    const text = '分析完毕\n```json\n' + JSON.stringify(VALID_OUTPUTS.tan_wei) + '\n```'
    const h = track(makeHarness({ providers: ['swarm-codex'], plans: [{ result: { output: [{ type: 'text', text }], stopReason: 'completed' } }] }))
    const native = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', backend: 'codex' }, exec(), h.session)
    expect(native).toMatchObject({ status: 'completed', backend: 'codex', hardIsolation: false, route: { provider: 'swarm-codex', model: 'codex-native' } })
    const request = h.requests[0]?.request as SubagentStartRequestLike
    expect(h.requests[0]?.name).toBe('swarm-codex')
    expect(request.persona).toBeUndefined()
    expect(String(request.prompt[0]?.text)).toContain('JSON Schema')
    expect(h.session.counters.native).toBe(1)
  })

  it('原生后端：不支持的角色与超出调用上限时退回 spawn', async () => {
    const h = track(makeHarness({ providers: ['swarm-codex'], config: getSwarmConfig({ native: { maxCallsPerSession: 0 } }) }))
    const budget = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', backend: 'codex' }, exec(), h.session)
    expect(budget.attempts[0]).toMatchObject({ outcome: 'skipped', reason: 'native-budget' })
    const unsupported = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x', backend: 'codex' }, exec(), h.session)
    expect(unsupported.attempts[0]?.reason).toContain('不支持原生后端')
  })

  it('自动升级：nativeEscalation=auto 且高风险任务时优先原生后端', async () => {
    const text = '```json\n' + JSON.stringify(VALID_OUTPUTS.yu_shi) + '\n```'
    const h = track(makeHarness({ providers: ['swarm-codex'], config: getSwarmConfig({ nativeEscalation: 'auto' }), plans: [{ result: { output: [{ type: 'text', text }], stopReason: 'completed' } }] }))
    h.session.store.UpdateTask('T-1', { gates: [{ gate: 'G_REVIEW', role: 'yu_shi', reason: 'r', source: 'rule' }] })
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'yu_shi', prompt: 'x' }, exec(), h.session)
    expect(record.backend).toBe('codex')
  })

  it('git 改动追踪：编辑角色记录改动，只读角色出现改动时告警', async () => {
    const snapshots = [new Map(), new Map([['hello.txt', '??']]), new Map(), new Map([['x.ts', ' M']])]
    const h = track(makeHarness({
      gitStatus: async () => snapshots.shift(),
      plans: [
        { result: { output: [], structured: VALID_OUTPUTS.ji_feng, stopReason: 'completed' } },
        { result: { output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' } }
      ]
    }))
    const edit = await h.delegator.delegate({ task_id: 'T-1', role: 'ji_feng', prompt: 'x' }, exec(), h.session)
    expect(edit.changedFiles).toEqual(['hello.txt'])
    expect(edit.changeTracking).toBe('git')
    expect(edit.evidence).toContainEqual({ kind: 'file-change', ref: 'hello.txt' })
    const read = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(read.unresolved.join('')).toContain('x.ts')
    expect(harness.session.store.getTask('T-1')).toBeDefined()
    const noGit = await harness.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), harness.session)
    expect(noGit.changeTracking).toBe('unavailable')
  })

  it('观象：图片入库后随 prompt 发送；越界路径 blocked', async () => {
    const h = track(makeHarness({ plans: [{ result: { output: [], structured: VALID_OUTPUTS.guan_xiang, stopReason: 'completed' } }] }))
    const ok = await h.delegator.delegate({ task_id: 'T-1', role: 'guan_xiang', prompt: '看图', image_paths: ['shot.png'] }, exec(), h.session)
    expect(ok.status).toBe('completed')
    expect(h.requests[0]?.request.prompt[1]).toEqual({ type: 'image', attachment: { ref: 0 } })
    const outside = await h.delegator.delegate({ task_id: 'T-1', role: 'guan_xiang', prompt: '看图', image_paths: ['../x.png'] }, exec(), h.session)
    expect(outside.status).toBe('blocked')
    expect(outside.error).toContain('不在工作区内')
    const noAttach = track(makeHarness({ getAttachments: () => undefined }))
    const failed = await noAttach.delegator.delegate({ task_id: 'T-1', role: 'guan_xiang', prompt: '看图', image_paths: ['shot.png'] }, exec(), noAttach.session)
    expect(failed.error).toContain('附件服务不可用')
  })

  it('服务缺失时 blocked', async () => {
    const noSub = track(makeHarness({ getSubagents: () => undefined }))
    expect((await noSub.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), noSub.session)).error).toContain('子智能体服务不可用')
    const noTools = track(makeHarness({ getTools: () => undefined }))
    expect((await noTools.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), noTools.session)).error).toContain('工具服务不可用')
  })

  it('编辑类委派串行执行', async () => {
    const order: string[] = []
    const h = track(makeHarness())
    const slowStart = h.subagents.start.getMockImplementation()
    h.subagents.start.mockImplementation(async (name, request) => {
      order.push(`start:${request.label}`)
      const run = await (slowStart as NonNullable<typeof slowStart>)(name, request)
      return { ...run, result: run.result.then((r) => { order.push(`end:${request.label}`); return r }) }
    })
    await Promise.all([
      h.delegator.delegate({ task_id: 'T-1', role: 'ji_feng', prompt: 'a' }, exec(), h.session),
      h.delegator.delegate({ task_id: 'T-1', role: 'ji_feng', prompt: 'b' }, exec(), h.session)
    ])
    expect(order).toEqual(['start:疾风·T-1', 'end:疾风·T-1', 'start:疾风·T-1', 'end:疾风·T-1'])
  })

  it('超时中止子智能体', async () => {
    const h = track(makeHarness({ config: getSwarmConfig({ budgets: { delegationTimeoutMs: 1 } }) }))
    h.subagents.start.mockImplementation(async (_name, request) => ({
      id: 'slow',
      result: new Promise<SubagentResultLike>((r) => request.signal.addEventListener('abort', () => r({ output: [], stopReason: 'aborted' }))),
      dispose: async () => undefined
    }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(record).toMatchObject({ status: 'failed', error: 'aborted' })
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/delegate.test.ts`
Expected: FAIL，模块 `src/delegate.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/delegate.ts
import { getRoleRoute, type SwarmConfigInfo } from './config.js'
import { ValidateStructuredOutput, getEvidenceFromOutput, getOutputSchema, type EvidenceItem } from './contracts.js'
import type { BackendKind, DelegationRecord, Ledger, RouteAttempt, TaskRecord, TaskStore } from './evidence.js'
import {
  SPAWN_PROVIDER,
  STRUCTURED_OUTPUT_TOOL,
  getAgentHeader,
  type AgentLike,
  type AttachmentsLike,
  type ContentBlockLike,
  type SubagentResultLike,
  type SubagentRunLike,
  type SubagentsLike,
  type ToolsLike
} from './host-contract.js'
import { GATE_IDS, GATE_ROLE, ValidateDelegationBudget, type GateId } from './policy.js'
import type { FallbackEventInfo, RouteStateRegistry } from './route-state.js'
import {
  getChildPersona,
  getRoleInfo,
  getWantedTools,
  isDelegableRoleId,
  isEditRole,
  type DelegableRoleId,
  type SuanHengMode
} from './role-registry.js'
import { FindUsableRoutes, getModelFamily, getRouteKey, getRouteLabel, type EscalationKind, type ModelFamily, type RouteInfo, type RouteProbe } from './routes.js'
import { SwarmError, getErrorText } from './util/errors.js'
import { getChangedFiles, type GitStatusInfo } from './util/git.js'
import type { MutexInfo } from './util/mutex.js'
import { ValidateImagePaths, getImageBlocks } from './vision.js'

export const DELEGATE_BACKENDS = ['auto', 'api', 'codex', 'claude'] as const
export type DelegateBackend = typeof DELEGATE_BACKENDS[number]

/** swarm_delegate 的参数 */
export interface DelegateInput {
  task_id: string
  role: DelegableRoleId
  mode?: SuanHengMode
  prompt: string
  context_paths?: string[]
  image_paths?: string[]
  backend?: DelegateBackend
  allow_web?: boolean
  gate?: GateId
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

/**
 * 校验委派参数（包括角色与参数的组合约束）
 * @param {unknown} raw - 工具参数
 * @returns {{ input?: DelegateInput; errors: string[] }} 规范化参数或错误
 */
export const ValidateDelegateInput = (raw: unknown): { input?: DelegateInput; errors: string[] } => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['参数必须是对象'] }
  const value = raw as Record<string, unknown>
  const errors: string[] = []
  if (typeof value.task_id !== 'string' || value.task_id.trim() === '') errors.push('task_id 必须是非空字符串')
  if (typeof value.prompt !== 'string' || value.prompt.trim() === '') errors.push('prompt 必须是非空字符串')
  const role = value.role
  if (!isDelegableRoleId(role)) {
    errors.push('role 必须是可委派角色 ID（天枢不能被委派）')
    return { errors }
  }
  if (value.mode !== undefined && role !== 'suan_heng') errors.push('mode 只适用于 suan_heng')
  if (value.mode !== undefined && value.mode !== 'research' && value.mode !== 'verify') errors.push('mode 必须是 research 或 verify')
  if (value.image_paths !== undefined && role !== 'guan_xiang') errors.push('image_paths 只适用于 guan_xiang')
  if (value.image_paths !== undefined && !isStringList(value.image_paths)) errors.push('image_paths 必须是字符串数组')
  if (value.context_paths !== undefined && !isStringList(value.context_paths)) errors.push('context_paths 必须是字符串数组')
  if (value.allow_web !== undefined && typeof value.allow_web !== 'boolean') errors.push('allow_web 必须是布尔值')
  if (value.allow_web === true && getRoleInfo(role).web === 'never') errors.push(`「${getRoleInfo(role).name}」不开放 web 工具`)
  if (value.gate !== undefined && !(GATE_IDS as readonly unknown[]).includes(value.gate)) errors.push(`gate 必须是 ${GATE_IDS.join(' / ')} 之一`)
  if (value.backend !== undefined && !(DELEGATE_BACKENDS as readonly unknown[]).includes(value.backend)) errors.push(`backend 必须是 ${DELEGATE_BACKENDS.join(' / ')} 之一`)
  if (errors.length > 0) return { errors }
  return { input: value as unknown as DelegateInput, errors: [] }
}

/** 允许使用原生后端的只读类角色 */
export const NATIVE_READ_ROLES: readonly DelegableRoleId[] = ['mou_ding', 'shu_ji', 'suan_heng', 'tan_wei', 'bo_wen', 'yu_shi', 'miao_bi']
/** 允许使用原生后端的编辑类角色 */
export const NATIVE_EDIT_ROLES: readonly DelegableRoleId[] = ['zhu_jian', 'ji_feng']

/**
 * 按角色与选择确定原生后端实例种类；执行/验证/视觉角色不走原生后端
 * @param {DelegableRoleId} role - 角色
 * @param {EscalationKind} choice - codex 或 claude
 * @returns {BackendKind | undefined} 实例种类
 */
export const getNativeKind = (role: DelegableRoleId, choice: EscalationKind): BackendKind | undefined => {
  if (NATIVE_EDIT_ROLES.includes(role)) return choice === 'codex' ? 'codex-edit' : 'claude-edit'
  if (NATIVE_READ_ROLES.includes(role)) return choice === 'codex' ? 'codex' : 'claude-plan'
  return undefined
}

export const getNativeProviderName = (kind: BackendKind, config: SwarmConfigInfo): string => {
  const names: Record<BackendKind, string> = {
    spawn: SPAWN_PROVIDER,
    codex: config.native.codexProvider,
    'codex-edit': config.native.codexEditProvider,
    'claude-plan': config.native.claudePlanProvider,
    'claude-edit': config.native.claudeEditProvider
  }
  return names[kind]
}

/**
 * 子智能体工具过滤：角色需要的工具 ∩ 父会话实际可见的工具；无交集时隐藏全部可见工具
 * @param {DelegableRoleId} role - 角色
 * @param {string[]} visibleNames - 父会话可见工具名
 * @param {boolean} allowWeb - 本次是否开放 web
 * @returns {{ allow?: string[]; deny?: string[] } | undefined} toolFilter
 */
export const getToolFilter = (role: DelegableRoleId, visibleNames: string[], allowWeb: boolean): { allow?: string[]; deny?: string[] } | undefined => {
  const visible = new Set(visibleNames)
  const allow = getWantedTools(role, { allowWeb }).filter((name) => visible.has(name))
  if (allow.length > 0) return { allow }
  const deny = visibleNames.filter((name) => name !== STRUCTURED_OUTPUT_TOOL)
  return deny.length > 0 ? { deny } : undefined
}

/**
 * 生成交给子智能体的任务背景（子智能体看不到天枢对话）
 * @param {TaskRecord} task - 任务
 * @param {DelegateInput} input - 委派参数
 * @param {string} delegationId - 委派 ID
 * @returns {string} 背景文本
 */
export const getTaskBrief = (task: TaskRecord, input: DelegateInput, delegationId: string): string => {
  const card = task.card
  const constraints = Object.entries(card.constraints ?? {}).map(([key, value]) => `${key}=${String(value)}`)
  const perf = Object.entries(card.perf ?? {}).map(([key, value]) => `${key}=${String(value)}`)
  return [
    `任务 ${task.taskId} / 委派 ${delegationId}`,
    `任务标题：${card.title}`,
    `目标：${card.goal}`,
    `验收标准：\n${card.acceptance.map((item) => `- ${item}`).join('\n')}`,
    `范围：${card.scope.length > 0 ? card.scope.join('、') : '未指定'}`,
    ...(constraints.length > 0 ? [`约束：${constraints.join('；')}`] : []),
    ...(perf.length > 0 ? [`性能预算：${perf.join('；')}`] : []),
    ...(input.gate === undefined ? [] : [`本次委派用于满足门禁：${input.gate}（${GATE_ROLE[input.gate].label}）`]),
    ...((input.context_paths ?? []).length > 0 ? [`相关文件：\n${(input.context_paths ?? []).map((path) => `- ${path}`).join('\n')}`] : [])
  ].join('\n')
}

export const getChildPromptText = (task: TaskRecord, input: DelegateInput, delegationId: string): string =>
  [
    getTaskBrief(task, input, delegationId),
    '—— 本次任务 ——',
    input.prompt,
    '—— 交付 ——',
    `完成后调用 ${STRUCTURED_OUTPUT_TOOL} 提交结果（${getRoleInfo(input.role).deliverables.join('、')}）。`
  ].join('\n\n')

export const getNativePromptText = (task: TaskRecord, input: DelegateInput, delegationId: string, mode?: SuanHengMode): string =>
  [
    getChildPersona(input.role, mode),
    getTaskBrief(task, input, delegationId),
    '—— 本次任务 ——',
    input.prompt,
    '—— 交付 ——',
    '最后以一个 ```json 代码块输出结果，字段必须符合以下 JSON Schema（不要输出其他 json 代码块）：',
    JSON.stringify(getOutputSchema(input.role))
  ].join('\n\n')

/**
 * 从原生后端的文本回答中取结构化结果：最后一个 json 代码块，退化为首尾花括号片段
 * @param {string} text - 回答文本
 * @returns {unknown} 解析结果，失败为 undefined
 */
export const ParseNativeOutput = (text: string): unknown => {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  const candidate = blocks.at(-1)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}

export const getOutputText = (result: SubagentResultLike): string =>
  result.output.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text as string).join('\n')

/**
 * 独立性要求避开的模型家族：御史避开实现者，验算避开研算
 * @param {DelegableRoleId} role - 本次角色
 * @param {SuanHengMode | undefined} mode - 算衡模式
 * @param {DelegationRecord[]} delegations - 本任务已有委派
 * @returns {ModelFamily[]} 需要避开的家族
 */
export const getAvoidFamilies = (role: DelegableRoleId, mode: SuanHengMode | undefined, delegations: DelegationRecord[]): ModelFamily[] => {
  const familiesOf = (match: (d: DelegationRecord) => boolean): ModelFamily[] =>
    [...new Set(delegations.filter((d) => d.status === 'completed' && d.route !== undefined && match(d)).map((d) => getModelFamily((d.route as RouteInfo).model)))]
  if (role === 'yu_shi') return familiesOf((d) => NATIVE_EDIT_ROLES.includes(d.role))
  if (role === 'suan_heng' && mode === 'verify') return familiesOf((d) => d.role === 'suan_heng' && d.mode === 'research')
  return []
}

/** 单个根会话的委派上下文 */
export interface DelegateSessionInfo {
  sessionId: string
  store: TaskStore
  ledger: Ledger
  editLock: MutexInfo
  counters: { native: number }
}

export interface DelegateExecInfo {
  agent: AgentLike
  signal: AbortSignal
}

/** 委派执行依赖（全部可替换，便于测试） */
export interface DelegateDepsInfo {
  getConfig: () => SwarmConfigInfo
  getSubagents: () => SubagentsLike | undefined
  getTools: () => ToolsLike | undefined
  getAttachments: () => AttachmentsLike | undefined
  probe: RouteProbe
  routeState: RouteStateRegistry
  readFile: (path: string) => Promise<Uint8Array>
  gitStatus: (cwd: string) => Promise<GitStatusInfo | undefined>
  now: () => number
  newId: (prefix: string) => string
}

interface EvaluationInfo {
  status: 'completed' | 'failed'
  summary: string
  structured?: unknown
  unresolved: string[]
  evidence: EvidenceItem[]
  error?: string
}

const HIGH_RISK_GATES: readonly GateId[] = ['G_MATH_VERIFY', 'G_REVIEW', 'G_DIFF_TEST']

/**
 * 评估子智能体结果：必须 completed、提交结构化结果并通过契约校验
 * @param {DelegableRoleId} role - 角色
 * @param {SuanHengMode | undefined} mode - 算衡模式
 * @param {SubagentResultLike} result - 子智能体结果
 * @param {unknown} structured - 结构化结果（原生后端由文本解析得到）
 * @returns {EvaluationInfo} 评估
 */
const getEvaluation = (role: DelegableRoleId, mode: SuanHengMode | undefined, result: SubagentResultLike, structured: unknown): EvaluationInfo => {
  const text = getOutputText(result).slice(0, 500)
  if (result.stopReason !== 'completed') {
    return { status: 'failed', summary: text || '子智能体未完成', unresolved: [], evidence: [], error: `${result.stopReason}${result.diagnostic === undefined ? '' : `：${result.diagnostic}`}` }
  }
  if (structured === undefined) return { status: 'failed', summary: text || '无结果', unresolved: [], evidence: [], error: '子智能体没有提交结构化结果' }
  const errors = ValidateStructuredOutput(role, structured, mode)
  if (errors.length > 0) {
    return { status: 'failed', summary: text || '结果不合格', structured, unresolved: [], evidence: [], error: `结构化结果不符合契约：${errors.slice(0, 5).join('；')}` }
  }
  const value = structured as { summary: string; unresolved: string[] }
  return { status: 'completed', summary: value.summary, structured, unresolved: value.unresolved, evidence: getEvidenceFromOutput(role, structured) }
}

/**
 * 创建委派执行器
 * @param {DelegateDepsInfo} deps - 依赖
 * @returns {{ delegate: (raw: unknown, exec: DelegateExecInfo, session: DelegateSessionInfo) => Promise<DelegationRecord> }} 执行器
 */
export const intDelegator = (deps: DelegateDepsInfo) => {
  const finish = (session: DelegateSessionInfo, record: DelegationRecord, patch: Partial<DelegationRecord>): DelegationRecord => {
    const finishedAt = deps.now()
    const next = session.store.UpdateDelegation(record.delegationId, { ...patch, finishedAt, durationMs: finishedAt - record.startedAt })
    session.ledger.AddLedgerEvent({
      type: `delegation/${next.status}` as 'delegation/completed',
      taskId: next.taskId,
      delegationId: next.delegationId,
      data: {
        role: next.role, summary: next.summary, error: next.error, route: next.route === undefined ? undefined : getRouteLabel(next.route),
        backend: next.backend, attempts: next.attempts, independence: next.independence, hardIsolation: next.hardIsolation,
        changedFiles: next.changedFiles, evidenceCount: next.evidence.length, durationMs: next.durationMs
      }
    })
    return next
  }

  const block = (session: DelegateSessionInfo, record: DelegationRecord, reason: string, attempts: RouteAttempt[] = []): DelegationRecord =>
    finish(session, record, { status: 'blocked', summary: reason, error: reason, attempts: [...record.attempts, ...attempts] })

  const markRunning = (session: DelegateSessionInfo, record: DelegationRecord, backend: BackendKind): DelegationRecord => {
    const next = session.store.UpdateDelegation(record.delegationId, { status: 'running', backend })
    session.ledger.AddLedgerEvent({ type: 'delegation/running', taskId: next.taskId, delegationId: next.delegationId, data: { backend } })
    return next
  }

  /** 带超时与调用方取消的运行：超时或取消都会中止子智能体 */
  const runWithSignal = async (exec: DelegateExecInfo, config: SwarmConfigInfo, start: (signal: AbortSignal) => Promise<SubagentRunLike>, onRun?: (run: SubagentRunLike) => void) => {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    exec.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), config.budgets.delegationTimeoutMs)
    try {
      const run = await start(controller.signal)
      onRun?.(run)
      try {
        return { run, result: await run.result }
      } catch (error) {
        return { run, result: { output: [], stopReason: 'error', diagnostic: getErrorText(error) } as SubagentResultLike }
      } finally {
        await run.dispose().catch(() => undefined)
      }
    } finally {
      clearTimeout(timer)
      exec.signal.removeEventListener('abort', onAbort)
    }
  }

  const getWorkspaceRoot = (agent: AgentLike): string => getAgentHeader(agent).cwd ?? process.cwd()

  /** 统计执行前后的工作区改动；只读角色出现改动时追加告警 */
  const getChangeInfo = (role: DelegableRoleId, before: GitStatusInfo | undefined, after: GitStatusInfo | undefined) => {
    if (before === undefined || after === undefined) return { changeTracking: 'unavailable' as const, changedFiles: undefined, warnings: [] as string[] }
    const changedFiles = getChangedFiles(before, after)
    const warnings = !isEditRole(role) && changedFiles.length > 0
      ? [`警告：「${getRoleInfo(role).name}」执行期间工作区出现改动：${changedFiles.join(', ')}（可能来自并行任务或越权操作，请核对）`]
      : []
    return { changeTracking: 'git' as const, changedFiles, warnings }
  }

  const getNativeChoice = (input: DelegateInput, task: TaskRecord, config: SwarmConfigInfo): EscalationKind | undefined => {
    if (input.backend === 'codex' || input.backend === 'claude') return input.backend
    if (input.backend === 'api' || config.nativeEscalation !== 'auto') return undefined
    const escalation = getRoleRoute(config, getRouteKey(input.role, input.mode)).escalation
    const highRisk = task.gates.some((gate) => HIGH_RISK_GATES.includes(gate.gate)) || task.card.flags.securitySensitive
    return highRisk ? escalation : undefined
  }

  const tryNative = async (
    input: DelegateInput, task: TaskRecord, record: DelegationRecord, exec: DelegateExecInfo,
    session: DelegateSessionInfo, config: SwarmConfigInfo, subagents: SubagentsLike, choice: EscalationKind, attempts: RouteAttempt[]
  ): Promise<DelegationRecord | undefined> => {
    const kind = getNativeKind(input.role, choice)
    if (kind === undefined) {
      attempts.push({ route: `native:${choice}`, backend: 'spawn', outcome: 'skipped', reason: `「${getRoleInfo(input.role).name}」不支持原生后端` })
      return undefined
    }
    const provider = getNativeProviderName(kind, config)
    if (subagents.getProvider(provider) === undefined) {
      attempts.push({ route: provider, backend: kind, outcome: 'skipped', reason: 'native-unavailable' })
      return undefined
    }
    if (session.counters.native >= config.native.maxCallsPerSession) {
      attempts.push({ route: provider, backend: kind, outcome: 'skipped', reason: 'native-budget' })
      return undefined
    }
    session.counters.native += 1
    session.ledger.AddLedgerEvent({ type: 'native/call', taskId: task.taskId, delegationId: record.delegationId, data: { provider, kind, used: session.counters.native } })
    const running = markRunning(session, record, kind)
    const cwd = getWorkspaceRoot(exec.agent)
    const before = await deps.gitStatus(cwd)
    const text = getNativePromptText(task, input, record.delegationId, input.mode)
    const { run, result } = await runWithSignal(exec, config, (signal) =>
      subagents.start(provider, { label: `${getRoleInfo(input.role).name}·${task.taskId}`, prompt: [{ type: 'text', text }], parent: exec.agent, signal }))
    const evaluation = getEvaluation(input.role, input.mode, result, ParseNativeOutput(getOutputText(result)))
    const change = getChangeInfo(input.role, before, await deps.gitStatus(cwd))
    const route: RouteInfo = { provider, model: kind.startsWith('codex') ? 'codex-native' : 'claude-native' }
    const avoid = getAvoidFamilies(input.role, input.mode, session.store.getTaskDelegations(task.taskId))
    return finish(session, running, {
      ...evaluation,
      unresolved: [...evaluation.unresolved, ...change.warnings],
      evidence: [...evaluation.evidence, ...(change.changedFiles ?? []).filter(() => isEditRole(input.role)).map((ref) => ({ kind: 'file-change' as const, ref }))],
      route,
      backend: kind,
      childId: run.id,
      hardIsolation: false,
      independence: avoid.length === 0 ? 'n/a' : avoid.includes(getModelFamily(route.model)) ? 'not-achieved' : 'achieved',
      attempts: [...attempts, { route: getRouteLabel(route), backend: kind, outcome: 'used' }],
      changeTracking: change.changeTracking,
      ...(change.changedFiles === undefined ? {} : { changedFiles: change.changedFiles })
    })
  }

  const runSpawn = async (
    input: DelegateInput, task: TaskRecord, record: DelegationRecord, exec: DelegateExecInfo,
    session: DelegateSessionInfo, config: SwarmConfigInfo, subagents: SubagentsLike, existing: DelegationRecord[], attempts: RouteAttempt[]
  ): Promise<DelegationRecord> => {
    const role = getRoleInfo(input.role)
    const selection = await FindUsableRoutes(getRoleRoute(config, getRouteKey(input.role, input.mode)).chain, {
      probe: deps.probe,
      requireVision: role.needsVision,
      avoidFamilies: getAvoidFamilies(input.role, input.mode, existing)
    })
    for (const skipped of selection.skipped) {
      attempts.push({ route: getRouteLabel(skipped.route), backend: 'spawn', outcome: 'skipped', reason: skipped.reason })
      session.ledger.AddLedgerEvent({ type: 'route/skipped', taskId: task.taskId, delegationId: record.delegationId, data: { route: getRouteLabel(skipped.route), reason: skipped.reason } })
    }
    if (selection.usable.length === 0) {
      const visionOnly = role.needsVision && selection.skipped.some((s) => s.reason === 'vision-unsupported')
      const reason = visionOnly ? 'vision-unsupported：路由链上没有支持图片输入的可用模型，不会降级为纯文本推断' : 'no-usable-route：路由链上没有可用的 provider/模型，请检查 Models 配置'
      return block(session, record, reason, attempts)
    }
    const tools = deps.getTools()
    if (tools === undefined) return block(session, record, '工具服务不可用，无法限制子智能体权限', attempts)
    const toolFilter = getToolFilter(input.role, tools.schemas(exec.agent).map((schema) => schema.name), input.allow_web === true)
    let images: ContentBlockLike[] = []
    if (input.image_paths !== undefined) {
      const check = ValidateImagePaths(input.image_paths, getWorkspaceRoot(exec.agent))
      if (!check.ok) return block(session, record, check.errors.join('；'), attempts)
      try {
        images = await getImageBlocks(check.resolved, { readFile: deps.readFile, ...(deps.getAttachments() === undefined ? {} : { attachments: deps.getAttachments() }) })
      } catch (error) {
        return block(session, record, `图片入库失败：${getErrorText(error)}`, attempts)
      }
    }
    const running = markRunning(session, record, 'spawn')
    const cwd = getWorkspaceRoot(exec.agent)
    const before = await deps.gitStatus(cwd)
    const text = getChildPromptText(task, input, record.delegationId)
    const fallbacks: RouteAttempt[] = []
    const onFallback = (event: FallbackEventInfo): void => {
      fallbacks.push({ route: getRouteLabel(event.from), backend: 'spawn', outcome: 'fallback', reason: `${event.failure.code ?? event.failure.status ?? 'error'} → ${getRouteLabel(event.to)}` })
      session.ledger.AddLedgerEvent({ type: 'route/fallback', taskId: task.taskId, delegationId: record.delegationId, data: { from: getRouteLabel(event.from), to: getRouteLabel(event.to), failure: event.failure } })
    }
    let usedIndex = -1
    const startSpawn = async (signal: AbortSignal): Promise<SubagentRunLike> => {
      for (const [index, route] of selection.usable.entries()) {
        try {
          const run = await subagents.start(SPAWN_PROVIDER, {
            label: `${role.name}·${task.taskId}`,
            prompt: [{ type: 'text', text }, ...images],
            parent: exec.agent,
            signal,
            agentOptions: route,
            outputSchema: getOutputSchema(input.role),
            maxDepth: 1,
            ...(toolFilter === undefined ? {} : { toolFilter }),
            persona: getChildPersona(input.role, input.mode)
          })
          usedIndex = index
          return run
        } catch (error) {
          attempts.push({ route: getRouteLabel(route), backend: 'spawn', outcome: 'failed', reason: `start: ${getErrorText(error)}` })
        }
      }
      throw new SwarmError('SERVICE_UNAVAILABLE', '所有可用路由都无法启动子智能体')
    }
    let finalRoute: RouteInfo | undefined
    let outcome: { run: SubagentRunLike; result: SubagentResultLike }
    try {
      outcome = await runWithSignal(exec, config, startSpawn, (run) =>
        deps.routeState.AddChild(run.id, { chain: selection.usable.slice(usedIndex), role: input.role, onFallback }))
    } catch (error) {
      return finish(session, running, { status: 'failed', summary: getErrorText(error), error: getErrorText(error), attempts })
    }
    finalRoute = deps.routeState.getChild(outcome.run.id)?.route ?? selection.usable[usedIndex]
    deps.routeState.DelAgent(outcome.run.id)
    const evaluation = getEvaluation(input.role, input.mode, outcome.result, outcome.result.structured)
    const change = getChangeInfo(input.role, before, await deps.gitStatus(cwd))
    const used: RouteAttempt[] = finalRoute === undefined ? [] : [{ route: getRouteLabel(finalRoute), backend: 'spawn', outcome: 'used' }]
    return finish(session, running, {
      ...evaluation,
      unresolved: [...evaluation.unresolved, ...change.warnings],
      evidence: [...evaluation.evidence, ...(isEditRole(input.role) ? (change.changedFiles ?? []).map((ref) => ({ kind: 'file-change' as const, ref })) : [])],
      ...(finalRoute === undefined ? {} : { route: finalRoute }),
      backend: 'spawn',
      childId: outcome.run.id,
      independence: selection.independence,
      attempts: [...attempts, ...fallbacks, ...used],
      changeTracking: change.changeTracking,
      ...(change.changedFiles === undefined ? {} : { changedFiles: change.changedFiles })
    })
  }

  const execute = async (input: DelegateInput, task: TaskRecord, record: DelegationRecord, exec: DelegateExecInfo, session: DelegateSessionInfo, existing: DelegationRecord[]): Promise<DelegationRecord> => {
    const config = deps.getConfig()
    const subagents = deps.getSubagents()
    if (subagents === undefined) return block(session, record, '子智能体服务不可用')
    const attempts: RouteAttempt[] = []
    const choice = getNativeChoice(input, task, config)
    if (choice !== undefined) {
      const native = await tryNative(input, task, record, exec, session, config, subagents, choice, attempts)
      if (native !== undefined) return native
    }
    return runSpawn(input, task, record, exec, session, config, subagents, existing, attempts)
  }

  const delegate = async (raw: unknown, exec: DelegateExecInfo, session: DelegateSessionInfo): Promise<DelegationRecord> => {
    const { input, errors } = ValidateDelegateInput(raw)
    if (input === undefined) throw new SwarmError('INVALID_ARGS', errors.join('；'))
    const task = session.store.getTask(input.task_id)
    if (task === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${input.task_id}，请先调用 swarm_task_card`)
    const role = getRoleInfo(input.role)
    const mode = input.role === 'suan_heng' ? (input.mode ?? 'research') : undefined
    const normalized: DelegateInput = mode === undefined ? input : { ...input, mode }
    const existing = session.store.getTaskDelegations(task.taskId)
    const record: DelegationRecord = {
      delegationId: deps.newId('D'), taskId: task.taskId, role: input.role, roleName: role.name,
      ...(mode === undefined ? {} : { mode }), ...(input.gate === undefined ? {} : { gate: input.gate }),
      status: 'queued', summary: '', evidence: [], attempts: [], independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: deps.now()
    }
    session.store.AddDelegation(record)
    session.ledger.AddLedgerEvent({ type: 'delegation/queued', taskId: task.taskId, delegationId: record.delegationId, data: { role: input.role, roleName: role.name, mode, gate: input.gate, backend: input.backend ?? 'auto' } })
    const budgetReason = ValidateDelegationBudget(existing, input.role, deps.getConfig().budgets)
    if (budgetReason !== undefined) return block(session, record, budgetReason)
    const run = (): Promise<DelegationRecord> => execute(normalized, task, record, exec, session, existing)
    return role.concurrencySafe ? run() : session.editLock.run(run)
  }

  return { delegate }
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/delegate.test.ts` 然后 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/delegate.ts tests/unit/delegate.test.ts
git commit -m "feat: add delegation executor with routing, native escalation and evidence"
```

---

### Task 11: SwarmService（任务卡、状态、验收、守卫）

**Files:**
- Create: `src/service.ts`
- Test: `tests/unit/service.test.ts`

**Interfaces:**
- Consumes: Task 1–10 的导出
- Produces:
  - `LoggerLike { info; warn }`、`SwarmServiceDepsInfo { getConfig; getLlm; getSubagents; getTools; getAttachments; getCredentials; dshHome; fetch; logger?; now?; readFile?; gitStatus?; sleep?; probe? }`
  - `AcceptInputInfo`、`ValidateAcceptInput(raw)` → `{ input?; errors }`
  - `SwarmService { getConfig(); routeState; AddTaskCard(raw, exec); delegate(raw, exec); getStatus(raw, exec); AcceptTask(raw, exec); getGuardReason(execution); getRoleForAgent(agent); getDiagnostics() }`
  - `intSwarmService(deps)` → `SwarmService`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/service.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig, type SwarmConfigInfo } from '../../src/config.js'
import { getLedgerEvents } from '../../src/evidence.js'
import type { SubagentStartRequestLike } from '../../src/host-contract.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import { ValidateAcceptInput, intSwarmService, type SwarmServiceDepsInfo } from '../../src/service.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const root = { id: 'root-1', session: { header: { agentPreset: 'tian-shu', cwd: process.cwd() } } }
const exec = () => ({ agent: root, signal: new AbortController().signal })

const jevBody = { answers: { math_task: { choice: 'research', confidence: 0.9 }, need_benchmark: { noul: 0.1 }, novelty: { score: 0.2, confidence: 0.9 } } }

const makeService = (options: { config?: Record<string, unknown>; env?: Partial<SwarmServiceDepsInfo> } = {}) => {
  const dshHome = mkdtempSync(join(tmpdir(), 'swarm-service-'))
  dirs.push(dshHome)
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(jevBody), { status: 200 }))
  const subagents = {
    list: () => ['spawn'],
    getProvider: (name: string) => (name === 'spawn' ? { capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } } : undefined),
    start: vi.fn(async (_name: string, request: SubagentStartRequestLike) => {
      const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as DelegableRoleId
      const structured = role === 'suan_heng' ? { ...(VALID_OUTPUTS.suan_heng as object), mode: request.persona?.includes('验算') ? 'verify' : 'research' } : VALID_OUTPUTS[role]
      return { id: `child-${role}-${subagents.start.mock.calls.length}`, result: Promise.resolve({ output: [], structured, stopReason: 'completed' }), dispose: async () => undefined }
    })
  }
  const config: SwarmConfigInfo = getSwarmConfig(options.config ?? {})
  const deps: SwarmServiceDepsInfo = {
    getConfig: () => config,
    getLlm: () => ({ listProviders: () => [{ id: 'qwen-token-plan-cn' }, { id: 'opencode-go' }, { id: 'deepseek-official' }], resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }),
    getSubagents: () => subagents,
    getTools: () => ({ register: () => () => undefined, schemas: () => ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'].map((name) => ({ name })), guard: () => () => undefined }),
    getAttachments: () => undefined,
    getCredentials: () => ({ resolve: async (ref: string) => (ref === 'TYPESAFE_API_KEY' ? { value: 'k' } : undefined) }),
    dshHome,
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async () => undefined,
    gitStatus: async () => undefined,
    now: (() => { let clock = 1000; return () => (clock += 10) })(),
    ...options.env
  }
  return { service: intSwarmService(deps), fetchMock, subagents, dshHome }
}

const cardInput = (flags: Record<string, boolean>, extra: Record<string, unknown> = {}) => ({ title: '任务', goal: '目标', acceptance: ['通过'], scope: ['src/a.ts'], flags, ...extra })

describe('AddTaskCard', () => {
  it('规则门禁 + Jev 追加门禁，写账本', async () => {
    const { service, fetchMock, dshHome } = makeService()
    const result = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    expect(result.task_id).toBe('T-1')
    expect(result.requiredGates.map((g) => g.gate).sort()).toEqual(['G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_VERIFY'])
    expect(result.triage.source).toBe('rules+jev')
    expect(result.suggestedRoles.map((s) => s.role)).toContain('fu_he')
    expect(result.requiredGates[0]).toHaveProperty('roleName')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ledgerPath.startsWith(join(dshHome, 'share', 'dsh-agent-swarm', 'ledger'))).toBe(true)
    expect(getLedgerEvents(result.ledgerPath).map((e) => e.type)).toEqual(['jev/call', 'task/card'])
  })

  it('Jev 关闭时只用规则；无关任务不调用 Jev', async () => {
    const { service, fetchMock } = makeService({ config: { jev: { enabled: false } } })
    const disabled = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    expect(disabled.triage).toMatchObject({ source: 'rules', fallbackReason: 'jev-disabled' })
    const copy = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    expect(copy.triage.source).toBe('rules')
    expect(copy.task_id).toBe('T-2')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Jev 缺少密钥时走严格路径；超出调用预算同样', async () => {
    const { service } = makeService({ config: { jev: { apiKeyEnv: 'SWARM_TEST_UNSET_KEY' } }, env: { getCredentials: () => undefined } })
    const result = await service.AddTaskCard(cardInput({ changesCode: true, changesAlgorithm: true }), exec())
    expect(result.triage).toMatchObject({ source: 'rules+jev-fallback', fallbackReason: 'missing-api-key' })
    expect(result.requiredGates.find((g) => g.gate === 'G_MATH_VERIFY')?.source).toBe('jev-fallback')
    const budget = makeService({ config: { jev: { maxCallsPerSession: 0 } } })
    const limited = await budget.service.AddTaskCard(cardInput({ changesCode: true }), exec())
    expect(limited.triage.fallbackReason).toBe('jev-budget')
  })

  it('环境变量兜底 Jev 密钥', async () => {
    process.env.SWARM_TEST_JEV_KEY = 'env-key'
    const { service, fetchMock } = makeService({ config: { jev: { apiKeyEnv: 'SWARM_TEST_JEV_KEY' } } })
    await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer env-key')
    delete process.env.SWARM_TEST_JEV_KEY
  })

  it('更新已有任务时门禁只增不减；未知任务与非法卡片报错', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    await service.AddTaskCard(cardInput({ hasVisualInput: true }), exec())
    const updated = await service.AddTaskCard(cardInput({ changesCode: true }, { task_id: 'T-1' }), exec())
    expect(updated.task_id).toBe('T-1')
    expect(updated.requiredGates.map((g) => g.gate).sort()).toEqual(['G_VERIFY', 'G_VISION'])
    await expect(service.AddTaskCard(cardInput({}, { task_id: 'T-9' }), exec())).rejects.toThrow('未知任务')
    await expect(service.AddTaskCard({ title: '' }, exec())).rejects.toThrow('title')
  })
})

describe('委派、状态与验收', () => {
  it('缺少复核时验收被拦下，补齐后通过；状态显示门禁与委派', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    const { task_id } = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    const edit = await service.delegate({ task_id, role: 'ji_feng', prompt: '改文件' }, exec())
    expect(edit.status).toBe('completed')
    const blocked = service.AcceptTask({ task_id, decision: 'accept', summary: '完成', stopReason: '完成' }, exec())
    expect(blocked.status).toBe('blocked')
    expect(blocked.missing.join('')).toContain('G_VERIFY')
    await service.delegate({ task_id, role: 'fu_he', prompt: '跑测试' }, exec())
    const status = service.getStatus({ task_id }, exec())
    expect(status.tasks[0]?.gates[0]).toMatchObject({ gate: 'G_VERIFY', satisfied: true })
    expect(status.tasks[0]?.delegations.map((d) => d.role)).toEqual(['ji_feng', 'fu_he'])
    expect(status.tasks[0]?.delegations[0]?.structured).toBeUndefined()
    expect(service.getStatus({ task_id, verbose: true }, exec()).tasks[0]?.delegations[0]?.structured).toBeDefined()
    const accepted = service.AcceptTask({ task_id, decision: 'accept', summary: '完成', unresolved: [], stopReason: '门禁全部满足' }, exec())
    expect(accepted.status).toBe('accepted')
    expect(service.getStatus({}, exec()).tasks[0]?.acceptance?.status).toBe('accepted')
  })

  it('御史高危发现需要处理说明', async () => {
    const { service, subagents } = makeService({ config: { jev: { enabled: false } } })
    const { task_id } = await service.AddTaskCard(cardInput({ crossModuleArchitecture: true }), exec())
    subagents.start.mockImplementationOnce(async () => ({
      id: 'review', dispose: async () => undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed', structured: { summary: 's', unresolved: [], findings: [{ severity: 'high', location: 'a', issue: 'i', suggestion: 's' }] } })
    }))
    const review = await service.delegate({ task_id, role: 'yu_shi', prompt: '审查' }, exec())
    const first = service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's' }, exec())
    expect(first.missing.join('')).toContain(`${review.delegationId}#0`)
    const second = service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's', findingResolutions: [{ delegationId: review.delegationId, index: 0, resolution: '已修复并补测试' }] }, exec())
    expect(second.status).toBe('accepted')
  })

  it('拒绝会累计修复轮次，超过上限后 blocked；incomplete 仅记录', async () => {
    const { service } = makeService({ config: { jev: { enabled: false }, budgets: { maxAutoFixRounds: 1 } } })
    const { task_id } = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    expect(service.AcceptTask({ task_id, decision: 'reject', summary: 's', stopReason: '需修复' }, exec())).toMatchObject({ status: 'recorded', roundsUsed: 1 })
    expect(service.AcceptTask({ task_id, decision: 'reject', summary: 's', stopReason: '需修复' }, exec())).toMatchObject({ status: 'blocked', roundsUsed: 2 })
    expect(service.AcceptTask({ task_id, decision: 'incomplete', summary: 's', stopReason: '缺少信息' }, exec()).status).toBe('recorded')
    expect(() => service.AcceptTask({ task_id: 'T-9', decision: 'accept', summary: 's', stopReason: 's' }, exec())).toThrow('未知任务')
    expect(() => service.getStatus({ task_id: 'T-9' }, exec())).toThrow('未知任务')
  })

  it('ValidateAcceptInput', () => {
    expect(ValidateAcceptInput('x').errors).toEqual(['参数必须是对象'])
    const result = ValidateAcceptInput({ task_id: 1, decision: 'maybe', summary: 1, stopReason: '', unresolved: [1], findingResolutions: [{ delegationId: 'd' }] })
    expect(result.errors.length).toBeGreaterThanOrEqual(5)
    expect(ValidateAcceptInput({ task_id: 'T', decision: 'accept', summary: 's', stopReason: 's' }).input).toMatchObject({ unresolved: [], findingResolutions: [] })
  })
})

describe('守卫与诊断', () => {
  it('只读角色调用写工具被拒绝；天枢与非 swarm 预设放行', async () => {
    const { service } = makeService()
    const reason = service.getGuardReason({ name: 'write', agent: { id: 'r', session: { header: { agentPreset: 'yu-shi' } } } })
    expect(reason).toContain('「御史」')
    expect(service.getGuardReason({ name: 'edit', agent: root })).toBeUndefined()
    expect(service.getGuardReason({ name: 'read', agent: { id: 'r', session: { header: { agentPreset: 'yu-shi' } } } })).toBeUndefined()
    expect(service.getGuardReason({ name: 'write', agent: { id: 'x', session: { header: { agentPreset: 'standard' } } } })).toBeUndefined()
    expect(service.getGuardReason({ name: 'write' })).toBeUndefined()
    service.routeState.AddChild('kid', { chain: [], role: 'fu_he' })
    expect(service.getGuardReason({ name: 'write', agent: { id: 'kid', session: { header: { agentPreset: 'tian-shu' } } } })).toContain('「复核」')
    expect(service.getRoleForAgent({ id: 'kid' })).toBe('fu_he')
  })

  it('诊断列出缺失或能力不足的宿主服务', () => {
    const { service } = makeService({ env: { getLlm: () => undefined, getTools: () => undefined, getSubagents: () => ({ list: () => [], getProvider: () => undefined, start: async () => { throw new Error('x') } }) } })
    const diagnostics = service.getDiagnostics().join('\n')
    expect(diagnostics).toContain('ctx.llm')
    expect(diagnostics).toContain('ctx.tools')
    expect(diagnostics).toContain('spawn')
    expect(diagnostics).toContain('附件')
    expect(makeService().service.getDiagnostics().join('')).toContain('附件')
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/service.test.ts`
Expected: FAIL，模块 `src/service.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/service.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SwarmConfigInfo } from './config.js'
import { intDelegator, type DelegateExecInfo, type DelegateSessionInfo } from './delegate.js'
import { intLedger, intTaskStore, type AcceptanceRecord, type DelegationRecord, type TaskRecord, type TriageRecord } from './evidence.js'
import {
  SPAWN_PROVIDER,
  WRITE_TOOL_NAMES,
  getAgentHeader,
  type AgentLike,
  type AttachmentsLike,
  type CredentialsLike,
  type LlmLike,
  type SubagentsLike,
  type ToolExecutionLike,
  type ToolsLike
} from './host-contract.js'
import { intJevClient, type JevOutcome } from './jev.js'
import {
  AddTriageGates,
  GATE_ROLE,
  ValidateTaskCard,
  getAcceptanceCheck,
  getEffectiveGates,
  getRuleGates,
  getSuggestedRoles,
  isTriageUseful,
  type FindingResolution,
  type GateRequirement,
  type TaskCard
} from './policy.js'
import { intRouteStateRegistry, type RouteStateRegistry } from './route-state.js'
import { FindRoleByPresetId, getPermissionLabel, getRoleInfo, isWriteAllowed, type RoleId } from './role-registry.js'
import { getRouteLabel, intRouteProbe, type RouteProbe } from './routes.js'
import { SwarmError } from './util/errors.js'
import { getGitStatus, type GitStatusInfo } from './util/git.js'
import { intMutex } from './util/mutex.js'

export interface LoggerLike {
  info: (message: string) => void
  warn: (message: string) => void
}

/** 服务依赖：宿主服务一律用 getter 延迟读取，适配服务晚于插件就绪的情况 */
export interface SwarmServiceDepsInfo {
  getConfig: () => SwarmConfigInfo
  getLlm: () => LlmLike | undefined
  getSubagents: () => SubagentsLike | undefined
  getTools: () => ToolsLike | undefined
  getAttachments: () => AttachmentsLike | undefined
  getCredentials: () => CredentialsLike | undefined
  dshHome: string
  fetch: typeof fetch
  logger?: LoggerLike
  now?: () => number
  readFile?: (path: string) => Promise<Uint8Array>
  gitStatus?: (cwd: string) => Promise<GitStatusInfo | undefined>
  sleep?: (ms: number) => Promise<void>
  probe?: RouteProbe
}

/** swarm_accept 的参数 */
export interface AcceptInputInfo {
  task_id: string
  decision: 'accept' | 'reject' | 'incomplete'
  summary: string
  unresolved: string[]
  stopReason: string
  findingResolutions: FindingResolution[]
}

const DECISIONS = ['accept', 'reject', 'incomplete'] as const

const isResolution = (value: unknown): value is FindingResolution => {
  const record = value as Record<string, unknown> | null
  return record !== null && typeof record === 'object' && typeof record.delegationId === 'string'
    && typeof record.index === 'number' && typeof record.resolution === 'string'
}

/**
 * 校验验收参数
 * @param {unknown} raw - 工具参数
 * @returns {{ input?: AcceptInputInfo; errors: string[] }} 规范化参数或错误
 */
export const ValidateAcceptInput = (raw: unknown): { input?: AcceptInputInfo; errors: string[] } => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['参数必须是对象'] }
  const value = raw as Record<string, unknown>
  const errors: string[] = []
  if (typeof value.task_id !== 'string' || value.task_id === '') errors.push('task_id 必须是非空字符串')
  if (!(DECISIONS as readonly unknown[]).includes(value.decision)) errors.push('decision 必须是 accept / reject / incomplete 之一')
  if (typeof value.summary !== 'string') errors.push('summary 必须是字符串')
  if (typeof value.stopReason !== 'string' || value.stopReason.trim() === '') errors.push('stopReason 必须是非空字符串')
  const unresolved = value.unresolved ?? []
  if (!Array.isArray(unresolved) || unresolved.some((item) => typeof item !== 'string')) errors.push('unresolved 必须是字符串数组')
  const resolutions = value.findingResolutions ?? []
  if (!Array.isArray(resolutions) || !resolutions.every(isResolution)) errors.push('findingResolutions 每项需要 delegationId、index、resolution')
  if (errors.length > 0) return { errors }
  return {
    input: {
      task_id: value.task_id as string,
      decision: value.decision as AcceptInputInfo['decision'],
      summary: value.summary as string,
      unresolved: unresolved as string[],
      stopReason: value.stopReason as string,
      findingResolutions: resolutions as FindingResolution[]
    },
    errors: []
  }
}

interface SessionStateInfo extends DelegateSessionInfo {
  counters: { native: number; jev: number }
}

/** 天枢工具与运行时行共用的服务 */
export interface SwarmService {
  getConfig: () => SwarmConfigInfo
  routeState: RouteStateRegistry
  AddTaskCard: (raw: unknown, exec: DelegateExecInfo) => Promise<ReturnType<typeof getTaskCardResult>>
  delegate: (raw: unknown, exec: DelegateExecInfo) => Promise<DelegationRecord>
  getStatus: (raw: unknown, exec: DelegateExecInfo) => ReturnType<typeof getStatusResult>
  AcceptTask: (raw: unknown, exec: DelegateExecInfo) => AcceptResultInfo
  getGuardReason: (execution: ToolExecutionLike) => string | undefined
  getRoleForAgent: (agent: AgentLike | undefined) => RoleId | undefined
  getDiagnostics: () => string[]
}

/** 验收结果 */
export interface AcceptResultInfo {
  task_id: string
  status: AcceptanceRecord['status']
  missing: string[]
  roundsUsed: number
  maxAutoFixRounds: number
  gates: ReturnType<typeof getAcceptanceCheck>['statuses']
}

const getGateView = (gate: GateRequirement) => ({
  gate: gate.gate,
  role: gate.role,
  roleName: getRoleInfo(gate.role).name,
  ...(gate.mode === undefined ? {} : { mode: gate.mode }),
  label: GATE_ROLE[gate.gate].label,
  reason: gate.reason,
  source: gate.source
})

const getTaskCardResult = (task: TaskRecord, card: TaskCard, config: SwarmConfigInfo, ledgerPath: string) => ({
  task_id: task.taskId,
  title: card.title,
  requiredGates: task.gates.map(getGateView),
  suggestedRoles: getSuggestedRoles(card, task.gates).map((item) => ({ ...item, roleName: getRoleInfo(item.role).name })),
  triage: task.triage,
  budgets: config.budgets,
  ledgerPath
})

const getDelegationView = (d: DelegationRecord, verbose: boolean) => ({
  delegationId: d.delegationId,
  role: d.role,
  roleName: d.roleName,
  ...(d.mode === undefined ? {} : { mode: d.mode }),
  status: d.status,
  summary: d.summary.slice(0, 300),
  route: d.route === undefined ? null : getRouteLabel(d.route),
  backend: d.backend ?? null,
  independence: d.independence,
  hardIsolation: d.hardIsolation,
  durationMs: d.durationMs ?? null,
  error: d.error ?? null,
  unresolved: d.unresolved,
  changedFiles: d.changedFiles ?? [],
  ...(verbose ? { structured: d.structured, evidence: d.evidence, attempts: d.attempts } : {})
})

const getTaskView = (task: TaskRecord, delegations: DelegationRecord[], config: SwarmConfigInfo, verbose: boolean) => {
  const gates = getEffectiveGates(task.gates, delegations)
  const check = getAcceptanceCheck(gates, delegations, task.acceptance?.resolutions ?? [])
  return {
    task_id: task.taskId,
    title: task.card.title,
    goal: task.card.goal,
    rounds: task.rounds,
    triage: task.triage,
    acceptance: task.acceptance ?? null,
    gates: check.statuses.map((status) => ({ ...status, label: GATE_ROLE[status.gate].label })),
    delegations: delegations.map((d) => getDelegationView(d, verbose)),
    budget: { used: delegations.filter((d) => d.status !== 'blocked').length, max: config.budgets.maxDelegationsPerTask }
  }
}

const getStatusResult = (tasks: ReturnType<typeof getTaskView>[], session: SessionStateInfo, diagnostics: string[]) => ({
  tasks,
  ledgerPath: session.ledger.path,
  usage: { nativeCalls: session.counters.native, jevCalls: session.counters.jev },
  diagnostics
})

/**
 * 创建 SwarmService
 * @param {SwarmServiceDepsInfo} deps - 依赖
 * @returns {SwarmService} 服务
 */
export const intSwarmService = (deps: SwarmServiceDepsInfo): SwarmService => {
  const sessions = new Map<string, SessionStateInfo>()
  const now = deps.now ?? Date.now
  let sequence = 0
  const newId = (prefix: string): string => `${prefix}-${++sequence}`

  const getLedgerDir = (): string => deps.getConfig().ledgerDir || join(deps.dshHome, 'share', 'dsh-agent-swarm', 'ledger')

  const getSession = (sessionId: string): SessionStateInfo => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionStateInfo = {
      sessionId,
      store: intTaskStore(),
      ledger: intLedger(getLedgerDir(), sessionId, (error) => deps.logger?.warn(`账本写入失败：${String(error)}`)),
      editLock: intMutex(),
      counters: { native: 0, jev: 0 }
    }
    sessions.set(sessionId, created)
    return created
  }

  const routeState = intRouteStateRegistry((event) => {
    deps.logger?.warn(`主会话 ${event.agentId} 路由 ${getRouteLabel(event.from)} 失败（${event.failure.code ?? event.failure.status ?? 'error'}），回退到 ${getRouteLabel(event.to)}`)
    getSession(event.agentId).ledger.AddLedgerEvent({ type: 'route/fallback', data: { scope: 'root', from: getRouteLabel(event.from), to: getRouteLabel(event.to), failure: event.failure } })
  })

  const delegator = intDelegator({
    getConfig: deps.getConfig,
    getSubagents: deps.getSubagents,
    getTools: deps.getTools,
    getAttachments: deps.getAttachments,
    probe: deps.probe ?? intRouteProbe(deps.getLlm),
    routeState,
    readFile: deps.readFile ?? (async (path) => new Uint8Array(await readFile(path))),
    gitStatus: deps.gitStatus ?? ((cwd) => getGitStatus(cwd)),
    now,
    newId
  })

  const getJevKey = async (env: string): Promise<string | undefined> => {
    try {
      const hit = await deps.getCredentials()?.resolve(env)
      if (hit?.value) return hit.value
    } catch (error) {
      deps.logger?.warn(`读取 Jev 凭据引用 ${env} 失败：${String(error)}`)
    }
    return process.env[env]
  }

  const getTriage = async (card: TaskCard, gates: GateRequirement[], session: SessionStateInfo, signal: AbortSignal) => {
    const config = deps.getConfig()
    const rulesApplied = gates.map((gate) => `${gate.gate}：${gate.reason}`)
    if (!isTriageUseful(card, gates)) return { gates, triage: { source: 'rules', rulesApplied } as TriageRecord }
    if (!config.jev.enabled) return { gates, triage: { source: 'rules', rulesApplied, fallbackReason: 'jev-disabled' } as TriageRecord }
    let outcome: JevOutcome
    if (session.counters.jev >= config.jev.maxCallsPerSession) {
      outcome = { ok: false, reason: 'jev-budget', attempts: 0 }
    } else {
      session.counters.jev += 1
      outcome = await intJevClient(config.jev, { fetch: deps.fetch, getApiKey: () => getJevKey(config.jev.apiKeyEnv), ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) }).triage(card, signal)
    }
    session.ledger.AddLedgerEvent({ type: 'jev/call', data: outcome.ok ? { ok: true, attempts: outcome.attempts, answers: outcome.answers } : { ok: false, reason: outcome.reason, attempts: outcome.attempts } })
    const next = AddTriageGates(gates, card, outcome.ok ? { failed: false, answers: outcome.answers } : { failed: true, reason: outcome.reason }, config.thresholds)
    const triage: TriageRecord = outcome.ok
      ? { source: 'rules+jev', answers: outcome.answers, rulesApplied }
      : { source: 'rules+jev-fallback', fallbackReason: outcome.reason, rulesApplied }
    return { gates: next, triage }
  }

  const AddTaskCard: SwarmService['AddTaskCard'] = async (raw, exec) => {
    const { card, errors } = ValidateTaskCard(raw)
    if (card === undefined) throw new SwarmError('INVALID_ARGS', errors.join('；'))
    const session = getSession(exec.agent.id)
    const requestedId = (raw as { task_id?: unknown }).task_id
    const existing = typeof requestedId === 'string' ? session.store.getTask(requestedId) : undefined
    if (typeof requestedId === 'string' && existing === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${requestedId}`)
    const ruleGates = getRuleGates(card)
    const merged = existing === undefined ? ruleGates : [...existing.gates, ...ruleGates.filter((gate) => !existing.gates.some((old) => old.gate === gate.gate))]
    const { gates, triage } = await getTriage(card, merged, session, exec.signal)
    const task: TaskRecord = existing === undefined
      ? { taskId: `T-${session.store.getTasks().length + 1}`, sessionId: session.sessionId, card, gates, triage, delegationIds: [], rounds: 0, createdAt: now(), updatedAt: now() }
      : session.store.UpdateTask(existing.taskId, { card, gates, triage })
    if (existing === undefined) session.store.AddTask(task)
    session.ledger.AddLedgerEvent({ type: 'task/card', taskId: task.taskId, data: { card, gates: gates.map((gate) => gate.gate), triage: triage.source } })
    return getTaskCardResult(task, card, deps.getConfig(), session.ledger.path)
  }

  const getTaskOrThrow = (session: SessionStateInfo, taskId: string): TaskRecord => {
    const task = session.store.getTask(taskId)
    if (task === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${taskId}`)
    return task
  }

  const getDiagnostics = (): string[] => {
    const out: string[] = []
    if (deps.getLlm() === undefined) out.push('ctx.llm 不可用：无法做路由预检')
    if (deps.getTools() === undefined) out.push('ctx.tools 不可用：无法计算子智能体工具白名单')
    const spawn = deps.getSubagents()?.getProvider(SPAWN_PROVIDER)
    const capabilities = spawn?.capabilities ?? {}
    const required = ['agentOptions', 'outputSchema', 'toolFilter', 'persona', 'depthLimit']
    if (spawn === undefined) out.push('spawn 子智能体后端不可用：无法委派')
    else if (required.some((cap) => capabilities[cap] !== true)) out.push(`spawn 后端缺少能力：${required.filter((cap) => capabilities[cap] !== true).join(', ')}`)
    if (deps.getAttachments() === undefined) out.push('附件服务不可用：观象无法接收工作区图片')
    return out
  }

  const getStatus: SwarmService['getStatus'] = (raw, exec) => {
    const input = (raw ?? {}) as { task_id?: unknown; verbose?: unknown }
    const session = getSession(exec.agent.id)
    const config = deps.getConfig()
    const tasks = typeof input.task_id === 'string' ? [getTaskOrThrow(session, input.task_id)] : session.store.getTasks()
    const views = tasks.map((task) => getTaskView(task, session.store.getTaskDelegations(task.taskId), config, input.verbose === true))
    return getStatusResult(views, session, getDiagnostics())
  }

  const AcceptTask: SwarmService['AcceptTask'] = (raw, exec) => {
    const { input, errors } = ValidateAcceptInput(raw)
    if (input === undefined) throw new SwarmError('INVALID_ARGS', errors.join('；'))
    const session = getSession(exec.agent.id)
    const task = getTaskOrThrow(session, input.task_id)
    const config = deps.getConfig()
    const delegations = session.store.getTaskDelegations(task.taskId)
    const resolutions = [...(task.acceptance?.resolutions ?? []), ...input.findingResolutions]
    const check = getAcceptanceCheck(getEffectiveGates(task.gates, delegations), delegations, resolutions)
    let rounds = task.rounds
    let status: AcceptanceRecord['status'] = 'recorded'
    let missing: string[] = []
    if (input.decision === 'accept') {
      const pending = delegations.filter((d) => d.status === 'queued' || d.status === 'running').map((d) => d.delegationId)
      missing = [...check.missing, ...(pending.length > 0 ? [`仍有未结束的委派：${pending.join(', ')}`] : [])]
      status = missing.length === 0 ? 'accepted' : 'blocked'
    } else if (input.decision === 'reject') {
      rounds += 1
      if (rounds > config.budgets.maxAutoFixRounds) {
        status = 'blocked'
        missing = [`自动修复轮次已用尽（上限 ${config.budgets.maxAutoFixRounds}），请向用户报告阻塞原因`]
      }
    }
    const acceptance: AcceptanceRecord = {
      decision: input.decision, status, summary: input.summary, missing, unresolved: input.unresolved,
      stopReason: input.stopReason, resolutions, at: now()
    }
    session.store.UpdateTask(task.taskId, { rounds, acceptance })
    session.ledger.AddLedgerEvent({ type: 'accept/decision', taskId: task.taskId, data: { ...acceptance } })
    return { task_id: task.taskId, status, missing, roundsUsed: rounds, maxAutoFixRounds: config.budgets.maxAutoFixRounds, gates: check.statuses }
  }

  const getRoleForAgent = (agent: AgentLike | undefined): RoleId | undefined => {
    if (agent === undefined) return undefined
    return routeState.getChildRole(agent.id) ?? FindRoleByPresetId(getAgentHeader(agent).agentPreset)?.id
  }

  const getGuardReason = (execution: ToolExecutionLike): string | undefined => {
    if (!WRITE_TOOL_NAMES.includes(execution.name)) return undefined
    const role = getRoleForAgent(execution.agent)
    if (role === undefined || isWriteAllowed(role)) return undefined
    return `dsh-agent-swarm 守卫：「${getRoleInfo(role).name}」是${getPermissionLabel(role)}角色，不能调用 ${execution.name} 修改文件。请在结果中写明需要的改动，由天枢交给铸剑或疾风处理。`
  }

  return {
    getConfig: deps.getConfig,
    routeState,
    AddTaskCard,
    delegate: (raw, exec) => delegator.delegate(raw, exec, getSession(exec.agent.id)),
    getStatus,
    AcceptTask,
    getGuardReason,
    getRoleForAgent,
    getDiagnostics
  }
}
````

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/service.test.ts` 然后 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/service.ts tests/unit/service.test.ts
git commit -m "feat: add SwarmService with task cards, status, acceptance and write guard"
```

---

### Task 12: 插件入口（宿主行、工具行、运行时行）

**Files:**
- Create: `src/index.ts`, `src/tools.ts`, `src/runtime.ts`
- Test: `tests/unit/plugin.test.ts`

**Interfaces:**
- Consumes: `SWARM_SERVICE`、`PluginContextLike`、`ToolsLike`（Task 1）、`Config`、`getSwarmConfig`（Task 7）、`intSwarmService`、`SwarmService`（Task 11）、`getToolDefinition`（Task 1）
- Produces:
  - `src/index.ts`：`name = 'dsh-agent-swarm'`、`inject = ['llm', 'subagents', 'tools']`、`Config`、`getDshHome(ctx)`、`apply(ctx, config)`（provide `agentSwarm`，注册写操作守卫）
  - `src/tools.ts`：`name`、`inject = ['agentSwarm', 'tools']`、`TASK_CARD_PARAMETERS`、`DELEGATE_PARAMETERS`、`STATUS_PARAMETERS`、`ACCEPT_PARAMETERS`、`getTaskCardText`、`getDelegationText`、`getStatusText`、`getAcceptText`、`getSwarmToolDefinitions(service)`、`apply(ctx)`
  - `src/runtime.ts`：`name`、`inject = ['agentSwarm']`、`Config`（`{ role }`）、`apply(ctx, config)`

- [ ] **Step 1: 写失败的测试**

````ts file=tests/unit/plugin.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as host from '../../src/index.js'
import * as runtime from '../../src/runtime.js'
import * as tools from '../../src/tools.js'
import type { PluginContextLike, SubagentStartRequestLike, ToolExecutionLike } from '../../src/host-contract.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import type { SwarmService } from '../../src/service.js'
import type { ToolDefinitionLike } from '../../src/tool-shape.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const makeContext = (services: Record<string, unknown>) => {
  const provided = new Map<string, unknown>()
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const disposers: Array<() => void> = []
  const warn = vi.fn()
  const ctx: PluginContextLike = {
    get: (name) => provided.get(name) ?? services[name],
    provide: (name, value) => { provided.set(name, value); return () => { provided.delete(name) } },
    effect: (execute) => { disposers.push(execute()) },
    on: (name, listener) => { listeners.set(name, listener); return () => true },
    logger: () => ({ info: vi.fn(), warn })
  }
  return { ctx, provided, listeners, disposers, warn }
}

const makeHost = () => {
  const home = mkdtempSync(join(tmpdir(), 'swarm-plugin-'))
  dirs.push(home)
  const registered: ToolDefinitionLike[] = []
  const guards: Array<(execution: ToolExecutionLike) => string | undefined> = []
  const toolsService = {
    register: (definition: unknown) => { registered.push(definition as ToolDefinitionLike); return () => undefined },
    schemas: () => ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'].map((name) => ({ name })),
    guard: (guard: (execution: ToolExecutionLike) => string | undefined) => { guards.push(guard); return () => undefined }
  }
  const subagents = {
    list: () => ['spawn'],
    getProvider: (name: string) => (name === 'spawn' ? { capabilities: {} } : undefined),
    start: vi.fn(async (_name: string, request: SubagentStartRequestLike) => {
      const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as DelegableRoleId
      return { id: `child-${role}`, result: Promise.resolve({ output: [], structured: VALID_OUTPUTS[role], stopReason: 'completed' }), dispose: async () => undefined }
    })
  }
  const services = {
    llm: { listProviders: () => [{ id: 'qwen-token-plan-cn' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
    subagents,
    tools: toolsService,
    profileContext: { home }
  }
  const context = makeContext(services)
  host.apply(context.ctx, { jev: { enabled: false } })
  return { ...context, registered, guards, toolsService, home, services }
}

describe('宿主插件', () => {
  it('provide agentSwarm 服务并注册写操作守卫', () => {
    const { provided, guards, disposers } = makeHost()
    expect(host.name).toBe('dsh-agent-swarm')
    expect(host.inject).toEqual(['llm', 'subagents', 'tools'])
    expect(provided.get('agentSwarm')).toBeDefined()
    expect(guards).toHaveLength(1)
    expect(guards[0]?.({ name: 'write', agent: { id: 'a', session: { header: { agentPreset: 'yu-shi' } } } })).toContain('守卫')
    expect(disposers).toHaveLength(2)
  })

  it('DSH_HOME 解析顺序：profileContext.home → 环境变量 → ~/.dsh', () => {
    expect(host.getDshHome(makeContext({ profileContext: { home: '/h' } }).ctx)).toBe('/h')
    process.env.DSH_HOME = '/env-home'
    expect(host.getDshHome(makeContext({}).ctx)).toBe('/env-home')
    delete process.env.DSH_HOME
    expect(host.getDshHome(makeContext({}).ctx)).toMatch(/\.dsh$/)
  })
})

describe('工具插件', () => {
  it('注册 4 个工具并能走通任务卡 → 委派 → 状态 → 验收', async () => {
    const hostHarness = makeHost()
    const service = hostHarness.provided.get('agentSwarm') as SwarmService
    const registered: ToolDefinitionLike[] = []
    const context = makeContext({ agentSwarm: service, tools: { ...hostHarness.toolsService, register: (d: unknown) => { registered.push(d as ToolDefinitionLike); return () => undefined } } })
    tools.apply(context.ctx)
    expect(registered.map((d) => d.name)).toEqual(['swarm_task_card', 'swarm_delegate', 'swarm_status', 'swarm_accept'])
    const byName = (name: string) => registered.find((d) => d.name === name) as ToolDefinitionLike
    const exec = { agent: { id: 'root', session: { header: { agentPreset: 'tian-shu', cwd: process.cwd() } } }, signal: new AbortController().signal }

    const cardArgs = { title: '小改动', goal: '改一行', acceptance: ['测试通过'], scope: ['a.ts'], flags: { changesCode: true } }
    const card = await byName('swarm_task_card').execute(cardArgs, exec)
    const cardText = byName('swarm_task_card').output.render(cardArgs, card)[0]?.text ?? ''
    expect(cardText).toContain('task_id: T-1')
    expect(cardText).toContain('G_VERIFY')

    const delegateArgs = { task_id: 'T-1', role: 'ji_feng', prompt: '改 a.ts' }
    const edit = await byName('swarm_delegate').execute(delegateArgs, exec)
    const editText = byName('swarm_delegate').output.render(delegateArgs, edit)[0]?.text ?? ''
    expect(editText).toContain('【疾风】completed')
    expect(editText).toContain('```json')
    expect(byName('swarm_delegate').isConcurrencySafe?.({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' })).toBe(true)
    expect(byName('swarm_delegate').isConcurrencySafe?.(delegateArgs)).toBe(false)

    const blocked = await byName('swarm_accept').execute({ task_id: 'T-1', decision: 'accept', summary: 's', stopReason: 's' }, exec)
    expect(byName('swarm_accept').output.render({}, blocked)[0]?.text).toContain('blocked')

    await byName('swarm_delegate').execute({ task_id: 'T-1', role: 'fu_he', prompt: '测试' }, exec)
    const status = await byName('swarm_status').execute({ task_id: 'T-1', verbose: true }, exec)
    const statusText = byName('swarm_status').output.render({}, status)[0]?.text ?? ''
    expect(statusText).toContain('✓ G_VERIFY')
    expect(statusText).toContain('疾风')
    const accepted = await byName('swarm_accept').execute({ task_id: 'T-1', decision: 'accept', summary: 's', stopReason: '门禁满足' }, exec)
    expect(byName('swarm_accept').output.render({}, accepted)[0]?.text).toContain('accepted')
  })

  it('缺少会话上下文或参数非法时报错', async () => {
    const hostHarness = makeHost()
    const definitions = tools.getSwarmToolDefinitions(hostHarness.provided.get('agentSwarm') as SwarmService)
    const status = definitions.find((d) => d.name === 'swarm_status') as ToolDefinitionLike
    await expect(status.execute({}, { signal: new AbortController().signal })).rejects.toThrow('会话上下文')
    const delegate = definitions.find((d) => d.name === 'swarm_delegate') as ToolDefinitionLike
    await expect(delegate.execute({ task_id: 'T-1', role: 'x', prompt: 'p' }, { signal: new AbortController().signal })).rejects.toThrow('参数不合法')
  })

  it('渲染函数覆盖失败、跳过与告警信息', () => {
    const text = tools.getDelegationText({
      delegationId: 'D-9', taskId: 'T-1', role: 'guan_xiang', roleName: '观象', status: 'blocked', summary: 'vision-unsupported', evidence: [],
      attempts: [{ route: 'a/b', backend: 'spawn', outcome: 'skipped', reason: 'vision-unsupported' }, { route: 'c/d', backend: 'spawn', outcome: 'fallback', reason: 'QUOTA → e/f' }],
      independence: 'not-achieved', hardIsolation: false, unresolved: ['缺图'], error: 'vision-unsupported', startedAt: 1, changedFiles: ['x.png']
    })
    expect(text).toContain('跳过 a/b（vision-unsupported）')
    expect(text).toContain('回退 c/d（QUOTA → e/f）')
    expect(text).toContain('硬隔离：否')
    expect(text).toContain('错误：vision-unsupported')
    expect(text).toContain('改动文件：x.png')
  })
})

describe('运行时插件', () => {
  it('在作用域事件中改写路由并处理回退、清理', async () => {
    const hostHarness = makeHost()
    const service = hostHarness.provided.get('agentSwarm') as SwarmService
    const context = makeContext({ agentSwarm: service })
    runtime.apply(context.ctx, { role: { get: () => 'tian_shu' } })
    service.routeState.AddChild('kid', { chain: [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }], role: 'fu_he' })
    const onRequest = context.listeners.get('agent/request') as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const onError = context.listeners.get('agent/request-error') as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const onDisposed = context.listeners.get('agent/disposed') as unknown as (payload: unknown) => void
    expect(await onRequest({ agent: { id: 'kid' } }, async () => ({ provider: 'x', model: 'y' }))).toEqual({ provider: 'a', model: 'm1' })
    expect(await onError({ agent: { id: 'kid' }, provider: 'a', failure: { code: 'QUOTA' } }, async () => undefined)).toEqual({ kind: 'retry' })
    expect(service.routeState.getChild('kid')?.route?.model).toBe('m2')
    onDisposed({ agent: { id: 'kid' } })
    onDisposed(undefined)
    expect(service.routeState.getChild('kid')).toBeUndefined()
    expect(runtime.inject).toEqual(['agentSwarm'])
  })

  it('非法角色配置时只做子智能体改写，不做根会话回退', async () => {
    const hostHarness = makeHost()
    const service = hostHarness.provided.get('agentSwarm') as SwarmService
    const context = makeContext({ agentSwarm: service })
    runtime.apply(context.ctx, { role: 'nobody' })
    const onError = context.listeners.get('agent/request-error') as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
    expect(await onError({ agent: { id: 'root', session: { header: {} } }, provider: 'a', failure: { code: 'QUOTA' } }, async () => undefined)).toBeUndefined()
    expect(runtime.Config({ role: 'fu_he' })).toBeDefined()
  })
})
````

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/plugin.test.ts`
Expected: FAIL，模块 `src/index.js` 不存在

- [ ] **Step 3: 写实现**

````ts file=src/index.ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, getSwarmConfig } from './config.js'
import {
  SWARM_SERVICE,
  type AttachmentsLike,
  type CredentialsLike,
  type LlmLike,
  type PluginContextLike,
  type SubagentsLike,
  type ToolsLike
} from './host-contract.js'
import { intSwarmService, type LoggerLike } from './service.js'

/** 宿主行：提供 agentSwarm 服务并注册写操作守卫，本身不向模型注册工具 */
export const name = 'dsh-agent-swarm'
export const inject = ['llm', 'subagents', 'tools']
export { Config }

const getLogger = (ctx: PluginContextLike): LoggerLike => {
  const logger = ctx.logger?.('dsh-agent-swarm')
  return {
    info: (message) => logger?.info(message),
    warn: (message) => logger?.warn(message)
  }
}

/**
 * DSH 主目录：profileContext.home → DSH_HOME → ~/.dsh
 * @param {PluginContextLike} ctx - 插件上下文
 * @returns {string} 目录
 */
export const getDshHome = (ctx: PluginContextLike): string => {
  const profile = ctx.get('profileContext') as { home?: string } | undefined
  return profile?.home ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
}

/**
 * 宿主插件入口
 * @param {PluginContextLike} ctx - 插件上下文
 * @param {unknown} config - swarm-core 行的 Config（volatile）
 */
export const apply = (ctx: PluginContextLike, config: unknown): void => {
  const service = intSwarmService({
    getConfig: () => getSwarmConfig(config),
    getLlm: () => ctx.get('llm') as LlmLike | undefined,
    getSubagents: () => ctx.get('subagents') as SubagentsLike | undefined,
    getTools: () => ctx.get('tools') as ToolsLike | undefined,
    getAttachments: () => ctx.get('attachments') as AttachmentsLike | undefined,
    getCredentials: () => ctx.get('credentials') as CredentialsLike | undefined,
    dshHome: getDshHome(ctx),
    fetch: (input, init) => globalThis.fetch(input, init),
    logger: getLogger(ctx)
  })
  ctx.effect(() => ctx.provide(SWARM_SERVICE, service))
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (tools !== undefined) ctx.effect(() => tools.guard((execution) => service.getGuardReason(execution)))
}
````

````ts file=src/tools.ts
import { DELEGATE_BACKENDS } from './delegate.js'
import type { DelegationRecord } from './evidence.js'
import { SWARM_SERVICE, type PluginContextLike, type ToolsLike } from './host-contract.js'
import { FLAG_KEYS, GATE_IDS, type FlagKey } from './policy.js'
import { getDelegableRoleIds, getRoleCatalogText, getRoleInfo, isDelegableRoleId } from './role-registry.js'
import { getRouteLabel } from './routes.js'
import type { AcceptResultInfo, SwarmService } from './service.js'
import { getToolDefinition, type ToolDefinitionLike, type ToolExecLike } from './tool-shape.js'
import { SwarmError } from './util/errors.js'
import type { JsonSchemaObject } from './util/json-schema.js'

/** 预设行：只挂在天枢预设上，注册 4 个模型工具 */
export const name = 'dsh-agent-swarm-tools'
export const inject = [SWARM_SERVICE, 'tools']

const FLAG_DESCRIPTIONS: Readonly<Record<FlagKey, string>> = {
  changesCode: '会修改代码',
  changesAlgorithm: '改变算法语义',
  touchesFinancialLogic: '涉及资金、交易委托或策略逻辑',
  timeSeriesOrBacktest: '涉及时间序列未来信息或回测',
  stateMachine: '涉及状态机',
  numericPrecision: '涉及数值精度',
  sharedStateConcurrency: '涉及共享状态并发',
  crossModuleArchitecture: '跨模块架构或数据流',
  securitySensitive: '涉及安全、认证或密钥',
  hasVisualInput: '有截图、设计稿、图表或视觉回归产物',
  uiCopy: '涉及界面文案、命名或说明',
  hasExecSteps: '有明确的命令、构建或迁移执行步骤',
  needsExternalFacts: '需要外部最新资料、RFC 或论文',
  ambiguousRequirements: '需求模糊或多目标'
}

const MAX_RENDER = 7000
const DELEGATE_TIMEOUT_MS = 2 * 60 * 60 * 1000

const clip = (text: string, max = MAX_RENDER): string =>
  text.length > max ? `${text.slice(0, max)}\n…（已截断，完整内容见 swarm_status verbose 或账本）` : text

const strList = (description: string): JsonSchemaObject => ({ type: 'array', items: { type: 'string' }, description })

const getExec = (exec: ToolExecLike) => {
  if (exec.agent === undefined) throw new SwarmError('SERVICE_UNAVAILABLE', '工具调用缺少会话上下文')
  return { agent: exec.agent, signal: exec.signal }
}

export const TASK_CARD_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: '更新已有任务时传入；新任务不传' },
    title: { type: 'string', description: '任务标题' },
    goal: { type: 'string', description: '目标与期望结果' },
    acceptance: strList('可核对的验收标准（至少 1 条）'),
    scope: strList('涉及的文件或模块路径；未知可留空'),
    constraints: {
      type: 'object',
      properties: {
        apiCompat: { type: 'string', description: 'API 兼容要求' },
        environment: { type: 'string', description: '关键运行环境' },
        resourceLimits: { type: 'string', description: 'CPU/内存/I/O 上限' }
      },
      additionalProperties: false
    },
    perf: {
      type: 'object',
      description: '性能预算；未知参数写「待测」，不要编造',
      properties: {
        p95Ms: { description: 'p95 延迟（毫秒数字）或「待测」' },
        p99Ms: { description: 'p99 延迟（毫秒数字）或「待测」' },
        throughput: { type: 'string', description: '吞吐要求' },
        dataScale: { type: 'string', description: '数据规模' }
      },
      additionalProperties: false
    },
    flags: {
      type: 'object',
      description: '风险标志：如实填写，规则据此给出硬门槛',
      properties: Object.fromEntries(FLAG_KEYS.map((key) => [key, { type: 'boolean', description: FLAG_DESCRIPTIONS[key] }])),
      additionalProperties: false
    }
  },
  required: ['title', 'goal', 'acceptance', 'flags'],
  additionalProperties: false
}

export const DELEGATE_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: 'swarm_task_card 返回的 task_id' },
    role: { type: 'string', enum: getDelegableRoleIds(), description: `专家角色：\n${getRoleCatalogText()}` },
    mode: { type: 'string', enum: ['research', 'verify'], description: '仅算衡：research=研算（实现前定义语义与复杂度），verify=验算（独立找反例）' },
    prompt: { type: 'string', description: '自包含的任务说明：目标、相关文件、约束与交付要求。专家看不到本对话。' },
    context_paths: strList('相关文件路径'),
    image_paths: strList('仅观象：工作区内的截图/设计稿路径'),
    backend: { type: 'string', enum: DELEGATE_BACKENDS, description: 'auto（默认，按配置）/ api / codex（ChatGPT Plus 原生 Codex）/ claude（Claude Pro 原生 Claude Code）' },
    allow_web: { type: 'boolean', description: '仅枢机/算衡/妙笔：本次开放 web_search 与 web_fetch' },
    gate: { type: 'string', enum: GATE_IDS, description: '本次委派用于满足的门禁' }
  },
  required: ['task_id', 'role', 'prompt'],
  additionalProperties: false
}

export const STATUS_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: '只看某个任务；不传则列出本会话全部任务' },
    verbose: { type: 'boolean', description: '附带每个委派的结构化结果、证据与路由记录' }
  },
  additionalProperties: false
}

export const ACCEPT_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    decision: { type: 'string', enum: ['accept', 'reject', 'incomplete'], description: 'accept=申请验收；reject=不接受并进入修复轮次；incomplete=如实记录未完成' },
    summary: { type: 'string', description: '验收说明' },
    unresolved: strList('未解决问题'),
    stopReason: { type: 'string', description: '停止理由' },
    findingResolutions: {
      type: 'array',
      description: '对御史 critical/high 发现逐条说明处理结果',
      items: {
        type: 'object',
        properties: { delegationId: { type: 'string' }, index: { type: 'number' }, resolution: { type: 'string' } },
        required: ['delegationId', 'index', 'resolution'],
        additionalProperties: false
      }
    }
  },
  required: ['task_id', 'decision', 'summary', 'stopReason'],
  additionalProperties: false
}

type TaskCardResult = Awaited<ReturnType<SwarmService['AddTaskCard']>>
type StatusResult = ReturnType<SwarmService['getStatus']>

export const getTaskCardText = (result: TaskCardResult): string => {
  const triage = result.triage
  const answers = triage.answers === undefined ? '' : `；Jev：${JSON.stringify(triage.answers)}`
  return clip([
    `task_id: ${result.task_id}（任务卡已记录）`,
    `标题：${result.title}`,
    '必需门禁（硬门槛，不能跳过）：',
    ...(result.requiredGates.length === 0 ? ['- 无'] : result.requiredGates.map((g) => `- ${g.gate} ${g.label} → ${g.roleName}（${g.source}：${g.reason}）`)),
    '建议角色：',
    ...(result.suggestedRoles.length === 0 ? ['- 无'] : result.suggestedRoles.map((s) => `- ${s.role} ${s.roleName}：${s.reason}`)),
    `衡鉴：${triage.source}${triage.fallbackReason === undefined ? '' : `（回退原因：${triage.fallbackReason}）`}${answers}`,
    `预算：每任务最多 ${result.budgets.maxDelegationsPerTask} 次委派；每角色 ${result.budgets.maxCallsPerRole} 次（铸剑 ${result.budgets.maxCallsZhuJian} 次）；自动修复最多 ${result.budgets.maxAutoFixRounds} 轮`,
    `账本：${result.ledgerPath}`
  ].join('\n'))
}

export const getDelegationText = (record: DelegationRecord): string => {
  const attempts = record.attempts
    .filter((a) => a.outcome === 'skipped' || a.outcome === 'fallback' || a.outcome === 'failed')
    .map((a) => `${a.outcome === 'skipped' ? '跳过' : a.outcome === 'fallback' ? '回退' : '失败'} ${a.route}（${a.reason ?? ''}）`)
  return clip([
    `【${record.roleName}】${record.status}：${record.summary}`,
    `委派 ${record.delegationId} · 后端 ${record.backend ?? '无'} · 路由 ${record.route === undefined ? '无' : getRouteLabel(record.route)}`,
    ...(attempts.length > 0 ? [`路由记录：${attempts.join('；')}`] : []),
    `独立性：${record.independence}　硬隔离：${record.hardIsolation ? '是' : '否'}`,
    ...(record.changedFiles !== undefined && record.changedFiles.length > 0 ? [`改动文件：${record.changedFiles.join(', ')}`] : []),
    ...(record.unresolved.length > 0 ? [`未解决：${record.unresolved.join('；')}`] : []),
    ...(record.error === undefined ? [] : [`错误：${record.error}`]),
    ...(record.structured === undefined ? [] : ['结构化结果：', '```json', JSON.stringify(record.structured, null, 2), '```'])
  ].join('\n'))
}

export const getStatusText = (result: StatusResult): string => {
  const tasks = result.tasks.flatMap((task) => [
    `任务 ${task.task_id}：${task.title}（修复轮次 ${task.rounds}；委派 ${task.budget.used}/${task.budget.max}）`,
    ...task.gates.map((g) => `${g.satisfied ? '✓' : '✗'} ${g.gate} ${g.label}${g.satisfied ? `（${g.by ?? ''}）` : `：${g.missing ?? ''}`}${g.notes.length > 0 ? `；${g.notes.join('；')}` : ''}`),
    ...task.delegations.map((d) => `- ${d.delegationId} ${d.roleName} ${d.status} · ${d.route ?? '无路由'} · ${d.summary}${d.error === null ? '' : ` · 错误：${d.error}`}`),
    ...(task.acceptance === null ? [] : [`验收：${task.acceptance.status}（${task.acceptance.stopReason}）`]),
    ...task.delegations.filter((d) => 'structured' in d).map((d) => `${d.delegationId} 结构化结果：${JSON.stringify((d as { structured?: unknown }).structured)}`)
  ])
  return clip([
    ...(tasks.length > 0 ? tasks : ['本会话还没有任务卡']),
    `调用：原生后端 ${result.usage.nativeCalls} 次，Jev ${result.usage.jevCalls} 次`,
    ...(result.diagnostics.length > 0 ? [`宿主降级：${result.diagnostics.join('；')}`] : []),
    `账本：${result.ledgerPath}`
  ].join('\n'))
}

export const getAcceptText = (result: AcceptResultInfo): string =>
  clip([
    `验收结果：${result.status}`,
    ...(result.missing.length > 0 ? ['缺少：', ...result.missing.map((m) => `- ${m}`)] : []),
    `修复轮次：${result.roundsUsed}/${result.maxAutoFixRounds}`
  ].join('\n'))

/**
 * 生成 4 个模型工具定义
 * @param {SwarmService} service - 服务
 * @returns {ToolDefinitionLike[]} 工具定义
 */
export const getSwarmToolDefinitions = (service: SwarmService): ToolDefinitionLike[] => [
  getToolDefinition<unknown, TaskCardResult>({
    name: 'swarm_task_card',
    description: '建立或更新任务卡：记录目标、验收标准、范围、风险标志与性能预算，由规则与衡鉴（Jev）给出必需门禁和建议角色。每个任务先调用它。',
    parameters: TASK_CARD_PARAMETERS,
    execute: (args, exec) => service.AddTaskCard(args, getExec(exec)),
    render: (_args, value) => getTaskCardText(value)
  }),
  getToolDefinition<{ role?: unknown }, DelegationRecord>({
    name: 'swarm_delegate',
    description: '委派专家：把一项自包含的子任务交给指定中文角色，自动选择模型路由、限制工具权限并校验结构化交付。只读角色可在同一条消息里并行委派；编辑与执行类角色会串行执行。',
    parameters: DELEGATE_PARAMETERS,
    timeoutMs: DELEGATE_TIMEOUT_MS,
    isConcurrencySafe: (args) => isDelegableRoleId(args.role) && getRoleInfo(args.role).concurrencySafe,
    execute: (args, exec) => service.delegate(args, getExec(exec)),
    render: (_args, value) => getDelegationText(value)
  }),
  getToolDefinition<unknown, StatusResult>({
    name: 'swarm_status',
    description: '查询任务状态：门禁是否满足、各委派的状态/路由/证据、调用用量、宿主降级与账本位置。',
    parameters: STATUS_PARAMETERS,
    execute: async (args, exec) => service.getStatus(args, getExec(exec)),
    render: (_args, value) => getStatusText(value)
  }),
  getToolDefinition<unknown, AcceptResultInfo>({
    name: 'swarm_accept',
    description: '验收：accept 时逐项核对硬门槛证据，缺失则返回 blocked；reject 进入修复轮次（最多 2 轮）；incomplete 如实记录未完成。',
    parameters: ACCEPT_PARAMETERS,
    execute: async (args, exec) => service.AcceptTask(args, getExec(exec)),
    render: (_args, value) => getAcceptText(value)
  })
]

/**
 * 工具插件入口
 * @param {PluginContextLike} ctx - 预设作用域上下文
 */
export const apply = (ctx: PluginContextLike): void => {
  const service = ctx.get(SWARM_SERVICE) as SwarmService | undefined
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (service === undefined || tools === undefined) return
  for (const definition of getSwarmToolDefinitions(service)) ctx.effect(() => tools.register(definition))
}
````

````ts file=src/runtime.ts
import Schema from '@deepseek-ai/schemastery'
import {
  SWARM_SERVICE,
  type AgentLike,
  type CallConfigLike,
  type PluginContextLike,
  type RequestErrorActionLike,
  type RequestErrorPayloadLike
} from './host-contract.js'
import { ROLE_IDS, isRoleId } from './role-registry.js'
import type { SwarmService } from './service.js'
import { readLive } from './util/live.js'

/** 预设行：挂在全部 13 个预设上，在预设作用域内改写路由并处理回退 */
export const name = 'dsh-agent-swarm-runtime'
export const inject = [SWARM_SERVICE]

export const Config = Schema.object({
  role: Schema.union([...ROLE_IDS]).required().description('本预设对应的角色 ID')
})

/**
 * 运行时插件入口
 * @param {PluginContextLike} ctx - 预设作用域上下文
 * @param {unknown} config - `{ role }`
 */
export const apply = (ctx: PluginContextLike, config: unknown): void => {
  const service = ctx.get(SWARM_SERVICE) as SwarmService | undefined
  if (service === undefined) return
  const role = readLive<unknown>((config as { role?: unknown } | undefined)?.role)
  const presetRole = isRoleId(role) ? role : undefined
  ctx.on('agent/request', async (payload: { agent: AgentLike }, next: () => Promise<CallConfigLike>) =>
    service.routeState.getRequestOverride(payload.agent, await next(), presetRole))
  ctx.on('agent/request-error', async (payload: RequestErrorPayloadLike, next: () => Promise<RequestErrorActionLike>) =>
    service.routeState.getErrorAction(payload, await next(), presetRole, service.getConfig()))
  ctx.on('agent/disposed', (event: { agent?: AgentLike } | undefined) => {
    const id = event?.agent?.id
    if (id !== undefined) service.routeState.DelAgent(id)
  })
}
````

- [ ] **Step 4: 运行测试确认通过，并跑全量单测与覆盖率**

Run: `npx vitest run tests/unit/plugin.test.ts` 然后 `npm run typecheck` 然后 `npm run coverage`
Expected: 全部 PASS；覆盖率达到阈值（lines/functions/statements ≥ 80，branches ≥ 75）。未达标时为未覆盖分支补测试后重跑。

- [ ] **Step 5: 构建并提交**

Run: `npm run build`
Expected: 生成 `lib/index.js`、`lib/tools.js`、`lib/runtime.js`，无错误

```bash
git add src/index.ts src/tools.ts src/runtime.ts tests/unit/plugin.test.ts
git commit -m "feat: add host, tools and runtime plugin entries"
```

---

### Task 13: 预设构建器、生成脚本与 bundle 文件

**Files:**
- Create: `src/preset-builder.ts`, `scripts/yaml-js-tag.mjs`, `scripts/sandbox.mjs`, `scripts/gen-presets.mjs`, `cordis.patch.yml`, `locale/zh.json`, `locale/en.json`
- Generate: `presets/*.patch.yml`（13 个）、`tests/fixtures/standard-plugins.json`、`package.json` 的 `dsh.bundle.patch`
- Test: `tests/unit/presets.test.ts`

**Interfaces:**
- Consumes: `ROLE_INFO_LIST`、`getPresetPersona`、`getRoleInfo`、`RoleId`（Task 2）
- Produces:
  - `src/preset-builder.ts`：`PluginRow`、`PresetDeclarationInfo`、`PRESET_PACKAGE`、`SWARM_TOOLS_ROW`、`getRuntimeRow(role)`、`getStandardPlugins(patch)`、`getPresetPlugins(role, standard)`、`getPresetDescription(role)`、`getPresetDeclaration(role, standard)`、`getPresetPatch(role, standard)`、`getPresetFileName(role)`、`getBundlePatchList()`
  - `scripts/yaml-js-tag.mjs`：`JsExpr`、`JS_TAG`、`getJsRevived(value)`
  - `scripts/sandbox.mjs`：`REPO_ROOT`、`SANDBOX_ROOT`、`DRIVER_DIR`、`PROFILE`、`getTestedVersion()`、`getSandboxDshModules(version?)`、`ensureDsh(version?)`、`getHome(version?)`、`runDsh({ version?, args, env?, cwd?, timeout? })`、`runDshAsync(...)`、`ensureProfile(version?, { reset? })`

- [ ] **Step 1: 写 YAML 标签与沙箱脚本**

````js file=scripts/yaml-js-tag.mjs
/** YAML `!!js` 表达式标签：解析为 JsExpr，输出时写回 `!!js "<源码>"`，保证生成的预设保留 Loader 表达式 */
export class JsExpr {
  constructor(source) {
    this.source = source
  }

  toJSON() {
    return { $js: this.source }
  }
}

export const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  identify: (value) => value instanceof JsExpr,
  resolve: (source) => new JsExpr(source),
  stringify: (item) => JSON.stringify(item.value.source)
}

/**
 * 把 JSON 中的 `{ $js }` 还原为 JsExpr（fixture 与生成结果比对时使用）
 * @param {unknown} value - JSON 值
 * @returns {unknown} 还原后的值
 */
export const getJsRevived = (value) => {
  if (Array.isArray(value)) return value.map(getJsRevived)
  if (value === null || typeof value !== 'object') return value
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === '$js') return new JsExpr(value.$js)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, getJsRevived(item)]))
}
````

````js file=scripts/sandbox.mjs
#!/usr/bin/env node
/**
 * 沙箱：在 .sandbox/ 下安装指定版本的 DSH，使用独立 DSH_HOME，不触碰本机 ~/.dsh
 * 用法：node scripts/sandbox.mjs [--version <x>] [--reset]
 */
import { execSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SANDBOX_ROOT = join(REPO_ROOT, '.sandbox')
export const DRIVER_DIR = join(REPO_ROOT, 'tests', 'integration', 'driver')
export const PROFILE = 'swarmtest'

export const getTestedVersion = () =>
  process.env.SWARM_DSH_VERSION ?? JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).dsh.testedVersions[0]

const getDshDir = (version) => join(SANDBOX_ROOT, `dsh-${version}`)

export const getSandboxDshModules = (version = getTestedVersion()) => join(getDshDir(version), 'node_modules')

export const getHome = (version = getTestedVersion()) => join(SANDBOX_ROOT, `home-${version}`)

/**
 * 确保沙箱中安装了指定版本的 DSH，返回其 CLI 入口
 * @param {string} [version] - DSH 版本
 * @returns {string} bin.js 路径
 */
export const ensureDsh = (version = getTestedVersion()) => {
  const dir = getDshDir(version)
  const pkgFile = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const installed = existsSync(pkgFile) && JSON.parse(readFileSync(pkgFile, 'utf8')).version === version
  if (!installed) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-sandbox', private: true }))
    execSync(`npm install --no-audit --no-fund --ignore-scripts @deepseek-ai/dsh@${version}`, { cwd: dir, stdio: 'inherit' })
  }
  return join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

const getEnv = (version, env) => ({ ...process.env, DSH_HOME: getHome(version), DSH_TELEMETRY_DISABLED: '1', ...env })

/**
 * 同步运行沙箱 DSH
 * @param {{ version?: string, args: string[], env?: object, cwd?: string, timeout?: number }} options - 参数
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 结果
 */
export const runDsh = ({ version = getTestedVersion(), args, env = {}, cwd = REPO_ROOT, timeout = 180000 }) =>
  spawnSync(process.execPath, [ensureDsh(version), ...args], { cwd, env: getEnv(version, env), encoding: 'utf8', timeout })

/**
 * 异步运行沙箱 DSH（测试进程需要同时服务 HTTP mock 时使用）
 * @param {{ version?: string, args: string[], env?: object, cwd?: string, timeout?: number }} options - 参数
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>} 结果
 */
export const runDshAsync = ({ version = getTestedVersion(), args, env = {}, cwd = REPO_ROOT, timeout = 180000 }) =>
  new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [ensureDsh(version), ...args], { cwd, env: getEnv(version, env) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), timeout)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolvePromise({ status, stdout, stderr })
    })
  })

const getBundles = (profileDir) => {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? []
  } catch {
    return []
  }
}

/**
 * 确保测试 profile 已安装驱动 bundle 与本插件（顺序：先驱动后本插件，保证本插件的补丁覆盖驱动插入的注册表行）
 * @param {string} [version] - DSH 版本
 * @param {{ reset?: boolean }} [options] - reset 为 true 时重建 profile
 * @returns {{ home: string, profileDir: string, bin: string }} 路径
 */
export const ensureProfile = (version = getTestedVersion(), { reset = false } = {}) => {
  const home = getHome(version)
  const profileDir = join(home, 'profiles', PROFILE)
  if (reset) rmSync(profileDir, { recursive: true, force: true })
  const bundles = getBundles(profileDir)
  if (!bundles.includes('swarm-test-driver') || !bundles.includes('dsh-agent-swarm')) {
    for (const target of [DRIVER_DIR, REPO_ROOT]) {
      const result = runDsh({ version, args: ['plugin', '--profile', PROFILE, 'add', target], timeout: 600000 })
      if (result.status !== 0) throw new Error(`安装 ${target} 失败：\n${result.stdout}\n${result.stderr}`)
    }
  }
  return { home, profileDir, bin: ensureDsh(version) }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const versionIndex = argv.indexOf('--version')
  const version = versionIndex >= 0 ? argv[versionIndex + 1] : getTestedVersion()
  const paths = ensureProfile(version, { reset: argv.includes('--reset') })
  console.log(JSON.stringify({ version, ...paths }, null, 2))
}
````

- [ ] **Step 2: 写失败的测试**

````ts file=tests/unit/presets.test.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { JS_TAG, getJsRevived } from '../../scripts/yaml-js-tag.mjs'
import {
  getBundlePatchList,
  getPresetDeclaration,
  getPresetFileName,
  getPresetPatch,
  getPresetPlugins,
  getStandardPlugins,
  type PluginRow
} from '../../src/preset-builder.js'
import { ROLE_INFO_LIST, getPresetPersona } from '../../src/role-registry.js'

const ROOT = join(import.meta.dirname, '..', '..')
const standard = getJsRevived(JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'standard-plugins.json'), 'utf8'))) as PluginRow[]
const ids = (rows: PluginRow[]) => rows.map((row) => row.id)

describe('预设构建器', () => {
  it('从 standard 补丁中取出 plugins，找不到时报错', () => {
    expect(getStandardPlugins([{ insert: [{ id: 'preset-standard', config: { plugins: standard } }] }])).toBe(standard)
    expect(() => getStandardPlugins([{ insert: [] }])).toThrow('preset-standard')
    expect(() => getStandardPlugins(null)).toThrow('preset-standard')
  })

  it('天枢：替换 persona，去掉通用委派组，追加 swarm 工具行与运行时行', () => {
    const rows = getPresetPlugins('tian_shu', standard)
    const persona = rows.find((row) => row.id === 'persona') as PluginRow
    expect((persona.config as { prefix: string }).prefix).toBe(getPresetPersona('tian_shu'))
    expect((persona.config as { suffix?: string }).suffix).toContain('{{cwd}}')
    expect(ids(rows)).not.toContain('delegation')
    expect(ids(rows)).toEqual(expect.arrayContaining(['tool-pwsh', 'tool-web', 'tool-plugin-manager', 'swarm-tools', 'swarm-runtime']))
    expect(rows.at(-1)).toEqual({ id: 'swarm-runtime', name: 'dsh-agent-swarm/runtime', config: { role: 'tian_shu' } })
  })

  it('御史：无 shell、无 web、无 swarm 工具', () => {
    const rows = ids(getPresetPlugins('yu_shi', standard))
    for (const id of ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-web', 'swarm-tools', 'tool-plugin-manager', 'delegation']) expect(rows).not.toContain(id)
    expect(rows).toEqual(expect.arrayContaining(['persona', 'tool-fs', 'tool-fs-search', 'swarm-runtime']))
  })

  it('博闻有 web；复核有 shell 无 web；未知的新行原样保留', () => {
    expect(ids(getPresetPlugins('bo_wen', standard))).toContain('tool-web')
    const fuHe = ids(getPresetPlugins('fu_he', standard))
    expect(fuHe).toContain('tool-pwsh')
    expect(fuHe).not.toContain('tool-web')
    expect(ids(getPresetPlugins('yu_shi', [...standard, { id: 'future-row', name: 'future' }]))).toContain('future-row')
  })

  it('声明与文件名', () => {
    const declaration = getPresetDeclaration('guan_xiang', standard)
    expect(declaration).toMatchObject({ id: 'guan-xiang', name: '观象' })
    expect(declaration.description).toContain('图片')
    expect(getPresetDeclaration('tian_shu', standard).order).toBe(0)
    const patch = getPresetPatch('fu_he', standard) as Array<{ insert: Array<{ id: string; name: string }> }>
    expect(patch[0]?.insert[0]).toMatchObject({ id: 'preset-fu-he', name: '@deepseek-ai/dsh-agent-preset' })
    expect(getPresetFileName('fu_he')).toBe('presets/fu-he.patch.yml')
    expect(getBundlePatchList()).toHaveLength(14)
    expect(getBundlePatchList()[0]).toBe('./cordis.patch.yml')
  })
})

describe('已提交的 bundle 文件与生成器一致', () => {
  for (const role of ROLE_INFO_LIST) {
    it(`presets/${role.presetId}.patch.yml`, () => {
      const committed = YAML.parse(readFileSync(join(ROOT, getPresetFileName(role.id)), 'utf8'), { customTags: [JS_TAG] })
      expect(JSON.parse(JSON.stringify(committed))).toEqual(JSON.parse(JSON.stringify(getPresetPatch(role.id, standard))))
    })
  }

  it('package.json 的 dsh.bundle.patch 列出宿主补丁与 13 个预设', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.dsh.bundle.patch).toEqual(getBundlePatchList())
  })

  it('宿主补丁插入 swarm-core、4 个可选原生实例，并把默认预设设为天枢', () => {
    const host = YAML.parse(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'), { customTags: [JS_TAG] }) as Array<Record<string, unknown>>
    const inserted = (host[0]?.insert ?? []) as Array<{ id: string; name: string; config?: { providerName?: string; permissionMode?: string } }>
    expect(inserted.map((row) => row.id)).toEqual(['swarm-core', 'swarm-codex', 'swarm-codex-edit', 'swarm-claude-plan', 'swarm-claude-edit'])
    expect(inserted.slice(1).map((row) => row.config?.permissionMode)).toEqual(['never', 'approve-for-me', 'plan', 'acceptEdits'])
    expect(host[1]).toEqual({ id: 'agent-preset-registry', config: { default: 'tian-shu' } })
  })
})
````

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/unit/presets.test.ts`
Expected: FAIL，模块 `src/preset-builder.js` 不存在

- [ ] **Step 4: 写构建器、生成脚本、宿主补丁与 locale**

````ts file=src/preset-builder.ts
import { ROLE_INFO_LIST, getPresetPersona, getRoleInfo, type RoleId } from './role-registry.js'

/** Cordis 插件行；未识别的字段原样透传 */
export interface PluginRow {
  id?: string
  name: string
  config?: unknown
  disabled?: unknown
  [key: string]: unknown
}

/** 预设声明（@deepseek-ai/dsh-agent-preset 的 config） */
export interface PresetDeclarationInfo {
  id: string
  name: string
  description: string
  order: number
  plugins: PluginRow[]
}

export const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset'
export const SWARM_TOOLS_ROW: PluginRow = { id: 'swarm-tools', name: 'dsh-agent-swarm/tools' }

/** 委派统一走 swarm_delegate，通用委派组在全部 swarm 预设中移除；swarm 行由构建器自己追加 */
const DROPPED_ROWS = new Set(['delegation', 'swarm-tools', 'swarm-runtime'])
const SHELL_ROWS = new Set(['tool-bash', 'tool-pwsh', 'tool-jobs'])
const TIAN_SHU_ONLY_ROWS = new Set(['tool-plugin-manager'])
const ROLE_ORDER_BASE = 20

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const getRuntimeRow = (role: RoleId): PluginRow => ({ id: 'swarm-runtime', name: 'dsh-agent-swarm/runtime', config: { role } })

/**
 * 从 web-app 的 standard.patch.yml 解析结果中取出 preset-standard 的 plugins
 * @param {unknown} patch - YAML 解析结果
 * @returns {PluginRow[]} standard 预设的插件行
 */
export const getStandardPlugins = (patch: unknown): PluginRow[] => {
  const layers = Array.isArray(patch) ? patch : []
  for (const layer of layers) {
    const rows = isObject(layer) && Array.isArray(layer.insert) ? (layer.insert as unknown[]) : []
    const row = rows.find((item) => isObject(item) && item.id === 'preset-standard')
    const plugins = isObject(row) && isObject(row.config) ? row.config.plugins : undefined
    if (Array.isArray(plugins)) return plugins as PluginRow[]
  }
  throw new Error('standard.patch.yml 中找不到 preset-standard 的 plugins 列表')
}

/**
 * 以 standard 为底生成角色预设的插件行：替换 persona，按权限裁剪 shell/web，追加 swarm 行
 * 未识别的行原样保留，便于跟随 DSH 升级
 * @param {RoleId} role - 角色
 * @param {readonly PluginRow[]} standard - standard 预设插件行
 * @returns {PluginRow[]} 插件行
 */
export const getPresetPlugins = (role: RoleId, standard: readonly PluginRow[]): PluginRow[] => {
  const info = getRoleInfo(role)
  const keep = (row: PluginRow): PluginRow[] => {
    const id = row.id ?? ''
    if (DROPPED_ROWS.has(id)) return []
    if (id === 'persona') return [{ ...row, config: { ...(isObject(row.config) ? row.config : {}), prefix: getPresetPersona(role) } }]
    if (TIAN_SHU_ONLY_ROWS.has(id)) return role === 'tian_shu' ? [row] : []
    if (SHELL_ROWS.has(id)) return info.capabilities.includes('shell') ? [row] : []
    if (id === 'tool-web') return info.web === 'never' ? [] : [row]
    return [row]
  }
  return [...standard.flatMap(keep), ...(role === 'tian_shu' ? [SWARM_TOOLS_ROW] : []), getRuntimeRow(role)]
}

export const getPresetDescription = (role: RoleId): string => {
  const info = getRoleInfo(role)
  if (role === 'tian_shu') return `dsh-agent-swarm 主持者：${info.duty}按需委派 12 位中文专家，并以证据验收。`
  const base = `${info.title}：${info.duty}`
  return info.needsVision ? `${base}（需要支持图片输入的模型）` : base
}

export const getPresetDeclaration = (role: RoleId, standard: readonly PluginRow[]): PresetDeclarationInfo => {
  const info = getRoleInfo(role)
  return {
    id: info.presetId,
    name: info.name,
    description: getPresetDescription(role),
    order: role === 'tian_shu' ? 0 : ROLE_ORDER_BASE + info.order,
    plugins: getPresetPlugins(role, standard)
  }
}

/**
 * 单个预设的 bundle 补丁内容
 * @param {RoleId} role - 角色
 * @param {readonly PluginRow[]} standard - standard 预设插件行
 * @returns {unknown[]} 补丁（YAML 顶层数组）
 */
export const getPresetPatch = (role: RoleId, standard: readonly PluginRow[]): unknown[] => [
  { insert: [{ id: `preset-${getRoleInfo(role).presetId}`, name: PRESET_PACKAGE, config: getPresetDeclaration(role, standard) }] }
]

export const getPresetFileName = (role: RoleId): string => `presets/${getRoleInfo(role).presetId}.patch.yml`

export const getBundlePatchList = (): string[] => ['./cordis.patch.yml', ...ROLE_INFO_LIST.map((role) => `./${getPresetFileName(role.id)}`)]
````

````js file=scripts/gen-presets.mjs
#!/usr/bin/env node
/**
 * 生成 presets/*.patch.yml：以指定 DSH 版本 web-app 的 standard 预设为底，叠加 swarm 角色配置
 * 用法：npm run build && node scripts/gen-presets.mjs [--dsh <node_modules 目录>] [--write-fixture]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import YAML from 'yaml'
import { REPO_ROOT, ensureDsh, getSandboxDshModules } from './sandbox.mjs'
import { JS_TAG } from './yaml-js-tag.mjs'

const HEADER = '# 由 scripts/gen-presets.mjs 生成，请勿手改；修改角色请编辑 src/role-registry.ts 或 src/preset-builder.ts 后重新生成\n'

const getArgs = (argv) => ({
  dsh: argv.includes('--dsh') ? argv[argv.indexOf('--dsh') + 1] : undefined,
  writeFixture: argv.includes('--write-fixture')
})

const main = async () => {
  const args = getArgs(process.argv.slice(2))
  if (args.dsh === undefined) ensureDsh()
  const modulesDir = args.dsh ?? getSandboxDshModules()
  const standardFile = join(modulesDir, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  if (!existsSync(standardFile)) throw new Error(`找不到 ${standardFile}`)
  const load = (file) => import(pathToFileURL(join(REPO_ROOT, 'lib', file)).href)
  const { getStandardPlugins, getPresetPatch, getPresetFileName, getBundlePatchList } = await load('preset-builder.js')
  const { ROLE_INFO_LIST } = await load('role-registry.js')
  const standard = getStandardPlugins(YAML.parse(readFileSync(standardFile, 'utf8'), { customTags: [JS_TAG] }))
  const presetsDir = join(REPO_ROOT, 'presets')
  mkdirSync(presetsDir, { recursive: true })
  for (const file of readdirSync(presetsDir)) {
    if (file.endsWith('.patch.yml')) rmSync(join(presetsDir, file))
  }
  for (const role of ROLE_INFO_LIST) {
    const text = YAML.stringify(getPresetPatch(role.id, standard), { customTags: [JS_TAG], lineWidth: 0 })
    writeFileSync(join(REPO_ROOT, getPresetFileName(role.id)), HEADER + text, 'utf8')
  }
  const pkgFile = join(REPO_ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const next = { ...pkg, dsh: { ...pkg.dsh, bundle: { ...(pkg.dsh?.bundle ?? {}), patch: getBundlePatchList() } } }
  writeFileSync(pkgFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  if (args.writeFixture) {
    writeFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'standard-plugins.json'), `${JSON.stringify(standard, null, 2)}\n`, 'utf8')
  }
  console.log(`已生成 ${ROLE_INFO_LIST.length} 个预设（standard 来源：${standardFile}）`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
````

````yaml file=cordis.patch.yml
# dsh-agent-swarm 宿主层补丁（bundle 第一层）
# - swarm-core：提供 agentSwarm 服务（路由、策略、Jev、账本、写操作守卫），不向模型注册工具
# - swarm-codex / swarm-codex-edit / swarm-claude-plan / swarm-claude-edit：原生 Codex 与 Claude Code 的命名实例，
#   只在对应官方 bundle 已装入本 profile 时启用（按 profileContext.startedBundles 判断），否则保持禁用
# - agent-preset-registry：把默认预设改为天枢；用户在设置里选择的默认值仍然优先
# 13 个角色预设声明见 presets/*.patch.yml（由 scripts/gen-presets.mjs 生成）

- insert:
    - id: swarm-core
      name: dsh-agent-swarm

    - id: swarm-codex
      name: '@deepseek-ai/dsh-subagent-codex'
      disabled: !!js "!ctx.get('profileContext')?.startedBundles?.includes('@deepseek-ai/dsh-subagent-codex')"
      config:
        providerName: swarm-codex
        permissionMode: never

    - id: swarm-codex-edit
      name: '@deepseek-ai/dsh-subagent-codex'
      disabled: !!js "!ctx.get('profileContext')?.startedBundles?.includes('@deepseek-ai/dsh-subagent-codex')"
      config:
        providerName: swarm-codex-edit
        permissionMode: approve-for-me

    - id: swarm-claude-plan
      name: '@deepseek-ai/dsh-subagent-claude-code'
      disabled: !!js "!ctx.get('profileContext')?.startedBundles?.includes('@deepseek-ai/dsh-subagent-claude-code')"
      config:
        providerName: swarm-claude-plan
        permissionMode: plan

    - id: swarm-claude-edit
      name: '@deepseek-ai/dsh-subagent-claude-code'
      disabled: !!js "!ctx.get('profileContext')?.startedBundles?.includes('@deepseek-ai/dsh-subagent-claude-code')"
      config:
        providerName: swarm-claude-edit
        permissionMode: acceptEdits

- id: agent-preset-registry
  config:
    default: tian-shu
````

````json file=locale/zh.json
{
  "meta": {
    "title": "Agent Swarm 中文多智能体",
    "description": "天枢主持 13 个中文角色：衡鉴分流、统一委派、证据门禁、qwen 优先的模型路由与自动回退。"
  }
}
````

````json file=locale/en.json
{
  "meta": {
    "title": "Agent Swarm (Chinese multi-agent)",
    "description": "Tian Shu orchestrates 13 Chinese-named roles with rule + Jev triage, unified delegation, evidence gates and qwen-first model routing with fallback."
  }
}
````

- [ ] **Step 5: 构建并生成预设与 fixture**

Run: `npm run build` 然后 `node scripts/gen-presets.mjs --write-fixture`
Expected: 首次运行会在 `.sandbox/dsh-0.1.7-alpha.2/` 安装 DSH（约 1 分钟）；输出「已生成 13 个预设」；`presets/` 下出现 13 个文件；`package.json` 出现 `dsh.bundle.patch`（14 项）；`tests/fixtures/standard-plugins.json` 生成。打开 `presets/tian-shu.patch.yml`，确认 `disabled: !!js "process.platform === 'win32'"` 形式保留、persona 为中文。

- [ ] **Step 6: 运行测试确认通过；生成器幂等**

Run: `npx vitest run tests/unit/presets.test.ts` 然后再跑一次 `node scripts/gen-presets.mjs` 并执行 `git status --short presets package.json`
Expected: 测试 PASS；第二次生成后 `presets/` 与 `package.json` 相对第一次无变化

- [ ] **Step 7: 提交**

```bash
git add src/preset-builder.ts scripts cordis.patch.yml locale presets package.json tests/unit/presets.test.ts tests/fixtures/standard-plugins.json
git commit -m "feat: generate 13 role presets from DSH standard preset and add host bundle patch"
```

---

### Task 14: 沙箱集成测试（真实 DSH 0.1.7-alpha.2 + mock LLM）

**Files:**
- Create: `tests/integration/driver/package.json`, `tests/integration/driver/cordis.patch.yml`, `tests/integration/driver/host.js`, `tests/integration/driver/scenarios.js`
- Create: `tests/integration/helpers.ts`, `tests/integration/bundle.test.ts`, `tests/integration/flows.test.ts`
- Modify: `package.json`（`test:integration` 脚本先构建）

**Interfaces:**
- Consumes: `scripts/sandbox.mjs`（Task 13）、已构建的 `lib/`、`tests/fixtures/valid-outputs.json`
- Produces: `runScenario(name, overlay, options?)` → `ScenarioRunInfo { status; results; children; rootTools; taskId; sessionId; failQuotaHits; subagentProviders; ledgerEvents; workspace }`、`getRoutesOverlay(overrides)`

驱动 bundle 模拟 web 的组合：插入预设注册表行，并禁用宿主上的工具行，使工具全部由预设作用域注册。mock LLM 路由名为 `swarm-mock`，模型名约定如下：

- `root`：主会话，按场景脚本调用工具；
- `role-<id>`：该角色正常交付；
- `writer-<id>`：先调用 `write` 写入 `hello.txt`，再交付；
- `textonly-<id>`：不支持图片的模型；
- `fail-quota`：返回 QUOTA 失败。

- [ ] **Step 1: 写驱动 bundle**

````json file=tests/integration/driver/package.json
{
  "name": "swarm-test-driver",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./host.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
````

````yaml file=tests/integration/driver/cordis.patch.yml
# 集成测试驱动 bundle（只用于 .sandbox）：
# 1. 插入预设注册表（web-app 才有，这里模拟；dsh-agent-swarm 的补丁随后把默认值改为 tian-shu）
# 2. 插入驱动行：注册 mock LLM 并按 SWARM_SCENARIO 驱动一个预设会话
# 3. 禁用宿主工具行，模拟 web 组合下工具全部由预设作用域注册
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
    - id: swarm-test-driver
      name: swarm-test-driver

- id: tool-bash
  disabled: true
- id: tool-pwsh
  disabled: true
- id: tool-jobs
  disabled: true
- id: tool-fs
  disabled: true
- id: tool-fs-search
  disabled: true
- id: skill-filesystem
  disabled: true
- id: tool-skill
  disabled: true
- id: command-goal
  disabled: true
- id: tool-goal
  disabled: true
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
- id: workflow-ptc
  disabled: true
- id: tool-workflow
  disabled: true
- id: tool-todo
  disabled: true
- id: tool-web
  disabled: true
````

````js file=tests/integration/driver/scenarios.js
/** 集成测试场景：root 为主会话每一步的动作（tool+args / write / text），$TASK 替换为任务卡返回的 task_id */
const card = (flags, extra = {}) => ({
  tool: 'swarm_task_card',
  args: { title: '集成测试任务', goal: '验证 dsh-agent-swarm', acceptance: ['门禁满足'], scope: ['hello.txt'], flags, ...extra }
})
const delegate = (args) => ({ tool: 'swarm_delegate', args: { task_id: '$TASK', ...args } })
const accept = (stopReason) => ({ tool: 'swarm_accept', args: { task_id: '$TASK', decision: 'accept', summary: '申请验收', stopReason } })

export const SCENARIOS = {
  'gate-flow': {
    preset: 'tian-shu',
    root: [
      card({ changesCode: true }),
      delegate({ role: 'ji_feng', prompt: '创建 hello.txt' }),
      accept('尝试在复核前验收'),
      delegate({ role: 'fu_he', prompt: '确认 hello.txt 内容', gate: 'G_VERIFY' }),
      accept('门禁满足'),
      { tool: 'swarm_status', args: { task_id: '$TASK', verbose: true } },
      { text: 'DONE' }
    ]
  },
  'vision-blocked': {
    preset: 'tian-shu',
    root: [card({ hasVisualInput: true }), delegate({ role: 'guan_xiang', prompt: '描述截图', image_paths: ['shot.png'] }), { text: 'DONE' }]
  },
  'vision-ok': {
    preset: 'tian-shu',
    root: [
      card({ hasVisualInput: true }),
      delegate({ role: 'guan_xiang', prompt: '描述截图', image_paths: ['shot.png'] }),
      delegate({ role: 'guan_xiang', prompt: '越界路径', image_paths: ['../escape.png'] }),
      { text: 'DONE' }
    ]
  },
  'readonly-guard': {
    preset: 'yu-shi',
    root: [{ tool: 'write', write: { path: 'guard.txt', content: 'should be denied\n' } }, { text: 'DONE' }]
  },
  'native-fallback': {
    preset: 'tian-shu',
    root: [card({ changesCode: true }), delegate({ role: 'tan_wei', prompt: '定位入口', backend: 'codex' }), { text: 'DONE' }]
  },
  'jev-triage': { preset: 'tian-shu', root: [card({ changesCode: true }), { text: 'DONE' }] },
  'jev-fallback': { preset: 'tian-shu', root: [card({ changesCode: true, changesAlgorithm: true }), { text: 'DONE' }] },
  'root-fallback': { preset: 'tian-shu', root: [card({ uiCopy: true }), { text: 'DONE' }] }
}
````

````js file=tests/integration/driver/host.js
// 集成测试驱动（只用于 .sandbox）：注册 mock LLM「swarm-mock」，在指定预设中创建会话并按场景脚本驱动，结果写入 SWARM_DRIVER_OUT
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { SCENARIOS } from './scenarios.js'

export const name = 'swarm-test-driver'
export const inject = ['llm', 'agents', 'agentPresets', 'subagents']

const VALID_OUTPUTS = JSON.parse(readFileSync(new URL('../../fixtures/valid-outputs.json', import.meta.url), 'utf8'))

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolChunks(name, args) {
  const id = `call_${randomUUID().slice(0, 8)}`
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

const getText = (message) => (message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')

const getWriteArgs = (options, path, content) => {
  const schema = (options.tools ?? []).find((tool) => tool.name === 'write')
  const keys = Object.keys(schema?.parameters?.properties ?? {})
  const pathKey = keys.find((key) => /path|file/i.test(key)) ?? 'path'
  const contentKey = keys.find((key) => /content|text|data/i.test(key)) ?? 'content'
  return { [pathKey]: path, [contentKey]: content }
}

const getResolvedArgs = (value, state) => {
  if (typeof value === 'string') return value.replace('$TASK', state.taskId ?? 'T-1')
  if (Array.isArray(value)) return value.map((item) => getResolvedArgs(item, state))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, getResolvedArgs(item, state)]))
  return value
}

const getModelRole = (model) => /^(?:role|writer|textonly)-([a-z_]+?)(?:-verify)?$/.exec(model)?.[1]

class MockAdapter {
  constructor(scenario, state) {
    this.scenario = scenario
    this.state = state
    this.rootStep = 0
    this.childSteps = new Map()
  }

  providerInfo(provider) { return { id: provider, name: 'Swarm Mock' } }
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }
  async listModels(provider) { return [] }

  async resolveModel(provider, model) {
    const vision = !model.startsWith('textonly')
    return { provider, id: model, name: model, inputModalities: vision ? ['text', 'image'] : ['text'], context: { contextWindow: 200000 } }
  }

  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) }
  }

  async *stream(options) {
    if (options.purpose !== undefined) {
      yield* textChunks('Swarm test')
      return
    }
    if (options.model === 'fail-quota') {
      this.state.failQuotaHits += 1
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'mock quota exhausted', status: 429 } } }
      return
    }
    const role = getModelRole(options.model)
    if (role === undefined) yield* this.streamRoot(options)
    else yield* this.streamChild(options, role)
  }

  *streamRoot(options) {
    const last = options.messages?.at(-1)
    if (this.rootStep === 0) this.state.rootTools = (options.tools ?? []).map((tool) => tool.name)
    if (last?.role === 'tool') {
      const text = getText(last)
      this.state.results.push({ step: this.rootStep - 1, isError: last.isError === true, text })
      const match = /task_id: (T-\d+)/.exec(text)
      if (match !== null && this.state.taskId === undefined) this.state.taskId = match[1]
    }
    const action = this.scenario.root[this.rootStep++]
    if (action === undefined || action.text !== undefined) {
      yield* textChunks(action?.text ?? 'DONE')
      return
    }
    const args = action.write === undefined ? getResolvedArgs(action.args, this.state) : getWriteArgs(options, action.write.path, action.write.content)
    yield* toolChunks(action.tool, args)
  }

  *streamChild(options, role) {
    const key = String(options.sessionId)
    const step = this.childSteps.get(key) ?? 0
    this.childSteps.set(key, step + 1)
    const tools = (options.tools ?? []).map((tool) => tool.name)
    if (step === 0) {
      this.state.children.push({ role, model: options.model, tools, images: JSON.stringify(options.messages ?? []).includes('"type":"image"') })
    }
    if (options.model.startsWith('writer') && step === 0) {
      yield* toolChunks('write', getWriteArgs(options, 'hello.txt', 'hello swarm\n'))
      return
    }
    if (tools.includes('structured_output') && step <= 1) {
      const output = options.model.endsWith('-verify') ? { ...VALID_OUTPUTS[role], mode: 'verify' } : VALID_OUTPUTS[role]
      yield* toolChunks('structured_output', output)
      return
    }
    yield* textChunks('CHILD DONE')
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const apply = (ctx) => {
  const scenarioName = process.env.SWARM_SCENARIO
  if (scenarioName === undefined || scenarioName === '') return
  const out = process.env.SWARM_DRIVER_OUT
  const state = { scenario: scenarioName, results: [], children: [], rootTools: [], failQuotaHits: 0 }
  let finished = false
  const finish = (status, extra = {}) => {
    if (finished) return
    finished = true
    if (out) writeFileSync(out, JSON.stringify({ status, ...state, ...extra }, null, 2))
    setTimeout(() => process.exit(status === 'done' ? 0 : 1), 100)
  }
  const scenario = SCENARIOS[scenarioName]
  if (scenario === undefined) {
    finish('unknown-scenario')
    return
  }
  ctx.llm.registerAdapter(['swarm-mock'], new MockAdapter(scenario, state))
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await ctx.agentPresets.resolve(scenario.preset)
        break
      } catch (error) {
        if (attempt > 75) throw error
        await sleep(200)
      }
    }
    const sessionId = `swarm-it-${randomUUID()}`
    const scope = await ctx.agentPresets.acquireScope(scenario.preset)
    try {
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd(), agentPreset: scenario.preset },
        agentOptions: { provider: 'swarm-mock', model: process.env.SWARM_ROOT_MODEL ?? 'root' },
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, scenario.preset) }
      })
      state.sessionId = sessionId
      state.subagentProviders = ctx.subagents.list()
      handle.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'integration test' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      finish('done')
    } finally {
      await scope?.[Symbol.asyncDispose]?.()
    }
  }
  setTimeout(() => { run().catch((error) => finish('error', { error: String(error?.stack ?? error) })) }, 300)
  setTimeout(() => finish('timeout'), 150000)
}
````

- [ ] **Step 2: 写测试辅助与集成测试**

````ts file=tests/integration/helpers.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { PROFILE, SANDBOX_ROOT, ensureProfile, runDshAsync } from '../../scripts/sandbox.mjs'

/** 1×1 透明 PNG */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const ROUTE_KEYS = ['tian_shu', 'mou_ding', 'shu_ji', 'suan_heng:research', 'suan_heng:verify', 'tan_wei', 'bo_wen', 'guan_xiang', 'zhu_jian', 'xing_zhou', 'ji_feng', 'yu_shi', 'fu_he', 'miao_bi']

const getDefaultModel = (key: string): string =>
  key === 'tian_shu' ? 'root' : key === 'suan_heng:verify' ? 'role-suan_heng-verify' : `role-${key.replace(':research', '')}`

/**
 * 生成 swarm-core 的路由覆盖：全部指向 swarm-mock，可按角色替换模型链
 * @param {Record<string, string[]>} overrides - 路由键 → 模型名列表
 * @returns {Record<string, { chain: Array<{ provider: string; model: string }> }>} routes 配置
 */
export const getRoutesOverlay = (overrides: Record<string, string[]> = {}) =>
  Object.fromEntries(ROUTE_KEYS.map((key) => [key, { chain: (overrides[key] ?? [getDefaultModel(key)]).map((model) => ({ provider: 'swarm-mock', model })) }]))

export interface ScenarioRunInfo {
  status: string
  error?: string
  results: Array<{ step: number; isError: boolean; text: string }>
  children: Array<{ role: string; model: string; tools: string[]; images: boolean }>
  rootTools: string[]
  taskId?: string
  sessionId?: string
  failQuotaHits: number
  subagentProviders?: string[]
  ledgerEvents: Array<{ type: string; data: Record<string, unknown> }>
  workspace: string
  stdout: string
  stderr: string
}

const git = (cwd: string, args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=swarm-test', '-c', 'user.email=swarm@test.local', ...args], { cwd, stdio: 'ignore' })
}

/**
 * 在沙箱中运行一个场景：准备 git 工作区与覆盖补丁，启动 DSH，读取驱动输出与账本
 * @param {string} scenario - 场景名（tests/integration/driver/scenarios.js）
 * @param {Record<string, unknown>} coreConfig - swarm-core 行的 config
 * @param {{ env?: Record<string, string>; files?: Record<string, string | Buffer> }} [options] - 环境变量与工作区文件
 * @returns {Promise<ScenarioRunInfo>} 运行结果
 */
export const runScenario = async (
  scenario: string,
  coreConfig: Record<string, unknown>,
  options: { env?: Record<string, string>; files?: Record<string, string | Buffer> } = {}
): Promise<ScenarioRunInfo> => {
  const { home } = ensureProfile()
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  const workspace = mkdtempSync(join(SANDBOX_ROOT, `ws-${scenario}-`))
  writeFileSync(join(workspace, 'README.md'), '# sandbox workspace\n')
  for (const [file, content] of Object.entries(options.files ?? {})) writeFileSync(join(workspace, file), content)
  git(workspace, ['init', '-q'])
  git(workspace, ['add', '-A'])
  git(workspace, ['commit', '-q', '-m', 'init'])
  const overlay = `${workspace}.overlay.yml`
  writeFileSync(overlay, YAML.stringify([{ id: 'swarm-core', config: coreConfig }]))
  const out = `${workspace}.out.json`
  const result = await runDshAsync({
    args: ['--profile', PROFILE, '--patch', overlay],
    cwd: workspace,
    env: { SWARM_SCENARIO: scenario, SWARM_DRIVER_OUT: out, ...options.env },
    timeout: 170000
  })
  if (!existsSync(out)) throw new Error(`场景 ${scenario} 没有输出。\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  const data = JSON.parse(readFileSync(out, 'utf8')) as Omit<ScenarioRunInfo, 'ledgerEvents' | 'workspace' | 'stdout' | 'stderr'>
  const ledgerFile = join(home, 'share', 'dsh-agent-swarm', 'ledger', `${data.sessionId ?? 'none'}.jsonl`)
  const ledgerEvents = existsSync(ledgerFile)
    ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
    : []
  return { ...data, ledgerEvents, workspace, stdout: result.stdout, stderr: result.stderr }
}
````

````ts file=tests/integration/bundle.test.ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { PROFILE, REPO_ROOT, ensureProfile, runDsh } from '../../scripts/sandbox.mjs'

const PRESET_IDS = ['tian-shu', 'mou-ding', 'shu-ji', 'suan-heng', 'tan-wei', 'bo-wen', 'guan-xiang', 'zhu-jian', 'xing-zhou', 'ji-feng', 'yu-shi', 'fu-he', 'miao-bi']

beforeAll(() => {
  if (!existsSync(join(REPO_ROOT, 'lib', 'index.js'))) throw new Error('请先运行 npm run build')
  ensureProfile(undefined, { reset: true })
})

describe('bundle 在真实 DSH 中组合', () => {
  it('--dump-config 可见 swarm-core、原生实例、13 个预设与默认值 tian-shu', () => {
    const result = runDsh({ args: ['--profile', PROFILE, '--dump-config'] })
    expect(result.status, result.stderr).toBe(0)
    const text = result.stdout
    expect(text).toContain('swarm-core')
    expect(text).toContain('swarm-claude-plan')
    for (const id of PRESET_IDS) expect(text).toContain(`preset-${id}`)
    expect(text).toMatch(/default:\s*tian-shu/)
  })
})
````

````ts file=tests/integration/flows.test.ts
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PNG_1X1, getRoutesOverlay, runScenario } from './helpers.js'
import { REPO_ROOT, ensureProfile } from '../../scripts/sandbox.mjs'

const JEV_OFF = { jev: { enabled: false } }

beforeAll(() => {
  if (!existsSync(join(REPO_ROOT, 'lib', 'index.js'))) throw new Error('请先运行 npm run build')
  ensureProfile()
})

describe('委派、门禁与回退', () => {
  it('gate-flow：疾风改文件 → 验收被拦 → 复核（首路由 QUOTA 回退）→ 验收通过', async () => {
    const run = await runScenario('gate-flow', { ...JEV_OFF, routes: getRoutesOverlay({ ji_feng: ['writer-ji_feng'], fu_he: ['fail-quota', 'role-fu_he'] }) })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    const [card, edit, blocked, verify, accepted, status] = run.results
    expect(card?.text).toContain('task_id: T-1')
    expect(card?.text).toContain('G_VERIFY')
    expect(edit?.text).toContain('【疾风】completed')
    expect(edit?.text).toContain('hello.txt')
    expect(blocked?.text).toContain('验收结果：blocked')
    expect(verify?.text).toContain('【复核】completed')
    expect(verify?.text).toContain('回退 swarm-mock/fail-quota')
    expect(accepted?.text).toContain('验收结果：accepted')
    expect(status?.text).toContain('✓ G_VERIFY')
    expect(run.failQuotaHits).toBeGreaterThanOrEqual(1)
    expect(readFileSync(join(run.workspace, 'hello.txt'), 'utf8')).toBe('hello swarm\n')
    expect(run.rootTools).toEqual(expect.arrayContaining(['swarm_task_card', 'swarm_delegate', 'swarm_status', 'swarm_accept']))
    expect(run.rootTools).not.toContain('subagent')
    expect(run.rootTools).not.toContain('workflow')
    const jiFeng = run.children.find((c) => c.role === 'ji_feng')
    const fuHe = run.children.find((c) => c.role === 'fu_he')
    expect(jiFeng?.tools).toContain('write')
    expect(jiFeng?.tools).not.toContain('swarm_delegate')
    expect(fuHe?.tools).toContain('read')
    expect(fuHe?.tools).not.toContain('write')
    expect(fuHe?.tools).not.toContain('edit')
    const types = run.ledgerEvents.map((e) => e.type)
    expect(types.filter((t) => t === 'delegation/completed')).toHaveLength(2)
    expect(types).toContain('route/fallback')
    expect(types.filter((t) => t === 'accept/decision')).toHaveLength(2)
  })

  it('native-fallback：未安装原生 Codex 时退回 spawn 并记录原因', async () => {
    const run = await runScenario('native-fallback', { ...JEV_OFF, routes: getRoutesOverlay() })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[1]?.text).toContain('native-unavailable')
    expect(run.results[1]?.text).toContain('【探微】completed')
    expect(run.subagentProviders).not.toContain('swarm-codex')
  })

  it('root-fallback：主会话模型 QUOTA 后按天枢链回退', async () => {
    const run = await runScenario('root-fallback', { ...JEV_OFF, routes: getRoutesOverlay() }, { env: { SWARM_ROOT_MODEL: 'fail-quota' } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.failQuotaHits).toBeGreaterThanOrEqual(1)
    expect(run.results[0]?.text).toContain('task_id: T-1')
    expect(run.ledgerEvents.some((e) => e.type === 'route/fallback' && e.data.scope === 'root')).toBe(true)
  })
})

describe('视觉与权限', () => {
  it('vision-blocked：链上只有纯文本模型时拒绝，不降级', async () => {
    const run = await runScenario('vision-blocked', { ...JEV_OFF, routes: getRoutesOverlay({ guan_xiang: ['textonly-guan_xiang'] }) }, { files: { 'shot.png': PNG_1X1 } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[1]?.text).toContain('【观象】blocked')
    expect(run.results[1]?.text).toContain('vision-unsupported')
    expect(run.children.some((c) => c.role === 'guan_xiang')).toBe(false)
  })

  it('vision-ok：截图入库后交给观象；越界路径被拒绝', async () => {
    const run = await runScenario('vision-ok', { ...JEV_OFF, routes: getRoutesOverlay() }, { files: { 'shot.png': PNG_1X1 } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[1]?.text).toContain('【观象】completed')
    expect(run.children.find((c) => c.role === 'guan_xiang')?.images).toBe(true)
    expect(run.results[2]?.text).toContain('不在工作区内')
  })

  it('readonly-guard：御史预设中调用 write 被守卫拒绝，且没有 shell 与 swarm 工具', async () => {
    const run = await runScenario('readonly-guard', { ...JEV_OFF, routes: getRoutesOverlay() })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[0]?.text).toContain('守卫')
    expect(existsSync(join(run.workspace, 'guard.txt'))).toBe(false)
    expect(run.rootTools).not.toContain('pwsh')
    expect(run.rootTools).not.toContain('bash')
    expect(run.rootTools).not.toContain('swarm_delegate')
  })
})

describe('衡鉴 Jev', () => {
  let server: Server
  let port = 0
  let mode: 'ok' | 'overloaded' = 'ok'
  const requests: Array<{ auth?: string; body: Record<string, unknown> }> = []
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => { let data = ''; req.on('data', (c) => { data += c }); req.on('end', () => resolve(data)) })

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      requests.push({ auth: req.headers.authorization, body })
      if (mode === 'overloaded') {
        res.writeHead(529).end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        model: 'jev-1.13.0',
        answers: { math_task: { choice: 'research', confidence: 0.9 }, need_benchmark: { noul: 0.2 }, novelty: { score: 0.5, confidence: 0.9 } }
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => { server.close() })

  const jevConfig = () => ({ routes: getRoutesOverlay(), jev: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: 'SWARM_TEST_JEV_KEY' } })

  it('jev-triage：按答案追加门禁，请求带 Bearer 且只含脱敏摘要', async () => {
    mode = 'ok'
    const run = await runScenario('jev-triage', jevConfig(), { env: { SWARM_TEST_JEV_KEY: 'test-key' } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[0]?.text).toContain('衡鉴：rules+jev')
    expect(run.results[0]?.text).toContain('G_MATH_RESEARCH')
    const request = requests.at(-1)
    expect(request?.auth).toBe('Bearer test-key')
    expect(request?.body.model).toBe('jev-latest')
    expect(Object.keys((request?.body.state ?? {}) as object).sort()).toEqual(['acceptance_count', 'flags', 'goal', 'profile', 'scope_count', 'task'])
  })

  it('jev-fallback：Jev 过载时按严格路径追加验算与审查', async () => {
    mode = 'overloaded'
    const run = await runScenario('jev-fallback', jevConfig(), { env: { SWARM_TEST_JEV_KEY: 'test-key' } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[0]?.text).toContain('rules+jev-fallback')
    expect(run.results[0]?.text).toContain('http-529')
    expect(run.results[0]?.text).toContain('G_MATH_VERIFY')
  })
})
````

- [ ] **Step 3: 让 test:integration 先构建**

Modify `package.json` 的 `scripts.test:integration` 为：`"npm run build && vitest run --config vitest.integration.config.ts"`

- [ ] **Step 4: 运行集成测试**

Run: `npm run test:integration`
Expected: `bundle.test.ts` 与 `flows.test.ts` 全部 PASS。失败时先看 `run.stderr` 与 `.sandbox/ws-*.out.json`，按 superpowers:systematic-debugging 定位（常见原因：宿主接口与 §「已验证宿主事实」不符、mock 模型名与路由不匹配）。修复实现而不是放宽断言。

- [ ] **Step 5: 提交**

```bash
git add tests/integration package.json
git commit -m "test: add sandbox integration tests against real DSH 0.1.7-alpha.2"
```

---

### Task 15: 运维脚本、文档、示例与最终验证

**Files:**
- Create: `scripts/doctor.mjs`, `scripts/sync-dsh.mjs`
- Create: `README.md`, `docs/安装.md`, `docs/使用.md`, `docs/角色.md`, `docs/升级与回退.md`, `docs/评测.md`
- Create: `config/roles.example.yaml`, `config/policy.example.yaml`, `tests/fixtures/eval-tasks.example.json`
- Create: `tests/unit/docs.test.ts`
- Modify: `docs/superpowers/specs/2026-09-23-dsh-agent-swarm-design.md`（§6 工具名、§13 验证结果）

**Interfaces:**
- Consumes: `scripts/sandbox.mjs`、`ROLE_INFO_LIST`、`DEFAULT_ROUTE_CHAINS`、`getRouteLabel`
- Produces: `node scripts/doctor.mjs [--profile web]`（只读检查）、`node scripts/sync-dsh.mjs --version <x>`（升级适配）

- [ ] **Step 1: 写文档一致性测试（先失败）**

````ts file=tests/unit/docs.test.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROLE_INFO_LIST } from '../../src/role-registry.js'
import { DEFAULT_ROUTE_CHAINS, getRouteLabel } from '../../src/routes.js'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

describe('文档与代码一致', () => {
  it('角色.md 列出全部 13 个角色、预设 ID 与默认首选路由', () => {
    const doc = read('docs/角色.md')
    for (const role of ROLE_INFO_LIST) {
      expect(doc).toContain(role.name)
      expect(doc).toContain(role.presetId)
    }
    for (const chain of Object.values(DEFAULT_ROUTE_CHAINS)) expect(doc).toContain(getRouteLabel(chain[0] as { provider: string; model: string }))
  })

  it('安装.md 覆盖升级、模型、凭据、可选后端与 doctor', () => {
    const doc = read('docs/安装.md')
    for (const keyword of ['0.1.7-alpha.2', 'QWEN_TOKEN_PLAN_CN_API_KEY', 'OPENCODE_GO_API_KEY', 'TYPESAFE_API_KEY', '@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-subagent-claude-code', 'dsh-web-search-free', 'doctor', '天枢']) {
      expect(doc).toContain(keyword)
    }
  })

  it('示例配置只用真实存在的路由键', () => {
    const example = read('config/roles.example.yaml')
    const keys = [...example.matchAll(/^ {6}([a-z_:]+):$/gm)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(Object.keys(DEFAULT_ROUTE_CHAINS)).toContain(key)
  })

  it('评测样例包含 4 个必测案例', () => {
    const tasks = JSON.parse(read('tests/fixtures/eval-tasks.example.json')) as Array<{ id: string; mandatory?: boolean }>
    expect(tasks.filter((task) => task.mandatory === true).map((task) => task.id).sort()).toEqual(['command-exec', 'fu-he-finds-failure', 'screenshot', 'ui-copy'])
  })
})
````

Run: `npx vitest run tests/unit/docs.test.ts`
Expected: FAIL（文件不存在）

- [ ] **Step 2: 写 doctor 与 sync-dsh**

````js file=scripts/doctor.mjs
#!/usr/bin/env node
/**
 * dsh-agent-swarm 环境检查（只读；不输出任何密钥值）
 * 用法：node scripts/doctor.mjs [--profile web] [--dsh dsh]
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const getArg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const profile = getArg('--profile', 'web')
const dsh = getArg('--dsh', 'dsh')
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const MIN_VERSION = '0.1.7-alpha.2'
const rows = []
const add = (item, ok, detail, hint = '') => rows.push({ item, ok, detail, hint })

const run = (command) => {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
  } catch (error) {
    return undefined
  }
}

/** 比较 x.y.z-tag.n 形式的版本；预发布 alpha < beta < rc < 正式版 */
const getVersionOrder = (version) => {
  const [core, pre = ''] = version.trim().split('-')
  const nums = core.split('.').map(Number)
  const [tag = 'zz', n = '0'] = pre.split('.')
  const tagRank = { alpha: 0, beta: 1, rc: 2, zz: 3 }[tag] ?? 3
  return [...nums, tagRank, Number(n)]
}
const isAtLeast = (version, min) => {
  const a = getVersionOrder(version)
  const b = getVersionOrder(min)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

const version = run(`${dsh} --version`)?.trim()
add('DSH 版本', version !== undefined && isAtLeast(version, MIN_VERSION), version ?? '未找到 dsh 命令', `需要 ≥ ${MIN_VERSION}：npm i -g @deepseek-ai/dsh@${MIN_VERSION}`)

const profileDir = join(dshHome, 'profiles', profile)
let bundles = []
try {
  bundles = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? []
} catch {
  bundles = []
}
add(`profile「${profile}」已安装本插件`, bundles.includes('dsh-agent-swarm'), bundles.length > 0 ? `${bundles.length} 个 bundle` : 'profile 不存在或为空', `dsh plugin --profile ${profile} add <本仓库绝对路径>`)
add('原生 Codex 后端（可选）', bundles.includes('@deepseek-ai/dsh-subagent-codex'), bundles.includes('@deepseek-ai/dsh-subagent-codex') ? '已安装' : '未安装', `dsh plugin --profile ${profile} add @deepseek-ai/dsh-subagent-codex`)
add('原生 Claude Code 后端（可选）', bundles.includes('@deepseek-ai/dsh-subagent-claude-code'), bundles.includes('@deepseek-ai/dsh-subagent-claude-code') ? '已安装' : '未安装', `dsh plugin --profile ${profile} add @deepseek-ai/dsh-subagent-claude-code`)
add('免费网页搜索（可选）', bundles.includes('dsh-web-search-free'), bundles.includes('dsh-web-search-free') ? '已安装' : '未安装', `dsh plugin --profile ${profile} add dsh-web-search-free`)

const dump = version !== undefined ? run(`${dsh} --profile ${profile} --dump-config`) : undefined
if (dump !== undefined) {
  add('13 个 swarm 预设已组合', ['tian-shu', 'fu-he', 'miao-bi'].every((id) => dump.includes(`preset-${id}`)), dump.includes('preset-tian-shu') ? '已组合' : '未找到 preset-tian-shu')
  for (const provider of ['qwen-token-plan-cn', 'opencode-go']) {
    add(`模型 provider ${provider}`, dump.includes(provider), dump.includes(provider) ? '已配置' : '未在 profile 配置中找到', 'Web 设置 → 模型 → 添加 provider（内置目录，只需填写 API key）')
  }
} else {
  add('读取组合配置', false, '无法运行 --dump-config', '先修复上面的 DSH 版本或 profile 问题')
}

const credentialsText = existsSync(join(dshHome, '.credentials.yaml')) ? readFileSync(join(dshHome, '.credentials.yaml'), 'utf8') : ''
for (const ref of ['QWEN_TOKEN_PLAN_CN_API_KEY', 'OPENCODE_GO_API_KEY', 'DEEPSEEK_API_KEY', 'TYPESAFE_API_KEY']) {
  const fromEnv = (process.env[ref] ?? '') !== ''
  const fromStore = new RegExp(`^\\s+${ref}:`, 'm').test(credentialsText)
  add(`凭据引用 ${ref}`, fromEnv || fromStore, fromEnv ? '来源：环境变量' : fromStore ? '来源：凭据库' : '未配置', ref === 'TYPESAFE_API_KEY' ? '设置用户环境变量后重启 dsh；未配置时衡鉴按严格路径运行' : '在 Web 设置 → 模型中填写')
}

const legacyDir = join(dshHome, '.agent-presets')
const legacy = existsSync(legacyDir) ? readdirSync(legacyDir).filter((name) => !name.startsWith('.')) : []
if (legacy.length > 0) add('旧式预设目录', false, `${legacy.length} 个（0.1.7 起不再读取）：${legacy.join(', ')}`, '见 docs/升级与回退.md 的迁移说明')

const width = Math.max(...rows.map((row) => row.item.length))
for (const row of rows) {
  console.log(`${row.ok ? '✓' : '✗'} ${row.item.padEnd(width)}  ${row.detail}${row.ok || row.hint === '' ? '' : `\n    → ${row.hint}`}`)
}
if (argv.includes('--strict') && rows.some((row) => !row.ok)) process.exit(1)
````

````js file=scripts/sync-dsh.mjs
#!/usr/bin/env node
/**
 * 升级适配：在沙箱安装指定 DSH 版本，按新版 standard 预设重新生成预设，运行全部测试；通过后写入 testedVersions
 * 用法：node scripts/sync-dsh.mjs --version 0.1.8-alpha.1
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, ensureDsh, getSandboxDshModules } from './sandbox.mjs'

const argv = process.argv.slice(2)
const version = argv.includes('--version') ? argv[argv.indexOf('--version') + 1] : undefined
if (version === undefined) {
  console.error('用法：node scripts/sync-dsh.mjs --version <DSH 版本>')
  process.exit(2)
}

const step = (title, command, env = {}) => {
  console.log(`\n== ${title}\n$ ${command}`)
  execSync(command, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
}

ensureDsh(version)
step('构建', 'npm run build')
step('按新版 standard 预设重新生成预设与 fixture', `node scripts/gen-presets.mjs --dsh "${getSandboxDshModules(version)}" --write-fixture`)
step('单元测试与覆盖率', 'npx vitest run --coverage')
step('沙箱集成测试', 'npx vitest run --config vitest.integration.config.ts', { SWARM_DSH_VERSION: version })

const pkgFile = join(REPO_ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
const tested = [version, ...(pkg.dsh.testedVersions ?? []).filter((item) => item !== version)]
writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, dsh: { ...pkg.dsh, testedVersions: tested } }, null, 2)}\n`, 'utf8')
step('变更概览', 'git status --short presets tests/fixtures package.json')
console.log(`\nDSH ${version} 适配通过，已写入 testedVersions。请审阅 presets/ 的差异后提交。`)
````

- [ ] **Step 3: 写文档与示例**

写入以下文件，内容要求如下（以下为完整内容要点，逐条落实到文件中）：

`README.md`：一句话定位；架构图（宿主行 + 13 预设 + 4 工具）；快速开始（引用 `docs/安装.md`）；命令表（`npm run build / test / coverage / test:integration / gen:presets / doctor / sync-dsh`）；「沙箱已验证 / 需本机验证」表（同 spec §16）；许可证 MIT。

`docs/安装.md`（面向用户，中文，编号步骤）：
1. 备份：复制 `%USERPROFILE%\.dsh` 到 `%USERPROFILE%\.dsh.backup-日期`。
2. 升级：`npm i -g @deepseek-ai/dsh@0.1.7-alpha.2`，`dsh --version` 确认；首次 `dsh web` 会把 `settings.yaml` 迁移为 `settings.yaml.imported`（说明旧式预设目录 vibe-math/rigorquant/ultramath 不再被读取，迁移方法见《升级与回退》）。
3. 构建本插件：在仓库目录 `npm install && npm run build`。
4. 安装：`dsh plugin --profile web add D:\Desktop\swarm\dsh-agent-swarm`；可选：`dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex`、`dsh plugin --profile web add @deepseek-ai/dsh-subagent-claude-code`（需先分别完成 Codex 与 Claude Code 的官方登录；ChatGPT Plus / Claude Pro 额度由原生客户端消耗，默认每会话最多 3 次）、`dsh plugin --profile web add dsh-web-search-free`（在插件卡片填写六个搜索 API key）。
5. 模型：Web 设置 → 模型，添加内置 provider `qwen-token-plan-cn`（凭据 `QWEN_TOKEN_PLAN_CN_API_KEY`）、`opencode-go`（`OPENCODE_GO_API_KEY`）、DeepSeek（`DEEPSEEK_API_KEY`）；主模型建议选 `qwen-token-plan-cn / deepseek-v4-pro`。
6. Jev：`setx TYPESAFE_API_KEY "<你的 key>"` 后重开终端并重启 `dsh web`；不配置时衡鉴按规则 + 严格路径运行。
7. 检查：`npm run doctor -- --profile web`，逐项修复 ✗。
8. 重启 `dsh web`，在 Workspace 选择项目目录，新建会话（默认即「天枢」）。
9. 卸载：`dsh plugin --profile web remove dsh-agent-swarm`（不删除工作区文件与账本）。

`docs/使用.md`：天枢工作流（任务卡 → 委派 → 复核 → 验收）；4 个工具的参数与返回说明；门禁表（同 spec §8.2）；三个示例请求（V2 设计稿 §9 的三例，原文）；直接选用角色预设（算衡、妙笔、复核）；如何看账本（`%USERPROFILE%\.dsh\share\dsh-agent-swarm\ledger\<会话>.jsonl`）；如何在设置页或 profile 补丁中覆盖路由（引用 `config/roles.example.yaml`）；常见阻塞与处理（vision-unsupported、no-usable-route、native-unavailable、jev-fallback、预算用尽）。

`docs/角色.md`：一张表，列：中文名、预设 ID、权限、可用工具、首选路由（写成 `provider/model`，与 `DEFAULT_ROUTE_CHAINS` 每条链的第一项一致，包括 `suan_heng:research` 与 `suan_heng:verify` 两行）、备用、升级通道、交付物；表后写明各角色边界（行舟/疾风/复核、观象/铸剑、妙笔/谋定），与 V2 设计稿 §2 一致。

`docs/升级与回退.md`：升级 DSH 新版本时运行 `npm run sync-dsh -- --version <x>`，审阅 `presets/` diff 后提交；`src/host-contract.ts` 是宿主假设清单；回退：`dsh plugin --profile web remove dsh-agent-swarm`，`npm i -g @deepseek-ai/dsh@0.1.5-alpha.1`，用备份恢复 `.dsh`；旧式预设迁移：用 DSH 自带的 editing-cordis-compositions 技能，把 `$DSH_HOME/.agent-presets/<id>` 转成 bundle 补丁（给出该技能「Migrate a legacy preset」的步骤摘要）。

`docs/评测.md`：按 V2 设计稿 §8 运行 ≥20 个任务的评测。说明 `tests/fixtures/eval-tasks.example.json` 的字段（`id, category, prompt, expectedGates, expectedRoles, mandatory, acceptance`）；每题在「天枢」会话中执行；从账本统计：严重缺陷漏检、预算、测试通过率、性能结论可复现比例、路由准确率（实际委派角色 vs expectedRoles）；给出记录表模板。

`config/roles.example.yaml`：profile 补丁示例，内容为：

```yaml
# 复制到 %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml 末尾后重启 dsh web。
# 覆盖会整体替换 swarm-core 的 config，未写的字段恢复默认值。
- id: swarm-core
  config:
    routes:
      zhu_jian:
        chain:
          - { provider: qwen-token-plan-cn, model: kimi-k2.7-code }
          - { provider: opencode-go, model: kimi-k2.7-code }
        escalation: claude
      yu_shi:
        chain:
          - { provider: opencode-go, model: glm-5.3 }
      suan_heng:verify:
        chain:
          - { provider: qwen-token-plan-cn, model: qwen3.8-max, reasoningEffort: xhigh }
    nativeEscalation: manual
```

`config/policy.example.yaml`：同样的格式，覆盖 `budgets`（例如 `maxAutoFixRounds: 1`）、`jev`（`mathConfidence: 0.7`）与 `native.maxCallsPerSession: 5`，并附注释说明每个字段。

`tests/fixtures/eval-tasks.example.json`：JSON 数组，至少 8 条，其中 4 条 `mandatory: true`，id 分别为 `command-exec`（启动 FastAPI WebSocket 服务并记录失败，expectedRoles 含 `xing_zhou`、`fu_he`）、`ui-copy`（中文操作说明，含 `miao_bi`）、`screenshot`（按截图改看板，含 `guan_xiang`，expectedGates 含 `G_VISION`）、`fu-he-finds-failure`（故意留一个失败测试，期望复核给出 `verdict: fail` 并阻止验收）；其余为算法/时间序列边界案例（如缠论增量笔等价性，expectedGates 含 `G_MATH_RESEARCH`、`G_MATH_VERIFY`、`G_DIFF_TEST`）。

- [ ] **Step 4: 更新 spec 中已被实测修正的部分**

Modify `docs/superpowers/specs/2026-09-23-dsh-agent-swarm-design.md`：
- §6 能力映射改为实测工具名：`read → [read, read_image]`、`search → [glob, grep]`、`edit → [write, edit]`、`shell → [pwsh, bash]`、`web → [web_search, web_fetch]`。
- §7.1 表注明 DeepSeek 官方模型为 `deepseek-v4-pro` / `deepseek-flash`，并与 `src/routes.ts` 一致。
- §13 每行追加「结果」列：V1 用 `profileContext.startedBundles`（已采用）；V2/V6 预设作用域事件覆盖子智能体（已采用）；V3 `ctx.attachments.saveImages`（已采用）；V4 作用域内工具不能 restrict，改为全局 `tools.guard` + 子智能体 `toolFilter.allow`（已采用）；V5 在 `dependencies` 声明 schemastery（已采用）。

- [ ] **Step 5: 全量验证**

Run（逐条执行并检查输出）：
1. `npm run typecheck` → 无错误
2. `npm run coverage` → 全部 PASS，覆盖率达阈值
3. `npm run build`
4. `node scripts/gen-presets.mjs` 然后 `git status --short presets package.json` → 无变化（生成器幂等、已提交文件最新）
5. `npm run test:integration` → 全部 PASS
6. `node scripts/doctor.mjs --profile web` → 能运行并输出检查表（本机仍是 0.1.5 时应显示版本 ✗ 与升级提示；不输出任何密钥值）

Expected: 1–5 全部通过；6 正常输出（✗ 项为本机未升级导致，属预期）

- [ ] **Step 6: 代码审查**

按用户全局规范执行代码审查（安全：无硬编码密钥、账本与 Jev 请求均脱敏；质量：函数 < 50 行、文件 < 800 行、嵌套 ≤ 4 层）。对 CRITICAL/HIGH 问题修复后重跑 Step 5 的 1–5。

- [ ] **Step 7: 提交**

```bash
git add README.md docs config scripts tests/unit/docs.test.ts tests/fixtures/eval-tasks.example.json
git commit -m "docs: add install, usage, roles, upgrade and evaluation guides with doctor and sync-dsh"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1 目标 → Task 1–15；§2 宿主事实 → `host-contract.ts` 与集成测试；§3 架构 → Task 11–13；§4 包结构 → 各 Task；§5 bundle 补丁 → Task 13；§6 角色 → Task 2；§7 路由 → Task 3、7、9、10；§8 策略与衡鉴 → Task 4、5、11；§9 工具 → Task 12；§10 委派细节 → Task 8、10；§11 账本 → Task 6；§12 配置 → Task 7；§13 验证点 → 已在计划前沙箱实测，Task 15 回写 spec；§14 升级 → Task 13 生成器、Task 15 sync-dsh/doctor；§15 测试 → 各 Task 单测 + Task 14；§16 交付 → Task 15。
- **与 spec 的有意偏差**：`verification.ts` 合并入 `contracts.ts`（交付契约统一校验）；新增 `route-state.ts`、`preset-builder.ts`、`util/*`；天枢预设移除通用 `subagent/workflow` 工具，统一走 `swarm_delegate`。
- **类型一致性**：`GateDelegationView`（policy）⊂ `DelegationRecord`（evidence）；`RouteInfo`（routes）贯穿 config/route-state/delegate；`SwarmService` 方法名在 tools/runtime/index 中一致；`VALID_OUTPUTS` 由 JSON 单一来源供单测与驱动共用。
