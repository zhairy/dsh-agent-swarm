import { getToolDefinition, type ToolDefinitionLike, type ToolExecLike } from './tool-shape.js'
import { CALCULATE_PARAMETERS } from './math/schema.js'

/** Registration is intentionally owned by the service, which checks identity and task budgets. */
export const getMathToolDefinitions = (deps: { calculate: (raw: unknown, exec: ToolExecLike) => Promise<unknown> }): ToolDefinitionLike[] => [
  getToolDefinition({
    name: 'swarm_calculate',
    description: 'Bounded deterministic mathematical computation. Fixed operators only; computed values are evidence for supplied inputs, never a general proof.',
    parameters: CALCULATE_PARAMETERS,
    execute: deps.calculate,
    render: (_args: unknown, result: unknown) => JSON.stringify(result),
    isConcurrencySafe: () => false
  })
]
