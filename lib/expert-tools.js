import { SWARM_SERVICE } from './host-contract.js';
import { getBoundTaskToolDefinitions } from './task-tools.js';
export const name = 'dsh-agent-swarm-expert-tools';
export const inject = [SWARM_SERVICE, 'tools'];
/** 新宿主的独立专家 composition 不继承天枢工具；只补任务绑定工具，编排与全局 Jev 留在根会话。 */
export const apply = (ctx) => {
    const service = ctx.get(SWARM_SERVICE);
    const tools = ctx.get('tools');
    if (service === undefined || tools === undefined)
        return;
    for (const definition of getBoundTaskToolDefinitions(service))
        ctx.effect(() => tools.register(definition));
};
//# sourceMappingURL=expert-tools.js.map