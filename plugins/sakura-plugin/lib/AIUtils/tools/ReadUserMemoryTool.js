import { AbstractTool } from "./AbstractTool.js";
import { getMemoryLocation, readMemoryDocument } from "../memoryStore.js";

export class ReadUserMemoryTool extends AbstractTool {
  name = "ReadUserMemory";
  description = "读取指定QQ的全部个人记忆。群聊限当前群，私聊限本人。";
  parameters = {
    properties: {
      qq: {
        type: "string",
        pattern: "^\\d+$",
        description: "要查询的QQ号，仅包含数字。",
      },
    },
    required: ["qq"],
    additionalProperties: false,
  };

  func = async function (opts, e) {
    const qq = opts?.qq;
    if (typeof qq !== "string" || !/^\d+$/.test(qq)) {
      return { error: "QQ号必须是仅包含数字的字符串。" };
    }
    if (!e?.group_id && !e?.user_id) return { error: "无法获取当前对话信息。" };
    if (!e.group_id && qq !== String(e.user_id)) {
      return { error: "私聊中只能查询当前用户自己的个人记忆。" };
    }

    try {
      const location = getMemoryLocation({ groupId: e.group_id, userId: qq, scope: "user" });
      const document = readMemoryDocument(location.memoryFile, { throwOnError: true });
      const totalCount = document.memories.length;
      return {
        qq,
        groupId: e.group_id ? String(e.group_id) : null,
        totalCount,
        memories: document.memories,
        ...(totalCount === 0 ? {
          message: e.group_id ? "该成员在当前群暂无详细记忆记录。" : "当前用户暂无私聊记忆记录。",
        } : {}),
      };
    } catch (error) {
      logger.warn(`[Memory] 查询个人记忆失败：${error.message}`);
      return { error: "记忆查询失败，无法读取已有个人记忆。" };
    }
  };
}
