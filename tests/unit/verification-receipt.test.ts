import { describe, expect, it } from 'vitest'
import { IssueVerificationReceipt, IsVerificationReceiptCurrent, RUNTIME_POLICY_VERSION, ValidateVerificationReceipt, getVerificationDecisionDigest, type VerificationBinding } from '../../src/verification-receipt.js'

const binding: VerificationBinding = { rootSessionId: 'root', workspaceId: 'a'.repeat(64), taskId: 'T-1', cardRevision: 1,
  workflowRevision: 2, requestRevision: 3, questionVersion: 'question-v1', policyVersion: RUNTIME_POLICY_VERSION,
  artifactDigest: 'b'.repeat(64), evidenceDigest: 'c'.repeat(64), decisionDigest: 'd'.repeat(64) }

describe('verification receipt binding primitives', () => {
  it('server receipt freezes the binding and uses opaque unique identity', () => {
    const input = structuredClone(binding)
    const receipt = IssueVerificationReceipt(input, ['child', 'child'], 12)
    input.requestRevision += 1
    expect(receipt.producerIds).toEqual(['child'])
    expect(ValidateVerificationReceipt(receipt)).toBe(true)
    expect(IsVerificationReceiptCurrent(receipt, binding)).toBe(true)
    expect(IssueVerificationReceipt(binding, ['child'], 12).id).not.toBe(receipt.id)
  })
  it('rejects empty/root-only provenance, nonfinite time and malformed goal binding', () => {
    for (const producers of [[], ['root']]) expect(() => IssueVerificationReceipt(binding, producers, 12)).toThrow()
    for (const time of [-1, Infinity, NaN]) expect(() => IssueVerificationReceipt(binding, ['child'], time)).toThrow()
    expect(() => IssueVerificationReceipt({ ...binding, goalBinding: 'not-a-digest' }, ['child'], 12)).toThrow()
  })
  it('consumption is bound to every evidence/policy/authorization/goal fact', () => {
    const receipt = IssueVerificationReceipt(binding, ['child'], 12)
    for (const key of ['artifactDigest', 'evidenceDigest', 'decisionDigest', 'workspaceId', 'goalBinding'] as const) {
      expect(IsVerificationReceiptCurrent(receipt, { ...binding, [key]: 'f'.repeat(64) })).toBe(false)
    }
    expect(ValidateVerificationReceipt({ ...receipt, status: 'issued' })).toBe(false)
    expect(ValidateVerificationReceipt({ ...receipt, issuer: 'caller' })).toBe(false)
  })
  it('authorization digest isolates tasks and is stable against storage ordering', () => {
    const a = { id: 'a', questionBinding: { taskId: 'T-1' }, phase: 'waiting' }
    const b = { id: 'b', questionBinding: { taskId: 'T-1' }, phase: 'approved' }
    expect(getVerificationDecisionDigest({ a, b }, 'T-1')).toBe(getVerificationDecisionDigest({ b, a }, 'T-1'))
    expect(getVerificationDecisionDigest({ a, b }, 'T-2')).toBe(getVerificationDecisionDigest({}, 'T-2'))
    expect(getVerificationDecisionDigest({ a, b }, 'T-1')).not.toBe(getVerificationDecisionDigest({ a: { ...a, phase: 'approved' }, b }, 'T-1'))
  })
})
