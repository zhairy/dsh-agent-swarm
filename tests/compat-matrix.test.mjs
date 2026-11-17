import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ValidateCompatMatrix } from '../scripts/verify-compat-matrix.mjs'

const RC3 = '0.2.2-rc.3'
const RC1 = '0.2.2-rc.1'
const script = fileURLToPath(new URL('../scripts/verify-compat-matrix.mjs', import.meta.url))
const definitionPath = fileURLToPath(new URL('../compat/v3.4.1-matrix.json', import.meta.url))

const sha = value => createHash('sha256').update(value).digest('hex')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

// 真实 gzip/tar 夹具；不调用 npm 或包生命周期脚本。
const packFixture = (fixture, mode = '') => {
  const artifact = join(fixture.base, 'fixture-swarm.tgz')
  const run = spawnSync('python3', ['-I', '-c', `
import io, os, sys, tarfile
root, target, mode = sys.argv[1:]
with tarfile.open(target, 'w:gz') as archive:
    for directory, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, root).replace(os.sep, '/')
            if mode == 'omit' and relative == 'lib/cm-vendor.js': continue
            archive.add(path, arcname='package/' + relative, recursive=False)
    if mode in ('symlink', 'hardlink', 'fifo', 'escape', 'duplicate'):
        member = tarfile.TarInfo('package/../escape' if mode == 'escape' else 'package/lib/index.js' if mode == 'duplicate' else 'package/unsafe')
        if mode == 'symlink': member.type = tarfile.SYMTYPE; member.linkname = '/etc/passwd'
        if mode == 'hardlink': member.type = tarfile.LNKTYPE; member.linkname = 'package/package.json'
        if mode == 'fifo': member.type = tarfile.FIFOTYPE
        archive.addfile(member, io.BytesIO(b''))
`, fixture.component, artifact, mode], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return artifact
}

const createFixture = () => {
  const base = mkdtempSync(join(tmpdir(), 'swarm-compat-matrix-'))
  const repositoryRoot = join(base, 'repo')
  const sdk = join(base, 'sdk')
  const component = join(repositoryRoot, 'components/swarm')
  const hostRoot = join(sdk, '@deepseek-ai/dsh')
  const patchTarget = join(sdk, '@deepseek-ai/dsh-agent-loop/lib/index.js')
  const artifact = join(repositoryRoot, 'patches/fixture.patch')
  const native = 'export const marker = "native"\n'
  const patched = 'export const marker = "patched"\n'

  write(join(hostRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: RC3,
    bin: { dsh: 'lib/bin.js' },
    dependencies: {}
  }))
  write(join(hostRoot, 'lib/bin.js'), 'export {}\n')
  write(join(sdk, '@deepseek-ai/dsh-agent-loop/package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-agent-loop',
    version: RC3
  }))
  write(patchTarget, patched)
  write(artifact, 'fixture patch artifact\n')

  const componentPackage = {
    name: 'fixture-swarm',
    version: '3.4.1',
    exports: { '.': './lib/index.js' },
    files: ['lib']
  }
  write(join(component, 'package.json'), JSON.stringify(componentPackage))
  write(join(component, 'lib/index.js'), "import './dep.js'\nexport const value = 42\n")
  write(join(component, 'lib/dep.js'), 'export const dependency = true\n')

  const definition = {
    schemaVersion: 1,
    releaseVersion: '3.4.1',
    defaultHostVersion: RC3,
    components: [{
      id: 'swarm',
      packageName: 'fixture-swarm',
      version: '${releaseVersion}',
      defaultPath: 'components/swarm',
      required: true,
      requiredForHosts: [RC3],
      requiredEntries: ['lib/index.js'],
      patches: []
    }],
    hosts: {
      [RC3]: {
        role: 'local-target',
        claim: 'v3.4.1-local',
        verifyInternalVersions: true,
        requiredChecks: ['host-runtime'],
        patches: [{
          id: 'step-bridge',
          type: 'sha-state',
          target: '@deepseek-ai/dsh-agent-loop/lib/index.js',
          originalSha256: sha(native),
          patchedSha256: sha(patched),
          artifact: 'patches/fixture.patch',
          artifactSha256: sha('fixture patch artifact\n'),
          requiredState: 'patched'
        }]
      },
      [RC1]: {
        role: 'retained',
        claim: 'rc1-retained-only',
        verifyInternalVersions: true,
        requiredChecks: ['metadata-only'],
        patches: []
      }
    },
    checks: {
      'host-runtime': {
        kind: 'host-runtime',
        hostVersion: RC3,
        command: [process.execPath, '-e', "process.stdout.write(process.env.SWARM_MATRIX_HOST_VERSION ?? 'missing')"],
        timeoutMs: 10_000
      },
      'metadata-only': {
        kind: 'metadata',
        hostVersion: RC1,
        command: [process.execPath, '-e', 'process.exit(0)'],
        timeoutMs: 10_000
      }
    }
  }

  const saveDefinition = (target = join(repositoryRoot, 'compat-matrix.json')) => {
    write(target, JSON.stringify(definition, null, 2))
    return target
  }
  const options = evidenceDirectory => ({
    repositoryRoot,
    hostVersion: RC3,
    sdkPath: sdk,
    evidenceDirectory,
    runChecks: true
  })
  return {
    base,
    repositoryRoot,
    sdk,
    component,
    hostRoot,
    patchTarget,
    artifact,
    native,
    patched,
    definition,
    saveDefinition,
    options
  }
}

