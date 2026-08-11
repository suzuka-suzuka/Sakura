export const MESSAGE_IMAGE_ANALYZER_TOOL_NAME = "analyzeMessageImage";

export function hasInlineImageParts(parts = []) {
  return Array.isArray(parts) && parts.some((part) => part?.inlineData);
}

export function hasMessageImagePlaceholder(parts = []) {
  return Array.isArray(parts) && parts.some(
    (part) => {
      if (typeof part?.text !== "string") return false;
      return part.text.includes("[图片]") && /\(seq:[^)]+\)/.test(part.text);
    }
  );
}

export function hasMessageImageReference(parts = []) {
  return hasInlineImageParts(parts) || hasMessageImagePlaceholder(parts);
}

export function prepareImagePartsForModel(parts, supportsImageInput) {
  if (supportsImageInput || !hasInlineImageParts(parts)) {
    return parts;
  }

  return parts.filter((part) => !part?.inlineData);
}

export function shouldExposeMessageImageAnalyzer({
  hasCurrentImages = false,
  supportsImageInput = true,
  hasMessageContentAnalyzer = false,
} = {}) {
  return Boolean(
    hasCurrentImages &&
    !supportsImageInput &&
    !hasMessageContentAnalyzer
  );
}
