import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { EventEmitter } from "events";

// =================== OneBot v11 → Milky API 名称映射 ===================
const ACTION_MAP = {
  // 消息
  send_group_msg:          "send_group_message",
  send_private_msg:        "send_private_message",
  get_msg:                 "__get_msg",          // 需要上下文，特殊处理
  delete_msg:              "__recall_msg",        // 特殊处理
  send_forward_msg:        "__send_forward",      // 特殊处理
  get_group_msg_history:   "get_history_messages",
  get_friend_msg_history:  "get_history_messages",
  get_forward_msg:         "get_forwarded_messages",
  get_forwarded_messages:  "get_forwarded_messages",
  mark_private_msg_as_read:"mark_message_as_read",
  mark_group_msg_as_read:  "mark_message_as_read",
  get_resource_temp_url:   "get_resource_temp_url",

  // 系统
  get_login_info:          "get_login_info",
  get_stranger_info:       "get_user_profile",
  get_friend_list:         "get_friend_list",
  get_friend_info:         "get_friend_info",
  get_group_list:          "get_group_list",
  get_group_info:          "get_group_info",
  get_group_member_list:   "get_group_member_list",
  get_group_member_info:   "get_group_member_info",

  // 好友
  send_like:               "send_profile_like",
  friend_poke:             "send_friend_nudge",
  delete_friend:           "delete_friend",
  set_friend_add_request:  "__friend_request",   // 特殊处理

  // 群聊
  set_group_name:          "set_group_name",
  set_group_card:          "set_group_member_card",
  set_group_special_title: "set_group_member_special_title",
  set_group_admin:         "set_group_member_admin",
  set_group_ban:           "set_group_member_mute",
  set_group_whole_ban:     "set_group_whole_mute",
  set_group_kick:          "kick_group_member",
  set_group_leave:         "quit_group",
  group_poke:              "send_group_nudge",
  set_group_add_request:   "__group_request",    // 特殊处理

  // 表情回应
  set_msg_emoji_like:      "send_group_message_reaction",

  // 精华消息
  set_essence_msg:         "__essence_set",      // is_set: true
  delete_essence_msg:      "__essence_delete",   // is_set: false
  get_essence_msg_list:    "get_group_essence_messages",

  // 群公告
  _send_group_notice:      "send_group_announcement",
  _get_group_notice:       "get_group_announcements",
  del_group_notice:        "delete_group_announcement",

  // 文件
  upload_group_file:       "upload_group_file",
  upload_private_file:     "upload_private_file",
  get_group_file_url:      "get_group_file_download_url",
  get_group_root_files:    "get_group_files",
  get_group_files_by_folder:"get_group_files",
  move_group_file:         "move_group_file",
  rename_group_file:       "rename_group_file",
  delete_group_file:       "delete_group_file",
  create_group_file_folder:"create_group_folder",
  rename_group_folder:     "rename_group_folder",
  delete_group_folder:     "delete_group_folder",

  // 头像/信息
  set_avatar:              "set_avatar",
  set_nickname:            "set_nickname",
};

function detectMilkyReactionType(reactionId, explicitType) {
  if (explicitType === "face" || explicitType === "emoji") {
    return explicitType;
  }

  const normalizedId = String(reactionId ?? "").trim();
  if (/^\d{6}$/.test(normalizedId)) {
    return "emoji";
  }

  return "face";
}

function normalizeIncomingImageSubType(subType) {
  if (subType === "sticker" || subType === 1 || subType === "1") {
    return 1;
  }

  if (
    subType === "normal" ||
    subType === 0 ||
    subType === "0" ||
    subType === undefined ||
    subType === null
  ) {
    return 0;
  }

  return subType;
}


// =================== 消息段转换 ===================

/** Milky 接收段 → OneBot v11 段 */
function milkySegToOB(seg) {
  const d = seg.data || {};
  switch (seg.type) {
    case "text":
      return { type: "text", data: { text: d.text || "" } };
    case "mention":
      return { type: "at", data: { qq: String(d.user_id) } };
    case "mention_all":
      return { type: "at", data: { qq: "all" } };
    case "reply":
      return { type: "reply", data: { id: String(d.message_seq) } };
    case "image":
      return {
        type: "image",
        data: {
          file: d.temp_url || d.resource_id,
          url: d.temp_url,
          sub_type: normalizeIncomingImageSubType(d.sub_type),
          raw_sub_type: d.sub_type,
        },
      };
    case "record":
      return { type: "record", data: { file: d.temp_url || d.resource_id, url: d.temp_url } };
    case "video":
      return { type: "video", data: { file: d.temp_url || d.resource_id, url: d.temp_url } };
    case "face":
      return { type: "face", data: { id: Number(d.face_id) } };
    case "file":
      return {
        type: "file",
        data: {
          file_id: d.file_id,
          name:
            d.file_name ||
            d.name ||
            d.filename ||
            d.fileName ||
            d?.file?.file_name ||
            "",
          size: d.file_size ?? d.size ?? d?.file?.file_size ?? 0,
        },
      };
    case "forward":
      return { type: "forward", data: { id: d.forward_id } };
    case "light_app":
      return { type: "json", data: { data: d.json_payload } };
    case "xml":
      return { type: "xml", data: { data: d.xml_payload } };
    case "market_face":
      return { type: "mface", data: { ...d } };
    default:
      return { type: seg.type, data: { ...d } };
  }
}

