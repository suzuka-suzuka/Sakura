// 工具调用进度：一次 Agent 运行只保留一条“正在 xxx…”状态消息。
// QQ 消息不能编辑，阶段切换时先发新状态再撤回旧状态；运行结束时撤回最后一条。
// 工具执行很快时不发任何消息，只有超过 delayMs 还没跑完才显示。

const DEFAULT_DELAY_MS = 1500;
const MAX_LABELS = 2;

/**
 * 把一批并行工具的阶段名合成一句状态文字。
 * @param {Array<string|null|undefined>} labels 例如 ["搜索", "绘画"]
 * @returns {string} 例如 "正在搜索、绘画…"；没有可显示的阶段时返回空串
 */
export function formatProgressText(labels = []) {
  const unique = [...new Set(labels.map((label) => String(label || "").trim()).filter(Boolean))];
  if (unique.length === 0) return "";
  return `正在${unique.slice(0, MAX_LABELS).join("、")}…`;
}

function defaultSend(e) {
  return async (text) => {
    const res = await e.reply(text);
    return res?.message_id ?? null;
  };
}

function defaultRecall(e) {
  return async (messageId) => {
    await e.recall(messageId);
  };
}

export class ToolProgress {
  #delayMs;
  #send;
  #recall;
  #timer = null;
  #shown = null; // { text, messageId }
  #queue = Promise.resolve();
  #disposed = false;

  /**
   * @param {object} e 事件对象，需要 reply / recall
   * @param {object} [options]
   * @param {number} [options.delayMs] 阶段开始后多久仍未结束才发状态
   * @param {(text: string) => Promise<any>} [options.send] 发送状态消息，返回 message_id
   * @param {(messageId: any) => Promise<void>} [options.recall] 撤回状态消息
   */
  constructor(e, { delayMs = DEFAULT_DELAY_MS, send = null, recall = null } = {}) {
    this.#delayMs = delayMs;
    this.#send = send || defaultSend(e);
    this.#recall = recall || defaultRecall(e);
  }

  /** 进入一个阶段。text 为空表示这批工具不需要显示状态，保持现状。 */
  enter(text) {
    if (this.#disposed) return;
    this.#clearTimer();
    if (!text || this.#shown?.text === text) return;

    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#enqueue(() => this.#show(text));
    }, this.#delayMs);
    this.#timer.unref?.();
  }

  /** 当前阶段结束。还没显示出来的状态不再显示；已显示的留着，等下一阶段替换或运行结束撤回。 */
  leave() {
    this.#clearTimer();
  }

  /** 运行结束：撤回状态，之后的 enter 全部忽略。 */
  dispose() {
    this.#disposed = true;
    this.#clearTimer();
    return this.#enqueue(() => this.#recallShown());
  }

  #clearTimer() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #enqueue(action) {
    this.#queue = this.#queue.then(action).catch((err) => {
      logger.warn(`[ToolProgress] 更新进度消息失败: ${err.message}`);
    });
    return this.#queue;
  }

  async #show(text) {
    if (this.#disposed || this.#shown?.text === text) return;
    const previous = this.#shown;
    this.#shown = null;
    try {
      const messageId = await this.#send(text);
      if (messageId !== null && messageId !== undefined) {
        this.#shown = { text, messageId };
      }
    } finally {
      // 先发新再撤旧，中间不会出现空档。
      if (previous) await this.#recall(previous.messageId);
    }
  }

  async #recallShown() {
    const shown = this.#shown;
    if (!shown) return;
    this.#shown = null;
    await this.#recall(shown.messageId);
  }
}

export function createToolProgress(e, options) {
  if (typeof e?.reply !== "function" || typeof e?.recall !== "function") {
    return null;
  }
  return new ToolProgress(e, options);
}
