import { AbstractTool } from "./AbstractTool.js";
import {
    CONTENT_MAX_LENGTH,
    MAX_PENDING_ONCE_PER_USER,
    MAX_REPEAT_PER_USER,
    NOTE_MAX_LENGTH,
    addRepeatReminderTask,
    cancelOnceReminder,
    clipText,
    countPendingOnceReminders,
    createOnceReminder,
    formatDuration,
    formatReminderTime,
    getOnceReminder,
    getRepeatReminderTasks,
    listPendingOnceReminders,
    parseReminderTime,
    removeRepeatReminderTask,
    validateRepeatCron,
} from '../reminder.js';
import { getMessageIdentifier } from '../messageIdentifiers.js';
import { getMemorySource } from '../memoryScope.js';

const TOOL_SOURCE = 'ReminderTool';

// 主人和本群管理员可以查看、取消本群所有人的提醒（管理用途），但也只能给自己设提醒。
function isPrivileged(e) {
    return Boolean(e?.isMaster || (Number(e?.group_id || 0) > 0 && e?.isAdmin));
}

function isToolTask(task) {
    return String(task?.source || '') === TOOL_SOURCE;
}

// 重复提醒在当前会话里：群里看本群的；私聊只看发给自己私聊的。
function repeatTaskInScope(task, groupId, userId) {
    const taskGroup = Number(task?.groupId || 0);
    return groupId > 0 ? taskGroup === groupId : taskGroup === 0 && String(task?.qq || '') === userId;
}

function describeOnce(row) {
    return [
        `单次 #${row.id}`,
        formatReminderTime(row.due_at),
        `QQ:${row.user_id}`,
        `内容：${clipText(row.content, 80)}`,
    ].join('｜');
}

function describeRepeat(task) {
    return [
        `重复 #${task.id}`,
        `cron ${task.cron}`,
        task.enable ? '启用' : '已停用',
        task.qq ? `QQ:${task.qq}` : '不 @ 人',
        isToolTask(task) ? '' : '管理员配置',
        `内容：${clipText(task.content, 80)}`,
    ].filter(Boolean).join('｜');
}

export class ReminderTool extends AbstractTool {
    name = 'Reminder';
    parameters = {
        properties: {
            action: {
                type: 'string',
                enum: ['create', 'list', 'cancel'],
                description: "操作：create 新建提醒（默认）；list 查看当前会话里还没触发的提醒；cancel 取消一条提醒（先 list 拿到编号）",
            },
            time: {
                type: 'string',
                description: "绝对时间（北京时间）：'YYYY-MM-DD HH:mm'，或只写 'HH:mm' 表示今天（已过则明天）。与 relativeTime 二选一",
            },
            relativeTime: {
                type: 'string',
                description: "相对时长，用 d(天) h(小时) m(分钟) s(秒) 组合，如 '30m'、'2h30m'、'3d'。与 time 二选一",
            },
            content: {
                type: 'string',
                description: '提醒内容：到点要提醒对方做什么。create 时必填。',
            },
            note: {
                type: 'string',
                description: "写给到点时的自己的便条（第一人称，" + NOTE_MAX_LENGTH + " 字以内）：对方的原话（直接引用最能说明情况的那句）、" +
                    "为什么要提醒、当时在聊什么、对方是什么状态。到点时聊天记录多半已经清掉，只有便条能带过去，请务必填写。" +
                    "例：'他说“我去洗澡了，半小时后叫我回来打本”，洗完要接着打副本'",
            },
            type: {
                type: 'string',
                enum: ['once', 'repeat'],
                description: "提醒类型：'once' 单次（默认）或 'repeat' 重复。cancel 时用它指明要取消的是哪一类",
            },
            cron: {
                type: 'string',
                description: "重复提醒的 5 段 cron 表达式，如 '0 8 * * *'（每天 8 点）。两次提醒之间不能短于 1 小时",
            },
            id: {
                type: 'string',
                description: 'cancel 时要取消的提醒编号（list 结果里 # 后面的数字）',
            },
        },
    };
    description = '给当前和你说话的用户自己设置、查看或取消提醒。只能提醒用户本人，不能替别人设提醒、也不能去提醒别人；' +
        '用户想提醒别人时，告诉他可以让对方自己来设，或者直接 @ 对方。设置成功后把返回的具体时间复述给用户核对；' +
        '用户问有哪些提醒、或要取消提醒时，先 list 再 cancel。';

    func = async function (opts, e) {
        const action = String(opts?.action || 'create').trim().toLowerCase();
        try {
            if (action === 'list') return listReminders(e);
            if (action === 'cancel') return cancelReminder(opts, e);
            if (action === 'create') return createReminder(opts, e);
            return "参数错误：action 仅支持 'create'、'list'、'cancel'。";
        } catch (error) {
            logger.error(`[ReminderTool] ${action} 提醒时发生错误: ${error.message}`);
            return `提醒操作失败，内部错误：${error.message}`;
        }
    };
}

