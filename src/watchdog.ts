export interface WatchdogConfig {
  heartbeatMs: number
  suspectAfterMisses: number
  inputRetryBaseMs: number
  inputRetryMaxMs: number
  quarantineOnUnknownWrite: boolean
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  heartbeatMs: 15_000,
  suspectAfterMisses: 2,
  inputRetryBaseMs: 2_000,
  inputRetryMaxMs: 60_000,
  quarantineOnUnknownWrite: true
}

export interface WatchdogAssignment { id: string; ticketId: string; state: 'queued' | 'running' | 'ended'; startedAt: number; lastHeartbeatAt?: number; unknownSideEffect?: boolean }
export interface PendingInput { id: string; firstAttemptAt: number; attempts: number; lastError?: string }
export interface WatchdogTicket { id: string; activeAssignmentId?: string; pendingInputs: PendingInput[]; leaseExpiresAt?: number; quarantined?: boolean }
export interface WatchdogInput { now: number; assignments: readonly WatchdogAssignment[]; tickets: readonly WatchdogTicket[]; config?: Partial<WatchdogConfig> }
export interface WatchdogAlert { id: string; severity: 'info' | 'warning' | 'critical'; kind: 'stale-assignment' | 'input-delivery' | 'lease-expired' | 'unknown-side-effect'; ticketId?: string; assignmentId?: string; detail: string }

const mergeConfig = (input?: Partial<WatchdogConfig>): WatchdogConfig => ({ ...DEFAULT_WATCHDOG_CONFIG, ...input })
const retryDelay = (attempts: number, config: WatchdogConfig): number => Math.min(config.inputRetryMaxMs, config.inputRetryBaseMs * 2 ** Math.max(0, Math.min(16, attempts)))

/** Inspect persisted facts only; the watchdog never launches a new write or replays an assignment. */
export const inspectWatchdog = (input: WatchdogInput): { alerts: WatchdogAlert[]; quarantineTicketIds: string[] } => {
  const config = mergeConfig(input.config), alerts: WatchdogAlert[] = [], quarantine = new Set<string>()
  const ticketById = new Map(input.tickets.map((ticket) => [ticket.id, ticket]))
  for (const assignment of input.assignments) {
    if (assignment.state !== 'running') continue
    const ticket = ticketById.get(assignment.ticketId)
    if (assignment.unknownSideEffect === true && config.quarantineOnUnknownWrite) {
      quarantine.add(assignment.ticketId)
      alerts.push({ id: `unknown-write:${assignment.id}`, severity: 'critical', kind: 'unknown-side-effect', ticketId: assignment.ticketId, assignmentId: assignment.id, detail: 'Assignment stopped with an unknown external side effect; read-only reconciliation is required' })
      continue
    }
    const heartbeatAt = assignment.lastHeartbeatAt ?? assignment.startedAt
    if (input.now - heartbeatAt >= config.heartbeatMs * config.suspectAfterMisses) {
      alerts.push({ id: `stale:${assignment.id}`, severity: 'warning', kind: 'stale-assignment', ticketId: assignment.ticketId, assignmentId: assignment.id, detail: 'Assignment heartbeat is stale; automatic dispatch should pause pending reconciliation' })
    }
    if (ticket?.leaseExpiresAt !== undefined && ticket.leaseExpiresAt <= input.now) {
      alerts.push({ id: `lease:${assignment.ticketId}`, severity: 'warning', kind: 'lease-expired', ticketId: assignment.ticketId, assignmentId: assignment.id, detail: 'Workspace lease expired while the assignment still reports running' })
    }
  }
  for (const ticket of input.tickets) {
    for (const pending of ticket.pendingInputs) {
      const due = pending.firstAttemptAt + retryDelay(pending.attempts, config)
      if (input.now < due) continue
      alerts.push({ id: `input:${pending.id}`, severity: pending.attempts >= 3 ? 'warning' : 'info', kind: 'input-delivery', ticketId: ticket.id, detail: `${pending.id} remains undelivered after ${pending.attempts} attempts${pending.lastError === undefined ? '' : `: ${pending.lastError}`}` })
    }
  }
  return { alerts, quarantineTicketIds: [...quarantine] }
}

export interface SwarmWatchdog {
  evaluate: (input: Omit<WatchdogInput, 'config'>) => ReturnType<typeof inspectWatchdog>
  updateConfig: (value: Partial<WatchdogConfig>) => void
}

export const createSwarmWatchdog = (options: { config?: Partial<WatchdogConfig>; onAlert?: (alert: WatchdogAlert) => void } = {}): SwarmWatchdog => {
  let config = mergeConfig(options.config)
  return {
    evaluate: (input) => {
      const result = inspectWatchdog({ ...input, config })
      for (const alert of result.alerts) options.onAlert?.(alert)
      return result
    },
    updateConfig: (value) => { config = mergeConfig({ ...config, ...value }) }
  }
}