/** OneBot v11 发送段 → Milky 段 */
function toMilkyUri(uri) {
  if (typeof uri !== "string" || !uri) return "";
  if (uri.startsWith("base64://") || uri.startsWith("file://") || /^https?:\/\//i.test(uri)) {
    return uri;
  }
  return pathToFileURL(path.resolve(uri)).href;
}

function normalizeImageSubType(subType) {
  if (subType === "sticker" || subType === 1 || subType === "1") {
    return "sticker";
  }
  return "normal";
}

function obSegToMilky(seg) {
  const d = seg.data || {};
  switch (seg.type) {
    case "text":
      return { type: "text", data: { text: d.text || "" } };
    case "at":
      if (String(d.qq) === "all") return { type: "mention_all", data: {} };
      return { type: "mention", data: { user_id: Number(d.qq) } };
    case "reply":
      return { type: "reply", data: { message_seq: Number(d.id) } };
    case "image": {
      return {
        type: "image",
        data: {
          uri: toMilkyUri(d.file || d.url || ""),
          sub_type: normalizeImageSubType(d.sub_type),
          summary: d.summary,
        },
      };
    }
    case "record":
      return { type: "record", data: { uri: d.file || d.url } };
    case "video":
      return { type: "video", data: { uri: d.file || d.url } };
    case "face":
      return { type: "face", data: { face_id: String(d.id), is_large: false } };
    case "json":
      return { type: "light_app", data: { json_payload: d.data } };
    default:
      // 透传未知类型
      return seg;
  }
}

function convertToMilky(message) {
  if (!message) return [];
  if (typeof message === "string") return [{ type: "text", data: { text: message } }];
  if (!Array.isArray(message)) return [obSegToMilky(message)];
  return message.map(obSegToMilky).filter(Boolean);
}

function convertFromMilky(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.map(milkySegToOB);
}

/** 从 OneBot v11 格式的 message 数组生成 raw_message 文本 */
function buildRawMessage(obMessage) {
  if (!Array.isArray(obMessage)) return "";
  return obMessage.map(seg => {
    switch (seg.type) {
      case "text":   return seg.data?.text || "";
      case "at":     return `[CQ:at,qq=${seg.data?.qq}]`;
      case "reply":  return `[CQ:reply,id=${seg.data?.id}]`;
      case "image":  return "[CQ:image]";
      case "record": return "[CQ:record]";
      case "video":  return "[CQ:video]";
      case "face":   return `[CQ:face,id=${seg.data?.id}]`;
      case "forward":return "[CQ:forward]";
      default:       return `[CQ:${seg.type}]`;
    }
  }).join("");
}

// =================== 事件翻译 ===================

/** 将 Milky IncomingMessage 转为 OneBot v11 message 事件结构 */
function translateIncomingMessage(msg, selfId, time) {
  const isGroup = msg.message_scene === "group";
  const isTemp  = msg.message_scene === "temp";
  const obMessage = convertFromMilky(msg.segments);
  const ob = {
    self_id:    selfId,
    time:       msg.time ?? time ?? Math.floor(Date.now() / 1000),
    post_type:  "message",
    message_type: isGroup ? "group" : "private",
    sub_type:   isTemp ? "group" : "friend",
    message_id: String(msg.message_seq),
    message_seq: msg.message_seq,
    seq:        msg.message_seq,
    user_id:    msg.sender_id,
    message:    obMessage,
    raw_message: buildRawMessage(obMessage),
    font: 0,
  };
  if (isGroup) {
    ob.group_id = msg.peer_id;
    ob.group_name = msg.group?.group_name || "";
    ob.sender = {
      user_id:  msg.sender_id,
      nickname: msg.group_member?.nickname || "",
      card:     msg.group_member?.card || "",
      role:     msg.group_member?.role || "member",
      title:    msg.group_member?.special_title || "",
      level:    String(msg.group_member?.level || 0),
    };
  } else {
    ob.sender = {
      user_id:  msg.sender_id,
      nickname: msg.friend?.nickname || "",
      remark:   msg.friend?.remark || "",
    };
  }
  return ob;
}

