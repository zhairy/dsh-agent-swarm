/** 补阙没有默认收费模型；空配置交人工，用户更改在下一次诊断调用时读取。 */
export const getRepairRoute = (chain) => {
    const route = chain[0];
    if (route === undefined)
        return undefined;
    if (typeof route.provider !== 'string' || route.provider.trim() === '' || typeof route.model !== 'string' || route.model.trim() === '')
        throw new Error('RECOVERY_ROUTE_INVALID');
    return structuredClone(route);
};
//# sourceMappingURL=router.js.map