import {describe,expect,it} from 'vitest'
import {getRoutesOverlay,runScenario} from './helpers.js'

describe('2.5.0 visible language through real DSH AgentLoop and ToolRuntime',()=>{
 it('excluded provider receives no default language instruction; explicit follow-up language remains effective',async()=>{
  const run=await runScenario('language-flow',{jev:{enabled:false},review:{enabled:false},planningReview:{enabled:false},agents:{language:'ja',languageExclusions:['swarm-mock'],maxRetries:0},routes:getRoutesOverlay()})
  expect(run.status,run.error??run.stderr).toBe('done')
  const policies=(run as unknown as {languagePolicies:Array<{role:string;language:string;hasLanguageRule:boolean}>}).languagePolicies
  expect(policies).toEqual(expect.arrayContaining([expect.objectContaining({role:'tan_wei',model:'role-tan_wei',language:'default',hasLanguageRule:false})]))
  expect(policies.some(row=>row.role==='tan_wei'&&row.language==='en')).toBe(true)
  expect(policies.some(row=>row.role==='yu_shi'&&row.language==='ko')).toBe(true)
  expect(run.ledgerEvents.filter(x=>x.type==='delegation/retry')).toHaveLength(0)
 })
 it.each([['swarm-mock','default','ja'],['swarm-language-alt','ja','default']])('actual host fallback updates language policy with %s excluded',async(excluded,first,second)=>{
  const routes=getRoutesOverlay()
  routes.tan_wei={chain:[{provider:'swarm-mock',model:'role-tan_wei'},{provider:'swarm-language-alt',model:'role-tan_wei'}]}
  const run=await runScenario('language-fallback',{jev:{enabled:false},review:{enabled:false},agents:{language:'ja',languageExclusions:[excluded],maxRetries:0},routes})
  expect(run.status,run.error??run.stderr).toBe('done')
  const policies=(run as unknown as {languagePolicies:Array<{role:string;provider:string;language:string;hasLanguageRule:boolean}>}).languagePolicies
  expect(policies).toEqual(expect.arrayContaining([expect.objectContaining({provider:'swarm-mock',language:first,hasLanguageRule:first!=='default'}),expect.objectContaining({provider:'swarm-language-alt',language:second,hasLanguageRule:second!=='default'})]))
  expect(run.ledgerEvents.filter(x=>x.type==='delegation/completed')).toHaveLength(1)
  expect(run.ledgerEvents.filter(x=>x.type==='delegation/retry')).toHaveLength(0)
 })
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
