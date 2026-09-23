#!/usr/bin/env node
/**
 * 升级适配：在沙箱安装指定 DSH 版本，按新版 standard 预设重新生成预设，运行全部测试；通过后写入 testedVersions
 * 用法：node scripts/sync-dsh.mjs --version 0.1.8-alpha.1
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, ensureDsh, getSandboxDshModules } from './sandbox.mjs'

const argv = process.argv.slice(2)
const version = argv.includes('--version') ? argv[argv.indexOf('--version') + 1] : undefined
if (version === undefined) {
  console.error('用法：node scripts/sync-dsh.mjs --version <DSH 版本>')
  process.exit(2)
}

const step = (title, command, env = {}) => {
  console.log(`\n== ${title}\n$ ${command}`)
  execSync(command, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
}

ensureDsh(version)
step('构建', 'npm run build')
step('按新版 standard 预设重新生成预设与 fixture', `node scripts/gen-presets.mjs --dsh "${getSandboxDshModules(version)}" --write-fixture`)
step('单元测试与覆盖率', 'npx vitest run --coverage')
step('沙箱集成测试', 'npx vitest run --config vitest.integration.config.ts', { SWARM_DSH_VERSION: version })

const pkgFile = join(REPO_ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
const tested = [version, ...(pkg.dsh.testedVersions ?? []).filter((item) => item !== version)]
writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, dsh: { ...pkg.dsh, testedVersions: tested } }, null, 2)}\n`, 'utf8')
step('变更概览', 'git status --short presets tests/fixtures package.json')
console.log(`\nDSH ${version} 适配通过，已写入 testedVersions。请审阅 presets/ 的差异后提交。`)
