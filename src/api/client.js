import { logger } from "../utils/logger.js";

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
  customMusic: (
    url,
    audio,
    title,
    content,
    image
  ) => ({
    type: "music",
    data: { type: "custom", url, audio, title, content, image },
  }),
  file: (file, name) => ({
    type: "file",
    data: { file, name },
  }),
};

export let bot;
export const bots = new Map();

export function getBot(selfId) {
  return bots.get(Number(selfId));
}

export function removeBot(selfId) {
    const id = Number(selfId);
    bots.delete(id);
    if (bot && bot.self_id === id) {
        bot = undefined;
        if (typeof global !== 'undefined') global.bot = null;
        if (bots.size > 0) {
            bot = bots.values().next().value;
            if (typeof global !== 'undefined') global.bot = bot;
        }
    }
}

export class Friend {
  constructor(bot, user_id) {
    this.bot = bot;
    this.user_id = user_id;
  }

  /**
   * 发送私聊消息
   * @param message 消息内容
   */
  async sendMsg(message) {
    return this.bot.sendPrivateMsg(this.user_id, message);
  }

  /**
   * 发送合并转发消息
   * @param messages 消息列表
   */
  async sendForwardMsg(messages) {
    return this.bot.sendForwardMsg(messages, undefined, this.user_id);
  }

  /**
   * 发送戳一戳
   */
  async poke() {
    return this.bot.friendPoke(this.user_id);
  }

  /**
   * 发送私聊文件
   * @param file 文件路径
   * @param name 文件名
   */
  async uploadFile(file, name) {
    return this.bot.uploadPrivateFile(this.user_id, file, name);
  }

  /**
   * 获取好友历史消息
   * @param message_seq 起始消息序号
   */
  async getMsgHistory(message_seq) {
    return this.bot.getFriendMsgHistory(this.user_id, message_seq);
  }

  /**
   * 点赞
   * @param times 点赞次数
   */
  async sendLike(times = 1) {
    return this.bot.sendLike(this.user_id, times);
  }

  /**
   * 设置私聊已读
   */
  async setRead() {
    return this.bot.setPrivateRead(this.user_id);
  }

  /**
   * 获取账号信息 (陌生人信息)
   * @param no_cache 是否不使用缓存
   */
  async getInfo(no_cache = false) {
    return this.bot.getStrangerInfo(this.user_id, no_cache);
  }

  /**
   * 删除好友
   */
  async delete() {
    return this.bot.deleteFriend(this.user_id);
  }

  /**
   * 设置好友备注
   * @param remark 备注
   */
  async setRemark(remark) {
    return this.bot.setFriendRemark(this.user_id, remark);
  }

  /**
   * 获取用户状态
   */
  async getStatus() {
    return this.bot.getUserStatus(this.user_id);
  }

  /**
   * 获取私聊文件链接
   * @param file_id 文件 ID
   */
  async getFileUrl(file_id) {
    return this.bot.getPrivateFileUrl(this.user_id, file_id);
  }

  /**
   * 转发单条消息到私聊
   * @param message_id 消息 ID
   */
  async forwardSingleMsg(message_id) {
    return this.bot.forwardFriendSingleMsg(this.user_id, message_id);
  }
}

export class Group {
  constructor(bot, group_id) {
    this.bot = bot;
    this.group_id = group_id;
  }

  /**
   * 发送群聊消息
   * @param message 消息内容
   */
  async sendMsg(message) {
    return this.bot.sendGroupMsg(this.group_id, message);
  }

  /**
   * 发送合并转发消息
   * @param messages 消息列表
   */
  async sendForwardMsg(messages) {
    return this.bot.sendForwardMsg(messages, this.group_id);
  }

  /**
   * 发送戳一戳 (群内成员)
   * @param user_id 目标成员 QQ 号
   */
  async poke(user_id) {
    return this.bot.groupPoke(this.group_id, user_id);
  }

  /**
   * 发送群文件
   * @param file 文件路径
   * @param name 文件名
   */
  async uploadFile(file, name) {
    return this.bot.uploadGroupFile(this.group_id, file, name);
  }

  /**
   * 获取群历史消息
   * @param message_seq 起始消息序号
   */
  async getMsgHistory(message_seq) {
    return this.bot.getGroupMsgHistory(this.group_id, message_seq);
  }

  /**
   * 发送群 AI 语音
   * @param character 角色名
   * @param text 文本内容
   */
  async sendAiRecord(character, text) {
    return this.bot.sendGroupAiRecord(this.group_id, character, text);
  }

  /**
   * 设置群聊已读
   */
  async setRead() {
    return this.bot.setGroupRead(this.group_id);
  }

  /**
   * 获取群信息
   * @param no_cache 是否不使用缓存
   */
  async getInfo(no_cache = false) {
    return this.bot.getGroupInfo(this.group_id, no_cache);
  }

  /**
   * 获取群成员信息
   * @param user_id 成员 QQ 号
   * @param no_cache 是否不使用缓存
   */
  async getMemberInfo(user_id, no_cache = false) {
    return this.bot.getGroupMemberInfo(this.group_id, user_id, no_cache);
  }

  /**
   * 获取群成员列表
   * @param no_cache 是否不使用缓存
   */
  async getMemberList(no_cache = false) {
    return this.bot.getGroupMemberList(this.group_id, no_cache);
  }

  /**
   * 获取群荣誉信息
   * @param type 荣誉类型
   */
  async getHonorInfo(type) {
    return this.bot.getGroupHonorInfo(this.group_id, type);
  }

