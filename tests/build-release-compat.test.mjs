import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BUILD_SCRIPT = join(REPOSITORY_ROOT, 'scripts/build-release-compat.mjs')
const CURRENT_VERIFY_SCRIPT = join(REPOSITORY_ROOT, 'scripts/verify-release-compat.mjs')
const APPLY_PATCH_SCRIPT = join(REPOSITORY_ROOT, 'scripts/apply-plugin-compat.mjs')
const COMPAT_DOCUMENT = join(REPOSITORY_ROOT, 'docs/3.4.1-第三方插件与兼容包.md')
const HOST_VERSION = '0.2.2-rc.3'
const COMPONENT_IDS = ['notebook', 'subscriptions', 'rigorquant', 'opencode-go', 'calculator', 'opencode-live']
const PRESERVED_COMPONENT_IDS = ['rigorquant', 'opencode-go', 'calculator', 'opencode-live']

const sha256 = value => createHash('sha256').update(value).digest('hex')
const fileSha256 = path => sha256(readFileSync(path))
const sortKeys = object => Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right)))

const writeFile = (path, content) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)

const walkFiles = root => {
  const rows = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`fixture 不接受符号链接: ${path}`)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) rows.push(relative(root, path).split('\\').join('/'))
      else throw new Error(`fixture 文件类型不支持: ${path}`)
    }
  }
  visit(root)
  return rows
}

const fileMap = root => sortKeys(Object.fromEntries(walkFiles(root).map(path => [path, fileSha256(join(root, path))])))

const python = (source, args) => execFileSync('python3', ['-c', source, ...args], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
})

const CREATE_DIRECTORY_TAR = String.raw`
import json
import sys
import tarfile

spec = json.loads(sys.stdin.read())
with tarfile.open(spec["archive"], "w:gz") as archive:
    archive.add(spec["source"], arcname=spec["arcname"])
`

const CREATE_MALICIOUS_TAR = String.raw`
import io
import json
import sys
import tarfile

spec = json.loads(sys.stdin.read())
root = spec["root"]
kind = spec["kind"]
with tarfile.open(spec["archive"], "w:gz") as archive:
    directory = tarfile.TarInfo(root)
    directory.type = tarfile.DIRTYPE
    directory.mode = 0o755
    archive.addfile(directory)
    if kind == "symlink":
        item = tarfile.TarInfo(root + "/components/notebook/escape")
        item.type = tarfile.SYMTYPE
        item.linkname = "../../outside"
        archive.addfile(item)
    elif kind == "hardlink":
        target = tarfile.TarInfo(root + "/components/notebook/target.txt")
        content = b"target\n"
        target.size = len(content)
        archive.addfile(target, io.BytesIO(content))
        item = tarfile.TarInfo(root + "/components/notebook/escape.txt")
        item.type = tarfile.LNKTYPE
        item.linkname = root + "/components/notebook/target.txt"
        archive.addfile(item)
    else:
        names = {
            "traversal": root + "/../escape.txt",
            "absolute": "/tmp/swarm-compat-escape.txt",
            "node_modules": root + "/node_modules/escape.js",
            "log": root + "/private/build.log",
            "credential": root + "/.npmrc",
        }
        item = tarfile.TarInfo(names[kind])
        content = b"escape\n"
        item.size = len(content)
        archive.addfile(item, io.BytesIO(content))
`

const INSPECT_TAR = String.raw`
import json
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    rows = []
    for member in archive.getmembers():
        rows.append({
            "name": member.name,
            "type": member.type.decode("latin-1"),
            "mode": member.mode,
            "uid": member.uid,
            "gid": member.gid,
            "mtime": member.mtime,
            "size": member.size,
        })
    print(json.dumps(rows))
`

const createDirectoryTar = (source, archive, arcname) => {
  execFileSync('python3', ['-c', CREATE_DIRECTORY_TAR], {
    input: JSON.stringify({ source, archive, arcname }),
    encoding: 'utf8',
  })
}

const createMaliciousTar = (archive, kind) => {
  execFileSync('python3', ['-c', CREATE_MALICIOUS_TAR], {
    input: JSON.stringify({ archive, kind, root: 'dsh-agent-swarm-3.4.0-rc3-compat' }),
    encoding: 'utf8',
  })
}

const inspectTar = archive => JSON.parse(python(INSPECT_TAR, [archive]))

const writeSupportFile = (root, path, content) => {
  writeFile(join(root, path), content)
}

