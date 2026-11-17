import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  collectLocalRuntimeClosure,
  getNotebookCellFacts,
  isToolErrorResult,
  parseRequiredOptions,
  redactSensitiveText,
  sha256Tree,
  validateHttpProbeResult,
  waitFor
} from './notebook-snapshot-host-helpers.mjs'

test('required options reject missing values instead of inventing paths', () => {
  assert.throws(
    () => parseRequiredOptions(['--dsh', '/tmp/modules', '--swarm'], ['dsh', 'swarm', 'notebook', 'python', 'out']),
    /--swarm 缺少路径/
  )
  assert.throws(
    () => parseRequiredOptions(['--dsh', '/tmp/modules', '--swarm', '/tmp/swarm'], ['dsh', 'swarm', 'notebook', 'python', 'out']),
    /缺少必需参数 --notebook/
  )
})

test('sensitive auth text is redacted without hiding the request status', () => {
  const source = [
    'GET /?token=secret-value&keep=1 HTTP/1.1',
    'cookie=session-secret',
    '_sid=child-01',
    'status=200'
  ].join('\n')

  const redacted = redactSensitiveText(source)

  assert.equal(redacted.includes('secret-value'), false)
  assert.equal(redacted.includes('session-secret'), false)
  assert.match(redacted, /_sid=child-01/)
  assert.match(redacted, /status=200/)
})

test('notebook facts preserve sources, IPython output 42 and kernel alive state', () => {
  const facts = getNotebookCellFacts({
    current: {
      readOnly: true,
      kernel: { alive: false },
      cells: [
        { id: 'cell-a', source: 'x = 40', outputs: [] },
        {
          id: 'cell-b',
          source: 'print(x + 2)',
          execution_count: 1,
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['42\n'] }]
        }
      ]
    }
  })

  assert.equal(facts.cellCount, 2)
  assert.deepEqual(facts.sources, ['x = 40', 'print(x + 2)'])
  assert.equal(facts.outputText.includes('42'), true)
  assert.equal(facts.kernelAlive, false)
  assert.equal(facts.readOnly, true)
})

test('HTTP probe gate rejects a missing 403 or unknown kernel side effect', () => {
  const result = {
    get: { status: 200, cells: 2, outputText: '42', kernelAlive: false },
    unknownSession: { status: 403 },
    run: { status: 403 },
    edit: { status: 403 },
    save: { status: 403 },
    activeKernels: { status: 200, count: 1 }
  }

  assert.throws(() => validateHttpProbeResult(result), /activeKernels 应为 0/)
  assert.throws(
    () => validateHttpProbeResult({ ...result, activeKernels: { status: 200, count: 0 }, edit: { status: 200 } }),
    /edit 应为 403/
  )
})

test('successful Notebook execution with error null is not a tool error', () => {
  assert.equal(isToolErrorResult({
    value: {
      ok: true,
      status: 'ok',
      stdout: '42\n',
      error: null
    }
  }), false)
})

test('compact execution snapshot preserves source_preview as source facts', () => {
  const facts = getNotebookCellFacts({
    value: {
      current: {
        kernel: { alive: true },
        cells: [
          { id: 'cell-a', source_preview: 'x = 40', outputs_summary: { streams: 0 } },
          { id: 'cell-b', source_preview: 'print(x + 2)', outputs_summary: { streams: 1 } }
        ]
      }
    }
  })

  assert.deepEqual(facts.sources, ['x = 40', 'print(x + 2)'])
})

test('condition waiting treats null as not ready', async () => {
  let attempts = 0
  const value = await waitFor(() => {
    attempts += 1
    return attempts < 3 ? null : 'ready'
  }, 100, 1)

  assert.equal(value, 'ready')
  assert.equal(attempts, 3)
})

test('source tree digest ignores volatile sandbox state', () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-snapshot-helper-'))
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n')
    const before = sha256Tree(root)
    mkdirSync(join(root, '.sandbox', 'storages'), { recursive: true })
    writeFileSync(join(root, '.sandbox', 'storages', 'temp.tmp'), 'volatile')
    assert.equal(sha256Tree(root), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exact package runtime closure follows local imports and bundle patches', () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-snapshot-package-'))
  try {
    mkdirSync(join(root, 'lib', 'application'), { recursive: true })
    mkdirSync(join(root, 'locale'), { recursive: true })
    mkdirSync(join(root, 'presets'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-swarm',
      exports: {
        '.': './lib/index.js',
        './locale/*.json': './locale/*.json'
      },
      dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/root.patch.yml'] } }
    }))
    writeFileSync(join(root, 'cordis.patch.yml'), '- insert: []\n')
    writeFileSync(join(root, 'locale', 'en.json'), '{"hello":"world"}\n')
    writeFileSync(join(root, 'presets', 'root.patch.yml'), '- id: root\n')
    writeFileSync(join(root, 'lib', 'index.js'), "export { value } from './application/service.js'\n")
    writeFileSync(join(root, 'lib', 'application', 'service.js'), "import '../shared.js'\nexport const value = 42\n")
    writeFileSync(join(root, 'lib', 'shared.js'), 'export const shared = true\n')

    const closure = collectLocalRuntimeClosure(root)

    assert.equal(closure.entry, 'lib/index.js')
    assert.deepEqual(closure.files, [
      'cordis.patch.yml',
      'lib/application/service.js',
      'lib/index.js',
      'lib/shared.js',
      'locale/en.json',
      'package.json',
      'presets/root.patch.yml'
    ])
    assert.match(closure.digest, /^[a-f0-9]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exact package runtime digest tracks closure bytes but ignores unrelated files', () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-snapshot-package-bytes-'))
  try {
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-swarm-bytes',
      exports: './lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }))
    writeFileSync(join(root, 'cordis.patch.yml'), '- insert: []\n')
    writeFileSync(join(root, 'lib', 'index.js'), "import './dep.js'\n")
    writeFileSync(join(root, 'lib', 'dep.js'), 'export const value = 1\n')

    const first = collectLocalRuntimeClosure(root)
    writeFileSync(join(root, 'README.md'), 'unrelated\n')
    const unrelated = collectLocalRuntimeClosure(root)
    writeFileSync(join(root, 'lib', 'dep.js'), 'export const value = 2\n')
    const changed = collectLocalRuntimeClosure(root)

    assert.equal(unrelated.digest, first.digest)
    assert.notEqual(changed.digest, first.digest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exact package runtime closure rejects missing imports and path escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-snapshot-package-reject-'))
  try {
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-swarm-reject',
      exports: './lib/index.js',
      dsh: { bundle: { patch: '../outside.patch.yml' } }
    }))
    writeFileSync(join(root, 'lib', 'index.js'), "import './missing.js'\n")

    assert.throws(() => collectLocalRuntimeClosure(root), /bundle patch|越界/)
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-swarm-reject',
      exports: './lib/index.js'
    }))
    assert.throws(() => collectLocalRuntimeClosure(root), /无法解析/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
