import { describe, expect, it } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { ROLE_INFO_LIST } from '../../src/role-registry.js'
import { DEFAULT_ROUTE_CHAINS } from '../../src/domain/routing/routes.js'
import { EVENT_FILTER_REASONS } from '../../src/router-worker.js'
import { ACCEPT_MODES } from '../../src/domain/tickets/lifecycle.js'
import { getJevToolDefinitions } from '../../src/jev-tools.js'
import { getBoundTaskToolDefinitions } from '../../src/task-tools.js'
import { getSwarmToolDefinitions } from '../../src/tools.js'
import { getValueDigest } from '../../src/workflow.js'

const getGoldenSnapshot = () => {
  const config = getSwarmConfig(undefined)
  const service = {
    getConfig: () => config,
    jev: { tools: {} },
    AddTaskCard: () => undefined,
    delegate: () => undefined,
    getStatus: () => undefined,
    AcceptTask: () => undefined,
    ReviewPlan: () => undefined,
    Experience: () => undefined,
    ReadContext: () => undefined,
    ProjectFiles: () => undefined,
    Calculate: () => undefined,
    MessageSend: () => undefined,
    MessageRead: () => undefined,
    MessageAck: () => undefined
  }
  return {
    schemaVersion: 1,
    roles: ROLE_INFO_LIST.map((role) => ({
      id: role.id,
      presetId: role.presetId,
      permission: role.permission,
      capabilities: [...role.capabilities],
      web: role.web,
      needsVision: role.needsVision
    })),
    routes: Object.fromEntries(Object.entries(DEFAULT_ROUTE_CHAINS).sort(([left], [right]) => left.localeCompare(right))),
    tools: {
      root: getSwarmToolDefinitions(service as never).map((tool) => tool.name),
      bounded: getBoundTaskToolDefinitions(service as never).map((tool) => tool.name),
      jev: getJevToolDefinitions(() => service.jev.tools as never).map((tool) => tool.name)
    },
    policy: {
      rootFallback: config.rootFallback,
      workflow: config.workflow,
      planningReview: config.planningReview,
      agents: config.agents,
      budgets: config.budgets,
      messageBus: config.messageBus
    },
    protocols: { eventFilterReasons: EVENT_FILTER_REASONS, acceptModes: ACCEPT_MODES }
  }
}

describe('3.2.1 strangler golden baseline', () => {
  it('keeps public roles, routes, tools and policy semantics stable across the v3.3.0 migration', () => {
    const snapshot = getGoldenSnapshot()
    expect(snapshot.roles.map((role) => role.id)).toHaveLength(13)
    expect(snapshot.tools.root).toEqual(expect.arrayContaining(['swarm_task_card', 'swarm_delegate', 'swarm_status', 'swarm_accept']))
    expect(snapshot.tools.jev).toEqual(expect.arrayContaining(['jev_ask', 'jev_check', 'jev_classify', 'jev_score', 'jev_match', 'jev_screen', 'jev_health']))
    expect(getValueDigest(snapshot)).toBe('7c7175e3ebe622dbae0d2cd7334e9b53ea69a358917d4f219c03e13a1a2f0392')
  })
})
