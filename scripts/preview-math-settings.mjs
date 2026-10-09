#!/usr/bin/env node
// Controlled UI QA with the installed Host's React modules and a candidate's real SwarmService.
// No DSH process, account settings, production state or external model calls are used.
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = resolve(process.env.SWARM_PLUGIN_ROOT ?? projectRoot)
const version = process.env.SWARM_DSH_VERSION ?? '0.2.0-rc.2'
const frontend = join(projectRoot, '.sandbox', `dsh-${version}`, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
if (!existsSync(join(frontend, 'index.html'))) throw new Error('Missing existing sandbox Host frontend: ' + version)
const index = readFileSync(join(frontend, 'index.html'), 'utf8')
const appAsset = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(index)?.[1]
const css = [...index.matchAll(/href="\.\/(assets\/[^" ]+\.css)"/g)].map((match) => match[1])
if (appAsset === undefined) throw new Error('Unknown Host frontend entry; refusing guessed assets')
const load = (file) => import(pathToFileURL(join(pluginRoot, 'lib', file)).href)
const { Config, getSwarmConfig, DEFAULT_AGENTS_CONFIG } = await load('config.js')
const { DEFAULT_MATH_CONFIG, MATH_GROUP_OPERATORS, MATH_LIMIT_MAXIMA, MAX_MATH_WORK_PER_TASK, MAX_MATH_CALLS_PER_TASK } = await load('math/config.js')
const { intSwarmService } = await load('service.js')
const { ROLE_INFO_LIST } = await load('role-registry.js')
const { DEFAULT_ROUTE_CHAINS, PROVIDER_LABELS } = await load('routes.js')
const { DEFAULT_UPGRADES, UPGRADEABLE_KEYS, UPGRADE_TRIGGERS, UPGRADE_TRIGGER_LABELS } = await load('upgrade.js')
const { getRouteResourcePolicy } = await load('provider-policy.js')
const scratch = await mkdtemp(join(tmpdir(), 'swarm-quota-math-preview-'))
await mkdir(join(scratch, 'workspace', 'src'), { recursive: true })
await writeFile(join(scratch, 'workspace', 'src', 'qa.ts'), 'export const demo = true\n')

let rawConfig = { jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'advisory' }, persistence: { enabled: false }, messageBus: { enabled: false }, experience: { enabled: false }, routes: {}, math: {} }
let revision = 1
let config = getSwarmConfig(Config(structuredClone(rawConfig)))
const service = intSwarmService({
  getConfig: () => config, getLlm: () => undefined, getSubagents: () => undefined, getTools: () => undefined,
  getAttachments: () => undefined, getCredentials: () => undefined, dshHome: join(scratch, 'home'),
  fetch: async () => { throw new Error('Controlled QA never accesses external services') },
  probe: async () => ({ ok: false, reason: 'qa-no-model' }), gitStatus: async () => undefined
})
const agent = { id: 'quota-math-controlled-qa', session: { header: { agentPreset: 'tian-shu', cwd: join(scratch, 'workspace') } } }
const exec = () => ({ agent, signal: new AbortController().signal, callId: `qa-${randomUUID()}` })
let taskId
const newTask = async () => {
  const task = await service.AddTaskCard({ title: '纯函数设置受控 QA', goal: '核对数学设置与真实服务门禁；不调用模型、不修改生产配置。', acceptance: ['算子授权与累计工作量按最新配置执行'], scope: ['src/qa.ts'], flags: {}, intent: { text: '受控 QA：仅进行本地纯函数数学计算。' } }, exec())
  taskId = task.task_id
  return task
}
await newTask()
const formSnapshot = () => ({ status: 'ready', writable: true, revision, value: structuredClone(rawConfig) })
const qaState = () => ({ fixture: 'Controlled math task; real candidate mathematical service', revision, taskId, math: config.math, status: service.getStatus({ task_id: taskId, verbose: true }, exec()) })
const agents = ROLE_INFO_LIST.flatMap(role => (role.id === 'suan_heng' ? ['suan_heng:research', 'suan_heng:verify'] : [role.id]).map(key => ({
  key, name: role.name + (key.endsWith(':verify') ? ' · 验算' : key.endsWith(':research') ? ' · 研算' : ''), title: role.title,
  defaults: DEFAULT_ROUTE_CHAINS[key], upgradeable: UPGRADEABLE_KEYS.includes(key), ...(DEFAULT_UPGRADES[key] ? { upgradeDefault: DEFAULT_UPGRADES[key] } : {})
})))
const data = { namespace: 'swarm-core', agents, triggers: UPGRADE_TRIGGERS.map(id => ({ id, label: UPGRADE_TRIGGER_LABELS[id] })),
  resourceTypes: Object.fromEntries(Object.keys(PROVIDER_LABELS).map(provider => [provider, getRouteResourcePolicy({ provider, model: '' }).accessMode ?? 'unknown'])),
  policy: { defaults: DEFAULT_AGENTS_CONFIG }, math: { defaults: DEFAULT_MATH_CONFIG, groups: MATH_GROUP_OPERATORS, limitMaxima: MATH_LIMIT_MAXIMA, maxWorkPerTask: MAX_MATH_WORK_PER_TASK, maxCallsPerTask: MAX_MATH_CALLS_PER_TASK } }
