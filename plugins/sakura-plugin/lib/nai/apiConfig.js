export const DEFAULT_NAI_URL = "https://image.novelai.net";

export function normalizeNaiUrl(value) {
    let url;
    try {
        url = new URL(String(value || "").trim());
    } catch {
        throw new Error("请填写有效的 NovelAI API URL");
    }
    if (!["http:", "https:"].includes(url.protocol) ||
        url.username || url.password || url.search || url.hash) {
        throw new Error("NovelAI API URL 必须是 HTTP 或 HTTPS 基础地址，不能包含账号、查询参数或片段");
    }
    return url.href.replace(/\/+$/, "");
}

export function getNaiApiConfig(config = {}) {
    const key = typeof config.key === "string" ? config.key.trim() : "";
    if (!key) throw new Error("当前绘图配置中未设置 NovelAI API Key");
    return { key, url: normalizeNaiUrl(config.url) };
}
