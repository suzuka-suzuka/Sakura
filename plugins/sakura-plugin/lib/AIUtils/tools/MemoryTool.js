import { AbstractTool } from "./AbstractTool.js";
import { storeMemories } from "../memoryWriter.js";
import { getMemorySource, MIMIC_MEMORY_SOURCE } from "../memoryScope.js";

function formatStoreResult(scope, result, maintenanceScheduled) {
  const scopeName = scope === "group" ? "群公共记忆" : "用户记忆";
  let message = `已写入${scopeName}：「${result.content}」`;
  if (maintenanceScheduled) message += "；已在后台整理记忆并更新摘要";
  return message;
}

export class MemoryTool extends AbstractTool {
  name = "Memory";
  description = "主动保存可长期复用的身份、称呼、喜好、禁忌、习惯、目标、约定、重要经历及群规则、梗、设定。每条一件事，无需用户要求。";
  parameters = {
    properties: {
      scope: {
        type: "string",
        enum: ["user", "group"],
        description: "user=当前用户的长期信息；group=当前群需要共同记住的信息。",
      },
      content: {
        type: "string",
        description: "一条完整事实。涉及你自己时写“我”，不带自身QQ；“我”不指个人记忆所属用户。user：本人以 userId（未指定时为当前用户）为准，省略本人主语和QQ；可记本人关系、约定，不记他人独立信息。涉及其他群友时，已知QQ用“昵称（QQ：号码）”，未知不编造。",
      },
    },
    required: ["scope", "content"],
  };

  function(e, context = {}) {
    const original = super.function();
    const isMimic = getMemorySource() === MIMIC_MEMORY_SOURCE;
    const definition = {
      ...original,
      description: isMimic ? original.description : "主动保存当前设定下可长期复用的个人事实、偏好、关系和约定。每条一件事，无需用户要求。",
      parameters: {
        ...original.parameters,
        additionalProperties: false,
        properties: {
          ...original.parameters.properties,
          scope: {
            ...original.parameters.properties.scope,
            enum: isMimic ? ["user", "group"] : ["user"],
            description: isMimic ? original.parameters.properties.scope.description : "user=当前设定的个人记忆；不能读写群记忆。",
          },
        },
      },
    };
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
    if (scope === "group" && getMemorySource() !== MIMIC_MEMORY_SOURCE) return "前缀角色不能保存群记忆。";
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
