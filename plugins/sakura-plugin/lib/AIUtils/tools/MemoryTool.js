import { AbstractTool } from "./AbstractTool.js";
import { storeMemories } from "../memoryWriter.js";

function formatStoreResult(scope, result, maintenanceScheduled) {
  const scopeName = scope === "group" ? "群公共记忆" : "用户记忆";
  let message = `已写入${scopeName}：「${result.content}」`;
  if (maintenanceScheduled) message += "；已在后台整理记忆并更新摘要";
  return message;
}

export class MemoryTool extends AbstractTool {
  name = "Memory";
  description = "记录值得跨对话长期记住的信息。只要出现以下情况就应主动调用：用户的自我介绍、称呼、身份、喜好与厌恶、习惯、目标、约定、承诺、重要经历，或本群共同确立的规则、梗、称呼和设定等。宁可多记也不要遗漏，遇到稳定、可复用的信息就随手存下，不必等用户明确要求“记住”。每条只存一件独立、清晰的事实。";
  parameters = {
    properties: {
      scope: {
        type: "string",
        enum: ["user", "group"],
        description: "user=当前用户的长期信息；group=当前群需要共同记住的信息。",
      },
      content: {
        type: "string",
        description: "需要长期记住的一条简洁、明确且可独立理解的事实。提到其他群成员时，若上下文能明确确认其 QQ，必须使用“昵称（QQ：号码）”标明身份；不得猜测或编造 QQ。用户与其他成员的关系、共同约定可记入该用户的个人记忆，但不要写入他人的独立信息。",
      },
    },
    required: ["scope", "content"],
  };

  function(e, context = {}) {
    const definition = super.function();
    if (!Array.isArray(context.memoryTargets)) return definition;
    return {
      ...definition,
      parameters: {
        ...definition.parameters,
        properties: {
          ...definition.parameters.properties,
          userId: {
            type: "string",
            ...(context.memoryTargets.length > 0 ? { enum: context.memoryTargets } : {}),
            description: "写入 user 记忆时必须指定对应消息发送者的 QQ；group 记忆不填写。",
          },
        },
      },
    };
  }

  func = async function (opts, e, context = {}) {
    const { scope, content } = opts || {};
    if (!e?.user_id) return "无法获取用户信息。";
    if (!["user", "group"].includes(scope)) return "不支持的记忆作用域。";
    if (scope === "group" && !e.group_id) return "私聊中不能访问群公共记忆。";
    if (!String(content || "").trim()) {
      return "记忆内容不能为空。";
    }

    try {
      let userId = e.user_id;
      if (scope === "user" && Array.isArray(context.memoryTargets)) {
        userId = String(opts.userId || "").trim();
        if (!context.memoryTargets.includes(userId)) {
          return "个人记忆必须指定本批群消息中的发送者 QQ。";
        }
      }
      const result = await storeMemories({
        e, scope, userId, contents: [String(content).trim()],
      });
      if (result.added.length === 0) return `该记忆已存在，未重复添加：「${String(content).trim()}」`;
      if (Array.isArray(context.addedMemories)) {
        context.addedMemories.push(...result.added.map((memory) => ({
          scope, userId: String(userId), content: memory.content,
        })));
      }
      return formatStoreResult(scope, { content: result.added[0].content }, result.maintenanceScheduled);
    } catch (error) {
      return `记忆操作失败：${error.message}`;
    }
  };
}
