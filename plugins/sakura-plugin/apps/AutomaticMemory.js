import { getBot, getCurrentBotSelfId } from "../../../src/api/client.js";
import Setting from "../lib/setting.js";
import { getRedis } from "../../../src/utils/redis.js";
import { getActiveRecordedGroups, getGroupMemoryMessages } from "../lib/AIUtils/groupMessageStore.js";
import {
  AUTOMATIC_MEMORY_PREFIX,
  buildGroupMemoryForwardNodes,
  collectGroupMemories,
  GROUP_MEMORY_MESSAGE_COUNT,
  runDuePersonalMemories,
  withAutomaticMemoryLock,
} from "../lib/AIUtils/automaticMemory.js";

export class AutomaticMemory extends plugin {
  constructor() {
    super({ name: "自动记忆", priority: 1135 });
  }

  groupMemoryTask = Cron("0 * * * *", async (fireDate = new Date()) => {
    const selfId = getCurrentBotSelfId();
    const currentBot = getBot(selfId);
    if (selfId == null || !currentBot) return;
    const config = Setting.getConfig("Memory", { selfId });
    if (config.groupEnabled === false) return;
    const endTime = Math.floor(fireDate.getTime() / 1000);
    const startTime = endTime - 60 * 60;
    const configuredGroups = new Set((config.Groups || []).map(String));
    const groups = await getActiveRecordedGroups({ selfId, startTime, endTime });
    const client = getRedis();
    for (const group of groups) {
      if (configuredGroups.size > 0 && !configuredGroups.has(group.groupId)) continue;
      try {
        // 群公共记忆跨账号共享，同一群同一时段只由一个在线账号采集。
        await withAutomaticMemoryLock(client, `${AUTOMATIC_MEMORY_PREFIX}:group-lock:${group.groupId}`, async (hasLease) => {
          const doneKey = `${AUTOMATIC_MEMORY_PREFIX}:group-done:${group.groupId}:${Math.floor(endTime / 3600)}`;
          if (await client.exists(doneKey)) return;
          const messages = await getGroupMemoryMessages({ selfId, groupId: group.groupId, startTime, endTime });
          if (messages.length < GROUP_MEMORY_MESSAGE_COUNT) return;
          const e = { self_id: selfId, group_id: group.groupId, user_id: selfId };
          const addedMemories = [];
          await collectGroupMemories(e, messages, { hasLease, addedMemories });
          if (!await hasLease()) return;
          // 先标记采集完成，转发失败也不重新调用 AI 或重复写入记忆。
          await client.set(doneKey, "1", "EX", 2 * 60 * 60);
          const nodes = buildGroupMemoryForwardNodes(e, messages, addedMemories);
          if (nodes.length > 0) {
            try {
              const sent = await currentBot.sendForwardMsg({
                group_id: Number(group.groupId),
                messages: nodes,
                source: "新增记忆",
                news: [
                  { text: `群记忆${addedMemories.filter((memory) => memory.scope === "group").length}条` },
                  { text: `个人记忆${addedMemories.filter((memory) => memory.scope === "user").length}条` },
                ],
              });
              if (!sent) throw new Error("发送接口未返回成功结果");
            } catch (error) {
              logger.warn(`[Memory] 群 ${group.groupId} 记忆结果转发失败：${error.message}`);
            }
          }
          logger.info(`[Memory] 已检查群 ${group.groupId} 最近一小时的100条消息`);
        });
      } catch (error) {
        logger.warn(`[Memory] 群 ${group.groupId} 自动记忆失败：${error.message}`);
      }
    }
  });

  personalMemoryTask = Cron("* * * * *", async () => {
    const selfId = getCurrentBotSelfId();
    if (selfId == null || !getBot(selfId)) return;
    await runDuePersonalMemories(selfId);
  });
}
