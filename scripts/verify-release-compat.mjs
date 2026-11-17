#!/usr/bin/env node
/** 校验可公开兼容归档；可选链接仅作用于已解压副本，不修改用户 profile。 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const inside = (root, path) => { const rel = relative(root, path); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const safePath = (root, value) => {
  if (typeof value !== 'string' || isAbsolute(value) || value.includes('\\') || value.split('/').some(part => ['', '.', '..'].includes(part))) throw new Error('兼容清单包含非法路径')
  const path = resolve(root, value)
  if (!inside(root, path)) throw new Error('兼容路径越界')
  return path
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export const ValidateCompatBundle = (rootInput, sdkInput, options = {}) => {
  const root = realpathSync(resolve(rootInput)), sdk = realpathSync(resolve(sdkInput))
  const plan = JSON.parse(readFileSync(join(root, 'compat-manifest.json'), 'utf8'))
  if (plan.schemaVersion !== 1 || plan.hostVersion !== '0.2.2-rc.3' || !Array.isArray(plan.components) || plan.components.length === 0) throw new Error('兼容清单版本无效')
  const host = JSON.parse(readFileSync(join(sdk, '@deepseek-ai/dsh/package.json'), 'utf8'))
  if (host.version !== plan.hostVersion) throw new Error('SDK 不是精确目标 DSH 0.2.2-rc.3')
  const checked = new Set(), componentDirectories = []
  const checkFile = (path, expected) => {
    if (checked.has(path)) throw new Error('兼容清单路径重复')
    checked.add(path)
    const file = safePath(root, path), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, realpathSync(file))) throw new Error(`兼容文件位置不可信: ${path}`)
    if (!/^[0-9a-f]{64}$/.test(expected) || sha(readFileSync(file)) !== expected) throw new Error(`兼容文件摘要不匹配: ${path}`)
  }
  for (const component of plan.components) {
    const directory = safePath(root, component.directory)
    if (!inside(root, realpathSync(directory)) || lstatSync(directory).isSymbolicLink()) throw new Error('组件目录不是归档内物理目录')
    if (!component.files || typeof component.files !== 'object' || Object.keys(component.files).length === 0) throw new Error('组件文件清单为空')
    for (const [path, expected] of Object.entries(component.files)) checkFile(`${component.directory}/${path}`, expected)
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (pkg.name !== component.name || pkg.version !== component.version) throw new Error('组件包名或版本不匹配')
    // 文件清单本身可能就漏打了启动overlay；必须反查包的声明，不能仅验已列文件。
    const declared = []
    const add = (value, allowWildcard = false) => {
      if (typeof value !== 'string') throw new Error('声明入口格式无效')
      if (value.includes('*') && !allowWildcard) throw new Error('声明入口不接受通配符')
      if (!value.includes('*')) declared.push(value.startsWith('./') ? value.slice(2) : value)
    }
    const exportsOf = value => {
      if (typeof value === 'string') add(value, true)
      else if (value && typeof value === 'object') Object.values(value).forEach(exportsOf)
    }
    if (pkg.main) add(pkg.main)
    if (pkg.types) add(pkg.types)
    exportsOf(pkg.exports)
    const patches = pkg.dsh?.bundle?.patch
    if (patches !== undefined) (Array.isArray(patches) ? patches : [patches]).forEach(value => add(value))
    for (const path of new Set(declared)) {
      const target = safePath(directory, path)
      if (!existsSync(target) || !lstatSync(target).isFile() || !inside(directory, realpathSync(target))) throw new Error(`声明入口缺失或越界: ${component.name} -> ${path}`)
      if (!Object.hasOwn(component.files, path)) throw new Error(`声明入口未列入文件清单: ${component.name} -> ${path}`)
    }
    componentDirectories.push(directory)
  }
  for (const [path, expected] of Object.entries(plan.supportFiles ?? {})) checkFile(path, expected)
  const walk = directory => {
    for (const row of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, row.name), rel = relative(root, path).split(sep).join('/')
      if (row.name === 'node_modules') {
        if (!componentDirectories.includes(directory) || !row.isSymbolicLink() || realpathSync(path) !== sdk) throw new Error('发现未授权的 node_modules')
        continue
      }
      if (row.isSymbolicLink()) throw new Error(`兼容归档不接受符号链接: ${rel}`)
      if (row.isDirectory()) walk(path)
      else if (!checked.has(rel) && !['compat-manifest.json', 'SHA256SUMS'].includes(rel)) throw new Error(`发现清单外文件: ${rel}`)
    }
  }
  walk(root)
  // 外部 SDK 由宿主安装提供；相对导入必须在同一归档内闭合，含嵌套设置 wrapper。
  let relativeImports = 0
  for (const path of checked) {
    if (!/\.(?:mjs|js)$/.test(path) || !path.startsWith('components/')) continue
    const file = join(root, path), source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.[^'"\n]+)['"]/g)) {
      const target = resolve(dirname(file), match[1])
      if (!inside(root, target) || !existsSync(target) || !lstatSync(target).isFile()) throw new Error(`相对导入缺失或越界: ${path} -> ${match[1]}`)
      relativeImports++
    }
  }
  if (options.linkSdk === true) {
    // 全部字节和闭包验证后才链接；不覆盖已有目录或其它 SDK 的链接。
    for (const directory of componentDirectories) if (!existsSync(join(directory, 'node_modules'))) symlinkSync(sdk, join(directory, 'node_modules'), 'dir')
  }
  return { verified: true, hostVersion: host.version, components: plan.components.length, files: checked.size, relativeImports, sdkLinked: options.linkSdk === true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const root = option('--root'), sdk = option('--sdk')
  if (!root || !sdk || args.some(arg => arg.startsWith('--') && !['--root', '--sdk', '--link-sdk'].includes(arg))) throw new Error('用法: node verify-compat.mjs --root <解压根目录> --sdk <DSH node_modules> [--link-sdk]')
  console.log(JSON.stringify(ValidateCompatBundle(root, sdk, { linkSdk: args.includes('--link-sdk') })))
}
