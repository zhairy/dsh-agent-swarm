import Schema from '@deepseek-ai/schemastery';
import { type JevConfigInfo } from './jev.js';
import { type PromptStylePolicy } from './model-family.js';
import { type BudgetInfo, type TriageThresholdsInfo } from './policy.js';
import { type EscalationKind, type RouteInfo, type RouteKey } from './domain/routing/routes.js';
import { type UpgradeInfo } from './domain/routing/upgrade.js';
import { type ReviewThresholdsInfo } from './review.js';
import { type MathConfigInfo } from './math/config.js';
import { type OutputLanguage } from './language.js';
export declare const APPROVAL_SCOPES: readonly ['write', 'shell', 'external_mcp', 'jev'];
export interface ApprovalsConfigInfo {
    mode: 'inherit' | 'ask' | 'deny';
    scope: readonly typeof APPROVAL_SCOPES[number][];
}
export declare const DEFAULT_APPROVALS_CONFIG: ApprovalsConfigInfo;
/** swarm-core 行的 Config；字段标记为 volatile，可被 DSH 配置编辑接口在线修改，读取时每次取最新值 */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    routes: Schema<NoInfer<import("@deepseek-ai/cosmokit").Dict<{
        chain?: ({
            provider?: string | null | undefined;
            model?: string | null | undefined;
            reasoningEffort?: string | null | undefined;
            policy?: ({
                accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                quotaDomainId?: string | null | undefined;
                quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                poolId?: string | null | undefined;
                capabilities?: ({
                    generation?: boolean | null | undefined;
                    structuredOutput?: boolean | null | undefined;
                    vision?: boolean | null | undefined;
                    tools?: boolean | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
        escalation?: "claude" | "codex" | null | undefined;
        upgrade?: ({
            enabled?: boolean | null | undefined;
            chain?: ({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                reasoningEffort?: string | null | undefined;
                policy?: ({
                    accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                    quotaDomainId?: string | null | undefined;
                    quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                    poolId?: string | null | undefined;
                    capabilities?: ({
                        generation?: boolean | null | undefined;
                        structuredOutput?: boolean | null | undefined;
                        vision?: boolean | null | undefined;
                        tools?: boolean | null | undefined;
                    } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
            triggers?: ("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<NoInfer<{
        chain: Schema<({
            provider?: string | null | undefined;
            model?: string | null | undefined;
            reasoningEffort?: string | null | undefined;
            policy?: ({
                accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                quotaDomainId?: string | null | undefined;
                quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                poolId?: string | null | undefined;
                capabilities?: ({
                    generation?: boolean | null | undefined;
                    structuredOutput?: boolean | null | undefined;
                    vision?: boolean | null | undefined;
                    tools?: boolean | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "plain">;
            policy: Schema<Schemastery.ObjectS<NoInfer<{
                accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                quotaDomainId: Schema<string, string, "plain">;
                quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                poolId: Schema<string, string, "plain">;
                capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                    generation: Schema<boolean, boolean, "plain">;
                    structuredOutput: Schema<boolean, boolean, "plain">;
                    vision: Schema<boolean, boolean, "plain">;
                    tools: Schema<boolean, boolean, "plain">;
                }>>, Schemastery.ObjectT<NoInfer<{
                    generation: Schema<boolean, boolean, "plain">;
                    structuredOutput: Schema<boolean, boolean, "plain">;
                    vision: Schema<boolean, boolean, "plain">;
                    tools: Schema<boolean, boolean, "plain">;
                }>>, "plain">;
            }>>, Schemastery.ObjectT<NoInfer<{
                accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                quotaDomainId: Schema<string, string, "plain">;
                quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                poolId: Schema<string, string, "plain">;
                capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                    generation: Schema<boolean, boolean, "plain">;
                    structuredOutput: Schema<boolean, boolean, "plain">;
                    vision: Schema<boolean, boolean, "plain">;
                    tools: Schema<boolean, boolean, "plain">;
                }>>, Schemastery.ObjectT<NoInfer<{
                    generation: Schema<boolean, boolean, "plain">;
                    structuredOutput: Schema<boolean, boolean, "plain">;
                    vision: Schema<boolean, boolean, "plain">;
                    tools: Schema<boolean, boolean, "plain">;
                }>>, "plain">;
            }>>, "plain">;
        }>>[], "defined">;
        escalation: Schema<"claude" | "codex", "claude" | "codex", "plain">;
        upgrade: Schema<Schemastery.ObjectS<NoInfer<{
            enabled: Schema<boolean, boolean, "defined">;
            chain: Schema<({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                reasoningEffort?: string | null | undefined;
                policy?: ({
                    accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                    quotaDomainId?: string | null | undefined;
                    quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                    poolId?: string | null | undefined;
                    capabilities?: ({
                        generation?: boolean | null | undefined;
                        structuredOutput?: boolean | null | undefined;
                        vision?: boolean | null | undefined;
                        tools?: boolean | null | undefined;
                    } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
                provider: Schema<string, string, "defined">;
                model: Schema<string, string, "defined">;
                reasoningEffort: Schema<string, string, "plain">;
                policy: Schema<Schemastery.ObjectS<NoInfer<{
                    accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                    quotaDomainId: Schema<string, string, "plain">;
                    quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                    poolId: Schema<string, string, "plain">;
                    capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, Schemastery.ObjectT<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, "plain">;
                }>>, Schemastery.ObjectT<NoInfer<{
                    accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                    quotaDomainId: Schema<string, string, "plain">;
                    quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                    poolId: Schema<string, string, "plain">;
                    capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, Schemastery.ObjectT<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, "plain">;
                }>>, "plain">;
            }>>[], "defined">;
            triggers: Schema<("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[], ("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[], "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: Schema<boolean, boolean, "defined">;
            chain: Schema<({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                reasoningEffort?: string | null | undefined;
                policy?: ({
                    accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                    quotaDomainId?: string | null | undefined;
                    quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                    poolId?: string | null | undefined;
                    capabilities?: ({
                        generation?: boolean | null | undefined;
                        structuredOutput?: boolean | null | undefined;
                        vision?: boolean | null | undefined;
                        tools?: boolean | null | undefined;
                    } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
                provider: Schema<string, string, "defined">;
                model: Schema<string, string, "defined">;
                reasoningEffort: Schema<string, string, "plain">;
                policy: Schema<Schemastery.ObjectS<NoInfer<{
                    accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                    quotaDomainId: Schema<string, string, "plain">;
                    quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                    poolId: Schema<string, string, "plain">;
                    capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, Schemastery.ObjectT<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, "plain">;
                }>>, Schemastery.ObjectT<NoInfer<{
                    accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                    quotaDomainId: Schema<string, string, "plain">;
                    quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                    poolId: Schema<string, string, "plain">;
                    capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, Schemastery.ObjectT<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, "plain">;
                }>>, "plain">;
            }>>[], "defined">;
            triggers: Schema<("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[], ("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[], "defined">;
        }>>, "plain">;
    }>>, string>>, "volatile-defined">;
    scheduling: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        strategy: Schema<"fifo" | "priority" | "roundRobin", "fifo" | "priority" | "roundRobin", "defined">;
        maxActive: Schema<number, number, "defined">;
        maxPending: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        strategy: Schema<"fifo" | "priority" | "roundRobin", "fifo" | "priority" | "roundRobin", "defined">;
        maxActive: Schema<number, number, "defined">;
        maxPending: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    memory: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        maxMatches: Schema<number, number, "defined">;
        maxChars: Schema<number, number, "defined">;
        ttlMs: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        maxMatches: Schema<number, number, "defined">;
        maxChars: Schema<number, number, "defined">;
        ttlMs: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    rootFallback: Schema<boolean, boolean, "volatile-defined">;
    proactive: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        mode: Schema<"auto" | "observe" | "off", "auto" | "observe" | "off", "defined">;
        rules: Schema<string[], string[], "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        mode: Schema<"auto" | "observe" | "off", "auto" | "observe" | "off", "defined">;
        rules: Schema<string[], string[], "defined">;
    }>>>, "volatile-defined">;
    events: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        journal: Schema<boolean, boolean, "defined">;
        sealAfterBytes: Schema<number, number, "defined">;
        maxLineBytes: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        journal: Schema<boolean, boolean, "defined">;
        sealAfterBytes: Schema<number, number, "defined">;
        maxLineBytes: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    watchdog: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        heartbeatMs: Schema<number, number, "defined">;
        suspectAfterMisses: Schema<number, number, "defined">;
        inputRetryBaseMs: Schema<number, number, "defined">;
        inputRetryMaxMs: Schema<number, number, "defined">;
        quarantineOnUnknownWrite: Schema<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        heartbeatMs: Schema<number, number, "defined">;
        suspectAfterMisses: Schema<number, number, "defined">;
        inputRetryBaseMs: Schema<number, number, "defined">;
        inputRetryMaxMs: Schema<number, number, "defined">;
        quarantineOnUnknownWrite: Schema<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
    router: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        workspaceWrites: Schema<"allow" | "deny", "allow" | "deny", "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        workspaceWrites: Schema<"allow" | "deny", "allow" | "deny", "defined">;
    }>>>, "volatile-defined">;
    approvals: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        mode: Schema<"ask" | "deny" | "inherit", "ask" | "deny" | "inherit", "defined">;
        scope: Schema<("external_mcp" | "jev" | "shell" | "write")[], ("external_mcp" | "jev" | "shell" | "write")[], "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        mode: Schema<"ask" | "deny" | "inherit", "ask" | "deny" | "inherit", "defined">;
        scope: Schema<("external_mcp" | "jev" | "shell" | "write")[], ("external_mcp" | "jev" | "shell" | "write")[], "defined">;
    }>>>, "volatile-defined">;
    nativeEscalation: Schema<"auto" | "manual", "auto" | "manual", "volatile-defined">;
    native: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        codexProvider: Schema<string, string, "defined">;
        codexEditProvider: Schema<string, string, "defined">;
        claudePlanProvider: Schema<string, string, "defined">;
        claudeEditProvider: Schema<string, string, "defined">;
        maxCallsPerSession: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        codexProvider: Schema<string, string, "defined">;
        codexEditProvider: Schema<string, string, "defined">;
        claudePlanProvider: Schema<string, string, "defined">;
        claudeEditProvider: Schema<string, string, "defined">;
        maxCallsPerSession: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    jev: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        source: Schema<"official" | "third-party", "official" | "third-party", "defined">;
        apiKeyEnv: Schema<string, string, "defined">;
        baseUrl: Schema<string, string, "defined">;
        model: Schema<string, string, "defined">;
        thirdParty: Schema<Schemastery.ObjectS<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "defined">;
        }>>, "defined">;
        timeoutMs: Schema<number, number, "defined">;
        maxRetries: Schema<number, number, "defined">;
        maxRequestsPerSecond: Schema<number, number, "defined">;
        maxRequestChars: Schema<number, number, "defined">;
        mathConfidence: Schema<number, number, "defined">;
        benchmarkNoul: Schema<number, number, "defined">;
        noveltyScore: Schema<number, number, "defined">;
        noveltyConfidence: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        source: Schema<"official" | "third-party", "official" | "third-party", "defined">;
        apiKeyEnv: Schema<string, string, "defined">;
        baseUrl: Schema<string, string, "defined">;
        model: Schema<string, string, "defined">;
        thirdParty: Schema<Schemastery.ObjectS<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "defined">;
        }>>, "defined">;
        timeoutMs: Schema<number, number, "defined">;
        maxRetries: Schema<number, number, "defined">;
        maxRequestsPerSecond: Schema<number, number, "defined">;
        maxRequestChars: Schema<number, number, "defined">;
        mathConfidence: Schema<number, number, "defined">;
        benchmarkNoul: Schema<number, number, "defined">;
        noveltyScore: Schema<number, number, "defined">;
        noveltyConfidence: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    review: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        trustedAbove: Schema<number, number, "defined">;
        doubtfulBelow: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        trustedAbove: Schema<number, number, "defined">;
        doubtfulBelow: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    agents: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        language: Schema<"en" | "ja" | "ko" | "zh-CN" | "zh-TW", "en" | "ja" | "ko" | "zh-CN" | "zh-TW", "defined">;
        languageExclusions: Schema<string[], string[], "defined">;
        session: Schema<"auto" | "continuable" | "oneshot", "auto" | "continuable" | "oneshot", "defined">;
        repeatAbove: Schema<number, number, "defined">;
        sameCategoryAbove: Schema<number, number, "defined">;
        maxRetries: Schema<number, number, "defined">;
        retryBackoffMs: Schema<number, number, "defined">;
        promptStyle: Schema<"auto" | "claude" | "generic" | "gpt", "auto" | "claude" | "generic" | "gpt", "defined">;
        networkWaitMs: Schema<number, number, "defined">;
        rootRecoverMs: Schema<number, number, "defined">;
        networkProbeUrls: Schema<string[], string[], "defined">;
        modelCallDisplay: Schema<"every" | "turn", "every" | "turn", "defined">;
        nativeTeamProjection: Schema<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        language: Schema<"en" | "ja" | "ko" | "zh-CN" | "zh-TW", "en" | "ja" | "ko" | "zh-CN" | "zh-TW", "defined">;
        languageExclusions: Schema<string[], string[], "defined">;
        session: Schema<"auto" | "continuable" | "oneshot", "auto" | "continuable" | "oneshot", "defined">;
        repeatAbove: Schema<number, number, "defined">;
        sameCategoryAbove: Schema<number, number, "defined">;
        maxRetries: Schema<number, number, "defined">;
        retryBackoffMs: Schema<number, number, "defined">;
        promptStyle: Schema<"auto" | "claude" | "generic" | "gpt", "auto" | "claude" | "generic" | "gpt", "defined">;
        networkWaitMs: Schema<number, number, "defined">;
        rootRecoverMs: Schema<number, number, "defined">;
        networkProbeUrls: Schema<string[], string[], "defined">;
        modelCallDisplay: Schema<"every" | "turn", "every" | "turn", "defined">;
        nativeTeamProjection: Schema<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
    budgets: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        maxDelegationsPerTask: Schema<number, number, "defined">;
        maxCallsPerRole: Schema<number, number, "defined">;
        maxCallsZhuJian: Schema<number, number, "defined">;
        maxAutoFixRounds: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        maxDelegationsPerTask: Schema<number, number, "defined">;
        maxCallsPerRole: Schema<number, number, "defined">;
        maxCallsZhuJian: Schema<number, number, "defined">;
        maxAutoFixRounds: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    ledgerDir: Schema<string, string, "volatile-defined">;
    workflow: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        mode: Schema<"advisory" | "enforced" | "off", "advisory" | "enforced" | "off", "defined">;
        maxNodes: Schema<number, number, "defined">;
        maxEdges: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        mode: Schema<"advisory" | "enforced" | "off", "advisory" | "enforced" | "off", "defined">;
        maxNodes: Schema<number, number, "defined">;
        maxEdges: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    planningReview: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        requireJev: Schema<boolean, boolean, "defined">;
        maxFixRounds: Schema<number, number, "defined">;
        timeoutMs: Schema<number, number, "defined">;
        reviewAbove: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        requireJev: Schema<boolean, boolean, "defined">;
        maxFixRounds: Schema<number, number, "defined">;
        timeoutMs: Schema<number, number, "defined">;
        reviewAbove: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    execution: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        profile: Schema<"bounded" | "legacy", "bounded" | "legacy", "defined">;
        maxCalls: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        profile: Schema<"bounded" | "legacy", "bounded" | "legacy", "defined">;
        maxCalls: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    recovery: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        maxTransientRetries: Schema<number, number, "defined">;
        maxLogicalAttempts: Schema<number, number, "defined">;
        maxShortRetryDelayMs: Schema<number, number, "defined">;
        maxTransientWaitMs: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        maxTransientRetries: Schema<number, number, "defined">;
        maxLogicalAttempts: Schema<number, number, "defined">;
        maxShortRetryDelayMs: Schema<number, number, "defined">;
        maxTransientWaitMs: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    persistence: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        directory: Schema<string, string, "defined">;
        maxStateBytes: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        directory: Schema<string, string, "defined">;
        maxStateBytes: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    messageBus: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        maxPending: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        maxPending: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    math: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        enableExtended: Schema<boolean, boolean, "defined">;
        maxCallsPerTask: Schema<number, number, "defined">;
        maxWorkUnitsPerTask: Schema<number, number, "defined">;
        groups: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        operators: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        numericModes: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        limits: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<number, number, "defined">;
        }>>, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        enableExtended: Schema<boolean, boolean, "defined">;
        maxCallsPerTask: Schema<number, number, "defined">;
        maxWorkUnitsPerTask: Schema<number, number, "defined">;
        groups: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        operators: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        numericModes: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        limits: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<number, number, "defined">;
        }>>, "defined">;
    }>>>, "volatile-defined">;
    experience: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    routes: Schema<NoInfer<import("@deepseek-ai/cosmokit").Dict<{
        chain?: ({
            provider?: string | null | undefined;
            model?: string | null | undefined;
            reasoningEffort?: string | null | undefined;
            policy?: ({
                accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                quotaDomainId?: string | null | undefined;
                quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                poolId?: string | null | undefined;
                capabilities?: ({
                    generation?: boolean | null | undefined;
                    structuredOutput?: boolean | null | undefined;
                    vision?: boolean | null | undefined;
                    tools?: boolean | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
        escalation?: "claude" | "codex" | null | undefined;
        upgrade?: ({
            enabled?: boolean | null | undefined;
            chain?: ({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                reasoningEffort?: string | null | undefined;
                policy?: ({
                    accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                    quotaDomainId?: string | null | undefined;
                    quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                    poolId?: string | null | undefined;
                    capabilities?: ({
                        generation?: boolean | null | undefined;
                        structuredOutput?: boolean | null | undefined;
                        vision?: boolean | null | undefined;
                        tools?: boolean | null | undefined;
                    } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[] | null | undefined;
            triggers?: ("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[] | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<NoInfer<{
        chain: Schema<({
            provider?: string | null | undefined;
            model?: string | null | undefined;
            reasoningEffort?: string | null | undefined;
            policy?: ({
                accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                quotaDomainId?: string | null | undefined;
                quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                poolId?: string | null | undefined;
                capabilities?: ({
                    generation?: boolean | null | undefined;
                    structuredOutput?: boolean | null | undefined;
                    vision?: boolean | null | undefined;
                    tools?: boolean | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "plain">;
            policy: Schema<Schemastery.ObjectS<NoInfer<{
                accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                quotaDomainId: Schema<string, string, "plain">;
                quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                poolId: Schema<string, string, "plain">;
                capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                    generation: Schema<boolean, boolean, "plain">;
                    structuredOutput: Schema<boolean, boolean, "plain">;
                    vision: Schema<boolean, boolean, "plain">;
                    tools: Schema<boolean, boolean, "plain">;
                }>>, Schemastery.ObjectT<NoInfer<{
                    generation: Schema<boolean, boolean, "plain">;
                    structuredOutput: Schema<boolean, boolean, "plain">;
                    vision: Schema<boolean, boolean, "plain">;
                    tools: Schema<boolean, boolean, "plain">;
                }>>, "plain">;
            }>>, Schemastery.ObjectT<NoInfer<{
                accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                quotaDomainId: Schema<string, string, "plain">;
                quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                poolId: Schema<string, string, "plain">;
                capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                    generation: Schema<boolean, boolean, "plain">;
                    structuredOutput: Schema<boolean, boolean, "plain">;
                    vision: Schema<boolean, boolean, "plain">;
                    tools: Schema<boolean, boolean, "plain">;
                }>>, Schemastery.ObjectT<NoInfer<{
                    generation: Schema<boolean, boolean, "plain">;
                    structuredOutput: Schema<boolean, boolean, "plain">;
                    vision: Schema<boolean, boolean, "plain">;
                    tools: Schema<boolean, boolean, "plain">;
                }>>, "plain">;
            }>>, "plain">;
        }>>[], "defined">;
        escalation: Schema<"claude" | "codex", "claude" | "codex", "plain">;
        upgrade: Schema<Schemastery.ObjectS<NoInfer<{
            enabled: Schema<boolean, boolean, "defined">;
            chain: Schema<({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                reasoningEffort?: string | null | undefined;
                policy?: ({
                    accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                    quotaDomainId?: string | null | undefined;
                    quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                    poolId?: string | null | undefined;
                    capabilities?: ({
                        generation?: boolean | null | undefined;
                        structuredOutput?: boolean | null | undefined;
                        vision?: boolean | null | undefined;
                        tools?: boolean | null | undefined;
                    } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
                provider: Schema<string, string, "defined">;
                model: Schema<string, string, "defined">;
                reasoningEffort: Schema<string, string, "plain">;
                policy: Schema<Schemastery.ObjectS<NoInfer<{
                    accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                    quotaDomainId: Schema<string, string, "plain">;
                    quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                    poolId: Schema<string, string, "plain">;
                    capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, Schemastery.ObjectT<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, "plain">;
                }>>, Schemastery.ObjectT<NoInfer<{
                    accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                    quotaDomainId: Schema<string, string, "plain">;
                    quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                    poolId: Schema<string, string, "plain">;
                    capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, Schemastery.ObjectT<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, "plain">;
                }>>, "plain">;
            }>>[], "defined">;
            triggers: Schema<("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[], ("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[], "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: Schema<boolean, boolean, "defined">;
            chain: Schema<({
                provider?: string | null | undefined;
                model?: string | null | undefined;
                reasoningEffort?: string | null | undefined;
                policy?: ({
                    accessMode?: "judgment_api" | "metered_api" | "subscription" | "unknown" | null | undefined;
                    quotaDomainId?: string | null | undefined;
                    quotaScope?: "account" | "model" | "plan" | "pool" | "unknown" | null | undefined;
                    poolId?: string | null | undefined;
                    capabilities?: ({
                        generation?: boolean | null | undefined;
                        structuredOutput?: boolean | null | undefined;
                        vision?: boolean | null | undefined;
                        tools?: boolean | null | undefined;
                    } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
                } & import("@deepseek-ai/cosmokit").Dict) | null | undefined;
            } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
                provider: Schema<string, string, "defined">;
                model: Schema<string, string, "defined">;
                reasoningEffort: Schema<string, string, "plain">;
                policy: Schema<Schemastery.ObjectS<NoInfer<{
                    accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                    quotaDomainId: Schema<string, string, "plain">;
                    quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                    poolId: Schema<string, string, "plain">;
                    capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, Schemastery.ObjectT<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, "plain">;
                }>>, Schemastery.ObjectT<NoInfer<{
                    accessMode: Schema<"judgment_api" | "metered_api" | "subscription" | "unknown", "judgment_api" | "metered_api" | "subscription" | "unknown", "plain">;
                    quotaDomainId: Schema<string, string, "plain">;
                    quotaScope: Schema<"account" | "model" | "plan" | "pool" | "unknown", "account" | "model" | "plan" | "pool" | "unknown", "plain">;
                    poolId: Schema<string, string, "plain">;
                    capabilities: Schema<Schemastery.ObjectS<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, Schemastery.ObjectT<NoInfer<{
                        generation: Schema<boolean, boolean, "plain">;
                        structuredOutput: Schema<boolean, boolean, "plain">;
                        vision: Schema<boolean, boolean, "plain">;
                        tools: Schema<boolean, boolean, "plain">;
                    }>>, "plain">;
                }>>, "plain">;
            }>>[], "defined">;
            triggers: Schema<("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[], ("algorithm" | "ambiguous" | "concurrency" | "conflict" | "crossModule" | "financial" | "lowConfidence" | "perf" | "retry" | "security" | "stateMachine")[], "defined">;
        }>>, "plain">;
    }>>, string>>, "volatile-defined">;
    scheduling: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        strategy: Schema<"fifo" | "priority" | "roundRobin", "fifo" | "priority" | "roundRobin", "defined">;
        maxActive: Schema<number, number, "defined">;
        maxPending: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        strategy: Schema<"fifo" | "priority" | "roundRobin", "fifo" | "priority" | "roundRobin", "defined">;
        maxActive: Schema<number, number, "defined">;
        maxPending: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    memory: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        maxMatches: Schema<number, number, "defined">;
        maxChars: Schema<number, number, "defined">;
        ttlMs: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        maxMatches: Schema<number, number, "defined">;
        maxChars: Schema<number, number, "defined">;
        ttlMs: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    rootFallback: Schema<boolean, boolean, "volatile-defined">;
    proactive: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        mode: Schema<"auto" | "observe" | "off", "auto" | "observe" | "off", "defined">;
        rules: Schema<string[], string[], "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        mode: Schema<"auto" | "observe" | "off", "auto" | "observe" | "off", "defined">;
        rules: Schema<string[], string[], "defined">;
    }>>>, "volatile-defined">;
    events: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        journal: Schema<boolean, boolean, "defined">;
        sealAfterBytes: Schema<number, number, "defined">;
        maxLineBytes: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        journal: Schema<boolean, boolean, "defined">;
        sealAfterBytes: Schema<number, number, "defined">;
        maxLineBytes: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    watchdog: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        heartbeatMs: Schema<number, number, "defined">;
        suspectAfterMisses: Schema<number, number, "defined">;
        inputRetryBaseMs: Schema<number, number, "defined">;
        inputRetryMaxMs: Schema<number, number, "defined">;
        quarantineOnUnknownWrite: Schema<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        heartbeatMs: Schema<number, number, "defined">;
        suspectAfterMisses: Schema<number, number, "defined">;
        inputRetryBaseMs: Schema<number, number, "defined">;
        inputRetryMaxMs: Schema<number, number, "defined">;
        quarantineOnUnknownWrite: Schema<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
    router: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        workspaceWrites: Schema<"allow" | "deny", "allow" | "deny", "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        workspaceWrites: Schema<"allow" | "deny", "allow" | "deny", "defined">;
    }>>>, "volatile-defined">;
    approvals: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        mode: Schema<"ask" | "deny" | "inherit", "ask" | "deny" | "inherit", "defined">;
        scope: Schema<("external_mcp" | "jev" | "shell" | "write")[], ("external_mcp" | "jev" | "shell" | "write")[], "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        mode: Schema<"ask" | "deny" | "inherit", "ask" | "deny" | "inherit", "defined">;
        scope: Schema<("external_mcp" | "jev" | "shell" | "write")[], ("external_mcp" | "jev" | "shell" | "write")[], "defined">;
    }>>>, "volatile-defined">;
    nativeEscalation: Schema<"auto" | "manual", "auto" | "manual", "volatile-defined">;
    native: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        codexProvider: Schema<string, string, "defined">;
        codexEditProvider: Schema<string, string, "defined">;
        claudePlanProvider: Schema<string, string, "defined">;
        claudeEditProvider: Schema<string, string, "defined">;
        maxCallsPerSession: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        codexProvider: Schema<string, string, "defined">;
        codexEditProvider: Schema<string, string, "defined">;
        claudePlanProvider: Schema<string, string, "defined">;
        claudeEditProvider: Schema<string, string, "defined">;
        maxCallsPerSession: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    jev: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        source: Schema<"official" | "third-party", "official" | "third-party", "defined">;
        apiKeyEnv: Schema<string, string, "defined">;
        baseUrl: Schema<string, string, "defined">;
        model: Schema<string, string, "defined">;
        thirdParty: Schema<Schemastery.ObjectS<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "defined">;
        }>>, "defined">;
        timeoutMs: Schema<number, number, "defined">;
        maxRetries: Schema<number, number, "defined">;
        maxRequestsPerSecond: Schema<number, number, "defined">;
        maxRequestChars: Schema<number, number, "defined">;
        mathConfidence: Schema<number, number, "defined">;
        benchmarkNoul: Schema<number, number, "defined">;
        noveltyScore: Schema<number, number, "defined">;
        noveltyConfidence: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        source: Schema<"official" | "third-party", "official" | "third-party", "defined">;
        apiKeyEnv: Schema<string, string, "defined">;
        baseUrl: Schema<string, string, "defined">;
        model: Schema<string, string, "defined">;
        thirdParty: Schema<Schemastery.ObjectS<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            provider: Schema<string, string, "defined">;
            model: Schema<string, string, "defined">;
            reasoningEffort: Schema<string, string, "defined">;
        }>>, "defined">;
        timeoutMs: Schema<number, number, "defined">;
        maxRetries: Schema<number, number, "defined">;
        maxRequestsPerSecond: Schema<number, number, "defined">;
        maxRequestChars: Schema<number, number, "defined">;
        mathConfidence: Schema<number, number, "defined">;
        benchmarkNoul: Schema<number, number, "defined">;
        noveltyScore: Schema<number, number, "defined">;
        noveltyConfidence: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    review: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        trustedAbove: Schema<number, number, "defined">;
        doubtfulBelow: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        trustedAbove: Schema<number, number, "defined">;
        doubtfulBelow: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    agents: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        language: Schema<"en" | "ja" | "ko" | "zh-CN" | "zh-TW", "en" | "ja" | "ko" | "zh-CN" | "zh-TW", "defined">;
        languageExclusions: Schema<string[], string[], "defined">;
        session: Schema<"auto" | "continuable" | "oneshot", "auto" | "continuable" | "oneshot", "defined">;
        repeatAbove: Schema<number, number, "defined">;
        sameCategoryAbove: Schema<number, number, "defined">;
        maxRetries: Schema<number, number, "defined">;
        retryBackoffMs: Schema<number, number, "defined">;
        promptStyle: Schema<"auto" | "claude" | "generic" | "gpt", "auto" | "claude" | "generic" | "gpt", "defined">;
        networkWaitMs: Schema<number, number, "defined">;
        rootRecoverMs: Schema<number, number, "defined">;
        networkProbeUrls: Schema<string[], string[], "defined">;
        modelCallDisplay: Schema<"every" | "turn", "every" | "turn", "defined">;
        nativeTeamProjection: Schema<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        language: Schema<"en" | "ja" | "ko" | "zh-CN" | "zh-TW", "en" | "ja" | "ko" | "zh-CN" | "zh-TW", "defined">;
        languageExclusions: Schema<string[], string[], "defined">;
        session: Schema<"auto" | "continuable" | "oneshot", "auto" | "continuable" | "oneshot", "defined">;
        repeatAbove: Schema<number, number, "defined">;
        sameCategoryAbove: Schema<number, number, "defined">;
        maxRetries: Schema<number, number, "defined">;
        retryBackoffMs: Schema<number, number, "defined">;
        promptStyle: Schema<"auto" | "claude" | "generic" | "gpt", "auto" | "claude" | "generic" | "gpt", "defined">;
        networkWaitMs: Schema<number, number, "defined">;
        rootRecoverMs: Schema<number, number, "defined">;
        networkProbeUrls: Schema<string[], string[], "defined">;
        modelCallDisplay: Schema<"every" | "turn", "every" | "turn", "defined">;
        nativeTeamProjection: Schema<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
    budgets: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        maxDelegationsPerTask: Schema<number, number, "defined">;
        maxCallsPerRole: Schema<number, number, "defined">;
        maxCallsZhuJian: Schema<number, number, "defined">;
        maxAutoFixRounds: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        maxDelegationsPerTask: Schema<number, number, "defined">;
        maxCallsPerRole: Schema<number, number, "defined">;
        maxCallsZhuJian: Schema<number, number, "defined">;
        maxAutoFixRounds: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    ledgerDir: Schema<string, string, "volatile-defined">;
    workflow: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        mode: Schema<"advisory" | "enforced" | "off", "advisory" | "enforced" | "off", "defined">;
        maxNodes: Schema<number, number, "defined">;
        maxEdges: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        mode: Schema<"advisory" | "enforced" | "off", "advisory" | "enforced" | "off", "defined">;
        maxNodes: Schema<number, number, "defined">;
        maxEdges: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    planningReview: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        requireJev: Schema<boolean, boolean, "defined">;
        maxFixRounds: Schema<number, number, "defined">;
        timeoutMs: Schema<number, number, "defined">;
        reviewAbove: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        requireJev: Schema<boolean, boolean, "defined">;
        maxFixRounds: Schema<number, number, "defined">;
        timeoutMs: Schema<number, number, "defined">;
        reviewAbove: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    execution: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        profile: Schema<"bounded" | "legacy", "bounded" | "legacy", "defined">;
        maxCalls: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        profile: Schema<"bounded" | "legacy", "bounded" | "legacy", "defined">;
        maxCalls: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    recovery: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        maxTransientRetries: Schema<number, number, "defined">;
        maxLogicalAttempts: Schema<number, number, "defined">;
        maxShortRetryDelayMs: Schema<number, number, "defined">;
        maxTransientWaitMs: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        maxTransientRetries: Schema<number, number, "defined">;
        maxLogicalAttempts: Schema<number, number, "defined">;
        maxShortRetryDelayMs: Schema<number, number, "defined">;
        maxTransientWaitMs: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    persistence: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        directory: Schema<string, string, "defined">;
        maxStateBytes: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        directory: Schema<string, string, "defined">;
        maxStateBytes: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    messageBus: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        maxPending: Schema<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        maxPending: Schema<number, number, "defined">;
    }>>>, "volatile-defined">;
    math: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        enableExtended: Schema<boolean, boolean, "defined">;
        maxCallsPerTask: Schema<number, number, "defined">;
        maxWorkUnitsPerTask: Schema<number, number, "defined">;
        groups: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        operators: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        numericModes: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        limits: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<number, number, "defined">;
        }>>, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
        enableExtended: Schema<boolean, boolean, "defined">;
        maxCallsPerTask: Schema<number, number, "defined">;
        maxWorkUnitsPerTask: Schema<number, number, "defined">;
        groups: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        operators: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        numericModes: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<boolean, boolean, "plain">;
        }>>, "defined">;
        limits: Schema<Schemastery.ObjectS<NoInfer<{
            [k: string]: Schema<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            [k: string]: Schema<number, number, "defined">;
        }>>, "defined">;
    }>>>, "volatile-defined">;
    experience: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        enabled: Schema<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
}>>, "plain">;
/** 原生后端实例配置 */
export interface NativeConfigInfo {
    codexProvider: string;
    codexEditProvider: string;
    claudePlanProvider: string;
    claudeEditProvider: string;
    maxCallsPerSession: number;
}
export declare const DEFAULT_NATIVE_CONFIG: NativeConfigInfo;
/** 某角色的路由 */
export interface RoleRouteInfo {
    chain: RouteInfo[];
    escalation?: EscalationKind;
    upgrade?: UpgradeInfo;
}
/** 衡鉴复评配置（不设调用额度：Jev 单次成本约 $0.00001） */
export interface ReviewConfigInfo extends ReviewThresholdsInfo {
    enabled: boolean;
}
export declare const DEFAULT_REVIEW_CONFIG: ReviewConfigInfo;
/** 专家会话策略 */
export type AgentSessionPolicy = 'auto' | 'oneshot' | 'continuable';
/** 专家的会话与重试策略 */
export interface AgentsConfigInfo {
    language: OutputLanguage;
    languageExclusions: string[];
    session: AgentSessionPolicy;
    repeatAbove: number;
    sameCategoryAbove: number;
    maxRetries: number;
    retryBackoffMs: number;
    /** 提示风格：auto 按模型家族选择 */
    promptStyle: PromptStylePolicy;
    /** 网络中断时等待恢复的最长时间（毫秒），0 为不等待 */
    networkWaitMs: number;
    /** 天枢回退覆盖的有效期（毫秒），到期后重新尝试对话框所选模型；0 为不过期 */
    rootRecoverMs: number;
    /** 联网探测地址 */
    networkProbeUrls: string[];
    /** 聊天窗口「调用模型」行的显示方式（由浏览器端读取） */
    modelCallDisplay: ModelCallDisplay;
    /** 实验性 DSH 原生团队只读投影；默认关闭，百工仍是唯一执行控制器 */
    nativeTeamProjection: boolean;
}
/** every：每次调用都显示；turn：每轮首次调用与换模型时显示 */
export type ModelCallDisplay = 'every' | 'turn';
export declare const DEFAULT_NETWORK_PROBE_URLS: readonly string[];
export declare const DEFAULT_AGENTS_CONFIG: AgentsConfigInfo;
/** 合并默认值后的完整配置 */
export interface SwarmConfigInfo {
    scheduling: {
        strategy: 'fifo' | 'priority' | 'roundRobin';
        maxActive: number;
        maxPending: number;
    };
    memory: {
        enabled: boolean;
        maxMatches: number;
        maxChars: number;
        ttlMs: number;
    };
    approvals: ApprovalsConfigInfo;
    routes: Partial<Record<RouteKey, RoleRouteInfo>>;
    rootFallback: boolean;
    proactive: {
        mode: 'off' | 'observe' | 'auto';
        rules: readonly string[];
    };
    events: {
        journal: boolean;
        sealAfterBytes: number;
        maxLineBytes: number;
    };
    watchdog: {
        enabled: boolean;
        heartbeatMs: number;
        suspectAfterMisses: number;
        inputRetryBaseMs: number;
        inputRetryMaxMs: number;
        quarantineOnUnknownWrite: boolean;
    };
    router: {
        workspaceWrites: 'allow' | 'deny';
    };
    nativeEscalation: 'manual' | 'auto';
    native: NativeConfigInfo;
    jev: JevConfigInfo;
    thresholds: TriageThresholdsInfo;
    review: ReviewConfigInfo;
    agents: AgentsConfigInfo;
    budgets: BudgetInfo;
    ledgerDir: string;
    workflow: {
        mode: 'off' | 'advisory' | 'enforced';
        maxNodes: number;
        maxEdges: number;
    };
    planningReview: {
        enabled: boolean;
        requireJev: boolean;
        maxFixRounds: number;
        reviewAbove: number;
        timeoutMs: number;
    };
    execution: {
        profile: 'legacy' | 'bounded';
        maxCalls: number;
    };
    recovery: {
        maxTransientRetries: number;
        maxLogicalAttempts: number;
        maxShortRetryDelayMs: number;
        maxTransientWaitMs: number;
    };
    persistence: {
        enabled: boolean;
        directory: string;
        maxStateBytes: number;
    };
    messageBus: {
        enabled: boolean;
        maxPending: number;
    };
    math: MathConfigInfo;
    experience: {
        enabled: boolean;
    };
}
export declare const DEFAULT_WORKFLOW_CONFIG: SwarmConfigInfo['workflow'];
export declare const DEFAULT_PLANNING_REVIEW: SwarmConfigInfo['planningReview'];
export declare const DEFAULT_EXECUTION_CONFIG: SwarmConfigInfo['execution'];
export declare const DEFAULT_RECOVERY_CONFIG: SwarmConfigInfo['recovery'];
export declare const DEFAULT_PROACTIVE_CONFIG: SwarmConfigInfo['proactive'];
export declare const DEFAULT_EVENTS_CONFIG: SwarmConfigInfo['events'];
export declare const DEFAULT_WATCHDOG_CONFIG: SwarmConfigInfo['watchdog'];
export declare const DEFAULT_ROUTER_CONFIG: SwarmConfigInfo['router'];
export declare const ROUTE_KEYS: readonly RouteKey[];
/**
 * 读取 Config 当前值并合并默认值；每次调用都重新读取，设置页修改即时生效
 * @param {unknown} raw - 插件收到的 Config（volatile 引用或普通对象）
 * @returns {SwarmConfigInfo} 完整配置
 */
export declare const getSwarmConfig: (raw: unknown) => SwarmConfigInfo;
/**
 * 取某路由键的有效路由：用户覆盖（非空链）优先，否则用内置默认；原生升级通道与容灾升级同理。
 * 容灾升级只在已启用且升级链非空时返回；用户显式停用（enabled: false）时不返回。
 * @param {SwarmConfigInfo} config - 配置
 * @param {RouteKey} key - 路由键
 * @returns {RoleRouteInfo} 路由
 */
export declare const getRoleRoute: (config: SwarmConfigInfo, key: RouteKey) => RoleRouteInfo;
