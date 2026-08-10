
const requestHashKey = (self_id, group_id) => `sakura:groupRequest:${self_id || "default"}:${group_id}`;
const requestCounterKey = (self_id, group_id) => `sakura:groupRequest:${self_id || "default"}:${group_id}:counter`;
const REQUEST_TTL = 7 * 24 * 60 * 60;

// 同意/拒绝时要带上 sub_type（add 和 invite 是两条不同的审批队列），所以 flag 和 sub_type 一起存
const encodeRequest = (flag, sub_type) =>
  JSON.stringify({ flag, sub_type: sub_type || "add" });

function decodeRequest(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.flag) return { flag: parsed.flag, sub_type: parsed.sub_type || "add" };
  } catch {
    // 旧数据只存了 flag 本身
  }
  return { flag: raw, sub_type: "add" };
}

export class groupRequestListener extends plugin {
  constructor() {
    super({
      name: "入群申请监听",
    });
  }

  handleGroupAddRequest = OnEvent("request.group", async (e) => {
    // 「群成员邀请他人入群、待管理员审批」：NapCat 报 sub_type=add，SnowLuma 报 invite。
    // 但「邀请 bot 进新群」也是 invite，那种情况 bot 还不在群里，没法在群里发门牌号，跳过。
    if (e.sub_type === "invite") {
      const selfMember = await e
        .getGroupMemberInfo(e.group_id, e.self_id)
        .catch(() => null);
      if (!selfMember) return false;
    }

    const info = await e.getStrangerInfo(e.user_id).catch(() => null);
    const nickname = info?.nickname || e.user_id;

    const markerId = await redis.incr(requestCounterKey(e.self_id, e.group_id));
    await redis.expire(requestCounterKey(e.self_id, e.group_id), REQUEST_TTL);
    await redis.hset(
      requestHashKey(e.self_id, e.group_id),
      markerId,
      encodeRequest(e.flag, e.sub_type)
    );
    await redis.expire(requestHashKey(e.self_id, e.group_id), REQUEST_TTL);

    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=100`;
    // 这里不要拆成多个连续 text 段。部分 QQNT/Milky 组合在“连续文本段 + 图片”混排时，
    // 偶发把中间文本段渲染成乱码/0；把所有文字合成一个 text 段更稳。
    const message = [
      `来人啦\n门牌号: ${markerId}\n敲门人: ${nickname} (${e.user_id})\n敲门口令: ${e.comment || "这个人啥也没说"}`,
      segment.image(avatarUrl),
    ];
    await e.reply(message);

    return false;
  });

  handleApprovalCommand = Command(
    /^#?开门\s*(\d+)$/,
    "message.group",
    1135,
    async (e) => {
      if (!e.isAdmin && !e.isWhite) {
        return false;
      }

      const markerId = Number(e.msg.match(/^#?开门\s*(\d+)$/)[1]);
      const request = decodeRequest(
        await redis.hget(requestHashKey(e.self_id, e.group_id), markerId)
      );

      if (!request) {
        await e.reply(`门牌号${markerId}不存在`, 10);
        return true;
      }

      await e.reply(`好的，我这就开门`);
      await e.bot.setGroupAddRequest({
        flag: request.flag,
        sub_type: request.sub_type,
        approve: true,
      });
      await redis.hdel(requestHashKey(e.self_id, e.group_id), markerId);

      return true;
    }
  );

  handleRejectCommand = Command(
    /^#?关门\s*(\d+)$/,
    "message.group",
    1135,
    async (e) => {
      if (!e.isAdmin && !e.isWhite) {
        return false;
      }

      const markerId = Number(e.msg.match(/^#?关门\s*(\d+)$/)[1]);
      const request = decodeRequest(
        await redis.hget(requestHashKey(e.self_id, e.group_id), markerId)
      );

      if (!request) {
        await e.reply(`门牌号${markerId}不存在`, 10);
        return true;
      }

      await e.reply(`好的，我这就关门`);
      await e.bot.setGroupAddRequest({
        flag: request.flag,
        sub_type: request.sub_type,
        approve: false,
      });
      await redis.hdel(requestHashKey(e.self_id, e.group_id), markerId);

      return true;
    }
  );
}
