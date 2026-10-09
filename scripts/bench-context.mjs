import { performance } from 'node:perf_hooks'
import { cpus, platform } from 'node:os'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

// Explicit compiled directories keep this benchmark independent of the live Host.
const args = process.argv.slice(2)
const option = (key) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1] }
const samples = Number(option('--samples') ?? 30)
const warmup = Number(option('--warmup') ?? 5)
if (!Number.isSafeInteger(samples) || samples < 5 || samples > 1000 || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 50) throw new Error('Invalid sample/warmup counts')
const directories = { ...(option('--baseline-dir') ? { before: resolve(option('--baseline-dir')) } : {}), after: resolve(option('--current-dir') ?? 'lib') }
const variants = []
for (const [name, directory] of Object.entries(directories)) {
  const file = join(directory, 'context-store.js')
  variants.push({ name, directory, moduleDigest: createHash('sha256').update(await readFile(file)).digest('hex'), ...(await import(pathToFileURL(file).href)) })
}
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]
const summarize = (values) => ({ median: quantile(values, 0.5), p95: quantile(values, 0.95), min: Math.min(...values), max: Math.max(...values) })
const binding = { rootSessionId: 'audit-root', workspaceId: 'audit-workspace', taskId: 'audit-task', cardRevision: 1, workflowRevision: 1, threadId: 'audit-expert' }
const rows = []
for (const [label, text] of [['small-ascii', 'a'.repeat(1024)], ['large-unicode', '中文🙂éabc'.repeat(65536)]]) {
  const expectedBytes = Buffer.byteLength(text)
  const entries = variants.map((variant) => {
    const store = variant.intContextStore({ maxArtifactBytes: 2 * 1024 * 1024 })
    const artifact = store.Add({ binding, layer: 'L2', kind: 'evidence', text })
    // Check reconstruction and byte units outside the measured section.
    const pieces = []
    let cursor = '0'
    do { const page = store.Read(binding, artifact.ref, { cursor }); pieces.push(page.text); cursor = page.nextCursor; if (page.totalBytes !== expectedBytes) throw new Error('Incorrect UTF-8 byte count') } while (cursor !== null)
    if (pieces.join('') !== text) throw new Error('Pagination changed the text')
    return { variant, store, ref: artifact.ref, pages: pieces.length, paginationMs: [], indexMs: [] }
  })
  for (let iteration = 0; iteration < warmup + samples; iteration++) {
    for (const entry of iteration % 2 ? [...entries].reverse() : entries) {
      let cursor = '0'
      const started = performance.now()
      do { cursor = entry.store.Read(binding, entry.ref, { cursor }).nextCursor } while (cursor !== null)
      const elapsed = performance.now() - started
      const indexStarted = performance.now(); entry.store.List(binding); const indexElapsed = performance.now() - indexStarted
      if (iteration >= warmup) { entry.paginationMs.push(elapsed); entry.indexMs.push(indexElapsed) }
    }
  }
  for (const entry of entries) rows.push({ variant: entry.variant.name, label, chars: text.length, bytes: expectedBytes, pages: entry.pages,
    paginationMs: summarize(entry.paginationMs), indexMs: summarize(entry.indexMs), raw: { paginationMs: entry.paginationMs, indexMs: entry.indexMs } })
}
const memoryRows = []
for (const variant of variants) {
  const script = `
    import { pathToFileURL } from 'node:url';
    const { intContextStore } = await import(pathToFileURL(process.argv[1]).href);
    const sampleCount = Number(process.argv[2]), warmup = Number(process.argv[3]);
    const binding = { rootSessionId: 'root', workspaceId: 'workspace', taskId: 'task', cardRevision: 1, workflowRevision: 1 };
    const samples = [];
    let retained;
    for (let iteration = 0; iteration < sampleCount + warmup; iteration++) {
      retained = undefined; global.gc(); const before = process.memoryUsage().heapUsed;
      retained = (() => { const store = intContextStore(); for (let index = 0; index < 256; index++) store.Add({binding,layer:'L2',kind:'evidence',text:'fixed-small-body'}); return store; })();
      global.gc(); const delta = process.memoryUsage().heapUsed - before;
      if (iteration >= warmup) samples.push(delta);
    }
    if (retained.List(binding).length !== 256) throw new Error('Unexpected live artifact count');
    process.stdout.write(JSON.stringify(samples));
  `
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script, join(variant.directory, 'context-store.js'), String(samples), String(warmup)], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (child.status !== 0) throw new Error('Isolated memory benchmark failed: ' + child.stderr)
  const values = JSON.parse(child.stdout)
  memoryRows.push({ variant: variant.name, liveArtifacts: 256, retainedHeapBytes: summarize(values), rawRetainedHeapBytes: values })
}
const result = { schemaVersion: 1, recordedAt: new Date().toISOString(), node: process.versions.node, cpu: cpus()[0]?.model, platform: platform(), samples, warmup,
  methodology: 'Synthetic immutable contexts; alternating variant order. Pagination and List retain all authorization checks. Separate Node processes estimate retained heap for 256 live small artifacts with forced GC; GC noise is reported and this is not production peak memory, Host latency, LLM cost, or token savings.',
  complexity: { beforePagination: 'O(A * ceil(C/pageChars)) for A UTF-8 bytes and C UTF-16 code units', afterPagination: 'O(C + pageCount * authorizationChecks)', cacheSpace: 'One weak integer entry per private live artifact; no additional text or persisted schema fields; removed materials are not retained by the cache.' },
  sources: variants.map(({name,directory,moduleDigest}) => ({name,directory,moduleDigest})), rows, memoryRows }
const encoded = JSON.stringify(result, null, 2) + '\n'
if (option('--output')) await writeFile(resolve(option('--output')), encoded)
process.stdout.write(encoded)