function createReminder(opts, e) {
    const mode = String(opts.type || 'once').trim().toLowerCase();
    if (mode !== 'once' && mode !== 'repeat') {
        return "参数错误：'type' 仅支持 'once' 或 'repeat'。";
    }

    const userId = String(e?.user_id || '').trim();
    if (!/^\d{5,11}$/.test(userId)) {
        return '设置失败：无法确定当前用户。';
    }
    // 参数里已经没有 qq，模型硬塞别人的号时明确拒绝，而不是悄悄改成提醒自己。
    if (opts.qq && String(opts.qq).trim() !== userId) {
        return '设置失败：只能给自己设提醒，不能提醒别人。请告诉用户可以让对方自己来设，或者直接 @ 对方。';
    }

    const content = clipText(opts.content, CONTENT_MAX_LENGTH);
    if (!content) {
        return '参数错误：提醒内容 content 不能为空。';
    }
    // 模型没写便条时，至少把触发这次设置的那条消息原话存下来。
    const triggerText = clipText(e?.msg, NOTE_MAX_LENGTH - 10);
    const note = clipText(opts.note, NOTE_MAX_LENGTH) || (triggerText ? `对方当时说：“${triggerText}”` : '');
    const selfId = e?.self_id;
    const groupId = Number(e?.group_id || 0);
    const exempt = Boolean(e?.isMaster);

    if (mode === 'repeat') {
        const cronResult = validateRepeatCron(opts.cron, { enforceMinInterval: !exempt });
        if (!cronResult.ok) return cronResult.message;

        if (!exempt) {
            const owned = getRepeatReminderTasks(selfId).filter((task) => isToolTask(task) && String(task?.qq || '') === userId);
            if (owned.length >= MAX_REPEAT_PER_USER) {
                return `创建失败：每人最多 ${MAX_REPEAT_PER_USER} 条重复提醒，请先取消不需要的（action='list' 查看）。`;
            }
        }

        const saved = addRepeatReminderTask({
            targetQQ: userId,
            groupId,
            content,
            note,
            cronExpression: cronResult.cronExpression,
            selfId,
        });
        if (!saved.ok) {
            return '重复提醒创建失败：写入配置文件失败。';
        }
        return `重复提醒已创建（重复 #${saved.taskId}），cron：${cronResult.cronExpression}，下次提醒：${formatReminderTime(cronResult.nextAt)}。请把下次提醒时间告诉用户核对。`;
    }

    const now = Date.now();
    const parsed = parseReminderTime({ time: opts.time, relativeTime: opts.relativeTime, now });
    if (!parsed.ok) return parsed.message;

    if (!exempt && countPendingOnceReminders(selfId, userId) >= MAX_PENDING_ONCE_PER_USER) {
        return `设置失败：每人最多同时挂 ${MAX_PENDING_ONCE_PER_USER} 条待触发的单次提醒，请先取消不需要的（action='list' 查看）。`;
    }

    const id = createOnceReminder({
        selfId,
        groupId,
        userId,
        userName: e?.sender?.card || e?.sender?.nickname || '',
        content,
        note,
        sourceMessageId: getMessageIdentifier(e?.message_id, e?.message_seq, e?.seq),
        origin: getMemorySource(),
        dueAt: parsed.dueAt,
        now,
    });

    return `提醒已设置（单次 #${id}）：${formatReminderTime(parsed.dueAt)}，约 ${formatDuration(parsed.dueAt - now)}后提醒对方。` +
        '请把这个时间复述给用户，方便对方核对。';
}

function listReminders(e) {
    const selfId = e?.self_id;
    const groupId = Number(e?.group_id || 0);
    const userId = String(e?.user_id || '');
    const privileged = isPrivileged(e);

    const onceRows = listPendingOnceReminders(selfId, { groupId, userId })
        .filter((row) => privileged || String(row.user_id) === userId);
    const repeatTasks = getRepeatReminderTasks(selfId)
        .filter((task) => repeatTaskInScope(task, groupId, userId) && (privileged || String(task?.qq || '') === userId));

    if (onceRows.length === 0 && repeatTasks.length === 0) {
        return privileged ? '当前会话里没有待触发的提醒。' : '当前会话里没有你的待触发提醒。';
    }
    return [
        ...onceRows.map(describeOnce),
        ...repeatTasks.map(describeRepeat),
    ].join('\n');
}

function cancelReminder(opts, e) {
    const id = String(opts?.id || '').replace(/^#/, '').trim();
    if (!/^\d+$/.test(id)) {
        return "参数错误：cancel 需要提供提醒编号 id（先用 action='list' 查看）。";
    }
    const mode = String(opts?.type || 'once').trim().toLowerCase();
    const selfId = e?.self_id;
    const groupId = Number(e?.group_id || 0);
    const userId = String(e?.user_id || '');
    const privileged = isPrivileged(e);

    if (mode === 'repeat') {
        const task = getRepeatReminderTasks(selfId).find((item) => String(item?.id || '') === id);
        if (!task || !repeatTaskInScope(task, groupId, userId)) return `当前会话里没有重复提醒 #${id}。`;
        // 管理员在面板或命令里配的提醒，普通成员不能自己取消。
        if (!privileged && !(isToolTask(task) && String(task.qq || '') === userId)) {
            return `没有权限：重复提醒 #${id} 不是你自己设的。`;
        }
        const removed = removeRepeatReminderTask(id, selfId);
        if (!removed.ok) return '取消失败：写入配置文件失败。';
        return `已取消重复提醒 #${id}（内容：${clipText(task.content, 80)}）。`;
    }
    if (mode !== 'once') {
        return "参数错误：'type' 仅支持 'once' 或 'repeat'。";
    }

    const row = getOnceReminder(id);
    const inScope = row && String(row.self_id) === String(selfId) && (groupId > 0
        ? row.group_id === String(groupId)
        : row.group_id === '' && String(row.user_id) === userId);
    if (!inScope || !['pending', 'sending'].includes(row.status)) {
        return `当前会话里没有待触发的单次提醒 #${id}。`;
    }
    if (!privileged && String(row.user_id) !== userId) {
        return `没有权限：单次提醒 #${id} 不是你的。`;
    }
    if (!cancelOnceReminder(id)) {
        return `单次提醒 #${id} 正在发送，来不及取消了。`;
    }
    return `已取消单次提醒 #${id}（原定 ${formatReminderTime(row.due_at)}，内容：${clipText(row.content, 80)}）。`;
}
