import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importLegacyLedgerEvents } from './ledger-event-bridge.js';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isLedgerEvent = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return typeof record.ts === 'string' && typeof record.type === 'string' && typeof record.sessionId === 'string'
        && record.data !== null && typeof record.data === 'object' && !Array.isArray(record.data);
};
/**
 * Import one session's legacy JSONL ledger through the deterministic bridge.
 * The manifest contains hashes and counts only, never event payloads.
 */
export const importLegacyLedgerFile = (input) => {
    const result = { source: input.ledgerPath, imported: 0, skipped: 0, unsupported: 0, invalidLines: 0, rejectedLines: 0 };
    if (!existsSync(input.ledgerPath))
        return result;
    const text = readFileSync(input.ledgerPath, 'utf8');
    const sourceDigest = sha256(text);
    result.sourceDigest = sourceDigest;
    const events = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            result.invalidLines++;
            continue;
        }
        if (!isLedgerEvent(parsed)) {
            result.invalidLines++;
            continue;
        }
        if (parsed.sessionId !== input.rootSessionId) {
            result.rejectedLines++;
            continue;
        }
        events.push(parsed);
    }
    const summary = importLegacyLedgerEvents(input.journal, events);
    Object.assign(result, summary);
    const manifests = join(input.journal.path, '..', 'imports');
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    const manifestPath = join(manifests, `legacy-${sha256(input.rootSessionId).slice(0, 16)}.json`);
    const manifest = {
        schemaVersion: 1,
        source: input.ledgerPath,
        sourceDigest,
        rootSessionId: input.rootSessionId,
        imported: result.imported,
        skipped: result.skipped,
        unsupported: result.unsupported,
        invalidLines: result.invalidLines,
        rejectedLines: result.rejectedLines,
        journalSegments: input.journal.segments().length,
        at: (input.now?.() ?? new Date()).toISOString()
    };
    const temporary = `${manifestPath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, manifestPath);
    result.manifestPath = manifestPath;
    return result;
};
export const isLegacyLedgerEventType = (value) => value.length > 0 && value.includes('/');
//# sourceMappingURL=event-import.js.map