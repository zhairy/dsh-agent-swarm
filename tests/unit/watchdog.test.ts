import { describe, expect, it, vi } from 'vitest'
import { createSwarmWatchdog, inspectWatchdog } from '../../src/watchdog.js'

describe('v3.2.0 swarm watchdog', () => {
  it('detects stale heartbeats and expired leases without replacing the assignment', () => {
    const result = inspectWatchdog({ now: 31_000, config: { heartbeatMs: 10_000, suspectAfterMisses: 2 },
      assignments: [{ id: 'D-1', ticketId: 'T-1', state: 'running', startedAt: 1_000, lastHeartbeatAt: 10_000 }],
      tickets: [{ id: 'T-1', activeAssignmentId: 'D-1', pendingInputs: [], leaseExpiresAt: 20_000 }] })
    expect(result.alerts.map((alert) => alert.kind)).toEqual(['stale-assignment', 'lease-expired'])
    expect(result.quarantineTicketIds).toEqual([])
  })

  it('quarantines unknown writes and emits bounded input retry alerts', () => {
    const alert = vi.fn()
    const watchdog = createSwarmWatchdog({ onAlert: alert })
    const result = watchdog.evaluate({ now: 9_000,
      assignments: [{ id: 'D-1', ticketId: 'T-1', state: 'running', startedAt: 0, unknownSideEffect: true }],
      tickets: [{ id: 'T-1', activeAssignmentId: 'D-1', pendingInputs: [{ id: 'I-1', firstAttemptAt: 0, attempts: 3, lastError: 'offline' }] }] })
    expect(result.quarantineTicketIds).toEqual(['T-1'])
    expect(result.alerts.map((item) => item.kind)).toContain('unknown-side-effect')
    expect(alert).toHaveBeenCalled()
  })
})