function translateForwardedMessage(msg) {
  const obMessage = convertFromMilky(msg?.segments);
  const seq = msg?.message_seq;
  const senderName = msg?.sender_name || "";

  return {
    time: msg?.time ?? Math.floor(Date.now() / 1000),
    message_id: seq !== undefined ? String(seq) : "",
    message_seq: seq,
    seq,
    user_id: 0,
    nickname: senderName,
    avatar: msg?.avatar_url || "",
    sender: {
      user_id: 0,
      nickname: senderName,
      card: senderName,
    },
    message: obMessage,
    raw_message: buildRawMessage(obMessage),
  };
}

/** Milky 事件 → OneBot v11 事件格式 */
function translateEvent(milkyEvent, selfId) {
  const { event_type, time, self_id, data = {} } = milkyEvent;
  const sid  = self_id ?? selfId;
  const base = { self_id: sid, time };

  switch (event_type) {
    // ---- 消息 ----
    case "message_receive":
      return translateIncomingMessage({ ...data, time }, sid, time);

    // ---- 消息撤回 ----
    case "message_recall": {
      const isGroup = data.message_scene === "group";
      return {
        ...base,
        post_type:    "notice",
        notice_type:  isGroup ? "group_recall" : "friend_recall",
        group_id:     isGroup ? data.peer_id : undefined,
        user_id:      data.sender_id,
        operator_id:  data.operator_id,
        message_id:   String(data.message_seq),
      };
    }

    // ---- 好友请求 ----
    case "friend_request":
      return {
        ...base,
        post_type:    "request",
        request_type: "friend",
        user_id:      data.initiator_id,
        comment:      data.comment || "",
        flag:         data.initiator_uid, // uid 作为 flag
      };

    // ---- 加群请求 ----
    case "group_join_request":
      return {
        ...base,
        post_type:    "request",
        request_type: "group",
        sub_type:     "add",
        group_id:     data.group_id,
        user_id:      data.initiator_id,
        // flag 编码为 "group_id:notification_seq:type"，accept/reject 时解包
        flag:         `${data.group_id}:${data.notification_seq}:add:${data.is_filtered ? 1 : 0}`,
      };
    case "group_invited_join_request":
      return {
        ...base,
        post_type:    "request",
        request_type: "group",
        sub_type:     "add",
        group_id:     data.group_id,
        user_id:      data.target_user_id,
        flag:         `${data.group_id}:${data.notification_seq ?? 0}:invite:0`,
      };
    case "group_invitation":
      return {
        ...base,
        post_type:    "request",
        request_type: "group",
        sub_type:     "invite",
        group_id:     data.group_id,
        user_id:      data.initiator_id,
        flag:         `${data.group_id}:${data.invitation_seq}:invitation:0`,
      };

    // ---- 群成员变动 ----
    case "group_member_increase":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "group_increase",
        sub_type:    data.invitor_id ? "invite" : "approve",
        group_id:    data.group_id,
        user_id:     data.user_id,
        operator_id: data.operator_id || data.invitor_id || 0,
      };
    case "group_member_decrease":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "group_decrease",
        sub_type:    data.operator_id ? "kick" : "leave",
        group_id:    data.group_id,
        user_id:     data.user_id,
        operator_id: data.operator_id || 0,
      };

    // ---- 群管理员变动 ----
    case "group_admin_change":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "group_admin",
        sub_type:    data.is_set ? "set" : "unset",
        group_id:    data.group_id,
        user_id:     data.user_id,
      };

    // ---- 群禁言 ----
    case "group_mute":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "group_ban",
        sub_type:    data.duration > 0 ? "ban" : "lift_ban",
        group_id:    data.group_id,
        user_id:     data.user_id,
        operator_id: data.operator_id,
        duration:    data.duration,
      };
    case "group_whole_mute":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "group_ban",
        sub_type:    data.is_mute ? "ban" : "lift_ban",
        group_id:    data.group_id,
        user_id:     0,
        operator_id: data.operator_id,
      };

    // ---- 戳一戳 ----
    case "friend_nudge":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "notify",
        sub_type:    "poke",
        user_id:     data.user_id,
        target_id:   data.is_self_send ? data.user_id : sid,
        sender_id:   data.user_id,
      };
    case "group_nudge":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "notify",
        sub_type:    "poke",
        group_id:    data.group_id,
        user_id:     data.sender_id,
        target_id:   data.receiver_id,
        sender_id:   data.sender_id,
      };

    // ---- 精华消息 ----
    case "group_essence_message_change":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "essence",
        sub_type:    data.is_set ? "add" : "delete",
        group_id:    data.group_id,
        message_id:  String(data.message_seq),
        operator_id: data.operator_id,
      };

    // ---- 群名变更 ----
    case "group_name_change":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "group_name_change",
        group_id:    data.group_id,
        group_name:  data.new_group_name,
        operator_id: data.operator_id,
      };

    // ---- 表情回应 ----
    case "group_message_reaction":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "group_msg_emoji_like",
        group_id:    data.group_id,
        user_id:     data.user_id,
        message_id:  String(data.message_seq),
        emoji_id:    String(data.face_id),
        face_id:     data.face_id,
        likes:       [{ emoji_id: String(data.face_id), is_add: data.is_add }],
        is_add:      data.is_add,
      };

    // ---- 文件上传 ----
    case "friend_file_upload":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "offline_file",
        user_id:     data.user_id,
        file:        { id: data.file_id, name: data.file_name, size: data.file_size },
      };
    case "group_file_upload":
      return {
        ...base,
        post_type:   "notice",
        notice_type: "group_upload",
        group_id:    data.group_id,
        user_id:     data.user_id,
        file:        { id: data.file_id, name: data.file_name, size: data.file_size },
      };

    // ---- Bot 下线 ----
    case "bot_offline":
      return {
        ...base,
        post_type:        "meta_event",
        meta_event_type:  "lifecycle",
        sub_type:         "disable",
      };

    default:
      // 透传未知事件
      return { ...base, post_type: "notice", notice_type: event_type, ...data };
  }
}

