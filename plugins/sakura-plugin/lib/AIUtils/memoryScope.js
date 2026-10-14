import { AsyncLocalStorage } from "node:async_hooks";

const memoryScope = new AsyncLocalStorage();
export const MIMIC_MEMORY_SOURCE = "Mimic";

export function normalizeMemorySource(source) {
  if (source === MIMIC_MEMORY_SOURCE) return source;
  if (typeof source === "string" && source.startsWith("chat:") && source.length > 5) return source;
  throw new Error("记忆来源必须是 Mimic 或有效的前缀设定");
}

// 来源只由聊天入口或后台任务指定，不使用模型的工具参数，也不修改共享事件对象。
export function getMemorySource() {
  return memoryScope.getStore() ?? MIMIC_MEMORY_SOURCE;
}

export function withMemoryScope(source, action) {
  return memoryScope.run(normalizeMemorySource(source), action);
}
