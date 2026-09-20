import { parseReactionCommand } from "../lib/reactionCommand.js";

export class ReactionCommand extends plugin {
  constructor() {
    super({
      name: "贴表情",
      event: "message.group",
      priority: 35,
    });
  }

  reactToCommand = Command(/^#?贴表情/u, async (e) => {
    const reaction = parseReactionCommand(e.message);

    if (reaction.status === "unsupported-composite") {
      await e.reply("此表情不支持贴表情", 10);
      return true;
    }

    if (reaction.status !== "ok") {
      return false;
    }

    try {
      await e.react(reaction.id);
    } catch (error) {
      logger.warn(`[贴表情] 添加回应失败: ${error.message}`);
      await e.reply("贴表情失败，请稍后再试", 10);
    }

    return true;
  });
}
