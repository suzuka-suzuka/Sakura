import Config from "../../src/core/config.js";
import { Friend, Segment } from "../../src/api/client.js";
import { Command, OnEvent, plugin } from "../../src/core/plugin.js";
import { normalizeMasters } from "../../src/utils/common.js";
import { logger } from "../../src/utils/logger.js";
import { getRedis } from "../../src/utils/redis.js";

// 通知消息 message_id → 申请内容。主人引用通知回复时靠它找回 flag
const noticeKey = (selfId, messageId) => `sakura:requestNotify:${selfId}:${messageId}`;
const NOTICE_TTL = 7 * 24 * 60 * 60;
const HINT = "引用本条回复「同意」或「拒绝」";

/**
 * 直接走 ws 调接口：bot 代理上的 sendRequest 失败时只记日志返回 null，
 * 而 set_*_request 成功时 data 本来就是 null，分不出成败。这里要把失败原因告诉主人。
 */
function callStrict(e, action, params) {
  return e.bot.ws.send(action, params, { selfId: e.self_id });
}

/**
 * 是不是「有人邀请 bot 进群」。
 * SnowLuma：invited_id 就是 bot 自己（群成员邀请别人入群也是 invite，invited_id 是被邀请人）。
 * NapCat 邀请 bot 时不带 invited_id；SnowLuma 解析不到被邀请人时也不带，这时看 bot 在不在群里。
 */
async function isBotInvite(e) {
  if (e.sub_type !== "invite") return false;
  const invitedId = Number(e.invited_id);
  if (Number.isSafeInteger(invitedId) && invitedId > 0) {
    return invitedId === Number(e.self_id);
  }
  const selfMember = await e.getGroupMemberInfo(e.group_id, e.self_id).catch(() => null);
  return !selfMember;
}

/** bot 不在群里，get_group_info 查不到；群名从群系统消息里找，查不到就只显示群号 */
async function findInviteGroupName(e) {
  try {
    const data = await callStrict(e, "get_group_system_msg", { group_id: e.group_id, count: 20 });
    // SnowLuma 返回数组，NapCat 返回 { invited_requests, join_requests }
    const list = Array.isArray(data)
      ? data
      : [...(data?.invited_requests || []), ...(data?.join_requests || [])];
    const sameGroup = list.filter((item) => Number(item?.group_id) === Number(e.group_id));
    const hit = sameGroup.find((item) => item?.flag === e.flag) || sameGroup[0];
    return hit?.group_name || "";
  } catch {
    return "";
  }
}

async function describeUser(e, userId) {
  const info = await e.getStrangerInfo(userId).catch(() => null);
  return info?.nickname ? `${info.nickname} (${userId})` : String(userId);
}

export class RequestNotify extends plugin {
  constructor() {
    super({
      name: "好友/邀群申请通知",
      dsc: "有人加 bot 好友或拉 bot 进群时私聊通知主人，主人引用通知回复同意/拒绝",
    });
  }

  // 不能给整个插件挂 master 权限：loader 用 e.user_id 判权限，申请事件里那是申请人
  notify = OnEvent("request", async (e) => {
    let kind;
    if (e.request_type === "friend") {
      kind = "friend";
    } else if (e.request_type === "group" && (await isBotInvite(e))) {
      kind = "group";
    } else {
      return false;
    }

    if (!e.flag) {
      logger.warn(`[申请通知] ${kind === "friend" ? "好友申请" : "邀群"}事件没有 flag，无法处理: ${e.user_id}`);
      return false;
    }

    // 多个主人只通知第一个
    const master = normalizeMasters(Config.getForSelf(e.self_id, "master"))[0];
    if (!master) return false;

    const requester = await describeUser(e, e.user_id);
    const comment = String(e.comment || "").trim();
    let text;
    let target;
    if (kind === "friend") {
      text = `收到好友申请\n申请人: ${requester}\n验证消息: ${comment || "无"}\n${HINT}`;
      target = `${requester} 的好友申请`;
    } else {
      const groupName = await findInviteGroupName(e);
      const group = groupName ? `${groupName} (${e.group_id})` : String(e.group_id);
      text = `有人邀请我进群\n群: ${group}\n邀请人: ${requester}${comment ? `\n附言: ${comment}` : ""}\n${HINT}`;
      target = `${requester} 拉我进 ${group} 的邀请`;
    }

    const friend = new Friend(e.bot, Number(master));
    // 文字合成一个 text 段再接图片（连续文本段 + 图片偶发乱码，见 GroupAddRequest）
    let res = await friend
      .sendMsg([text, Segment.image(`https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=100`)])
      .catch(() => null);
    if (!res?.message_id) {
      // 头像拉不下来时整条会发失败，退回纯文字
      res = await friend.sendMsg(text).catch(() => null);
    }
    if (!res?.message_id) {
      logger.warn(`[申请通知] 通知主人 ${master} 失败（主人需要是 bot 好友）: ${text.split("\n")[0]} ${e.user_id}`);
      return false;
    }

    await getRedis().set(
      noticeKey(e.self_id, res.message_id),
      JSON.stringify({
        kind,
        flag: e.flag,
        sub_type: e.sub_type || "",
        target,
      }),
      "EX",
      NOTICE_TTL
    );
    return false;
  });

  decide = Command(
    /^#?(同意|拒绝)$/,
    { event: "message.private", permission: "master" },
    async (e) => {
      const replyId = e.reply_id;
      if (!replyId) return false;

      const redis = getRedis();
      const key = noticeKey(e.self_id, replyId);
      const raw = await redis.get(key);
      // 引用的不是申请通知（或已超过 7 天），放行给后面的处理器
      if (!raw) return false;

      let request;
      try {
        request = JSON.parse(raw);
      } catch {
        await redis.del(key);
        return false;
      }

      const approve = e.match[1] === "同意";
      if (request.done) {
        await e.reply(`这条申请已经${request.done}过了`);
        return true;
      }

      const { target } = request;
      try {
        if (request.kind === "friend") {
          await callStrict(e, "set_friend_add_request", { flag: request.flag, approve });
        } else {
          await callStrict(e, "set_group_add_request", {
            flag: request.flag,
            sub_type: request.sub_type || "invite",
            approve,
          });
        }
      } catch (err) {
        // 不删记录，主人可以再引用重试；多半是已在别处处理或申请已失效
        await e.reply(`处理 ${target} 失败: ${err?.message || err}`);
        return true;
      }

      const action = approve ? "同意" : "拒绝";
      await redis.set(key, JSON.stringify({ ...request, done: action }), "KEEPTTL");
      await e.reply(`已${action} ${target}`);
      return true;
    }
  );
}
