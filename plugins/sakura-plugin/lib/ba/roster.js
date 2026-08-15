/**
 * 碧蓝档案 · 回合制群战 —— 角色表（自 SchaleDB 官方数据生成）
 *
 * 本文件由 scripts/emit-roster.mjs 生成，不要手改。
 * 折算口径：等级 1 / 无装备 / 无羁绊 / 统一 3★ / 技能 1 级 / 1 轮 = 5 秒
 * 战斗公式与克制表均取自官方实现，见 CFG 注释。
 */

/** 官方克制表（万分比）：SchaleDB config.TypeEffectiveness */
export const TYPE_EFFECTIVENESS = {
  "Normal": {
    "LightArmor": 10000,
    "HeavyArmor": 10000,
    "Unarmed": 10000,
    "Structure": 5000,
    "ElasticArmor": 10000,
    "CompositeArmor": 10000,
    "Normal": 10000
  },
  "Explosion": {
    "LightArmor": 20000,
    "HeavyArmor": 10000,
    "Unarmed": 5000,
    "Structure": 5000,
    "ElasticArmor": 5000,
    "CompositeArmor": 10000,
    "Normal": 10000
  },
  "Pierce": {
    "LightArmor": 5000,
    "HeavyArmor": 20000,
    "Unarmed": 10000,
    "Structure": 5000,
    "ElasticArmor": 10000,
    "CompositeArmor": 10000,
    "Normal": 10000
  },
  "Mystic": {
    "LightArmor": 10000,
    "HeavyArmor": 5000,
    "Unarmed": 20000,
    "Structure": 5000,
    "ElasticArmor": 10000,
    "CompositeArmor": 5000,
    "Normal": 10000
  },
  "Sonic": {
    "LightArmor": 10000,
    "HeavyArmor": 5000,
    "Unarmed": 15000,
    "Structure": 5000,
    "ElasticArmor": 20000,
    "CompositeArmor": 5000,
    "Normal": 10000
  },
  "Chemical": {
    "LightArmor": 5000,
    "HeavyArmor": 15000,
    "Unarmed": 10000,
    "Structure": 5000,
    "ElasticArmor": 10000,
    "CompositeArmor": 20000,
    "Normal": 10000
  }
}

// 短名与全称都认，避免调用方写全称时静默退化成 1.0
const ARMOR_KEY = {
  轻装: "LightArmor", 重装: "HeavyArmor", 特殊: "Unarmed", 弹力: "ElasticArmor", 复合: "CompositeArmor",
  轻装甲: "LightArmor", 重装甲: "HeavyArmor", 特殊装甲: "Unarmed", 弹力装甲: "ElasticArmor", 复合装甲: "CompositeArmor",
}
const BULLET_KEY = { 爆发: "Explosion", 贯通: "Pierce", 神秘: "Mystic", 振动: "Sonic", 变化: "Chemical" }

/** 属性克制系数：克制 2.0 / 普通 1.0 / 被抵抗 0.5（振动打特殊为 1.5） */
export function affinity(atkType, defType) {
  const row = TYPE_EFFECTIVENESS[BULLET_KEY[atkType]]
  const key = ARMOR_KEY[defType]
  if (!row || !key) throw new Error(`未知属性组合: ${atkType} / ${defType}`)
  return (row[key] ?? 10000) / 10000
}

export const CFG = {
  // ---- 官方战斗公式常数（取自 SchaleDB common.js 实现）----
  DEF_C: 6000, DEF_BASE: 10000000,   // 防御系数 = DEF_BASE / (防御 × DEF_C + DEF_BASE)
  HIT_C: 3, HIT_BASE: 2000,          // 命中率  = HIT_BASE / (max(闪避−命中,0) × HIT_C + HIT_BASE)
  CRIT_C: 6000, CRIT_BASE: 4000000,  // 暴击率  = 1 − CRIT_BASE / (max(暴击−暴抵,0) × CRIT_C + CRIT_BASE)
  STAB_BASE: 1000,                   // 伤害下限 = 稳定值/(稳定值+STAB_BASE) + 稳定率/10000
  DEFAULT_STAB_RATE: 2000,
  ROUND_SECONDS: 5,       // 1 轮（双方各行动一次）= 5 秒，技能时长与冷却都按这把尺子折算

  // ---- 对战框架（非 BA 原生，为回合制 PvP 而设）----
  // Cost 在每个回合「结束时」回复，因此首轮双方都是开局值直接开打：
  // 先手首轮 0，后手首轮 2，之后后手恒定领先 2 点。
  COST_START: 0,
  COST_REGEN_PER_UNIT: 0.5,          // 满编 4 人 = 2/回合
  COST_MAX: 10,                      // 与 BA 的 Cost 上限一致
  EX_COOLDOWN_SLACK: 2,              // EX 冷却长度 = 存活人数 − 这个值
  SECOND_BONUS: 2,                   // 后手方开局补偿

  // ---- 白热化 / FEVER TIME（照搬原作，按 1 轮 = 5 秒折算）----
  // 原作 PvP：总时长 240 秒，剩余不足 60 秒进入白热化，
  // 时间耗尽则比双方「当前血量 / 最大血量」的比值定胜负。
  FEVER_ROUND: 36,  // 第几轮进入白热化 = 180 秒
  FEVER_COST_MULT: 2,                // 白热化唯一的基础效果：Cost 攒得更快
  FEVER_DEBUFF: 0.5,                 // 赛季附加规则：防御 / 闪避 / 受治疗下降，设 0 可关掉
  MAX_ROUND: 48,                   // 时间耗尽 = 240 秒 = 48 轮
}