// =================== MilkyClient ===================

/**
 * Milky 协议适配器
 *
 * 与 OneBotWsClient 接口一致（EventEmitter + send() + connect() + disconnect()）
 * 内部用 HTTP POST 调 API，WebSocket 连 /event 接收事件
 * 自动将 Milky 格式 ↔ OneBot v11 格式互转，插件无需修改
 *
 * config 字段:
 *   url               Milky HTTP 基础地址，如 http://127.0.0.1:3000
 *   accessToken       访问令牌
 *   reconnectDelay    WS 重连间隔(ms)，0=不重连
 *   heartbeatInterval 心跳 ping 间隔(ms)，0=不发送
 */
export class MilkyClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this._ws = null;
    this._selfId = null;
    this._reconnectTimer = null;
    this._reconnectCount = 0;
    this._heartbeatTimer = null;
    this._disconnecting = false;
    // 消息上下文缓存: String(message_seq) → { scene, peer_id }
    // 用于 delete_msg / get_msg 时还原完整请求参数
    this._msgContext = new Map();

    // Proxy：将 client.snake_case_method(params) 自动路由到 send()
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        if (typeof prop !== "string") return undefined;
        if (/^[a-z_][a-z_0-9]*$/.test(prop)) {
          return (params) => target.send(prop, params);
        }
        return undefined;
      },
    });
  }

  // =================== URL 工具 ===================

  get _httpBase() {
    return (this.config.url || "http://127.0.0.1:3000").replace(/\/$/, "");
  }

  get _wsEventUrl() {
    const base = this._httpBase.replace(/^http/, "ws") + "/event";
    // 同时通过 query 参数传递 access_token，兼容不支持 Authorization 头的协议端实现
    if (this.config.accessToken) {
      return `${base}?access_token=${encodeURIComponent(this.config.accessToken)}`;
    }
    return base;
  }

  // =================== 公共接口 ===================

  async connect() {
    await this._connectWs();
  }

  disconnect() {
    this._disconnecting = true;
    this._stopHeartbeat();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close(1000, "disconnect");
      this._ws = null;
    }
  }

  /**
   * 发送 OneBot v11 风格的 API 请求
   * 自动转换为 Milky HTTP 调用，参数和响应双向翻译
   */
  async send(action, params = {}) {
    // 特殊动作
    switch (action) {
      case "__recall_msg":
      case "delete_msg":
        return this._handleRecall(params);
      case "__get_msg":
      case "get_msg":
        return this._handleGetMsg(params);
      case "get_group_msg_history":
      case "get_friend_msg_history":
        return this._handleHistoryMessages(action, params);
      case "__friend_request":
      case "set_friend_add_request":
        return this._handleFriendRequest(params);
      case "__group_request":
      case "set_group_add_request":
        return this._handleGroupRequest(params);
      case "__essence_set":
      case "set_essence_msg":
        return this._httpPost("set_group_essence_message", { ...params, is_set: true });
      case "__essence_delete":
      case "delete_essence_msg":
        return this._httpPost("set_group_essence_message", { ...params, is_set: false });
      case "__send_forward":
      case "send_forward_msg":
        return this._handleForward(params);
    }

    const milkyAction = ACTION_MAP[action] || action;
    const milkyParams = this._transformParams(action, params);
    const result = await this._httpPost(milkyAction, milkyParams);
    return this._transformResponse(action, result, params);
  }

  // =================== HTTP 请求 ===================

  async _httpPost(action, params = {}) {
    const url = `${this._httpBase}/api/${action}`;
    const headers = { "Content-Type": "application/json" };
    if (this.config.accessToken) {
      headers["Authorization"] = `Bearer ${this.config.accessToken}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(params ?? {}),
    });

    if (res.status === 401) throw new Error("Milky: 认证失败，请检查 accessToken");
    if (res.status === 404) {
      // 接口不存在时仅打印警告，不抛异常，避免中断插件后续逻辑
      const { logger } = await import("../utils/logger.js");
      logger.warn(`[Milky] 接口不存在: ${action}，已跳过`);
      return null;
    }

    const json = await res.json();
    if (json.retcode !== 0) {
      if (
        action === "send_group_message_reaction" &&
        /已经设置过该表情|已设置过该表情/.test(json.message || "")
      ) {
        const { logger } = await import("../utils/logger.js");
        logger.warn(`[Milky] 表情回应已存在，已忽略: ${json.message}`);
        return {
          duplicated: true,
          message: json.message,
        };
      }
      throw new Error(json.message || `Milky API 错误 retcode=${json.retcode} action=${action}`);
    }
    return json.data ?? null;
  }

  // =================== 参数转换 ===================

  _transformParams(action, rawParams) {
    let params = rawParams;
    if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
      params = { ...rawParams };
      const numberFields = [
        'group_id',
        'user_id',
        'message_id',
        'message_seq',
        'peer_id',
        'operator_id',
        'count',
        'limit',
        'start_message_seq',
      ];
      for (const key of numberFields) {
        if (typeof params[key] === 'string' && /^-?\d+$/.test(params[key])) {
          params[key] = Number(params[key]);
        }
      }
    }

    switch (action) {
      case "send_group_msg":
        return {
          group_id:      params.group_id,
          message:       convertToMilky(params.message),
        };

      case "send_private_msg":
        return {
          user_id:       params.user_id,
          message:       convertToMilky(params.message),
        };

      case "get_group_msg_history": {
        const historyParams = {
          message_scene: "group",
          peer_id:       params.group_id,
          group_id:      params.group_id,
        };
        if (Number.isFinite(params.message_seq) && params.message_seq > 0) {
          historyParams.start_message_seq = params.message_seq;
        }
        if (Number.isFinite(params.count) && params.count > 0) {
          historyParams.limit = Math.min(params.count, 30);
        }
        return historyParams;
      }

      case "get_friend_msg_history": {
        const historyParams = {
          message_scene: "friend",
          peer_id:       params.user_id,
          user_id:       params.user_id,
        };
        if (Number.isFinite(params.message_seq) && params.message_seq > 0) {
          historyParams.start_message_seq = params.message_seq;
        }
        if (Number.isFinite(params.count) && params.count > 0) {
          historyParams.limit = Math.min(params.count, 30);
        }
        return historyParams;
      }

      case "get_forward_msg":
      case "get_forwarded_messages":
        return {
          forward_id: String(
            params.forward_id ?? params.id ?? params.message_id ?? ""
          ),
        };

      case "mark_private_msg_as_read":
        return { message_scene: "friend", peer_id: params.user_id, user_id: params.user_id };

      case "mark_group_msg_as_read":
        return { message_scene: "group", peer_id: params.group_id, group_id: params.group_id };

      case "set_group_ban":
        return {
          group_id: params.group_id,
          user_id:  params.user_id,
          duration: params.duration ?? 0,
        };

      case "set_group_whole_ban":
        return {
          group_id: params.group_id,
          is_mute:  params.enable !== false,
        };

      case "set_group_admin":
        return {
          group_id: params.group_id,
          user_id:  params.user_id,
          is_set:   params.enable !== false,
        };

      case "set_group_kick":
        return {
          group_id:           params.group_id,
          user_id:            params.user_id,
          reject_add_request: params.reject_add_request ?? false,
        };

      case "send_like":
        return {
          user_id: params.user_id,
          count:   params.times ?? params.count ?? 1,
        };

      case "friend_poke":
        return { user_id: params.user_id };

      case "group_poke":
        return { group_id: params.group_id, user_id: params.user_id };

      case "_send_group_notice":
        return {
          group_id:  params.group_id,
          content:   params.content,
          image_uri: params.image || undefined,
        };

      case "_get_group_notice":
        return { group_id: params.group_id };

      case "del_group_notice":
        return {
          group_id:        params.group_id,
          announcement_id: params.notice_id,
        };

      case "get_group_root_files":
      case "get_group_files_by_folder":
        return {
          group_id:         params.group_id,
          parent_folder_id: params.folder_id || "/",
        };

      case "get_group_file_url":
        return {
          group_id: params.group_id,
          file_id:  params.file_id,
        };

      case "upload_group_file":
        return {
          group_id:         params.group_id,
          file_uri:         params.file,
          file_name:        params.name,
          parent_folder_id: params.folder_id || "/",
        };

      case "upload_private_file":
        return {
          user_id:   params.user_id,
          file_uri:  params.file,
          file_name: params.name,
        };

      case "create_group_file_folder":
        return {
          group_id:    params.group_id,
          folder_name: params.name,
        };

      case "set_msg_emoji_like": {
        let groupId = params.group_id;
        if (!groupId) {
          const ctx = this._msgContext.get(String(params.message_id));
          if (ctx && ctx.scene === "group") {
            groupId = ctx.peer_id;
          }
        }
        const reactionId = String(params.emoji_id ?? params.face_id ?? "424");
        return {
          group_id: Number(groupId) || 0,
          message_seq: Number(params.message_id),
          reaction: reactionId,
          reaction_type: detectMilkyReactionType(
            reactionId,
            params.reaction_type
          ),
          is_add: params.is_add ?? true,
        };
      }

      default:
        return params;
    }
  }

  // =================== 响应转换 ===================

  _transformResponse(action, data, params) {
    if (data === null || data === undefined) return data;

    switch (action) {
      case "send_group_msg":
      case "send_private_msg": {
        const seq = data.message_seq;
        // 缓存消息上下文供后续 recall/get_msg 使用
        const scene  = action === "send_group_msg" ? "group" : "friend";
        const peerId = action === "send_group_msg" ? params.group_id : params.user_id;
        this._saveMsgCtx(String(seq), scene, peerId);
        return { message_id: String(seq), message_seq: seq };
      }

      case "get_login_info":
        return { user_id: data.uin, nickname: data.nickname, ...data };

      case "get_stranger_info":
        // get_user_profile 返回扁平字段
        return {
          user_id:  params?.user_id,
          nickname: data.nickname,
          sex:      data.sex,
          age:      data.age,
          remark:   data.remark,
          bio:      data.bio,
          level:    data.level,
          ...data,
        };

      case "get_group_info":
        return data.group ?? data;

      case "get_group_list":
        return data.groups ?? data;

      case "get_friend_list":
        return data.friends ?? data;

      case "get_friend_info":
        return data.friend ?? data;

      case "get_group_member_info": {
        const member = data.member ?? data;
        if (member) {
          if (member.join_time > 10000000000) {
            member.join_time = Math.floor(member.join_time / 1000);
          }
          if (member.last_sent_time > 10000000000) {
            member.last_sent_time = Math.floor(member.last_sent_time / 1000);
          }
        }
        return member;
      }

      case "get_group_member_list": {
        const members = data.members ?? data;
        if (Array.isArray(members)) {
          members.forEach(member => {
            if (member.join_time > 10000000000) {
              member.join_time = Math.floor(member.join_time / 1000);
            }
            if (member.last_sent_time > 10000000000) {
              member.last_sent_time = Math.floor(member.last_sent_time / 1000);
            }
          });
        }
        return members;
      }

      case "get_group_msg_history":
      case "get_friend_msg_history": {
        const msgs = (data.messages || []).map(m =>
          translateIncomingMessage(m, this._selfId, m.time)
        );
        return {
          messages: msgs,
          next_message_seq: data.next_message_seq,
        };
      }

      case "get_forward_msg":
      case "get_forwarded_messages":
        return {
          messages: (data.messages || []).map(translateForwardedMessage),
        };

      case "_get_group_notice":
        // { announcements: [...] } → 兼容旧格式
        return (data.announcements || []).map(a => ({
          notice_id:        a.announcement_id,
          sender_id:        a.sender_id,
          publication_time: a.time,
          message:          { text: a.content },
          image:            a.image_url || "",
        }));

      case "get_essence_msg_list":
        return data.messages ?? data;

      case "get_group_root_files":
      case "get_group_files_by_folder":
        return {
          files:   data.files ?? [],
          folders: data.folders ?? [],
        };

      case "get_group_file_url":
        return { url: data.download_url };

      case "upload_group_file":
      case "upload_private_file":
        return { file_id: data.file_id };

      case "create_group_file_folder":
        return { folder_id: data.folder_id };

      default:
        return data;
    }
  }

  // =================== 特殊处理 ===================

  async _handleHistoryMessages(action, params = {}) {
    const milkyAction = ACTION_MAP[action] || action;
    const milkyParams = this._transformParams(action, params);
    const requestedCount = Number(params.count ?? params.limit);

    if (!(Number.isFinite(requestedCount) && requestedCount > 30)) {
      const result = await this._httpPost(milkyAction, milkyParams);
      return this._transformResponse(action, result, params);
    }

    const mergedMessages = [];
    const seenMessageSeqs = new Set();
    let nextMessageSeq = milkyParams.start_message_seq;
    let previousStartSeq = null;
    let remaining = requestedCount;

    while (remaining > 0) {
      const pageParams = {
        ...milkyParams,
        limit: Math.min(remaining, 30),
      };

      if (Number.isFinite(nextMessageSeq) && nextMessageSeq > 0) {
        pageParams.start_message_seq = nextMessageSeq;
      } else {
        delete pageParams.start_message_seq;
      }

      const page = await this._httpPost(milkyAction, pageParams);
      const pageMessages = Array.isArray(page?.messages) ? page.messages : [];

      if (pageMessages.length === 0) {
        nextMessageSeq = page?.next_message_seq;
        break;
      }

      let addedCount = 0;
      for (const message of pageMessages) {
        const seqKey = String(message?.message_seq ?? "");
        if (seenMessageSeqs.has(seqKey)) {
          continue;
        }
        seenMessageSeqs.add(seqKey);
        mergedMessages.push(message);
        addedCount += 1;
      }

      remaining = requestedCount - mergedMessages.length;
      const pageNextSeq = page?.next_message_seq;

      if (!pageNextSeq || addedCount === 0) {
        nextMessageSeq = pageNextSeq;
        break;
      }

      if (
        String(pageNextSeq) === String(nextMessageSeq) ||
        String(pageNextSeq) === String(previousStartSeq)
      ) {
        nextMessageSeq = pageNextSeq;
        break;
      }

      previousStartSeq = nextMessageSeq;
      nextMessageSeq = pageNextSeq;
    }

    mergedMessages.sort((a, b) => {
      const seqA = Number(a?.message_seq ?? 0);
      const seqB = Number(b?.message_seq ?? 0);
      return seqA - seqB;
    });

    return this._transformResponse(
      action,
      { messages: mergedMessages, next_message_seq: nextMessageSeq },
      params
    );
  }

  async _handleRecall(params) {
    const msgId = String(params.message_id);
    const ctx   = this._resolveMsgContext(msgId, params);
    if (!ctx) {
      throw new Error(`Milky: 找不到消息 ${msgId} 的上下文，无法撤回（仅支持撤回 bot 发出或本次连接收到的消息）`);
    }
    const apiName = ctx.scene === "group" ? "recall_group_message" : "recall_private_message";
    const recallParams = { message_seq: Number(msgId) };

    if (ctx.scene === "group") {
      recallParams.group_id = Number(ctx.peer_id);
    } else {
      recallParams.user_id = Number(ctx.peer_id);
    }

    return this._httpPost(apiName, recallParams);
  }

  async _handleGetMsg(params) {
    const msgId = String(params.message_id);
    const ctx   = this._resolveMsgContext(msgId, params);
    if (!ctx) throw new Error(`Milky: 找不到消息 ${msgId} 的上下文`);
    const data = await this._httpPost("get_message", {
      message_scene: ctx.scene,
      peer_id:       ctx.peer_id,
      message_seq:   Number(msgId),
    });
    this._saveMsgCtx(msgId, ctx.scene, ctx.peer_id);
    if (data?.message) return translateIncomingMessage(data.message, this._selfId);
    return data;
  }

  _resolveMsgContext(msgId, params = {}) {
    const cached = this._msgContext.get(String(msgId));
    if (cached) return cached;

    if (params.message_scene && params.peer_id) {
      return {
        scene: params.message_scene,
        peer_id: Number(params.peer_id),
      };
    }

    if (params.group_id) {
      return {
        scene: "group",
        peer_id: Number(params.group_id),
      };
    }

    if (params.user_id) {
      return {
        scene: "friend",
        peer_id: Number(params.user_id),
      };
    }

    return null;
  }

  async _handleFriendRequest(params) {
    // params: { flag: initiator_uid, approve, remark }
    if (params.approve !== false) {
      return this._httpPost("accept_friend_request", { initiator_uid: params.flag });
    }
    return this._httpPost("reject_friend_request", {
      initiator_uid: params.flag,
      reason:        params.reason,
    });
  }

  async _handleGroupRequest(params) {
    // flag 格式: "group_id:seq:type:is_filtered"
    const [groupIdStr, seqStr, type, filteredStr] = (params.flag || "").split(":");
    const group_id        = Number(groupIdStr);
    const seq             = Number(seqStr);
    const is_filtered     = filteredStr === "1";
    const notification_type = type === "invite" ? "invited_join_request" : "join_request";

    if (type === "invitation") {
      if (params.approve !== false) {
        return this._httpPost("accept_group_invitation", { group_id, invitation_seq: seq });
      }
      return this._httpPost("reject_group_invitation", { group_id, invitation_seq: seq });
    }

    if (params.approve !== false) {
      return this._httpPost("accept_group_request", {
        group_id, notification_seq: seq, notification_type, is_filtered,
      });
    }
    return this._httpPost("reject_group_request", {
      group_id, notification_seq: seq, notification_type, is_filtered,
      reason: params.reason,
    });
  }

  async _handleForward(params) {
    // OneBot v11 合并转发节点 → Milky forward segment
    const nodes = (params.messages || [])
      .filter(m => m.type === "node")
      .map(m => ({
        user_id:     m.data?.user_id || 0,
        sender_name: m.data?.nickname || "",
        segments:    convertToMilky(m.data?.content || []),
      }));

    const isGroup = !!params.group_id;
    const scene   = isGroup ? "group" : "friend";
    const peer_id = params.group_id || params.user_id;

    const result = await this._httpPost(
      isGroup ? "send_group_message" : "send_private_message",
      {
        message_scene: scene,
        peer_id,
        message: [{
          type:     "forward",
          messages: nodes,
          title:    params.source || "",
          preview:  (params.news || []).map(n => n.text || ""),
          summary:  params.summary || "",
          prompt:   params.prompt || "",
        }],
      }
    );

    if (result?.message_seq) {
      this._saveMsgCtx(String(result.message_seq), scene, peer_id);
      return { message_id: String(result.message_seq) };
    }
    return result;
  }

  // =================== 消息上下文缓存 ===================

  _saveMsgCtx(msgId, scene, peerId) {
    if (!msgId) return;
    this._msgContext.set(msgId, { scene, peer_id: peerId });
    // 最多缓存 2000 条
    if (this._msgContext.size > 2000) {
      this._msgContext.delete(this._msgContext.keys().next().value);
    }
  }

  // =================== WebSocket 事件连接 ===================

  _connectWs() {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (this.config.accessToken) {
        headers["Authorization"] = `Bearer ${this.config.accessToken}`;
      }

      const ws = new WebSocket(this._wsEventUrl, { headers });
      this._ws = ws;
      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      ws.on("open", async () => {
        this._reconnectCount = 0;
        try {
          // 获取 self_id
          const info = await this._httpPost("get_login_info", {});
          this._selfId = info?.uin;
          this._startHeartbeat(ws);
          this.emit("socket.open", {});
          // 合成 lifecycle.connect 事件，触发 index.js 创建 OneBotApi 实例
          const lifecycleEvent = {
            post_type:       "meta_event",
            meta_event_type: "lifecycle",
            sub_type:        "connect",
            self_id:         this._selfId,
            time:            Math.floor(Date.now() / 1000),
          };
          this.emit("meta_event", lifecycleEvent);
          this.emit("meta_event.lifecycle", lifecycleEvent);
          this.emit("meta_event.lifecycle.connect", lifecycleEvent);
          settle(resolve);
        } catch (e) {
          settle(reject, e);
        }
      });

      ws.on("message", (raw) => {
        let milkyEvent;
        try { milkyEvent = JSON.parse(raw.toString()); } catch { return; }

        const obEvent = translateEvent(milkyEvent, this._selfId);
        if (!obEvent) return;

        // 缓存收到的消息上下文（用于 recall / get_msg）
        if (obEvent.post_type === "message" && obEvent.message_id) {
          const scene  = obEvent.message_type === "group" ? "group" : "friend";
          const peerId = obEvent.group_id || obEvent.user_id;
          this._saveMsgCtx(obEvent.message_id, scene, peerId);
        }

        this._dispatchEvent(obEvent);
      });

      ws.on("close", (code, reason) => {
        this._stopHeartbeat();
        this._ws = null;
        this.emit("socket.close", { code, reason: reason?.toString() || "" });
        if (!this._disconnecting) this._scheduleReconnect();
        settle(reject, new Error(`连接关闭 code=${code}`));
      });

      ws.on("error", (err) => {
        this.emit("socket.error", { error_type: err.message });
        settle(reject, err);
      });
    });
  }

  _scheduleReconnect() {
    const delay = this.config.reconnectDelay ?? 5000;
    if (!delay) return;
    this._reconnectCount++;
    this.emit("socket.connecting", { reconnection: { nowAttempts: this._reconnectCount } });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectWs().catch(() => {});
    }, delay);
  }

  _startHeartbeat(ws) {
    const interval = this.config.heartbeatInterval ?? 30000;
    if (!interval) return;
    this._heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, interval);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // =================== 事件分发 ===================

  _dispatchEvent(event) {
    const { post_type } = event;
    if (!post_type) return;

    this.emit(post_type, event);

    if (post_type === "meta_event" && event.meta_event_type) {
      this.emit(`meta_event.${event.meta_event_type}`, event);
      if (event.sub_type) {
        this.emit(`meta_event.${event.meta_event_type}.${event.sub_type}`, event);
      }
    } else if (event.sub_type) {
      this.emit(`${post_type}.${event.sub_type}`, event);
    }
  }
}