const createComponent = ({
  root,
  id,
  packageName,
  version,
  extraFiles = {},
  skipOverlay = false,
}) => {
  const directory = join(root, 'components', id)
  const packageInfo = {
    name: packageName,
    version,
    private: true,
    license: 'MIT',
    type: 'module',
    main: id === 'notebook' ? 'lib/index.js' : 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  writeJson(join(directory, 'package.json'), packageInfo)
  writeSupportFile(directory, 'LICENSE', 'MIT fixture license\n')
  if (!skipOverlay) writeSupportFile(directory, 'cordis.patch.yml', `- insert:\n    - id: ${id}\n`)
  if (id === 'notebook') writeSupportFile(directory, 'lib/index.js', "export const notebook = 'template'\n")
  else writeSupportFile(directory, 'index.js', `export const component = '${id}'\n`)
  for (const [path, content] of Object.entries(extraFiles)) writeSupportFile(directory, path, content)
  return directory
}

const createBaseManifest = (baseRoot, options) => {
  const components = []
  for (const [id, packageName, version] of [
    ['notebook', '@beihaizb/dsh-notebook', '0.4.2+rc3.sandbox.3'],
    ['subscriptions', 'dsh-plugin-subscriptions', '0.9.13+rc3.transport.2'],
    ['rigorquant', 'dsh-rigorquant', '0.7.0+rc3.sidecar.2'],
    ['opencode-go', 'dsh-opencode-go', '0.4.4'],
    ['calculator', '@deepseek-ai/dsh-tool-calculator', '0.0.1+rc22.local.1'],
    ['opencode-live', 'dsh-opencode-live', '0.1.0+rc22.local.1'],
  ]) {
    components.push({
      id,
      name: packageName,
      version,
      directory: `components/${id}`,
      license: 'MIT',
      source: `fixture:${id}`,
      sourceCommit: '1111111111111111111111111111111111111111',
      runtimeFilesUnchanged: id !== 'notebook',
      originalArchiveSha256: id === 'notebook' ? sha256('old-notebook') : sha256(`old-${id}`),
      baseline: id === 'notebook' ? 'npm:@beihaizb/dsh-notebook@0.4.2' : id === 'subscriptions' ? 'npm:dsh-plugin-subscriptions@0.9.13' : `npm:${packageName}@${version}`,
      ...(id === 'notebook' || id === 'subscriptions' ? { patchManifest: `patches/${id}.json` } : {}),
      files: fileMap(join(baseRoot, 'components', id)),
    })
  }
  if (options.corruptManifestHash === true) components.find(component => component.id === 'rigorquant').files['index.js'] = sha256('not-the-component')
  const supportFiles = {}
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const rel = relative(baseRoot, path).split('\\').join('/')
      if (rel === 'compat-manifest.json' || rel === 'SHA256SUMS') continue
      if (rel === 'components' || rel.startsWith('components/')) continue
      if (entry.isDirectory()) visit(path)
      else supportFiles[rel] = fileSha256(path)
    }
  }
  visit(baseRoot)
  const manifest = {
    schemaVersion: 1,
    release: 'v3.4.0',
    hostVersion: HOST_VERSION,
    nodeMinimum: '24.9.0',
    components,
    notBundled: [{ name: 'fixture-private', reason: 'not distributable' }],
    supportFiles: sortKeys(supportFiles),
  }
  writeJson(join(baseRoot, 'compat-manifest.json'), manifest)
  const sums = walkFiles(baseRoot)
    .filter(path => path !== 'SHA256SUMS')
    .map(path => `${fileSha256(join(baseRoot, path))}  ${path}`)
    .join('\n')
  writeFile(join(baseRoot, 'SHA256SUMS'), `${sums}\n`)
  return manifest
}

