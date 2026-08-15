/**
 * 碧蓝档案 · 回合制群战 —— 角色表（自 SchaleDB 官方数据生成）
 *
 * 本文件由 scripts/emit-roster.mjs 生成，不要手改。
 * 折算口径：等级 1 / 无装备 / 统一 3★ / 技能 1 级 / 1 轮 = 5 秒
 * 有爱用品的角色用强化版普通技能（GearPublic）；爱用品的属性加成不取，那是按满级标定的定值
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

/**
 * 召唤物模板。它们**不进 ROSTER**，也不占号位——只作为 side.summons 里的挡刀物存在，
 * 所以 aliveOf / sideDead / settle / EX 冷却全都天然不把它们算进去。
 */
export const SUMMONS = {
  "40002": {
    "id": 40002,
    "name": "佩洛洛人偶",
    "defType": "轻装",
    "role": "召唤",
    "hp": 10,
    "dfs": 0,
    "dodge": 0,
    "crit": 0,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 300
  }
}

export const ROSTER = [
  {
    "id": "ARU",
    "sid": 10000,
    "name": "爱露",
    "star": 3,
    "baseStar": 3,
    "atkType": "爆发",
    "defType": "轻装",
    "role": "输出",
    "bullet": "Explosion",
    "armor": "LightArmor",
    "hp": 2505,
    "atk": 451,
    "dfs": 19,
    "healPower": 1655,
    "acc": 905,
    "dodge": 201,
    "crit": 201,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1988,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "黑色攻击+",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 31416,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        156.16,
        256.69
      ],
      "splashHits": [
        256.69
      ]
    },
    "ex": {
      "name": "冷酷无情射击",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 125664,
      "effects": [],
      "cost": 4,
      "hits": [
        274.38,
        292.07
      ],
      "splashHits": [
        292.07
      ]
    }
  },
  {
    "id": "EIMI",
    "sid": 10001,
    "name": "艾米",
    "star": 3,
    "baseStar": 3,
    "atkType": "爆发",
    "defType": "轻装",
    "role": "坦克",
    "bullet": "Explosion",
    "armor": "LightArmor",
    "hp": 3434,
    "atk": 138,
    "dfs": 183,
    "healPower": 1609,
    "acc": 586,
    "dodge": 234,
    "crit": 195,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 2044,
    "autoAttack": {
      "hits": [
        33.34,
        33.33,
        33.33
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "执念的猛击+",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 62832,
      "effects": [
        {
          "type": "heal",
          "scope": "self",
          "scale": 0.427,
          "source": "heal"
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 3
      },
      "hits": [
        405.56
      ]
    },
    "ex": {
      "name": "不屈的意志",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "regen",
          "scope": "self",
          "scale": 0.0864,
          "source": "heal",
          "turns": 4,
          "period": 1,
          "lostHpRate": 0.0346
        }
      ],
      "cost": 4
    }
  },
  {
    "id": "HARUNA",
    "sid": 10002,
    "name": "晴奈",
    "star": 3,
    "baseStar": 3,
    "atkType": "神秘",
    "defType": "重装",
    "role": "输出",
    "bullet": "Mystic",
    "armor": "HeavyArmor",
    "hp": 2451,
    "atk": 457,
    "dfs": 19,
    "healPower": 1690,
    "acc": 924,
    "dodge": 205,
    "crit": 205,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1944,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "爆炸的异国风情",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 6
      },
      "hits": [
        200.21
      ]
    },
    "ex": {
      "name": "优雅地贯穿",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 100000,
      "effects": [],
      "cost": 4,
      "hits": [
        506.96
      ],
      "falloff": {
        "rate": 0.1,
        "max": 0.3
      }
    }
  },
  {
    "id": "HIFUMI",
    "sid": 10003,
    "name": "日富美",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "辅助",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2520,
    "atk": 238,
    "dfs": 20,
    "healPower": 1644,
    "acc": 699,
    "dodge": 799,
    "crit": 199,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1400,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "佩洛洛大人的助威",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "enemy",
          "stat": "acc",
          "value": -0.1686,
          "turns": 6,
          "channel": 605
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 7
      },
      "hits": [
        212.81
      ]
    },
    "ex": {
      "name": "佩洛洛大人，快帮帮我！",
      "target": "enemy_adjacent",
      "count": 3,
      "area": 282743,
      "effects": [
        {
          "type": "summon",
          "summonId": 40002,
          "hpRate": 1.6006,
          "turns": 6,
          "taunt": 1
        }
      ],
      "cost": 5,
      "hits": [
        101.88,
        101.88
      ]
    }
  },
  {
    "id": "HINA",
    "sid": 10004,
    "name": "日奈",
    "star": 3,
    "baseStar": 3,
    "atkType": "爆发",
    "defType": "重装",
    "role": "输出",
    "bullet": "Explosion",
    "armor": "HeavyArmor",
    "hp": 2529,
    "atk": 310,
    "dfs": 80,
    "healPower": 1638,
    "acc": 99,
    "dodge": 199,
    "crit": 199,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1404,
    "autoAttack": {
      "hits": [
        14.28,
        14.28,
        14.28,
        14.29,
        14.29,
        14.29,
        14.29
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "重装与毁灭+",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "atk",
          "value": 0.2296,
          "turns": 4,
          "channel": 2
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "thenAutoAttack": true
    },
    "ex": {
      "name": "终幕：伊施波设",
      "target": "enemy_all",
      "count": 4,
      "area": 316777,
      "effects": [],
      "cost": 7,
      "hits": [
        63.604,
        63.604,
        63.604,
        63.604,
        63.604,
        63.604,
        63.604,
        63.604,
        63.604,
        63.604
      ]
    }
  },
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
    "gearSkill": true,
    "skill": {
      "name": "急救治疗+",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "regen",
          "scope": "self",
          "scale": 1.3718,
          "source": "heal",
          "turns": 4,
          "period": 1
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "crit_dmg_res_flat",
          "value": 1579,
          "turns": 4,
          "channel": 23
        }
      ],
      "trigger": {
        "type": "hp_below",
        "value": 0.3,
        "maxUses": 2
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
    "id": "IORI",
    "sid": 10006,
    "name": "伊织",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "重装",
    "role": "输出",
    "bullet": "Pierce",
    "armor": "HeavyArmor",
    "hp": 2591,
    "atk": 391,
    "dfs": 20,
    "healPower": 1597,
    "acc": 874,
    "dodge": 194,
    "crit": 194,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 2056,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "悬赏通缉",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        229.83
      ]
    },
    "ex": {
      "name": "一网打尽",
      "target": "enemy_chain",
      "count": 3,
      "area": 32725,
      "effects": [],
      "cost": 3,
      "hits": [
        350.73,
        350.73,
        350.73
      ]
    }
  },
  {
    "id": "MAKI",
    "sid": 10007,
    "name": "真纪",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "输出",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2563,
    "atk": 276,
    "dfs": 81,
    "healPower": 1616,
    "acc": 98,
    "dodge": 196,
    "crit": 245,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1424,
    "autoAttack": {
      "hits": [
        20,
        20,
        20,
        20,
        20
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "投掷油漆弹！",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "enemy",
          "stat": "dfs",
          "value": -0.1837,
          "turns": 3,
          "channel": 603
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      }
    },
    "ex": {
      "name": "让世界更加鲜艳！",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "atk",
          "value": 0.4194,
          "turns": 6,
          "channel": 2
        }
      ],
      "cost": 5,
      "hits": [
        67.617,
        67.617,
        67.617,
        67.617,
        67.617,
        67.617,
        67.617,
        67.617,
        67.617,
        67.617,
        67.617
      ]
    }
  },
  {
    "id": "IZUMI",
    "sid": 10009,
    "name": "泉",
    "star": 3,
    "baseStar": 3,
    "atkType": "爆发",
    "defType": "轻装",
    "role": "输出",
    "bullet": "Explosion",
    "armor": "LightArmor",
    "hp": 2571,
    "atk": 238,
    "dfs": 81,
    "healPower": 1611,
    "acc": 97,
    "dodge": 195,
    "crit": 244,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1428,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "瞄准，砰！+",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        20.7269,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542,
        20.5542
      ]
    },
    "ex": {
      "name": "芝士巧克力汉堡~",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "heal",
          "scope": "self",
          "scale": 1.456,
          "source": "heal"
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "dmg_deal",
          "value": 0,
          "turns": 5,
          "channel": 24,
          "inactive": true
        }
      ],
      "cost": 3
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
    "gearSkill": true,
    "skill": {
      "name": "投掷手榴弹+",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 31416,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        290.51
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
    "id": "SUMIRE",
    "sid": 10012,
    "name": "堇",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "特殊",
    "role": "输出",
    "bullet": "Pierce",
    "armor": "Unarmed",
    "hp": 2541,
    "atk": 231,
    "dfs": 121,
    "healPower": 1630,
    "acc": 594,
    "dodge": 198,
    "crit": 198,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 2016,
    "autoAttack": {
      "hits": [
        16.66,
        16.66,
        16.67,
        16.66,
        16.66,
        16.67
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "热身运动+",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "atk",
          "value": 0.2752,
          "turns": 4,
          "channel": 2
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "dfs",
          "value": 0.1102,
          "turns": 4,
          "channel": 3
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 8
      }
    },
    "ex": {
      "name": "冲刺，射击！",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 62832,
      "effects": [],
      "cost": 3,
      "hits": [
        247.4728,
        247.3986,
        247.3986
      ]
    }
  },
  {
    "id": "TSURUGI",
    "sid": 10013,
    "name": "鹤城",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "重装",
    "role": "输出",
    "bullet": "Pierce",
    "armor": "HeavyArmor",
    "hp": 2877,
    "atk": 471,
    "dfs": 138,
    "healPower": 1600,
    "acc": 642,
    "dodge": 175,
    "crit": 243,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 2052,
    "autoAttack": {
      "hits": [
        16.66,
        16.67,
        16.67,
        16.66,
        16.67,
        16.67
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "激情+",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "heal",
          "scope": "self",
          "scale": 1.269,
          "source": "heal"
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "dmg_deal",
          "value": 0.2559,
          "turns": 4,
          "channel": 24
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      }
    },
    "ex": {
      "name": "诡异灭裂",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 98175,
      "effects": [
        {
          "type": "charge",
          "shots": 2,
          "mult": 1.38,
          "count": 2
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "atk",
          "value": 0.2588,
          "turns": 2,
          "channel": 2
        }
      ],
      "cost": 3,
      "thenAutoAttack": true
    }
  },
  {
    "id": "AKANE",
    "sid": 13000,
    "name": "茜",
    "star": 3,
    "baseStar": 2,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "辅助",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2473,
    "atk": 120,
    "dfs": 19,
    "healPower": 1675,
    "acc": 101,
    "dodge": 1119,
    "crit": 203,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 980,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "击穿，要精致",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 8
      },
      "hits": [
        396.8
      ]
    },
    "ex": {
      "name": "清除，要优雅",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "enemy",
          "stat": "dfs",
          "value": -0.2904,
          "turns": 6,
          "channel": 603
        }
      ],
      "cost": 2,
      "hits": [
        547.95
      ]
    }
  },
  {
    "id": "CHISE",
    "sid": 13001,
    "name": "千世",
    "star": 3,
    "baseStar": 2,
    "atkType": "神秘",
    "defType": "重装",
    "role": "输出",
    "bullet": "Mystic",
    "armor": "HeavyArmor",
    "hp": 2527,
    "atk": 271,
    "dfs": 20,
    "healPower": 1641,
    "acc": 99,
    "dodge": 199,
    "crit": 249,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1000,
    "autoAttack": {
      "hits": [
        100
      ],
      "target": "enemy_adjacent",
      "count": 2
    },
    "gearSkill": true,
    "skill": {
      "name": "要射击啦~+",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 31416,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        298.99
      ]
    },
    "ex": {
      "name": "可能会痛哦~",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 125664,
      "effects": [
        {
          "type": "dot",
          "scope": "enemy",
          "icon": "Zone",
          "scale": 3.0817,
          "turns": 2,
          "period": 1
        }
      ],
      "cost": 4
    }
  },
  {
    "id": "AKARI",
    "sid": 13002,
    "name": "明里",
    "star": 3,
    "baseStar": 2,
    "atkType": "爆发",
    "defType": "重装",
    "role": "输出",
    "bullet": "Explosion",
    "armor": "HeavyArmor",
    "hp": 2523,
    "atk": 336,
    "dfs": 20,
    "healPower": 1642,
    "acc": 698,
    "dodge": 798,
    "crit": 199,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1400,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "再来一碗辣的！",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "atk",
          "value": 0.3877,
          "turns": 4,
          "channel": 2
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      }
    },
    "ex": {
      "name": "一发榴弹，分量满满！",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 70686,
      "effects": [],
      "cost": 4,
      "hits": [
        392.11
      ]
    }
  },
  {
    "id": "HASUMI",
    "sid": 13003,
    "name": "莲见",
    "star": 3,
    "baseStar": 2,
    "atkType": "贯通",
    "defType": "重装",
    "role": "输出",
    "bullet": "Pierce",
    "armor": "HeavyArmor",
    "hp": 2527,
    "atk": 418,
    "dfs": 20,
    "healPower": 1640,
    "acc": 897,
    "dodge": 199,
    "crit": 199,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 2004,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "冷彻之心＋",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "crit_dmg",
          "value": 0.3512,
          "turns": 6,
          "channel": 11
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "thenAutoAttack": true
    },
    "ex": {
      "name": "穿甲射击",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "cost": 5,
      "hits": [
        574.31
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
    "gearSkill": true,
    "skill": {
      "name": "闪亮登场~☆+",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "atk",
          "value": 0.2233,
          "turns": 4,
          "channel": 2
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "acc",
          "value": 0.1936,
          "turns": 4,
          "channel": 5
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
    "id": "KAYOKO",
    "sid": 13005,
    "name": "佳代子",
    "star": 3,
    "baseStar": 2,
    "atkType": "爆发",
    "defType": "重装",
    "role": "辅助",
    "bullet": "Explosion",
    "armor": "HeavyArmor",
    "hp": 2545,
    "atk": 129,
    "dfs": 20,
    "healPower": 1628,
    "acc": 98,
    "dodge": 1088,
    "crit": 197,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1008,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "恐慌射击",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "cc",
          "scope": "enemy",
          "icon": "Fear",
          "chance": 0.3,
          "turns": 1
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 4
      },
      "hits": [
        132.83
      ]
    },
    "ex": {
      "name": "恐慌传播者",
      "target": "enemy_all",
      "count": 4,
      "area": 1539380,
      "effects": [
        {
          "type": "cc",
          "scope": "enemy",
          "icon": "Fear",
          "chance": 1,
          "turns": 1
        }
      ],
      "cost": 6,
      "hits": [
        349.08
      ]
    }
  },
  {
    "id": "MUTSUKI",
    "sid": 13006,
    "name": "睦月",
    "star": 3,
    "baseStar": 2,
    "atkType": "爆发",
    "defType": "轻装",
    "role": "输出",
    "bullet": "Explosion",
    "armor": "LightArmor",
    "hp": 2531,
    "atk": 232,
    "dfs": 80,
    "healPower": 1637,
    "acc": 99,
    "dodge": 199,
    "crit": 199,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1404,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "爆裂咏叹调",
      "target": "enemy_adjacent",
      "count": 3,
      "area": 31416,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 4
      },
      "hits": [
        334.59
      ]
    },
    "ex": {
      "name": "灼热小夜曲",
      "target": "enemy_adjacent",
      "count": 3,
      "area": 49087,
      "effects": [],
      "cost": 4,
      "hits": [
        409.72
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
    "gearSkill": true,
    "skill": {
      "name": "瞄准射击+",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        30.5397,
        30.5397,
        30.5397,
        30.5397,
        30.5397,
        30.5397,
        30.5397,
        30.5397,
        30.5397,
        30.5397,
        30.5733
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
          "turns": 6,
          "channel": 2
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

/** 召唤物按名字查，供「伊织ex打佩洛洛人偶」这种指令定位。允许省略「人偶」等后缀 */
export function findSummon(token) {
  const s = String(token).trim()
  if (!s) return null
  return Object.values(SUMMONS).find((t) => t.name === s || t.name.startsWith(s)) || null
}
