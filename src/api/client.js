import { logger, logContext } from "../utils/logger.js";

/**
 * 驼峰 → 下划线
 * sendGroupMsg → send_group_msg
 */
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export const Segment = {
  text: (text) => ({ type: "text", data: { text } }),
  image: (file, sub_type) => ({
    type: "image",
    data: {
      file:
        typeof file === "string" ? file : `base64://${file.toString("base64")}`,
      sub_type,
    },
  }),
  record: (file) => ({ type: "record", data: { file } }),
  video: (file) => ({ type: "video", data: { file } }),
  at: (qq) => ({ type: "at", data: { qq } }),
  reply: (id) => ({ type: "reply", data: { id } }),
  poke: (qq) => ({ type: "poke", data: { qq } }),
  dice: () => ({ type: "dice", data: {} }),
  rps: () => ({ type: "rps", data: {} }),
  json: (data) => ({
    type: "json",
    data: { data: typeof data === "string" ? data : JSON.stringify(data) },
  }),
  face: (id) => ({ type: "face", data: { id } }),
  music: (type, id) => ({
    type: "music",
    data: { type, id },
  }),
  customMusic: (url, audio, title, content, image) => ({
    type: "music",
    data: { type: "custom", url, audio, title, content, image },
  }),
  file: (file, name) => ({
    type: "file",
    data: { file, name },
  }),
};

/**
 * 当前实例的 Bot。一个进程只服务一个 QQ 号（多个号各开一个实例，见 docs/multi-instance.md），
 * 所以这里没有账号路由：bot 就是当前这条连接上的账号，离线时为 null。
 */
export let bot = null;

