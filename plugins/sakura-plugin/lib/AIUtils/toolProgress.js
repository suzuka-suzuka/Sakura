// 工具调用提示：AI 调用工具时，用一条合并转发告诉用户它在做什么（搜索词、绘画提示词等）。
//
// 模型同一轮并行调用的多个工具合成一条转发，工具开始执行时立刻发出。
// 发送按顺序排队；模型输出中间文字、整次运行结束前会等排队的转发发完，保证转发排在后续文字之前。
//
// 总开关：AI 配置的 toolCallForward。

import Setting from "../setting.js";

const BUSY_NICKNAME = "忙碌中";
const MAX_PREVIEW_LINES = 4;
const PREVIEW_MAX_LENGTH = 80;

export function shortenProgressText(text, maxLength = PREVIEW_MAX_LENGTH) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

/**
 * 一次工具调用要展示的内容。
 * @typedef {object} ToolCallNotice
 * @property {string} action 动作名，如 "搜索"，合并后用作转发来源
 * @property {Array<{ nickname?: string, text: string }>} lines 转发里的节点，nickname 缺省为“忙碌中”
 */

/** 把一批调用拼成一条转发的节点和外显信息 */
export function buildForwardPayload(notices = [], selfId) {
  const lines = notices.flatMap((notice) => notice.lines);
  const actions = [...new Set(notices.map((notice) => notice.action).filter(Boolean))];
  const previews = lines.map((line) => shortenProgressText(line.text)).filter(Boolean);
  return {
    nodes: lines.map((line) => ({
      user_id: selfId,
      nickname: line.nickname || BUSY_NICKNAME,
      content: [{ type: "text", data: { text: line.text } }],
    })),
    info: {
      source: actions.join("|") || BUSY_NICKNAME,
      prompt: previews.join(" | "),
      news: previews.slice(0, MAX_PREVIEW_LINES).map((text) => ({ text })),
    },
  };
}

export class ToolCallForward {
  #send;
  #queue = Promise.resolve();
  disposed = false;

  /**
   * @param {object} e 事件对象，需要 sendForwardMsg
   * @param {object} [options]
   * @param {(notices: ToolCallNotice[]) => Promise<any>} [options.send] 发送一批调用
   */
  constructor(e, { send = null } = {}) {
    const selfId = e?.self_id;
    this.#send = send || ((notices) => {
      const { nodes, info } = buildForwardPayload(notices, selfId);
      return e.sendForwardMsg(nodes, info);
    });
  }

  /** 一批并行调用合成一条转发，排队发出（不等它发完，工具照常执行） */
  add(notices = []) {
    if (this.disposed) return;
    const valid = notices.filter((notice) => notice?.lines?.length);
    if (valid.length === 0) return;
    this.#queue = this.#queue
      .then(() => this.#send(valid))
      .catch((err) => {
        logger.warn(`[ToolCallForward] 发送工具调用转发失败: ${err?.message || err}`);
      });
  }

  /** 等排队中的转发发完 */
  flush() {
    return this.#queue;
  }

  /** 运行结束：等排队的发完，之后的 add 全部忽略 */
  dispose() {
    this.disposed = true;
    return this.#queue;
  }
}

export function isToolCallForwardEnabled(e) {
  try {
    return Setting.getConfig("AI", { selfId: e?.self_id })?.toolCallForward !== false;
  } catch {
    return true;
  }
}

export function createToolProgress(e, options) {
  if (typeof e?.sendForwardMsg !== "function") return null;
  if (!isToolCallForwardEnabled(e)) return null;
  return new ToolCallForward(e, options);
}
