import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { plugindata, pluginresources } from "../path.js";

// 异色外观管线：手绘覆盖图 > 磁盘缓存 > 现场生成。
// 银灰系低饱和度鱼图对色相旋转免疫，改用金色染色；其余统一旋转 180°。
const SHINY_SATURATION_THRESHOLD = 0.25;
const SHINY_HUE_DEGREES = 180;
const SHINY_GOLD_TINT = { r: 255, g: 196, b: 64 };
const SHINY_GOLD_BRIGHTNESS = 1.08;

const baseImageDir = path.join(pluginresources, "fish", "img");
const overrideDir = path.join(baseImageDir, "shiny");
const cacheDir = path.join(plugindata, "fish", "shiny_cache");

// 可见像素（alpha 加权）的平均 HSV 饱和度
async function measureMeanSaturation(imagePath) {
  const { data, info } = await sharp(imagePath)
    .resize(64, 64, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let satSum = 0;
  let alphaSum = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const alpha = data[i + 3] / 255;
    if (alpha < 0.05) continue;
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    satSum += (max === 0 ? 0 : (max - min) / max) * alpha;
    alphaSum += alpha;
  }
  return alphaSum > 0 ? satSum / alphaSum : 0;
}

async function generateShinyImage(sourcePath, targetPath) {
  const saturation = await measureMeanSaturation(sourcePath);
  const pipeline = saturation < SHINY_SATURATION_THRESHOLD
    ? sharp(sourcePath).tint(SHINY_GOLD_TINT).modulate({ brightness: SHINY_GOLD_BRIGHTNESS })
    : sharp(sourcePath).modulate({ hue: SHINY_HUE_DEGREES });
  // 先写临时文件再改名，避免并发结算读到半张图
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await pipeline.png().toFile(tempPath);
  await fs.promises.rename(tempPath, targetPath);
}

// 返回异色图路径；底图缺失返回 null，生成失败抛错由调用方兜底
export async function getShinyFishImagePath(fishId) {
  const overridePath = path.join(overrideDir, `${fishId}.png`);
  if (fs.existsSync(overridePath)) return overridePath;

  const basePath = path.join(baseImageDir, `${fishId}.png`);
  if (!fs.existsSync(basePath)) return null;

  const cachePath = path.join(cacheDir, `${fishId}.png`);
  if (!fs.existsSync(cachePath)) {
    await fs.promises.mkdir(cacheDir, { recursive: true });
    await generateShinyImage(basePath, cachePath);
  }
  return cachePath;
}
