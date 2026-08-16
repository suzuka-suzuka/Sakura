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
    "line": "后",
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
    "line": "前",
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
    "line": "后",
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
      },
      "depth": "through"
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
    "line": "中",
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
    "line": "后",
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
    "line": "前",
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
    "line": "后",
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
    "line": "后",
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
    "line": "后",
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
        "type": "on_auto",
        "chance": 0.2,
        "turns": 2
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
          "stat": "aa",
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
    "line": "中",
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
    "id": "SHUN",
    "sid": 10011,
    "name": "瞬",
    "star": 3,
    "baseStar": 3,
    "atkType": "爆发",
    "defType": "轻装",
    "role": "输出",
    "line": "后",
    "bullet": "Explosion",
    "armor": "LightArmor",
    "hp": 2495,
    "atk": 393,
    "dfs": 19,
    "healPower": 1661,
    "acc": 908,
    "dodge": 201,
    "crit": 252,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1980,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "请大家集中精神！",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "cost",
          "scope": "self",
          "value": 2
        }
      ],
      "trigger": {
        "type": "battle_start",
        "maxUses": 1
      }
    },
    "ex": {
      "name": "坏孩子在哪呢？",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "charge",
          "hits": [
            153.12
          ],
          "count": 1,
          "turns": 6,
          "targeting": "max_atk"
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "aa",
          "value": -0.1882,
          "turns": 6,
          "channel": 524
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "crit",
          "value": 0.2635,
          "turns": 6,
          "channel": 9
        }
      ],
      "cost": 3
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
    "line": "前",
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
      "target": "enemy_chain",
      "count": 3,
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
    "line": "前",
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
          "stat": "aa",
          "value": 0.2559,
          "turns": 4,
          "channel": 24
        }
      ],
      "trigger": {
        "type": "on_kill",
        "turns": 2
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
          "hits": [
            69.355,
            69.355
          ],
          "count": 2,
          "shots": 2
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
    "line": "中",
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
    "line": "中",
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
    "line": "中",
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
        "type": "on_auto",
        "chance": 0.1,
        "turns": 3
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
    "line": "后",
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
        "type": "on_kill",
        "turns": 0
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
    "line": "后",
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
    "line": "中",
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
    "line": "后",
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
    "id": "JUNKO",
    "sid": 13007,
    "name": "纯子",
    "star": 3,
    "baseStar": 2,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "输出",
    "line": "中",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2536,
    "atk": 335,
    "dfs": 20,
    "healPower": 1635,
    "acc": 695,
    "dodge": 794,
    "crit": 198,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1408,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "别在我肚子饿的时候搭话！+",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "ex_discount",
          "scope": "self",
          "mode": "flat",
          "value": 4,
          "uses": 2
        },
        {
          "type": "immortal",
          "scope": "self",
          "turns": 3
        }
      ],
      "trigger": {
        "type": "hp_below",
        "value": 0.2,
        "maxUses": 1
      }
    },
    "ex": {
      "name": "空腹的愤怒",
      "target": "enemy_adjacent",
      "count": 3,
      "area": 135000,
      "effects": [
        {
          "type": "hp_cost",
          "scope": "self",
          "rate": 0.257
        }
      ],
      "cost": 5,
      "hits": [
        186.5075,
        186.5075,
        186.5075,
        186.5075
      ],
      "depth": "through"
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
    "line": "中",
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
  },
  {
    "id": "TSUBAKI",
    "sid": 13009,
    "name": "椿",
    "star": 3,
    "baseStar": 2,
    "atkType": "贯通",
    "defType": "特殊",
    "role": "坦克",
    "line": "前",
    "bullet": "Pierce",
    "armor": "Unarmed",
    "hp": 3414,
    "atk": 209,
    "dfs": 30,
    "healPower": 1618,
    "acc": 98,
    "dodge": 1416,
    "crit": 196,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1420,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "睡眠，大补",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "heal",
          "scope": "self",
          "scale": 3.4928,
          "source": "heal"
        }
      ],
      "trigger": {
        "type": "hp_below",
        "value": 0.3,
        "maxUses": 1
      }
    },
    "ex": {
      "name": "展开战术盾牌",
      "target": "self",
      "count": 1,
      "area": 1539380,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "dfs",
          "value": 0.2811,
          "turns": 6,
          "channel": 3
        },
        {
          "type": "taunt",
          "kind": "provoke",
          "scope": "self",
          "turns": 1
        }
      ],
      "cost": 4
    }
  },
  {
    "id": "YUUKA",
    "sid": 13010,
    "name": "优香",
    "star": 3,
    "baseStar": 2,
    "atkType": "爆发",
    "defType": "重装",
    "role": "坦克",
    "line": "前",
    "bullet": "Explosion",
    "armor": "HeavyArmor",
    "hp": 3357,
    "atk": 132,
    "dfs": 29,
    "healPower": 1645,
    "acc": 100,
    "dodge": 1440,
    "crit": 200,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1396,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "I.F.F+",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "dodge",
          "value": 0.2602,
          "turns": 2,
          "channel": 7
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 3
      },
      "hits": [
        36.6315,
        36.5986,
        36.5986,
        36.5986,
        36.5986,
        36.5986,
        36.5986,
        36.5986,
        36.5986
      ]
    },
    "ex": {
      "name": "Q.E.D",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "shield",
          "scope": "self",
          "scale": 1.9054,
          "source": "heal",
          "turns": 3
        }
      ],
      "cost": 3
    }
  },
  {
    "id": "HARUKA",
    "sid": 16000,
    "name": "春香",
    "star": 3,
    "baseStar": 1,
    "atkType": "爆发",
    "defType": "轻装",
    "role": "坦克",
    "line": "前",
    "bullet": "Explosion",
    "armor": "LightArmor",
    "hp": 3397,
    "atk": 142,
    "dfs": 182,
    "healPower": 1627,
    "acc": 593,
    "dodge": 237,
    "crit": 197,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 2020,
    "autoAttack": {
      "hits": [
        33.34,
        33.33,
        33.33
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "一触即发",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "dfs",
          "value": 0.1898,
          "turns": 4,
          "channel": 3
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 4
      }
    },
    "ex": {
      "name": "混乱射击",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 79522,
      "effects": [],
      "cost": 4,
      "hits": [
        91.2398,
        91.2398,
        91.2398,
        91.2398,
        91.2398,
        91.2398,
        91.2398,
        91.2398,
        91.2398
      ]
    }
  },
  {
    "id": "ASUNA",
    "sid": 16001,
    "name": "明日奈",
    "star": 3,
    "baseStar": 1,
    "atkType": "神秘",
    "defType": "轻装",
    "role": "输出",
    "line": "中",
    "bullet": "Mystic",
    "armor": "LightArmor",
    "hp": 2587,
    "atk": 325,
    "dfs": 20,
    "healPower": 1601,
    "acc": 681,
    "dodge": 778,
    "crit": 243,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1436,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "我要开火咯！＋",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "aa",
          "value": 0.242,
          "turns": 4,
          "channel": 24
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 4
      },
      "hits": [
        24.4494,
        24.4494,
        24.4494,
        24.4494,
        24.4494,
        24.4494,
        24.4494,
        24.4494,
        24.4494,
        24.4494,
        24.4494
      ],
      "hpRate": {
        "lo": 0,
        "hi": 1,
        "atLo": 1.5,
        "atHi": 1
      }
    },
    "ex": {
      "name": "要冲了哦！",
      "target": "self",
      "count": 1,
      "area": 20000,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "dodge",
          "value": 0.4341,
          "turns": 1,
          "channel": 7
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "aa",
          "value": 0.302,
          "turns": 6,
          "channel": 24
        }
      ],
      "cost": 2
    }
  },
  {
    "id": "SUZUMI",
    "sid": 16003,
    "name": "铃美",
    "star": 3,
    "baseStar": 1,
    "atkType": "爆发",
    "defType": "重装",
    "role": "辅助",
    "line": "中",
    "bullet": "Explosion",
    "armor": "HeavyArmor",
    "hp": 2555,
    "atk": 235,
    "dfs": 20,
    "healPower": 1622,
    "acc": 690,
    "dodge": 788,
    "crit": 197,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1416,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "巡逻者的潜能+",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "cc",
          "scope": "enemy",
          "icon": "Stunned",
          "chance": 1,
          "turns": 1
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        25.452,
        25.452,
        25.452,
        25.452,
        25.452,
        25.452,
        25.452,
        25.452,
        25.452,
        25.452
      ]
    },
    "ex": {
      "name": "自制闪光弹",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 70686,
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
        389.14
      ]
    }
  },
  {
    "id": "PINA",
    "sid": 16004,
    "name": "菲娜",
    "star": 3,
    "baseStar": 1,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "输出",
    "line": "后",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2582,
    "atk": 309,
    "dfs": 81,
    "healPower": 1604,
    "acc": 97,
    "dodge": 195,
    "crit": 243,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1432,
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
      "name": "再次燃烧！",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "heal",
          "scope": "self",
          "scale": 3.5523,
          "source": "heal"
        }
      ],
      "trigger": {
        "type": "hp_below",
        "value": 0.2,
        "maxUses": 1
      }
    },
    "ex": {
      "name": "连射模式！",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "aa",
          "value": 0.3256,
          "turns": 6,
          "channel": 17
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "atk",
          "value": 0.2912,
          "turns": 6,
          "channel": 2
        }
      ],
      "cost": 4,
      "thenAutoAttack": true
    }
  },
  {
    "id": "IZUNA",
    "sid": 10014,
    "name": "泉奈",
    "star": 3,
    "baseStar": 3,
    "atkType": "神秘",
    "defType": "轻装",
    "role": "输出",
    "line": "前",
    "bullet": "Mystic",
    "armor": "LightArmor",
    "hp": 2835,
    "atk": 225,
    "dfs": 22,
    "healPower": 1624,
    "acc": 108,
    "dodge": 1066,
    "crit": 246,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1416,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "秘技！爆炸手里剑！",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 31416,
      "effects": [],
      "trigger": {
        "type": "on_auto",
        "chance": 1,
        "every": 6,
        "turns": 0
      },
      "hits": [
        444.73
      ]
    },
    "ex": {
      "name": "泉奈忍法帖！",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "reposition",
          "scope": "self",
          "range": 1
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "aa",
          "value": 0.2744,
          "turns": 6,
          "channel": 24
        }
      ],
      "cost": 3
    }
  },
  {
    "id": "YUZU",
    "sid": 10018,
    "name": "柚子",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "特殊",
    "role": "输出",
    "line": "中",
    "bullet": "Pierce",
    "armor": "Unarmed",
    "hp": 2461,
    "atk": 435,
    "dfs": 19,
    "healPower": 1683,
    "acc": 102,
    "dodge": 195,
    "crit": 191,
    "critDmg": 24000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 976,
    "autoAttack": {
      "hits": [
        100
      ],
      "target": "enemy_adjacent",
      "count": 2
    },
    "gearSkill": true,
    "skill": {
      "name": "达成连击！＋",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 31416,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "crit",
          "value": 0.1786,
          "turns": 4,
          "channel": 9
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "hits": [
        159.54
      ],
      "pick": "max_atk"
    },
    "ex": {
      "name": "游戏开始！",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 125664,
      "effects": [],
      "cost": 4,
      "hits": [
        312.92
      ]
    }
  },
  {
    "id": "AZUSA",
    "sid": 10019,
    "name": "梓",
    "star": 3,
    "baseStar": 3,
    "atkType": "爆发",
    "defType": "重装",
    "role": "输出",
    "line": "中",
    "bullet": "Explosion",
    "armor": "HeavyArmor",
    "hp": 2496,
    "atk": 231,
    "dfs": 19,
    "healPower": 1661,
    "acc": 706,
    "dodge": 792,
    "crit": 201,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1384,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "sagitta mortis",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "enemy",
          "stat": "dfs",
          "value": -0.1899,
          "turns": 4,
          "channel": 603
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 6
      },
      "hits": [
        292.67
      ]
    },
    "ex": {
      "name": "intulit mortem",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "cost": 5,
      "hits": [
        44.4526,
        44.4526,
        44.4526,
        44.4526,
        44.4526,
        44.4526,
        44.4526,
        44.4526,
        44.4526,
        44.4526,
        44.4526,
        44.4526,
        533.005
      ]
    }
  },
  {
    "id": "NERU",
    "sid": 10008,
    "name": "妮露",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "输出",
    "line": "前",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2523,
    "atk": 254,
    "dfs": 17,
    "healPower": 1643,
    "acc": 99,
    "dodge": 958,
    "crit": 274,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1400,
    "autoAttack": {
      "hits": [
        16.66,
        16.66,
        16.67,
        16.67,
        16.67,
        16.67
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "啊~？把我当傻子是吧？！+",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "dodge",
          "value": 0.1947,
          "turns": 4,
          "channel": 7
        },
        {
          "type": "state",
          "key": "fury",
          "scope": "self",
          "turns": 4
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 6
      }
    },
    "ex": {
      "name": "啊~？活腻了吧你？",
      "target": "enemy_single",
      "count": 1,
      "effects": [],
      "cost": 2,
      "hits": [
        4.7679,
        4.7679,
        4.7679,
        4.7679,
        4.7679,
        4.7679,
        4.7679,
        4.7679,
        4.7679,
        4.7679,
        4.7679,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6776,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299,
        8.6299
      ],
      "altHits": [
        {
          "state": "fury",
          "min": 1,
          "hits": [
            9.5358,
            9.5358,
            9.5358,
            9.5358,
            9.5358,
            9.5358,
            9.5358,
            9.5358,
            9.5358,
            9.5358,
            9.5358,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.3552,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598,
            17.2598
          ],
          "total": 952.72
        }
      ]
    }
  },
  {
    "id": "KOTORI",
    "sid": 16002,
    "name": "琴里",
    "star": 3,
    "baseStar": 1,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "辅助",
    "line": "后",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2534,
    "atk": 227,
    "dfs": 80,
    "healPower": 1636,
    "acc": 99,
    "dodge": 198,
    "crit": 198,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1404,
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
      "name": "对不起！+",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 105592,
      "effects": [],
      "trigger": {
        "type": "cooldown",
        "turns": 7
      },
      "hits": [
        2.2034,
        2.2034,
        2.9378,
        2.9378,
        3.6723,
        3.6723,
        4.4068,
        4.4068,
        5.1412,
        5.1412,
        5.8757,
        5.8757,
        6.6101,
        6.6101,
        7.3446,
        7.3446,
        8.0791,
        8.0791,
        8.8135,
        8.8135,
        9.548,
        9.548,
        10.2824,
        10.2824,
        11.0169,
        11.0169,
        11.7514,
        11.7514,
        12.4858,
        12.4858,
        13.2203,
        13.2203,
        13.9547,
        13.9547,
        14.6892,
        14.6892,
        15.4237,
        15.4237,
        16.1581,
        16.1581
      ]
    },
    "ex": {
      "name": "解答箱",
      "target": "ally_all",
      "count": 4,
      "effects": [
        {
          "type": "shield",
          "scope": "ally_all",
          "scale": 1.7595,
          "source": "heal",
          "turns": 3
        }
      ],
      "cost": 4
    }
  },
  {
    "id": "ARIS",
    "sid": 10015,
    "name": "爱丽丝",
    "star": 3,
    "baseStar": 3,
    "atkType": "神秘",
    "defType": "特殊",
    "role": "输出",
    "line": "后",
    "bullet": "Mystic",
    "armor": "Unarmed",
    "hp": 2142,
    "atk": 514,
    "dfs": 68,
    "healPower": 1892,
    "acc": 690,
    "dodge": 170,
    "crit": 230,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1188,
    "autoAttack": {
      "hits": [
        100
      ],
      "target": "enemy_adjacent",
      "count": 2
    },
    "gearSkill": true,
    "skill": {
      "name": "光呀！＋",
      "target": "self",
      "count": 1,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "crit",
          "value": 0.1859,
          "turns": 4,
          "channel": 9
        },
        {
          "type": "buff",
          "scope": "self",
          "stat": "crit_dmg",
          "value": 0.1487,
          "turns": 4,
          "channel": 11
        },
        {
          "type": "state",
          "key": "energy",
          "scope": "self",
          "step": 1,
          "max": 2
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      },
      "stateStart": {
        "key": "energy",
        "value": 1
      }
    },
    "ex": {
      "name": "平衡崩坏！",
      "target": "enemy_all",
      "count": 4,
      "area": 400000,
      "effects": [
        {
          "type": "state",
          "key": "energy",
          "scope": "self",
          "value": 0
        }
      ],
      "cost": 6,
      "hits": [
        311.15
      ],
      "depth": "through",
      "altHits": [
        {
          "state": "energy",
          "min": 2,
          "hits": [
            622.25
          ],
          "total": 622.25
        },
        {
          "state": "energy",
          "min": 1,
          "hits": [
            466.7
          ],
          "total": 466.7
        }
      ]
    }
  },
  {
    "id": "MIDORI",
    "sid": 10016,
    "name": "绿",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "输出",
    "line": "后",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2489,
    "atk": 385,
    "dfs": 19,
    "healPower": 1665,
    "acc": 911,
    "dodge": 197,
    "crit": 202,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1972,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "审美锤炼＋",
      "target": "ally_lowest",
      "count": 1,
      "exceptSelf": true,
      "effects": [
        {
          "type": "heal",
          "scope": "ally_target",
          "scale": 0.846,
          "source": "heal"
        },
        {
          "type": "heal",
          "scope": "ally_named",
          "scale": 0.8698,
          "source": "heal",
          "ally": "MOMOI"
        },
        {
          "type": "buff",
          "scope": "ally_named",
          "stat": "atk",
          "value": 0.2195,
          "turns": 5,
          "channel": 102,
          "ally": "MOMOI"
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 5
      }
    },
    "ex": {
      "name": "绘画艺术",
      "target": "enemy_cycle",
      "count": 5,
      "effects": [
        {
          "type": "dot",
          "scope": "enemy",
          "icon": "Poison",
          "scale": 0.3987,
          "turns": 4,
          "period": 1,
          "ifAlly": "MOMOI"
        }
      ],
      "cost": 3,
      "hits": [
        119.64,
        119.64,
        119.64,
        119.64,
        119.64
      ]
    }
  },
  {
    "id": "MOMOI",
    "sid": 13011,
    "name": "桃",
    "star": 3,
    "baseStar": 2,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "输出",
    "line": "中",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2588,
    "atk": 258,
    "dfs": 20,
    "healPower": 1601,
    "acc": 681,
    "dodge": 821,
    "crit": 194,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1436,
    "autoAttack": {
      "hits": [
        33.33,
        33.33,
        33.34
      ]
    },
    "gearSkill": true,
    "skill": {
      "name": "死守期限＋",
      "target": "ally_all",
      "count": 4,
      "effects": [
        {
          "type": "buff",
          "scope": "self",
          "stat": "acc",
          "value": 0.2434,
          "turns": 4,
          "channel": 5
        },
        {
          "type": "buff",
          "scope": "ally_named",
          "stat": "atk",
          "value": 0.2195,
          "turns": 5,
          "channel": 102,
          "ally": "MIDORI"
        },
        {
          "type": "buff",
          "scope": "ally_named",
          "stat": "enh_Pierce",
          "value": 0.132,
          "turns": 5,
          "channel": 133,
          "ally": "MIDORI"
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 6
      }
    },
    "ex": {
      "name": "创作的痛苦",
      "target": "enemy_adjacent",
      "count": 3,
      "area": 283725,
      "effects": [
        {
          "type": "dot",
          "scope": "enemy",
          "icon": "Burn",
          "scale": 0.7204,
          "turns": 4,
          "period": 1,
          "ifAlly": "MIDORI"
        }
      ],
      "cost": 3,
      "hits": [
        112.7954,
        112.7954,
        112.8292
      ],
      "depth": "through"
    }
  },
  {
    "id": "CHERINO",
    "sid": 10017,
    "name": "切里诺",
    "star": 3,
    "baseStar": 3,
    "atkType": "贯通",
    "defType": "轻装",
    "role": "输出",
    "line": "中",
    "bullet": "Pierce",
    "armor": "LightArmor",
    "hp": 2477,
    "atk": 210,
    "dfs": 19,
    "healPower": 1673,
    "acc": 101,
    "dodge": 1081,
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
      "name": "铲除那家伙！",
      "target": "enemy_single",
      "count": 1,
      "effects": [
        {
          "type": "taunt",
          "kind": "focus",
          "scope": "enemy",
          "turns": 3
        },
        {
          "type": "buff",
          "scope": "enemy",
          "stat": "crit_dmg_res",
          "value": -0.1875,
          "turns": 3,
          "channel": 623
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 8
      },
      "pick": "max_atk"
    },
    "ex": {
      "name": "召唤亲卫队！",
      "target": "enemy_all",
      "count": 4,
      "area": 3141593,
      "effects": [],
      "cost": 7,
      "hits": [
        128.9575,
        128.9575,
        128.9575,
        128.9575
      ]
    }
  },
  {
    "id": "KOHARU",
    "sid": 10020,
    "name": "小春",
    "star": 3,
    "baseStar": 3,
    "atkType": "爆发",
    "defType": "重装",
    "role": "治疗",
    "line": "后",
    "bullet": "Explosion",
    "armor": "HeavyArmor",
    "hp": 2729,
    "atk": 254,
    "dfs": 24,
    "healPower": 2530,
    "acc": 923,
    "dodge": 194,
    "crit": 205,
    "critDmg": 20000,
    "critRes": 100,
    "critDmgRes": 5000,
    "stability": 1948,
    "autoAttack": {
      "hits": [
        100
      ]
    },
    "gearSkill": false,
    "skill": {
      "name": "我来治疗！",
      "target": "ally_hurt",
      "count": 1,
      "exceptSelf": true,
      "hpMax": 0.5,
      "effects": [
        {
          "type": "heal",
          "scope": "ally_target",
          "scale": 0.8085,
          "source": "heal"
        }
      ],
      "trigger": {
        "type": "cooldown",
        "turns": 2,
        "icd": true
      }
    },
    "ex": {
      "name": "神圣手榴弹",
      "target": "enemy_adjacent",
      "count": 2,
      "area": 125664,
      "effects": [
        {
          "type": "heal",
          "scope": "ally_mirror",
          "scale": 1.0145,
          "source": "heal"
        }
      ],
      "cost": 3,
      "hits": [
        227.31
      ]
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
