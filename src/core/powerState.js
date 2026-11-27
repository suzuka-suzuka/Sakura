import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { DATA_DIR } from "../utils/home.js";

/**
 * 软关机状态，按 Bot 账号记录。
 *
 * 软关机的账号由 loader 拦下全部事件、多步对话和定时任务，只放行标了 whileOff 的处理器：
 * 主人的 #开机，和掉线通知（掉线后收不到 #开机，得让主人知道）。
 * 进程不退出，所以能远程开机；已经在跑的处理和插件自己挂的计时器不会被打断。
 * 状态不会过期，所以不放 Redis，写到 data/ 下的 JSON，重启后照样保持关机。
 */

const STATE_PATH = path.join(DATA_DIR, "power-state.json");

/** selfId(字符串) → 软关机时间戳；首次用到时才从文件读 */
let offAccounts = null;

function normalizeSelfId(selfId) {
  const id = Number(selfId);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

function getState() {
  if (offAccounts) return offAccounts;
  offAccounts = new Map();
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8") || "{}");
      for (const [selfId, since] of Object.entries(raw?.off || {})) {
        const id = normalizeSelfId(selfId);
        if (id) offAccounts.set(id, Number(since) || Date.now());
      }
    }
  } catch (error) {
    logger.error(`[软关机] 读取状态失败，按全部开机处理: ${error.message || error}`);
  }
  if (offAccounts.size > 0) {
    logger.warn(`[软关机] 账号 ${[...offAccounts.keys()].join("、")} 处于软关机状态，主人发送 #开机 恢复`);
  }
  return offAccounts;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tempPath = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ off: Object.fromEntries(getState()) }, null, 2), "utf8");
    fs.renameSync(tempPath, STATE_PATH);
  } catch (error) {
    logger.error(`[软关机] 保存状态失败，重启后会恢复成开机: ${error.message || error}`);
  }
}

export function isPoweredOff(selfId) {
  const id = normalizeSelfId(selfId);
  return id != null && getState().has(id);
}

/**
 * 让账号进入软关机。
 * @returns {boolean} 原本是开机状态、这次关掉了就返回 true
 */
export function powerOff(selfId) {
  const id = normalizeSelfId(selfId);
  const state = getState();
  if (id == null || state.has(id)) return false;
  state.set(id, Date.now());
  save();
  logger.info(`[软关机] 账号 ${id} 已软关机`);
  return true;
}

/**
 * 让软关机的账号恢复。
 * @returns {number|null} 当初软关机的时间戳；本来就开着返回 null
 */
export function powerOn(selfId) {
  const id = normalizeSelfId(selfId);
  const state = getState();
  if (id == null || !state.has(id)) return null;
  const since = state.get(id);
  state.delete(id);
  save();
  logger.info(`[软关机] 账号 ${id} 已开机`);
  return since;
}
