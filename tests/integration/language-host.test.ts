import {describe,expect,it} from 'vitest'
import {getRoutesOverlay,runScenario} from './helpers.js'

describe('2.5.0 visible language through real DSH AgentLoop and ToolRuntime',()=>{
 it('configured default, explicit continuation and independent review overrides reach actual child messages without language retries',async()=>{
  const run=await runScenario('language-flow',{jev:{enabled:false},review:{enabled:false},planningReview:{enabled:false},agents:{language:'ja',maxRetries:0},routes:getRoutesOverlay({tan_wei:['role-tan_wei'],yu_shi:['role-yu_shi']})})
  expect(run.status,run.error??run.stderr).toBe('done')
  const observed=(run as unknown as {outputLanguages:Array<{role:string;language:string}>}).outputLanguages
  expect(observed).toEqual(expect.arrayContaining([{role:'tan_wei',language:'ja'},{role:'tan_wei',language:'en'},{role:'yu_shi',language:'ko'}]))
  expect(run.results.slice(1,4).every(x=>!x.isError&&x.text.includes('completed'))).toBe(true)
  expect(run.results[4]?.text).toContain('角色能力建议')
  expect(run.results[4]?.text).toContain('suan_heng')
  // The mock provider deliberately submits Chinese fixture summaries. JSON admission remains
  // authoritative: a language mismatch must never replay tools or spend another attempt.
  expect(run.ledgerEvents.filter(x=>x.type==='delegation/completed')).toHaveLength(3)
  expect(run.ledgerEvents.filter(x=>x.type==='delegation/retry')).toHaveLength(0)
 })
})
