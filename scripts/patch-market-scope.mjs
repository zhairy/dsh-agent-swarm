import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 修复 dshmarket 1.73.1 把 npm scope 容器误认为残缺包，拒绝套用到未知源码。 */
export const getPatchedMarketCheckSource = (source) => {
  const start = source.indexOf('export function findResidualDirectories(')
  const end = source.indexOf('\nexport ', start + 1)
  if (start < 0) throw new Error('找不到市场残留扫描函数，未修改文件')
  const stop = end < 0 ? source.length : end
  let body = source.slice(start, stop)
  const oldTmpDeclaration = 'declared: declared.has(tmp[1])'
  const scopedTmpDeclaration = "declared: declared.has(scope === '' ? tmp[1] : scope + '/' + tmp[1])"
  if (body.includes('const packageName = scope')) {
    body = body.replace(oldTmpDeclaration, () => scopedTmpDeclaration)
    return source.slice(0, start) + body + source.slice(stop)
  }
  const replace = (before, after) => {
    if (body.split(before).length !== 2) throw new Error('市场扫描源码已变化，未修改文件')
    body = body.replace(before, () => after)
  }
  replace('const consider = (directory, entry, relative) => {', `const consider = (directory, entry, relative, scope = '') => {`)
  replace("if (entry.startsWith('.'))\n            return;", `if (entry.startsWith('.'))
            return;
        // scope 是包容器，检查其子包；绝不能将整个 scope 作为可删除残留。
        if (scope === '' && entry.startsWith('@')) {
            try {
                for (const child of readdirSync(join(directory, entry)))
                    consider(join(directory, entry), child, join(relative, entry), entry);
            } catch (error) {
                if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
                    console.warn('dshmarket: cannot inspect scope', join(relative, entry), error.code);
            }
            return;
        }
        const packageName = scope === '' ? entry : scope + '/' + entry;`)
  replace('name: tmp[1], path:', "name: scope === '' ? tmp[1] : scope + '/' + tmp[1], path:")
  replace(oldTmpDeclaration, scopedTmpDeclaration)
  replace('if (declared.has(entry))', 'if (declared.has(packageName))')
  replace("name: entry, path: join(relative, entry), kind: 'incomplete-package'", "name: packageName, path: join(relative, entry), kind: 'incomplete-package'")
  return source.slice(0, start) + body + source.slice(stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2]
  if (!target) throw new Error('用法：node scripts/patch-market-scope.mjs <dshmarket/lib/check.js>')
  try {
    const path = resolve(target)
    const source = readFileSync(path, 'utf8')
    const patched = getPatchedMarketCheckSource(source)
    if (patched !== source) writeFileSync(path, patched, 'utf8')
    console.log(patched === source ? '市场 scope 修复已存在' : '市场 scope 修复已写入')
  } catch (error) {
    console.error('市场 scope 修复失败：', target, error.message)
    process.exitCode = 1
  }
}
