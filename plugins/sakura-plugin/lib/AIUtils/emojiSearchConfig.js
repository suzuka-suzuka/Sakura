import Setting from "../setting.js";

export const DEFAULT_EMOJI_SEARCH_TOP_K = 3;
export const DEFAULT_EMOJI_SEARCH_MIN_SCORE = 0.65;
export const MAX_EMOJI_SEARCH_TOP_K = 20;

export function normalizeEmojiSearchConfig(config = {}) {
  const source = config && typeof config === "object" ? config : {};

  return {
    topK: Number.isInteger(source.searchTopK)
      ? Math.min(MAX_EMOJI_SEARCH_TOP_K, Math.max(1, source.searchTopK))
      : DEFAULT_EMOJI_SEARCH_TOP_K,
    minScore: Number.isFinite(source.searchMinScore)
      ? Math.min(1, Math.max(0, source.searchMinScore))
      : DEFAULT_EMOJI_SEARCH_MIN_SCORE,
  };
}

export function getEmojiSearchConfig() {
  return normalizeEmojiSearchConfig(Setting.getConfig("EmojiThief"));
}
