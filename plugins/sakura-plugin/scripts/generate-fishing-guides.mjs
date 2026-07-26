import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  FISHING_LOCATIONS,
  GHOST_DEBT_INTEREST_RATE,
  GHOST_DEBT_MARK_PENALTY_RATE,
  GHOST_DEBT_WRITE_OFF_THRESHOLD,
  SHINY_CHANCE,
  SHINY_EXP_MULTIPLIER,
  SHINY_PRICE_MULTIPLIER,
  TORPEDO_ARM_DURATION_MS,
  TORPEDO_BLAST_CATCH_COUNT,
  TORPEDO_DETONATE_PRICE_MULTIPLIER,
  TORPEDO_PRICE_BOOST_MULTIPLIER,
  TORPEDO_ROD_DAMAGE,
  WEATHER_CONFIG,
} from "../lib/fishing/rules.js";
import {
  DEX_LOCATION_FULL_COIN_REWARD,
  FISHING_LEVEL_REWARD_ITEMS,
  FISHING_LEVEL_REWARD_STEP,
  getDexLocationRewardTiers,
} from "../lib/economy/rules.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const resourceRoot = path.join(pluginRoot, "resources");
const fishRoot = path.join(resourceRoot, "fish");
const fishImageRoot = path.join(fishRoot, "img");
const guideRoot = path.join(fishRoot, "guide");

const fishData = JSON.parse(
  fs.readFileSync(path.join(fishRoot, "fish.json"), "utf8"),
);
const specialConfig = yaml.load(
  fs.readFileSync(path.join(resourceRoot, "economy", "special_items.yaml"), "utf8"),
);
const shopConfig = yaml.load(
  fs.readFileSync(path.join(resourceRoot, "economy", "shop.yaml"), "utf8"),
);

const fontMain = path.join(resourceRoot, "sign", "font", "FZFWZhuZiAYuanJWD.ttf");
const fontFallback = path.join(resourceRoot, "sign", "font", "MotoyaMaruStd-W5.otf");
GlobalFonts.registerFromPath(fontMain, "FishingGuide");
GlobalFonts.registerFromPath(fontFallback, "FishingGuideFallback");

const FONT = 'FishingGuide, FishingGuideFallback, "Microsoft YaHei", sans-serif';
const WIDTH = 1600;
const LOCATION_ORDER = Object.keys(FISHING_LOCATIONS);
const LOCATION_INDEX = new Map(LOCATION_ORDER.map((id, index) => [id, index]));
const LOCATION_SHORT = Object.freeze({
  pond: "池塘",
  river: "河湾",
  lake: "雾湖",
  coast: "海岸",
  abyss: "海沟",
  mystic: "秘境",
});
const RARITY_STYLE = Object.freeze({
  "垃圾": { fill: "#EBE6E2", text: "#6F6761", border: "#C8BDB6" },
  "普通": { fill: "#F1F4F7", text: "#526171", border: "#C8D1D9" },
  "精品": { fill: "#E7F4E9", text: "#39724A", border: "#A9D2B2" },
  "稀有": { fill: "#E6F0FB", text: "#356DA8", border: "#A9C8E8" },
  "史诗": { fill: "#F0E8F7", text: "#794F9C", border: "#C7ACE0" },
  "传说": { fill: "#FFF0DC", text: "#A86618", border: "#E7BE82" },
  "宝藏": { fill: "#FFF5CC", text: "#8A6B10", border: "#E4CC69" },
  "噩梦": { fill: "#F3E5EA", text: "#843E59", border: "#D6A6B7" },
});
const PALETTE = Object.freeze({
  ink: "#3E3340",
  secondary: "#6C5A68",
  muted: "#94838D",
  pink: "#C84F83",
  pinkSoft: "#F9E3EC",
  blue: "#446E9D",
  blueSoft: "#E4EDF7",
  gold: "#A9782D",
  goldSoft: "#FBF0D9",
  green: "#397D5A",
  greenSoft: "#E2F2E8",
  red: "#A94855",
  redSoft: "#F7E4E7",
  violet: "#75508E",
  violetSoft: "#EEE6F4",
  panel: "rgba(255, 253, 252, 0.93)",
  panelStrong: "rgba(255, 255, 255, 0.97)",
  border: "rgba(113, 79, 98, 0.22)",
});

const backgroundPaths = Object.freeze({
  light: path.join(guideRoot, "guide-background-light.png"),
  dark: path.join(guideRoot, "guide-background-dark.png"),
});
const imageCache = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawPanel(ctx, x, y, width, height, options = {}) {
  const {
    fill = PALETTE.panel,
    border = PALETTE.border,
    radius = 28,
    shadow = true,
    lineWidth = 2,
  } = options;
  ctx.save();
  if (shadow) {
    ctx.shadowColor = "rgba(45, 34, 43, 0.15)";
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 8;
  }
  ctx.fillStyle = fill;
  roundedRect(ctx, x, y, width, height, radius);
  ctx.fill();
  ctx.shadowColor = "transparent";
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = lineWidth;
    roundedRect(ctx, x, y, width, height, radius);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPill(ctx, text, x, y, options = {}) {
  const {
    fontSize = 22,
    height = 42,
    paddingX = 18,
    fill = PALETTE.pinkSoft,
    color = PALETTE.pink,
    border = null,
    align = "left",
  } = options;
  ctx.save();
  ctx.font = `bold ${fontSize}px ${FONT}`;
  const width = Math.ceil(ctx.measureText(String(text)).width) + paddingX * 2;
  const left = align === "right" ? x - width : x;
  ctx.fillStyle = fill;
  roundedRect(ctx, left, y, width, height, height / 2);
  ctx.fill();
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 1.5;
    roundedRect(ctx, left, y, width, height, height / 2);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(text), left + width / 2, y + height / 2 + 1);
  ctx.restore();
  return width;
}

