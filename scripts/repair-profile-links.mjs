#!/usr/bin/env node
/** 绝对 link 声明是来源；暂存目录迁移后必须同时校正 pnpm 锁与软链接。 */
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import YAML from 'yaml'

export const repairProfileLinks = (profile, { write = false } = {}) => {
  profile = resolve(profile)
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  const lockPath = join(profile, 'pnpm-lock.yaml')
  const before = readFileSync(lockPath, 'utf8')
  const lock = YAML.parse(before)
  const replacements = new Map()
  const links = []
  for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
    if (!specifier.startsWith('link:') || !isAbsolute(specifier.slice(5))) continue
    const target = resolve(specifier.slice(5))
    if (!existsSync(join(target, 'package.json'))) throw new Error(`link 目标缺少清单: ${name}: ${target}`)
    const entry = lock.importers?.['.']?.dependencies?.[name]
    if (!entry || entry.specifier !== specifier || !entry.version?.startsWith('link:')) {
      throw new Error(`锁文件与声明不一致，拒绝猜测: ${name}`)
    }
    const next = `link:${relative(profile, target).split('\\').join('/')}`
    if (entry.version !== next) {
      if (replacements.has(entry.version) && replacements.get(entry.version) !== next) throw new Error(`锁链接歧义: ${name}`)
      replacements.set(entry.version, next)
    }
    const path = join(profile, 'node_modules', name)
    let old
    try {
      if (!lstatSync(path).isSymbolicLink()) throw new Error(`非链接依赖不得覆盖: ${name}`)
      old = readlinkSync(path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (old === undefined || resolve(dirname(path), old) !== target) links.push({ name, path, target, previous: old })
  }
  const replace = value => {
    if (typeof value === 'string') return replacements.get(value) ?? value
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]))
    return value
  }
  if (write) {
    if (replacements.size) {
      const temporary = `${lockPath}.repair-${process.pid}`
      writeFileSync(temporary, YAML.stringify(replace(lock)), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, lockPath)
    }
    for (const link of links) {
      const temporary = `${link.path}.repair-${process.pid}`
      symlinkSync(relative(dirname(link.path), link.target), temporary, 'dir')
      renameSync(temporary, link.path)
    }
  }
  return { status: write ? 'REPAIRED' : 'DRY_RUN', profile, lockResolutions: replacements.size, links }
}

export const getBrokenLinks = root => {
  const broken = []
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) { if (!existsSync(child)) broken.push(child) }
      else if (entry.isDirectory()) walk(child)
    }
  }
  walk(root)
  return broken
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const index = args.indexOf('--profile')
  if (index < 0 || !args[index + 1]) throw new Error('需要 --profile；默认 dry-run，--write 才写入')
  console.log(JSON.stringify(repairProfileLinks(args[index + 1], { write: args.includes('--write') }), null, 2))
}
