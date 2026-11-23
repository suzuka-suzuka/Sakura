// 模型与供应商的公共工具：配置里用“模型名（或别名）”引用模型，
// 使用处保存一个有序的模型列表，排在前面的优先，失败时按顺序换下一个。

export const MODEL_TYPES = ["chat", "image", "video"];

export const DEFAULT_MODEL_TIMEOUT_MS = {
  chat: 300000,
  image: 300000,
  video: 900000,
};

/** 模型在配置里的标识：别名优先，留空则用模型名。 */
export function modelKey(entry) {
  if (!entry || typeof entry !== "object") return "";
  const alias = String(entry.name ?? "").trim();
  return alias || String(entry.model ?? "").trim();
}

/** 把使用处的模型引用统一成去重后的字符串数组。兼容旧配置里的单个字符串。 */
export function normalizeModelList(reference) {
  const values = Array.isArray(reference) ? reference : [reference];
  const result = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

export function hasModels(reference) {
  return normalizeModelList(reference).length > 0;
}

/** 日志与报错里展示模型列表。 */
export function formatModelList(reference) {
  const names = normalizeModelList(reference);
  return names.length > 0 ? names.join(" → ") : "（未选择模型）";
}

/** 模型列表的稳定比较键，用于判断缓存的执行计划是否还对应同一组模型。 */
export function modelListKey(reference) {
  return normalizeModelList(reference).join("\u0000");
}

export function providerName(provider) {
  return String(provider?.name ?? "").trim();
}

export function usesVertex(provider) {
  return provider?.protocol === "gemini" && provider?.vertex === true;
}

// 日志里的 Key 标签：序号对应面板里 Key 列表的位置；长 Key 附末 4 位方便和中转站后台对账，
// 8 位以内的短 Key 只给序号，露末 4 位等于把 Key 写进日志。
function credentialLabel(apiKey, index) {
  const text = String(apiKey || "");
  return text.length > 8 ? `Key${index + 1}(…${text.slice(-4)})` : `Key${index + 1}`;
}

/**
 * 把供应商的 Key 列表展开成内部使用的凭据对象。
 * Vertex 供应商使用服务账号引用，其他供应商使用 API Key。
 */
export function providerCredentials(provider) {
  if (!provider) return [];
  if (usesVertex(provider)) {
    return normalizeModelList(provider.serviceAccounts).map((reference, index) => ({
      id: `服务账号${index + 1}`,
      apiKey: "",
      serviceAccountRef: reference,
    }));
  }
  return normalizeModelList(provider.apiKeys).map((apiKey, index) => ({
    id: credentialLabel(apiKey, index),
    apiKey,
    serviceAccountRef: "",
  }));
}

export function modelTimeoutMs(entry) {
  const seconds = Number(entry?.timeoutSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  return DEFAULT_MODEL_TIMEOUT_MS[entry?.type] || DEFAULT_MODEL_TIMEOUT_MS.chat;
}
