export function isBotOfflineEvent(event) {
  if (!event || typeof event !== "object") return false;

  if (event.post_type === "notice" && event.notice_type === "bot_offline") {
    return true;
  }

  if (
    event.post_type === "meta_event" &&
    event.meta_event_type === "heartbeat" &&
    event.status?.online === false
  ) {
    return true;
  }

  return (
    event.post_type === "meta_event" &&
    event.meta_event_type === "lifecycle" &&
    (event.sub_type === "disable" || event.sub_type === "disconnect")
  );
}
