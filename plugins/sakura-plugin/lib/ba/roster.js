/**
 * 碧蓝档案 · 回合制群战 —— 规则常量与 16 角色数值表
 *
 * 与 docs/ba-battle/sim/engine.py 严格对应，改动时两边要同步。
 * 数值全部经过 autotune 配平，独立种子 8000 场复测极差 0.053。
 */

export const CFG = {
  DEF_K: 400, // 防御减伤系数：400 / (400 + 防御)
  AFF_STRONG: 1.35,
  AFF_NORMAL: 1.0,
  AFF_WEAK: 0.75,
  CRIT_DMG: 1.5,
  DODGE_K: 300,
  DODGE_CAP: 0.35,
  CRIT_CAP: 0.6,

  // --- Cost：回复只取决于场上存活人数，与本回合是否出招无关 ---
  COST_START: 0, // 双方开局对等
  COST_REGEN: 0, // 不随战损衰减的保底部分
  COST_REGEN_PER_UNIT: 0.5, // 满编 4 人 = 2/回合，剩 2 人 = 1/回合
  COST_MAX: 10, // 正好等于终极技价格：攒满条 = 开大
  EX_CD: 1, // 释放后该角色下 1 个自己的回合不能再放
  SECOND_BONUS: 3, // 后手方开局补偿，实测先手胜率 49.0%

  // --- 白热化：防拖沓 ---
  SD_START: 10,
  SD_DMG_STEP: 0.2,
  SD_HEAL_STEP: 0.25,

  DMG_JITTER: 0.05,
  MAX_ROUND: 22,
  HP_SCALE: 1.4, // 拉长对局到 ~11 回合，给 10 费终极技留出攒满的空间
}

export const ATK_TYPES = ["爆发", "贯通", "神秘", "振动"]
export const DEF_TYPES = ["轻装", "重装", "特殊", "弹力"]

const AFF_TABLE = {
  爆发: { 轻装: "S", 重装: "W", 特殊: "N", 弹力: "N" },
  贯通: { 轻装: "N", 重装: "S", 特殊: "W", 弹力: "N" },
  神秘: { 轻装: "W", 重装: "N", 特殊: "S", 弹力: "N" },
  振动: { 轻装: "N", 重装: "N", 特殊: "W", 弹力: "S" },
}

/** 属性克制系数：克制 1.35 / 普通 1.00 / 被抵抗 0.75 */
export function affinity(atkType, defType) {
  const g = AFF_TABLE[atkType]?.[defType]
  if (g === "S") return CFG.AFF_STRONG
  if (g === "W") return CFG.AFF_WEAK
  return CFG.AFF_NORMAL
}

/** 伤害类效果的简写 */
function D(mult, target = "lane", extra = {}) {
  return { kind: "damage", mult, target, ...extra }
}

/**
 * 16 角色 = 4 攻击属性 × 4 防御属性全覆盖，每格一人。
 * 费用分布 2×3 / 3×4 / 4×5 / 5×1 / 6×2 / 10×1。
 *
 * 两条硬性设计规则（见设计文档 7.1）：
 *   1. 高费 EX 必须是多目标 —— 单体的价值上限是「删掉一个敌人」，10 费单体在 35% 胜率封顶
 *   2. EX 费用要和角色生存能力正相关 —— 6 费大招装在轻装身板上只有 0.396
 */
