import type { AcceptanceRecord, AssessmentInfo } from '../evidence.js'
import { getAcceptanceCheck, type FindingResolution } from '../policy.js'

export interface AcceptInputInfo {
  task_id: string
  decision: 'accept' | 'reject' | 'incomplete'
  summary: string
  unresolved: string[]
  stopReason: string
  findingResolutions: FindingResolution[]
  verification_token?: string
}

export interface AcceptResultInfo {
  task_id: string
  status: AcceptanceRecord['status']
  missing: string[]
  roundsUsed: number
  maxAutoFixRounds: number
  gates: ReturnType<typeof getAcceptanceCheck>['statuses']
  assessment?: AssessmentInfo
  completionScope?: 'phase' | 'request'
  deferred?: string[]
  verification_token?: string
}

const DECISIONS = ['accept', 'reject', 'incomplete'] as const
const isResolution = (value: unknown): value is FindingResolution => {
  const record = value as Record<string, unknown> | null
  return record !== null && typeof record === 'object' && typeof record.delegationId === 'string'
    && typeof record.index === 'number' && typeof record.resolution === 'string'
}

export const ValidateAcceptInput = (raw: unknown): { input?: AcceptInputInfo; errors: string[] } => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['参数必须是对象'] }
  const value = raw as Record<string, unknown>
  const errors: string[] = []
  if (typeof value.task_id !== 'string' || value.task_id === '') errors.push('task_id 必须是非空字符串')
  if (!(DECISIONS as readonly unknown[]).includes(value.decision)) errors.push('decision 必须是 accept / reject / incomplete 之一')
  if (typeof value.summary !== 'string') errors.push('summary 必须是字符串')
  if (typeof value.stopReason !== 'string' || value.stopReason.trim() === '') errors.push('stopReason 必须是非空字符串')
  if (value.verification_token !== undefined && (typeof value.verification_token !== 'string' || !/^vr-[a-f0-9-]{36}$/.test(value.verification_token))) errors.push('verification_token 必须是服务器签发的receipt ID')
  if (value.verification_token !== undefined && value.decision !== 'accept') errors.push('verification_token 只适用于accept')
  const unresolved = value.unresolved ?? []
  if (!Array.isArray(unresolved) || unresolved.some((item) => typeof item !== 'string')) errors.push('unresolved 必须是字符串数组')
  const resolutions = value.findingResolutions ?? []
  if (!Array.isArray(resolutions) || !resolutions.every(isResolution)) errors.push('findingResolutions 每项需要 delegationId、index、resolution')
  if (errors.length > 0) return { errors }
  return {
    input: {
      task_id: value.task_id as string,
      decision: value.decision as AcceptInputInfo['decision'],
      summary: value.summary as string,
      unresolved: unresolved as string[],
      stopReason: value.stopReason as string,
      findingResolutions: resolutions as FindingResolution[],
      ...(value.verification_token === undefined ? {} : { verification_token: value.verification_token as string })
    },
    errors: []
  }
}
