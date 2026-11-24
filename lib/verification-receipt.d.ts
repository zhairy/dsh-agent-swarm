import type { DelegationRecord, TaskRecord } from './evidence.js';
import type { FindingResolution } from './policy.js';
export declare const RUNTIME_POLICY_VERSION = "swarm-runtime/3.1.3-v1";
export declare const VERIFICATION_QUESTION_VERSION: string;
export interface VerificationBinding {
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision: number;
    questionVersion: string;
    policyVersion: string;
    artifactDigest: string;
    evidenceDigest: string;
    decisionDigest: string;
    goalBinding?: string;
}
export interface VerificationReceipt {
    id: string;
    policyVersion: typeof RUNTIME_POLICY_VERSION;
    status: 'consumed';
    binding: VerificationBinding;
    issuer: 'independent-evidence-verifier';
    producerIds: string[];
    issuedAt: number;
    consumedAt: number;
}
/** 类型不防伪：只由服务的当前证据校验路径签发，调用方JSON不会进入此路径。 */
export declare const IssueVerificationReceipt: (binding: VerificationBinding, producerIds: readonly string[], at: number) => VerificationReceipt;
export declare const ValidateVerificationReceipt: (raw: unknown) => raw is VerificationReceipt;
export declare const IsVerificationReceiptCurrent: (raw: unknown, expected: VerificationBinding) => boolean;
/** 验收与goal完成守卫共用的绑定投影；所有事实须由宿主重取，不能从caller JSON传入。 */
export declare const getTaskVerificationBinding: (input: {
    task: TaskRecord;
    workspaceId: string;
    artifactDigest: string;
    records: readonly DelegationRecord[];
    resolutions: readonly FindingResolution[];
    externalEditAt: number;
    policyDigest: string;
    decisionDigest: string;
    goalBinding?: string;
}) => VerificationBinding;
/** 授权答案是服务器事实；稳定排序使存储顺序不改变当前授权绑定。 */
export declare const getVerificationDecisionDigest: (raw: unknown, taskId: string) => string;
/** 证明来自已登记、已提交的独立子委派；不声称输出里的测试语义一定正确。 */
export declare const getVerificationProducers: (task: TaskRecord, records: readonly DelegationRecord[], saved: readonly DelegationRecord[]) => string[];
