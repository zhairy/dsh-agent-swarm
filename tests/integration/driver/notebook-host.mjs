import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

const VALID_OUTPUTS = JSON.parse(readFileSync(new URL('../../fixtures/valid-outputs.json', import.meta.url), 'utf8'))
const NOTEBOOK_RUNTIME_KEY = Symbol.for('dsh-agent-swarm.notebook-runtime.v1')
const EXECUTION_BOUNDARY_KEY = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
const BROWSER_SERVER = `
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const portFile = process.argv[2]
const server = createServer((request, response) => {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8'
  })
  response.end('<!doctype html><html><body><h1>managed-browser-42</h1><p>Node24 private loopback</p><button>Keep</button></body></html>')
})
const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const fd = openSync(portFile, 'w', 0o600)
  try {
    writeFileSync(fd, String(address.port), 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  process.stdout.write(JSON.stringify({ pid: process.pid, port: address.port }) + '\\n')
})
`
const BROWSER_SERVER_BASE64 = Buffer.from(BROWSER_SERVER).toString('base64')
const FUHE_BASH_COMMAND = [
  'set -eu',
  'tmpdir=/dev/shm',
  'export TMPDIR="$tmpdir"',
  'test -d "$tmpdir"',
  'test -w "$tmpdir"',
  'work="$(mktemp -d "$tmpdir/fu-he-node.XXXXXX")"',
  'trap \'rm -rf "$work"\' EXIT',
  'test "$(node -p \'process.versions.node.split(".")[0]\')" = 24',
  'printf \'%s\\n\' \'const value = 40 + 2\' \'console.log(value)\' > "$work/check.mjs"',
  'printf \'%s\\n\' \'const value: number = 40 + 2\' \'console.log(value)\' > "$work/check.ts"',
  'js_raw="$(node "$work/check.mjs")"',
  'ts_raw="$(node --experimental-strip-types "$work/check.ts")"',
  'e2e_raw="$(node -e \'process.stdout.write("42\\n")\')"',
  'test "$js_raw" = 42',
  'test "$ts_raw" = 42',
  'test "$e2e_raw" = 42',
  'printf \'NODE_JS_RAW=%s\\nNODE_TS_RAW=%s\\nNODE_E2E_RAW=%s\\n\' "$js_raw" "$ts_raw" "$e2e_raw"'
].join('\n')
const FUHE_BROWSER_COMMAND = [
  'set -eu',
  'tmpdir=/dev/shm',
  'test -d "$tmpdir"',
  'test -w "$tmpdir"',
  'work="$(mktemp -d "$tmpdir/fu-he-browser.XXXXXX")"',
  'browser_session="fuhe-browser-$(basename "$work")"',
  'current_step=init',
  'server_pid=""',
  'cleanup() {',
  '  status=$?',
  '  if [ "$status" -ne 0 ]; then',
  '    printf \'BROWSER_FAILURE_STATUS=%s\\nBROWSER_FAILURE_STEP=%s\\n\' "$status" "$current_step"',
  '    for diagnostic in server.json server.err open.json open.err wait.txt wait.err text.err snapshot.json snapshot.err close.txt close.err sessions.json sessions.err cleanup-close.txt cleanup-close.err; do',
  '      if [ -f "$work/$diagnostic" ]; then',
  '        printf \'BROWSER_DIAGNOSTIC_BEGIN=%s\\n\' "$diagnostic"',
  '        sed -n \'1,120p\' "$work/$diagnostic"',
  '        printf \'BROWSER_DIAGNOSTIC_END=%s\\n\' "$diagnostic"',
  '      fi',
  '    done',
  '  fi',
  '  if [ -n "${browser_bin:-}" ]; then',
  '    "$browser_bin" --session "$browser_session" close > "$work/cleanup-close.txt" 2> "$work/cleanup-close.err" || true',
  '  fi',
  '  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then',
  '    kill -TERM "$server_pid" 2>/dev/null || true',
  '    wait "$server_pid" 2>/dev/null || true',
  '  fi',
  '  rm -rf "$work"',
  '  exit "$status"',
  '}',
  'trap cleanup EXIT',
  'current_step=browser-path',
  'browser_bin=/home/zhairy/.npm-global/bin/agent-browser',
  'browser_exe="$(find /home/zhairy/.agent-browser/browsers -type f -path "*/chrome" | sort -V | tail -n 1)"',
  'test -x "$browser_bin"',
  'test -x "$browser_exe"',
  'current_step=server-source',
  `printf '%s' '${BROWSER_SERVER_BASE64}' | base64 -d > "$work/server.mjs"`,
  'mkdir -p "$work/config" "$work/run" "$work/tmp"',
  'browser_config="$work/config/agent-browser.json"',
  'printf \'{"executablePath":"%s","idleTimeoutMs":2000,"restoreSave":"never"}\\n\' "$browser_exe" > "$browser_config"',
  'export TMPDIR="$work/tmp"',
  'export AGENT_BROWSER_ALLOWED_DOMAINS=127.0.0.1',
  'export AGENT_BROWSER_EXECUTABLE_PATH="$browser_exe"',
  'export AGENT_BROWSER_IDLE_TIMEOUT_MS=2000',
  'export AGENT_BROWSER_RESTORE_SAVE=never',
  'export AGENT_BROWSER_SOCKET_DIR="$work/run/agent-browser"',
  'unset AGENT_BROWSER_AUTO_CONNECT AGENT_BROWSER_CDP AGENT_BROWSER_PROFILE AGENT_BROWSER_PROVIDER AGENT_BROWSER_STATE',
  'browser() { "$browser_bin" --config "$browser_config" --session "$browser_session" "$@"; }',
  'current_step=server-start',
  'node "$work/server.mjs" "$work/port" > "$work/server.json" 2> "$work/server.err" &',
  'server_pid=$!',
  'for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do',
  '  if [ -s "$work/port" ]; then break; fi',
  '  sleep 0.1',
  'done',
  'test -s "$work/port"',
  'port="$(cat "$work/port")"',
  'current_step=browser-open',
  'browser open "http://127.0.0.1:$port/" > "$work/open.json" 2> "$work/open.err"',
  'current_step=browser-wait',
  'browser wait --text managed-browser-42 > "$work/wait.txt" 2> "$work/wait.err"',
  'current_step=browser-text',
  'browser_text="$(browser get text body 2> "$work/text.err")"',
  'current_step=browser-snapshot',
  'browser snapshot -i --json > "$work/snapshot.json" 2> "$work/snapshot.err"',
  'printf "%s" "$browser_text" | grep -Fq managed-browser-42',
  'grep -Fq \'"role":"button"\' "$work/snapshot.json"',
  'current_step=browser-close',
  'browser close > "$work/close.txt" 2> "$work/close.err"',
  'current_step=browser-sessions',
  '"$browser_bin" --config "$browser_config" session list --json > "$work/sessions.json" 2> "$work/sessions.err"',
  'if grep -Fq "\\"$browser_session\\"" "$work/sessions.json"; then exit 1; fi',
  'current_step=server-stop',
  'kill -TERM "$server_pid"',
  'wait "$server_pid"',
  'server_pid=""',
  'printf \'BROWSER_TEXT_START\\n%s\\nBROWSER_TEXT_END\\nBROWSER_CLOSED=true\\nSERVER_STOPPED=true\\nBROWSER_SESSION=%s\\n\' "$browser_text" "$browser_session"'
].join('\n')

