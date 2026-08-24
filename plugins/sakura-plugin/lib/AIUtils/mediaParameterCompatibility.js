export const GROK_CPA_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
]);

export const GROK_CPA_VIDEO_RESOLUTIONS = new Set(["480p", "720p"]);
export const GROK_CPA_MAX_VIDEO_RESOLUTION = "720p";

function parseAspectRatio(value) {
  const matched = `${value || ""}`.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!matched) return null;

  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return width / height;
}

function aspectOrientation(value) {
  if (Math.abs(value - 1) < 1e-6) return "square";
  return value > 1 ? "landscape" : "portrait";
}

/**
 * Maps an unsupported ratio to the numerically nearest supported ratio while
 * preserving portrait/landscape orientation whenever the target supports it.
 */
export function nearestSupportedAspectRatio(aspectRatio, supportedRatios) {
  if (!aspectRatio || aspectRatio === "auto") return aspectRatio;

  const supported = [...supportedRatios].filter(
    (ratio) => ratio && ratio !== "auto"
  );
  if (supported.includes(aspectRatio)) return aspectRatio;

  const requestedValue = parseAspectRatio(aspectRatio);
  if (!requestedValue) return null;

  const requestedOrientation = aspectOrientation(requestedValue);
  const parsed = supported
    .map((ratio) => ({ ratio, value: parseAspectRatio(ratio) }))
    .filter((item) => item.value != null);
  const sameOrientation = parsed.filter(
    (item) => aspectOrientation(item.value) === requestedOrientation
  );
  const candidates = sameOrientation.length > 0 ? sameOrientation : parsed;

  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(Math.log(requestedValue / candidate.value));
    if (distance < nearestDistance) {
      nearest = candidate.ratio;
      nearestDistance = distance;
    }
  }

  return nearest;
}

export function clampInteger(value, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return value;
  return Math.min(maximum, Math.max(minimum, parsed));
}
