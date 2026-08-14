/**
 * 碧蓝档案 · 回合制群战 —— 规则常量与 16 角色数值表
 *
 * 与 docs/ba-battle/sim/engine.py 严格对应，改动时两边要同步。
 * 数值全部经过模拟配平；零被动 + 小技能回费版独立种子 12000 场复测极差 0.027。
 */

export const CFG = {
  DEF_K: 400, // 防御减伤系数：400 / (400 + 防御)
  AFF_STRONG: 1.35,
  AFF_NORMAL: 1.0,
  AFF_WEAK: 0.75,
  CRIT_DMG: 1.5,
  // 闪避率 =(闪避值 − 攻击方命中值) ÷ 200，即每 2 点差 1%，上限 35%
  DODGE_K: 200,
  DODGE_CAP: 0.35,
  CRIT_CAP: 0.6,

  // --- Cost：回复只取决于场上存活人数，与本回合是否出招无关 ---
  COST_START: 0, // 双方开局对等
  COST_REGEN: 0, // 不随战损衰减的保底部分
  COST_REGEN_PER_UNIT: 0.5, // 满编 4 人 = 2/回合，剩 2 人 = 1/回合
  COST_MAX: 10, // 正好等于终极技价格：攒满条 = 开大
  EX_HAND_SIZE: 2, // 4 张角色技能牌中同时只展示 2 张，用后补牌
  SECOND_BONUS: 3, // 后手方开局补偿；技能牌窗口版扫描 0~3 后最接近五五开

  // --- 白热化：防拖沓 ---
  SD_START: 10,
  SD_DMG_STEP: 0.2,
  SD_HEAL_STEP: 0.25,

  DMG_JITTER: 0.05,
  MAX_ROUND: 22,
}

export const ATK_TYPES = ["爆发", "贯通", "神秘", "振动"]
export const DEF_TYPES = ["轻装", "重装", "特殊", "弹力"]

/** 玩家需要识别的唯一定位；不再区分出场类型或前中后排。 */
export const COMBAT_ROLES = Object.freeze({
  YH: "打手",
  ZP: "打手",
  SG: "打手",
  LF: "辅助",
  CJ: "打手",
  RF: "打手",
  LS: "打手",
  GY: "打手",
  MY: "治疗",
  ZF: "辅助",
  LH: "坦克",
  XS: "打手",
  GM: "辅助",
  ZD: "辅助",
  CX: "坦克",
  HX: "坦克",
})

export function combatRoleOf(tmplOrId) {
  const id = typeof tmplOrId === "string" ? tmplOrId : tmplOrId?.id
  return COMBAT_ROLES[id] || null
}

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
 *
 * 命中、闪避、攻防血量、技能效率与 Cost 共用一份角色预算，不做单属性硬绑定。
 * 每名角色只有一个统一命中值，普攻、普通技能与 EX 全部共用；便宜或高收益技能可以
 * 反过来压低该角色的统一命中。闪避坦用低防御换高闪，重甲坦则反过来。
 */