  /**
   * 群禁言
   * @param user_id 成员 QQ 号
   * @param duration 禁言时长 (秒), 0 为解除禁言
   */
  async setBan(user_id, duration = 30 * 60) {
    return this.bot.setGroupBan(this.group_id, user_id, duration);
  }

  /**
   * 群全员禁言
   * @param enable 是否开启
   */
  async setWholeBan(enable = true) {
    return this.bot.setGroupWholeBan(this.group_id, enable);
  }

  /**
   * 设置群管理
   * @param user_id 成员 QQ 号
   * @param enable 是否设置为管理员
   */
  async setAdmin(user_id, enable = true) {
    return this.bot.setGroupAdmin(this.group_id, user_id, enable);
  }

  /**
   * 群踢人
   * @param user_id 成员 QQ 号
   * @param reject_add_request 是否拒绝此人的加群请求
   */
  async kick(user_id, reject_add_request = false) {
    return this.bot.setGroupKick(this.group_id, user_id, reject_add_request);
  }

  /**
   * 设置群名
   * @param group_name 新群名
   */
  async setName(group_name) {
    return this.bot.setGroupName(this.group_id, group_name);
  }

  /**
   * 设置群成员名片
   * @param user_id 成员 QQ 号
   * @param card 新名片
   */
  async setCard(user_id, card) {
    return this.bot.setGroupCard(this.group_id, user_id, card);
  }

  /**
   * 设置群头衔
   * @param user_id 成员 QQ 号
   * @param special_title 头衔
   * @param duration 持有时间 (秒), -1 为永久
   */
  async setSpecialTitle(
    user_id,
    special_title,
    duration = -1
  ) {
    return this.bot.setGroupSpecialTitle(
      this.group_id,
      user_id,
      special_title,
      duration
    );
  }

  /**
   * 退出群组
   * @param is_dismiss 是否解散 (仅群主可用)
   */
  async leave(is_dismiss = false) {
    return this.bot.setGroupLeave(this.group_id, is_dismiss);
  }

  /**
   * 设置群头像
   * @param file 图片文件
   */
  async setPortrait(file) {
    return this.bot.setGroupPortrait(this.group_id, file);
  }

  /**
   * 获取群精华消息
   */
  async getEssence() {
    return this.bot.getGroupEssence(this.group_id);
  }

  /**
   * 发送群公告
   * @param content 公告内容
   * @param image 图片路径
   */
  async sendNotice(content, image) {
    return this.bot.sendGroupNotice(this.group_id, content, image);
  }

  /**
   * 获取群公告
   */
  async getNotice() {
    return this.bot.getGroupNotice(this.group_id);
  }

  /**
   * 删除群公告
   * @param notice_id 公告 ID
   */
  async deleteNotice(notice_id) {
    return this.bot.deleteGroupNotice(this.group_id, notice_id);
  }

  /**
   * 设置群搜索
   * @param is_search 是否允许搜索
   */
  async setSearch(is_search) {
    return this.bot.setGroupSearch(this.group_id, is_search);
  }

  /**
   * 获取群详细信息
   */
  async getInfoEx() {
    return this.bot.getGroupInfoEx(this.group_id);
  }

  /**
   * 设置群添加选项
   * @param option 添加选项 1: 允许任何人 2: 需要验证 3: 拒绝任何人 4: 需要回答问题 5: 需要回答问题并由管理员审核
   * @param question 问题 (option 为 4/5 时必填)
   * @param answer 答案 (option 为 4/5 时必填)
   */
  async setAddOption(option, question, answer) {
    return this.bot.setGroupAddOption(this.group_id, option, question, answer);
  }

  /**
   * 设置群机器人添加选项
   * @param option 1: 允许 2: 需要验证 3: 拒绝
   */
  async setBotAddOption(option) {
    return this.bot.setGroupBotAddOption(this.group_id, option);
  }

  /**
   * 设置群备注
   * @param remark 备注
   */
  async setRemark(remark) {
    return this.bot.setGroupRemark(this.group_id, remark);
  }

  /**
   * 获取群 @全体成员 剩余次数
   */
  async getAtAllRemain() {
    return this.bot.getGroupAtAllRemain(this.group_id);
  }

  /**
   * 获取群禁言列表
   */
  async getBanList() {
    return this.bot.getGroupBanList(this.group_id);
  }

  /**
   * 获取群过滤系统消息
   */
  async getIgnoredNotifies() {
    return this.bot.getGroupIgnoredNotifies(this.group_id);
  }

  /**
   * 群打卡
   */
  async sign() {
    return this.bot.sendGroupSign(this.group_id);
  }

  /**
   * 创建群文件文件夹
   * @param name 文件夹名称
   * @param parent_id 父文件夹 ID
   */
  async createFileFolder(name, parent_id = "/") {
    return this.bot.createGroupFileFolder(this.group_id, name, parent_id);
  }

  /**
   * 删除群文件
   * @param file_id 文件 ID
   * @param busid 文件类型
   */
  async deleteFile(file_id, busid) {
    return this.bot.deleteGroupFile(this.group_id, file_id, busid);
  }

  /**
   * 删除群文件夹
   * @param folder_id 文件夹 ID
   */
  async deleteFolder(folder_id) {
    return this.bot.deleteGroupFolder(this.group_id, folder_id);
  }

  /**
   * 获取群文件系统信息
   */
  async getFileSystemInfo() {
    return this.bot.getGroupFileSystemInfo(this.group_id);
  }

  /**
   * 获取群根目录文件列表
   */
  async getRootFiles() {
    return this.bot.getGroupRootFiles(this.group_id);
  }

