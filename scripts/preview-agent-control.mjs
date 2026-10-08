#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { ensureDsh, ensureProfile, getHome, PROFILE, SANDBOX_ROOT, DRIVER_DIR } from './sandbox.mjs'

// Isolated test Host; no production DSH profile or real model credentials are read.
const version = process.env.SWARM_DSH_VERSION ?? '0.2.0-rc.2'
ensureProfile(version)
mkdirSync(SANDBOX_ROOT, { recursive: true })
const workspace = mkdtempSync(join(SANDBOX_ROOT, 'agent-control-browser-'))
writeFileSync(join(workspace, 'README.md'), '# Agent control browser fixture\n')
const git = (args) => execFileSync('git', ['-c', 'user.name=control-qa', '-c', 'user.email=control@test.local', ...args], { cwd: workspace, stdio: 'ignore' })
git(['init', '-q']); git(['add', '-A']); git(['commit', '-q', '-m', 'fixture'])
const overlay = `${workspace}.overlay.yml`
writeFileSync(overlay, YAML.stringify([
  { id: 'swarm-core', config: { rootFallback: false, jev: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'advisory' }, persistence: { enabled: false }, agents: { maxRetries: 3, retryBackoffMs: 1, networkWaitMs: 0 }, routes: { tan_wei: { chain: [{ provider: 'swarm-control-mock', model: 'hang' }] } } } },
  { insert: [{ id: 'swarm-agent-control-integration', name: join(DRIVER_DIR, 'agent-control-scenarios.js') }] }
]))
const child = spawn(process.execPath, [ensureDsh(version), '--profile', PROFILE, '--patch', overlay], { cwd: workspace, stdio: 'inherit', env: { ...process.env, DSH_HOME: getHome(version), DSH_TELEMETRY_DISABLED: '1', DSH_SWARM_ROLE_PRESETS: '1', SWARM_DSH_VERSION: version, SWARM_SCENARIO: '', SWARM_AGENT_CONTROL_SCENARIO: 'browser-manual', SWARM_DRIVER_OUT: `${workspace}.out.json` } })
process.once('SIGINT', () => child.kill('SIGINT'))
process.once('SIGTERM', () => child.kill('SIGTERM'))
child.once('exit', (code) => process.exit(code ?? 0))