export const ROSTER = [
  {
    "id": "HOSHINO",
    "sid": 10005,
    "name": "星野",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "重装",
    "role": "坦克",
    "bullet": "Pierce",
    "armor": "HeavyArmor",
    "hp": 3275,
    "atk": 213,
    "dfs": 175,
    "healPower": 1687,
    "acc": 615,
    "dodge": 246,
    "crit": 205,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1948,
    "autoAttack": {
      "hits": [
        33.34,
        33.33,
        33.33
      ]
    },
    "skill": {
      "name": "急救治疗",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "regen",
          "scope": "self",
          "scale": 1.006,
          "source": "heal",
          "turns": 4,
          "period": 1
        }
      ],
      "trigger": {
        "type": "hp_below",
        "value": 0.3,
        "maxUses": 1
      }
    },
    "ex": {
      "name": "战术镇压",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 62832,
      "effects": [
        {
          "type": "cc",
          "scope": "enemy",
          "icon": "Stunned",
          "chance": 1,
          "turns": 0,
          "inactive": true
        }
      ],
      "cost": 4,
      "hits": [
        87.198,
        87.198,
        87.198,
        87.198,
        87.198
      ]
    }
  },
  {
    "id": "SHIROKO",
    "sid": 10010,
    "name": "白子",
    "star": 3,
    "baseStar": 3,
    "atkType": "爆发",
    "defType": "轻装",
    "role": "输出",
    "bullet": "Explosion",
    "armor": "LightArmor",
    "hp": 2492,
    "atk": 340,
    "dfs": 19,
    "healPower": 1662,
    "acc": 707,
    "dodge": 808,
    "crit": 202,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1384,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "skill": {
      "name": "投掷手榴弹",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 31416,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        193.65
      ]
    },
    "ex": {
      "name": "召唤无人机：火力支援，开始",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "cost": 2,
      "hits": [
        40.045,
        40.045,
        40.045,
        40.045,
        40.045,
        40.045,
        40.045,
        40.045,
        40.045,
        40.045
      ]
    }
  },
  {
    "id": "NONOMI",
    "sid": 13004,
    "name": "野宫",
    "star": 3,
    "baseStar": 2,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "输出",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2536,
    "atk": 321,
    "dfs": 80,
    "healPower": 1634,
    "acc": 99,
    "dodge": 198,
    "crit": 198,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1408,
    "autoAttack": {
      "hits": [
        20,
        20,
        20,
        20,
        20
      ]
    },
    "skill": {
      "name": "闪亮登场~☆",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "atk",
          "value": 0.2184,
          "turns": 4
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 6
      }
    },
    "ex": {
      "name": "惩罚时间到了~♣",
      "target": "enemy_all",
      "count": 4,
      "area": 472548,
      "effects": [],
      "cost": 5,
      "hits": [
        216.27,
        216.27
      ]
    }
  },
  {
    "id": "SERIKA",
    "sid": 13008,
    "name": "芹香",
    "star": 3,
    "baseStar": 2,
    "atkType": "爆发",
    "defType": "轻装",
    "role": "输出",
    "bullet": "Explosion",
    "armor": "LightArmor",
    "hp": 2456,
    "atk": 345,
    "dfs": 19,
    "healPower": 1687,
    "acc": 717,
    "dodge": 820,
    "crit": 256,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1364,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "skill": {
      "name": "瞄准射击",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        20.3598,
        20.3598,
        20.3598,
        20.3598,
        20.3598,
        20.3598,
        20.3598,
        20.3598,
        20.3598,
        20.3598,
        20.3822
      ]
    },
    "ex": {
      "name": "别碍手碍脚！",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "atk",
          "value": 0.3565,
          "turns": 6
        }
      ],
      "cost": 2,
      "thenAutoAttack": true
    }
  }
]

export const BY_ID = Object.fromEntries(ROSTER.map((t) => [t.id, t]))

export function combatRoleOf(x) {
  const id = typeof x === "string" ? x : x?.id
  return BY_ID[id]?.role || null
}

/**
 * 按角色名或内部代号查角色。**不认编号** —— 配队和出招一律写名字，
 * 记「星野ex打白子」比记「ex 1>3」容易得多，角色也不再对外暴露序号。
 */
export function findUnit(token) {
  const s = String(token).trim()
  return BY_ID[s.toUpperCase()] || ROSTER.find((t) => t.name === s) || null
}
