import Setting from '../lib/setting.js';

export class forwardMessage extends plugin {
  constructor() {
    super({
      name: "转发消息插件",
      event: "message.group",
      priority: 35,
    });
  }

  get appconfig() {
    return Setting.getConfig("forwardMessage");
  }

  handleForwardedMessage = OnEvent("message.group", async (e) => {
    const forwardRules = this.appconfig.forwardRules || [];
    const rules = forwardRules.filter(r =>
      r.sourceGroupIds && r.sourceGroupIds.includes(e.group_id) &&
      r.targetGroupIds && r.targetGroupIds.length > 0
    );
    if (rules.length === 0 || !Array.isArray(e.message)) {
      return false;
    }

    const isRecord = e.message.some(m => m.type === 'forward');
    const isVideo = !isRecord && e.message.some(m => m.type === 'video');
    const isImage = !isRecord && !isVideo &&
      e.message.length > 0 &&
      e.message.every(m => m.type === 'image' && !(m.data?.sub_type === 1));

    // 同一来源群可配置多条规则，每条按自己的开关判断，目标群去重
    const targetIds = new Set();
    for (const rule of rules) {
      const { enableImage = true, enableVideo = true, enableRecord = true } = rule;
      const shouldForward =
        (isRecord && enableRecord) || (isVideo && enableVideo) || (isImage && enableImage);
      if (!shouldForward) continue;
      for (const targetId of rule.targetGroupIds) {
        if (targetId !== e.group_id) targetIds.add(targetId);
      }
    }

    for (const targetId of targetIds) {
      try {
        const targetGroup = e.bot.pickGroup(targetId);
        if (targetGroup) {
          await targetGroup.forwardSingleMsg(e.message_id);
        } else {
          logger.warn(`[转发消息] 目标群聊 ${targetId} 未找到，跳过。`);
        }
      } catch (error) {
        logger.error(
          `[转发消息] 转发到群聊 ${targetId} 时发生错误: ${error}`
        );
      }
    }

    return false;
  });
}
