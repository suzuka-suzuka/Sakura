import { CronExpressionParser } from 'cron-parser';
import Setting from '../setting.js';
import db from '../Database.js';
import { getRedis } from '../../../../src/utils/redis.js';
import { getBot, withBotContext } from '../../../../src/api/client.js';
import { isPoweredOff } from '../../../../src/core/powerState.js';
import { hasModels } from "./aiModels.js";
import { formatBeijingDateTime } from './currentTime.js';
import { getPrimaryPrefix } from './profileTriggers.js';
import { MIMIC_MEMORY_SOURCE } from './memoryScope.js';

// 旧版单次提醒放在 Redis，靠过期通知触发；启动时迁进 SQLite 后删除。
const LEGACY_TRIGGER_PREFIX = 'sakura:reminder:once:trigger:';
const LEGACY_DATA_PREFIX = 'sakura:reminder:once:data:';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const MAX_ONCE_DELAY_MS = 366 * DAY_MS;
export const MAX_PENDING_ONCE_PER_USER = 10;
export const MAX_REPEAT_PER_USER = 5;
export const MIN_REPEAT_INTERVAL_MS = HOUR_MS;
// 错过超过这么久（机器人离线、软关机）就不再补发，只记日志。
const LATE_DROP_MS = 6 * HOUR_MS;
// 晚到超过这么久时，告诉改写模型这条提醒迟到了。
const LATE_NOTICE_MS = 5 * MINUTE_MS;
const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = MINUTE_MS;
// 发送途中进程退出会留下 sending 状态，超过这么久视为卡住，重新待发。
const STALE_CLAIM_MS = 10 * MINUTE_MS;
const FINISHED_RETENTION_MS = 7 * DAY_MS;
// 这个时间窗内到期的提醒额外挂一个进程内定时器，精确到秒；更远的靠每分钟扫描。
const TIMER_WINDOW_MS = DAY_MS;

export const CONTENT_MAX_LENGTH = 500;
export const NOTE_MAX_LENGTH = 300;
const OUTPUT_MAX_LENGTH = 300;

const REMINDER_AI_SYSTEM_PROMPT =
  '你是一个提醒文案助手。根据给出的提醒信息，写一条自然、简短、友好的中文提醒。' +
  '要求：只使用给出的信息，不要编造；不要输出解释，只输出最终可发送文本。';

// ---------- 时间解析（统一按北京时间，与 AI 看到的当前时间一致，不依赖服务器时区） ----------

function beijingParts(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function beijingToEpoch(year, month, day, hour, minute, second) {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) - BEIJING_OFFSET_MS;
  const check = new Date(ms + BEIJING_OFFSET_MS);
  // Date.UTC 会把 2 月 30 日之类顺延成别的日期，这里拒绝。
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return NaN;
  }
  return ms;
}

/** 毫秒时长 → "2小时30分钟"，不足一分钟时按秒 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}秒`;
  const minutes = Math.round(total / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days && `${days}天`, hours && `${hours}小时`, rest && `${rest}分钟`].filter(Boolean).join('') || '0分钟';
}

export function formatReminderTime(ms) {
  return `${formatBeijingDateTime(new Date(ms))}（北京时间）`;
}

/**
 * 解析单次提醒的触发时间。
 * time：'YYYY-MM-DD HH:mm[:ss]'，或只写 'HH:mm[:ss]'（今天，已过则明天）。
 * relativeTime：'1d2h30m15s' 这类组合，单位 d/h/m/s。
 * @returns {{ok: true, dueAt: number} | {ok: false, message: string}}
 */
