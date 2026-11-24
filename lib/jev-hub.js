import { getJevCredentialError, intJevClient } from './jev.js';
import { getThirdPartyJevSelection, intThirdPartyJevClient } from './jev-third-party.js';
import { intJevTools } from './jev-tools.js';
/** 凭据引用名必须像环境变量名；不合法时（例如误把密钥本身填进 apiKeyEnv）既不读取也不回显 */
export const isCredentialRefName = (ref) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) && ref.length <= 128;
const INVALID_REF = '（引用名不合法）';
/**
 * 创建 Jev 接入点
 * @param {JevHubDepsInfo} deps - 依赖
 * @returns 共享客户端、密钥读取、工具实现与健康检查
 */
export const intJevHub = (deps) => {
    let memo;
    /** 读取密钥：宿主没有值时兼容进程环境变量；宿主读取失败或拒绝时保持失败，不改走另一来源。 */
    const getKey = async (ref) => {
        if (!isCredentialRefName(ref))
            return undefined;
        try {
            const hit = await deps.getCredentials()?.resolve(ref);
            if (hit?.value)
                return hit.value;
        }
        catch (error) {
            const failure = getJevCredentialError(error);
            deps.logger?.warn(`读取 Jev 凭据引用 ${ref} 失败：${failure.reason}`);
            throw failure;
        }
        const value = process.env[ref];
        return value === undefined || value === '' ? undefined : value;
    };
    const getClient = () => {
        const config = deps.getConfig();
        const fingerprint = JSON.stringify(config);
        if (memo?.fingerprint === fingerprint)
            return memo.client;
        const client = config.source === 'third-party'
            ? intThirdPartyJevClient(config, { getLlm: () => deps.getLlm?.(), ...(deps.now === undefined ? {} : { now: deps.now }) })
            : intJevClient(config, {
                fetch: deps.fetch,
                getApiKey: () => getKey(config.apiKeyEnv),
                ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
                ...(deps.now === undefined ? {} : { now: deps.now })
            });
        memo = { fingerprint, client };
        return client;
    };
    const tools = intJevTools({ getClient, ...(deps.now === undefined ? {} : { now: deps.now }) });
    const describeKey = async () => {
        const config = deps.getConfig();
        if (config.source === 'third-party') {
            const selected = getThirdPartyJevSelection(config);
            return { ref: selected === undefined ? 'dsh-model:missing' : `dsh-model:${selected.provider}/${selected.model}`, configured: selected !== undefined, source: 'dsh-model-catalog', writable: false };
        }
        const ref = config.apiKeyEnv;
        if (!isCredentialRefName(ref))
            return { ref: INVALID_REF, configured: false };
        const credentials = deps.getCredentials();
        const inEnv = process.env[ref] !== undefined && process.env[ref] !== '';
        try {
            const info = await credentials?.describe?.(ref);
            if (info !== undefined && (info.configured || !inEnv)) {
                return { ref, configured: info.configured, writable: info.writable, ...(info.source === undefined ? {} : { source: info.source }) };
            }
            // 宿主没有 describe（较旧版本）：能解析出值即视为已配置
            if (info === undefined) {
                const hit = await credentials?.resolve(ref);
                if (hit?.value)
                    return { ref, configured: true, ...(hit.source === undefined ? {} : { source: hit.source }) };
            }
        }
        catch (error) {
            const failure = getJevCredentialError(error);
            deps.logger?.warn(`查询 Jev 凭据引用 ${ref} 失败：${failure.reason}`);
            throw failure;
        }
        if (inEnv)
            return { ref, configured: true, source: 'process-env', writable: false };
        return { ref, configured: false };
    };
    const getHealth = async (signal) => {
        const config = deps.getConfig();
        // 凭据元数据被宿主拒绝时，不应已经在并行分支启动 HTTP 检查。
        const key = await describeKey();
        const result = await tools.health(signal);
        const selected = getThirdPartyJevSelection(config);
        return { key, enabled: config.enabled, model: config.source === 'third-party' ? selected?.model ?? '' : config.model,
            baseUrl: config.source === 'third-party' ? `dsh-model://${selected?.provider ?? ''}` : config.baseUrl, result };
    };
    return { getClient, describeKey, getHealth, tools };
};
//# sourceMappingURL=jev-hub.js.map