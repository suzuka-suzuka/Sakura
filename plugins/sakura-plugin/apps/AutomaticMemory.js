import { getBot } from "../../../src/api/client.js";
import { runDuePersonalMemories } from "../lib/AIUtils/automaticMemory.js";

export class AutomaticMemory extends plugin {
  constructor() {
    super({ name: "自动记忆", priority: 1135 });
  }

  personalMemoryTask = Cron("* * * * *", async () => {
    const selfId = getBot()?.self_id;
    if (selfId == null) return;
    await runDuePersonalMemories(selfId);
  });
}