function normalizeNumericId(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function setCurrentBot(instance) {
  bot = instance;
  if (typeof global !== "undefined") {
    global.bot = instance;
  }
}

const POSITIONAL_PARAM_BUILDERS = {
  getGroupInfo: (group_id, no_cache = false) => ({ group_id, no_cache }),
  getGroupMemberInfo: (group_id, user_id, no_cache = false) => ({
    group_id,
    user_id,
    no_cache,
  }),
  getGroupMemberList: (group_id, no_cache = false) => ({ group_id, no_cache }),
  getGroupHonorInfo: (group_id, type) => ({ group_id, type }),
  getStrangerInfo: (user_id, no_cache = false) => ({ user_id, no_cache }),
  getGroupMsgHistory: (group_id, message_seq, count) => ({
    group_id,
    ...(message_seq !== undefined ? { message_seq } : {}),
    ...(count !== undefined ? { count } : {}),
  }),
  getFriendMsgHistory: (user_id, message_seq, count) => ({
    user_id,
    ...(message_seq !== undefined ? { message_seq } : {}),
    ...(count !== undefined ? { count } : {}),
  }),
  deleteMsg: (message_id) => ({ message_id }),
  getMsg: (message_id) => ({ message_id }),
};

/**
 * 取当前 Bot。传了 selfId 时账号对得上才返回，免得把别的号当成自己。
 */
export function getBot(selfId) {
  if (!bot) return undefined;
  if (selfId === undefined || selfId === null || selfId === "") return bot;
  return normalizeNumericId(selfId) === bot.self_id ? bot : undefined;
}

/** 面板展示用的账号摘要，离线时为 null */
export function getBotSummary() {
  if (!bot) return null;
  const loginInfo = bot.loginInfo || {};
  return {
    self_id: bot.self_id,
    uin: loginInfo.user_id || bot.self_id,
    nickname: loginInfo.nickname || bot.nickname || null,
    status: "online",
    // 群和好友列表在连接后异步拉取，还没拉到时为 null
    groupCount: bot.groupCount ?? null,
    friendCount: bot.friendCount ?? null,
  };
}

/** 账号下线：传了 selfId 时只在对得上当前账号时注销 */
export function removeBot(selfId) {
  if (!bot) return;
  if (selfId != null && normalizeNumericId(selfId) !== bot.self_id) return;
  setCurrentBot(null);
}

export class Friend {
  constructor(bot, user_id) {
    this.bot = bot;
    this.user_id = user_id;
  }

  /** 发送私聊消息 */
  async sendMsg(message) {
    return this.bot.sendPrivateMsg(this.user_id, message);
  }

  /** 发送合并转发消息 */
  async sendForwardMsg(messages) {
    return this.bot.sendForwardMsg(messages, undefined, this.user_id);
  }

  /** 发送戳一戳 */
  async poke() {
    return this.bot.friendPoke({ user_id: this.user_id });
  }

  /** 发送私聊文件 */
  async uploadFile(file, name) {
    return this.bot.uploadPrivateFile({ user_id: this.user_id, file, name });
  }

  /** 获取好友历史消息 */
  async getMsgHistory(message_seq) {
    return this.bot.getFriendMsgHistory({ user_id: this.user_id, message_seq });
  }

  /** 点赞 */
  async sendLike(times = 1) {
    return this.bot.sendLike({ user_id: this.user_id, times });
  }

  /** 设置私聊已读 */
  async setRead() {
    return this.bot.markPrivateMsgAsRead({ user_id: this.user_id });
  }

  /** 获取账号信息 (陌生人信息) */
  async getInfo(no_cache = false) {
    return this.bot.getStrangerInfo({ user_id: this.user_id, no_cache });
  }

  /** 删除好友 */
  async delete() {
    return this.bot.deleteFriend({ user_id: this.user_id });
  }

  /** 设置好友备注 */
  async setRemark(remark) {
    return this.bot.setFriendRemark({ user_id: this.user_id, remark });
  }

  /** 获取用户状态 */
  async getStatus() {
    return this.bot.ncGetUserStatus({ user_id: this.user_id });
  }

  /** 获取私聊文件链接 */
  async getFileUrl(file_id) {
    return this.bot.getPrivateFileUrl({ user_id: this.user_id, file_id });
  }

  /** 转发单条消息到私聊 */
  async forwardSingleMsg(message_id) {
    return this.bot.forwardFriendSingleMsg({
      user_id: this.user_id,
      message_id,
    });
  }
}

export class Group {
  constructor(bot, group_id) {
    this.bot = bot;
    this.group_id = group_id;
  }

  /** 发送群聊消息 */
  async sendMsg(message) {
    return this.bot.sendGroupMsg(this.group_id, message);
  }

  /** 发送合并转发消息 */
  async sendForwardMsg(messages) {
    return this.bot.sendForwardMsg(messages, this.group_id);
  }

  /** 发送戳一戳 (群内成员) */
  async poke(user_id) {
    return this.bot.groupPoke({ group_id: this.group_id, user_id });
  }

  /** 发送群文件 */
  async uploadFile(file, name) {
    return this.bot.uploadGroupFile({ group_id: this.group_id, file, name });
  }

  /** 获取群历史消息 */
  async getMsgHistory(message_seq, count) {
    const params = { group_id: this.group_id, message_seq };
    if (count !== undefined) params.count = count;
    return this.bot.getGroupMsgHistory(params);
  }

  /** 发送群 AI 语音 */
  async sendAiRecord(character, text) {
    return this.bot.sendGroupAiRecord({
      group_id: this.group_id,
      character,
      text,
    });
  }

  /** 设置群聊已读 */
  async setRead() {
    return this.bot.markGroupMsgAsRead({ group_id: this.group_id });
  }

  /** 获取群信息 */
  async getInfo(no_cache = false) {
    return this.bot.getGroupInfo({ group_id: this.group_id, no_cache });
  }

  /** 获取群成员信息 */
  async getMemberInfo(user_id, no_cache = false) {
    return this.bot.getGroupMemberInfo({
      group_id: this.group_id,
      user_id,
      no_cache,
    });
  }

  /** 获取群成员列表 */
  async getMemberList(no_cache = false) {
    return this.bot.getGroupMemberList({
      group_id: this.group_id,
      no_cache,
    });
  }

  /** 获取群荣誉信息 */
  async getHonorInfo(type) {
    return this.bot.getGroupHonorInfo({ group_id: this.group_id, type });
  }

  /** 群禁言 */
  async setBan(user_id, duration = 30 * 60) {
    return this.bot.setGroupBan({
      group_id: this.group_id,
      user_id,
      duration,
    });
  }

  /** 群全员禁言 */
  async setWholeBan(enable = true) {
    return this.bot.setGroupWholeBan({ group_id: this.group_id, enable });
  }

  /** 设置群管理 */
  async setAdmin(user_id, enable = true) {
    return this.bot.setGroupAdmin({ group_id: this.group_id, user_id, enable });
  }

  /** 群踢人 */
  async kick(user_id, reject_add_request = false) {
    return this.bot.setGroupKick({
      group_id: this.group_id,
      user_id,
      reject_add_request,
    });
  }

  /** 设置群名 */
  async setName(group_name) {
    return this.bot.setGroupName({ group_id: this.group_id, group_name });
  }

  /** 设置群成员名片 */
  async setCard(user_id, card) {
    return this.bot.setGroupCard({ group_id: this.group_id, user_id, card });
  }

  /** 设置群头衔 */
  async setSpecialTitle(user_id, special_title, duration = -1) {
    return this.bot.setGroupSpecialTitle({
      group_id: this.group_id,
      user_id,
      special_title,
      duration,
    });
  }

  /** 退出群组 */
  async leave(is_dismiss = false) {
    return this.bot.setGroupLeave({ group_id: this.group_id, is_dismiss });
  }

  /** 设置群头像 */
  async setPortrait(file) {
    return this.bot.setGroupPortrait({ group_id: this.group_id, file });
  }

  /** 获取群精华消息 */
  async getEssence() {
    return this.bot.getEssenceMsgList({ group_id: this.group_id });
  }

  /** 发送群公告 */
  async sendNotice(content, image) {
    const params = { group_id: this.group_id, content };
    if (image) params.image = image;
    return this.bot.sendGroupNotice(params);
  }

  /** 获取群公告 */
  async getNotice() {
    return this.bot.getGroupNotice({ group_id: this.group_id });
  }

  /** 删除群公告 */
  async deleteNotice(notice_id) {
    return this.bot.delGroupNotice({ group_id: this.group_id, notice_id });
  }

  /** 设置群搜索 */
  async setSearch(is_search) {
    return this.bot.setGroupSearch({ group_id: this.group_id, is_search });
  }

  /** 获取群详细信息 */
  async getInfoEx() {
    return this.bot.getGroupInfoEx({ group_id: this.group_id });
  }

  /** 设置群添加选项 */
  async setAddOption(option, question, answer) {
    return this.bot.setGroupAddOption({
      group_id: this.group_id,
      option,
      question,
      answer,
    });
  }

  /** 设置群机器人添加选项 */
  async setBotAddOption(option) {
    return this.bot.setGroupRobotAddOption({
      group_id: this.group_id,
      option,
    });
  }

  /** 设置群备注 */
  async setRemark(remark) {
    return this.bot.setGroupRemark({ group_id: this.group_id, remark });
  }

  /** 获取群 @全体成员 剩余次数 */
  async getAtAllRemain() {
    return this.bot.getGroupAtAllRemain({ group_id: this.group_id });
  }

  /** 获取群禁言列表 */
  async getBanList() {
    return this.bot.getGroupShutList({ group_id: this.group_id });
  }

  /** 获取群过滤系统消息 */
  async getIgnoredNotifies() {
    return this.bot.getGroupIgnoredNotifies({ group_id: this.group_id });
  }

  /** 群打卡 */
  async sign() {
    return this.bot.setGroupSign({ group_id: this.group_id });
  }

  /** 创建群文件文件夹 */
  async createFileFolder(name, parent_id = "/") {
    return this.bot.createGroupFileFolder({
      group_id: this.group_id,
      name,
      parent_id,
    });
  }

  /** 删除群文件 */
  async deleteFile(file_id, busid) {
    return this.bot.deleteGroupFile({
      group_id: this.group_id,
      file_id,
      busid,
    });
  }

  /** 删除群文件夹 */
  async deleteFolder(folder_id) {
    return this.bot.deleteGroupFolder({
      group_id: this.group_id,
      folder_id,
    });
  }

  /** 获取群文件系统信息 */
  async getFileSystemInfo() {
    return this.bot.getGroupFileSystemInfo({ group_id: this.group_id });
  }

  /** 获取群根目录文件列表 */
  async getRootFiles() {
    return this.bot.getGroupRootFiles({ group_id: this.group_id });
  }

  /** 获取群子目录文件列表 */
  async getFilesByFolder(folder_id) {
    return this.bot.getGroupFilesByFolder({
      group_id: this.group_id,
      folder_id,
    });
  }

  /** 获取群文件链接 */
  async getFileUrl(file_id, busid) {
    return this.bot.getGroupFileUrl({
      group_id: this.group_id,
      file_id,
      busid,
    });
  }

  /** 移动群文件 */
  async moveFile(file_id, folder_id) {
    return this.bot.moveGroupFile({
      group_id: this.group_id,
      file_id,
      folder_id,
    });
  }

  /** 重命名群文件 */
  async renameFile(file_id, name) {
    return this.bot.renameGroupFile({
      group_id: this.group_id,
      file_id,
      name,
    });
  }

  /** 转发单条消息到群 */
  async forwardSingleMsg(message_id) {
    return this.bot.forwardGroupSingleMsg({
      group_id: this.group_id,
      message_id,
    });
  }

  /** 删除群相册文件 */
  async deleteAlbumFile(album_id, photo_ids) {
    return this.bot.delGroupAlbumMedia({
      group_id: this.group_id,
      album_id,
      photo_ids,
    });
  }

  /** 点赞群相册 */
  async albumLike(album_id, photo_id) {
    return this.bot.setGroupAlbumMediaLike({
      group_id: this.group_id,
      album_id,
      photo_id,
    });
  }

  /** 查看群相册评论 */
  async getAlbumComments(album_id, photo_id) {
    return this.bot.doGroupAlbumComment({
      group_id: this.group_id,
      album_id,
      photo_id,
    });
  }

  /** 获取群相册列表 */
  async getAlbumList(album_id) {
    return this.bot.getGroupAlbumMediaList({
      group_id: this.group_id,
      album_id,
    });
  }

  /** 上传图片到群相册 */
  async uploadAlbumImage(album_id, album_name, file, desc) {
    return this.bot.uploadImageToQunAlbum({
      group_id: this.group_id,
      album_id,
      album_name,
      file,
      desc,
    });
  }

  /** 获取群相册总列表 */
  async getAlbumMainList() {
    return this.bot.getQunAlbumList({ group_id: this.group_id });
  }

  /** 设置群精华消息 */
  async setEssence(message_id) {
    return this.bot.setEssenceMsg({ message_id });
  }

  /** 删除群精华消息 */
  async deleteEssence(message_id) {
    return this.bot.deleteEssenceMsg({ message_id });
  }

  /** 设置群代办 */
  async setTodo(message_id, message_seq) {
    const params = { group_id: this.group_id, message_id };
    if (message_seq !== undefined) params.message_seq = message_seq;
    return this.bot.setGroupTodo(params);
  }
}

/**
 * OneBotApi —— 包裹 OneBotWsClient 实例，用 ES6 Proxy 自动映射驼峰 → 下划线
 *
 * 使用方式:
 *   bot.sendGroupMsg(group_id, message)         // 保留的自定义方法
 *   bot.setGroupBan({ group_id, user_id, ... }) // Proxy 自动转发 → ws.set_group_ban(params)
 *   bot.anyNewApi({ ... })                       // 任何 OneBot v11 API 无需修改代码
 */
export class OneBotApi {
  constructor(ws, selfId) {
    this.ws = ws;
    this._selfId = normalizeNumericId(selfId) ?? selfId;
    this.nickname = "Bot";
    this.loginInfo = null;
    this.groupCount = null;
    this.friendCount = null;

    // ES6 Proxy: 自动将驼峰方法映射到 OneBotWsClient 的下划线方法
    const proxy = new Proxy(this, {
      get(target, prop, receiver) {
        // 1. 实例自身属性（含原型链方法）优先
        if (prop in target) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value === "function") {
            return value.bind(target);
          }
          return value;
        }

        // 2. 内置 Symbol 等非字符串属性直接返回
        if (typeof prop !== "string") {
          return undefined;
        }

        // 3. 驼峰 → 下划线，生成代理方法
        const snakeName = camelToSnake(prop);
        if (typeof target.ws[snakeName] === "function") {
          return (...args) => {
            let params = args[0];
            // 传的不是参数对象时按位置参数组装，如 getGroupInfo(groupId)、getGroupMemberInfo(groupId, userId)
            const isParamObject = params && typeof params === "object" && !Array.isArray(params);
            if (args.length > 0 && !isParamObject && POSITIONAL_PARAM_BUILDERS[prop]) {
              params = POSITIONAL_PARAM_BUILDERS[prop](...args);
            }
            return target.sendRequest(snakeName, params || {});
          };
        }

        // 未知属性返回 undefined（不兜底，避免 Event Proxy 误判）
        return undefined;
      },
    });

    this._proxy = proxy;
    setCurrentBot(proxy);

    this.init();

    return proxy;
  }

  async init() {
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const info = await this.getLoginInfo();
      if (info?.nickname) {
        this.nickname = info.nickname;
      }

      // 部分实现（如 SnowLuma）在昵称缺失时会回退成 QQ 号，改查资料接口补全
      if (
        !this.nickname ||
        this.nickname === "Bot" ||
        this.nickname === String(this._selfId)
      ) {
        const profile = await this.sendRequest("get_stranger_info", {
          user_id: this._selfId,
        });
        const realNickname = profile?.nickname;
        if (realNickname && realNickname !== String(this._selfId)) {
          this.nickname = realNickname;
          if (info) info.nickname = realNickname;
        }
      }

      if (info) {
        this.loginInfo = { ...info };
      }

      // getGroupList / getFriendList 会顺手记下数量
      await Promise.allSettled([this.getGroupList(), this.getFriendList()]);
    } catch (e) {
      // 忽略初始化错误
    }
  }

  /** 获取好友对象 */
  pickFriend(user_id) {
    return new Friend(this._proxy || this, user_id);
  }

  /** 获取群对象 */
  pickGroup(group_id) {
    return new Group(this._proxy || this, group_id);
  }

  get self_id() {
    return this._selfId;
  }

  /**
   * 兜底请求方法 —— 直接调用 OneBotWsClient.send()
   */
  async sendRequest(action, params) {
    try {
      return await this.ws.send(action, params || {}, { selfId: this._selfId });
    } catch (e) {
      logger.error(`Request ${action} failed: ${e.message || e}`);
      return null;
    }
  }

  // =================== 登录信息 ===================

  /** 获取登录号信息 */
  async getLoginInfo() {
    return this.sendRequest("get_login_info", {});
  }

  /** 获取群列表 */
  async getGroupList() {
    const groups = await this.sendRequest("get_group_list", {});
    if (Array.isArray(groups)) this.groupCount = groups.length;
    return groups;
  }

  /** 获取好友列表 */
  async getFriendList() {
    const friends = await this.sendRequest("get_friend_list", {});
    if (Array.isArray(friends)) this.friendCount = friends.length;
    return friends;
  }

  // =================== 消息发送（带日志） ===================

  /** 发送群聊消息 */
  async sendGroupMsg(group_id, message) {
    let msgLog = "";
    if (typeof message === "string") {
      msgLog = message;
    } else {
      try {
        msgLog = JSON.stringify(message);
      } catch {
        msgLog = String(message);
      }
    }

    if (msgLog.length > 200) {
      msgLog = msgLog.substring(0, 200) + "...";
    }
    const ctx = logContext.getStore();
    const target = ctx?.group_id === group_id ? "" : ` ${group_id}`;
    return this.sendRequest("send_group_msg", { group_id, message });
  }

  /** 发送私聊消息 */
  async sendPrivateMsg(user_id, message) {
    let msgLog = "";
    if (typeof message === "string") {
      msgLog = message;
    } else {
      try {
        msgLog = JSON.stringify(message);
      } catch {
        msgLog = String(message);
      }
    }

    if (msgLog.length > 200) {
      msgLog = msgLog.substring(0, 200) + "...";
    }
    const ctx = logContext.getStore();
    const target = ctx?.user_id === user_id ? "" : ` ${user_id}`;
    return this.sendRequest("send_private_msg", { user_id, message });
  }

  // =================== 便捷组合方法 ===================

  /** 发送群图片 */
  async sendGroupImage(group_id, file) {
    return this.sendGroupMsg(group_id, [Segment.image(file)]);
  }

  /** 发送私聊图片 */
  async sendPrivateImage(user_id, file) {
    return this.sendPrivateMsg(user_id, [Segment.image(file)]);
  }

  /** 发送群语音 */
  async sendGroupVoice(group_id, file) {
    return this.sendGroupMsg(group_id, [Segment.record(file)]);
  }

  /** 发送私聊语音 */
  async sendPrivateVoice(user_id, file) {
    return this.sendPrivateMsg(user_id, [Segment.record(file)]);
  }

  /** 发送群视频 */
  async sendGroupVideo(group_id, file) {
    return this.sendGroupMsg(group_id, [Segment.video(file)]);
  }

  /** 发送私聊视频 */
  async sendPrivateVideo(user_id, file) {
    return this.sendPrivateMsg(user_id, [Segment.video(file)]);
  }

  /** 发送群音乐卡片 */
  async sendGroupMusic(group_id, type, id) {
    return this.sendGroupMsg(group_id, [Segment.music(type, id)]);
  }

  /** 发送私聊音乐卡片 */
  async sendPrivateMusic(user_id, type, id) {
    return this.sendPrivateMsg(user_id, [Segment.music(type, id)]);
  }

  /** 发送群骰子 */
  async sendGroupDice(group_id) {
    return this.sendGroupMsg(group_id, [Segment.dice()]);
  }

  /** 发送私聊骰子 */
  async sendPrivateDice(user_id) {
    return this.sendPrivateMsg(user_id, [Segment.dice()]);
  }

  /** 发送群猜拳 */
  async sendGroupRps(group_id) {
    return this.sendGroupMsg(group_id, [Segment.rps()]);
  }

  /** 发送私聊猜拳 */
  async sendPrivateRps(user_id) {
    return this.sendPrivateMsg(user_id, [Segment.rps()]);
  }

  // =================== 需要特殊参数处理的方法 ===================

  /** 撤回消息 */
  async deleteMsg(message_id) {
    const params =
      message_id && typeof message_id === "object"
        ? { ...message_id }
        : { message_id };
    return this.sendRequest("delete_msg", params);
  }

  /** 获取消息详情 */
  async getMsg(message_id) {
    const params =
      message_id && typeof message_id === "object"
        ? { ...message_id }
        : { message_id };
    return this.sendRequest("get_msg", params);
  }

  /** 发送合并转发消息（参数处理复杂，保留） */
  async sendForwardMsg(messages, group_id, user_id) {
    const ctx = logContext.getStore();

    const shrink = (text) => {
      if (!text) return "";
      return text.length > 200 ? text.substring(0, 200) + "..." : text;
    };

    const safeStringify = (value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const buildTargetText = (gid, uid) => {
      if (gid) {
        const sameGroup = ctx?.group_id && String(ctx.group_id) === String(gid);
        return `群聊${sameGroup ? "" : ` ${gid}`}`;
      }
      if (uid) {
        const sameUser = ctx?.user_id && String(ctx.user_id) === String(uid);
        return `私聊${sameUser ? "" : ` ${uid}`}`;
      }
      return "未知目标";
    };

    if (!Array.isArray(messages)) {
      const params = { ...messages };
      if (group_id && !params.group_id) params.group_id = group_id;
      if (user_id && !params.user_id) params.user_id = user_id;

      const targetText = buildTargetText(params.group_id, params.user_id);
      const msgLog = shrink(safeStringify(params.messages ?? params));

      return this.sendRequest("send_forward_msg", params);
    }

    const targetText = buildTargetText(group_id, user_id);
    const msgLog = shrink(safeStringify(messages));

    return this.sendRequest("send_forward_msg", {
      messages,
      group_id,
      user_id,
    });
  }

  /** 群公告（action 名带下划线前缀） */
  async sendGroupNotice(params) {
    return this.sendRequest("_send_group_notice", params);
  }

  /** 获取群公告 */
  async getGroupNotice(params) {
    return this.sendRequest("_get_group_notice", params);
  }

  /** 删除群公告（action 名带下划线前缀，对齐 NapCat/go-cqhttp） */
  async delGroupNotice(params) {
    return this.sendRequest("_del_group_notice", params);
  }
}
