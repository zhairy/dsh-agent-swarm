import { type QuotaReader, type QuotaRpcInvoke } from '../../domain/routing/resources.js';
import { type QuotaPoolConfiguration } from '../../domain/routing/quota.js';
import type { RouteInfo } from '../../domain/routing/routes.js';
export interface QuotaRoutingSource {
    orderQuotaRoutes: (routes: readonly RouteInfo[], signal?: AbortSignal, protectedRoutes?: readonly RouteInfo[]) => Promise<readonly RouteInfo[]>;
    succeeded: (route: RouteInfo) => void;
    invalidate: () => void;
    diagnostics: () => unknown;
    dispose: () => void;
}
/** Ephemeral source, separate from contracts, health tombstones and numerical task budgets. */
export declare const createQuotaRoutingSource: (deps: {
    reader: QuotaReader;
    invoke: QuotaRpcInvoke;
    getPoolConfiguration: () => QuotaPoolConfiguration | undefined;
    getRegisteredProviders: () => readonly string[];
    available: () => boolean;
    now?: () => number;
    waitMs?: number;
}) => QuotaRoutingSource;
