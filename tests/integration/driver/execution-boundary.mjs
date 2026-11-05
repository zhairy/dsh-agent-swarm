import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
// Read the active bundle's carrier, including when testing an extracted tarball.
const getExecutionBoundaryCarrier = () => globalThis[Symbol.for('dsh-agent-swarm.execution-boundary.v1')]

export const name = 'swarm-execution-boundary-proof'
export const inject = ['llm', 'agents', 'agentPresets', 'subagents', 'tools', 'workingDirectory', 'fs']
const outputs = JSON.parse(readFileSync(new URL('../../fixtures/valid-outputs.json', import.meta.url), 'utf8'))
const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
function* text(value) { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: value }; yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }; yield { type: 'finish', reason: { kind: 'stop' } } }
function* call(name, args) { if (name === 'bash') args = { description: 'isolated execution-boundary fixture', ...args }; const id = `proof-${randomUUID()}`, value = JSON.stringify(args); yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: value }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: value } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } }
const writeArgs = (options, path, content) => { const properties = (options.tools || []).find(tool => tool.name === 'write')?.parameters?.properties || {}; const keys = Object.keys(properties); return { [keys.find(key => /path|file/i.test(key)) || 'path']: path, [keys.find(key => /content|text|data/i.test(key)) || 'content']: content } }

