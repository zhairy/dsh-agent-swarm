import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRpcRoutes } from '../../../lib/rpc.js'
import { PROVIDER_LABELS } from '../../../lib/routes.js'
import { CONTROL_MODEL_CATALOG } from './agent-control-scenarios.js'

/** Browser QA bridge uses actual production RPC handlers and actual running Host child. */
export const serveAgentControlPreview = async ({ service, parentSessionId, childId, state }) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const frontend = resolve(root, `.sandbox/dsh-${process.env.SWARM_DSH_VERSION ?? '0.2.0-rc.2'}/node_modules/@deepseek-ai/dsh-web-frontend/dist`)
  const entry = readFileSync(resolve(frontend, 'index.html'), 'utf8')
  const asset = /src="\.\/(assets\/[^" ]+\.js)"/.exec(entry)?.[1]
  if (asset === undefined) throw new Error('Host React bootstrap asset unavailable')
  const styles = [...entry.matchAll(/href="\.\/(assets\/[^" ]+\.css)"/g)].map((match) => match[1])
  const display = { presets: ['tian-shu'], providers: { ...PROVIDER_LABELS, 'swarm-control-mock': '隔离测试供应商' } }
  const source = readFileSync(resolve(root, 'client/model-display.js'), 'utf8').replace('const DISPLAY = __SWARM_DISPLAY__', () => `const DISPLAY = ${JSON.stringify(display)}`)
  const moduleSource = `(function(){const module={exports:{}};const exports=module.exports;const require=(id)=>window.__CONTROL_MODULES__[id];\n${source}\nwindow.__CONTROL_PAGE__=module.exports;window.__CONTROL_LOCALES__={zh,en}})()`
  const address = { parentSessionId, childId }
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>持久子会话模型控制 QA</title>${styles.map((path) => `<link rel="stylesheet" href="/${path}">`).join('')}<style>body{margin:0;padding:20px;background:#f7f9fc;color:#24344a;font:14px system-ui,sans-serif}main{max-width:1040px;margin:auto}#root{display:none}h1{font-size:23px}p{line-height:1.7}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f7;padding:12px;border-radius:8px}.qa-header{display:flex;justify-content:space-between;gap:12px;align-items:center;position:relative;margin:18px 0 20px}@media(max-width:500px){body{padding:12px}h1{font-size:19px}.qa-header{justify-content:flex-end}}</style></head><body><div id="root"></div><main><h1>持久子会话模型控制 QA</h1><p>真实 DSH AgentLoop、continuable 子会话、生产 RPC 与任务管线；模型响应来自明确的隔离测试供应商。首调用 hang 等待取消；选择 recovered 后安全继续。此页不访问真实账户，也不代表真实第三方模型已调用。</p><div id="qa"></div></main><script>
window.__ModuleLoader__={create(options){window.__CONTROL_MODULES__=options.staticModules;const script=document.createElement('script');script.src='/model-display.js';script.onload=mount;document.head.append(script);return{manifest:{plugins:[{id:'qa-bootstrap-hold',immediately:true}]},prefetch(){return new Promise(()=>{})}}}};
function mount(){const React=window.__CONTROL_MODULES__.react;const page=window.__CONTROL_PAGE__.__test__;const t=(key)=>window.__CONTROL_LOCALES__.zh[key]??key;const address=${JSON.stringify(address)};const rpc=async(method,payload)=>{const response=await fetch('/api/swarm.'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'swarm.'+method,payload})});const result=(await response.json()).result;if(result?.ok!==true)throw new Error((result?.error?.code??'')+': '+(result?.error?.message??'RPC failed'));return result.value};const transport={view:(value)=>rpc('agentView',value),command:(value)=>rpc('agentControl',value),catalog:async()=>({ok:true,value:{groups:${JSON.stringify(CONTROL_MODEL_CATALOG)}}})};function App(){const [view,setView]=React.useState();const [evidence,setEvidence]=React.useState();React.useEffect(()=>{let disposed=false;const update=async()=>{try{const result=await transport.view(address);const raw=await(await fetch('/qa/evidence')).json();if(!disposed){setView(result.control??result);setEvidence(raw)}}catch(error){if(!disposed)setEvidence({error:String(error)})}};update();const timer=setInterval(update,1000);return()=>{disposed=true;clearInterval(timer)}},[]);const actual=view?.actual?.route;return React.createElement(React.Fragment,null,actual===undefined?null:React.createElement(page.ModelCallRow,{t,node:{data:{...actual,swarm:true}}}),React.createElement('div',{className:'qa-header'},React.createElement('span',null,'子会话 '+address.childId),React.createElement(page.AgentModelControls,{t,transport,useSession:()=>({address:{...address,childSessionId:address.childId,mode:'continuable'},parentAvailable:true})})),React.createElement('pre',{'aria-label':'真实宿主执行证据'},JSON.stringify({control:view,requests:evidence?.requests,ends:evidence?.ends,error:evidence?.error},null,2)))}window.__CONTROL_MODULES__['react-dom/client'].createRoot(document.getElementById('qa')).render(React.createElement(App))}
</script><script type="module" src="/${asset}"></script></body></html>`
  const routes = getRpcRoutes(() => service.jev, { agentView: (parent, child) => service.getAgentViewForRpc(parent, child), agentControl: (input) => service.ControlAgentForRpc(input) })
  const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' }
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname
      if (request.method === 'GET' && pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return }
      if (request.method === 'GET' && pathname === '/model-display.js') { response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(moduleSource); return }
      if (request.method === 'GET' && pathname === '/qa/evidence') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(state)); return }
      const route = routes.find((item) => item.path === pathname && item.methods.includes(request.method))
      if (route !== undefined) {
        const chunks = []; let size = 0
        for await (const chunk of request) { size += chunk.length; if (size > 16384) { response.writeHead(413); response.end(); return }; chunks.push(chunk) }
        const result = await route.fetch(new Request('http://127.0.0.1'+pathname, { method: request.method, headers: { 'content-type': request.headers['content-type'] ?? '' }, body: Buffer.concat(chunks) }))
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); return
      }
      if (request.method === 'GET' && pathname.startsWith('/assets/')) {
        const path = resolve(frontend, `.${pathname}`)
        if (!path.startsWith(frontend+'/') || !existsSync(path)) { response.writeHead(404); response.end(); return }
        response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }); response.end(readFileSync(path)); return
      }
      response.writeHead(404); response.end()
    } catch (error) { response.writeHead(500); response.end(String(error.message ?? error)) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.SWARM_PREVIEW_PORT ?? '4185'), '127.0.0.1', resolve) })
  console.log(`Agent control browser QA: http://127.0.0.1:${server.address().port}`)
  await new Promise((resolve) => { const close = () => server.close(resolve); process.once('SIGINT', close); process.once('SIGTERM', close) })
}
