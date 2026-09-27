import { createHash } from "node:crypto";

// 配置热更新时按新池重建轮询状态；只保存摘要和计数，不缓存明文 Key。
const pools = new Map();
const MAX_CACHED_POOLS = 128;

export function migrateNaiConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { token, ...config } = value;
    if (config.apis === undefined && typeof token === "string" && token.trim()) {
        config.apis = [{ name: "默认 API", token: token.trim(), weight: 1 }];
    }
    return config;
}

export function getNaiApis(config = {}) {
    const entries = migrateNaiConfig(config)?.apis || [];
    if (!Array.isArray(entries)) throw new Error("NovelAI API 配置必须是列表");
    const unique = new Map();
    for (const [index, entry] of entries.entries()) {
        const token = typeof entry?.token === "string" ? entry.token.trim() : "";
        if (!token) continue;
        const weight = entry.weight ?? 1;
        if (!Number.isInteger(weight) || weight < 0 || weight > 1000) {
            throw new Error(`第 ${index + 1} 个 NovelAI API 的权重必须是 0–1000 的整数`);
        }
        // 重复填写同一个 Key 时合并权重，余额只查询一次，避免重复计入总额。
        if (unique.has(token)) {
            unique.get(token).weight += weight;
        } else {
            unique.set(token, {
                name: String(entry.name || "").trim() || `API ${index + 1}`,
                token,
                weight,
            });
        }
    }
    return [...unique.values()];
}

export function selectNaiApi(config, scope = "default") {
    const apis = getNaiApis(config);
    if (!apis.length) throw new Error("请先在配置中添加 NovelAI API Key");
    const enabled = apis.filter((api) => api.weight > 0);
    if (!enabled.length) throw new Error("所有 NovelAI API 的轮询权重均为 0，请至少启用一个 API");
    const fingerprint = createHash("sha256")
        .update(JSON.stringify([scope, enabled.map(({ token, weight }) => [token, weight])]))
        .digest("hex");
    let current = pools.get(fingerprint);
    if (!current) current = enabled.map(() => 0);
    pools.delete(fingerprint);
    pools.set(fingerprint, current);
    if (pools.size > MAX_CACHED_POOLS) pools.delete(pools.keys().next().value);

    // 平滑加权轮询：每轮加上权重，选出最高者并减去总权重。
    let selected = 0;
    let total = 0;
    enabled.forEach((api, index) => {
        total += api.weight;
        current[index] += api.weight;
        if (current[index] > current[selected]) selected = index;
    });
    current[selected] -= total;
    return enabled[selected];
}
