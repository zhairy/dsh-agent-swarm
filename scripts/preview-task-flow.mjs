#!/usr/bin/env node
// 可重跑的组件 QA：真实 SwarmService 任务卡 + 宿主 React/MarkdownText + 本地 Mermaid。
// 不加载账户配置、不调用生成模型；生成的任务没有执行或伪造审核通过。
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.env.SWARM_DSH_VERSION ?? '0.2.0-rc.2'
const frontend = join(root, '.sandbox', `dsh-${version}`, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
if (!existsSync(join(frontend, 'index.html'))) throw new Error(`缺少沙箱宿主前端 ${version}；先运行项目已有 sandbox 安装步骤`)
const frontendIndex = readFileSync(join(frontend, 'index.html'), 'utf8')
const appAsset = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(frontendIndex)?.[1]
const styles = [...frontendIndex.matchAll(/href="\.\/(assets\/[^" ]+\.css)"/g)].map((match) => match[1])
if (appAsset === undefined) throw new Error('无法识别当前宿主前端入口，不猜测加载路径')

const { intSwarmService } = await import(pathToFileURL(join(root, 'lib/service.js')).href)
const { getSwarmConfig, getRoleRoute } = await import(pathToFileURL(join(root, 'lib/config.js')).href)
const { getTaskCardText } = await import(pathToFileURL(join(root, 'lib/tools.js')).href)
const { getRpcRoutes } = await import(pathToFileURL(join(root, 'lib/rpc.js')).href)
const { PROVIDER_LABELS } = await import(pathToFileURL(join(root, 'lib/routes.js')).href)
const { getRouteResourcePolicy } = await import(pathToFileURL(join(root, 'lib/provider-policy.js')).href)
const debug = (message) => { if (process.env.SWARM_PREVIEW_DEBUG === '1') console.log(`[preview] ${message}`) }
debug('service modules loaded')
const scratch = await mkdtemp(join(tmpdir(), 'swarm-flow-preview-'))
await mkdir(join(scratch, 'workspace', 'src'), { recursive: true })
await writeFile(join(scratch, 'workspace', 'src/example.ts'), 'export const sum = (a, b) => a + b\n')
const config = getSwarmConfig({ rootFallback: false, jev: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'advisory' }, persistence: { enabled: false }, messageBus: { enabled: false }, experience: { enabled: false } })
const service = intSwarmService({ getConfig: () => config, getLlm: () => undefined, getSubagents: () => undefined, getTools: () => undefined, getAttachments: () => undefined, getCredentials: () => undefined, dshHome: join(scratch, 'home'), fetch: async () => { throw new Error('preview 不访问外部服务') }, probe: async () => ({ ok: false, reason: 'preview-no-model' }) })
const agent = { id: 'task-flow-preview', session: { header: { agentPreset: 'tian-shu', cwd: join(scratch, 'workspace') } } }
const exec = { agent, signal: new AbortController().signal }
debug('creating real task card')
const generated = await service.AddTaskCard({ title: '算法任务流程预览', goal: '规划一个数值算法改动，核对不变量 $a+b=b+a$，再以实际验证与独立验算验收。预览只创建任务卡，不执行实现。', acceptance: ['实现前定义算法不变量与精度', '修改后实际运行测试', '独立审查与验算没有未解决的严重问题'], scope: ['src/example.ts'], perf: { p95Ms: '待测', dataScale: '待测' }, flags: { changesCode: true, changesAlgorithm: true, numericPrecision: true }, intent: { text: '只创建可见的数值算法任务流程，不执行任何业务修改或模型调用。' } }, exec)
debug('task card created')
const taskId = generated.task_id
const generatedText = getTaskCardText(generated)
const generatedMermaid = generated.flow?.mermaid
const rpcRoutes = getRpcRoutes(() => service.jev, { taskView: (sessionId, id) => service.getTaskViewForRpc(sessionId, id) })

