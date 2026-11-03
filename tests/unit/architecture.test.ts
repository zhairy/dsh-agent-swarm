import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../..')
const files = (path: string): string[] => readdirSync(path).flatMap((name) => {
  const target = join(path, name)
  return statSync(target).isDirectory() ? files(target) : [target]
})

describe('strangler architecture guards', () => {
  it('keeps the public service module as an application composition facade', () => {
    const source = readFileSync(join(root, 'src/service.ts'), 'utf8')
    expect(source.trim().split('\n').length).toBeLessThanOrEqual(12)
    expect(source).toContain("from './application/swarm-service.js'")
    expect(source).not.toMatch(/createFeatureSession|getTaskOrThrow|intDelegator|createRouteEngine/)
  })

  it('prevents the domain layer from importing application, adapters or host I/O', () => {
    const violations = files(join(root, 'src/domain')).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]!)
        .filter((specifier) => /(?:^|\/)(?:application|adapters|service)(?:\.js|\/)|^node:fs|^react$|host-contract/.test(specifier))
        .map((specifier) => `${file}: ${specifier}`)
    })
    expect(violations).toEqual([])
  })

  it('has removed the route and ticket compatibility shims', () => {
    for (const name of ['route-state.ts', 'route-engine.ts', 'routes.ts', 'route-health.ts', 'provider-policy.ts', 'quota-routing.ts', 'quota.ts', 'quota-routing-source.ts', 'ticket-lifecycle.ts']) {
      expect(() => statSync(join(root, 'src', name))).toThrow()
    }
  })
})
