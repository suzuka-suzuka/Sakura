const REACTION_COMMAND_PATTERN = /^\s*#?贴表情/u;
const SINGLE_CODE_POINT_EMOJI_PATTERN = /^\p{Extended_Pictographic}$/u;
const LEADING_SEPARATOR_PATTERN = /^\s+/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", {
  granularity: "grapheme",
});

function firstGrapheme(value) {
  const iterator = GRAPHEME_SEGMENTER.segment(value)[Symbol.iterator]();
  return iterator.next().value?.segment || "";
}

function parseTextCandidate(value) {
  const text = String(value ?? "").replace(LEADING_SEPARATOR_PATTERN, "");
  if (!text) return null;

  const emoji = firstGrapheme(text);
  const codePoints = [...emoji].map((char) => char.codePointAt(0));

  if (codePoints.length !== 1) {
    return {
      status: "unsupported-composite",
      emoji,
      codePoints,
    };
  }

  if (!SINGLE_CODE_POINT_EMOJI_PATTERN.test(emoji)) {
    return {
      status: "invalid",
      value: emoji,
    };
  }

  return {
    status: "ok",
    type: "emoji",
    id: String(codePoints[0]),
    emoji,
  };
}

/**
 * 从“贴表情”消息中按消息段顺序取第一个 QQ 表情或 Unicode Emoji。
 * Unicode Emoji 按用户可见字素判断，只接受恰好由一个码点组成的 Emoji。
 */
export function parseReactionCommand(message) {
  if (!Array.isArray(message)) return { status: "missing" };

  let commandFound = false;

  for (const segment of message) {
    if (!segment || typeof segment !== "object") continue;

    if (!commandFound) {
      if (segment.type !== "text") continue;

      const text = String(segment.data?.text ?? "");
      const commandMatch = text.match(REACTION_COMMAND_PATTERN);
      if (!commandMatch) continue;

      commandFound = true;
      const candidate = parseTextCandidate(text.slice(commandMatch[0].length));
      if (candidate) return candidate;
      continue;
    }

    if (segment.type === "face") {
      const id = String(segment.data?.id ?? "").trim();
      if (/^\d+$/.test(id)) {
        return {
          status: "ok",
          type: "face",
          id,
        };
      }
      return { status: "invalid" };
    }

    if (segment.type === "text") {
      const candidate = parseTextCandidate(segment.data?.text);
      if (candidate) return candidate;
    }
  }

  return { status: "missing" };
}