const contentTypes = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' }
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>天枢任务流程组件 QA</title>${styles.map((path) => `<link rel="stylesheet" href="/${path}">`).join('')}<style>body{margin:0;padding:20px;color:#182635;background:#f6f8fb;font-family:system-ui,sans-serif}main{max-width:1080px;margin:auto}#root{display:none}.qa-controls{display:flex;gap:10px;flex-wrap:wrap}button{padding:8px 12px;border:1px solid #cdd6e2;border-radius:6px;background:white;color:#243d5e}svg{max-width:100%;height:auto}h1{font-size:23px}.qa-note{color:#52657c;font-size:14px;line-height:1.7}@media(max-width:540px){body{padding:12px}h1{font-size:19px}}</style></head><body><div id="root"></div><main><h1>天枢任务流程组件 QA</h1><p class="qa-note">此页使用真实 SwarmService 生成任务卡与只读 taskView。规划审核在预览中关闭；没有启动专家、执行任务或伪造通过。此页不代替完整 DSH 集成验证。</p><div class="qa-controls"><button id="qa-normal">正常任务视图</button><button id="qa-invalid">注入无效 Mermaid</button><button id="qa-rpc-error">注入 RPC 错误</button></div><div id="qa"></div><section id="settings-qa"></section></main><script>
let fault='none'; let mounted;
window.__ModuleLoader__={create(options){window.__SWARM_QA_MODULES__=options.staticModules;const script=document.createElement('script');script.src='/task-flow-module.js';script.onload=mount;document.head.append(script);return{manifest:{plugins:[{id:'qa-bootstrap-hold',immediately:true}]},prefetch(){return new Promise(()=>{})}}}};
function mount(){const modules=window.__SWARM_QA_MODULES__;const React=modules.react;const root=modules['react-dom/client'].createRoot(document.getElementById('qa'));const component=window.__SWARM_QA_FLOW__.__test__.TaskFlowRow;const taskId=${JSON.stringify(taskId)};
const loadTask=async(sessionId,id)=>{if(fault==='rpc')throw new Error('QA injected RPC failure');const response=await fetch('/api/swarm.taskView',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'swarm.taskView',payload:{sessionId,taskId:id}})});const envelope=await response.json();if(envelope.result?.ok!==true)throw new Error(envelope.result?.error?.message??'RPC failed');const view=envelope.result.value;if(fault==='invalid')view.flow.mermaid='flowchart TD\\n n_invalid["未闭合';return view};
mounted=()=>root.render(React.createElement(component,{node:{data:{taskId,seq:Date.now(),text:${JSON.stringify(generatedText)},mermaid:${JSON.stringify(generatedMermaid) ?? 'undefined'}}},sessionId:${JSON.stringify(agent.id)},loadTask}));mounted();document.getElementById('qa-normal').onclick=()=>{fault='none';mounted()};document.getElementById('qa-invalid').onclick=()=>{fault='invalid';mounted()};document.getElementById('qa-rpc-error').onclick=()=>{fault='rpc';mounted()};
const settingsScript=document.createElement('script');settingsScript.src='/settings-module.js';settingsScript.onload=()=>{const settings=window.__SWARM_QA_SETTINGS__.__test__;const labels={primary:'主模型',backup:'备用',provider:'供应商',model:'模型',effort:'推理',addLayer:'添加一层',resource_subscription:'订阅',resource_metered_api:'按量 API',resource_judgment_api:'判断 API',resource_unknown:'资源类型未声明'};const rows=settings.getSlots(${JSON.stringify(getRoleRoute(config, 'tian_shu').chain)});modules['react-dom/client'].createRoot(document.getElementById('settings-qa')).render(React.createElement('section',{style:{marginTop:20,overflowX:'auto'}},React.createElement('h2',null,'已安装默认路由资源标签（只读）'),React.createElement(settings.LayerGrid,{t:(key)=>labels[key]??key,rowKey:'tian_shu',target:'chain',slots:rows,errors:[],groups:[],editable:false,controller:{}})))};document.head.append(settingsScript);}
</script><script type="module" src="/${appAsset}"></script></body></html>`

const clientSource = readFileSync(join(root, 'client/task-flow.js'), 'utf8')
const clientModule = `;(function(){const module={exports:{}};const exports=module.exports;const require=(id)=>{const value=window.__SWARM_QA_MODULES__[id];if(value===undefined)throw new Error('QA static module missing: '+id);return value};\n${clientSource}\nwindow.__SWARM_QA_FLOW__=module.exports})()`
const settingsData = { namespace: 'swarm-core', agents: [], triggers: [], resourceTypes: Object.fromEntries(Object.keys(PROVIDER_LABELS).map((provider) => [provider, getRouteResourcePolicy({ provider, model: '' }).accessMode ?? 'unknown'])) }
const settingsSource = readFileSync(join(root, 'client/settings-page.js'), 'utf8').replace('const DATA = __SWARM_DATA__', () => `const DATA = ${JSON.stringify(settingsData)}`)
const settingsModule = `;(function(){const module={exports:{}};const exports=module.exports;const require=(id)=>{const value=window.__SWARM_QA_MODULES__[id];if(value===undefined)throw new Error('QA static module missing: '+id);return value};\n${settingsSource}\nwindow.__SWARM_QA_SETTINGS__=module.exports})()`
const respond = (response, code, type, body) => { response.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(body) }
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && pathname === '/') return respond(response, 200, 'text/html; charset=utf-8', html)
    if (request.method === 'GET' && pathname === '/task-flow-module.js') return respond(response, 200, 'text/javascript; charset=utf-8', clientModule)
    if (request.method === 'GET' && pathname === '/settings-module.js') return respond(response, 200, 'text/javascript; charset=utf-8', settingsModule)
    const route = rpcRoutes.find((entry) => entry.path === pathname && entry.methods.includes(request.method))
    if (route !== undefined) {
      const parts = []
      let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 16384) return respond(response, 413, 'text/plain', 'Request too large'); parts.push(chunk) }
      const headers = new Headers(Object.entries(request.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]))
      const webRequest = new Request(`http://127.0.0.1${pathname}`, { method: request.method, headers, ...(request.method === 'GET' ? {} : { body: Buffer.concat(parts) }) })
      const webResponse = await route.fetch(webRequest)
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()))
      return response.end(Buffer.from(await webResponse.arrayBuffer()))
    }
    if (request.method === 'GET' && pathname.startsWith('/assets/')) {
      const path = resolve(frontend, `.${pathname}`)
      const rel = relative(frontend, path)
      if (rel.startsWith('..') || isAbsolute(rel)) return respond(response, 403, 'text/plain', 'Forbidden')
      if (!existsSync(path)) return respond(response, 404, 'text/plain', 'Not found')
      return respond(response, 200, contentTypes[extname(path)] ?? 'application/octet-stream', readFileSync(path))
    }
    return respond(response, 404, 'text/plain', 'Not found')
  } catch (error) { return respond(response, 500, 'application/json', JSON.stringify({ error: String(error.message ?? error) })) }
})

const port = Number(process.env.SWARM_PREVIEW_PORT ?? '4183')
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('SWARM_PREVIEW_PORT 不合法')
server.listen(port, '127.0.0.1', () => { console.log(`Task-flow component preview: http://127.0.0.1:${server.address().port}`) })
server.on('error', (error) => { console.error(`preview listen failed: ${error.message}`); process.exitCode = 1 })
const close = () => server.close(async () => { await rm(scratch, { recursive: true, force: true }); process.exit(0) })
process.on('SIGINT', close)
process.on('SIGTERM', close)