  /**
   * 获取群子目录文件列表
   * @param folder_id 文件夹 ID
   */
  async getFilesByFolder(folder_id) {
    return this.bot.getGroupFilesByFolder(this.group_id, folder_id);
  }

  /**
   * 获取群文件链接
   * @param file_id 文件 ID
   * @param busid 文件类型
   */
  async getFileUrl(file_id, busid) {
    return this.bot.getGroupFileUrl(this.group_id, file_id, busid);
  }

  /**
   * 移动群文件
   * @param file_id 文件 ID
   * @param folder_id 目标文件夹 ID
   */
  async moveFile(file_id, folder_id) {
    return this.bot.setGroupFileMove(this.group_id, file_id, folder_id);
  }

  /**
   * 重命名群文件
   * @param file_id 文件 ID
   * @param name 新文件名
   */
  async renameFile(file_id, name) {
    return this.bot.renameGroupFile(this.group_id, file_id, name);
  }

  /**
   * 转存为永久文件
   * @param file_id 文件 ID
   */
  async setFileToPermanent(file_id) {
    return this.bot.setGroupFileToPermanent(this.group_id, file_id);
  }

  /**
   * 转发单条消息到群
   * @param message_id 消息 ID
   */
  async forwardSingleMsg(message_id) {
    return this.bot.forwardGroupSingleMsg(this.group_id, message_id);
  }

  /**
   * 删除群相册文件
   * @param album_id 相册 ID
   * @param photo_ids 图片 ID 列表
   */
  async deleteAlbumFile(album_id, photo_ids) {
    return this.bot.deleteGroupAlbumFile(this.group_id, album_id, photo_ids);
  }

  /**
   * 点赞群相册
   * @param album_id 相册 ID
   * @param photo_id 图片 ID
   */
  async albumLike(album_id, photo_id) {
    return this.bot.groupAlbumLike(this.group_id, album_id, photo_id);
  }

  /**
   * 查看群相册评论
   * @param album_id 相册 ID
   * @param photo_id 图片 ID
   */
  async getAlbumComments(album_id, photo_id) {
    return this.bot.getGroupAlbumComments(this.group_id, album_id, photo_id);
  }

  /**
   * 获取群相册列表
   * @param album_id 相册 ID
   */
  async getAlbumList(album_id) {
    return this.bot.getGroupAlbumList(this.group_id, album_id);
  }

  /**
   * 上传图片到群相册
   * @param album_id 相册 ID
   * @param file 图片文件
   * @param desc 描述
   */
  async uploadAlbumImage(album_id, album_name, file, desc) {
    return this.bot.uploadGroupAlbumImage(this.group_id, album_id,album_name, file, desc);
  }

  /**
   * 获取群相册总列表
   */
  async getAlbumMainList() {
    return this.bot.getGroupAlbumMainList(this.group_id);
  }

  /**
   * 设置群精华消息
   * @param message_id 消息 ID
   */
  async setEssence(message_id) {
    return this.bot.setGroupEssence(message_id);
  }

  /**
   * 删除群精华消息
   * @param message_id 消息 ID
   */
  async deleteEssence(message_id) {
    return this.bot.deleteGroupEssence(message_id);
  }

  /**
   * 设置群代办
   * @param content 代办内容
   */
  async setTodo(content) {
    return this.bot.setGroupTodo(this.group_id, content);
  }
}

export class OneBotApi {
  constructor(server, selfId) {
    this.server = server;
    this._selfId = selfId;
    this.nickname = "Bot";
    this.pendingRequests = new Map();
    
    if (!bot) {
        bot = this;
        if (typeof global !== 'undefined') global.bot = this;
    }
    bots.set(selfId, this);

    this.server.on("data", (data) => {
      if (data.echo && this.pendingRequests.has(data.echo)) {
        const resolve = this.pendingRequests.get(data.echo);
        if (resolve) {
          resolve(data);
          this.pendingRequests.delete(data.echo);
        }
      }
    });

    this.init();
  }