export const name = 'notebook-host-driver'
export const inject = ['llm', 'agents', 'agentPresets', 'subagents', 'tools']

const getText = message => (message?.content ?? [])
  .filter(block => block.type === 'text')
  .map(block => block.text)
  .join('')

const getResultText = result => {
  const content = result?.content
  if (Array.isArray(content)) {
    const text = content
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text !== '') return text
  }
  if (typeof result?.value === 'string') return result.value
  if (result?.value !== undefined) return JSON.stringify(result.value)
  return String(result?.error ?? '')
}

const parseValue = value => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

const getSnapshot = value => {
  const parsed = parseValue(value)
  return parsed?.notebook ?? parsed?.current ?? parsed
}

const getFirstCellId = value => {
  const snapshot = getSnapshot(value)
  const cell = snapshot?.cells?.find?.(item => typeof item?.id === 'string')
  return typeof cell?.id === 'string' ? cell.id : undefined
}

const getAddedCellId = value => {
  const parsed = parseValue(value)
  if (typeof parsed?.cell?.id === 'string') return parsed.cell.id
  const snapshot = getSnapshot(parsed)
  return snapshot?.cells?.findLast?.(item => typeof item?.id === 'string')?.id
}

const getStdout = value => {
  const parsed = parseValue(value)
  return typeof parsed?.stdout === 'string' ? parsed.stdout : ''
}

const getStreamText = value => {
  const stream = parseValue(value)?.stdout
  if (typeof stream === 'string') return stream
  return typeof stream?.text === 'string' ? stream.text : ''
}

const getExecutionStatus = value => {
  const parsed = parseValue(value)
  return typeof parsed?.status === 'string' ? parsed.status : undefined
}

const getBashArgs = (options, command) => {
  const schema = (options.tools ?? []).find(tool => tool.name === 'bash')
  const keys = Object.keys(schema?.parameters?.properties ?? {})
  const descriptionKey = keys.find(key => key === 'description') ?? keys.find(key => /description/i.test(key))
  const commandKey = keys.find(key => key === 'command') ?? keys.find(key => /command/i.test(key)) ?? 'command'
  return {
    ...(descriptionKey === undefined ? {} : { [descriptionKey]: 'Run fixed Node24 JavaScript and TypeScript fixture in managed read-only bash' }),
    [commandKey]: command
  }
}

const clip = (value, length = 500) => String(value ?? '').slice(0, length)

const writeDurable = (file, value) => {
  const fd = openSync(file, 'w', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const readProcFile = (path, encoding = 'utf8') => {
  try { return readFileSync(path, encoding) } catch { return undefined }
}

const getProcessTable = () => {
  try {
    return execFileSync('ps', ['-eo', 'pid=,ppid=,stat=,args='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      .split('\n')
      .map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
      .filter(Boolean)
      .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), stat: match[3], args: match[4] }))
  } catch {
    return []
  }
}

const getProcessIdentity = (pid) => {
  const root = `/proc/${pid}`
  const cmdline = readProcFile(`${root}/cmdline`, 'utf8')
  const stat = readProcFile(`${root}/stat`, 'utf8')
  const cwd = (() => {
    try { return readlinkSync(`${root}/cwd`) } catch { return undefined }
  })()
  const startTicks = (() => {
    if (stat === undefined) return undefined
    const close = stat.lastIndexOf(')')
    const fields = stat.slice(close + 2).trim().split(/\s+/)
    return fields[19]
  })()
  return {
    pid,
    cwd,
    startTicks,
    command: cmdline === undefined ? [] : cmdline.split('\0').filter(Boolean).slice(0, 32)
  }
}

