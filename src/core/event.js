import { Segment, Group, Friend } from "../api/client.js";
import Config from "./config.js";
export class Event {
  constructor(event, bot) {
    Object.assign(this, event);

    this.bot = bot;

    if (this.group_id) {
      this.group = new Group(bot, this.group_id);
    }

    if (this.user_id) {
      this.friend = new Friend(bot, this.user_id);
    }

    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target) {
          return target[prop];
        }

        if (target.bot && typeof target.bot[prop] === "function") {
          return target.bot[prop].bind(target.bot);
        }

        return undefined;
      },
    });
  }

  get msg() {
    if (Array.isArray(this.message)) {
      let result = "";
      for (let i = 0; i < this.message.length; i++) {
        const seg = this.message[i];
        if (seg.type === "text") {
          let text = seg.data?.text || "";
          if (
            i > 0 &&
            this.message[i - 1].type === "at" &&
            text.startsWith(" ")
          ) {
            text = text.substring(1);
          }
          result += text;
        }
      }
      return result.trim();
    }
    return "";
  }

  get at() {
    if (Array.isArray(this.message)) {
      const atSeg = this.message.find((seg) => seg.type === "at");
      if (atSeg?.data?.qq) {
        if (atSeg.data.qq === "all") return undefined;
        return String(atSeg.data.qq);
      }
    }
    return undefined;
  }

  get reply_id() {
    if (Array.isArray(this.message)) {
      const replySeg = this.message.find((seg) => seg.type === "reply");
      return replySeg?.data?.id;
    }
    return undefined;
  }

  get isMaster() {
    const config = Config.get();
    const master = config.master;
    if (Array.isArray(master)) {
      return master.includes(this.user_id);
    }
    return master == this.user_id;
  }

  get isWhite() {
    if (this.isMaster) return true;
    const config = Config.get();
    const whiteUsers = config.whiteUsers || [];
    return whiteUsers.includes(this.user_id);
  }

  get isOwner() {
    return this.sender?.role === "owner";
  }

  get isAdmin() {
    return this.sender?.role === "admin" || this.sender?.role === "owner";
  }

  getMaster() {
    return Config.get('master');
  }

  getWhite() {
    const config = Config.get();
    const masters = config.master
      ? Array.isArray(config.master)
        ? config.master
        : [config.master]
      : [];
    const whiteUsers = config.whiteUsers || [];
    return [...new Set([...masters, ...whiteUsers])];
  }

  /**
   * 快速发送消息 (智能判断群/私聊)
   * @param msg 消息内容
   * @param {number} [recall=0] 撤回时间 (秒)
   * @param {boolean} [quote=false] 是否引用回复
   * @param {boolean} [at=false] 是否艾特发送者 (仅群聊有效)
   */
  async reply(msg, recall = 0, quote = false, at = false) {
    if (!this.group_id && !this.user_id) return;

    let message;
    if (Array.isArray(msg)) {
      message = msg.map((item) =>
        typeof item === "string" ? Segment.text(item) : item
      );
    } else {
      message =
        typeof msg === "object" && msg && msg.type
          ? [msg]
          : [Segment.text(msg)];
    }

    if (at && this.group_id) {
      message = [Segment.at(this.user_id), ...message];
    }

    if (quote && this.message_id) {
      message = [Segment.reply(this.message_id), ...message];
    }

    let res;
    if (this.group_id) {
      res = await this.bot.sendGroupMsg(this.group_id, message);
    } else if (this.user_id) {
      res = await this.bot.sendPrivateMsg(this.user_id, message);
    }

    if (recall > 0 && res && res.message_id) {
      setTimeout(() => {
        this.bot.deleteMsg(res.message_id);
      }, recall * 1000);
    }

    return res;
  }

  /**
   * 撤回消息
   * e.recall() -> 撤回当前触发事件的消息
   * e.recall(messageId) -> 撤回指定消息
   * e.recall(null, delay) -> 延迟撤回
   */
  async recall(messageId = null, delay = 0) {
    const msgId = messageId || this.message_id;
    if (msgId) {
      if (delay > 0) {
        setTimeout(() => {
          this.bot.deleteMsg(msgId);
        }, delay * 1000);
        return true;
      }
      return this.bot.deleteMsg(msgId);
    }
  }

  /**
   * 获取发送者或指定用户的详细信息 (智能判断上下文)
   * e.getInfo() -> 获取发送者信息
   * e.getInfo(targetId) -> 获取指定人信息
   * @param {number|string} [targetId] 目标用户 ID
   * @param {boolean} [noCache] 是否不使用缓存
   */
  async getInfo(targetId = null, noCache = false) {
    const uid = targetId || this.user_id;
    if (this.group_id) {
      return this.bot.getGroupMemberInfo(this.group_id, uid, noCache);
    } else {
      return this.bot.getStrangerInfo(uid, noCache);
    }
  }

  /**
   * 踢人 (智能判断)
   * e.kick() -> 踢出发送消息的人
   * e.kick(targetId) -> 踢出指定人
   * e.kick([id1, id2]) -> 批量踢人
   */
  async kick(targetId = null, rejectRequest = false) {
    if (!this.group_id) return false;

    if (Array.isArray(targetId)) {
      if (targetId.length === 0) return false;
      return this.bot.kickGroupMemberBatch(
        this.group_id,
        targetId,
        rejectRequest
      );
    }

    const uid = targetId || this.user_id;
    return this.bot.setGroupKick(this.group_id, uid, rejectRequest);
  }

  /**
   * 禁言 (智能判断)
   * e.ban(60) -> 禁言发送者 60秒
   * e.ban(60, targetId) -> 禁言指定人 60秒
   * e.ban(0) -> 解除禁言
   */
  async ban(duration = 6000, targetId = null) {
    if (!this.group_id) return false;
    const uid = targetId || this.user_id;
    return this.bot.setGroupBan(this.group_id, uid, duration);
  }

  /**
   * 全员禁言
   * e.wholeBan() -> 开启
   * e.wholeBan(false) -> 关闭
   */
  async wholeBan(enable = true) {
    if (!this.group_id) return false;
    return this.bot.setGroupWholeBan(this.group_id, enable);
  }

  /**
   * 设置管理员
   * e.admin() -> 设置发送者为管理
   * e.admin(false) -> 取消发送者管理
   * e.admin(true, targetId) -> 设置指定人为管理
   */
  async admin(enable = true, targetId = null) {
    if (!this.group_id) return false;
    const uid = targetId || this.user_id;
    return this.bot.setGroupAdmin(this.group_id, uid, enable);
  }

  /**
   * 修改群名片
   * e.card("新名字") -> 修改发送者名片
   * e.card("新名字", targetId) -> 修改指定人名片
   */
  async card(card, targetId = null) {
    if (!this.group_id) return false;
    const uid = targetId || this.user_id;
    return this.bot.setGroupCard(this.group_id, uid, card);
  }

  /**
   * 修改群头衔
   */
  async title(title, targetId = null) {
    if (!this.group_id) return false;
    const uid = targetId || this.user_id;
    return this.bot.setGroupSpecialTitle(this.group_id, uid, title);
  }

  /**
   * 戳一戳
   * e.poke() -> 戳发送者
   * e.poke(targetId) -> 戳指定人
   */
  async poke(targetId = null) {
    const uid = targetId || this.user_id;
    if (this.group_id) {
      return this.bot.groupPoke(this.group_id, uid);
    } else {
      return this.bot.friendPoke(uid);
    }
  }

  /**
   * 表情回应 (仅群聊)
   * 针对当前消息或指定消息贴表情
   * @param {number|string} emojiId 表情 ID
   * @param {number|string} [messageId] 消息 ID (可选，默认为当前消息)
   */
  async react(emojiId, messageId = null) {
    const msgId = messageId || this.message_id;
    if (!this.group_id || !msgId) return false;
    return this.bot.setMsgEmojiLike(msgId, emojiId);
  }

  /**
   * 同意请求 (加群/加好友)
   */
  async approve(remark = "", flag = null) {
    const targetFlag = flag || this.flag;
    if (!targetFlag) return;

    if (this.request_type === "friend") {
      return this.bot.setFriendAddRequest(targetFlag, true, remark);
    }
    if (this.request_type === "group") {
      return this.bot.setGroupAddRequest(targetFlag, this.sub_type, true);
    }
  }

  /**
   * 拒绝请求
   */
  async reject(reason = "", flag = null) {
    const targetFlag = flag || this.flag;
    if (!targetFlag) return;

    if (this.request_type === "friend") {
      return this.bot.setFriendAddRequest(targetFlag, false);
    }
    if (this.request_type === "group") {
      return this.bot.setGroupAddRequest(
        targetFlag,
        this.sub_type,
        false,
        reason
      );
    }
  }

  /**
   * 智能获取历史消息记录
   * 根据当前上下文自动判断获取群聊或私聊历史消息
   * @param {number} [count=20] 获取消息数量
   * @param {number|string} [messageSeq] 起始消息序号 (可选，默认从最新开始)
   * @returns {Promise<Array>} 消息列表
   */
  async getMsgHistory(count = 20, messageSeq = null) {
    let messages = [];

    if (this.group_id) {
      const res = await this.bot.getGroupMsgHistory(this.group_id, messageSeq);
      messages = res?.messages || [];
    } else if (this.user_id) {
      const res = await this.bot.getFriendMsgHistory(this.user_id, messageSeq);
      messages = res?.messages || [];
    }

    if (count > 0 && messages.length > count) {
      messages = messages.slice(-count);
    }

    return messages;
  }

  /**
   * 获取引用消息的详情
   * 如果当前消息包含引用回复，自动获取被引用消息的详细内容
   * @returns {Promise<object|null>} 被引用的消息详情
   */
  async getReplyMsg() {
    const replyId = this.reply_id;
    if (!replyId) return null;
    return this.bot.getMsg(replyId);
  }

  /**
   * 获取指定消息的详情
   * @param {number|string} messageId 消息 ID
   * @returns {Promise<object|null>} 消息详情
   */
  async getMsg(messageId) {
    if (!messageId) return null;
    return this.bot.getMsg(messageId);
  }

  /**
   * 制作并发送合并转发消息
   * @param {string|object|array} msg 消息内容或消息数组
   * @param {object} info 转发信息配置
   * @param {string} info.prompt 外显摘要
   * @param {string} info.summary 底部文本
   * @param {string} info.source 来源标题
   * @param {Array} info.news 自定义摘要
   */
  async sendForwardMsg(msg, info = {}) {
    const { prompt, summary, source, news } = info;

    let nodes = [];
    const msgs = Array.isArray(msg) ? msg : [msg];

    for (let m of msgs) {
      if (!m) continue;

      if (typeof m === "object" && m.type === "node") {
        nodes.push(m);
        continue;
      }

      let content = m;
      let uid = this.bot.self_id;
      let name = this.bot.nickname;
      let extraData = {};

      if (typeof m === "object" && !Array.isArray(m) && m.content) {
        content = m.content;
        if (m.user_id) uid = m.user_id;
        if (m.nickname) name = m.nickname;
        const { content: _, user_id: __, nickname: ___, ...rest } = m;
        extraData = rest;
      }

      if (Array.isArray(content)) {
        content = content.map((item) =>
          typeof item === "string" ? Segment.text(item) : item
        );
      } else {
        content =
          typeof content === "object" && content && content.type
            ? [content]
            : [Segment.text(content)];
      }

      nodes.push({
        type: "node",
        data: {
          user_id: uid,
          nickname: name,
          content: content,
          ...extraData,
        },
      });
    }

    if (nodes.length === 0) return;

    const params = {
      messages: nodes,
    };

    if (prompt) params.prompt = prompt;
    if (summary) params.summary = summary;
    if (source) params.source = source;

    if (news) {
      params.news = news;
    }

    if (this.group_id) {
      params.group_id = this.group_id;
    } else if (this.user_id) {
      params.user_id = this.user_id;
    }

    return this.bot.sendForwardMsg(params);
  }
}