test('精确 Host、组件闭包、补丁和真实 Host 检查全部绑定后才是 verified', () => {
  const fixture = createFixture()
  const evidence = join(fixture.base, 'evidence')
  try {
    const result = ValidateCompatMatrix(fixture.definition, fixture.options(evidence))
    assert.equal(result.status, 'verified')
    assert.equal(result.exitCode, 0)
    assert.equal(result.target.hostVersion, RC3)
    assert.equal(result.host.packageVersion, RC3)
    assert.equal(result.host.patches[0].state, 'patched')
    assert.equal(result.components.swarm.version, '3.4.1')
    assert.ok(result.components.swarm.entryFiles.includes('lib/index.js'))
    assert.equal(result.components.swarm.files['lib/dep.js'], sha('export const dependency = true\n'))
    assert.equal(result.checks[0].exitCode, 0)
    assert.equal(result.checks[0].kind, 'host-runtime')
    assert.equal(result.checks[0].evidence.stdoutSha256, sha(RC3))
    assert.ok(existsSync(result.checks[0].evidence.stdout))
    assert.ok(existsSync(result.evidence.summary))
    assert.equal(JSON.parse(readFileSync(result.evidence.summary, 'utf8')).status, 'verified')
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('正式矩阵定义只把 rc3 设为本机目标，rc1 保持独立 retained 声明', () => {
  const definition = JSON.parse(readFileSync(definitionPath, 'utf8'))
  assert.equal(definition.releaseVersion, '3.4.1')
  assert.equal(definition.defaultHostVersion, RC3)
  assert.equal(definition.hosts[RC3].role, 'local-target')
  assert.equal(definition.hosts[RC3].claim, 'v3.4.1-local')
  assert.equal(definition.hosts[RC1].role, 'retained')
  assert.equal(definition.hosts[RC1].claim, 'rc1-retained-only')
  assert.ok(definition.hosts[RC3].requiredChecks.includes('rc3-step-model-host'))
  assert.equal(definition.checks['rc3-step-model-host'].kind, 'host-runtime')
  assert.equal(definition.checks['rc3-step-model-host'].hostVersion, RC3)
  assert.equal(definition.checks['rc3-step-model-host'].requiredSdkPath, '.sandbox/dsh-0.2.2-rc.3/node_modules')

  const components = Object.fromEntries(definition.components.map(component => [component.id, component]))
  assert.deepEqual(components.swarm.requiredArtifactForHosts, [RC3])
  assert.equal(components.notebook.defaultPath, 'third_party/dsh-notebook')
  assert.ok(components.notebook.requiredEntries.includes('lib/notebook-host-context.js'))
  assert.ok(components.notebook.requiredEntries.includes('lib/notebook-runtime.js'))
  assert.ok(components.notebook.requiredEntries.includes('lib/notebook-snapshot-bridge.js'))
  assert.equal(components.notebook.patches[0].plan, 'patches/dsh-notebook-0.4.2-rc3-snapshot.json')
  assert.equal(
    components.notebook.patches[0].planSha256,
    '435b15e4242378209e108c17b3f9c94f0a86e62c089f83fe698705948a5cad7b'
  )
  const notebookPlan = JSON.parse(readFileSync(join(dirname(definitionPath), '..', components.notebook.patches[0].plan), 'utf8'))
  assert.equal(components.notebook.version, '0.4.2+rc3.sandbox.9')
  assert.equal(components.notebook.distributionSha256, '36a518ed879c27d6110c42d78357abafdac00d1c65946e192563034c0189a353')
  assert.equal(notebookPlan.targetVersion, '0.4.2+rc3.sandbox.9')
  assert.equal(notebookPlan.patchSha256, '884e8d1399e113294b76a8fb7c897d2fb122e804ff1f000c7075badc805792a8')
  for (const row of notebookPlan.files) {
    const actual = sha(readFileSync(join(dirname(definitionPath), '..', 'third_party/dsh-notebook', row.path)))
    assert.equal(actual, row.afterSha256)
  }

  assert.equal(components.subscriptions.version, '0.9.13+rc3.transport.2')
  assert.equal(components.subscriptions.defaultPath, undefined)
  assert.equal(components.subscriptions.distributionSha256, '79955b8ef455d4a48c50afea738053f0ebade8cb382b6407f2753f6bb33da41d')
  assert.equal(
    components.subscriptions.patches[0].plan,
    'compat/subscriptions-0.9.13-rc3-transport.2/subscriptions.json'
  )
  const subscriptionPlanPath = join(dirname(definitionPath), '..', components.subscriptions.patches[0].plan)
  assert.equal(
    sha(readFileSync(subscriptionPlanPath)),
    '3707bd4f5d849b1302874cfc1dbc2ff161c905bc57d85b1faaa2fa3a09bc17c5'
  )
  const subscriptionPlan = JSON.parse(readFileSync(subscriptionPlanPath, 'utf8'))
  assert.equal(subscriptionPlan.patch, 'subscriptions.patch')
  assert.equal(subscriptionPlan.patchSha256, '513f3ec79b732b44006c5f16a6a03722e1b98ae4745a62876b6a2c1a96458ca4')
  const subscriptionPackageRow = subscriptionPlan.files.find(row => row.path === 'package.json')
  assert.equal(subscriptionPackageRow.afterSha256, '243f71310ee0bc50d21267b5e08aab58762f24fbb19905d5a17a0d03d569ffd5')
  assert.equal(
    sha(readFileSync(join(dirname(subscriptionPlanPath), subscriptionPlan.patch))),
    subscriptionPlan.patchSha256
  )
  assert.doesNotMatch(JSON.stringify(definition), /dsh-notebook-0\.4\.2-rc3-runtime|dsh-subscriptions-0\.9\.13-rc3-transport/)
  assert.deepEqual(definition.hosts[RC3].requiredChecks, [
    'release-package-closure',
    'rc3-step-model-host',
    'primary-live-boundary',
    'linked-verification-boundary',
    'notebook-js-browser-host',
    'notebook-double-boot-host',
    'notebook-snapshot',
    'route-observability-offline'
  ])
  assert.equal(definition.checks['primary-live-boundary'].kind, 'host-runtime')
  assert.equal(definition.checks['linked-verification-boundary'].kind, 'host-runtime')
  assert.equal(definition.checks['notebook-double-boot-host'].kind, 'host-runtime')
  const legacyNotebook = definition.checks['notebook-js-browser-host']
  assert.equal(legacyNotebook.kind, 'host-runtime')
  assert.equal(legacyNotebook.hostVersion, RC3)
  assert.equal(legacyNotebook.requiredSdkPath, '.sandbox/dsh-0.2.2-rc.3/node_modules')
  assert.equal(legacyNotebook.timeoutMs, 660000)
  assert.deepEqual(legacyNotebook.requiredEnv, ['DSH_NOTEBOOK_CONTROLLER_PYTHON'])
  assert.deepEqual(legacyNotebook.command, [
    'node', 'scripts/verify-notebook-host.mjs', '--dsh', '${sdk}',
    '--swarm', '${component:swarm}', '--notebook', '${component:notebook}',
    '--python', '${env:DSH_NOTEBOOK_CONTROLLER_PYTHON}', '--out', '${evidenceRun}/notebook-js-browser'
  ])
  assert.deepEqual(definition.checks['notebook-double-boot-host'].requiredEnv, ['DSH_NOTEBOOK_CONTROLLER_PYTHON'])
  assert.ok(definition.checks['notebook-double-boot-host'].command.includes('${env:DSH_NOTEBOOK_CONTROLLER_PYTHON}'))
  assert.ok(definition.checks['primary-live-boundary'].command.includes('${sdk}'))
  assert.ok(definition.checks['linked-verification-boundary'].command.includes('--verify-linked'))
  for (const id of ['primary-live-boundary', 'linked-verification-boundary']) {
    const command = definition.checks[id].command
    assert.equal(command[command.indexOf('--bundle') + 1], '${component:swarm}')
  }
  const notebookCommand = definition.checks['notebook-double-boot-host'].command
  assert.equal(notebookCommand[notebookCommand.indexOf('--swarm') + 1], '${component:swarm}')
  assert.equal(notebookCommand[notebookCommand.indexOf('--notebook') + 1], '${component:notebook}')
  assert.equal(definition.checks['notebook-snapshot'].kind, 'offline')
  assert.equal(definition.checks['route-observability-offline'].kind, 'offline')
})

test('plugin plan 的 targetVersion 必须与当前组件版本精确一致', () => {
  const fixture = createFixture()
  try {
    const componentFile = join(fixture.component, 'lib/index.js')
    const afterSha256 = sha(readFileSync(componentFile))
    const patch = 'fixture composite patch\n'
    write(join(fixture.repositoryRoot, 'patches/fixture-composite.patch'), patch)
    const plan = {
      schemaVersion: 1,
      packageName: 'fixture-swarm',
      baseVersion: '3.4.1',
      targetVersion: '3.4.1',
      patch: 'fixture-composite.patch',
      patchSha256: sha(patch),
      files: [{
        path: 'lib/index.js',
        beforeSha256: sha('previous composite bytes\n'),
        afterSha256
      }]
    }
    const planText = JSON.stringify(plan)
    write(join(fixture.repositoryRoot, 'patches/fixture-composite.json'), planText)
    fixture.definition.components[0].patches = [{
      id: 'fixture-composite',
      type: 'plugin-plan',
      plan: 'patches/fixture-composite.json',
      planSha256: sha(planText),
      baseVersion: '3.4.1',
      requiredState: 'patched'
    }]

    const verified = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'plan-green')))
    assert.equal(verified.status, 'verified')

    plan.targetVersion = '3.4.0'
    const changedPlan = JSON.stringify(plan)
    write(join(fixture.repositoryRoot, 'patches/fixture-composite.json'), changedPlan)
    fixture.definition.components[0].patches[0].planSha256 = sha(changedPlan)
    const rejected = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'plan-red')))
    assert.equal(rejected.status, 'rejected')
    assert.match(rejected.reasons.join('\n'), /targetVersion/)
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('精确组件 tgz 必须按声明 SHA 匹配', () => {
  const fixture = createFixture()
  try {
    const artifact = packFixture(fixture)
    const artifactSha = sha(readFileSync(artifact))
    fixture.definition.components[0].distributionSha256 = artifactSha
    const verified = ValidateCompatMatrix(fixture.definition, {
      ...fixture.options(join(fixture.base, 'artifact-green')),
      artifactPaths: { swarm: artifact }
    })
    assert.equal(verified.status, 'verified')
    assert.equal(verified.components.swarm.distribution.sha256, artifactSha)

    write(artifact, 'changed component archive\n')
    const rejected = ValidateCompatMatrix(fixture.definition, {
      ...fixture.options(join(fixture.base, 'artifact-red')),
      artifactPaths: { swarm: artifact }
    })
    assert.equal(rejected.status, 'rejected')
    assert.match(rejected.reasons.join('\n'), /精确包摘要/)
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('artifact 全文件门禁拒绝 CM vendor/README 修改、目录缺失或额外运行文件与归档遗漏', () => {
  for (const mode of ['vendor', 'readme', 'missing', 'extra', 'omit']) {
    const fixture = createFixture()
    try {
      write(join(fixture.component, 'lib/cm-vendor.js'), 'export const CM = true\n')
      write(join(fixture.component, 'README.md'), 'exact readme\n')
      const artifact = packFixture(fixture, mode)
      fixture.definition.components[0].distributionSha256 = sha(readFileSync(artifact))
      if (mode === 'vendor') write(join(fixture.component, 'lib/cm-vendor.js'), 'export const CM = false\n')
      if (mode === 'readme') write(join(fixture.component, 'README.md'), 'changed readme\n')
      if (mode === 'missing') rmSync(join(fixture.component, 'lib/cm-vendor.js'))
      if (mode === 'extra') write(join(fixture.component, 'lib/extra-runtime.js'), 'export {}\n')
      const result = ValidateCompatMatrix(fixture.definition, {
        ...fixture.options(join(fixture.base, 'archive-evidence')), artifactPaths: { swarm: artifact }
      })
      assert.equal(result.status, 'rejected', mode)
      assert.equal(result.checks.length, 0, mode)
      assert.match(result.reasons.join('\n'), /归档|精确包/, mode)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  }
})

test('文本假 tgz、symlink/hardlink/特殊类型、越界与重复 member 均拒绝', () => {
  for (const mode of ['text', 'symlink', 'hardlink', 'fifo', 'escape', 'duplicate']) {
    const fixture = createFixture()
    try {
      const artifact = packFixture(fixture, mode)
      if (mode === 'text') write(artifact, 'exact component archive\n')
      fixture.definition.components[0].distributionSha256 = sha(readFileSync(artifact))
      const result = ValidateCompatMatrix(fixture.definition, {
        ...fixture.options(join(fixture.base, 'bad-archive-evidence')), artifactPaths: { swarm: artifact }
      })
      assert.equal(result.status, 'rejected', mode)
      assert.equal(result.checks.length, 0, mode)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  }
})

test('Swarm requiredArtifact 不固定自身 SHA；有效 tgz 可通过且忽略 node_modules 安装元数据', () => {
  const fixture = createFixture()
  try {
    fixture.definition.components[0].requiredArtifactForHosts = [RC3]
    const missing = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'required-archive')))
    assert.equal(missing.status, 'unverified')
    const artifact = packFixture(fixture)
    write(join(fixture.component, 'node_modules/.package-lock.json'), '{}')
    write(join(fixture.component, 'package-lock.json'), '{}')
    const result = ValidateCompatMatrix(fixture.definition, {
      ...fixture.options(join(fixture.base, 'exact-archive')), artifactPaths: { swarm: artifact }
    })
    assert.equal(result.status, 'verified', result.reasons.join('\n'))
    assert.equal(result.components.swarm.distribution.sha256, sha(readFileSync(artifact)))
    assert.equal(result.components.swarm.distribution.files['lib/dep.js'].sha256, sha(readFileSync(join(fixture.component, 'lib/dep.js'))))
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('检查命令参数展开 sdk 与 evidenceRun 占位符', () => {
  const fixture = createFixture()
  const envKey = 'SWARM_MATRIX_TEST_PYTHON'
  const previousEnv = process.env[envKey]
  try {
    process.env[envKey] = join(fixture.base, 'venv/bin/python')
    fixture.definition.checks['host-runtime'].command = [
      process.execPath,
      '-e',
      `const [sdk,out,python]=process.argv.slice(1);if(sdk!==process.env.SWARM_DSH_MODULES||!out.endsWith('/linked-host')||python!==process.env.${envKey})process.exit(9);process.stdout.write(sdk+'|'+out+'|'+python)`,
      '${sdk}',
      '${evidenceRun}/linked-host',
      `\${env:${envKey}}`
    ]
    fixture.definition.checks['host-runtime'].requiredEnv = [envKey]
    const result = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'token-evidence')))
    assert.equal(result.status, 'verified')
    assert.equal(result.checks[0].exitCode, 0)
    assert.equal(result.checks[0].command[3], fixture.sdk)
    assert.equal(result.checks[0].command[4], join(result.evidence.run, 'linked-host'))
    assert.equal(result.checks[0].command[5], process.env[envKey])
  } finally {
    if (previousEnv === undefined) delete process.env[envKey]
    else process.env[envKey] = previousEnv
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('primary/linked 与双 boot 的真实命令使用已核验自定义组件目录，环境变量不能替代组件路径', () => {
  const fixture = createFixture()
  const envKeys = ['DSH_NOTEBOOK_CONTROLLER_PYTHON', 'component:swarm', 'component:notebook']
  const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  try {
    // 保留仓库默认候选，再选择树外目录，防止遗漏参数后悄悄测回源码树。
    const swarm = join(fixture.base, 'extracted packages/主包')
    const notebook = join(fixture.base, 'extracted packages/Notebook')
    cpSync(fixture.component, swarm, { recursive: true })
    write(join(notebook, 'package.json'), JSON.stringify({
      name: 'fixture-notebook', version: '0.4.2+rc3.sandbox.9', main: 'lib/index.js'
    }))
    write(join(notebook, 'lib/index.js'), 'export const notebook = true\n')
    fixture.definition.components.push({
      id: 'notebook', packageName: 'fixture-notebook', version: '0.4.2+rc3.sandbox.9', required: true
    })
    process.env.DSH_NOTEBOOK_CONTROLLER_PYTHON = join(fixture.base, 'venv/bin/python')
    process.env['component:swarm'] = fixture.repositoryRoot
    process.env['component:notebook'] = fixture.component
    const definition = JSON.parse(readFileSync(definitionPath, 'utf8'))
    const ids = ['primary-live-boundary', 'linked-verification-boundary', 'notebook-js-browser-host', 'notebook-double-boot-host']
    fixture.definition.hosts[RC3].requiredChecks = ids
    for (const id of ids) {
      const swarmFlag = id.startsWith('notebook-') ? '--swarm' : '--bundle'
      const source = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const argv = process.argv.slice(1);
        const option = key => { assert.ok(argv.includes(key), key); return argv[argv.indexOf(key) + 1]; };
        const swarm = option(${JSON.stringify(swarmFlag)});
        assert.equal(swarm, ${JSON.stringify(swarm)});
        assert.equal(process.env.MATRIX_SELECTED_SWARM, swarm);
        assert.equal(process.env.MATRIX_SELECTED_NOTEBOOK, ${JSON.stringify(notebook)});
        assert.equal(process.cwd(), ${JSON.stringify(fixture.repositoryRoot)});
        assert.equal(option('--dsh'), process.env.SWARM_DSH_MODULES);
        assert.equal(JSON.parse(fs.readFileSync(path.join(swarm, 'package.json'))).name, 'fixture-swarm');
        if (${JSON.stringify(id)}.startsWith('notebook-')) {
          assert.equal(option('--notebook'), ${JSON.stringify(notebook)});
          assert.equal(JSON.parse(fs.readFileSync(path.join(option('--notebook'), 'package.json'))).name, 'fixture-notebook');
          assert.equal(option('--python'), process.env.DSH_NOTEBOOK_CONTROLLER_PYTHON);
        }
        process.stdout.write(JSON.stringify(argv));
      `
      fixture.definition.checks[id] = {
        kind: 'host-runtime',
        hostVersion: RC3,
        cwd: '${repositoryRoot}',
        command: [process.execPath, '-e', source, '--', ...definition.checks[id].command.slice(2)],
        env: { MATRIX_SELECTED_SWARM: '${component:swarm}', MATRIX_SELECTED_NOTEBOOK: '${component:notebook}' }
      }
    }
    const result = ValidateCompatMatrix(fixture.definition, {
      ...fixture.options(join(fixture.base, 'selected-components-evidence')),
      componentPaths: { swarm, notebook }
    })
    assert.equal(result.status, 'verified', result.checks.map(check => readFileSync(check.evidence.stderr, 'utf8')).join('\n') || result.reasons.join('\n'))
    assert.equal(result.components.swarm.root, swarm)
    assert.equal(result.components.notebook.root, notebook)
    assert.equal(result.checks.length, ids.length)
    for (const check of result.checks) {
      assert.equal(check.exitCode, 0)
      assert.deepEqual(JSON.parse(readFileSync(check.evidence.stdout, 'utf8')), check.command.slice(4))
    }
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('组件占位符在命令、环境变量和工作目录使用同一核验目录', () => {
  const fixture = createFixture()
  try {
    fixture.definition.checks['host-runtime'] = {
      kind: 'host-runtime',
      hostVersion: RC3,
      cwd: '${component:swarm}',
      env: { MATRIX_SELECTED_COMPONENT: '${component:swarm}' },
      command: [process.execPath, '-e', `
        const assert = require('node:assert/strict');
        assert.equal(process.argv[1], ${JSON.stringify(fixture.component)});
        assert.equal(process.cwd(), process.argv[1]);
        assert.equal(process.env.MATRIX_SELECTED_COMPONENT, process.argv[1]);
      `, '${component:swarm}']
    }
    const result = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'shared-variables')))
    assert.equal(result.status, 'verified', result.reasons.join('\n'))
    assert.equal(result.checks[0].exitCode, 0)
    assert.equal(result.checks[0].cwd, fixture.component)
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('未知或缺失组件占位符、未知普通占位符在任何检查启动前拒绝', () => {
  const fixture = createFixture()
  try {
    fixture.definition.components.push({
      id: 'notebook', packageName: 'fixture-notebook', version: '0.4.2+rc3.sandbox.9'
    })
    const marker = join(fixture.base, 'must-not-run')
    fixture.definition.checks['host-runtime'].command = [
      process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
    ]
    fixture.definition.hosts[RC3].requiredChecks.push('invalid-placeholder')
    const cases = [
      ['${component:missing}', /component:missing/],
      ['${component:notebook}', /component:notebook/],
      ['${unknownPlaceholder}', /unknownPlaceholder/],
      ['${component:}', /component:/]
    ]
    for (const [token, reason] of cases) {
      for (const field of ['command', 'env', 'cwd']) {
        const check = {
          kind: 'host-runtime', hostVersion: RC3,
          command: [process.execPath, '-e', 'process.exit(0)']
        }
        if (field === 'command') check.command.push(token)
        else if (field === 'env') check.env = { MATRIX_INVALID_TOKEN: token }
        else check.cwd = token
        fixture.definition.checks['invalid-placeholder'] = check
        const result = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'invalid-token-evidence')))
        assert.equal(result.status, 'rejected', `${field}: ${token}`)
        assert.match(result.reasons.join('\n'), reason)
        assert.equal(result.checks.length, 0)
        assert.equal(existsSync(marker), false, `${field}: ${token} 启动了前序检查`)
      }
    }
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('metadata-only、未执行或缺少 runtime 检查只能标为 unverified', () => {
  const fixture = createFixture()
  try {
    const metadata = structuredClone(fixture.definition)
    metadata.hosts[RC3].requiredChecks = ['metadata-only']
    metadata.checks['metadata-only'].hostVersion = RC3
    const metadataResult = ValidateCompatMatrix(metadata, fixture.options(join(fixture.base, 'metadata-evidence')))
    assert.equal(metadataResult.status, 'unverified')
    assert.equal(metadataResult.exitCode, 2)
    assert.match(metadataResult.reasons.join('\n'), /runtime/)

    const skipped = ValidateCompatMatrix(fixture.definition, {
      ...fixture.options(join(fixture.base, 'skipped-evidence')),
      runChecks: false
    })
    assert.equal(skipped.status, 'unverified')
    assert.match(skipped.reasons.join('\n'), /未执行/)

    const missingEnv = structuredClone(fixture.definition)
    missingEnv.checks['host-runtime'].requiredEnv = ['SWARM_MATRIX_MISSING_ENV']
    const metadataEnv = ValidateCompatMatrix(missingEnv, {
      ...fixture.options(join(fixture.base, 'metadata-env-evidence')),
      runChecks: false
    })
    assert.equal(metadataEnv.status, 'unverified')
    assert.match(metadataEnv.reasons.join('\n'), /环境变量/)
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('未知 Host、未知组件版本、缺失入口和未知补丁字节明确拒绝', () => {
  const fixture = createFixture()
  try {
    write(join(fixture.hostRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: '0.2.2-rc.4',
      bin: { dsh: 'lib/bin.js' },
      dependencies: {}
    }))
    const unknownHost = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'host-evidence')))
    assert.equal(unknownHost.status, 'rejected')
    assert.match(unknownHost.reasons.join('\n'), /Host 版本/)

    write(join(fixture.hostRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: RC3,
      bin: { dsh: 'lib/bin.js' },
      dependencies: {}
    }))
    write(join(fixture.sdk, '@deepseek-ai/dsh-agent-loop/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-agent-loop',
      version: RC1
    }))
    const targetPackageMismatch = ValidateCompatMatrix(
      fixture.definition,
      fixture.options(join(fixture.base, 'target-package-evidence'))
    )
    assert.equal(targetPackageMismatch.status, 'rejected')
    assert.match(targetPackageMismatch.reasons.join('\n'), /补丁目标包版本不匹配/)

    write(join(fixture.sdk, '@deepseek-ai/dsh-agent-loop/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-agent-loop',
      version: RC3
    }))
    const packagePath = join(fixture.component, 'package.json')
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
    pkg.version = '3.4.0'
    write(packagePath, JSON.stringify(pkg))
    const unknownComponent = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'component-evidence')))
    assert.equal(unknownComponent.status, 'rejected')
    assert.match(unknownComponent.reasons.join('\n'), /组件版本/)

    pkg.version = '3.4.1'
    write(packagePath, JSON.stringify(pkg))
    rmSync(join(fixture.component, 'lib/dep.js'))
    const missingEntry = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'entry-evidence')))
    assert.equal(missingEntry.status, 'rejected')
    assert.match(missingEntry.reasons.join('\n'), /相对导入/)

    write(join(fixture.component, 'lib/dep.js'), 'export const dependency = true\n')
    write(fixture.patchTarget, 'unknown bytes\n')
    const unknownPatch = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'patch-evidence')))
    assert.equal(unknownPatch.status, 'rejected')
    assert.match(unknownPatch.reasons.join('\n'), /补丁摘要未知/)
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('已知但未应用补丁为 unverified，真实检查失败为 rejected 并保留证据', () => {
  const fixture = createFixture()
  try {
    write(fixture.patchTarget, fixture.native)
    const unapplied = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'unapplied-evidence')))
    assert.equal(unapplied.status, 'unverified')
    assert.match(unapplied.reasons.join('\n'), /未应用/)

    write(fixture.patchTarget, fixture.patched)
    fixture.definition.checks['host-runtime'].command = [process.execPath, '-e', 'process.exit(7)']
    const evidence = join(fixture.base, 'failed-evidence')
    const failed = ValidateCompatMatrix(fixture.definition, fixture.options(evidence))
    assert.equal(failed.status, 'rejected')
    assert.equal(failed.checks[0].exitCode, 7)
    assert.ok(existsSync(failed.checks[0].evidence.stderr))
    assert.ok(existsSync(join(evidence, failed.runId, 'compat-matrix.json')))
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('非法检查 id 只拒绝，不执行命令也不写出 evidence run 目录', () => {
  const fixture = createFixture()
  try {
    fixture.definition.hosts[RC3].requiredChecks = ['../escape']
    fixture.definition.checks['../escape'] = {
      kind: 'host-runtime',
      hostVersion: RC3,
      command: [process.execPath, '-e', 'process.exit(0)']
    }
    const result = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'unsafe-evidence')))
    assert.equal(result.status, 'rejected')
    assert.equal(result.checks.length, 0)
    assert.match(result.reasons.join('\n'), /检查 id 非法/)
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('runtime 检查的 SDK realpath 与矩阵目标不一致时拒绝执行', () => {
  const fixture = createFixture()
  try {
    mkdirSync(join(fixture.repositoryRoot, 'other-sdk'), { recursive: true })
    fixture.definition.checks['host-runtime'].requiredSdkPath = 'other-sdk'
    const result = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'sdk-binding-evidence')))
    assert.equal(result.status, 'rejected')
    assert.equal(result.checks.length, 0)
    assert.match(result.reasons.join('\n'), /SDK 路径与运行夹具不一致/)
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('只在本机目标上要求 rc3；rc1 retained 结果和旧证据不能填 rc3 检查', () => {
  const fixture = createFixture()
  try {
    const oldEvidence = join(fixture.base, 'evidence')
    write(join(oldEvidence, 'old-run/compat-matrix.json'), JSON.stringify({
      releaseVersion: '3.4.1',
      status: 'verified',
      target: { hostVersion: RC1 },
      checks: [{ id: 'old-rc1', exitCode: 0 }]
    }))
    const rc1Host = join(fixture.sdk, '@deepseek-ai/dsh/package.json')
    write(rc1Host, JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: RC1,
      bin: { dsh: 'lib/bin.js' },
      dependencies: {}
    }))
    const rc1 = ValidateCompatMatrix(fixture.definition, {
      ...fixture.options(oldEvidence),
      hostVersion: RC1
    })
    assert.equal(rc1.status, 'unverified')
    assert.equal(rc1.target.claim, 'rc1-retained-only')

    write(rc1Host, JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: RC3,
      bin: { dsh: 'lib/bin.js' },
      dependencies: {}
    }))
    const rc3 = ValidateCompatMatrix(fixture.definition, fixture.options(oldEvidence))
    assert.equal(rc3.status, 'verified')
    assert.notEqual(rc3.runId, 'old-run')
    assert.equal(rc3.target.claim, 'v3.4.1-local')
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('检查期间组件字节变化会使本轮结果失效', () => {
  const fixture = createFixture()
  try {
    const target = join(fixture.component, 'lib/dep.js')
    fixture.definition.checks['host-runtime'].command = [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(target)}, '// changed during check\\n')`
    ]
    const result = ValidateCompatMatrix(fixture.definition, fixture.options(join(fixture.base, 'mutating-evidence')))
    assert.equal(result.status, 'rejected')
    assert.match(result.reasons.join('\n'), /检查期间.*变化/)
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})

test('CLI 输出矩阵摘要，并对 verified/unverified 返回 0/2', () => {
  const fixture = createFixture()
  try {
    const definition = fixture.saveDefinition()
    const evidence = join(fixture.base, 'cli-evidence')
    const run = spawnSync(process.execPath, [
      script,
      '--definition',
      definition,
      '--repository-root',
      fixture.repositoryRoot,
      '--host',
      RC3,
      '--sdk',
      fixture.sdk,
      '--component',
      `swarm=${fixture.component}`,
      '--evidence',
      evidence
    ], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(run.status, 0, `stdout=${run.stdout}\nstderr=${run.stderr}`)
    const result = JSON.parse(run.stdout)
    assert.equal(result.status, 'verified')
    assert.equal(result.target.hostVersion, RC3)
    assert.ok(existsSync(result.evidence.summary))

    const metadataRun = spawnSync(process.execPath, [
      script,
      '--definition',
      definition,
      '--repository-root',
      fixture.repositoryRoot,
      '--host',
      RC3,
      '--sdk',
      fixture.sdk,
      '--component',
      `swarm=${fixture.component}`,
      '--evidence',
      join(fixture.base, 'cli-metadata-evidence'),
      '--metadata-only'
    ], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(metadataRun.status, 2, `stdout=${metadataRun.stdout}\nstderr=${metadataRun.stderr}`)
    assert.equal(JSON.parse(metadataRun.stdout).status, 'unverified')
  } finally {
    rmSync(fixture.base, { recursive: true, force: true })
  }
})