export const ROSTER = [
  // ---------- 爆发（克轻装 / 被重装抵抗） ----------
  {
    id: "YH", name: "炎火", atkType: "爆发", defType: "轻装", role: "处决狙击",
    hp: 4250, atk: 940, dfs: 190, crit: 0.28, dodge: 55,
    skill: { cd: 3, ...D(2.4) },
    ex: { cost: 3, ...D(3.5, "enemy_single", { execBonus: [0.5, 1.5] }) },
  },
  {
    // 全场唯一 10 费。Cost 上限也是 10，所以攒它 = 全队 5 回合不花钱，且全群可见
    id: "ZP", name: "重炮", atkType: "爆发", defType: "重装", role: "決戦炮击",
    hp: 5750, atk: 710, dfs: 335, crit: 0.1, dodge: 10,
    skill: { cd: 3, ...D(1.9, "lane_splash", { splash: 0.45 }) },
    ex: { cost: 10, ...D(6.2, "enemy_all") },
  },
  {
    id: "SG", name: "闪光", atkType: "爆发", defType: "特殊", role: "高闪刺客",
    hp: 4400, atk: 740, dfs: 235, crit: 0.3, dodge: 100,
    skill: { cd: 3, ...D(2.0) },
    ex: { cost: 2, ...D(1.7, "enemy_single") },
  },
  {
    id: "LF", name: "烈风", atkType: "爆发", defType: "弹力", role: "增伤辅助",
    hp: 5300, atk: 705, dfs: 285, crit: 0.15, dodge: 55,
    skill: { cd: 3, ...D(1.8) },
    ex: {
      cost: 4, kind: "support", target: "ally_all",
      buffs: [{ stat: "dmg_deal", value: 0.65, turns: 2 }],
    },
  },

  // ---------- 贯通（克重装 / 被特殊抵抗） ----------
  {
    id: "CJ", name: "穿甲", atkType: "贯通", defType: "重装", role: "减防坦输",
    hp: 6150, atk: 765, dfs: 330, crit: 0.12, dodge: 15,
    skill: { cd: 3, ...D(2.0, "lane", { debuffs: [{ stat: "dfs", value: -0.25, turns: 2 }] }) },
    ex: { cost: 3, ...D(3.4, "enemy_single", { debuffs: [{ stat: "dfs", value: -0.35, turns: 3 }] }) },
  },
  {
    id: "RF", name: "锐锋", atkType: "贯通", defType: "轻装", role: "暴击流",
    hp: 4000, atk: 775, dfs: 195, crit: 0.42, dodge: 60,
    skill: { cd: 3, ...D(2.2) },
    ex: { cost: 2, ...D(2.2, "enemy_single", { forceCrit: true }) },
    passive: { static: { crit_dmg: 0.45 } },
  },
  {
    id: "LS", name: "连射", atkType: "贯通", defType: "特殊", role: "多段散射",
    hp: 4750, atk: 740, dfs: 250, crit: 0.2, dodge: 75,
    skill: { cd: 3, ...D(2.0) },
    ex: { cost: 3, ...D(1.5, "enemy_random", { hits: 4 }) },
  },
  {
    id: "GY", name: "贯月", atkType: "贯通", defType: "弹力", role: "三格贯穿",
    hp: 5150, atk: 730, dfs: 285, crit: 0.18, dodge: 50,
    skill: { cd: 3, ...D(2.1) },
    ex: { cost: 4, ...D(3.8, "lane_splash", { splash: 0.75, ignoreDeadLane: true }) },
  },

  // ---------- 神秘（克特殊 / 被轻装抵抗） ----------
  {
    id: "MY", name: "秘仪", atkType: "神秘", defType: "特殊", role: "主治疗",
    hp: 4950, atk: 680, dfs: 255, crit: 0.1, dodge: 60,
    skill: { cd: 3, kind: "support", target: "ally_lowest", heal: 1.3 },
    ex: { cost: 5, kind: "support", target: "ally_all", heal: 2.4 },
  },
  {
    id: "ZF", name: "咒缚", atkType: "神秘", defType: "轻装", role: "单体控制",
    hp: 4650, atk: 930, dfs: 195, crit: 0.24, dodge: 80,
    skill: { cd: 3, ...D(2.0) },
    ex: { cost: 4, ...D(4.2, "enemy_single", { stun: 1 }) },
  },
  {
    id: "LH", name: "灵护", atkType: "神秘", defType: "重装", role: "护盾坦",
    hp: 6300, atk: 670, dfs: 345, crit: 0.08, dodge: 10,
    skill: { cd: 3, kind: "support", target: "self", shield: 2.8, shieldTurns: 2 },
    ex: {
      cost: 6, kind: "support", target: "ally_all", shield: 3.0, shieldTurns: 2,
      buffs: [{ stat: "atk", value: 0.25, turns: 2 }],
    },
  },
  {
    id: "XS", name: "虚数", atkType: "神秘", defType: "弹力", role: "灼烧引爆",
    hp: 5050, atk: 685, dfs: 280, crit: 0.15, dodge: 50,
    skill: { cd: 3, ...D(1.5, "lane", { dot: { value: 0.55, turns: 3 } }) },
    ex: { cost: 6, ...D(2.3, "enemy_all", { detonate: 1.7 }) },
  },

  // ---------- 振动（克弹力 / 被特殊抵抗） ----------
  {
    // 被动 +0.5 = 在「每存活角色 0.5」的规则下本人算两个人。
    // v3 曾给 +1 且把攻击力压到 495，导致它的强度全押在被动上，
    // 回复速率一改就在 0.22 和 0.63 之间弹，所以 v4 把常规属性匀了回来。
    id: "GM", name: "共鸣", atkType: "振动", defType: "弹力", role: "Cost引擎",
    hp: 4500, atk: 620, dfs: 290, crit: 0.12, dodge: 48,
    skill: { cd: 3, ...D(1.8) },
    ex: { cost: 2, ...D(2.0, "enemy_single") },
    passive: { costRegen: 0.5 },
  },
  {
    id: "ZD", name: "震荡", atkType: "振动", defType: "轻装", role: "全体破防",
    hp: 4450, atk: 855, dfs: 200, crit: 0.2, dodge: 65,
    skill: { cd: 3, ...D(2.1) },
    ex: { cost: 4, ...D(2.0, "enemy_all", { debuffs: [{ stat: "dfs", value: -0.25, turns: 3 }] }) },
  },
  {
    id: "CX", name: "潮汐", atkType: "振动", defType: "特殊", role: "嘲讽坦",
    hp: 5450, atk: 630, dfs: 300, crit: 0.1, dodge: 40,
    skill: { cd: 3, ...D(1.8, "lane", { selfBuffs: [{ stat: "dmg_take", value: -0.2, turns: 2 }] }) },
    ex: {
      cost: 3, kind: "support", target: "self", taunt: 1, heal: 1.2,
      reflect: 0.8, reflectTurns: 1,
      buffs: [{ stat: "dmg_take", value: -0.6, turns: 1 }],
    },
  },
  {
    id: "HX", name: "回响", atkType: "振动", defType: "重装", role: "团队续航",
    hp: 5550, atk: 615, dfs: 320, crit: 0.1, dodge: 15,
    skill: { cd: 3, ...D(1.7, "lane", { selfHeal: 0.8 }) },
    ex: { cost: 4, kind: "support", target: "ally_all", heal: 1.15, cleanse: true },
    passive: { revive: 0.2 },
  },
]

export const BY_ID = Object.fromEntries(ROSTER.map((t) => [t.id, t]))

/** 图鉴编号 1~16 → 角色，配队指令用 */
export const BY_INDEX = ROSTER.reduce((acc, t, i) => {
  acc[i + 1] = t
  return acc
}, {})

/** 支持按编号、id、角色名三种写法查角色 */
export function findUnit(token) {
  const s = String(token).trim()
  if (/^\d+$/.test(s)) return BY_INDEX[Number(s)] || null
  return BY_ID[s.toUpperCase()] || ROSTER.find((t) => t.name === s) || null
}
