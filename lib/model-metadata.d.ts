export interface AuthoritativeModelMetadata {
    contextWindow: number;
    maxTokens: number;
    source: string;
    verifiedAt: string;
}
/**
 * pi-ai 1.5.0 still carries 272K for several direct OpenAI models. OpenAI
 * documents 272K only as the long-context price boundary; the actual API
 * context window is 1.05M for this model family.
 *
 * Keep this correction scoped to the direct `openai` API provider. Codex and
 * ChatGPT Work subscriptions have their own lower default context windows, and
 * third-party gateways may impose additional limits.
 */
export declare const OPENAI_API_MODEL_METADATA: Readonly<Record<string, AuthoritativeModelMetadata>>;
export declare const getAuthoritativeModelMetadata: (provider: string, model: string) => AuthoritativeModelMetadata | undefined;
export interface ModelMetadataMismatch {
    id: string;
    field: 'contextWindow';
    actual: number | undefined;
    expected: number;
    source: string;
}
export declare const getOpenAIAPIMetadataMismatches: (models: readonly {
    id: string;
    contextWindow?: number;
}[]) => ModelMetadataMismatch[];