const createFixture = (options = {}) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'swarm-build-compat-test-'))
  const templateParent = join(temporaryRoot, 'template')
  const baseRoot = join(templateParent, 'dsh-agent-swarm-3.4.0-rc3-compat')
  const sdk = join(temporaryRoot, 'sdk')
  const notebookOriginal = join(temporaryRoot, 'originals/notebook')
  const subscriptionsOriginal = join(temporaryRoot, 'originals/subscriptions')
  const notebookPackage = join(temporaryRoot, 'notebook-package')
  const notebookArchive = join(temporaryRoot, 'notebook.tgz')
  const baseArchive = join(temporaryRoot, 'base.tar.gz')
  const notebookVersion = options.notebookVersion ?? '0.4.2+rc3.sandbox.9'

  writeJson(join(sdk, '@deepseek-ai/dsh/package.json'), { name: '@deepseek-ai/dsh', version: HOST_VERSION })
  createComponent({
    root: baseRoot,
    id: 'notebook',
    packageName: '@beihaizb/dsh-notebook',
    version: '0.4.2+rc3.sandbox.3',
  })
  createComponent({
    root: baseRoot,
    id: 'subscriptions',
    packageName: 'dsh-plugin-subscriptions',
    version: '0.9.13+rc3.transport.2',
    extraFiles: {
      'keep.js': "export const keep = 'same'\n",
      'index.js': "export const subscriptions = 'final'\n",
      'new.js': "export const added = true\n",
      'no-eof.txt': 'value=final',
    },
  })
  for (const [id, packageName, version] of [
    ['rigorquant', 'dsh-rigorquant', '0.7.0+rc3.sidecar.2'],
    ['opencode-go', 'dsh-opencode-go', '0.4.4'],
    ['calculator', '@deepseek-ai/dsh-tool-calculator', '0.0.1+rc22.local.1'],
    ['opencode-live', 'dsh-opencode-live', '0.1.0+rc22.local.1'],
  ]) createComponent({ root: baseRoot, id, packageName, version, skipOverlay: options.skipOverlayFor === id })

  writeSupportFile(baseRoot, 'README.zh-CN.md', '# old fixture readme\n')
  writeSupportFile(baseRoot, 'KNOWN-ISSUES.zh-CN.md', '# old fixture issues\n')
  writeSupportFile(baseRoot, 'notebook-runtime.requirements.txt', 'ipykernel==7.1.0\n')
  writeSupportFile(baseRoot, 'licenses/notebook-LICENSE', 'MIT fixture license\n')
  writeSupportFile(baseRoot, 'licenses/subscriptions-LICENSE', 'MIT fixture license\n')
  writeSupportFile(baseRoot, 'host-patches/apply-dsh-step-bridge.mjs', '// fixture host patch\n')
  writeSupportFile(baseRoot, 'host-patches/apply-dsh-execution-boundary.mjs', '// fixture host patch\n')
  writeSupportFile(baseRoot, 'patches/notebook.json', '{}\n')
  writeSupportFile(baseRoot, 'patches/notebook.patch', '')
  writeSupportFile(baseRoot, 'patches/subscriptions.json', '{}\n')
  writeSupportFile(baseRoot, 'patches/subscriptions.patch', '')
  writeSupportFile(baseRoot, 'tools/apply-plugin-compat.mjs', readFileSync(APPLY_PATCH_SCRIPT))
  writeSupportFile(baseRoot, 'tools/verify-compat.mjs', '// old verifier fixture\n')
  writeJson(join(baseRoot, 'plugin-inventory.json'), {
    schemaVersion: 1,
    hostVersion: HOST_VERSION,
    plugins: [
      { name: '@beihaizb/dsh-notebook', version: '0.4.2+rc3.sandbox.3', distribution: 'compat component' },
      { name: 'dsh-plugin-subscriptions', version: '0.9.13+rc3.transport.2', distribution: 'compat component' },
    ],
  })

  writeJson(join(notebookOriginal, 'package.json'), {
    name: '@beihaizb/dsh-notebook',
    version: '0.4.2',
    license: 'MIT',
    type: 'module',
    main: 'lib/index.js',
  })
  writeSupportFile(notebookOriginal, 'LICENSE', 'MIT baseline license\n')
  writeSupportFile(notebookOriginal, 'lib/index.js', "export const notebook = 'baseline'\n")
  writeSupportFile(notebookOriginal, 'baseline-only.txt', 'must remain when applying a forward patch\n')

  writeJson(join(subscriptionsOriginal, 'package.json'), {
    name: 'dsh-plugin-subscriptions',
    version: '0.9.13',
    license: 'MIT',
    type: 'module',
    main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeSupportFile(subscriptionsOriginal, 'LICENSE', 'MIT baseline license\n')
  writeSupportFile(subscriptionsOriginal, 'cordis.patch.yml', '- insert:\n    - id: subscriptions\n')
  writeSupportFile(subscriptionsOriginal, 'index.js', "export const subscriptions = 'baseline'\n")
  writeSupportFile(subscriptionsOriginal, 'keep.js', "export const keep = 'same'\n")
  writeSupportFile(subscriptionsOriginal, 'no-eof.txt', 'value=baseline')
  writeSupportFile(subscriptionsOriginal, 'README.md', 'baseline-only QA document\n')

  createBaseManifest(baseRoot, options)
  if (options.corruptComponentBytes === true) writeSupportFile(baseRoot, 'components/rigorquant/index.js', "export const component = 'tampered'\n")

  createDirectoryTar(baseRoot, baseArchive, 'dsh-agent-swarm-3.4.0-rc3-compat')

  const finalNotebook = join(notebookPackage, 'package')
  writeJson(join(finalNotebook, 'package.json'), {
    name: '@beihaizb/dsh-notebook',
    version: notebookVersion,
    license: 'MIT',
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  if (options.notebookLicense !== false) writeSupportFile(finalNotebook, 'LICENSE', 'MIT notebook license\n')
  writeSupportFile(finalNotebook, 'cordis.patch.yml', '- insert:\n    - id: notebook\n')
  writeSupportFile(finalNotebook, 'README.md', '# notebook\n')
  writeSupportFile(finalNotebook, 'README.zh-CN.md', '# notebook zh\n')
  writeSupportFile(finalNotebook, 'lib/index.js', options.notebookBrokenImport === true
    ? "export * from './missing.js'\n"
    : "export const notebook = 'final'\n")
  writeSupportFile(finalNotebook, 'lib/client.js', "export const client = 'final'\n")
  writeSupportFile(finalNotebook, 'lib/notebook-snapshot-bridge.js', "export const bridge = 'snapshot'\n")
  writeSupportFile(finalNotebook, 'native/LICENSE', 'native fixture license\n')
  writeSupportFile(finalNotebook, 'native-pi-ai.mjs', "export const native = true\n")
  writeSupportFile(finalNotebook, 'vendor/DOMPurify.LICENSE.txt', 'DOMPurify vendored license\n')
  writeSupportFile(finalNotebook, 'vendor/DOMPurify.NOTICE.txt', 'DOMPurify vendored notice\n')
  writeSupportFile(finalNotebook, 'skills/notebook/SKILL.md', '# notebook skill\n')
  createDirectoryTar(finalNotebook, notebookArchive, 'package')

  return {
    temporaryRoot,
    baseArchive,
    baseSha256: fileSha256(baseArchive),
    notebookArchive,
    notebookSha256: fileSha256(notebookArchive),
    notebookVersion,
    notebookOriginal,
    subscriptionsOriginal,
    sdk,
    baseRoot,
  }
}

const buildArguments = (fixture, out, overrides = {}) => [
  '--version', overrides.version ?? '3.4.1',
  '--base-archive', overrides.baseArchive ?? fixture.baseArchive,
  '--base-sha256', overrides.baseSha256 ?? fixture.baseSha256,
  '--notebook-tarball', overrides.notebookArchive ?? fixture.notebookArchive,
  '--notebook-sha256', overrides.notebookSha256 ?? fixture.notebookSha256,
  '--notebook-original', fixture.notebookOriginal,
  '--subscriptions-original', fixture.subscriptionsOriginal,
  '--sdk', fixture.sdk,
  '--out', out,
]

const runBuild = (fixture, out, overrides = {}) => spawnSync(process.execPath, [BUILD_SCRIPT, ...buildArguments(fixture, out, overrides)], {
  cwd: REPOSITORY_ROOT,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})

const assertBuildSucceeded = result => {
  assert.equal(result.status, 0, `构建失败:\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  return JSON.parse(result.stdout)
}

const assertBuildFailed = (result, pattern, out) => {
  assert.notEqual(result.status, 0, `预期构建失败，但成功输出: ${result.stdout}`)
  assert.match(`${result.stderr}\n${result.stdout}`, pattern)
  assert.equal(existsSync(join(out, 'dsh-agent-swarm-3.4.1-dsh-0.2.2-rc.3-compat.tar.gz')), false)
  assert.equal(existsSync(join(out, 'third-party-manifest.json')), false)
}

test('从固定旧模板和动态 Notebook tgz 生成可复验、可确定的六组件兼容包', () => {
  const fixture = createFixture()
  const outOne = join(fixture.temporaryRoot, 'out-one')
  const outTwo = join(fixture.temporaryRoot, 'out-two')
  const beforeNotebookOriginal = fileMap(fixture.notebookOriginal)
  const beforeSubscriptionsOriginal = fileMap(fixture.subscriptionsOriginal)
  try {
    const first = assertBuildSucceeded(runBuild(fixture, outOne))
    const second = assertBuildSucceeded(runBuild(fixture, outTwo))
    const archiveName = 'dsh-agent-swarm-3.4.1-dsh-0.2.2-rc.3-compat.tar.gz'
    const firstArchive = join(outOne, archiveName)
    const secondArchive = join(outTwo, archiveName)
    assert.equal(first.tarballSha256, fileSha256(firstArchive))
    assert.equal(first.tarballSha256, second.tarballSha256)
    assert.equal(fileSha256(firstArchive), fileSha256(secondArchive))
    assert.equal(readFileSync(join(outOne, 'third-party-manifest.json'), 'utf8'), readFileSync(join(outTwo, 'third-party-manifest.json'), 'utf8'))
    assert.deepEqual(fileMap(fixture.notebookOriginal), beforeNotebookOriginal)
    assert.deepEqual(fileMap(fixture.subscriptionsOriginal), beforeSubscriptionsOriginal)
    assert.equal(first.patchRoundtrip.notebook.apply, 'patched')
    assert.equal(first.patchRoundtrip.notebook.check, 'verified')
    assert.equal(first.patchRoundtrip.notebook.restore, 'restored')
    assert.equal(first.patchRoundtrip.notebook.baselineOnlyFilesPreserved, true)
    assert.equal(first.patchRoundtrip.subscriptions.baselineOnlyFilesPreserved, true)

    const headers = inspectTar(firstArchive)
    assert.equal(headers[0].name, 'dsh-agent-swarm-3.4.1-rc3-compat')
    assert.deepEqual(headers.map(row => row.name), headers.map(row => row.name).toSorted())
    assert.ok(headers.every(row => row.uid === 0 && row.gid === 0 && row.mtime === 0))
    assert.ok(headers.every(row => row.type === '5' || row.type === '0'))
    const gzip = readFileSync(firstArchive)
    assert.equal(gzip.subarray(4, 8).toString('hex'), '00000000')

    const unpacked = join(fixture.temporaryRoot, 'unpacked')
    mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', firstArchive, '-C', unpacked], { stdio: 'pipe' })
    const artifactRoot = join(unpacked, 'dsh-agent-swarm-3.4.1-rc3-compat')
    execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: artifactRoot, stdio: 'pipe' })
    const manifest = JSON.parse(readFileSync(join(artifactRoot, 'compat-manifest.json'), 'utf8'))
    assert.equal(manifest.release, 'v3.4.1')
    assert.equal(manifest.components.length, 6)
    assert.deepEqual(manifest.components.map(component => component.id).sort(), [...COMPONENT_IDS].sort())
    const notebook = manifest.components.find(component => component.id === 'notebook')
    assert.equal(notebook.version, fixture.notebookVersion)
    assert.equal(notebook.runtimeFilesUnchanged, false)
    assert.ok(notebook.files['lib/notebook-snapshot-bridge.js'])
    assert.ok(notebook.files['vendor/DOMPurify.LICENSE.txt'])
    assert.ok(notebook.files['vendor/DOMPurify.NOTICE.txt'])
    for (const id of PRESERVED_COMPONENT_IDS) {
      const component = manifest.components.find(row => row.id === id)
      assert.equal(component.runtimeFilesUnchanged, true)
      assert.deepEqual(fileMap(join(artifactRoot, 'components', id)), fileMap(join(fixture.baseRoot, 'components', id)))
    }
    assert.equal(readFileSync(join(artifactRoot, 'tools/verify-compat.mjs'), 'utf8'), readFileSync(CURRENT_VERIFY_SCRIPT, 'utf8'))
    assert.equal(readFileSync(join(artifactRoot, 'README.zh-CN.md'), 'utf8'), readFileSync(COMPAT_DOCUMENT, 'utf8'))
    assert.doesNotMatch(readFileSync(join(artifactRoot, 'README.zh-CN.md'), 'utf8'), /1792项|Node64项|Host56项/)
    assert.match(readFileSync(join(artifactRoot, 'KNOWN-ISSUES.zh-CN.md'), 'utf8'), /v3\.4\.0 历史基线/)
    const inventory = JSON.parse(readFileSync(join(artifactRoot, 'plugin-inventory.json'), 'utf8'))
    assert.equal(inventory.plugins.find(plugin => plugin.name === '@beihaizb/dsh-notebook').version, fixture.notebookVersion)
    assert.equal(inventory.plugins.find(plugin => plugin.name === 'dsh-plugin-subscriptions').version, '0.9.13+rc3.transport.2')
    const notebookPlan = JSON.parse(readFileSync(join(artifactRoot, 'patches/notebook.json'), 'utf8'))
    assert.ok(notebookPlan.files.some(row => row.path === 'lib/notebook-snapshot-bridge.js' && row.beforeSha256 === null))
    const subscriptionsPlan = JSON.parse(readFileSync(join(artifactRoot, 'patches/subscriptions.json'), 'utf8'))
    assert.ok(subscriptionsPlan.files.some(row => row.path === 'new.js' && row.beforeSha256 === null))
    assert.match(readFileSync(join(artifactRoot, 'patches/subscriptions.patch'), 'utf8'), /\\ No newline at end of file/)
    assert.equal(subscriptionsPlan.files.some(row => row.path === 'README.md'), false)
    assert.equal(
      readFileSync(join(artifactRoot, 'compat-manifest.json'), 'utf8'),
      readFileSync(join(outOne, 'third-party-manifest.json'), 'utf8'),
    )
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true })
  }
})

test('声明 overlay 缺失时即使主入口存在也拒绝产出', () => {
  const fixture = createFixture({ skipOverlayFor: 'rigorquant' })
  const out = join(fixture.temporaryRoot, 'out')
  try {
    assertBuildFailed(runBuild(fixture, out), /声明入口.*cordis|声明入口缺失/, out)
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true })
  }
})

test('输入归档摘要不匹配或内部内容被篡改时拒绝产出', () => {
  const fixture = createFixture()
  const out = join(fixture.temporaryRoot, 'out')
  try {
    const tamperedArchive = join(fixture.temporaryRoot, 'tampered.tar.gz')
    copyFileSync(fixture.baseArchive, tamperedArchive)
    appendFileSync(tamperedArchive, Buffer.from([0]))
    assertBuildFailed(
      runBuild(fixture, out, { baseArchive: tamperedArchive }),
      /base.*SHA-256|base-archive.*摘要|归档摘要/,
      out,
    )
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true })
  }

  const manifestFixture = createFixture({ corruptManifestHash: true })
  const manifestOut = join(manifestFixture.temporaryRoot, 'out')
  try {
    assertBuildFailed(runBuild(manifestFixture, manifestOut), /摘要不匹配/, manifestOut)
  } finally {
    rmSync(manifestFixture.temporaryRoot, { recursive: true, force: true })
  }

  const bytesFixture = createFixture({ corruptComponentBytes: true })
  const bytesOut = join(bytesFixture.temporaryRoot, 'out')
  try {
    assertBuildFailed(runBuild(bytesFixture, bytesOut), /摘要不匹配/, bytesOut)
  } finally {
    rmSync(bytesFixture.temporaryRoot, { recursive: true, force: true })
  }
})

test('拒绝 symlink、hardlink、绝对或父目录路径、node_modules、日志和凭据', () => {
  const fixture = createFixture()
  try {
    for (const kind of ['symlink', 'hardlink', 'traversal', 'absolute', 'node_modules', 'log', 'credential']) {
      const archive = join(fixture.temporaryRoot, `malicious-${kind}.tgz`)
      createMaliciousTar(archive, kind)
      const out = join(fixture.temporaryRoot, `malicious-out-${kind}`)
      assertBuildFailed(
        runBuild(fixture, out, { baseArchive: archive, baseSha256: fileSha256(archive) }),
        /symlink|hardlink|路径|node_modules|日志|凭据/i,
        out,
      )
    }
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true })
  }
})

test('新 Notebook 缺 license 或相对 import 不闭合时拒绝产出', () => {
  const missingLicense = createFixture({ notebookLicense: false })
  const licenseOut = join(missingLicense.temporaryRoot, 'out')
  try {
    assertBuildFailed(runBuild(missingLicense, licenseOut), /license|许可证/i, licenseOut)
  } finally {
    rmSync(missingLicense.temporaryRoot, { recursive: true, force: true })
  }

  const brokenImport = createFixture({ notebookBrokenImport: true })
  const importOut = join(brokenImport.temporaryRoot, 'out')
  try {
    assertBuildFailed(runBuild(brokenImport, importOut), /相对导入/, importOut)
  } finally {
    rmSync(brokenImport.temporaryRoot, { recursive: true, force: true })
  }
})
