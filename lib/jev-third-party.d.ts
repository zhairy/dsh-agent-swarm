import { type JevClient, type JevConfigInfo } from './jev.js';
type TextStreamChunk = {
    type: string;
    text?: string;
    usage?: Record<string, unknown>;
    reason?: string | {
        kind?: string;
        failure?: {
            code?: string;
            status?: number;
            message?: string;
        };
    };
};
export interface ThirdPartyJevLlmLike {
    stream: (options: {
        provider: string;
        model: string;
        reasoningEffort?: string;
        system?: string;
        messages: Array<{
            role: 'user';
            content: Array<{
                type: 'text';
                text: string;
            }>;
        }>;
        signal?: AbortSignal;
    }) => AsyncIterable<TextStreamChunk>;
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown>;
}
export declare const getThirdPartyJevSelection: (config: JevConfigInfo) => {
    provider: string;
    model: string;
    reasoningEffort?: string;
} | undefined;
/** JEV protocol adapter over a DSH-selected third-party model. */
export declare const intThirdPartyJevClient: (config: JevConfigInfo, deps: {
    getLlm: () => ThirdPartyJevLlmLike | undefined;
    now?: () => number;
}) => JevClient;
export {};