export function parseReminderTime({ time, relativeTime, now = Date.now() } = {}) {
  const absolute = String(time || '').trim();
  const relative = String(relativeTime || '').trim();
  if ((absolute && relative) || (!absolute && !relative)) {
    return { ok: false, message: "参数错误：'time'（绝对时间）和 'relativeTime'（相对时间）必须提供一个，且只能提供一个。" };
  }

  let dueAt;
  if (absolute) {
    const match = absolute.match(/^(?:(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T])?(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (!match) {
      return { ok: false, message: `参数错误：时间 "${absolute}" 格式不正确，请用 'YYYY-MM-DD HH:mm' 或 'HH:mm'（北京时间）。` };
    }
    const [, y, mo, d, h, mi, s = '0'] = match;
    const [hour, minute, second] = [h, mi, s].map(Number);
    if (hour > 23 || minute > 59 || second > 59) {
      return { ok: false, message: `参数错误：时间 "${absolute}" 包含无效的数值。` };
    }
    if (y) {
      dueAt = beijingToEpoch(Number(y), Number(mo), Number(d), hour, minute, second);
      if (!Number.isFinite(dueAt)) {
        return { ok: false, message: `参数错误：日期 "${absolute}" 不存在。` };
      }
      if (dueAt <= now) {
        return { ok: false, message: `参数错误：${formatReminderTime(dueAt)} 已经过去了，现在是 ${formatReminderTime(now)}。` };
      }
    } else {
      const today = beijingParts(now);
      dueAt = beijingToEpoch(today.year, today.month, today.day, hour, minute, second);
      if (dueAt <= now) dueAt += DAY_MS;
    }
  } else {
    const units = { d: DAY_MS, h: HOUR_MS, m: MINUTE_MS, s: 1000 };
    let delay = 0;
    const rest = relative.replace(/(\d+)\s*([dhms])/gi, (_, amount, unit) => {
      delay += Number(amount) * units[unit.toLowerCase()];
      return '';
    });
    if (rest.trim()) {
      return { ok: false, message: `参数错误：相对时间 "${relative}" 无法解析，请用 d/h/m/s 组合，如 '30m'、'2h30m'、'3d'。` };
    }
    if (delay <= 0) {
      return { ok: false, message: `参数错误：相对时间 "${relative}" 解析后的总时长必须大于 0 秒。` };
    }
    dueAt = now + delay;
  }

  if (dueAt - now > MAX_ONCE_DELAY_MS) {
    return { ok: false, message: '参数错误：单次提醒最多只能设在一年以内。' };
  }
  return { ok: true, dueAt };
}

/**
 * 校验重复提醒的 cron，并算出下次触发时间。
 * 与 isCronDue 一样按服务器本地时区解释 cron。
 */
export function validateRepeatCron(cron, { enforceMinInterval = true, now = new Date() } = {}) {
  const expression = String(cron || '').trim();
  if (!expression) {
    return { ok: false, message: "参数错误：type='repeat' 时必须提供 cron 表达式。" };
  }
  if (expression.split(/\s+/).length !== 5) {
    return { ok: false, message: '参数错误：cron 必须是标准 5 段 cron 表达式。' };
  }

  let times;
  try {
    const interval = CronExpressionParser.parse(expression, { currentDate: now });
    times = Array.from({ length: 25 }, () => interval.next().toDate().getTime());
  } catch {
    return { ok: false, message: `参数错误：cron "${expression}" 无效。` };
  }

  if (enforceMinInterval) {
    const minGap = Math.min(...times.slice(1).map((time, index) => time - times[index]));
    if (minGap < MIN_REPEAT_INTERVAL_MS) {
      return {
        ok: false,
        message: `参数错误：重复提醒两次之间不能短于 ${formatDuration(MIN_REPEAT_INTERVAL_MS)}，这条 cron 最短只隔 ${formatDuration(minGap)}。`,
      };
    }
  }
  return { ok: true, cronExpression: expression, nextAt: times[0] };
}

export function clipText(value, maxLength) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// ---------- 重复提醒（存在 reminderTask 配置里，面板可编辑） ----------

export function getRepeatReminderTasks(selfId = null) {
  const config = Setting.getConfig('reminderTask', { selfId }) || {};
  return Array.isArray(config.tasks) ? config.tasks : [];
}

// AI 只能给用户自己设提醒，所以 qq 既是提醒对象也是设置人；source 标明来自提醒工具。
export function addRepeatReminderTask({ targetQQ, groupId, content, note = '', cronExpression, selfId = null }) {
  const reminderConfig = Setting.getConfig('reminderTask', { selfId }) || {};
  const tasks = Array.isArray(reminderConfig.tasks) ? [...reminderConfig.tasks] : [];

  const taskId = buildNextReminderTaskId(tasks);
  tasks.push({
    id: taskId,
    enable: true,
    cron: cronExpression,
    qq: targetQQ,
    groupId,
    content: String(content).trim(),
    note: String(note || '').trim(),
    createdAt: new Date().toISOString(),
    source: 'ReminderTool',
  });

  const ok = Setting.setConfig('reminderTask', {
    ...reminderConfig,
    tasks,
  }, { selfId });

  return { ok, taskId };
}

export function removeRepeatReminderTask(taskId, selfId = null) {
  const reminderConfig = Setting.getConfig('reminderTask', { selfId }) || {};
  const tasks = Array.isArray(reminderConfig.tasks) ? [...reminderConfig.tasks] : [];
  const index = tasks.findIndex((task) => String(task?.id || '') === String(taskId));
  if (index < 0) return { ok: false, task: null };
  const [task] = tasks.splice(index, 1);
  const ok = Setting.setConfig('reminderTask', { ...reminderConfig, tasks }, { selfId });
  return { ok, task };
}

function buildNextReminderTaskId(tasks) {
  const usedIds = new Set(
    tasks
      .map((task) => String(task?.id || '').trim())
      .filter((id) => /^\d+$/.test(id))
  );

  let next = 1;
  while (usedIds.has(String(next))) {
    next += 1;
  }

  return String(next);
}

// ---------- 单次提醒（SQLite） ----------

export function createOnceReminder({
  selfId, groupId = 0, userId, userName = '',
  content, note = '', sourceMessageId = '', origin = '', dueAt, now = Date.now(),
}) {
  const result = db.prepare(`
    INSERT INTO once_reminders
      (self_id, group_id, user_id, user_name, content, note, source_message_id, origin, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(selfId ?? ''),
    Number(groupId) > 0 ? String(groupId) : '',
    String(userId),
    String(userName || ''),
    String(content).trim(),
    String(note || '').trim(),
    String(sourceMessageId || ''),
    String(origin || ''),
    dueAt,
    now
  );
  const id = Number(result.lastInsertRowid);
  if (selfId != null) armReminderTimer(selfId, dueAt);
  return id;
}

export function getOnceReminder(id) {
  return db.prepare('SELECT * FROM once_reminders WHERE id = ?').get(Number(id)) || null;
}

export function countPendingOnceReminders(selfId, userId) {
  return db.prepare(`
    SELECT COUNT(*) AS count FROM once_reminders
    WHERE self_id = ? AND user_id = ? AND status IN ('pending', 'sending')
  `).get(String(selfId), String(userId)).count;
}

/** 某个会话（群，或私聊里的某个用户）里还没触发的单次提醒 */
export function listPendingOnceReminders(selfId, { groupId = 0, userId = '' } = {}) {
  if (Number(groupId) > 0) {
    return db.prepare(`
      SELECT * FROM once_reminders
      WHERE self_id = ? AND group_id = ? AND status IN ('pending', 'sending')
      ORDER BY due_at
    `).all(String(selfId), String(groupId));
  }
  return db.prepare(`
    SELECT * FROM once_reminders
    WHERE self_id = ? AND group_id = '' AND user_id = ? AND status IN ('pending', 'sending')
    ORDER BY due_at
  `).all(String(selfId), String(userId));
}

export function cancelOnceReminder(id, now = Date.now()) {
  return db.prepare(`
    UPDATE once_reminders SET status = 'cancelled', finished_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, Number(id)).changes > 0;
}

function finishOnceReminder(id, status, now = Date.now()) {
  db.prepare('UPDATE once_reminders SET status = ?, finished_at = ? WHERE id = ?').run(status, now, id);
}

function armReminderTimer(selfId, dueAt) {
  const delay = dueAt - Date.now();
  if (delay > TIMER_WINDOW_MS) return;
  const timer = setTimeout(() => {
    dispatchFromTimer(selfId).catch((error) => {
      logger.warn(`[Reminder] 定时器触发单次提醒失败: ${error.message}`);
    });
  }, Math.max(0, delay) + 200);
  timer.unref?.();
}

async function dispatchFromTimer(selfId) {
  // 账号离线或软关机时不发，等每分钟扫描（loader 会跳过这些账号）恢复后再补。
  if (!getBot(selfId) || isPoweredOff(selfId)) return;
  await withBotContext(selfId, () => runDueOnceReminders(selfId));
}

/**
 * 发送当前账号已到期的单次提醒。由 reminderTask 的每分钟定时任务和进程内定时器调用。
 * 认领用条件更新保证同一条只会被一个调用方发送。
 */
export async function runDueOnceReminders(selfId, { now = Date.now() } = {}) {
  const sid = String(selfId);
  db.prepare(`
    UPDATE once_reminders SET status = 'pending'
    WHERE status = 'sending' AND claimed_at < ? AND self_id IN (?, '')
  `).run(now - STALE_CLAIM_MS, sid);
  db.prepare(`
    DELETE FROM once_reminders
    WHERE status IN ('sent', 'cancelled', 'failed', 'missed') AND finished_at < ?
  `).run(now - FINISHED_RETENTION_MS);

  const rows = db.prepare(`
    SELECT * FROM once_reminders
    WHERE status = 'pending' AND due_at <= ? AND self_id IN (?, '')
      AND (claimed_at IS NULL OR claimed_at <= ?)
    ORDER BY due_at
    LIMIT 20
  `).all(now, sid, now - RETRY_DELAY_MS);

  for (const row of rows) {
    const claimed = db.prepare(`
      UPDATE once_reminders SET status = 'sending', claimed_at = ?, attempts = attempts + 1, self_id = ?
      WHERE id = ? AND status = 'pending'
    `).run(Date.now(), sid, row.id);
    if (claimed.changes === 0) continue;

    const lateMs = Date.now() - row.due_at;
    if (lateMs > LATE_DROP_MS) {
      finishOnceReminder(row.id, 'missed');
      logger.warn(`[Reminder] 单次提醒 #${row.id} 已错过 ${formatDuration(lateMs)}，不再补发：${row.content}`);
      continue;
    }

    try {
      await deliverOnceReminder(row, sid, lateMs);
      finishOnceReminder(row.id, 'sent');
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      if (attempts >= MAX_SEND_ATTEMPTS) {
        finishOnceReminder(row.id, 'failed');
        logger.error(`[Reminder] 单次提醒 #${row.id} 发送 ${attempts} 次仍失败，放弃: ${error.message}`);
      } else {
        // 回到待发，claimed_at 记着这次时间，一分钟后再试。
        db.prepare(`UPDATE once_reminders SET status = 'pending', claimed_at = ? WHERE id = ?`).run(Date.now(), row.id);
        logger.warn(`[Reminder] 单次提醒 #${row.id} 发送失败，稍后重试: ${error.message}`);
      }
    }
  }
}

async function deliverOnceReminder(row, selfId, lateMs) {
  const currentBot = getBot(selfId);
  if (!currentBot) throw new Error('账号不在线');

  const groupId = Number(row.group_id || 0);
  const text = await composeReminderText({
    selfId,
    groupId,
    origin: row.origin,
    targetId: row.user_id,
    targetName: row.user_name,
    // 旧版从 Redis 迁来的提醒没有来源，可能是替别人设的，不说“对方自己让你提醒”。
    selfSet: Boolean(row.origin),
    content: row.content,
    note: row.note,
    createdAt: row.created_at,
    lateMs,
  }, currentBot);

  // 原话已经在便条里，这里只管引用；原消息撤回或太旧导致引用失败时，sendReminderMessage 会改为不引用。
  await sendReminderMessage(currentBot, {
    groupId,
    targetId: row.user_id,
    text,
    quoteId: row.source_message_id,
  });
}

/** 发重复提醒：只带便条，不引用原消息，也不提“当时”。面板配置的任务可能不 @ 任何人。 */
export async function deliverRepeatReminder(task, selfId) {
  const currentBot = getBot(selfId);
  if (!currentBot) throw new Error('账号不在线');

  const groupId = Number(task.groupId || 0);
  const targetId = String(task.qq || '').trim();
  const text = await composeReminderText({
    selfId,
    groupId,
    origin: '',
    targetId,
    content: String(task.content || '').trim(),
    note: String(task.note || '').trim(),
    repeat: true,
  }, currentBot);

  await sendReminderMessage(currentBot, { groupId, targetId, text, quoteId: '' });
}

// 框架的发送接口失败时记日志并返回 null，不抛错；成功时返回含 message_id 的对象。
async function trySend(send) {
  try {
    return (await send()) != null;
  } catch (error) {
    logger.warn(`[Reminder] 发送异常: ${error.message}`);
    return false;
  }
}

async function sendReminderMessage(currentBot, { groupId, targetId, text, quoteId }) {
  let target;
  let body;
  if (groupId > 0) {
    target = currentBot.pickGroup(groupId);
    body = targetId ? [segment.at(String(targetId)), segment.text(` ${text}`)] : [segment.text(text)];
  } else {
    if (!/^\d{5,11}$/.test(String(targetId))) throw new Error(`提醒对象无效: ${targetId}`);
    target = currentBot.pickFriend(Number(targetId));
    body = [segment.text(text)];
  }

  if (quoteId) {
    if (await trySend(() => target.sendMsg([segment.reply(quoteId), ...body]))) return;
    logger.warn('[Reminder] 引用原消息发送失败，改为不引用');
  }
  if (!await trySend(() => target.sendMsg(body))) {
    throw new Error('协议端发送失败');
  }
}

// ---------- 到点文案 ----------

function findRolePrompt(name, fallback = '') {
  if (!name) return fallback;
  const roles = Setting.getConfig('roles')?.roles || [];
  return roles.find((role) => role.name === name)?.prompt || fallback;
}

function resolveMimicConfig(groupId, selfId) {
  const config = Setting.getConfig('mimic', { selfId }) || {};
  const override = (config.GroupConfigs || []).find((item) => item.group &&
    (Array.isArray(item.group) ? item.group : [item.group]).map(String).includes(String(groupId)));
  if (!override) return config;
  const merged = { ...config, ...override };
  if (!hasModels(override.models)) merged.models = config.models;
  return merged;
}

/**
 * 按设置提醒时的聊天入口找人设：伪人用该群的伪人主人设（反差人设的回复会撤回，不用），
 * 前缀对话用对应触发设定的人设。找不到返回 null，改用后台辅助模型。
 */
function resolveReminderPersona(origin, groupId, selfId) {
  if (origin === MIMIC_MEMORY_SOURCE && groupId > 0) {
    const config = resolveMimicConfig(groupId, selfId);
    const prompt = findRolePrompt(config.name, config.Prompt || '');
    return prompt ? { route: config.models, prompt, groupContext: true } : null;
  }
  if (typeof origin === 'string' && origin.startsWith('chat:')) {
    const profiles = Setting.getConfig('AI', { selfId })?.profiles || [];
    const profile = profiles.find((item) => `chat:${getPrimaryPrefix(item)}` === origin);
    if (!profile) return null;
    const prompt = findRolePrompt(profile.name, profile.Prompt || '');
    return prompt ? { route: profile.models, prompt, groupContext: Boolean(profile.groupContext) } : null;
  }
  return null;
}

async function lookupMemberName(currentBot, groupId, userId) {
  if (!(groupId > 0) || !userId) return '';
  try {
    const info = await currentBot.pickGroup(groupId).getMemberInfo(Number(userId), false);
    return String(info?.card || info?.nickname || '');
  } catch {
    return '';
  }
}

function describePerson(name, qq) {
  return name ? `${name}(QQ:${qq})` : `QQ:${qq}`;
}

export function buildReminderQuery(info, now = Date.now()) {
  const lines = ['现在到了约定的提醒时间，请写一条提醒消息。'];

  if (!info.targetId) {
    lines.push('提醒对象：群里的大家（不针对具体的人）');
  } else {
    const target = describePerson(info.targetName, info.targetId);
    lines.push(info.selfSet ? `提醒对象：${target}（是对方自己让你提醒的）` : `提醒对象：${target}`);
  }
  if (info.repeat) {
    lines.push('这是一条定期重复的提醒。');
  } else if (info.createdAt) {
    lines.push(`设置时间：${formatReminderTime(info.createdAt)}，约 ${formatDuration(now - info.createdAt)}前`);
  }
  lines.push(`提醒内容：${info.content}`);
  if (info.note) lines.push(`你当时留的便条：${info.note}`);
  if (info.lateMs > LATE_NOTICE_MS) {
    lines.push(`注意：这条提醒比约定时间晚了约 ${formatDuration(info.lateMs)}（这段时间你不在线），可以顺带说一声。`);
  }
  const autoParts = [info.targetId && '@提醒对象', !info.repeat && '引用原消息'].filter(Boolean);
  lines.push(
    '要求：用你平时的口吻，一两句话把提醒送到；只使用上面给出的信息，不要编造新的事实；不要 @ 任何人' +
    (autoParts.length ? `，系统会自动${autoParts.join('并')}` : '') + '；只输出要发送的话。'
  );
  return lines.join('\n');
}

function cleanupGeneratedText(text) {
  return clipText(String(text || '').replace(/^\s*@\d{5,11}\s*/, ''), OUTPUT_MAX_LENGTH);
}

/**
 * 生成到点发送的文案：优先用设置时那个聊天入口的人设和模型，失败再用后台辅助模型，都不行就发原始内容。
 */
export async function composeReminderText(info, currentBot) {
  const groupId = Number(info.groupId || 0);
  const targetName = info.targetName || await lookupMemberName(currentBot, groupId, info.targetId);
  const query = buildReminderQuery({ ...info, targetName });

  const attempts = [];
  const persona = resolveReminderPersona(info.origin, groupId, info.selfId);
  if (persona && hasModels(persona.route)) {
    attempts.push({ label: '人设', ...persona });
  }
  const utilityRoute = Setting.getConfig('AI', { selfId: info.selfId })?.utilityModels;
  if (hasModels(utilityRoute)) {
    attempts.push({ label: '辅助模型', route: utilityRoute, prompt: REMINDER_AI_SYSTEM_PROMPT, groupContext: false });
  }

  const mockE = {
    self_id: Number(info.selfId),
    group_id: groupId > 0 ? groupId : undefined,
    user_id: info.targetId ? Number(info.targetId) : undefined,
  };
  // getAI → tools.js → ReminderTool → 本文件，静态导入会形成循环，ReminderTool 构造时读到未初始化的常量。
  const { getAI } = attempts.length > 0 ? await import('./getAI.js') : {};
  for (const attempt of attempts) {
    try {
      const result = await getAI(
        attempt.route,
        mockE,
        [{ text: query }],
        attempt.prompt,
        attempt.groupContext && groupId > 0 ? { noHeader: true } : false,
        false,
        [],
        { includeCurrentTime: true, disableNativeWebSearch: true }
      );
      if (typeof result === 'string') {
        logger.warn(`[Reminder] ${attempt.label}生成提醒文案返回错误: ${result}`);
        continue;
      }
      const text = cleanupGeneratedText(result?.text);
      if (text) return text;
    } catch (error) {
      logger.warn(`[Reminder] ${attempt.label}生成提醒文案失败: ${error.message}`);
    }
  }
  return String(info.content || '').trim();
}

// ---------- 旧数据迁移 ----------

/** 把旧版存在 Redis 里的单次提醒搬进 SQLite：先写库，再删键。 */
export async function migrateLegacyOnceReminders({ now = Date.now() } = {}) {
  const redis = getRedis();
  let cursor = '0';
  let migrated = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${LEGACY_DATA_PREFIX}*`, 'COUNT', 100);
    cursor = next;
    for (const dataKey of keys) {
      const taskId = dataKey.slice(LEGACY_DATA_PREFIX.length);
      const triggerKey = `${LEGACY_TRIGGER_PREFIX}${taskId}`;
      const raw = await redis.get(dataKey);
      let task = null;
      try {
        task = raw ? JSON.parse(raw) : null;
      } catch {}

      if (task?.qq && String(task.content || '').trim()) {
        const ttl = await redis.pttl(triggerKey);
        createOnceReminder({
          selfId: task.selfId ?? null,
          groupId: Number(task.groupId || 0),
          userId: String(task.qq),
          content: String(task.content),
          dueAt: ttl > 0 ? now + ttl : now,
          now,
        });
        migrated += 1;
      }
      await redis.del(dataKey, triggerKey);
    }
  } while (cursor !== '0');

  if (migrated > 0) logger.info(`[Reminder] 已把 ${migrated} 条旧版单次提醒从 Redis 迁到 SQLite`);
  return migrated;
}
