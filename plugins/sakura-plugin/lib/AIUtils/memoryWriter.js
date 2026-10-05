import {
  appendMemory,
  getMemoryLocation,
  readMemoryDocument,
  withMemoryDocumentLock,
  writeMemoryDocument,
} from "./memoryStore.js";
import { scheduleMemoryMaintenance } from "./memoryMaintenance.js";

// 工具写入和后台 JSON 写入共用计数、去重与整理入口。
export async function storeMemories({ e, scope, userId = e?.user_id, contents, location = null }, options = {}) {
  if (!Array.isArray(contents) || contents.some((content) => typeof content !== "string" || !content.trim())) {
    throw new Error("记忆必须是非空文字列表");
  }
  const target = location || getMemoryLocation({ groupId: e?.group_id, userId, scope });
  const result = await withMemoryDocumentLock(target.memoryFile, async () => {
    if (options.shouldWrite && !await options.shouldWrite()) return { added: [], duplicates: [], skipped: true };
    let document = readMemoryDocument(target.memoryFile, { throwOnError: true });
    const added = [];
    const duplicates = [];
    for (const content of contents) {
      const appended = appendMemory(document, { content });
      if (appended.error) {
        duplicates.push(content.trim());
        continue;
      }
      document = appended.document;
      added.push(appended.memory);
    }
    if (added.length > 0) writeMemoryDocument(target.memoryFile, document);
    return { added, duplicates };
  });
  const schedule = options.scheduleMaintenance || scheduleMemoryMaintenance;
  const maintenanceScheduled = result.added.length > 0
    ? schedule({ location: target, e })
    : false;
  return { ...result, location: target, maintenanceScheduled };
}
