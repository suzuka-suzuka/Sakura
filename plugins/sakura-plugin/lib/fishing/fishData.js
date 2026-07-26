import fs from "node:fs";
import path from "node:path";
import { pluginresources } from "../path.js";
import { validateLegacyFishData } from "./rules.js";

// fish.json 在进程启动时读一次：图鉴视图、图鉴奖励和垂钓结算共用同一份分母，
// 避免三处各自读文件后因为校验失败的处理方式不同而对不上数。
let fishData = [];
try {
  const fishJsonPath = path.join(pluginresources, "fish", "fish.json");
  fishData = JSON.parse(fs.readFileSync(fishJsonPath, "utf8"));
  const validationErrors = validateLegacyFishData(fishData);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.slice(0, 5).join("；"));
  }
} catch (err) {
  logger.error(`[钓鱼] 加载鱼类数据失败: ${err.message}`);
  fishData = [];
}

const fishIdSet = new Set(fishData.map((fish) => fish.id));

export function getFishData() {
  return fishData;
}

export function getFishIdSet() {
  return fishIdSet;
}

// 钓点专属鱼：locations 里点名了该钓点的鱼，含跨钓点鱼，不含未填 locations 的全钓点通用鱼。
// 通用鱼在任何钓点都能钓到，计进钓点图鉴会让后面的钓点凭第一个钓点的进度白拿档位。
export function getLocationExclusiveFish(locationId) {
  if (!locationId) return [];
  return fishData.filter((fish) => fish.locations?.includes(locationId));
}