export const ROSTER = [
  // ---------- 爆发（克轻装 / 被重装抵抗） ----------
  {
    // 精准狙击：高攻击与高命中并存，代价落在全场最低一档的体质与闪避上。
    id: "YH", name: "炎火", atkType: "爆发", defType: "轻装",
    hp: 5530, atk: 975, dfs: 160, crit: 0.28, dodge: 25, acc: 60,
    skill: { cd: 3, ...D(2.4) },
    ex: { cost: 3, ...D(3.5, "enemy_single", { execBonus: [0.5, 1.5] }) },
  },
  {
    // 全场唯一 10 费。Cost 上限也是 10，所以攒它 = 全队 5 回合不花钱，且全群可见
    id: "ZP", name: "重炮", atkType: "爆发", defType: "重装",
    hp: 7560, atk: 610, dfs: 340, crit: 0.1, dodge: 5, acc: 45,
    skill: { cd: 3, ...D(1.9, "lane_splash", { splash: 0.45 }) },
    ex: { cost: 10, ...D(6.2, "enemy_all") },
  },
  {
    id: "SG", name: "闪光", atkType: "爆发", defType: "特殊",
    hp: 6160, atk: 730, dfs: 150, crit: 0.3, dodge: 105, acc: 30,
    skill: { cd: 3, ...D(2.0) },
    ex: { cost: 2, ...D(1.7, "enemy_single") },
  },
  {
    id: "LF", name: "烈风", atkType: "爆发", defType: "弹力",
    hp: 7350, atk: 660, dfs: 260, crit: 0.15, dodge: 65, acc: 55,
    skill: { cd: 3, ...D(1.8) },
    ex: {
      cost: 4, kind: "support", target: "ally_all",
      buffs: [{ stat: "dmg_deal", value: 1.0, turns: 2 }],
    },
  },

  // ---------- 贯通（克重装 / 被特殊抵抗） ----------
  {
    id: "CJ", name: "穿甲", atkType: "贯通", defType: "重装",
    hp: 7700, atk: 685, dfs: 360, crit: 0.12, dodge: 5, acc: 45,
    skill: { cd: 3, ...D(2.0, "lane", { debuffs: [{ stat: "dfs", value: -0.25, turns: 2 }] }) },
    ex: { cost: 3, ...D(3.4, "enemy_single", { debuffs: [{ stat: "dfs", value: -0.35, turns: 3 }] }) },
  },
  {
    id: "RF", name: "锐锋", atkType: "贯通", defType: "轻装",
    hp: 5950, atk: 860, dfs: 175, crit: 0.42, dodge: 70, acc: 35,
    skill: { cd: 3, ...D(2.2) },
    ex: { cost: 2, ...D(2.2, "enemy_single", { forceCrit: true }) },
  },
  {
    id: "LS", name: "连射", atkType: "贯通", defType: "特殊",
    hp: 6650, atk: 730, dfs: 220, crit: 0.2, dodge: 60, acc: 30,
    skill: { cd: 3, ...D(2.0) },
    ex: { cost: 3, ...D(1.5, "enemy_random", { hits: 4 }) },
  },
  {
    id: "GY", name: "贯月", atkType: "贯通", defType: "弹力",
    hp: 6930, atk: 710, dfs: 280, crit: 0.18, dodge: 45, acc: 50,
    skill: { cd: 3, ...D(2.1) },
    ex: { cost: 4, ...D(3.8, "lane_splash", { splash: 0.75, ignoreDeadLane: true }) },
  },

  // ---------- 神秘（克特殊 / 被轻装抵抗） ----------
  {
    id: "MY", name: "秘仪", atkType: "神秘", defType: "特殊",
    hp: 6790, atk: 710, dfs: 230, crit: 0.1, dodge: 65, acc: 55,
    skill: { cd: 3, kind: "support", target: "ally_lowest", heal: 1.3 },
    ex: { cost: 5, kind: "support", target: "ally_all", heal: 2.4 },
  },
  {
    id: "ZF", name: "咒缚", atkType: "神秘", defType: "轻装",
    hp: 6300, atk: 845, dfs: 180, crit: 0.24, dodge: 75, acc: 65,
    skill: { cd: 3, ...D(2.0) },
    ex: { cost: 4, ...D(4.2, "enemy_single", { stun: 1 }) },
  },
  {
    id: "LH", name: "灵护", atkType: "神秘", defType: "重装",
    hp: 8470, atk: 655, dfs: 400, crit: 0.08, dodge: 5, acc: 50,
    skill: { cd: 3, kind: "support", target: "self", shield: 2.8, shieldTurns: 2 },
    ex: {
      cost: 6, kind: "support", target: "ally_all", shield: 3.0, shieldTurns: 2,
      buffs: [{ stat: "atk", value: 0.55, turns: 2 }],
    },
  },
  {
    id: "XS", name: "虚数", atkType: "神秘", defType: "弹力",
    hp: 7140, atk: 700, dfs: 250, crit: 0.15, dodge: 40, acc: 45,
    skill: { cd: 3, ...D(1.5, "lane", { dot: { value: 0.60, turns: 3 } }) },
    ex: { cost: 6, ...D(2.3, "enemy_all", { detonate: 1.7 }) },
  },

  // ---------- 振动（克弹力 / 被特殊抵抗） ----------
  {
    // 低费轮转辅助，因此基础输出、体质与统一命中都偏低。
    id: "GM", name: "共鸣", atkType: "振动", defType: "弹力",
    hp: 6510, atk: 625, dfs: 240, crit: 0.12, dodge: 55, acc: 30,
    skill: { cd: 3, ...D(1.8), costGain: 3 },
    ex: { cost: 2, ...D(2.0, "enemy_single") },
  },
  {
    id: "ZD", name: "震荡", atkType: "振动", defType: "轻装",
    hp: 6580, atk: 885, dfs: 190, crit: 0.2, dodge: 50, acc: 25,
    skill: { cd: 3, ...D(2.1) },
    ex: { cost: 4, ...D(2.0, "enemy_all", { debuffs: [{ stat: "dfs", value: -0.25, turns: 3 }] }) },
  },
  {
    id: "CX", name: "潮汐", atkType: "振动", defType: "特殊",
    hp: 7350, atk: 670, dfs: 160, crit: 0.1, dodge: 95, acc: 45,
    skill: { cd: 3, ...D(1.8, "lane", { selfBuffs: [{ stat: "dmg_take", value: -0.2, turns: 2 }] }) },
    ex: {
      cost: 3, kind: "support", target: "self", taunt: 1, heal: 1.2,
      reflect: 0.8, reflectTurns: 1,
      buffs: [{ stat: "dmg_take", value: -0.6, turns: 1 }],
    },
  },
  {
    id: "HX", name: "回响", atkType: "振动", defType: "重装",
    hp: 11600, atk: 570, dfs: 180, crit: 0.1, dodge: 20, acc: 50,
    skill: { cd: 3, ...D(1.7, "lane", { selfHeal: 0.8 }) },
    ex: { cost: 4, kind: "support", target: "ally_all", heal: 1.15, cleanse: true },
  },
]

export const BY_ID = Object.fromEntries(ROSTER.map((t) => [t.id, t]))

/** 图鉴编号 1~16 → 角色，配队指令用 */
export const BY_INDEX = ROSTER.reduce((map, t, i) => {
  map[i + 1] = t
  return map
}, {})

/** 支持按编号、id、角色名三种写法查角色 */
export function findUnit(token) {
  const s = String(token).trim()
  if (/^\d+$/.test(s)) return BY_INDEX[Number(s)] || null
  return BY_ID[s.toUpperCase()] || ROSTER.find((t) => t.name === s) || null
}
