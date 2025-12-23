import { logger } from "../utils/logger.js";
import { bots } from "../api/client.js";

export function logEvent(data) {
  const event = data;
  if (!event.post_type) return;

  const prefix = (bots.size > 1 && event.self_id) ? `[${event.self_id}] ` : "";

  if (event.post_type === "meta_event") {
    if (event.meta_event_type === "heartbeat") return;
    if (event.meta_event_type === "lifecycle") {
      logger.debug(`${prefix}生命周期 ${event.sub_type}`);
      return;
    }
    logger.debug(`${prefix}元事件 ${event.meta_event_type}`);
    return;
  }

  if (event.post_type === "message") {
    const senderName =
      event.sender?.card || event.sender?.nickname || "Unknown";
    const senderId = event.user_id;

    let content = "";
    if (Array.isArray(event.message)) {
      content = event.message
        .map((seg) => {
          switch (seg.type) {
            case "text":
              return seg.data?.text || "";
            case "at":
              return `@${seg.data?.qq}`;
            case "image": {
              const isAnimated = seg.data?.sub_type === 1;
              return isAnimated ? "[动画表情]" : "[图片]";
            }
            case "record":
              return "[语音]";
            case "video":
              return "[视频]";
            case "json":
              return "[JSON]";
            case "face":
              return `[表情:${seg.data?.id}]`;
            case "reply":
              return `[回复:${seg.data?.id}]`;
            case "forward":
              return "[聊天记录]";
            default:
              return `[${seg.type}]`;
          }
        })
        .join("");
    } else {
      content = event.raw_message || "";
    }

    if (content.length > 200) {
      content = content.substring(0, 200) + "...";
    }

    if (event.message_type === "group") {
      const groupInfo = event.group_name
        ? `${event.group_name}(${event.group_id})`
        : `群:${event.group_id}`;
      logger.info(
        `${prefix}接收 <- 群聊 [${groupInfo}] [${senderName}(${senderId})] ${content}`
      );
      return;
    }

    if (event.message_type === "private") {
      logger.info(`${prefix}接收 <- 私聊 [${senderName}(${senderId})] ${content}`);
      return;
    }
  }

  if (event.post_type === "notice") {
    switch (event.notice_type) {
      case "group_increase":
        logger.info(`${prefix}群成员增加 ${event.group_id} ${event.operator_id} -> ${event.user_id}`);
        return;
      case "group_decrease":
        logger.info(`${prefix}群成员减少 ${event.group_id} ${event.operator_id} -> ${event.user_id} ${event.sub_type}`);
        return;
      case "group_ban":
        const duration = event.duration ? `${event.duration}s` : "0";
        logger.info(`${prefix}群禁言 ${event.group_id} ${event.operator_id} -> ${event.user_id} ${duration}`);
        return;
      case "group_recall":
        logger.info(`${prefix}群撤回 ${event.group_id} ${event.operator_id} -> ${event.user_id} ${event.message_id}`);
        return;
      case "friend_recall":
        logger.info(`${prefix}私聊撤回 ${event.user_id} ${event.message_id}`);
        return;
      case "group_upload":
        logger.info(`${prefix}群文件上传 ${event.group_id} ${event.user_id} -> ${event.file?.name}`);
        return;
      case "group_admin":
        logger.info(`${prefix}群管理员变动 ${event.group_id} ${event.user_id} ${event.sub_type}`);
        return;
      case "friend_add":
        logger.info(`${prefix}好友添加 ${event.user_id}`);
        return;
      case "group_card":
        logger.info(`${prefix}群名片变更 ${event.group_id} ${event.user_id} ${event.card_old} -> ${event.card_new}`);
        return;
      case "essence":
        logger.info(`${prefix}群精华 ${event.group_id} ${event.operator_id} -> ${event.sender_id} ${event.message_id} ${event.sub_type}`);
        return;
      case "group_msg_emoji_like":
        const emojis = event.likes?.map((l) => `${l.emoji_id}`);
        logger.info(`${prefix}表情回应 ${event.group_id} ${event.message_id} ${emojis}`);
        return;
      case "bot_offline":
        logger.warn(`${prefix}离线 ${event.tag} ${event.message}`);
        return;
      case "notify":
        if (event.sub_type === "poke") {
          logger.info(`${prefix}戳一戳 ${event.group_id || "私聊"} ${event.user_id} -> ${event.target_id}`);
          return;
        }
        if (event.sub_type === "group_name") {
          logger.info(`${prefix}群名变更 ${event.group_id} ${event.user_id} -> ${event.name_new}`);
          return;
        }
        if (event.sub_type === "title") {
          logger.info(`${prefix}群头衔变更 ${event.group_id} ${event.user_id} -> ${event.title}`);
          return;
        }
        if (event.sub_type === "profile_like") {
          logger.info(`${prefix}资料点赞 ${event.operator_id} x${event.times}`);
          return;
        }
        if (event.sub_type === "input_status") {
          logger.info(`${prefix}输入状态 ${event.group_id || "私聊"} ${event.user_id} ${event.status_text}`);
          return;
        }
        logger.info(`${prefix}通知 ${event.group_id || ""} ${event.sub_type}`);
        return;
      default:
        logger.info(`${prefix}${event.notice_type} ${JSON.stringify(data)}`);
        return;
    }
  }

  if (event.post_type === "request") {
    if (event.request_type === "friend") {
      logger.info(`${prefix}好友请求 ${event.user_id} ${event.comment || ""}`);
      return;
    }
    if (event.request_type === "group") {
      logger.info(`${prefix}加群请求 ${event.group_id} ${event.user_id} ${event.sub_type} ${event.comment || ""}`);
      return;
    }
  }

  logger.info(`${prefix}${event.post_type.toUpperCase()} ${JSON.stringify(data)}`);
}
