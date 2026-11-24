export type ProactiveMode = 'off' | 'observe' | 'auto';
export type TriggerActorKind = 'human' | 'bot' | 'system';
export type TriggerStrength = 'explicit' | 'inferred';
export type TriggerDisposition = 'accepted' | 'would-accept' | 'ignored' | 'filtered';
export interface SourceInstance {
    schemaVersion: 1;
    id: string;
    kind: string;
    enabled: boolean;
    selfActor?: string;
    botActors: string[];
    allowedActors: string[];
    ignoredThreads: string[];
    replyChannels: string[];
}
export interface TriggerMandate {
    title: string;
    goal: string;
    acceptance: string[];
    scope: string[];
    flags: Record<string, boolean>;
}
export interface TriggerInput {
    sourceId: string;
    externalId: string;
    threadId: string;
    actorId: string;
    actorKind: TriggerActorKind;
    addressed: boolean;
    preview: string;
    topics: string[];
    ruleIds: string[];
    replyChannel?: string;
    mandate?: TriggerMandate;
}
export interface TriggerFact extends TriggerInput {
    schemaVersion: 1;
    id: string;
    at: string;
    contentDigest: string;
    strength?: TriggerStrength;
}
export interface SourceThread {
    schemaVersion: 1;
    id: string;
    sourceId: string;
    threadId: string;
    openedAt: string;
    lastAt: string;
}
export interface SourceSubscription {
    schemaVersion: 1;
    id: string;
    sourceId: string;
    threadId: string;
    ticketId: string;
    contextOnly: boolean;
    createdAt: string;
    endedAt?: string;
}
export interface TriggerDecision {
    schemaVersion: 1;
    disposition: TriggerDisposition;
    reason: string;
    policyVersion: string;
    matchedRules: string[];
}
export declare const ValidateSourceInstance: (raw: unknown) => raw is SourceInstance;
export declare const ValidateSourceThread: (raw: unknown) => raw is SourceThread;
export declare const ValidateSourceSubscription: (raw: unknown) => raw is SourceSubscription;
export declare const createSourceInstance: (input: Omit<SourceInstance, 'schemaVersion' | 'selfActor' | 'botActors' | 'allowedActors' | 'ignoredThreads' | 'replyChannels'> & Partial<Pick<SourceInstance, 'selfActor' | 'botActors' | 'allowedActors' | 'ignoredThreads' | 'replyChannels'>>) => SourceInstance;
export declare const normalizeTrigger: (source: SourceInstance, input: TriggerInput, now: Date) => TriggerFact | {
    filtered: string;
};
export declare const getPolicyVersion: (mode: ProactiveMode, rules: readonly string[]) => string;
export declare const evaluateTrigger: (trigger: TriggerFact, input: {
    mode: ProactiveMode;
    rules: readonly string[];
    hasActiveTicket?: boolean;
    hasMandate?: boolean;
}) => TriggerDecision;