function splitLines(ctx, text, maxWidth) {
  const lines = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    if (!rawLine) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const char of [...rawLine]) {
      const next = line + char;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = char;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function measureTextBlock(ctx, text, maxWidth, options = {}) {
  const {
    fontSize = 26,
    lineHeight = Math.round(fontSize * 1.48),
    bold = false,
    maxLines = Number.POSITIVE_INFINITY,
  } = options;
  ctx.save();
  ctx.font = `${bold ? "bold " : ""}${fontSize}px ${FONT}`;
  const lines = splitLines(ctx, text, maxWidth).slice(0, maxLines);
  ctx.restore();
  return { lines, height: lines.length * lineHeight, lineHeight };
}

function drawTextBlock(ctx, text, x, y, maxWidth, options = {}) {
  const {
    fontSize = 26,
    lineHeight = Math.round(fontSize * 1.48),
    bold = false,
    color = PALETTE.secondary,
    maxLines = Number.POSITIVE_INFINITY,
    align = "left",
  } = options;
  ctx.save();
  ctx.font = `${bold ? "bold " : ""}${fontSize}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  const lines = splitLines(ctx, text, maxWidth).slice(0, maxLines);
  lines.forEach((line, index) => {
    const drawX = align === "center" ? x + maxWidth / 2 : x;
    ctx.fillText(line, drawX, y + index * lineHeight);
  });
  ctx.restore();
  return y + lines.length * lineHeight;
}

function drawSectionTitle(ctx, title, x, y, width, options = {}) {
  const { color = PALETTE.pink, subtitle = "" } = options;
  ctx.save();
  ctx.fillStyle = color;
  roundedRect(ctx, x, y + 11, 8, 42, 4);
  ctx.fill();
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `bold 38px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(title, x + 24, y + 47);
  if (subtitle) {
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `23px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillText(subtitle, x + width, y + 44);
  }
  ctx.restore();
}

async function getImage(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  if (!imageCache.has(imagePath)) {
    imageCache.set(imagePath, loadImage(imagePath).catch(() => null));
  }
  return imageCache.get(imagePath);
}

function drawImageCover(ctx, image, x, y, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.width - sourceWidth) / 2;
  const sourceY = (image.height - sourceHeight) / 2;
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    x,
    y,
    width,
    height,
  );
}

async function drawImageContain(ctx, imagePath, x, y, width, height, options = {}) {
  const {
    radius = 20,
    background = "rgba(255,255,255,0.62)",
    inset = 8,
  } = options;
  ctx.save();
  ctx.fillStyle = background;
  roundedRect(ctx, x, y, width, height, radius);
  ctx.fill();
  const image = await getImage(imagePath);
  if (image) {
    const availableWidth = width - inset * 2;
    const availableHeight = height - inset * 2;
    const scale = Math.min(availableWidth / image.width, availableHeight / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    ctx.save();
    roundedRect(ctx, x, y, width, height, radius);
    ctx.clip();
    ctx.drawImage(
      image,
      x + (width - drawWidth) / 2,
      y + (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    ctx.restore();
  }
  ctx.restore();
}

async function createPoster(height, mode = "light") {
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");
  const background = await getImage(backgroundPaths[mode]);
  if (background) {
    drawImageCover(ctx, background, 0, 0, WIDTH, height);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, mode === "dark" ? "#CAD1DD" : "#FFF1F5");
    gradient.addColorStop(1, mode === "dark" ? "#627086" : "#DCEEF5");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WIDTH, height);
  }
  ctx.fillStyle = mode === "dark"
    ? "rgba(230, 234, 241, 0.23)"
    : "rgba(255, 252, 249, 0.18)";
  ctx.fillRect(0, 0, WIDTH, height);
  return { canvas, ctx };
}

function drawHeader(ctx, title, subtitle, options = {}) {
  const { tag = "钓鱼攻略", accent = PALETTE.pink } = options;
  drawPanel(ctx, 92, 76, WIDTH - 184, 190, {
    fill: "rgba(255, 255, 255, 0.84)",
    border: "rgba(180, 132, 157, 0.26)",
    radius: 38,
  });
  drawPill(ctx, tag, 132, 108, {
    fontSize: 22,
    height: 40,
    fill: `${accent}20`,
    color: accent,
  });
  ctx.save();
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `bold 62px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(title, 130, 202);
  ctx.fillStyle = PALETTE.secondary;
  ctx.font = `25px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(subtitle, WIDTH - 130, 205);
  ctx.restore();
}

function drawFooter(ctx, height, text = "数据以当前游戏配置为准 · 未标注者按通用规则处理") {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  roundedRect(ctx, 250, height - 84, WIDTH - 500, 46, 23);
  ctx.fill();
  ctx.fillStyle = PALETTE.secondary;
  ctx.font = `20px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, WIDTH / 2, height - 61);
  ctx.restore();
}

function getTokenLayout(ctx, entries, width, options = {}) {
  const {
    fontSize = 22,
    horizontalGap = 10,
    verticalGap = 10,
    paddingX = 14,
    tokenHeight = 38,
  } = options;
  ctx.save();
  ctx.font = `bold ${fontSize}px ${FONT}`;
  let x = 0;
  let y = 0;
  const placements = [];
  for (const entry of entries) {
    const label = entry.is_boss ? `首领·${entry.name}` : entry.name;
    const desired = Math.ceil(ctx.measureText(label).width) + paddingX * 2;
    const tokenWidth = Math.min(width, desired);
    if (x > 0 && x + tokenWidth > width) {
      x = 0;
      y += tokenHeight + verticalGap;
    }
    placements.push({ entry, label, x, y, width: tokenWidth });
    x += tokenWidth + horizontalGap;
  }
  ctx.restore();
  return {
    placements,
    height: entries.length === 0 ? 0 : y + tokenHeight,
    tokenHeight,
    fontSize,
  };
}

function drawFishTokens(ctx, entries, x, y, width, options = {}) {
  const layout = getTokenLayout(ctx, entries, width, options);
  ctx.save();
  for (const placement of layout.placements) {
    const style = RARITY_STYLE[placement.entry.rarity] || RARITY_STYLE["普通"];
    const drawX = x + placement.x;
    const drawY = y + placement.y;
    ctx.fillStyle = style.fill;
    roundedRect(ctx, drawX, drawY, placement.width, layout.tokenHeight, 12);
    ctx.fill();
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 1.2;
    roundedRect(ctx, drawX, drawY, placement.width, layout.tokenHeight, 12);
    ctx.stroke();
    ctx.fillStyle = style.text;
    ctx.font = `bold ${layout.fontSize}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      placement.label,
      drawX + placement.width / 2,
      drawY + layout.tokenHeight / 2 + 1,
    );
  }
  ctx.restore();
  return layout.height;
}

function measureFishCard(ctx, entries, width, options = {}) {
  const tokenWidth = width - 48;
  const layout = getTokenLayout(ctx, entries, tokenWidth, options);
  return 88 + layout.height + 24;
}

function drawFishCard(ctx, { title, entries, note = "" }, x, y, width, options = {}) {
  const {
    accent = PALETTE.pink,
    tokenOptions = {},
    minHeight = 0,
  } = options;
  const height = Math.max(
    minHeight,
    measureFishCard(ctx, entries, width, tokenOptions) + (note ? 34 : 0),
  );
  drawPanel(ctx, x, y, width, height);
  ctx.save();
  ctx.fillStyle = accent;
  roundedRect(ctx, x, y, 10, height, 5);
  ctx.fill();
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `bold 29px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(title, x + 26, y + 48);
  drawPill(ctx, `${entries.length} 种`, x + width - 24, y + 18, {
    align: "right",
    fontSize: 18,
    height: 34,
    paddingX: 13,
    fill: `${accent}18`,
    color: accent,
  });
  if (note) {
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `18px ${FONT}`;
    ctx.fillText(note, x + 26, y + 76);
  }
  ctx.restore();
  drawFishTokens(
    ctx,
    entries,
    x + 24,
    y + (note ? 98 : 72),
    width - 48,
    tokenOptions,
  );
  return height;
}

function isFullDay(hours) {
  return Array.isArray(hours) &&
    hours.length === 1 &&
    Number(hours[0]?.[0]) === 0 &&
    Number(hours[0]?.[1]) === 24;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatActiveHours(hours) {
  if (
    hours.length === 2 &&
    Number(hours[0]?.[1]) === 24 &&
    Number(hours[1]?.[0]) === 0
  ) {
    return `${formatHour(hours[0][0])}–次日${formatHour(hours[1][1])}`;
  }
  return hours
    .map(([start, end]) => `${formatHour(start)}–${formatHour(end)}`)
    .join(" / ");
}

function activeHourKey(hours) {
  return hours.map(([start, end]) => `${start}-${end}`).join("+");
}

function sortLocationIds(ids) {
  return [...ids].sort(
    (left, right) => LOCATION_INDEX.get(left) - LOCATION_INDEX.get(right),
  );
}

function locationGroupKey(locations) {
  return sortLocationIds(locations).join("+");
}

function locationGroupTitle(key) {
  return key
    .split("+")
    .map((id) => FISHING_LOCATIONS[id]?.name || id)
    .join(" × ");
}

function getLocationFish(locationId) {
  return fishData.filter(
    (fish) => Array.isArray(fish.locations) && fish.locations.includes(locationId),
  );
}

function getSpecialItems() {
  return specialConfig?.categories?.special?.items || [];
}

function getTreasureItems() {
  return specialConfig?.categories?.treasures?.items || [];
}

function findShopItem(id) {
  for (const category of Object.values(shopConfig?.categories || {})) {
    const item = (category?.items || []).find((candidate) => candidate.id === id);
    if (item) return item;
  }
  return null;
}

function itemImagePath(itemId) {
  return path.join(fishImageRoot, `${itemId}.png`);
}

async function savePoster(canvas, filename) {
  fs.mkdirSync(guideRoot, { recursive: true });
  const outputPath = path.join(guideRoot, filename);
  fs.writeFileSync(
    outputPath,
    canvas.toBuffer("image/jpeg", { quality: 0.92, progressive: true }),
  );
  const sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`generated ${path.relative(pluginRoot, outputPath)} (${sizeKb} KB)`);
  return outputPath;
}

async function generateTimeGuide() {
  const height = 2400;
  const { canvas, ctx } = await createPoster(height, "light");
  const limitedFish = fishData.filter((fish) => (
    fish.is_boss !== true &&
    Array.isArray(fish.active_hours) &&
    fish.active_hours.length > 0 &&
    !isFullDay(fish.active_hours)
  ));
  const grouped = new Map();
  for (const fish of limitedFish) {
    const key = activeHourKey(fish.active_hours);
    if (!grouped.has(key)) {
      grouped.set(key, { hours: fish.active_hours, entries: [] });
    }
    grouped.get(key).entries.push(fish);
  }
  const groups = [...grouped.values()].sort((left, right) => (
    Number(left.hours[0]?.[0]) - Number(right.hours[0]?.[0]) ||
    Number(left.hours.at(-1)?.[1]) - Number(right.hours.at(-1)?.[1])
  ));

  drawHeader(
    ctx,
    "限定出没时间总览",
    `共 ${limitedFish.length} 种限时渔获 · 未列出的全天可见`,
    { tag: "时间篇", accent: PALETTE.gold },
  );
  drawSectionTitle(ctx, "按相同时间窗归组", 96, 294, WIDTH - 192, {
    color: PALETTE.gold,
    subtitle: "区间左闭右开，例如 06:00–18:00 不含 18:00",
  });

  const columnGap = 28;
  const columnWidth = (WIDTH - 192 - columnGap) / 2;
  const half = Math.ceil(groups.length / 2);
  const columns = [groups.slice(0, half), groups.slice(half)];
  const tokenOptions = { fontSize: 21, tokenHeight: 38, verticalGap: 9 };

  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    let y = 374;
    const x = 96 + columnIndex * (columnWidth + columnGap);
    for (const group of columns[columnIndex]) {
      const cardHeight = drawFishCard(
        ctx,
        {
          title: formatActiveHours(group.hours),
          entries: group.entries,
        },
        x,
        y,
        columnWidth,
        {
          accent: group.hours[0][0] >= 16 ? PALETTE.violet : PALETTE.gold,
          tokenOptions,
        },
      );
      y += cardHeight + 20;
    }
  }

  drawPanel(ctx, 110, height - 205, WIDTH - 220, 92, {
    fill: "rgba(255, 250, 232, 0.91)",
    border: "rgba(169, 120, 45, 0.28)",
  });
  drawTextBlock(
    ctx,
    "提示：跨午夜时段已合并成“当日–次日”写法；本图仅列非全天出没的渔获。",
    150,
    height - 153,
    WIDTH - 300,
    { fontSize: 24, lineHeight: 34, color: PALETTE.gold, bold: true, maxLines: 2 },
  );
  drawFooter(ctx, height);
  return savePoster(canvas, "01-fish-time.jpg");
}

async function generateLocationWeatherGuide() {
  const height = 3000;
  const { canvas, ctx } = await createPoster(height, "light");
  const limitedFish = fishData.filter(
    (fish) => (
      fish.rarity !== "噩梦" &&
      Array.isArray(fish.locations) &&
      fish.locations.length > 0
    ),
  );
  const grouped = new Map();
  for (const fish of limitedFish) {
    const key = locationGroupKey(fish.locations);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(fish);
  }
  const singleGroups = LOCATION_ORDER.map((id) => ({
    key: id,
    entries: grouped.get(id) || [],
  }));
  const crossGroups = [...grouped.entries()]
    .filter(([key]) => key.includes("+"))
    .map(([key, entries]) => ({ key, entries }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const weatherLimited = fishData.filter(
    (fish) => (
      fish.is_boss !== true &&
      Array.isArray(fish.weather) &&
      fish.weather.length > 0
    ),
  );
  const weatherGroups = new Map();
  for (const fish of weatherLimited) {
    const key = [...fish.weather].sort().join("/");
    if (!weatherGroups.has(key)) weatherGroups.set(key, []);
    weatherGroups.get(key).push(fish);
  }

  drawHeader(
    ctx,
    "限定出没地点与天气",
    `地点限定 ${limitedFish.length} 种 · 天气限定 ${weatherLimited.length} 种`,
    { tag: "条件篇", accent: PALETTE.blue },
  );
  drawSectionTitle(ctx, "单钓点限定", 96, 294, WIDTH - 192, {
    color: PALETTE.blue,
    subtitle: "仅列严格受钓点限制的渔获",
  });

  const columns = 3;
  const gap = 22;
  const cardWidth = (WIDTH - 192 - gap * (columns - 1)) / columns;
  const mainTop = 374;
  const mainHeight = 480;
  for (const [index, group] of singleGroups.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    drawFishCard(
      ctx,
      {
        title: locationGroupTitle(group.key),
        entries: group.entries,
      },
      96 + column * (cardWidth + gap),
      mainTop + row * (mainHeight + 24),
      cardWidth,
      {
        accent: [PALETTE.pink, PALETTE.green, PALETTE.violet, PALETTE.gold, PALETTE.blue, "#735FA7"][index],
        tokenOptions: {
          fontSize: 18,
          tokenHeight: 34,
          horizontalGap: 7,
          verticalGap: 7,
          paddingX: 10,
        },
        minHeight: mainHeight,
      },
    );
  }

  const crossSectionY = mainTop + mainHeight * 2 + 24 + 82;
  drawSectionTitle(ctx, "双钓点交叉限定", 96, crossSectionY, WIDTH - 192, {
    color: PALETTE.green,
    subtitle: "只会出现在卡片写明的两个钓点",
  });
  const crossTop = crossSectionY + 80;
  const crossHeight = 190;
  for (const [index, group] of crossGroups.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    drawFishCard(
      ctx,
      {
        title: locationGroupTitle(group.key),
        entries: group.entries,
      },
      96 + column * (cardWidth + gap),
      crossTop + row * (crossHeight + 20),
      cardWidth,
      {
        accent: PALETTE.green,
        tokenOptions: {
          fontSize: 18,
          tokenHeight: 34,
          horizontalGap: 7,
          verticalGap: 7,
          paddingX: 10,
        },
        minHeight: crossHeight,
      },
    );
  }

  const weatherSectionY = crossTop +
    Math.ceil(crossGroups.length / columns) * (crossHeight + 20) +
    52;
  drawSectionTitle(ctx, "天气限定出没", 96, weatherSectionY, WIDTH - 192, {
    color: PALETTE.violet,
    subtitle: "只展示出没条件，不展示天气概率与倍率",
  });
  const weatherTop = weatherSectionY + 80;
  const weatherCardHeight = 190;
  for (const [index, [weather, entries]] of [...weatherGroups.entries()].entries()) {
    const x = 96 + (index % columns) * (cardWidth + gap);
    const y = weatherTop + Math.floor(index / columns) * (weatherCardHeight + 20);
    drawFishCard(
      ctx,
      {
        title: `${WEATHER_CONFIG[weather]?.emoji || ""} ${weather}限定`,
        entries,
      },
      x,
      y,
      cardWidth,
      {
        accent: PALETTE.violet,
        tokenOptions: {
          fontSize: 18,
          tokenHeight: 34,
          horizontalGap: 7,
          verticalGap: 7,
          paddingX: 10,
        },
        minHeight: weatherCardHeight,
      },
    );
  }

  const noteY = weatherTop +
    Math.ceil(weatherGroups.size / columns) * (weatherCardHeight + 20) +
    36;
  drawPanel(ctx, 110, noteY, WIDTH - 220, 150, {
    fill: "rgba(238, 232, 247, 0.94)",
    border: "rgba(117, 80, 142, 0.28)",
  });
  drawTextBlock(
    ctx,
    "同一渔获可能同时受时间、天气与地点限制，请与“限定出没时间”图交叉查看；未列出的渔获不受对应条件限制。",
    150,
    noteY + 55,
    WIDTH - 300,
    { fontSize: 23, lineHeight: 35, color: PALETTE.violet, bold: true, maxLines: 2 },
  );
  drawFooter(ctx, height, "数据以当前游戏配置为准 · 本图不公开天气概率与倍率");
  return savePoster(canvas, "02-fish-location-weather.jpg");
}

async function generateWeatherGuide() {
  const height = 2300;
  const { canvas, ctx } = await createPoster(height, "light");
  const weatherLimited = fishData.filter(
    (fish) => Array.isArray(fish.weather) && fish.weather.length > 0,
  );
  const weatherGroups = new Map();
  for (const fish of weatherLimited) {
    const key = [...fish.weather].sort().join("/");
    if (!weatherGroups.has(key)) weatherGroups.set(key, []);
    weatherGroups.get(key).push(fish);
  }

  drawHeader(
    ctx,
    "天气倍率说明",
    "天气每小时随机一次 · 全钓点共享",
    { tag: "天气篇", accent: PALETTE.blue },
  );
  drawSectionTitle(ctx, "倍率与出现概率", 96, 294, WIDTH - 192, {
    color: PALETTE.blue,
    subtitle: "困难度、有效重量、售价、经验使用同一倍率",
  });

  const weatherEntries = Object.entries(WEATHER_CONFIG);
  const columns = 3;
  const gap = 22;
  const cardWidth = (WIDTH - 192 - gap * 2) / columns;
  const cardHeight = 300;
  const top = 374;
  const weatherAccents = ["#E29B35", "#6F8294", "#4D88B8", "#72879A", "#6D5CA1", "#7196B4"];
  for (const [index, [name, config]] of weatherEntries.entries()) {
    const x = 96 + (index % columns) * (cardWidth + gap);
    const y = top + Math.floor(index / columns) * (cardHeight + 22);
    const accent = weatherAccents[index];
    drawPanel(ctx, x, y, cardWidth, cardHeight);
    ctx.save();
    ctx.fillStyle = accent;
    ctx.font = `bold 38px ${FONT}`;
    ctx.fillText(`${config.emoji} ${name}`, x + 28, y + 58);
    drawPill(ctx, `概率 ${config.weight}%`, x + cardWidth - 24, y + 22, {
      align: "right",
      fontSize: 18,
      height: 35,
      fill: `${accent}1E`,
      color: accent,
    });
    ctx.fillStyle = PALETTE.secondary;
    ctx.font = `23px ${FONT}`;
    const rows = [
      ["困难度", config.difficultyMultiplier],
      ["有效重量", config.weightMultiplier],
      ["金币售价", config.priceMultiplier],
      ["钓鱼经验", config.expMultiplier],
    ];
    rows.forEach(([label, value], rowIndex) => {
      const rowY = y + 105 + rowIndex * 43;
      ctx.fillText(label, x + 34, rowY);
      ctx.fillStyle = value > 1 ? PALETTE.green : value < 1 ? PALETTE.red : PALETTE.secondary;
      ctx.font = `bold 25px ${FONT}`;
      ctx.textAlign = "right";
      ctx.fillText(`×${Number(value).toFixed(value === 1 ? 0 : 2).replace(/0$/, "")}`, x + cardWidth - 34, rowY);
      ctx.textAlign = "left";
      ctx.fillStyle = PALETTE.secondary;
      ctx.font = `23px ${FONT}`;
    });
    ctx.restore();
  }

  const limitedSectionY = top + cardHeight * 2 + 22 + 82;
  drawSectionTitle(ctx, "天气限定渔获", 96, limitedSectionY, WIDTH - 192, {
    color: PALETTE.violet,
    subtitle: `仅列出 ${weatherLimited.length} 种带天气标记的渔获`,
  });
  const limitedTop = limitedSectionY + 78;
  const limitedCardHeight = 190;
  for (const [index, [weather, entries]] of [...weatherGroups.entries()].entries()) {
    const x = 96 + (index % columns) * (cardWidth + gap);
    const y = limitedTop + Math.floor(index / columns) * (limitedCardHeight + 20);
    drawFishCard(
      ctx,
      { title: `${WEATHER_CONFIG[weather]?.emoji || ""} ${weather}限定`, entries },
      x,
      y,
      cardWidth,
      {
        accent: PALETTE.violet,
        tokenOptions: {
          fontSize: 18,
          tokenHeight: 34,
          horizontalGap: 7,
          verticalGap: 7,
          paddingX: 10,
        },
        minHeight: limitedCardHeight,
      },
    );
  }

  drawPanel(ctx, 110, height - 322, WIDTH - 220, 204, {
    fill: "rgba(232, 241, 249, 0.95)",
    border: "rgba(68, 110, 157, 0.3)",
  });
  drawTextBlock(
    ctx,
    "规则速记",
    150,
    height - 266,
    260,
    { fontSize: 30, lineHeight: 40, color: PALETTE.blue, bold: true },
  );
  drawTextBlock(
    ctx,
    "• 晴天更轻、更容易，但收益也低；雷暴收益最高，同时最难。\n• 雾灯只把个人天气固定为雾，并屏蔽垃圾与噩梦，不改变群内天气播报。\n• 首领与鱼雷爆破收获不吃天气重量、难度或收益倍率。",
    390,
    height - 273,
    WIDTH - 550,
    { fontSize: 22, lineHeight: 36, color: PALETTE.secondary, maxLines: 6 },
  );
  drawFooter(ctx, height);
  return savePoster(canvas, "03-weather-multipliers.jpg");
}

async function generateBossGuide() {
  const height = 2400;
  const { canvas, ctx } = await createPoster(height, "dark");
  const bosses = fishData.filter((fish) => fish.is_boss === true);

  drawHeader(
    ctx,
    "钓点首领通用说明",
    "仅说明共同规则 · 各首领特殊机制以战斗提示为准",
    { tag: "首领篇", accent: PALETTE.red },
  );

  const bossTop = 314;
  const cellWidth = (WIDTH - 180) / bosses.length;
  for (const [index, boss] of bosses.entries()) {
    const locationId = boss.locations?.[0];
    const centerX = 90 + cellWidth * index + cellWidth / 2;
    await drawImageContain(
      ctx,
      itemImagePath(boss.id),
      centerX - 78,
      bossTop,
      156,
      156,
      { radius: 78, background: "rgba(255,255,255,0.86)", inset: 4 },
    );
    ctx.save();
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `bold 22px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(boss.name, centerX, bossTop + 190);
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `19px ${FONT}`;
    ctx.fillText(FISHING_LOCATIONS[locationId]?.name || "", centerX, bossTop + 220);
    ctx.restore();
  }

  drawSectionTitle(ctx, "从入场到胜利", 96, 565, WIDTH - 192, {
    color: PALETTE.red,
    subtitle: "每个钓点各有一名当地首领",
  });
  const flowCards = [
    {
      title: "1 · 准备鱼饵",
      text: "首领鱼饵为宝箱非卖品；装备后在任意已解锁钓点发送「#钓鱼」。",
    },
    {
      title: "2 · 通过重量判定",
      text: "下一竿必定呼出当地首领。咬钩后先回复「收竿」，鱼线承重仍需过关。",
    },
    {
      title: "3 · 60 秒战斗",
      text: "「拉」拉近距离并升张力；「溜」降张力但拉远；「攻」每 5 秒一次。",
    },
    {
      title: "4 · 双条件收尾",
      text: "必须让首领生命与距离同时归零；首领每 5 秒反击，超时或断线即失败。",
    },
  ];
  const flowGap = 18;
  const flowWidth = (WIDTH - 192 - flowGap * 3) / 4;
  for (const [index, card] of flowCards.entries()) {
    const x = 96 + index * (flowWidth + flowGap);
    const y = 645;
    drawPanel(ctx, x, y, flowWidth, 300, {
      fill: "rgba(255, 252, 252, 0.94)",
      border: "rgba(169, 72, 85, 0.26)",
    });
    ctx.fillStyle = PALETTE.red;
    ctx.font = `bold 27px ${FONT}`;
    ctx.fillText(card.title, x + 24, y + 52);
    drawTextBlock(ctx, card.text, x + 24, y + 98, flowWidth - 48, {
      fontSize: 22,
      lineHeight: 34,
      color: PALETTE.secondary,
      maxLines: 6,
    });
  }

  drawSectionTitle(ctx, "战斗共通规则", 96, 988, WIDTH - 192, {
    color: PALETTE.blue,
    subtitle: "鱼线耐久仅存在于本场，战斗结束后不保留",
  });
  drawPanel(ctx, 96, 1068, WIDTH - 192, 410, {
    fill: "rgba(248, 250, 253, 0.94)",
    border: "rgba(68, 110, 157, 0.28)",
  });
  const ruleColumns = [
    [
      ["攻", "伤害只读取当前鱼竿实际控制力，不叠加钓鱼等级隐藏战力。"],
      ["拉", "降低距离、提高张力；首领倒地后仍要继续拉到岸边。"],
      ["溜", "降低张力、增加距离；用来避免张力达到 100 断线。"],
    ],
    [
      ["临时鱼线耐久", "按鱼线承重生成；被首领反击打到 0 会立即断线。"],
      ["失败条件", "60 秒超时、鱼线断裂、距离回到 100，或鱼竿损毁。"],
      ["首领反击", "每 5 秒自动发生；击倒首领后停止继续反击。"],
    ],
  ];
  for (const [columnIndex, rules] of ruleColumns.entries()) {
    const x = 132 + columnIndex * 714;
    for (const [rowIndex, [label, text]] of rules.entries()) {
      const y = 1120 + rowIndex * 108;
      drawPill(ctx, label, x, y, {
        fontSize: 21,
        height: 38,
        fill: columnIndex === 0 ? PALETTE.blueSoft : PALETTE.violetSoft,
        color: columnIndex === 0 ? PALETTE.blue : PALETTE.violet,
      });
      drawTextBlock(ctx, text, x + 102, y + 28, 560, {
        fontSize: 20,
        lineHeight: 30,
        color: PALETTE.secondary,
        maxLines: 3,
      });
    }
  }

  drawSectionTitle(ctx, "加成与奖励边界", 96, 1520, WIDTH - 192, {
    color: PALETTE.gold,
    subtitle: "首领奖励走独立结算链",
  });
  drawPanel(ctx, 96, 1600, 690, 520, {
    fill: "rgba(255, 248, 241, 0.95)",
    border: "rgba(169, 120, 45, 0.3)",
  });
  ctx.fillStyle = PALETTE.red;
  ctx.font = `bold 31px ${FONT}`;
  ctx.fillText("不会生效", 130, 1658);
  drawTextBlock(
    ctx,
    "• 好运护符不能跳过首领重量判定\n• 天气不改变首领重量、难度或奖励\n• 完美收竿、双倍金币卡、怪物诱饵不加成\n• 精明商人收益加成与鱼雷鱼价加成不生效\n• 星愿瓶不会被首领鱼饵消耗，也不会改品质",
    132,
    1710,
    610,
    { fontSize: 21, lineHeight: 36, color: PALETTE.secondary, maxLines: 10 },
  );
  drawPanel(ctx, 814, 1600, 690, 520, {
    fill: "rgba(241, 249, 244, 0.95)",
    border: "rgba(57, 125, 90, 0.3)",
  });
  ctx.fillStyle = PALETTE.green;
  ctx.font = `bold 31px ${FONT}`;
  ctx.fillText("仍然生效 / 特别注意", 848, 1658);
  drawTextBlock(
    ctx,
    `• 河神垂青可阻止断线；触发时首领鱼饵按寻宝鱼饵价值折现\n• 随机异色仍可能出现（基础 ${Math.round(SHINY_CHANCE * 100)}%），异色首领金币 ×${SHINY_PRICE_MULTIPLIER}、经验 ×${SHINY_EXP_MULTIPLIER}\n• 锦鲤许愿签不能强制首领异色，却会在这次咬钩被消耗\n• 胜利获得：按首领重量结算金币 + 200 经验 + 当地宝箱 ×1`,
    850,
    1710,
    610,
    { fontSize: 21, lineHeight: 36, color: PALETTE.secondary, maxLines: 11 },
  );

  drawPanel(ctx, 190, 2150, WIDTH - 380, 122, {
    fill: "rgba(247, 229, 232, 0.95)",
    border: "rgba(169, 72, 85, 0.32)",
  });
  drawTextBlock(
    ctx,
    "一句话策略：先用「拉 / 溜」守住张力与距离，在「攻」冷却结束时补伤害；生命清零后别停，继续把距离拉到 0。",
    235,
    2203,
    WIDTH - 470,
    { fontSize: 25, lineHeight: 37, color: PALETTE.red, bold: true, maxLines: 2 },
  );
  drawFooter(ctx, height, "首领特殊机制不在本图展开 · 进入战斗后请以当场提示为准");
  return savePoster(canvas, "04-boss-guide.jpg");
}

const NIGHTMARE_TEXT = Object.freeze({
  rod_damage: {
    effect: "鱼竿耐久直接损耗 20 点。",
    counter: "事后用修理工具箱恢复；预防只能靠完整免疫。",
  },
  rod_control_loss: {
    effect: "当前鱼竿留下暗伤，控制力永久 -20；严重时鱼竿会断。",
    counter: "修理工具箱可恢复暗伤与耐久。",
  },
  steal_coins_flat: {
    effect: "偷走 1～200 樱花币；身无分文时改为鱼竿 -20 耐久。",
    counter: "控余额只能改变损失类型，不能免伤。",
  },
  steal_coins_percent: {
    effect: "吞掉当前余额的 1%～10%；余额为 0 时改为鱼竿 -20 耐久。",
    counter: "完整免疫最稳；空余额也并不安全。",
  },
  curse: {
    effect: "附加 1 层诅咒；之后每抛一竿再 +1 层，每层让噩梦权重 +1。",
    counter: "钓到任意噩梦会清旧诅咒；净化圣水可直接清除。",
  },
  nightmare_weight_multiplier: {
    effect: "花嫁印记累计生效：每层让噩梦抽取权重再 ×2。",
    counter: "净化圣水清除全部花嫁印记；雾灯可临时屏蔽噩梦。",
  },
  steal_bait: {
    effect: "偷走背包里价值最高的鱼饵 ×1；没鱼饵时改为鱼竿 -20 耐久。",
    counter: "提前整理鱼饵只能降损；完整免疫可彻底挡下。",
  },
  stamina_crush: {
    effect: "按当前体力反噬鱼竿（最多 20 点），并把钓鱼体力强制压到 1。",
    counter: "低体力可降低竿损；工具箱负责修竿。",
  },
  ghost_debt: {
    effect: `先给 200 币并欠 200；渔获先抵债，每竿未清部分 ×${GHOST_DEBT_INTEREST_RATE}，到 ${GHOST_DEBT_WRITE_OFF_THRESHOLD} 后改为永久 -${Math.round(GHOST_DEBT_MARK_PENALTY_RATE * 100)}% 垂钓收益。`,
    counter: "尽快用渔获还清，或用净化圣水清掉债务与印记。",
  },
  deep_pressure: {
    effect: "永久累加 1 层深压；每层让鱼竿实际控制力再 ×0.8。",
    counter: "修理工具箱或净化圣水都能清除全部深压。",
  },
  devour_inventory: {
    effect: "按背包物品件数随机吞掉 1 件（当前装备鱼竿除外）；没有可吞噽物品时鱼竿 -20 耐久。",
    counter: "整理贵重库存可降风险；完整免疫可完全挡下。",
  },
});

async function generateNightmareGuide() {
  const height = 3000;
  const { canvas, ctx } = await createPoster(height, "dark");
  const nightmares = fishData.filter((fish) => fish.rarity === "噩梦");

  drawHeader(
    ctx,
    "噩梦效果与反制",
    `${nightmares.length} 种噩梦 · 其中 6 种为当地怪谈`,
    { tag: "噩梦篇", accent: PALETTE.violet },
  );
  drawPanel(ctx, 96, 292, WIDTH - 192, 124, {
    fill: "rgba(245, 239, 249, 0.94)",
    border: "rgba(117, 80, 142, 0.3)",
  });
  drawTextBlock(
    ctx,
    "共同代价：成功钓到噩梦时，鱼线会先断；深渊猎手完整免疫或河神垂青可以保线，但河神垂青不会阻止噩梦效果。",
    138,
    346,
    WIDTH - 276,
    { fontSize: 24, lineHeight: 36, color: PALETTE.violet, bold: true, maxLines: 2 },
  );

  const columns = 2;
  const gap = 24;
  const cardWidth = (WIDTH - 192 - gap) / columns;
  const cardHeight = 292;
  const startY = 448;
  for (const [index, fish] of nightmares.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = 96 + column * (cardWidth + gap);
    const y = startY + row * (cardHeight + 18);
    const locationId = fish.locations?.length === 1 ? fish.locations[0] : null;
    const meta = NIGHTMARE_TEXT[fish.nightmare_effect?.type] || {
      effect: fish.description,
      counter: "优先使用雾灯或深渊猎手完整免疫。",
    };
    drawPanel(ctx, x, y, cardWidth, cardHeight, {
      fill: "rgba(250, 250, 252, 0.94)",
      border: locationId
        ? "rgba(169, 72, 85, 0.3)"
        : "rgba(117, 80, 142, 0.24)",
    });
    await drawImageContain(ctx, itemImagePath(fish.id), x + 22, y + 24, 118, 118, {
      radius: 22,
      background: "rgba(236, 232, 241, 0.95)",
      inset: 3,
    });
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText(fish.name, x + 162, y + 60);
    drawPill(
      ctx,
      locationId ? `${FISHING_LOCATIONS[locationId].name}·当地怪谈` : "通用噩梦",
      x + 162,
      y + 80,
      {
        fontSize: 17,
        height: 34,
        paddingX: 12,
        fill: locationId ? PALETTE.redSoft : PALETTE.violetSoft,
        color: locationId ? PALETTE.red : PALETTE.violet,
      },
    );
    ctx.fillStyle = PALETTE.red;
    ctx.font = `bold 20px ${FONT}`;
    ctx.fillText("效果", x + 26, y + 176);
    drawTextBlock(ctx, meta.effect, x + 88, y + 176, cardWidth - 116, {
      fontSize: 19,
      lineHeight: 28,
      color: PALETTE.secondary,
      maxLines: 3,
    });
    ctx.fillStyle = PALETTE.green;
    ctx.font = `bold 20px ${FONT}`;
    ctx.fillText("反制", x + 26, y + 258);
    drawTextBlock(ctx, meta.counter, x + 88, y + 258, cardWidth - 116, {
      fontSize: 19,
      lineHeight: 28,
      color: PALETTE.secondary,
      maxLines: 2,
    });
  }

  const ruleX = 96 + (cardWidth + gap);
  const ruleY = startY + 5 * (cardHeight + 18);
  drawPanel(ctx, ruleX, ruleY, cardWidth, cardHeight, {
    fill: "rgba(238, 244, 250, 0.95)",
    border: "rgba(68, 110, 157, 0.3)",
  });
  ctx.fillStyle = PALETTE.blue;
  ctx.font = `bold 30px ${FONT}`;
  ctx.fillText("当地怪谈怎么抽？", ruleX + 28, ruleY + 56);
  drawTextBlock(
    ctx,
    "当稀有度已经抽到“噩梦”时：当前钓点的当地怪谈占 40%，剩余 60% 在其他所有噩梦中均分。因此“当地怪谈”不是绝对地点封锁。",
    ruleX + 28,
    ruleY + 106,
    cardWidth - 56,
    { fontSize: 21, lineHeight: 33, color: PALETTE.secondary, maxLines: 6 },
  );

  const counterY = startY + 6 * (cardHeight + 18) + 14;
  drawSectionTitle(ctx, "反制优先级", 96, counterY, WIDTH - 192, {
    color: PALETTE.green,
    subtitle: "预防 > 完整免疫 > 保线 > 事后清理",
  });
  drawPanel(ctx, 96, counterY + 80, WIDTH - 192, 480, {
    fill: "rgba(241, 249, 244, 0.96)",
    border: "rgba(57, 125, 90, 0.32)",
  });
  const counters = [
    ["1 · 雾灯", "35 分钟内个人天气固定为雾，同时把垃圾与噩梦权重归零；最直接的预防。"],
    ["2 · 深渊猎手", "充能触发时，噩梦伤害、偷取、状态与断线全部免疫；1级最多1次/24小时，2级最多2次/12小时恢复1次。"],
    ["3 · 河神垂青", "只保住鱼线并给予折现奖励，噩梦本体效果照常生效。"],
    ["4 · 净化圣水", "清诅咒、花嫁印记、亡者债务/抽成印记与深压；不修鱼竿暗伤。"],
    ["5 · 修理工具箱", "修满耐久、修复骸骨鲨暗伤，并清除全部深压；不清花嫁、诅咒或债务。"],
  ];
  for (const [index, [label, text]] of counters.entries()) {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 132 + column * 710;
    const y = counterY + 134 + row * 112;
    drawPill(ctx, label, x, y, {
      fontSize: 20,
      height: 38,
      fill: PALETTE.greenSoft,
      color: PALETTE.green,
    });
    drawTextBlock(ctx, text, x, y + 72, 650, {
      fontSize: 19,
      lineHeight: 29,
      color: PALETTE.secondary,
      maxLines: 3,
    });
  }
  drawFooter(ctx, height, "即时偷取无法靠事后道具追回 · 重要物品请在高风险垂钓前妥善整理");
  return savePoster(canvas, "05-nightmare-effects.jpg");
}

const ITEM_GUIDE_TEXT = Object.freeze({
  item_charm_lucky: "35分钟内必定上钩，可跳过普通渔获的重量与难度判定；仍需5秒内操作才算完美收竿。",
  item_toolkit_repair: "立即修满当前鱼竿耐久、修复骸骨鲨暗伤，并清除全部深压回响。",
  item_holy_water: "立即清除骷髅诅咒、花嫁印记、亡者债务/抽成印记与深压回响。",
  item_sand_time: "35分钟内把每竿钓鱼冷却从5分钟缩短到2分30秒。",
  bait_boss: "宝箱非卖品。装备后下一竿必定呼出当前钓点首领；每次消耗1个。",
  torpedo: `每人最多埋1枚。被别人钓中：鱼竿-${TORPEDO_ROD_DAMAGE}、断线，钓点鱼价35分钟×${TORPEDO_PRICE_BOOST_MULTIPLIER}；满${Math.round(TORPEDO_ARM_DURATION_MS / 3600000)}小时可自爆，获得当地随机${TORPEDO_BLAST_CATCH_COUNT}条鱼并使鱼价×${TORPEDO_DETONATE_PRICE_MULTIPLIER}。`,
  item_sign_koi: "35分钟内下一次咬钩必定异色；宝藏、噩梦、鱼雷、首领不适用，但仍会消耗许愿签。",
  item_charm_river: "35分钟内鱼线永不断裂；每次成功保线，会按本竿鱼饵市价获得等额樱花币。",
  item_lamp_fog: "35分钟内个人天气固定为雾，享受雾倍率，同时不会钓到垃圾或噩梦。",
  item_card_double_coin: "35分钟内普通垂钓金币收益×2；首领奖励不吃该倍率。",
  item_bait_monster: "35分钟内噩梦权重+50，普通垂钓金币与经验×3；首领奖励不吃该倍率。",
  item_bottle_wish: "使用时指定任意品质；35分钟内下一次普通咬钩必定为该品质。首领鱼饵不会消耗星愿。",
});

async function drawItemCard(ctx, item, x, y, width, height, meta) {
  const { scope, accent, text } = meta;
  drawPanel(ctx, x, y, width, height, {
    fill: "rgba(255, 253, 252, 0.95)",
    border: `${accent}38`,
  });
  await drawImageContain(ctx, itemImagePath(item.id), x + 22, y + 24, 112, 112, {
    radius: 22,
    background: `${accent}16`,
    inset: 4,
  });
  ctx.fillStyle = PALETTE.ink;
  ctx.font = `bold 29px ${FONT}`;
  ctx.fillText(item.name, x + 156, y + 58);
  drawPill(ctx, scope, x + 156, y + 78, {
    fontSize: 17,
    height: 33,
    paddingX: 12,
    fill: `${accent}18`,
    color: accent,
  });
  drawTextBlock(ctx, text, x + 24, y + 164, width - 48, {
    fontSize: 20,
    lineHeight: 30,
    color: PALETTE.secondary,
    maxLines: 4,
  });
}

async function generateItemGuide() {
  const height = 2700;
  const { canvas, ctx } = await createPoster(height, "light");
  const specialItems = getSpecialItems();
  const commonIds = [
    "item_charm_lucky",
    "item_toolkit_repair",
    "item_holy_water",
    "item_sand_time",
  ];
  const localIds = [
    "item_sign_koi",
    "item_charm_river",
    "item_lamp_fog",
    "item_card_double_coin",
    "item_bait_monster",
    "item_bottle_wish",
  ];
  const localById = Object.fromEntries(
    LOCATION_ORDER.map((locationId, index) => [localIds[index], locationId]),
  );
  const commonItems = commonIds
    .map((id) => specialItems.find((item) => item.id === id))
    .filter(Boolean);
  commonItems.push(
    findShopItem("bait_boss"),
    findShopItem("torpedo"),
  );
  const localItems = localIds
    .map((id) => specialItems.find((item) => item.id === id))
    .filter(Boolean);

  drawHeader(
    ctx,
    "钓鱼道具效果总览",
    "特殊道具、首领鱼饵、鱼雷与钓点藏品",
    { tag: "道具篇", accent: PALETTE.pink },
  );
  drawSectionTitle(ctx, "通用 / 商店道具", 96, 294, WIDTH - 192, {
    color: PALETTE.pink,
    subtitle: "可在任意钓点使用",
  });

  const gap = 24;
  const cardWidth = (WIDTH - 192 - gap) / 2;
  const cardHeight = 248;
  const commonTop = 374;
  for (const [index, item] of commonItems.entries()) {
    if (!item) continue;
    const x = 96 + (index % 2) * (cardWidth + gap);
    const y = commonTop + Math.floor(index / 2) * (cardHeight + 18);
    const scope = item.id === "bait_boss"
      ? "通用·宝箱非卖品"
      : item.id === "torpedo"
        ? "通用·商店"
        : "通用·宝箱";
    await drawItemCard(ctx, item, x, y, cardWidth, cardHeight, {
      scope,
      accent: item.id === "torpedo" ? PALETTE.red : PALETTE.pink,
      text: ITEM_GUIDE_TEXT[item.id],
    });
  }

  const localSectionY = commonTop + 3 * (cardHeight + 18) + 36;
  drawSectionTitle(ctx, "钓点专属功能道具", 96, localSectionY, WIDTH - 192, {
    color: PALETTE.blue,
    subtitle: "均来自对应钓点宝箱，效果持续35分钟或等待下一次咬钩",
  });
  const localTop = localSectionY + 80;
  for (const [index, item] of localItems.entries()) {
    const x = 96 + (index % 2) * (cardWidth + gap);
    const y = localTop + Math.floor(index / 2) * (cardHeight + 18);
    const locationId = localById[item.id];
    await drawItemCard(ctx, item, x, y, cardWidth, cardHeight, {
      scope: `${FISHING_LOCATIONS[locationId].name}专属`,
      accent: PALETTE.blue,
      text: ITEM_GUIDE_TEXT[item.id],
    });
  }

  const treasureSectionY = localTop + 3 * (cardHeight + 18) + 38;
  drawSectionTitle(ctx, "钓点藏品与宝箱", 96, treasureSectionY, WIDTH - 192, {
    color: PALETTE.gold,
    subtitle: "藏品没有主动效果，可出售；宝箱发送「#开宝箱」开启",
  });
  drawPanel(ctx, 96, treasureSectionY + 80, WIDTH - 192, 288, {
    fill: "rgba(255, 250, 235, 0.95)",
    border: "rgba(169, 120, 45, 0.3)",
  });
  const treasures = getTreasureItems();
  const treasureCellWidth = (WIDTH - 240) / treasures.length;
  for (const [index, treasure] of treasures.entries()) {
    const x = 120 + index * treasureCellWidth;
    await drawImageContain(ctx, itemImagePath(treasure.id), x + 24, treasureSectionY + 105, 112, 112, {
      radius: 20,
      background: PALETTE.goldSoft,
      inset: 5,
    });
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `bold 19px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(treasure.name, x + treasureCellWidth / 2, treasureSectionY + 242);
    ctx.fillStyle = PALETTE.gold;
    ctx.font = `18px ${FONT}`;
    ctx.fillText(`${FISHING_LOCATIONS[LOCATION_ORDER[index]].name} · 售价 ${treasure.sell_price}`, x + treasureCellWidth / 2, treasureSectionY + 272);
  }
  ctx.textAlign = "left";

  drawPanel(ctx, 130, height - 210, WIDTH - 260, 92, {
    fill: "rgba(249, 227, 236, 0.94)",
    border: "rgba(200, 79, 131, 0.28)",
  });
  drawTextBlock(
    ctx,
    "范围说明：本图覆盖全部“特殊物品”、首领鱼饵、鱼雷与钓点藏品；常规鱼竿、鱼线、普通鱼饵的数值请查看「#商店」。",
    170,
    height - 157,
    WIDTH - 340,
    { fontSize: 23, lineHeight: 34, color: PALETTE.pink, bold: true, maxLines: 2 },
  );
  drawFooter(ctx, height);
  return savePoster(canvas, "06-item-effects.jpg");
}

async function generateUnlockGuide() {
  const height = 2200;
  const { canvas, ctx } = await createPoster(height, "light");

  drawHeader(
    ctx,
    "钓点解锁等级",
    "提升钓鱼等级，依次开放六片水域",
    { tag: "解锁篇", accent: PALETTE.green },
  );
  drawSectionTitle(ctx, "水域开放路线", 96, 294, WIDTH - 192, {
    color: PALETTE.green,
    subtitle: "钓点只改变物种池，不额外提高同稀有度渔获强度",
  });

  const entries = Object.entries(FISHING_LOCATIONS);
  const gap = 24;
  const cardWidth = (WIDTH - 192 - gap) / 2;
  const cardHeight = 440;
  const top = 380;
  const accents = [PALETTE.pink, PALETTE.green, PALETTE.violet, PALETTE.gold, PALETTE.blue, "#735FA7"];
  for (const [index, [locationId, location]] of entries.entries()) {
    const x = 96 + (index % 2) * (cardWidth + gap);
    const y = top + Math.floor(index / 2) * (cardHeight + 24);
    const accent = accents[index];
    drawPanel(ctx, x, y, cardWidth, cardHeight, {
      fill: "rgba(255, 253, 252, 0.95)",
      border: `${accent}38`,
    });
    await drawImageContain(ctx, itemImagePath(`chest_${locationId}`), x + 30, y + 34, 158, 158, {
      radius: 28,
      background: `${accent}16`,
      inset: 5,
    });
    drawPill(ctx, `Lv.${location.unlockLevel} 解锁`, x + 218, y + 44, {
      fontSize: 23,
      height: 46,
      fill: `${accent}1C`,
      color: accent,
    });
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `bold 39px ${FONT}`;
    ctx.fillText(`${location.emoji} ${location.name}`, x + 218, y + 142);
    drawTextBlock(ctx, location.description, x + 32, y + 240, cardWidth - 64, {
      fontSize: 24,
      lineHeight: 37,
      color: PALETTE.secondary,
      maxLines: 3,
    });
    const localCount = getLocationFish(locationId).length;
    drawPill(ctx, `地点图鉴 ${localCount} 种`, x + 32, y + 353, {
      fontSize: 20,
      height: 40,
      fill: PALETTE.blueSoft,
      color: PALETTE.blue,
    });
    drawPill(ctx, `${LOCATION_SHORT[locationId]}宝箱`, x + cardWidth - 30, y + 353, {
      align: "right",
      fontSize: 20,
      height: 40,
      fill: PALETTE.goldSoft,
      color: PALETTE.gold,
    });
  }

  drawPanel(ctx, 120, height - 330, WIDTH - 240, 210, {
    fill: "rgba(241, 249, 244, 0.95)",
    border: "rgba(57, 125, 90, 0.3)",
  });
  ctx.fillStyle = PALETTE.green;
  ctx.font = `bold 30px ${FONT}`;
  ctx.fillText("如何切换", 160, height - 270);
  drawTextBlock(
    ctx,
    "发送「#钓点」查看当前解锁情况；发送「#前往钓点 樱花池塘 / 青柳河湾 / 雾隐湖 / 落日海岸 / 深渊海沟 / 星辉秘境」切换。钓鱼过程中不能切换钓点。",
    330,
    height - 273,
    WIDTH - 500,
    { fontSize: 24, lineHeight: 38, color: PALETTE.secondary, maxLines: 4 },
  );
  drawFooter(ctx, height);
  return savePoster(canvas, "03-location-unlocks.jpg");
}

async function generateRewardsGuide() {
  const height = 2550;
  const { canvas, ctx } = await createPoster(height, "light");
  const locationTotals = Object.fromEntries(
    LOCATION_ORDER.map((locationId) => [locationId, getLocationFish(locationId).length]),
  );
  const sampleTiers = getDexLocationRewardTiers("pond", locationTotals.pond);

  drawHeader(
    ctx,
    "图鉴与等级奖励",
    "收录地点图鉴、每5级领取一档自救物资",
    { tag: "奖励篇", accent: PALETTE.gold },
  );

  drawSectionTitle(ctx, "图鉴如何记录", 96, 294, WIDTH - 192, {
    color: PALETTE.blue,
    subtitle: "发送「#钓鱼图鉴」或「#钓鱼图鉴 钓点名」",
  });
  drawPanel(ctx, 96, 374, WIDTH - 192, 330, {
    fill: "rgba(242, 248, 252, 0.95)",
    border: "rgba(68, 110, 157, 0.3)",
  });
  const states = [
    ["未发现", "从未咬钩", "#A7A0A5"],
    ["已目击", "咬钩后逃脱，尚未成功", PALETTE.violet],
    ["已收录", "至少成功钓获1次", PALETTE.green],
    ["异色点亮", "成功钓到异色个体", PALETTE.gold],
  ];
  const stateWidth = (WIDTH - 260) / states.length;
  for (const [index, [label, text, accent]] of states.entries()) {
    const x = 130 + index * stateWidth;
    drawPill(ctx, label, x + 16, 414, {
      fontSize: 22,
      height: 42,
      fill: `${accent}1A`,
      color: accent,
    });
    drawTextBlock(ctx, text, x + 16, 505, stateWidth - 32, {
      fontSize: 21,
      lineHeight: 32,
      color: PALETTE.secondary,
      maxLines: 3,
    });
  }
  drawTextBlock(
    ctx,
    "最大重量只在成功钓获时刷新；鱼雷爆破收获不计入图鉴。指定钓点时只展示带该钓点标记的渔获，通用鱼不占地点图鉴分母。",
    138,
    638,
    WIDTH - 276,
    { fontSize: 22, lineHeight: 34, color: PALETTE.blue, bold: true, maxLines: 2 },
  );

  drawSectionTitle(ctx, "地点图鉴进度", 96, 746, WIDTH - 192, {
    color: PALETTE.pink,
    subtitle: "六个钓点各自独立领取",
  });
  const progressTop = 826;
  const progressGap = 18;
  const progressWidth = (WIDTH - 192 - progressGap * 2) / 3;
  const progressHeight = 176;
  for (const [index, locationId] of LOCATION_ORDER.entries()) {
    const location = FISHING_LOCATIONS[locationId];
    const x = 96 + (index % 3) * (progressWidth + progressGap);
    const y = progressTop + Math.floor(index / 3) * (progressHeight + 18);
    drawPanel(ctx, x, y, progressWidth, progressHeight, {
      fill: "rgba(255, 253, 252, 0.95)",
    });
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `bold 27px ${FONT}`;
    ctx.fillText(`${location.emoji} ${location.name}`, x + 24, y + 50);
    drawPill(ctx, `全收录 ${locationTotals[locationId]} 种`, x + 24, y + 78, {
      fontSize: 18,
      height: 36,
      fill: PALETTE.pinkSoft,
      color: PALETTE.pink,
    });
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `19px ${FONT}`;
    ctx.fillText("阶段：10 / 20 / 30 / 全收录", x + 24, y + 151);
  }

  const tierSectionY = progressTop + progressHeight * 2 + 18 + 70;
  drawSectionTitle(ctx, "地点图鉴奖励档位", 96, tierSectionY, WIDTH - 192, {
    color: PALETTE.gold,
    subtitle: "发送「#领取图鉴奖励 [钓点名]」",
  });
  const tiers = [
    {
      label: "收录 10 种",
      reward: "当地宝箱 ×1",
      imageId: "chest_pond",
    },
    {
      label: "收录 20 种",
      reward: "当地宝箱 ×2",
      imageId: "chest_pond",
    },
    {
      label: "收录 30 种",
      reward: "当地功能道具 ×1 + 当地宝箱 ×1",
      imageId: "item_sign_koi",
    },
    {
      label: "当地全收录",
      reward: `首领鱼饵 ×2 + 当地藏品 ×1 + ${DEX_LOCATION_FULL_COIN_REWARD} 樱花币`,
      imageId: "bait_boss",
    },
  ];
  const tierTop = tierSectionY + 80;
  const tierGap = 18;
  const tierWidth = (WIDTH - 192 - tierGap * 3) / 4;
  for (const [index, tier] of tiers.entries()) {
    const x = 96 + index * (tierWidth + tierGap);
    drawPanel(ctx, x, tierTop, tierWidth, 350, {
      fill: "rgba(255, 250, 235, 0.95)",
      border: "rgba(169, 120, 45, 0.3)",
    });
    await drawImageContain(ctx, itemImagePath(tier.imageId), x + (tierWidth - 126) / 2, tierTop + 28, 126, 126, {
      radius: 24,
      background: PALETTE.goldSoft,
      inset: 5,
    });
    ctx.fillStyle = PALETTE.gold;
    ctx.font = `bold 25px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(tier.label, x + tierWidth / 2, tierTop + 196);
    drawTextBlock(ctx, tier.reward, x + 24, tierTop + 244, tierWidth - 48, {
      fontSize: 21,
      lineHeight: 32,
      color: PALETTE.secondary,
      bold: true,
      align: "center",
      maxLines: 3,
    });
  }
  ctx.textAlign = "left";

  const levelSectionY = tierTop + 398;
  drawSectionTitle(ctx, "钓鱼等级里程碑奖励", 96, levelSectionY, WIDTH - 192, {
    color: PALETTE.green,
    subtitle: `每 ${FISHING_LEVEL_REWARD_STEP} 级一档，不设上限`,
  });
  drawPanel(ctx, 96, levelSectionY + 80, WIDTH - 192, 390, {
    fill: "rgba(241, 249, 244, 0.96)",
    border: "rgba(57, 125, 90, 0.3)",
  });
  const rewardIds = FISHING_LEVEL_REWARD_ITEMS.map((reward) => reward.itemId);
  await drawImageContain(ctx, itemImagePath(rewardIds[0]), 150, levelSectionY + 122, 150, 150, {
    radius: 26,
    background: PALETTE.greenSoft,
    inset: 6,
  });
  await drawImageContain(ctx, itemImagePath(rewardIds[1]), 326, levelSectionY + 122, 150, 150, {
    radius: 26,
    background: PALETTE.blueSoft,
    inset: 6,
  });
  ctx.fillStyle = PALETTE.green;
  ctx.font = `bold 32px ${FONT}`;
  ctx.fillText(`Lv.5 / 10 / 15 / 20 / …`, 530, levelSectionY + 144);
  drawTextBlock(
    ctx,
    "每一档：修理工具箱 ×1 + 净化圣水 ×1\n发送「#领取钓鱼等级奖励」会一次结算所有尚未领取的已达成档位；每档需要 2 格背包空间。",
    530,
    levelSectionY + 204,
    860,
    { fontSize: 24, lineHeight: 40, color: PALETTE.secondary, maxLines: 5 },
  );

  const fullTier = sampleTiers.at(-1);
  if (!fullTier || fullTier.key !== "full") {
    throw new Error("地点图鉴全收录奖励配置异常");
  }
  drawFooter(ctx, height, "图鉴奖励与等级奖励都需要手动领取 · 背包空间不足时不会消耗领取资格");
  return savePoster(canvas, "04-dex-level-rewards.jpg");
}

const obsoleteGuideImages = [
  "02-fish-location.jpg",
  "03-weather-multipliers.jpg",
  "04-boss-guide.jpg",
  "05-nightmare-effects.jpg",
  "06-item-effects.jpg",
  "07-location-unlocks.jpg",
  "08-dex-level-rewards.jpg",
];
for (const filename of obsoleteGuideImages) {
  const obsoletePath = path.join(guideRoot, filename);
  if (!fs.existsSync(obsoletePath)) continue;
  fs.rmSync(obsoletePath);
  console.log(`removed ${path.relative(pluginRoot, obsoletePath)}`);
}

const outputs = [];
outputs.push(await generateTimeGuide());
outputs.push(await generateLocationWeatherGuide());
outputs.push(await generateUnlockGuide());
outputs.push(await generateRewardsGuide());

console.log(`done: ${outputs.length} fishing guide images`);