export const apply = ctx => {
  const fixture = JSON.parse(readFileSync(process.env.SWARM_BOUNDARY_FIXTURE, 'utf8'))
  const phase = process.env.SWARM_BOUNDARY_PHASE || 'live'
  const state = { phase, results: [], requests: 0, children: [], driftPrevented: false, snapshotRetained: false, oldOwnerDenied: false, fsBoundaryDenied: false }
  const steps = new Map(), roles = new Map()
  let root, worktreeId, checkout = fixture.path, beforeRestore
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', checkout, ...args], { encoding: 'utf8' }).trimEnd()
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  const snapshot = () => ({ head: git('rev-parse', 'HEAD'), branch: git('symbolic-ref', 'HEAD'), status: git('status', '--porcelain=v1', '-z'), index: hash(join(git('rev-parse', '--absolute-git-dir'), 'index')), inside: hash(join(checkout, 'allowed/inside.txt')), denied: hash(join(checkout, 'denied.txt')) })
  const adapter = {
    providerInfo: id => ({ id, name: 'isolated boundary mock' }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    listModels: async () => [], resolveModel: async (provider, id) => ({ provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 1000000 }, defaultMaxTokens: 32000 }),
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) } },
    async *stream(options) {
      if (options.purpose) { yield* text('fixture'); return }
      state.requests++
      const id = String(options.sessionId)
      if (!steps.has(id)) { steps.set(id, 0); roles.set(id, state.children.length); state.children.push(id) }
      const step = steps.get(id), position = roles.get(id); steps.set(id, step + 1)
      if (phase === 'cold') {
        if (step === 0) { yield* call('swarm_restore_worktree', { worktree_id: fixture.worktreeId }); return }
      } else if (position === 0) {
        const actions = [
          () => call('create_worktree', { name: 'boundary-case' }),
          () => call('bash', { command: 'printf inside-ok > allowed/inside.txt' }),
          () => call('bash', { command: 'cd ../../.. && printf tree-escape > source.txt' }),
          () => call('bash', { command: 'printf scope-escape > denied.txt' }),
          () => call('bash', { command: 'printf workdir-escape > source.txt', workdir: fixture.repositoryRoot }),
          () => call('write', writeArgs(options, 'allowed/file-tool.txt', 'file-ok')),
          () => call('write', writeArgs(options, 'denied.txt', 'file-escape')),
          () => call('write', writeArgs(options, 'allowed/race-file.txt', 'late-file-escape')),
          () => call('bash', { command: 'printf drift-escape > allowed/drift.txt' }),
          () => call('bash', { command: 'bwrap --bind / / -- /bin/sh -c "printf nested-escape > denied.txt"' })
        ]
        if (actions[step]) { yield* actions[step](); return }
      } else if (step === 0) { yield* call('swarm_context_read', {}); return }
      else if (step === 1) { yield* call('swarm_restore_worktree', { worktree_id: worktreeId }); return }
      else if (step === 2) { yield* call('bash', { command: 'printf second-owner > allowed/second.txt' }); return }
      if ((options.tools || []).some(tool => tool.name === 'structured_output')) {
        if (textOf(options.messages?.at(-1)).includes('structured_output')) { yield* text('DONE'); return }
        yield* call('structured_output', outputs.zhu_jian); return
      }
      yield* text(`完成。\n\`\`\`json\n${JSON.stringify(outputs.zhu_jian)}\n\`\`\``)
    }
  }
  ctx.llm.registerAdapter(['swarm-boundary-mock'], adapter)
  ctx.on('tools/execute', async (execution, next) => {
    if (execution.agent?.session?.header?.parentSession !== root?.id) return next()
    if (execution.name === 'write' && Object.values(execution.arguments || {}).includes('allowed/race-file.txt')) {
      const filesystem = ctx.fs, original = filesystem.writeText
      filesystem.writeText = async function (target, ...args) {
        assert.ok(getExecutionBoundaryCarrier().storage.getStore(), 'file fault must be inside the actual boundary')
        const outside = await filesystem.resolve(join(fixture.repositoryRoot, 'source.txt'))
        try { return await original.call(filesystem, outside, ...args) }
        catch (error) { state.fsBoundaryDenied = true; throw error }
      }
      try { return await next() } finally { filesystem.writeText = original }
    }
    if (execution.name !== 'bash' || execution.arguments?.command !== 'printf drift-escape > allowed/drift.txt') return next()
    const directories = ctx.workingDirectory, original = directories.ensure
    directories.ensure = async function (agent, signal) {
      assert.ok(getExecutionBoundaryCarrier().storage.getStore(), 'CWD fault must be inside the actual boundary')
      const saved = `${checkout}-saved`
      renameSync(checkout, saved)
      try { return await original.call(directories, agent, signal) }
      finally { state.driftPrevented = directories.get(agent.session) === checkout; renameSync(saved, checkout) }
    }
    try { return await next() } finally { directories.ensure = original }
  })
  ctx.on('tools/result', (execution, result) => {
    if (execution.agent?.session?.header?.parentSession !== root?.id) return
    state.results.push({ agentId: execution.agent.id, tool: execution.name, command: execution.arguments?.command, isError: result.isError, exitCode: result.value?.exitCode,
      text: result.isError ? textOf(result).slice(0, 240) : undefined })
    if (execution.name === 'create_worktree' && !result.isError) checkout = result.value.path
    if (execution.name === 'swarm_restore_worktree' && !result.isError && beforeRestore) state.snapshotRetained = JSON.stringify(snapshot()) === JSON.stringify(beforeRestore)
  })
  const run = async () => {
    for (let i = 0;; i++) {
      try { await ctx.agentPresets.resolve('tian-shu'); if (ctx.get('agentSwarm')) break } catch {}
      if (i > 100) throw new Error('Swarm preset did not activate')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const composition = { agentOptions: { provider: 'swarm-boundary-mock', model: 'root' }, setup: async childCtx => { await ctx.agentPresets.mount(childCtx, 'tian-shu') } }
    const handle = phase === 'cold'
      ? await ctx.agents.resume({ resumeSessionId: fixture.rootId, ...composition })
      : await ctx.agents.create({ sessionId: fixture.rootId, meta: { cwd: fixture.repositoryRoot, agentPreset: 'tian-shu' }, ...composition })
    root = handle.agent
    const service = ctx.get('agentSwarm'), exec = { agent: root, signal: new AbortController().signal }
    const task = phase !== 'cold' ? await service.AddTaskCard({ title: 'Boundary proof', goal: 'Operate only inside the admitted worktree scope', acceptance: ['no escape'], scope: ['allowed'], flags: {} }, exec) : { task_id: fixture.taskId }
    if (phase === 'unsupported') {
      await assert.rejects(service.delegate({ task_id: task.task_id, role: 'zhu_jian', prompt: 'must not start', session: 'oneshot', backend: 'api' }, exec), /桥接未就绪/)
      assert.equal(state.requests, 0)
      assert.equal(existsSync(checkout), false)
      state.unsupportedHostBlocked = true
    } else if (phase === 'cold') {
      await service.WaitAgentReady(root)
      await service.delegate({ task_id: task.task_id, role: 'zhu_jian', prompt: 'Read-only proof: explicitly request restoration, then report the denial.', session: 'oneshot', backend: 'api' }, exec)
      assert.ok(state.results.some(row => row.tool === 'swarm_restore_worktree' && row.isError && /停净证明/.test(row.text)))
      assert.equal(existsSync(join(checkout, 'allowed/cold-write.txt')), false)
      state.coldWriteGrantDenied = true
    } else {
      await service.delegate({ task_id: task.task_id, role: 'zhu_jian', prompt: 'Execute the bounded temporary fixture cases.', session: 'oneshot', backend: 'api' }, exec)
      const view = service.getTaskViewForRpc(root.id, task.task_id)
      worktreeId = view.worktrees[0].worktreeId
      beforeRestore = snapshot()
      assert.equal(readFileSync(join(checkout, 'allowed/inside.txt'), 'utf8'), 'inside-ok')
      assert.equal(readFileSync(join(checkout, 'allowed/file-tool.txt'), 'utf8'), 'file-ok')
      assert.equal(readFileSync(join(checkout, 'denied.txt'), 'utf8'), 'scope-protected')
      assert.equal(readFileSync(join(fixture.repositoryRoot, 'source.txt'), 'utf8'), 'source-protected')
      assert.equal(readFileSync(join(fixture.repositoryRoot, 'allowed/drift.txt'), 'utf8'), 'source-drift-protected')
      assert.equal(state.driftPrevented, true)
      for (const command of ['cd ../../.. && printf tree-escape > source.txt', 'printf scope-escape > denied.txt', 'printf workdir-escape > source.txt', 'printf drift-escape > allowed/drift.txt', 'bwrap --bind / / -- /bin/sh -c "printf nested-escape > denied.txt"']) {
        const result = state.results.find(row => row.command === command)
        assert.ok(result && (result.isError || typeof result.exitCode === 'number' && result.exitCode !== 0), `escape was not refused: ${command}`)
      }
      assert.deepEqual(state.results.filter(row => row.tool === 'write').map(row => row.isError), [false, true, true])
      assert.equal(state.fsBoundaryDenied, true)
      await service.delegate({ task_id: task.task_id, role: 'zhu_jian', prompt: 'Explicitly restore the retained tree in this new attempt, then write only inside allowed.', session: 'oneshot', backend: 'api' }, exec)
      assert.equal(state.snapshotRetained, true)
      assert.equal(readFileSync(join(checkout, 'allowed/second.txt'), 'utf8'), 'second-owner')
      const old = { id: state.children[0], session: { header: { parentSession: root.id, agentPreset: 'zhu-jian', cwd: fixture.repositoryRoot } } }
      state.oldOwnerDenied = service.getGuardReason({ name: 'write', agent: old, arguments: { path: 'allowed/late.txt' } }) !== undefined
      assert.equal(state.oldOwnerDenied, true)
      writeFileSync(process.env.SWARM_BOUNDARY_FIXTURE, JSON.stringify({ ...fixture, taskId: task.task_id, path: checkout, worktreeId }), { mode: 0o600 })
    }
    await service.dispose()
    await handle.dispose()
    return { ...state, status: 'passed', realHost: '0.2.2-rc.1', llm: 'local mock', workspace: checkout }
  }
  setTimeout(() => { void run().then(result => { writeFileSync(process.env.SWARM_BOUNDARY_OUT, JSON.stringify(result, null, 2), { mode: 0o600 }); setTimeout(() => process.exit(0), 100) }, error => { writeFileSync(process.env.SWARM_BOUNDARY_OUT, JSON.stringify({ ...state, status: 'failed', error: String(error?.stack ?? error) }, null, 2), { mode: 0o600 }); setTimeout(() => process.exit(1), 100) }) }, 500)
  setTimeout(() => process.exit(2), 120000).unref()
}