  async init() {
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const info = await this.getLoginInfo();
      if (info && info.nickname) {
        this.nickname = info.nickname;
      }
    } catch (e) {
    }
  }

  /**
   * 获取好友对象
   * @param user_id 好友 QQ 号
   */
  pickFriend(user_id) {
    return new Friend(this, user_id);
  }

  /**
   * 获取群对象
   * @param group_id 群号
   */
  pickGroup(group_id) {
    return new Group(this, group_id);
  }

  get self_id() {
    return this._selfId;
  }

  async sendRequest(action, params) {
    const echo = Date.now().toString() + Math.random().toString();
    const payload = {
      action,
      params,
      echo,
    };

    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (this.pendingRequests.has(echo)) {
            this.pendingRequests.delete(echo);
            reject(new Error(`Request ${action} timed out`));
          }
        }, 120000);

        this.pendingRequests.set(echo, (response) => {
          clearTimeout(timeout);
          if (
            response.status === "failed" ||
            (response.retcode !== undefined && response.retcode !== 0)
          ) {
            const errMsg = response.wording || "Request failed";
            reject(new Error(`Request ${action} failed: ${errMsg}`));
          } else {
            resolve(response.data);
          }
        });

        try {
          this.server.send(payload, this.self_id);
        } catch (e) {
          clearTimeout(timeout);
          this.pendingRequests.delete(echo);
          reject(new Error(`Failed to send request ${action}: ${e}`));
        }
      });
    } catch (e) {
      logger.error(e.message);
      return null;
    }
  }

  /**
   * 发送群聊消息
   * @param group_id 群号
   * @param message 消息内容
   */
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
    const prefix = bots.size > 1 ? `[${this.self_id}] ` : "";
    logger.info(`${prefix}发送 -> 群聊 ${group_id} ${msgLog}`);
    return this.sendRequest("send_group_msg", { group_id, message });
  }

  /**
   * 发送私聊消息
   * @param user_id 对方 QQ 号
   * @param message 消息内容
   */
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
    const prefix = bots.size > 1 ? `[${this.self_id}] ` : "";
    logger.info(`${prefix}发送 -> 私聊 ${user_id} ${msgLog}`);
    return this.sendRequest("send_private_msg", { user_id, message });
  }

  /**
   * 发送群图片
   * @param group_id 群号
   * @param file 图片文件 (URL/Base64/本地路径)
   */
  async sendGroupImage(group_id, file) {
    return this.sendGroupMsg(group_id, [Segment.image(file)]);
  }

  /**
   * 发送私聊图片
   * @param user_id 对方 QQ 号
   * @param file 图片文件 (URL/Base64/本地路径)
   */
  async sendPrivateImage(user_id, file) {
    return this.sendPrivateMsg(user_id, [Segment.image(file)]);
  }

  /**
   * 发送群语音
   * @param group_id 群号
   * @param file 语音文件
   */
  async sendGroupVoice(group_id, file) {
    return this.sendGroupMsg(group_id, [Segment.record(file)]);
  }

  /**
   * 发送私聊语音
   * @param user_id 对方 QQ 号
   * @param file 语音文件
   */
  async sendPrivateVoice(user_id, file) {
    return this.sendPrivateMsg(user_id, [Segment.record(file)]);
  }

  /**
   * 发送群视频
   * @param group_id 群号
   * @param file 视频文件
   */
  async sendGroupVideo(group_id, file) {
    return this.sendGroupMsg(group_id, [Segment.video(file)]);
  }

  /**
   * 发送私聊视频
   * @param user_id 对方 QQ 号
   * @param file 视频文件
   */
  async sendPrivateVideo(user_id, file) {
    return this.sendPrivateMsg(user_id, [Segment.video(file)]);
  }

  /**
   * 发送群文件
   * @param group_id 群号
   * @param file 文件路径
   * @param name 文件名
   */
  async uploadGroupFile(group_id, file, name) {
    return this.sendRequest("upload_group_file", { group_id, file, name });
  }

  /**
   * 发送私聊文件
   * @param user_id 对方 QQ 号
   * @param file 文件路径
   * @param name 文件名
   */
  async uploadPrivateFile(user_id, file, name) {
    return this.sendRequest("upload_private_file", { user_id, file, name });
  }

  /**
   * 发送戳一戳 (群)
   * @param group_id 群号
   * @param user_id 对方 QQ 号
   */
  async groupPoke(group_id, user_id) {
    return this.sendRequest("group_poke", { group_id, user_id });
  }

  /**
   * 发送戳一戳 (好友)
   * @param user_id 对方 QQ 号
   */
  async friendPoke(user_id) {
    return this.sendRequest("friend_poke", { user_id });
  }

  /**
   * 发送群音乐卡片
   * @param group_id 群号
   * @param type 音乐平台 (qq/163/xm)
   * @param id 音乐 ID
   */
  async sendGroupMusic(
    group_id,
    type,
    id
  ) {
    return this.sendGroupMsg(group_id, [Segment.music(type, id)]);
  }

  /**
   * 发送私聊音乐卡片
   * @param user_id 对方 QQ 号
   * @param type 音乐平台 (qq/163/xm)
   * @param id 音乐 ID
   */
  async sendPrivateMusic(
    user_id,
    type,
    id
  ) {
    return this.sendPrivateMsg(user_id, [Segment.music(type, id)]);
  }

  /**
   * 发送群骰子
   * @param group_id 群号
   */
  async sendGroupDice(group_id) {
    return this.sendGroupMsg(group_id, [Segment.dice()]);
  }

  /**
   * 发送私聊骰子
   * @param user_id 对方 QQ 号
   */
  async sendPrivateDice(user_id) {
    return this.sendPrivateMsg(user_id, [Segment.dice()]);
  }

  /**
   * 发送群猜拳
   * @param group_id 群号
   */
  async sendGroupRps(group_id) {
    return this.sendGroupMsg(group_id, [Segment.rps()]);
  }

  /**
   * 发送私聊猜拳
   * @param user_id 对方 QQ 号
   */
  async sendPrivateRps(user_id) {
    return this.sendPrivateMsg(user_id, [Segment.rps()]);
  }

  /**
   * 撤回消息
   * @param message_id 消息 ID
   */
  async deleteMsg(message_id) {
    return this.sendRequest("delete_msg", { message_id });
  }

  /**
   * 获取群历史消息
   * @param group_id 群号
   * @param message_seq 起始消息序号
   */
  async getGroupMsgHistory(group_id, message_seq) {
    return this.sendRequest("get_group_msg_history", { group_id, message_seq });
  }

  /**
   * 获取消息详情
   * @param message_id 消息 ID
   */
  async getMsg(message_id) {
    return this.sendRequest("get_msg", { message_id });
  }

  /**
   * 获取合并转发消息
   * @param id 合并转发 ID
   */
  async getForwardMsg(id) {
    return this.sendRequest("get_forward_msg", { id });
  }

  /**
   * 贴表情
   * @param message_id 消息 ID
   * @param emoji_id 表情 ID
   */
  async setMsgEmojiLike(message_id, emoji_id) {
    return this.sendRequest("set_msg_emoji_like", { message_id, emoji_id });
  }

  /**
   * 获取好友历史消息
   * @param user_id 好友 QQ 号
   * @param message_seq 起始消息序号
   */
  async getFriendMsgHistory(user_id, message_seq) {
    return this.sendRequest("get_friend_msg_history", { user_id, message_seq });
  }

  /**
   * 获取贴表情详情
   * @param message_id 消息 ID
   */
  async getMsgEmojiLike(message_id) {
    return this.sendRequest("get_msg_emoji_like", { message_id });
  }

  /**
   * 发送合并转发消息
   * @param messages 消息列表
   * @param group_id 群号 (可选)
   * @param user_id 用户号 (可选)
   */
  async sendForwardMsg(
    messages,
    group_id,
    user_id
  ) {
    if (!Array.isArray(messages)) {
      const params = { ...messages };
      if (group_id && !params.group_id) params.group_id = group_id;
      if (user_id && !params.user_id) params.user_id = user_id;
      return this.sendRequest("send_forward_msg", params);
    }
    return this.sendRequest("send_forward_msg", {
      messages,
      group_id,
      user_id,
    });
  }

  /**
   * 转发单条消息到群
   * @param group_id 群号
   * @param message_id 消息 ID
   */
  async forwardGroupSingleMsg(group_id, message_id) {
    return this.sendRequest("forward_group_single_msg", { group_id, message_id });
  }

  /**
   * 转发单条消息到私聊
   * @param user_id 对方 QQ 号
   * @param message_id 消息 ID
   */
  async forwardFriendSingleMsg(user_id, message_id) {
    return this.sendRequest("forward_friend_single_msg", { user_id, message_id });
  }

  /**
   * 获取语音消息详情
   * @param file 文件名
   * @param out_format 输出格式
   */
  async getRecord(file, out_format) {
    return this.sendRequest("get_record", { file, out_format });
  }

  /**
   * 获取图片消息详情
   * @param file 文件名
   */
  async getImage(file) {
    return this.sendRequest("get_image", { file });
  }

  /**
   * 发送群 AI 语音
   * @param group_id 群号
   * @param character 角色名
   * @param text 文本内容
   */
  async sendGroupAiRecord(group_id, character, text) {
    return this.sendRequest("send_group_ai_record", {
      group_id,
      character,
      text,
    });
  }

  /**
   * 设置账号信息
   * @param nickname 昵称
   * @param company 公司
   * @param email 邮箱
   * @param college 学校
   * @param personal_note 个人说明
   */
  async setQqProfile(
    nickname,
    company,
    email,
    college,
    personal_note
  ) {
    return this.sendRequest("set_qq_profile", {
      nickname,
      company,
      email,
      college,
      personal_note,
    });
  }

  /**
   * 获取被过滤好友请求
   */
  async getFriendSystemMsg() {
    return this.sendRequest("get_friend_system_msg", {});
  }

  /**
   * 处理好友请求
   * @param flag 请求 flag
   * @param approve 是否同意
   * @param remark 备注
   */
  async setFriendAddRequest(
    flag,
    approve = true,
    remark = ""
  ) {
    return this.sendRequest("set_friend_add_request", {
      flag,
      approve,
      remark,
    });
  }

  /**
   * 获取被过滤好友请求
   */
  async getFilteredFriendRequest() {
    return this.sendRequest("get_filtered_friend_request", {});
  }

  /**
   * 处理被过滤好友请求
   * @param flag 请求 flag
   * @param approve 是否同意
   * @param remark 备注
   */
  async handleFilteredFriendRequest(
    flag,
    approve = true,
    remark = ""
  ) {
    return this.sendRequest("handle_filtered_friend_request", {
      flag,
      approve,
      remark,
    });
  }

  /**
   * 获取群系统消息
   */
  async getGroupSystemMsg() {
    return this.sendRequest("get_group_system_msg", {});
  }

  /**
   * 获取当前账号在线客户端列表
   * @param no_cache 是否不使用缓存
   */
  async getOnlineClients(no_cache = false) {
    return this.sendRequest("get_online_clients", { no_cache });
  }

  /**
   * 设置消息已读
   * @param message_id 消息 ID
   */
  async setMsgRead(message_id) {
    return this.sendRequest("mark_msg_as_read", { message_id });
  }

  /**
   * 设置在线状态
   * @param status 在线状态
   * @param ext_status 扩展状态
   * @param battery 电量
   */
  async setOnlineStatus(status, ext_status, battery) {
    return this.sendRequest("set_online_status", {
      status,
      ext_status,
      battery,
    });
  }

  /**
   * 获取好友分组列表
   */
  async getFriendGroupList() {
    return this.sendRequest("get_friend_group_list", {});
  }

  /**
   * 设置头像
   * @param file 图片文件
   */
  async setAvatar(file) {
    return this.sendRequest("set_qq_avatar", { file });
  }

  /**
   * 点赞
   * @param user_id 对方 QQ 号
   * @param times 点赞次数
   */
  async sendLike(user_id, times = 1) {
    return this.sendRequest("send_like", { user_id, times });
  }

  /**
   * 设置私聊已读
   * @param user_id 对方 QQ 号
   */
  async setPrivateRead(user_id) {
    return this.sendRequest("mark_private_msg_as_read", { user_id });
  }

  /**
   * 设置群聊已读
   * @param group_id 群号
   */
  async setGroupRead(group_id) {
    return this.sendRequest("mark_group_msg_as_read", { group_id });
  }

  /**
   * 设置个性签名
   * @param signature 签名内容
   */
  async setSignature(signature) {
    return this.sendRequest("set_signature", { signature });
  }

  /**
   * 获取登录号信息
   */
  async getLoginInfo() {
    return this.sendRequest("get_login_info", {});
  }

  /**
   * 获取最近消息列表
   * @param count 获取数量
   */
  async getRecentContact(count = 10) {
    return this.sendRequest("get_recent_contact", { count });
  }

  /**
   * 获取账号信息 (陌生人信息)
   * @param user_id 对方 QQ 号
   * @param no_cache 是否不使用缓存
   */
  async getStrangerInfo(user_id, no_cache = false) {
    return this.sendRequest("get_stranger_info", { user_id, no_cache });
  }

  /**
   * 获取好友列表
   */
  async getFriendList() {
    return this.sendRequest("get_friend_list", {});
  }

  /**
   * 删除好友
   * @param user_id 好友 QQ 号
   */
  async deleteFriend(user_id) {
    return this.sendRequest("delete_friend", { user_id });
  }

  /**
   * 获取状态
   */
  async getStatus() {
    return this.sendRequest("get_status", {});
  }

  /**
   * 获取单向好友列表
   */
  async getUnidirectionalFriendList() {
    return this.sendRequest("get_unidirectional_friend_list", {});
  }

  /**
   * 设置好友备注
   * @param user_id 好友 QQ 号
   * @param remark 备注
   */
  async setFriendRemark(user_id, remark) {
    return this.sendRequest("set_friend_remark", { user_id, remark });
  }

  /**
   * 获取推荐好友/群聊卡片
   */
  async getRecommendClient() {
    return this.sendRequest("get_recommend_client", {});
  }

  /**
   * 获取推荐群聊卡片
   */
  async getRecommendGroupClient() {
    return this.sendRequest("get_recommend_group_client", {});
  }

  /**
   * 创建收藏
   * @param raw_data 原始内容
   */
  async setFavorite(raw_data) {
    return this.sendRequest("set_favorite", { raw_data });
  }

  /**
   * 设置所有消息已读
   */
  async setAllMsgRead() {
    return this.sendRequest("_mark_all_as_read", {});
  }

  /**
   * 获取点赞列表
   */
  async getLikeList() {
    return this.sendRequest("get_like_list", {});
  }

  /**
   * 获取收藏表情
   */
  async getFavoriteEmoticon() {
    return this.sendRequest("get_favorite_emoticon", {});
  }

  /**
   * 获取在线机型
   * @param model 机型
   */
  async getModelShow(model) {
    return this.sendRequest("_get_model_show", { model });
  }

  /**
   * 设置在线机型
   * @param model 机型
   * @param show 是否显示
   */
  async setModelShow(model, show) {
    return this.sendRequest("_set_model_show", { model, show });
  }

  /**
   * 获取用户状态
   * @param user_id 用户 QQ 号
   */
  async getUserStatus(user_id) {
    return this.sendRequest("get_user_status", { user_id });
  }

  /**
   * 获取小程序卡片
   * @param appid 小程序 AppID
   * @param template_id 模板 ID
   * @param content 内容
   */
  async getMiniAppArk(appid, template_id, content) {
    return this.sendRequest("get_mini_app_ark", {
      appid,
      template_id,
      content,
    });
  }

  /**
   * 设置自定义在线状态
   * @param status 状态
   * @param status_text 状态文本
   */
  async setCustomStatus(status, status_text) {
    return this.sendRequest("set_custom_status", { status, status_text });
  }


  /**
   * 获取群信息
   * @param group_id 群号
   * @param no_cache 是否不使用缓存
   */
  async getGroupInfo(group_id, no_cache = false) {
    return this.sendRequest("get_group_info", { group_id, no_cache });
  }

  /**
   * 获取群列表
   * @param no_cache 是否不使用缓存
   */
  async getGroupList(no_cache = false) {
    return this.sendRequest("get_group_list", { no_cache });
  }

  /**
   * 获取群成员信息
   * @param group_id 群号
   * @param user_id 成员 QQ 号
   * @param no_cache 是否不使用缓存
   */
  async getGroupMemberInfo(
    group_id,
    user_id,
    no_cache = false
  ) {
    return this.sendRequest("get_group_member_info", {
      group_id,
      user_id,
      no_cache,
    });
  }

  /**
   * 获取群成员列表
   * @param group_id 群号
   * @param no_cache 是否不使用缓存
   */
  async getGroupMemberList(group_id, no_cache = false) {
    return this.sendRequest("get_group_member_list", { group_id, no_cache });
  }

  /**
   * 获取群荣誉信息
   * @param group_id 群号
   * @param type 荣誉类型
   */
  async getGroupHonorInfo(group_id, type) {
    return this.sendRequest("get_group_honor_info", { group_id, type });
  }

  /**
   * 群禁言
   * @param group_id 群号
   * @param user_id 成员 QQ 号
   * @param duration 禁言时长 (秒), 0 为解除禁言
   */
  async setGroupBan(
    group_id,
    user_id,
    duration = 30 * 60
  ) {
    return this.sendRequest("set_group_ban", { group_id, user_id, duration });
  }

  /**
   * 群全员禁言
   * @param group_id 群号
   * @param enable 是否开启
   */
  async setGroupWholeBan(group_id, enable = true) {
    return this.sendRequest("set_group_whole_ban", { group_id, enable });
  }

  /**
   * 设置群管理
   * @param group_id 群号
   * @param user_id 成员 QQ 号
   * @param enable 是否设置为管理员
   */
  async setGroupAdmin(
    group_id,
    user_id,
    enable = true
  ) {
    return this.sendRequest("set_group_admin", { group_id, user_id, enable });
  }

  /**
   * 群踢人
   * @param group_id 群号
   * @param user_id 成员 QQ 号
   * @param reject_add_request 是否拒绝此人的加群请求
   */
  async setGroupKick(
    group_id,
    user_id,
    reject_add_request = false
  ) {
    return this.sendRequest("set_group_kick", {
      group_id,
      user_id,
      reject_add_request,
    });
  }

  /**
   * 设置群名
   * @param group_id 群号
   * @param group_name 新群名
   */
  async setGroupName(group_id, group_name) {
    return this.sendRequest("set_group_name", { group_id, group_name });
  }

  /**
   * 设置群成员名片
   * @param group_id 群号
   * @param user_id 成员 QQ 号
   * @param card 新名片
   */
  async setGroupCard(group_id, user_id, card) {
    return this.sendRequest("set_group_card", { group_id, user_id, card });
  }

  /**
   * 设置群头衔
   * @param group_id 群号
   * @param user_id 成员 QQ 号
   * @param special_title 头衔
   * @param duration 持有时间 (秒), -1 为永久
   */
  async setGroupSpecialTitle(
    group_id,
    user_id,
    special_title,
    duration = -1
  ) {
    return this.sendRequest("set_group_special_title", {
      group_id,
      user_id,
      special_title,
      duration,
    });
  }

  /**
   * 退出群组
   * @param group_id 群号
   * @param is_dismiss 是否解散 (仅群主可用)
   */
  async setGroupLeave(group_id, is_dismiss = false) {
    return this.sendRequest("set_group_leave", { group_id, is_dismiss });
  }

  /**
   * 处理加群请求
   * @param flag 请求 flag
   * @param sub_type 请求类型 (add/invite)
   * @param approve 是否同意
   * @param reason 拒绝理由
   */
  async setGroupAddRequest(
    flag,
    sub_type,
    approve = true,
    reason = ""
  ) {
    return this.sendRequest("set_group_add_request", {
      flag,
      sub_type,
      approve,
      reason,
    });
  }

  /**
   * 设置群头像
   * @param group_id 群号
   * @param file 图片文件
   */
  async setGroupPortrait(group_id, file) {
    return this.sendRequest("set_group_portrait", { group_id, file });
  }

  /**
   * 获取群精华消息
   * @param group_id 群号
   */
  async getGroupEssence(group_id) {
    return this.sendRequest("get_group_essence", { group_id });
  }

  /**
   * 设置群精华消息
   * @param message_id 消息 ID
   */
  async setGroupEssence(message_id) {
    return this.sendRequest("set_group_essence", { message_id });
  }

  /**
   * 删除群精华消息
   * @param message_id 消息 ID
   */
  async deleteGroupEssence(message_id) {
    return this.sendRequest("delete_group_essence", { message_id });
  }

  /**
   * 发送群公告
   * @param group_id 群号
   * @param content 公告内容
   * @param image 图片路径
   */
  async sendGroupNotice(group_id, content, image) {
    const params = { group_id, content };
    if (image) params.image = image;
    return this.sendRequest("_send_group_notice", params);
  }

  /**
   * 获取群公告
   * @param group_id 群号
   */
  async getGroupNotice(group_id) {
    return this.sendRequest("_get_group_notice", { group_id });
  }

  /**
   * 删除群公告
   * @param group_id 群号
   * @param notice_id 公告 ID
   */
  async deleteGroupNotice(group_id, notice_id) {
    return this.sendRequest("_delete_group_notice", { group_id, notice_id });
  }

  /**
   * 设置群搜索
   * @param group_id 群号
   * @param is_search 是否允许搜索
   */
  async setGroupSearch(group_id, is_search) {
    return this.sendRequest("set_group_search", { group_id, is_search });
  }

  /**
   * 获取群详细信息
   * @param group_id 群号
   */
  async getGroupInfoEx(group_id) {
    return this.sendRequest("get_group_info_ex", { group_id });
  }

  /**
   * 设置群添加选项
   * @param group_id 群号
   * @param option 添加选项 1: 允许任何人 2: 需要验证 3: 拒绝任何人 4: 需要回答问题 5: 需要回答问题并由管理员审核
   * @param question 问题 (option 为 4/5 时必填)
   * @param answer 答案 (option 为 4/5 时必填)
   */
  async setGroupAddOption(
    group_id,
    option,
    question,
    answer
  ) {
    return this.sendRequest("set_group_add_option", {
      group_id,
      option,
      question,
      answer,
    });
  }

  /**
   * 设置群机器人添加选项
   * @param group_id 群号
   * @param option 1: 允许 2: 需要验证 3: 拒绝
   */
  async setGroupBotAddOption(group_id, option) {
    return this.sendRequest("set_group_bot_add_option", { group_id, option });
  }

  /**
   * 设置群备注
   * @param group_id 群号
   * @param remark 备注
   */
  async setGroupRemark(group_id, remark) {
    return this.sendRequest("set_group_remark", { group_id, remark });
  }

  /**
   * 获取群 @全体成员 剩余次数
   * @param group_id 群号
   */
  async getGroupAtAllRemain(group_id) {
    return this.sendRequest("get_group_at_all_remain", { group_id });
  }

  /**
   * 获取群禁言列表
   * @param group_id 群号
   */
  async getGroupBanList(group_id) {
    return this.sendRequest("get_group_shut_list", { group_id });
  }

  /**
   * 获取群过滤系统消息
   * @param group_id 群号
   */
  async getGroupIgnoredNotifies(group_id) {
    return this.sendRequest("get_group_ignored_notifies", { group_id });
  }

  /**
   * 群打卡
   * @param group_id 群号
   */
  async sendGroupSign(group_id) {
    return this.sendRequest("send_group_sign", { group_id });
  }

  /**
   * 设置群代办
   * @param group_id 群号
   * @param content 代办内容
   */
  async setGroupTodo(group_id, content) {
    return this.sendRequest("set_group_todo", { group_id, content });
  }


  /**
   * 获取文件信息
   * @param file 文件名
   */
  async getFile(file) {
    return this.sendRequest("get_file", { file });
  }

  /**
   * 创建群文件文件夹
   * @param group_id 群号
   * @param name 文件夹名称
   * @param parent_id 父文件夹 ID
   */
  async createGroupFileFolder(
    group_id,
    name,
    parent_id = "/"
  ) {
    return this.sendRequest("create_group_file_folder", {
      group_id,
      name,
      parent_id,
    });
  }

  /**
   * 删除群文件
   * @param group_id 群号
   * @param file_id 文件 ID
   * @param busid 文件类型
   */
  async deleteGroupFile(group_id, file_id, busid) {
    return this.sendRequest("delete_group_file", { group_id, file_id, busid });
  }

  /**
   * 删除群文件夹
   * @param group_id 群号
   * @param folder_id 文件夹 ID
   */
  async deleteGroupFolder(group_id, folder_id) {
    return this.sendRequest("delete_group_folder", { group_id, folder_id });
  }

  /**
   * 获取群文件系统信息
   * @param group_id 群号
   */
  async getGroupFileSystemInfo(group_id) {
    return this.sendRequest("get_group_file_system_info", { group_id });
  }

  /**
   * 获取群根目录文件列表
   * @param group_id 群号
   */
  async getGroupRootFiles(group_id) {
    return this.sendRequest("get_group_root_files", { group_id });
  }

  /**
   * 获取群子目录文件列表
   * @param group_id 群号
   * @param folder_id 文件夹 ID
   */
  async getGroupFilesByFolder(group_id, folder_id) {
    return this.sendRequest("get_group_files_by_folder", {
      group_id,
      folder_id,
    });
  }

  /**
   * 获取群文件链接
   * @param group_id 群号
   * @param file_id 文件 ID
   * @param busid 文件类型
   */
  async getGroupFileUrl(group_id, file_id, busid) {
    return this.sendRequest("get_group_file_url", { group_id, file_id, busid });
  }

  /**
   * 获取私聊文件链接
   * @param user_id 对方 QQ 号
   * @param file_id 文件 ID
   */
  async getPrivateFileUrl(user_id, file_id) {
    return this.sendRequest("get_private_file_url", { user_id, file_id });
  }

  /**
   * 下载文件到缓存目录
   * @param url 文件 URL
   * @param thread_count 线程数
   * @param headers 请求头
   */
  async downloadFile(url, thread_count = 1, headers = {}) {
    return this.sendRequest("download_file", { url, thread_count, headers });
  }

  /**
   * 清空缓存
   */
  async cleanCache() {
    return this.sendRequest("clean_cache", {});
  }

  /**
   * 移动群文件
   * @param group_id 群号
   * @param file_id 文件 ID
   * @param folder_id 目标文件夹 ID
   */
  async setGroupFileMove(group_id, file_id, folder_id) {
    return this.sendRequest("set_group_file_move", {
      group_id,
      file_id,
      folder_id,
    });
  }

  /**
   * 重命名群文件
   * @param group_id 群号
   * @param file_id 文件 ID
   * @param name 新文件名
   */
  async renameGroupFile(group_id, file_id, name) {
    return this.sendRequest("set_group_file_rename", {
      group_id,
      file_id,
      name,
    });
  }

  /**
   * 转存为永久文件
   * @param group_id 群号
   * @param file_id 文件 ID
   */
  async setGroupFileToPermanent(group_id, file_id) {
    return this.sendRequest("set_group_file_to_permanent", {
      group_id,
      file_id,
    });
  }

  /**
   * 删除群相册文件
   * @param group_id 群号
   * @param album_id 相册 ID
   * @param photo_ids 图片 ID 列表
   */
  async deleteGroupAlbumFile(group_id, album_id, photo_ids) {
    return this.sendRequest("delete_group_album_file", { group_id, album_id, photo_ids });
  }

  /**
   * 点赞群相册
   * @param group_id 群号
   * @param album_id 相册 ID
   * @param photo_id 图片 ID
   */
  async groupAlbumLike(group_id, album_id, photo_id) {
    return this.sendRequest("group_album_like", { group_id, album_id, photo_id });
  }

  /**
   * 查看群相册评论
   * @param group_id 群号
   * @param album_id 相册 ID
   * @param photo_id 图片 ID
   */
  async getGroupAlbumComments(group_id, album_id, photo_id) {
    return this.sendRequest("get_group_album_comments", { group_id, album_id, photo_id });
  }

  /**
   * 获取群相册列表
   * @param group_id 群号
   * @param album_id 相册 ID
   */
  async getGroupAlbumList(group_id, album_id) {
    return this.sendRequest("get_group_album_media_list", { group_id, album_id });
  }

  /**
   * 上传图片到群相册
   * @param group_id 群号
   * @param album_id 相册 ID
   * @param file 图片文件
   * @param desc 描述
   */
  async uploadGroupAlbumImage(group_id, album_id,album_name, file, desc) {
    return this.sendRequest("upload_image_to_qun_album", { group_id, album_id,album_name, file, desc });
  }

  /**
   * 获取群相册总列表
   * @param group_id 群号
   */
  async getGroupAlbumMainList(group_id) {
    return this.sendRequest("get_qun_album_list", { group_id });
  }
}