const captureKernelProcesses = (candidateRoot) => {
  const processes = getProcessTable()
  const byParent = new Map()
  for (const item of processes) {
    const list = byParent.get(item.ppid) ?? []
    list.push(item)
    byParent.set(item.ppid, list)
  }
  const roots = processes
    .filter(item => item.args.includes('kernel_driver.py')
      && item.args.includes(workspace)
      && (candidateRoot === undefined || item.args.includes(candidateRoot)))
    .map(item => item.pid)
  const rows = []
  const visit = (pid, depth) => {
    const item = processes.find(entry => entry.pid === pid)
    if (item === undefined) return
    const identity = getProcessIdentity(pid)
    rows.push({ ...identity, ppid: item.ppid, stat: item.stat, args: item.args, depth })
    for (const child of byParent.get(pid) ?? []) visit(child.pid, depth + 1)
  }
  for (const pid of roots) visit(pid, 0)
  return { roots, rows, capturedAt: new Date().toISOString() }
}

const getRuntimeState = (agentId) => {
  try {
    return globalThis[NOTEBOOK_RUNTIME_KEY]?.getState?.(agentId)
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

const getToolResult = batch => {
  const row = batch?.results?.[0] ?? batch
  return row?.result ?? row
}

const isToolErrorResult = result => {
  if (result?.isError === true) return true
  if (result?.error !== undefined) return true
  if (result?.value?.isError === true || result?.value?.error !== undefined) return true
  return /^(?:Error:|工具|专家|天枢)/.test(String(result?.text ?? result?.value?.content?.[0]?.text ?? ''))
}

const callCertificates = result => {
  if (Array.isArray(result?.certificates)) return result.certificates
  if (Array.isArray(result?.lastShutdown?.certificates)) return result.lastShutdown.certificates
  if (Array.isArray(result?.state?.lastShutdown?.certificates)) return result.state.lastShutdown.certificates
  if (Array.isArray(result?.result?.certificates)) return result.result.certificates
  return []
}

function* text(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* call(name, args) {
  const id = `notebook-host-${randomUUID()}`
  const value = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: value }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: value } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

export const apply = ctx => {
  const workspace = process.cwd()
  const output = process.env.NOTEBOOK_HOST_OUT
  if (output === undefined || output === '') throw new Error('NOTEBOOK_HOST_OUT is required')
  const candidateRoot = process.env.NOTEBOOK_HOST_CANDIDATE
  const state = {
    scenario: 'notebook-host',
    status: 'running',
    hostVersion: process.env.SWARM_DSH_VERSION ?? null,
    sdkModules: process.env.SWARM_DSH_MODULES ?? null,
    workspace,
    rootRequests: [],
    mathRequests: [],
    bashRequests: [],
    toolCalls: [],
    toolErrors: [],
    mathTools: [],
    bashTools: [],
    mathSequence: [],
    subagentEnds: [],
    logicalEnd: {},
    crossStep: {},
    firstCell: null,
    secondCell: null,
    firstStdout: null,
    finalStdout: null,
    firstExecutionStatus: null,
    finalExecutionStatus: null,
    bashChildId: null,
    bashBoundary: null,
    bashExit: {},
    jsTsBash: null,
    browserBash: null,
    spawnObservations: [],
    bashDelegation: null,
    bashLogicalEnd: {},
    uiSnapshot: null,
    crossActor: {},
    kernelProcesses: [],
    kernelExit: {},
    rootPreset: null,
    rootId: null,
    mathChildId: null,
    taskId: null,
    delegation: null,
    validOutputDigest: hashJson(VALID_OUTPUTS.suan_heng)
  }
  let restoreNotebookRuntime = () => {}
  let restoreBoundaryWrapper = () => {}
  let finished = false
  const finish = (status, error) => {
    if (finished) return
    finished = true
    state.status = status
    if (error !== undefined) state.error = clip(error?.stack ?? error, 8000)
    state.finishedAt = new Date().toISOString()
    writeDurable(output, state)
    setTimeout(() => process.exit(status === 'passed' ? 0 : 1), 100)
  }

  const adapter = {
    providerInfo: id => ({ id, name: 'Notebook Host local mock' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async () => [],
    resolveModel: async (provider, id) => ({
      provider,
      id,
      name: id,
      inputModalities: ['text'],
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 32_000
    }),
    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
    },
    async *stream(options) {
      if (options.purpose !== undefined) {
        yield* text('notebook-host-fixture')
        return
      }
      const sessionId = String(options.sessionId ?? 'unknown')
      const request = {
        sessionId,
        model: options.model,
        step: state.mathRequests.filter(item => item.sessionId === sessionId).length,
        tools: (options.tools ?? []).map(tool => tool.name),
        purpose: options.purpose ?? null
      }
      if (state.rootId !== null && sessionId === state.rootId) {
        state.rootRequests.push(request)
        yield* text('root model requests are forbidden in this fixture')
        return
      }
      if (options.model !== 'notebook-math') {
        if (options.model === 'managed-bash-math') {
          const bashStep = state.bashRequests.length
          state.bashRequests.push({
            sessionId,
            model: options.model,
            step: bashStep,
            tools: (options.tools ?? []).map(tool => tool.name),
            toolProperties: Object.fromEntries((options.tools ?? [])
              .filter(tool => tool.name === 'bash')
              .map(tool => [tool.name, Object.keys(tool.parameters?.properties ?? {})]))
          })
          if (bashStep === 0) {
            yield* call('bash', getBashArgs(options, FUHE_BASH_COMMAND))
            return
          }
          if (bashStep === 1) {
            yield* call('bash', getBashArgs(options, FUHE_BROWSER_COMMAND))
            return
          }
          yield* text(`完成。\n\`\`\`json\n${JSON.stringify(VALID_OUTPUTS.fu_he)}\n\`\`\``)
          return
        }
        yield* text('notebook-host auxiliary request')
        return
      }
      const mathStep = state.mathRequests.length
      state.mathRequests.push(request)
      if (mathStep === 0) {
        state.mathSequence.push('nb_new')
        yield* call('nb_new', { title: 'notebook-host-math' })
        return
      }
      if (mathStep === 1) {
        state.mathSequence.push('nb_edit_and_run_cell')
        yield* call('nb_edit_and_run_cell', {
          cellId: state.firstCell ?? 'missing-first-cell',
          source: 'x = 40'
        })
        return
      }
      if (mathStep === 2) {
        state.mathSequence.push('nb_add_cell')
        yield* call('nb_add_cell', { cell_type: 'code', source: 'print(x + 2)' })
        return
      }
      if (mathStep === 3) {
        state.mathSequence.push('nb_run_cell')
        yield* call('nb_run_cell', { cellId: state.secondCell ?? 'missing-second-cell' })
        return
      }
      // Continuable children do not receive outputSchema; the DSH contract
      // accepts a final fenced JSON block and validates it with the same role schema.
      yield* text(`完成。\n\`\`\`json\n${JSON.stringify(VALID_OUTPUTS.suan_heng)}\n\`\`\``)
    }
  }
  ctx.llm.registerAdapter(['notebook-host-mock'], adapter)

  ctx.on('tools/execute', async (execution, next) => {
    if (execution.name.startsWith('nb_') || execution.name === 'bash' || execution.name === 'structured_output') {
      const scope = globalThis[Symbol.for('dsh-agent-swarm.execution-boundary.v1')]?.storage?.getStore?.()
      state.toolCalls.push({
        name: execution.name,
        agentId: execution.agent?.id ?? null,
        arguments: execution.arguments,
        signalAborted: execution.signal?.aborted === true,
        boundary: scope === undefined ? null : {
          agentId: scope.agentId,
          attemptId: scope.attemptId,
          mode: scope.mode,
          operation: scope.operation,
          cwd: scope.cwd
        }
      })
    }
    return next()
  })

  ctx.on('tools/result', (execution, result) => {
    if (!execution.name.startsWith('nb_')) return
    const row = {
      name: execution.name,
      agentId: execution.agent?.id ?? null,
      isError: result?.isError === true,
      value: result?.value,
      text: clip(getResultText(result))
    }
    state.mathTools.push(row)
    if (row.isError) state.toolErrors.push({ name: row.name, agentId: row.agentId, error: row.text })
    if (execution.name === 'nb_new' && !row.isError) {
      state.firstCell = getFirstCellId(row.value)
      state.firstStdout = getStdout(row.value)
    }
    if (execution.name === 'nb_edit_and_run_cell' && !row.isError) {
      state.firstStdout = getStdout(row.value)
      state.firstExecutionStatus = getExecutionStatus(row.value)
    }
    if (execution.name === 'nb_add_cell' && !row.isError) state.secondCell = getAddedCellId(row.value)
    if (execution.name === 'nb_run_cell' && !row.isError) {
      state.finalStdout = getStdout(row.value)
      state.finalExecutionStatus = getExecutionStatus(row.value)
      state.kernelProcesses.push(captureKernelProcesses(candidateRoot))
      const runtimeHook = globalThis[NOTEBOOK_RUNTIME_KEY]
      if (state.mathChildId === null && execution.agent?.id !== undefined && runtimeHook?.shutdownSession !== undefined) {
        state.mathChildId = execution.agent.id
        state.kernelExit.earlyShutdown = { status: 'started', at: new Date().toISOString() }
        void runtimeHook.shutdownSession(execution.agent.id).then(result => {
          state.kernelExit.earlyShutdown = {
            status: 'returned',
            at: new Date().toISOString(),
            state: getRuntimeState(execution.agent.id),
            result: result === undefined ? null : result
          }
        }, error => {
          state.kernelExit.earlyShutdown = { status: 'failed', at: new Date().toISOString(), error: clip(error?.message ?? error) }
        })
      }
    }
  })
  ctx.on('tools/result', (execution, result) => {
    if (execution.name !== 'bash') return
    const value = result?.value ?? result
    const row = {
      agentId: execution.agent?.id ?? null,
      isError: result?.isError === true || value?.isError === true,
      command: execution.arguments?.command,
      stdout: getStreamText(value),
      stderr: (() => {
        const stream = parseValue(value)?.stderr
        return typeof stream === 'string' ? stream : typeof stream?.text === 'string' ? stream.text : ''
      })(),
      exitCode: typeof value?.exitCode === 'number' ? value.exitCode : null,
      text: clip(getResultText(result)),
      boundary: state.toolCalls.findLast?.(call => call.name === 'bash' && call.agentId === execution.agent?.id)?.boundary ?? null
    }
    state.bashTools.push(row)
    if (row.agentId !== null && state.bashChildId === null) state.bashChildId = row.agentId
    state.bashBoundary = row.boundary
    state.bashExit = row
    if (state.jsTsBash === null) state.jsTsBash = row
    else if (state.browserBash === null) state.browserBash = row
    if (row.isError) state.toolErrors.push({ name: 'bash', agentId: row.agentId, error: row.stderr || row.stdout || 'bash failed' })
  })
  ctx.on('subagent/end', info => {
    state.subagentEnds.push({
      id: info?.id ?? null,
      stopReason: info?.stopReason ?? null,
      diagnostic: info?.diagnostic === undefined ? null : clip(info.diagnostic),
      hasLastAssistantMessage: Array.isArray(info?.lastAssistantMessage) && info.lastAssistantMessage.length > 0
    })
    if (typeof info?.id === 'string') state.kernelExit.subagentEndState = getRuntimeState(info.id)
  }, { prepend: true })
  ctx.on('session/disposed', session => {
    if (typeof session?.id === 'string') state.kernelExit.sessionDisposedState = getRuntimeState(session.id)
  }, { prepend: true })

  const executeTool = async (agent, name, args) => {
    const tools = ctx.get('tools')
    if (tools?.execute === undefined) throw new Error('Host tools.execute unavailable')
    const batch = await tools.execute({
      calls: [{ type: 'tool-call', id: `cross-${randomUUID()}`, name, arguments: JSON.stringify(args) }],
      agent,
      signal: new AbortController().signal
    })
    return getToolResult(batch)
  }

  const probeCrossActor = async (rootAgent) => {
    if (state.firstCell === null) {
      state.crossActor = { passed: false, reason: 'first cell missing; no kernel identity to cross-check' }
      return
    }
    const checks = []
    try {
      const result = await executeTool(rootAgent, 'nb_run_cell', { cellId: state.firstCell })
      checks.push({ actor: 'tian-shu-router', passed: isToolErrorResult(result), result: { isError: result?.isError === true, value: result?.value ?? result } })
    } catch (error) {
      checks.push({ actor: 'tian-shu-router', passed: true, error: clip(error?.message ?? error) })
    }
    const unbound = {
      id: `notebook-cross-without-binding-${randomUUID()}`,
      session: { header: { cwd: workspace, parentSession: rootAgent.id, agentPreset: 'suan-heng' } }
    }
    try {
      const result = await executeTool(unbound, 'nb_run_cell', { cellId: state.firstCell })
      checks.push({ actor: 'unbound-managed-worker', passed: isToolErrorResult(result), result: { isError: result?.isError === true, value: result?.value ?? result } })
    } catch (error) {
      checks.push({ actor: 'unbound-managed-worker', passed: true, error: clip(error?.message ?? error) })
    }
    state.crossActor = { passed: checks.every(item => item.passed), checks }
  }

  const readCompletedNotebookSnapshot = async (sessionId) => {
    const connection = ctx.get('connection')
    const webServer = ctx.get('webServer')
    const origin = webServer?.getOrigin?.() ?? (
      process.env.NOTEBOOK_HOST_PORT === undefined
        ? undefined
        : `http://127.0.0.1:${process.env.NOTEBOOK_HOST_PORT}`
    )
    if (connection?.authenticatedUrl === undefined || origin === undefined) {
      throw new Error('authenticated Notebook snapshot route is unavailable')
    }
    const login = await fetch(connection.authenticatedUrl(`${origin}/`), { redirect: 'manual' })
    const cookieHeader = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie')
    const cookie = cookieHeader?.split(';')[0]
    if (login.status !== 303 || cookie === undefined) {
      throw new Error(`Notebook UI login exchange failed: status=${login.status}`)
    }
    const response = await fetch(`${origin}/nb/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ _sid: sessionId })
    })
    const body = await response.json().catch(() => ({}))
    return {
      httpStatus: response.status,
      sessionId,
      cells: Array.isArray(body.cells) ? body.cells : Array.isArray(body.current?.cells) ? body.current.cells : [],
      bodyDigest: hashJson(body),
      body: {
        path: body.path ?? body.current?.path ?? null,
        dirty: body.dirty ?? body.current?.dirty ?? null,
        cells: (Array.isArray(body.cells) ? body.cells : body.current?.cells ?? []).map(cell => ({
          id: cell?.id ?? null,
          source: clip(cell?.source ?? ''),
          outputs: Array.isArray(cell?.outputs) ? cell.outputs.slice(0, 4) : []
        }))
      }
    }
  }

  const run = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await ctx.agentPresets.resolve('tian-shu')
        if (ctx.get('agentSwarm') !== undefined && globalThis[NOTEBOOK_RUNTIME_KEY]?.version === 1) break
      } catch {}
      if (attempt === 99) throw new Error('Swarm/Notebook runtime did not activate before child tool scoping')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const runtimeHook = globalThis[NOTEBOOK_RUNTIME_KEY]
    if (runtimeHook === undefined || runtimeHook.version !== 1 || typeof runtimeHook.shutdownSession !== 'function') {
      throw new Error('Notebook runtime port is incomplete before Host root creation')
    }
    const originalShutdown = runtimeHook.shutdownSession.bind(runtimeHook)
    const originalGetState = runtimeHook.getState.bind(runtimeHook)
    const observedPort = Object.freeze({
      version: 1,
      getState: originalGetState,
      shutdownSession: async agentId => {
        const before = originalGetState(agentId)
        const result = await originalShutdown(agentId)
        const after = originalGetState(agentId)
        state.kernelExit.shutdownCalls ??= []
        const diagnostic = typeof result?.diagnostic === 'string' ? result.diagnostic
          : typeof result?.error?.message === 'string' ? result.error.message
            : typeof result?.error === 'string' ? result.error
              : typeof after?.lastShutdown?.diagnostic === 'string' ? after.lastShutdown.diagnostic
                : null
        state.kernelExit.shutdownCalls.push({
          agentId,
          before,
          after,
          result: result === undefined ? null : result,
          diagnostic: diagnostic === null ? null : clip(diagnostic)
        })
        return result
      }
    })
    globalThis[NOTEBOOK_RUNTIME_KEY] = observedPort
    restoreNotebookRuntime = () => {
      if (globalThis[NOTEBOOK_RUNTIME_KEY] === observedPort) globalThis[NOTEBOOK_RUNTIME_KEY] = runtimeHook
    }
    const boundaryCarrier = globalThis[EXECUTION_BOUNDARY_KEY]
    if (boundaryCarrier === undefined || typeof boundaryCarrier.prepareSpawn !== 'function' || boundaryCarrier.storage === undefined) {
      throw new Error('execution-boundary carrier is unavailable for actual spawn observation')
    }
    const originalPrepareSpawn = boundaryCarrier.prepareSpawn
    boundaryCarrier.prepareSpawn = spec => {
      const activeScope = boundaryCarrier.storage.getStore()
      const observation = {
        at: new Date().toISOString(),
        activeScope: activeScope === undefined ? null : {
          agentId: activeScope.agentId,
          attemptId: activeScope.attemptId,
          mode: activeScope.mode,
          operation: activeScope.operation,
          cwd: activeScope.cwd
        },
        spec: {
          cwd: spec.cwd,
          argv: spec.argv,
          envKeys: Object.keys(spec.env ?? {}).sort()
        },
        assertContainment: null,
        started: false,
        error: null
      }
      state.spawnObservations.push(observation)
      const ticket = originalPrepareSpawn.call(boundaryCarrier, spec)
      if (ticket === undefined) return undefined
      return {
        ...ticket,
        assertContainment: mode => {
          observation.assertContainment = mode
          try { return ticket.assertContainment(mode) }
          catch (error) {
            observation.error = clip(error?.message ?? error)
            throw error
          }
        },
        started: handle => {
          observation.started = true
          return ticket.started(handle)
        }
      }
    }
    restoreBoundaryWrapper = () => {
      if (boundaryCarrier.prepareSpawn !== originalPrepareSpawn) boundaryCarrier.prepareSpawn = originalPrepareSpawn
    }
    const presetScope = await ctx.agentPresets.acquireScope('tian-shu')
    let rootHandle
    let service
    let serviceDisposed = false
    try {
      rootHandle = await ctx.agents.create({
        sessionId: `notebook-host-root-${randomUUID()}`,
        meta: { cwd: workspace, agentPreset: 'tian-shu' },
        agentOptions: { provider: 'notebook-host-mock', model: 'notebook-root' },
        setup: async childCtx => { await ctx.agentPresets.mount(childCtx, 'tian-shu') }
      })
      const root = rootHandle.agent
      state.rootId = root.id
      state.rootPreset = root.session?.header?.agentPreset ?? null
      service = ctx.get('agentSwarm')
      assert.equal(typeof service?.AddTaskCard, 'function')
      assert.equal(typeof service?.delegate, 'function')
      await service.WaitAgentReady(root)
      const exec = { agent: root, signal: new AbortController().signal }
      const task = await service.AddTaskCard({
        title: '真实 Notebook Host 计算',
        goal: '让算衡在真实 DSH Host 中通过 Notebook 计算 40 + 2。',
        acceptance: ['两个 Notebook 执行 envelope 成功且最终输出 42'],
        scope: ['notebooks'],
        flags: {}
      }, exec)
      state.taskId = task.task_id
      const delegated = await service.delegate({
        task_id: task.task_id,
        role: 'suan_heng',
        mode: 'research',
        backend: 'api',
        session: 'new',
        prompt: '按顺序使用真实 nb_new、nb_edit_and_run_cell、nb_add_cell、nb_run_cell 工具计算 x=40，再输出 x+2，并在最终 JSON 中报告实际 42。'
      }, exec)
      state.delegation = {
        delegationId: delegated.delegationId,
        status: delegated.status,
        finalization: delegated.finalization ?? null,
        childId: delegated.childId ?? null,
        session: delegated.session ?? null,
        summary: delegated.summary,
        error: delegated.error ?? null,
        unresolved: delegated.unresolved ?? [],
        structured: delegated.structured ?? null
      }
      state.mathChildId = delegated.childId ?? delegated.session?.threadId ?? null
      try {
        state.uiSnapshot = await readCompletedNotebookSnapshot(state.mathChildId)
      } catch (error) {
        state.uiSnapshot = {
          httpStatus: null,
          sessionId: state.mathChildId,
          cells: [],
          error: clip(error?.stack ?? error, 8000)
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
      const logicalEnd = state.subagentEnds.find(item => item.id === state.mathChildId)
      const childAgent = state.mathChildId === null ? undefined : ctx.agents.get?.(state.mathChildId)
      state.logicalEnd = {
        event: logicalEnd ?? null,
        agentStatus: childAgent?.status ?? null,
        eventCount: state.subagentEnds.filter(item => item.id === state.mathChildId).length
      }
      state.crossStep = {
        requestCount: state.mathRequests.length,
        firstCell: state.firstCell,
        secondCell: state.secondCell,
        editAndRunStatus: state.firstExecutionStatus,
        runStatus: state.finalExecutionStatus,
        value: String(state.finalStdout ?? '').trim(),
        source: 'nb_edit_and_run_cell: x = 40 -> nb_run_cell: print(x + 2)'
      }
      state.kernelExit.beforeDispose = state.mathChildId === null ? null : getRuntimeState(state.mathChildId)
      state.kernelProcesses.push(captureKernelProcesses(candidateRoot))
      await probeCrossActor(root)
      const rootRequirements = {
        rootPreset: state.rootPreset,
        rootModelRequests: state.rootRequests.length,
        mathModelSteps: state.mathRequests.length,
        mathSequence: state.mathSequence,
        toolErrors: state.toolErrors,
        firstCell: state.firstCell,
        secondCell: state.secondCell,
        firstStdout: state.firstStdout,
        finalStdout: state.finalStdout,
        firstExecutionStatus: state.firstExecutionStatus,
        finalExecutionStatus: state.finalExecutionStatus,
        crossStep: state.crossStep,
        logicalEnd: state.logicalEnd,
        uiSnapshot: state.uiSnapshot,
        crossActor: state.crossActor,
        kernelExit: state.kernelExit,
        delegation: state.delegation
      }
      state.assertions = rootRequirements
      if (state.rootPreset !== 'tian-shu') throw new Error(`root preset is ${String(state.rootPreset)}`)
      if (state.rootRequests.length !== 0) throw new Error('root produced a real model request')
      if (delegated.status !== 'completed') throw new Error(`delegation status=${delegated.status}: ${delegated.error ?? delegated.summary}`)
      const mathToolErrors = state.toolErrors.filter(row => row.agentId === state.mathChildId)
      state.mathToolErrors = mathToolErrors
      if (mathToolErrors.length > 0) throw new Error(`Notebook math tool errors: ${JSON.stringify(mathToolErrors)}`)
      if (state.mathSequence.join(',') !== 'nb_new,nb_edit_and_run_cell,nb_add_cell,nb_run_cell') {
        throw new Error(`unexpected Notebook tool sequence: ${state.mathSequence.join(',')}`)
      }
      if (state.mathRequests.length < 2) throw new Error(`not enough real LLM steps: ${state.mathRequests.length}`)
      if (state.firstCell === null || state.secondCell === null) throw new Error('Notebook cell IDs were not returned')
      if (state.crossStep.editAndRunStatus !== 'ok' || state.crossStep.runStatus !== 'ok') {
        throw new Error(`cross-step execution status=${JSON.stringify(state.crossStep)}`)
      }
      if (state.crossStep.value !== '42') throw new Error(`cross-step value=${JSON.stringify(state.crossStep.value)}`)
      if (state.logicalEnd.event?.stopReason !== 'completed' || state.logicalEnd.eventCount !== 1) {
        throw new Error(`child logical end is incomplete: ${JSON.stringify(state.logicalEnd)}`)
      }
      if (String(state.finalStdout ?? '').trim() !== '42') throw new Error(`final Notebook stdout=${JSON.stringify(state.finalStdout)}`)
      if (state.crossActor.passed !== true) throw new Error(`crossActor probe failed: ${JSON.stringify(state.crossActor)}`)
      const shutdownCall = (state.kernelExit.shutdownCalls ?? []).find(call => call.agentId === state.mathChildId
        && (call.after?.lastShutdown?.certificates?.length ?? call.result?.certificates?.length
          ?? call.result?.lastShutdown?.certificates?.length ?? 0) > 0)
      const shutdown = shutdownCall?.after ?? state.kernelExit.sessionDisposedState ?? state.kernelExit.subagentEndState ?? state.kernelExit.beforeDispose
      const certificates = [
        ...(callCertificates(shutdownCall?.result) ?? []),
        ...(shutdown?.lastShutdown?.certificates ?? [])
      ]
      const exitCertificate = certificates.find(certificate => certificate?.stopped === true
        && certificate?.quiescent === true && certificate?.ownershipQuiescent === true)
      if (shutdown?.compute !== null || exitCertificate === undefined) {
        throw new Error(`Notebook kernel exit certificate missing: ${JSON.stringify({
          state: shutdown,
          result: shutdownCall?.result ?? null,
          diagnostic: shutdownCall?.diagnostic ?? state.kernelExit.subagentEndState?.lastShutdown?.diagnostic ?? null
        })}`)
      }
      state.kernelExit.afterDelegate = shutdown
      state.kernelExit.exitCertificate = exitCertificate
      state.kernelExit.shutdownDiagnostic = shutdownCall?.diagnostic ?? null
      state.kernelExit.afterProcessCapture = captureKernelProcesses(candidateRoot)
      state.kernelExit.oldComputeClosed = shutdown.compute === null
      state.kernelExit.certificatePresent = certificates.length > 0
      if ((state.kernelExit.afterProcessCapture.rows ?? []).length > 0) throw new Error('Notebook kernel process remained after delegation')
      const bashDelegated = await service.delegate({
        task_id: task.task_id,
        role: 'fu_he',
        backend: 'api',
        session: 'new',
        prompt: '在受管只读 bash 中使用 Node24 验证固定 JS 与 TypeScript 片段，stdout 必须为 42，并报告实际边界与退出码。'
      }, exec)
      state.bashDelegation = {
        status: bashDelegated.status,
        finalization: bashDelegated.finalization ?? null,
        childId: bashDelegated.childId ?? null,
        summary: bashDelegated.summary,
        error: bashDelegated.error ?? null,
        structured: bashDelegated.structured ?? null
      }
      state.bashChildId = bashDelegated.childId ?? state.bashChildId
      await new Promise(resolve => setTimeout(resolve, 250))
      const bashEnd = state.subagentEnds.find(item => item.id === state.bashChildId)
      state.bashLogicalEnd = {
        event: bashEnd ?? null,
        eventCount: state.subagentEnds.filter(item => item.id === state.bashChildId).length
      }
      state.assertions.bash = {
        requests: state.bashRequests,
        tools: state.bashTools,
        boundary: state.bashBoundary,
        exit: state.bashExit,
        jsTs: state.jsTsBash,
        browser: state.browserBash,
        delegation: state.bashDelegation,
        logicalEnd: state.bashLogicalEnd
      }
      const fuheSpawn = state.spawnObservations.filter(item => item.activeScope?.agentId === state.bashChildId)
      state.assertions.bash.spawn = fuheSpawn
      if (bashDelegated.status !== 'completed') throw new Error(`fu_he bash delegation status=${bashDelegated.status}: ${bashDelegated.error ?? bashDelegated.summary}`)
      if (state.bashRequests.length < 3) throw new Error(`fu_he did not execute both real LLM tool phases: ${JSON.stringify(state.bashRequests)}`)
      if (state.bashRequests[0]?.tools?.includes('bash') !== true) throw new Error(`fu_he bash not visible from actual schema: ${JSON.stringify(state.bashRequests)}`)
      if (state.bashTools.length !== 2 || state.jsTsBash === null || state.browserBash === null) {
        throw new Error(`fu_he JS/TS and browser phases incomplete: ${JSON.stringify(state.bashTools)}`)
      }
      if (fuheSpawn.length === 0) throw new Error('fu_he actual subprocess.spawn did not reach carrier.prepareSpawn')
      if (!fuheSpawn.some(item => item.assertContainment === 'linux-scope' && item.started === true)) {
        throw new Error(`fu_he native spawn containment missing: ${JSON.stringify(fuheSpawn)}`)
      }
      if (!fuheSpawn.some(item => item.activeScope?.mode === 'read-only' && item.activeScope?.operation === 'shell')) {
        throw new Error(`fu_he actual spawn was not read-only shell: ${JSON.stringify(fuheSpawn)}`)
      }
      const jsTsStdout = String(state.jsTsBash.stdout ?? '')
      if (state.jsTsBash.isError === true || state.jsTsBash.exitCode !== 0
        || !jsTsStdout.includes('NODE_JS_RAW=42')
        || !jsTsStdout.includes('NODE_TS_RAW=42')
        || !jsTsStdout.includes('NODE_E2E_RAW=42')) {
        throw new Error(`fu_he Node24 JS/TS exit proof invalid: ${JSON.stringify(state.jsTsBash)}`)
      }
      const browserStdout = String(state.browserBash.stdout ?? '')
      if (state.browserBash.isError === true || state.browserBash.exitCode !== 0
        || !browserStdout.includes('managed-browser-42')
        || !browserStdout.includes('BROWSER_CLOSED=true')
        || !browserStdout.includes('SERVER_STOPPED=true')) {
        throw new Error(`fu_he browser exit proof invalid: ${JSON.stringify(state.browserBash)}`)
      }
      if (state.bashLogicalEnd.event?.stopReason !== 'completed' || state.bashLogicalEnd.eventCount !== 1) {
        throw new Error(`fu_he logical end is incomplete: ${JSON.stringify(state.bashLogicalEnd)}`)
      }
      const snapshotCells = Array.isArray(state.uiSnapshot?.cells) ? state.uiSnapshot.cells : []
      const snapshotSource = snapshotCells.some(cell => String(cell.source).includes('print(x + 2)'))
      const snapshotOutput = snapshotCells.some(cell => JSON.stringify(cell.outputs).includes('42'))
      if (state.uiSnapshot?.httpStatus !== 200 || !snapshotSource || !snapshotOutput) {
        throw new Error(`completed Notebook view is blank or missing 42: ${JSON.stringify(state.uiSnapshot)}`)
      }
      await service.dispose()
      serviceDisposed = true
      state.kernelExit.afterServiceDispose = captureKernelProcesses(candidateRoot)
      if ((state.kernelExit.afterServiceDispose.rows ?? []).length > 0) throw new Error('Notebook kernel process remained after service dispose')
      finish('passed')
    } finally {
      if (service !== undefined && !serviceDisposed) await service.dispose().catch(() => {})
      restoreNotebookRuntime()
      restoreBoundaryWrapper()
      await rootHandle?.dispose?.()
      await presetScope?.[Symbol.asyncDispose]?.()
    }
  }

  setTimeout(() => {
    void run().catch(error => finish('failed', error))
  }, 300)
  setTimeout(() => finish('failed', new Error('Notebook Host driver timed out')), 180_000).unref()
}
