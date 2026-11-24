/** Enumerates actual files, never guesses a replacement path or follows workspace-external links. */
export declare const discoverProjectFiles: (cwd: string, input?: {
    path?: string;
    query?: string;
    cursor?: string;
    limit?: number;
}, options?: {
    maxEntries?: number;
    privateRoots?: string[];
    signal?: AbortSignal;
}) => Promise<{
    status: 'stale';
    digest: string;
    files: never[];
    nextCursor: null;
    nextAction: string;
    path?: undefined;
    suggestions?: undefined;
    totalMatches?: undefined;
    complete?: undefined;
    indexCapped?: undefined;
    scannedEntries?: undefined;
    unreadable?: undefined;
    skippedLinks?: undefined;
    excludedDirectoryNames?: undefined;
} | {
    status: 'ok';
    digest: string;
    path: string;
    files: string[];
    suggestions: string[];
    totalMatches: number;
    nextCursor: string | null;
    complete: boolean;
    indexCapped: boolean;
    scannedEntries: number;
    unreadable: string[];
    skippedLinks: string[];
    excludedDirectoryNames: string[];
    nextAction: string;
}>;
