import type { SwarmService, SwarmServiceDepsInfo } from './service-api.js';
export type { LoggerLike, PlanningRunView, RootUpgradeView } from './api.js';
export type { SwarmService, SwarmServiceDepsInfo } from './service-api.js';
export { ValidateAcceptInput } from './validation.js';
export type { AcceptInputInfo, AcceptResultInfo } from './validation.js';
/**
 * 创建 SwarmService
 * @param {SwarmServiceDepsInfo} deps - 依赖
 * @returns {SwarmService} 服务
 */
export declare const intSwarmService: (deps: SwarmServiceDepsInfo) => SwarmService;