const modelGroups = Object.entries(PROVIDER_LABELS).map(([id, name]) => ({ id, name, models: [...new Set(Object.values(DEFAULT_ROUTE_CHAINS).flat().filter(route => route.provider === id).map(route => route.model))].map(model => ({ id: model, name: model })) }))
const settingsPath = join(projectRoot, 'client', 'settings-page.js')
const settings = readFileSync(settingsPath, 'utf8').replace('const DATA = __SWARM_DATA__', () => `const DATA = ${JSON.stringify(data)}`)
const wrap = (body) => `(function(){const module={exports:{}};const exports=module.exports;${body}\nreturn module.exports})()`
const browserModule = `(() => {
  const modules=window.__SWARM_QA_MODULES__;
  const require=id=>{if(modules[id]===undefined)throw new Error('QA module missing: '+id);return modules[id]};
  const React=require('react');const h=React.createElement;
  const page=${wrap(settings + '\nexports.__preview__={SwarmAgentsSection,zh,en};')};
  const api=async(path,body)=>{const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error??'QA request failed');return result};
  const listeners=new Set();let snapshot;
  const form={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},mutate:async(ops,expected)=>{const result=await api('/qa/config',{ops,revision:expected});if(!result.accepted)return false;snapshot=result.snapshot;for(const fn of listeners)fn();await showState();return true}};
  const ctx={configForms:{get:()=>form},remote:{session:{modelCatalog:async()=>({ok:true,value:{groups:${JSON.stringify(modelGroups)},failures:[]}})}}};
  const cases={matmul:{op:'matmul',mode:'float64',args:{a:[[1,2],[3,4]],b:[[1,0],[0,1]]}},add:{op:'add',mode:'float64',args:{a:2,b:3}},mean:{op:'mean',mode:'float64',args:{values:[1e308,1e308]}},variance:{op:'variance',mode:'float64',args:{values:[1e154,-1e154],ddof:0}},poly_eval:{op:'poly_eval',mode:'float64',args:{coefficients:[1,2,3],x:2}},residual_norm:{op:'residual_norm',mode:'float64',args:{a:[[2,0],[0,2]],x:[3,4],b:[6,8]}},gcd:{op:'gcd',mode:'bigint',args:{a:'48',b:'18'}}};
  const output=document.getElementById('qa-result');const input=document.getElementById('qa-input');
  const showState=async()=>{const state=await api('/qa/status');document.getElementById('qa-state').textContent=JSON.stringify(state,null,2);document.getElementById('qa-revision').textContent='QA 配置修订 '+state.revision+' / 当前任务 '+state.taskId;return state};
  input.value=JSON.stringify(cases.matmul,null,2);
  document.getElementById('qa-case').onchange=event=>{input.value=JSON.stringify(cases[event.target.value],null,2)};
  document.getElementById('qa-calculate').onclick=async()=>{try{const result=await api('/qa/calculate',JSON.parse(input.value));output.textContent=JSON.stringify(result,null,2);await showState()}catch(error){output.textContent=String(error)}};
  document.getElementById('qa-new-task').onclick=async()=>{await api('/qa/new-task',{});await showState()};
  document.getElementById('qa-reload').onclick=()=>location.reload();
  document.getElementById('qa-refresh-state').onclick=showState;
  document.getElementById('qa-conflict').onclick=async()=>{await api('/qa/bump-revision',{});await showState()};
  (async()=>{snapshot=await api('/qa/config');const controller=new page.__test__.SwarmAgentsController(ctx);controller.t=key=>page.__preview__.zh[key]??key;modules['react-dom/client'].createRoot(document.getElementById('settings-qa')).render(h(page.__preview__.SwarmAgentsSection,{controller}));window.__SWARM_QA__={controller,form,api,cases,showState};await showState()})().catch(error=>{output.textContent=String(error);console.error(error)});
})();`

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>2.4.0 数学设置受控 QA</title>${css.map(path => `<link rel="stylesheet" href="/${path}">`).join('')}<style>body{margin:0;padding:20px;color:#182635;background:#f6f8fb;font-family:system-ui,sans-serif;--dsw-alias-label-primary:#182635;--dsw-alias-label-secondary:#52657c;--dsw-alias-label-tertiary:#69798b;--dsw-alias-border-primary:#cdd6e2;--dsw-alias-bg-layer-2:#fff}main{max-width:1100px;margin:auto;min-width:0}#root{display:none}.qa-panel{border:1px solid #cdd6e2;border-radius:10px;background:white;padding:14px;margin-bottom:18px;min-width:0}.qa-controls{display:flex;gap:8px;flex-wrap:wrap}button,select{font:inherit;padding:6px 10px;border:1px solid #cdd6e2;border-radius:6px;background:white;color:#243d5e}button:disabled{opacity:.5}textarea{display:block;box-sizing:border-box;width:100%;min-height:140px;margin:10px 0;font-family:monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}h1{font-size:23px}.qa-note{font-size:13px;line-height:1.7;color:#52657c}@media(max-width:540px){body{padding:10px}h1{font-size:18px}.qa-panel{padding:10px}}</style></head><body><div id="root"></div><main><h1>2.4.0 数学设置受控 QA</h1><p class="qa-note">设置页仅展示数学算子配置，额度不在设置中可视化。界面使用现有真实宿主 React；数学调用执行私有候选 SwarmService。配置只保存在本预览进程，刷新页面保留；不启动 DSH，不读取生产设置，不调用生成模型。</p><section class="qa-panel"><output id="qa-revision">加载中…</output><div class="qa-controls"><label>数学验算示例 <select id="qa-case" aria-label="数学验算示例"><option value="matmul">matmul 矩阵乘法</option><option value="add">add 加法</option><option value="mean">mean 极值均值</option><option value="variance">variance 极值方差</option><option value="poly_eval">poly_eval 多项式</option><option value="residual_norm">residual_norm 矩阵残差</option><option value="gcd">gcd 精确整数</option></select></label><button id="qa-calculate">调用真实数学服务</button><button id="qa-new-task">新建 QA 任务</button><button id="qa-reload">重载设置页面</button><button id="qa-refresh-state">读取真实服务预算</button><button id="qa-conflict">模拟配置并发修改</button></div><textarea id="qa-input" aria-label="数学请求 JSON" spellcheck="false"></textarea><pre id="qa-result" aria-live="polite">尚未调用。</pre><details><summary>当前真实服务状态与预算</summary><pre id="qa-state"></pre></details></section><div id="settings-qa"></div></main><script>window.__SWARM_QA_ERRORS__=[];window.addEventListener('error',event=>window.__SWARM_QA_ERRORS__.push(event.message));window.addEventListener('unhandledrejection',event=>window.__SWARM_QA_ERRORS__.push(String(event.reason)));window.__ModuleLoader__={create(options){window.__SWARM_QA_MODULES__=options.staticModules;const script=document.createElement('script');script.src='/qa/module.js';document.head.append(script);return{manifest:{plugins:[{id:'qa-bootstrap-hold',immediately:true}]},prefetch(){return new Promise(()=>{})}}}};</script><script type="module" src="/${appAsset}"></script></body></html>`
const contentTypes = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' }
const respond = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body) }
const json = (res, code, value) => respond(res, code, 'application/json; charset=utf-8', JSON.stringify(value))
const readBody = async request => {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('QA POST requires JSON')
  const parts = []; let size = 0
  for await (const chunk of request) { if ((size += chunk.length) > 524288) throw new Error('QA request too large'); parts.push(chunk) }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return json(response, 403, { error: 'QA same-origin only' })
    if (request.method === 'GET' && pathname === '/') return respond(response, 200, 'text/html; charset=utf-8', html)
    if (request.method === 'GET' && pathname === '/qa/module.js') return respond(response, 200, 'text/javascript; charset=utf-8', browserModule)
    if (request.method === 'GET' && pathname === '/qa/config') return json(response, 200, formSnapshot())
    if (request.method === 'GET' && pathname === '/qa/status') return json(response, 200, qaState())
    if (request.method === 'POST' && pathname === '/qa/config') {
      const body = await readBody(request)
      if (body.revision !== revision) return json(response, 200, { accepted: false, reason: 'revision-conflict', snapshot: formSnapshot() })
      if (!Array.isArray(body.ops) || body.ops.length < 1 || body.ops.length > 4 || body.ops.some(op => op?.op !== 'set' || !Array.isArray(op.path) || op.path.length !== 1 || !['routes', 'agents', 'approvals', 'math'].includes(op.path[0]))) return json(response, 400, { error: 'Unsupported QA configuration operation' })
      const next = structuredClone(rawConfig)
      for (const op of body.ops) next[op.path[0]] = op.value
      const normalized = getSwarmConfig(Config(structuredClone(next)))
      if (normalized.math.configurationError !== undefined) return json(response, 400, { error: normalized.math.configurationError })
      rawConfig = next; config = normalized; revision++
      return json(response, 200, { accepted: true, snapshot: formSnapshot() })
    }
    if (request.method === 'POST' && pathname === '/qa/calculate') {
      const body = await readBody(request)
      try { return json(response, 200, { result: await service.Calculate({ ...body, task_id: taskId }, exec()), state: qaState() }) }
      catch (error) { return json(response, 200, { error: { code: error.code ?? 'unknown', message: String(error.message ?? error) }, state: qaState() }) }
    }
    if (request.method === 'POST' && pathname === '/qa/new-task') { await readBody(request); await newTask(); return json(response, 200, qaState()) }
    if (request.method === 'POST' && pathname === '/qa/bump-revision') { await readBody(request); revision++; return json(response, 200, formSnapshot()) }
    if (request.method === 'GET' && pathname.startsWith('/assets/')) {
      const path = resolve(frontend, `.${pathname}`)
      const rel = relative(frontend, path)
      if (rel.startsWith('..') || isAbsolute(rel)) return respond(response, 403, 'text/plain', 'Forbidden')
      if (!existsSync(path)) return respond(response, 404, 'text/plain', 'Not found')
      return respond(response, 200, contentTypes[extname(path)] ?? 'application/octet-stream', readFileSync(path))
    }
    return respond(response, 404, 'text/plain', 'Not found')
  } catch (error) { return json(response, 400, { error: String(error.message ?? error) }) }
})
const port = Number(process.env.SWARM_PREVIEW_PORT ?? 4184)
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid SWARM_PREVIEW_PORT')
server.listen(port, '127.0.0.1', () => console.log(`Math settings controlled QA: http://127.0.0.1:${server.address().port} (candidate ${pluginRoot})`))
server.on('error', error => { console.error('QA listen failed: ' + error.message); process.exitCode = 1 })
const close = () => server.close(async () => { await service.dispose(); await rm(scratch, { recursive: true, force: true }); process.exit(0) })
process.on('SIGINT', close)
process.on('SIGTERM', close)
