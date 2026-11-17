import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { getPatchedMarketCheckSource } from '../../scripts/patch-market-scope.mjs'

// 与部署补丁的输入契约相同，不依赖用户主机安装的第三方包。
const source = `export function findResidualDirectories(profileDirectory, declared) {
    const out = [];
    const tmpShape = /^(.+)_tmp_\\d+_\\w+$/;
    const consider = (directory, entry, relative) => {
        if (entry.startsWith('.'))
            return;
        if (!lstatSync(join(directory, entry)).isDirectory()) return;
        const tmp = tmpShape.exec(entry);
        if (tmp) { out.push({ name: tmp[1], path: join(relative, entry), kind: 'tmp-directory', declared: declared.has(tmp[1]) }); return; }
        if (declared.has(entry)) return;
        let readable = false;
        try { JSON.parse(readFileSync(join(directory, entry, 'package.json'), 'utf8')); readable = true; } catch {}
        if (!readable) out.push({ name: entry, path: join(relative, entry), kind: 'incomplete-package' });
    };
    for (const entry of readdirSync(join(profileDirectory, 'node_modules'))) consider(join(profileDirectory, 'node_modules'), entry, 'node_modules');
    return out;
}`
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('npm scope 残留扫描修复', () => {
  it('保留 scope 容器，识别 scoped 包的真正残缺目录与临时目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-market-')); roots.push(root)
    for (const name of ['@types/valid', '@deepseek-ai/declared', '@types/broken', '@types/pkg_tmp_123_abc', 'broken', '.pnpm']) mkdirSync(join(root, 'node_modules', name), { recursive: true })
    writeFileSync(join(root, 'node_modules', '@types/valid/package.json'), '{}')
    const patched = getPatchedMarketCheckSource(source)
    const scan = new Function('readFileSync', 'lstatSync', 'readdirSync', 'join', patched.replace('export ', '') + '\nreturn findResidualDirectories;')(readFileSync, lstatSync, readdirSync, join)
    const findings = scan(root, new Set(['@deepseek-ai/declared', '@types/pkg']))
    expect(findings.map((item: { name: string }) => item.name).sort()).toEqual(['@types/broken', '@types/pkg', 'broken'])
    expect(findings.find((item: { name: string }) => item.name === '@types/pkg')).toMatchObject({ declared: true })
    expect(getPatchedMarketCheckSource(patched)).toBe(patched)
  })

  it('未知上游源码拒绝修改', () => {
    expect(() => getPatchedMarketCheckSource('export const other = 1')).toThrow('找不到')
    expect(() => getPatchedMarketCheckSource(source.replace('declared.has(entry)', 'changed(entry)'))).toThrow('源码已变化')
  })
})
