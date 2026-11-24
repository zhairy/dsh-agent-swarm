import type { RouteInfo } from '../../domain/routing/routes.js';
/** 补阙没有默认收费模型；空配置交人工，用户更改在下一次诊断调用时读取。 */
export declare const getRepairRoute: (chain: readonly RouteInfo[]) => RouteInfo | undefined;
