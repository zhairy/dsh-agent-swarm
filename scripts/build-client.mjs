#!/usr/bin/env node
// 生成浏览器端 bundle lib/client.js，包含两个模块：
// - client/settings-page.js：「设置 → 百工 Agent」页（Jev API key、会话与重试策略、各角色路由链）；
// - client/model-display.js：百工会话聊天窗口里的「调用模型」行与会话头部的当前模型徽标。
// 角色表、默认路由链、容灾升级、会话策略默认值与供应商名称从已编译的 lib/ 读取，保证与宿主侧同源；
// 因此必须在 tsc 之后运行（npm run build 已串好）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const { ROLE_INFO_LIST } = await import(pathToFileURL(join(root, 'lib/role-registry.js')).href)
const { DEFAULT_ROUTE_CHAINS, PROVIDER_LABELS } = await import(pathToFileURL(join(root, 'lib/routes.js')).href)
const { DEFAULT_UPGRADES, UPGRADEABLE_KEYS, UPGRADE_TRIGGERS, UPGRADE_TRIGGER_LABELS } = await import(pathToFileURL(join(root, 'lib/upgrade.js')).href)
const { DEFAULT_AGENTS_CONFIG } = await import(pathToFileURL(join(root, 'lib/config.js')).href)

/** swarm-core 条目 id：设置 namespace 即宿主 cordis 条目 id（见 cordis.patch.yml） */
const NAMESPACE = 'swarm-core'

const MODE_LABEL = { research: '研算', verify: '验算' }
const TIAN_SHU_NOTE = '主会话实际使用对话框模型选择器所选的模型；这里的链在该模型发生致命失败（额度耗尽、模型不可用、认证失败等）时依次接替。'
const TIAN_SHU_UPGRADE_NOTE = '天枢升级后，本任务后续的主会话请求改用升级模型，任务验收或标记未完成后恢复；你在对话框里手动换模型时以你的选择为准。'

const agents = ROLE_INFO_LIST.flatMap((role) => {
  const keys = role.id === 'suan_heng' ? ['suan_heng:research', 'suan_heng:verify'] : [role.id]
  return keys.map((key) => {
    const mode = key.split(':')[1]
    const defaults = DEFAULT_ROUTE_CHAINS[key]
    if (defaults === undefined) throw new Error(`build-client: 路由键 ${key} 没有默认路由链`)
    const upgradeable = UPGRADEABLE_KEYS.includes(key)
    const upgradeDefault = DEFAULT_UPGRADES[key]
    return {
      key,
      name: mode === undefined ? role.name : `${role.name} · ${MODE_LABEL[mode] ?? mode}`,
      title: role.title,
      ...(role.id === 'tian_shu' ? { note: TIAN_SHU_NOTE, upgradeNote: TIAN_SHU_UPGRADE_NOTE } : {}),
      defaults,
      upgradeable,
      ...(upgradeable && upgradeDefault !== undefined ? { upgradeDefault } : {})
    }
  })
})

const triggers = UPGRADE_TRIGGERS.map((id) => ({ id, label: UPGRADE_TRIGGER_LABELS[id] }))
const data = { namespace: NAMESPACE, agents, triggers, policy: { defaults: DEFAULT_AGENTS_CONFIG } }
const display = { presets: ROLE_INFO_LIST.map((role) => role.presetId), providers: PROVIDER_LABELS }

/**
 * 读取一个模块源码并替换其中唯一的数据占位
 * @param {string} file - client/ 下的文件
 * @param {string} placeholder - 占位语句
 * @param {unknown} value - 注入的数据
 * @returns {string} 模块体
 */
const getModuleBody = (file, placeholder, value) => {
  const source = readFileSync(join(root, 'client', file), 'utf8')
  if (source.split(placeholder).length !== 2) throw new Error(`build-client: client/${file} 必须恰好包含一处「${placeholder}」`)
  // 用函数替换：注入的数据里出现 `$&`、`$'` 等时不会被当成替换模式
  return source.replace(placeholder, () => `${placeholder.replace(/__\w+__$/, '')}${JSON.stringify(value, null, 2)}`)
}

const indent = (text, depth) => text.split('\n').map((line) => (line === '' ? '' : `${' '.repeat(depth)}${line}`)).join('\n')

/** 每个模块在自己的函数作用域里求值，避免顶层同名常量互相冲突 */
const wrapModule = (name, body) => `    var ${name} = (function () {
      var module = { exports: {} };
      var exports = module.exports;
${indent(body, 6)}
      return module.exports;
    })();`

const settingsBody = getModuleBody('settings-page.js', 'const DATA = __SWARM_DATA__', data)
const displayBody = getModuleBody('model-display.js', 'const DISPLAY = __SWARM_DISPLAY__', display)

const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
${wrapModule('settingsModule', settingsBody)}
${wrapModule('displayModule', displayBody)}
    var module = { exports: {} };
    var exports = module.exports;
    // 设置页只依赖设置与凭据服务；模型显示依赖会话视图，单独等待 uiConversation，两者互不阻塞
    exports.inject = settingsModule.inject;
    exports.apply = function (ctx) {
      settingsModule.apply(ctx);
      if (typeof ctx.inject === 'function') ctx.inject(displayModule.inject, function (scoped) { displayModule.apply(scoped); });
      else displayModule.apply(ctx);
    };
    exports.NS = settingsModule.NS;
    exports.__test__ = settingsModule.__test__;
    exports.__display__ = displayModule.__test__;
    return module.exports;
  }
});
`
writeFileSync(join(root, 'lib/client.js'), bundle)
console.log(`build-client: lib/client.js（${agents.length} 个 Agent 路由，模型显示覆盖 ${display.presets.length} 个预设）`)
