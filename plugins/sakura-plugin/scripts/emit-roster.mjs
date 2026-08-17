/**
 * SchaleDB → roster.js 生成器
 * 改 IDS 就能扩充角色池；所有折算规则集中在本文件顶部常数。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, "..", "lib", "ba", "roster.js")

const arr = (() => {
  const d = JSON.parse(fs.readFileSync(path.join(HERE, "students.json"), "utf8"))
  return Array.isArray(d) ? d : Object.values(d)
})()
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "cfg.json"), "utf8"))
const summonData = (() => {
  const d = JSON.parse(fs.readFileSync(path.join(HERE, "summons.json"), "utf8"))
  return Array.isArray(d) ? d : Object.values(d)
})()

const FORCE_STAR = 3, LEVEL = 1, SKILL_LV = 0, ROUND_SEC = 5
/**
 * 有爱用品的角色，普通技能取爱用品强化版（`Skills.GearPublic`，272 人里 66 人有）。
 *
 * 只吃技能强化，**不吃爱用品的属性加成**：那些是 `_Base` 定值、按满级面板标定，
 * 套到 LEVEL=1 上中位会放大到角色本体攻击的 288%（野宫 263 → 763，×2.9）。
 * 技能强化则是 Scale（万分比）与 Coefficient（百分比），与等级无关，
 * 36 件带伤害的倍率提升中位只有 ×1.20，量纲干净。
 */
const USE_GEAR_SKILL = true
/** 原作 PvP 的时间参数：一局 4 分钟，剩余不足 1 分钟进白热化 */
const BATTLE_SEC = 240, FEVER_LEFT_SEC = 60
const TRANS = [[0, 1000, 1200, 1400, 1700], [0, 500, 700, 900, 1400], [0, 750, 1000, 1200, 1500]]
const AOE_T1 = 126000, AOE_T2 = 300000

/**
 * 角色池。按**上线顺序**（SchaleDB 的 `DefaultOrder`）取可生成的前 15 位，再加芹香。
 *
 * 可生成 = EX 与普通技能都不含 Summon / Special / Accumulation（那几类要手写逻辑），
 * 且没有未映射的 Buff 属性，且名字不带括号（`findUnit` 精确匹配，变体名玩家难打）。
 * 272 人里满足这三条的只有 108 人。
 *
 * 芹香排第 19 位，本来进不了前 16，但她已经在池里、且是唯一的 11 段角色，
 * 保留她挤掉了第 16 位的佳代子（辅助）。
 *
 * `Special` 里做掉了 `FormChange` 之后，鹤城和瞬也进得来了（原先按「EX 含 Special」一刀切挡掉）。
 * 纯子排第 21 位，接了不死 / EX 打折 / 自伤三样之后才上得来。
 * 椿 / 优香 / 春香排 23~25 位，池里坦克只有星野和艾米，补三个不同装甲的坦克。
 *
 * **目标是补齐到小春（`DefaultOrder 56`）的全部 57 人**，分批上。第一批是 26~54 位里
 * 「改 IDS 就能进」的六个主力：明日奈、铃美、菲娜、泉奈、柚子、梓。
 * 顺手补了三条描述规则（位移 / 无视开火间隔 / 每 N 次普攻），见各自的注释。
 *
 * 代号取 SchaleDB 的 `PathName` 转大写，会成为 resources/ba/characters/ 的目录名。
 */
const IDS = [
  [10000, "ARU"], [10001, "EIMI"], [10002, "HARUNA"], [10003, "HIFUMI"], [10004, "HINA"],
  [10005, "HOSHINO"], [10006, "IORI"], [10007, "MAKI"], [10009, "IZUMI"],
  [10010, "SHIROKO"], [10011, "SHUN"], [10012, "SUMIRE"], [10013, "TSURUGI"], [13000, "AKANE"],
  [13001, "CHISE"], [13002, "AKARI"], [13003, "HASUMI"], [13004, "NONOMI"],
  [13005, "KAYOKO"], [13006, "MUTSUKI"], [13007, "JUNKO"], [13008, "SERIKA"],
  [13009, "TSUBAKI"], [13010, "YUUKA"], [16000, "HARUKA"],
  [16001, "ASUNA"], [16003, "SUZUMI"], [16004, "PINA"],
  [10014, "IZUNA"], [10018, "YUZU"], [10019, "AZUSA"],
  // 第二批：要补生成器规则的六个主力 + 妮露
  [10008, "NERU"], [16002, "KOTORI"], [10015, "ARIS"],
  [10016, "MIDORI"], [13011, "MOMOI"], [10017, "CHERINO"], [10020, "KOHARU"],
  /**
   * 第三批：**支援位**（`SquadType: "Support"`），小春之前的 19 人减去歌原。
   *
   * 歌原不加 —— 她的 EX 和普通技能都是会打人的炮台（雷ちゃん / 雷ちゃんMK-II），
   * 召唤物还没有自己的行动位，接进来只会是两堵不会动的墙。
   * 志美子的掩体在技能 1 级血量是 0（原文那句「掩体额外拥有…」在 1/2 级根本不出现），
   * 按现有「1 级数值为 0 就标 inactive」的口径她不部署掩体，EX 只剩全队 +16.4% 防御。
   */
  [20000, "HIBIKI"], [20001, "KARIN"], [20002, "SAYA"], [20003, "MASHIRO"],
  [23000, "AIRI"], [23001, "FUUKA"], [23002, "HANAE"], [23003, "HARE"],
  [23005, "AYANE"], [23006, "SHIZUKO"], [23007, "HANAKO"],
  [26000, "CHINATSU"], [26001, "KOTAMA"], [26002, "JURI"], [26003, "SERINA"],
  [26004, "SHIMIKO"], [26005, "YOSHIMI"], [26006, "NODOKA"],
]

/**
 * 「编队内已编入 X 时」「对 X(如在场)」里的 X → SchaleDB 的角色名。
 * 原数据这里的写法不统一：桃的技能里写「绿」（跟 `Name` 一致），
 * 绿的技能里却写「桃井」（日文姓，`Name` 是「桃」），只能手工对一行。
 */
const ALLY_NAME_ALIAS = { 桃井: "桃" }

const BULLET_CN = { Explosion: "爆发", Pierce: "贯通", Mystic: "神秘", Sonic: "振动", Chemical: "变化" }
// 短名与 BaBattleImageGenerator 的 ARMOR_VISUAL 键一致（该表的 label 里存全称）
// 构造物是召唤物专用的第六种装甲（掩体），官方克制表里对**所有**攻击属性都是 ×0.5。
// 不补这一条的话下面 summonTmpl 的 `|| "轻装"` 会静默把它退成轻装 —— 一堵「谁打都减半」的墙
// 变成「爆发打它翻倍」，方向正好反了，而且压测查不出来。
const ARMOR_CN = { LightArmor: "轻装", HeavyArmor: "重装", Unarmed: "特殊", ElasticArmor: "弹力", CompositeArmor: "复合", Structure: "构造物" }
const ROLE_CN = { Tanker: "坦克", DamageDealer: "输出", Healer: "治疗", Supporter: "辅助", Vehicle: "载具" }
const LINE_CN = { Front: "前", Middle: "中", Back: "后" }

const interp = (s1, s100, lv, tr = 1) => {
  const ls = Number(((lv - 1) / 99).toFixed(4))
  return Math.ceil(Number((Math.round(Number((s1 + (s100 - s1) * ls).toFixed(4))) * tr).toFixed(4)))
}
const starMul = (g) => {
  let a = 1, h = 1, e = 1
  for (let i = 0; i < g; i++) { a += TRANS[0][i] / 1e4; h += TRANS[1][i] / 1e4; e += TRANS[2][i] / 1e4 }
  return { atk: a, hp: h, heal: e }
}
/**
 * 秒 → `turns`。原作双方是同时打的，蓝回合与红回合是同一段 5 秒的两次呈现，
 * 各自跑完一遍四人普攻循环（实测 4.0~6.6 秒），所以时间刻度是**轮**不是回合。
 * 引擎里冷却与时长都只在自己方的回合跳，一轮正好跳一次，故除数就是 ROUND_SEC。
 */
const msToTurns = (ms) => (ms ? Math.max(1, Math.ceil(ms / (ROUND_SEC * 1000))) : null)
const secToTurns = (s) => Math.max(1, Math.ceil(s / ROUND_SEC))

const shapeArea = (r) => {
  switch (r.Type) {
    case "Circle": case "Bounce": return Math.PI * r.Radius ** 2
    case "Fan": return Math.PI * r.Radius ** 2 * (r.Degree / 360)
    case "Obb": return r.Width * r.Height
    case "Donut": return Math.PI * (r.Radius ** 2 - (r.ExcludeRadius || 0) ** 2) * ((r.Degree || 360) / 360)
  }
  return 0
}

/** 几何 → 目标语义。回合制没有坐标，只保留「打几个」。 */
function resolveTarget(sk, effTargets) {
  // 伤害效果在原数据里不写 Target，隐含打敌方（跟 RIDES_DAMAGE 同一个约定）。
  // 只看 Target 列表会把「造成伤害 + 给自己上 Buff」的技能整个判成打自己 ——
  // 真纪的 EX 就会 744% 砸在自己脸上。全 272 人里有 14 个技能踩这条。
  const hasDamage = (sk.Effects || []).some((e) => e.Type === "Damage")
  const ally = !hasDamage && effTargets.some((t) => /Ally/.test(t))
  const selfOnly = !hasDamage && effTargets.length > 0 && effTargets.every((t) => t === "Self")
  if (!sk.Radius) {
    if (selfOnly) return { target: "self", count: 1 }
    // 没有半径的己方技能默认是单体。真·全体必须由描述里的「我方全体 / 对 N 名」说清楚，
    // 见 allyPickOf —— 曾经这里一律 ally_all，花江 / 千夏的单奶、风香的「上限最高」全变成群奶。
    if (ally) return { target: "ally_single", count: 1 }
    return { target: "enemy_single", count: 1 }
  }
  if (sk.Radius[0].Type === "Bounce") return { target: "enemy_random", count: 1 }
  const a = sk.Radius.reduce((s, r) => s + shapeArea(r), 0)
  const count = a <= AOE_T1 ? 2 : a <= AOE_T2 ? 3 : 4
  if (ally) return { target: count >= 4 ? "ally_all" : "ally_adjacent", count }
  return { target: count >= 4 ? "enemy_all" : "enemy_adjacent", count, area: Math.round(a) }
}

/** BA 的 Buff.Stat → 引擎内部属性名。回合制无对应物的直接丢弃。 */
const STAT_MAP = {
  AttackPower_Coefficient: "atk", AttackPower_Base: "atk_flat",
  DefensePower_Coefficient: "dfs", DefensePower_Base: "dfs_flat",
  MaxHP_Coefficient: "maxhp", MaxHP_Base: "maxhp_flat",
  HealPower_Coefficient: "heal", HealPower_Base: "heal_flat",
  CriticalPoint_Coefficient: "crit", CriticalDamageRate_Coefficient: "crit_dmg",
  CriticalDamageRate_Base: "crit_dmg_flat",
  AccuracyPoint_Coefficient: "acc", DodgePoint_Coefficient: "dodge",
  // 爱用品强化技能会给这两项抵抗上增益，引擎侧 critResOf / critDmgResOf 有对应的层
  CriticalDamageResistRate_Base: "crit_dmg_res_flat",
  CriticalChanceResistPoint_Coefficient: "crit_res",
  // 攻速在回合制里没有第二枪，折成普攻增伤（aa）。只乘在普攻上，
  // EX / 普通技能不吃。鹤城 EX 后的 thenAutoAttack 走普攻，所以会吃到。
  AttackSpeed_Coefficient: "aa",
  DamagedRatio2_Coefficient: "dmg_take", HealEffectivenessRate_Coefficient: "heal_taken",
  // 切里诺的普技减暴伤抵抗。原来只映了 `_Base` 那档（爱用品用的），系数档是另一个字段
  CriticalDamageResistRate_Coefficient: "crit_dmg_res",
  // 属性增伤（爱用品，5 件）。引擎按**攻击者的弹种**匹配，见 strike 的 enhOf
  EnhancePierceRate_Base: "enh_Pierce",
  EnhanceMysticRate_Base: "enh_Mystic",
  EnhanceExplosionRate_Base: "enh_Explosion",
  EnhanceSonicRate_Base: "enh_Sonic",
  EnhanceChemicalRate_Base: "enh_Chemical",
}
/**
 * 名字带 `_Base` 但**值是万分比**的那几个。属性增伤原文写「加算13.2%」，
 * `Value` 是 1320 —— 照 `_Base` 当定值读会变成「+1320」。
 */
const BP_BASE_STAT = /^Enhance\w+Rate_Base$/
const DROP_STAT = /Range|MoveSpeed|Oppression|BlockRate/

/**
 * 「无视每 N 次普通攻击间的开火间隔」（`IgnoreDelayCount_Base`，全 272 人 4 处，池内只有菲娜）。
 *
 * 它跟 `AttackSpeed_Coefficient` 是**同一个物理量**——射速——只是一个用百分比写、
 * 一个用帧数写，所以走同一条口径折成普攻增伤 `aa`，别当成没有对应物丢掉。
 *
 * 一发普攻的周期 = 抬手 + 射击 + 收手 + **开火间隔**（`Frames.AttackBurstRoundOverDelay`）。
 * N 发连打时中间那 N−1 个间隔被吃掉：`N(a+d)` → `N·a+d`，提速 = `(a+d)/(a+d/N)`。
 * 菲娜 a=21+19+32=72、d=42、N=3 → 114/86 = **+32.6%**。
 *
 * `Value` 超过 20 的不是「次数」（惠 8492、桃（女仆）100 是另一种量纲），认不了就丢。
 * @returns {number|null} 折成 aa 的增幅；取不到帧数时返回 null
 */
function ignoreDelayToAa(student, n) {
  const f = one(student?.Skills?.Normal)?.Frames
  if (!f || !n || n > 20) return null
  const a = (f.AttackStartDuration || 0) + (f.AttackIngDuration || 0) + (f.AttackEndDuration || 0)
  const d = f.AttackBurstRoundOverDelay || 0
  if (!a || !d) return null
  return Number(((a + d) / (a + d / n) - 1).toFixed(4))
}

/** 同一个槽位有时是数组有时是对象，统一取第一条 */
const one = (x) => (Array.isArray(x) ? x[0] : x)

/**
 * 技能描述。`<?N>` 是按技能等级取值的占位符（第 N 个 `Parameters` 数组），
 * 回填之后才能用正则抠数字 —— 瞬的「获得<?1>技能COST」不填就只剩一个尖括号。
 */
const descOf = (sk) =>
  String(sk?.Desc || "").replace(/<\?(\d+)>/g, (m, n) => sk.Parameters?.[Number(n) - 1]?.[SKILL_LV] ?? m)

/** 从中文描述里抠出触发规则（BA 数据没有结构化的触发字段）。 */
function parseTrigger(desc) {
  if (!desc) return { type: "cooldown", turns: 5 }
  // 「该技能仅可触发」才是整条技能的次数（星野 / 椿 / 纯子）。
  // 「该效果仅可触发」是某一条效果的次数（绫音爱用品的急救状态），不能绑到整条技能上 ——
  // 绑上去会把她每 30 秒的暴击抵抗也限成一场一次。
  const once = /该技能仅可触发\s*(\d+)\s*次/.exec(desc)
    || (!/该效果仅可触发/.test(desc) && /仅可触发\s*(\d+)\s*次/.exec(desc))
  // 瞬：开局回费。这类技能在建局时就结算，不进 ③-a 技能阶段 ——
  // 拖到那里的话 Cost 会晚于玩家首轮的 EX 窗口，开局那 2 点等于没给。
  if (/战斗开始时/.test(desc)) return { type: "battle_start", maxUses: once ? Number(once[1]) : 1 }
  // **必须带「时」**：「自身生命值不高于30%<b>时</b>：」才是触发条件（全数据 10 处），
  // 而「对1名…生命值不高于50%的我方<b>单位</b>」是**选人条件**（2 处，池内是小春）——
  // 不加这个字，小春的单奶会变成「自己残血才放」，而且凭空多出一个「每场限 1 次」。
  const hp = /生命值不高于\s*([\d.]+)\s*%\s*时/.exec(desc)
  const sec = /每\s*([\d.]+)\s*秒/.exec(desc)
  const chance = /(\d+(?:\.\d+)?)\s*%\s*概率/.exec(desc)
  const icd = /冷却\s*([\d.]+)\s*秒/.exec(desc)
  // 鹤城 / 莲见：自己击杀掉才触发。别当成「每 5 回合必回血」。
  // 不认「击败 N 名 / 每击败」那种叠层计数（池外丽、纱织礼服）。
  if (/自身击败敌方单位时/.test(desc) && !/击败\s*\d+\s*名/.test(desc) && !/每击败/.test(desc)) {
    return {
      type: "on_kill",
      turns: icd ? secToTurns(Number(icd[1])) : 0,
      ...(once ? { maxUses: Number(once[1]) } : {}),
    }
  }
  // 泉奈：「自身每进行 6 次普通攻击」—— 数的是**普攻次数**，不是秒数。
  // 回合制里一回合最多一次普攻，但放 EX 的回合她不普攻，折成回合冷却会白送一次，
  // 所以走 on_auto 的计数分支（`every`），在 tryAutoProc 里一枪一枪数。
  const perAuto = /每进行\s*(\d+)\s*次普通攻击/.exec(desc)
  if (perAuto) {
    return {
      type: "on_auto", chance: 1, every: Number(perAuto[1]), turns: 0,
      ...(once ? { maxUses: Number(once[1]) } : {}),
    }
  }
  // 泉 / 明里：普通技能挂在普攻上，不是「每 X 秒必放」。冷却写在括号里，只有触发成功才进 CD。
  const onAuto = /自身普通攻击时/.test(desc)
  if (onAuto) {
    return {
      type: "on_auto",
      chance: chance ? Number(chance[1]) / 100 : 1,
      turns: icd ? secToTurns(Number(icd[1])) : 2,
      ...(once ? { maxUses: Number(once[1]) } : {}),
    }
  }
  // 「每 N 秒」是技能周期时，脚注里的「生命值不高于 N% 时」是状态触发，不是技能触发。
  // 绫音爱用品踩这条：支援自己没有会被打掉的血量，按 hp_below 会永远放不出来。
  if (hp && !sec) return { type: "hp_below", value: Number(hp[1]) / 100, maxUses: once ? Number(once[1]) : 1 }
  if (sec) return { type: "cooldown", turns: secToTurns(Number(sec[1])), ...(once ? { maxUses: Number(once[1]) } : {}) }
  // 没有「每 N 秒」时，「(冷却 N 秒)」是**再次使用的间隔**，不是周期（小春的「我来治疗！」）。
  // 不认的话会退成默认的 5 轮，比原作慢一倍半。
  // 标 `icd`：这类技能开局**不压满冷却**（跟 on_auto 同理）——它靠条件门控（要有人 ≤50%），
  // 不是「每 N 秒必放」，开局给满等于让第一次救援白白晚两轮。
  if (icd) {
    return { type: "cooldown", turns: secToTurns(Number(icd[1])), icd: true, ...(once ? { maxUses: Number(once[1]) } : {}) }
  }
  return { type: "cooldown", turns: 5, ...(once ? { maxUses: Number(once[1]) } : {}) }
}

/**
 * 时长也得按技能等级取 —— **`Effect.Duration` 存的是满级那一档**。
 *
 * 描述里写「持续<?2>」时，真正的时长在 `Parameters` 里是一张按级表
 * （优香的护盾 15/15/20/20/25 秒），而 `Effect.Duration` 固定 25000。
 * 本项目 `SKILL_LV = 0`，倍率和 Cost 都取第 1 档，时长没道理单独取满级。
 * 全 272 人里 13 个技能踩这条（果穗、爱丽丝（女仆）、一花、御坂美琴、千明、光、优香）。
 *
 * **只在「Duration 正好等于按级表最后一档」时才改写** —— 一个技能可能挂着几个不同时长的
 * 效果，不核对就会张冠李戴。
 * @returns {number|null} 毫秒；不该改写时返回 null
 */
function levelDuration(sk, e) {
  if (!e.Duration) return null
  const sec = (x) => {
    const m = /^\s*([\d.]+)\s*秒\s*$/.exec(String(x ?? ""))
    return m ? Number(m[1]) : null
  }
  for (const m of String(sk.Desc || "").matchAll(/持续\s*<\?(\d+)>/g)) {
    const tbl = sk.Parameters?.[Number(m[1]) - 1]
    if (!tbl?.length || sec(tbl[tbl.length - 1]) !== e.Duration / 1000) continue
    const own = sec(tbl[Math.min(SKILL_LV, tbl.length - 1)])
    if (own != null) return own * 1000
  }
  return null
}

/** 一个 Damage 效果 → 分段倍率数组。每段独立判定命中/暴击，所以不能合并成一个总倍率。 */
/**
 * `TargetHpRateModifier`：按目标当前血量百分比线性改伤害/治疗倍率。
 * 全数据 8 个技能有（池内只有明日奈的爱用品普技）。
 *   MinHpRate / MaxHpRate 是万分比；MultiplierMin 对应最低血、MultiplierMax 对应最高血。
 *   明日奈：0% → ×1.5，100% → ×1（越残越高）
 *   未花：  0% → ×1，  100% → ×2（越满越高）
 */
function hpRateOf(e) {
  const m = e?.TargetHpRateModifier
  if (!m) return null
  return {
    lo: (m.MinHpRate ?? 0) / 1e4,
    hi: (m.MaxHpRate ?? 10000) / 1e4,
    atLo: m.MultiplierMin,
    atHi: m.MultiplierMax,
  }
}

function hitsOf(dmg) {
  const total = dmg.Scale[SKILL_LV]
  const split = dmg.Hits || [10000]
  return split.map((h) => Number(((total * h) / 1e4 / 100).toFixed(4)))
}

/**
 * 「固定场地」类技能（全 272 人里 5 个：惠、千世、纱绫×2、切里诺（温泉））：
 * 在地上留一片区域，站在里面的人**持续挨打**，施放者死了场地也还在。
 *
 * `Hits` 只写一段，真正的跳数在 `HitFrames` 里（帧号，30fps）。**最后一帧就是场地存续时间**
 * ——千世的 `HitFrames` 收在 300 帧 = 10 秒 = 2 轮，跟技能描述的「持续10秒」对得上。
 *
 * 折成回合制不能一次性打完（那是 616% 的瞬间爆发，跟「持续」的语义完全相反），
 * 而是摊到存续的每一轮上：总伤害 ÷ 轮数。
 * @returns {object|null} 场地持续伤害效果，非场地技能返回 null
 */
function zoneDot(dmg) {
  const frames = dmg.HitFrames
  if (!(frames?.length > (dmg.Hits || [10000]).length)) return null
  const turns = msToTurns((Math.max(...frames) / 30) * 1000) ?? 2
  const totalPct = hitsOf(dmg).reduce((a, b) => a + b, 0) * frames.length
  return {
    type: "dot", scope: "enemy", icon: "Zone",
    scale: Number((totalPct / 100 / turns).toFixed(4)), turns, period: 1,
  }
}

/**
 * 「对 1 名敌方单位造成伤害，再对以其为中心的范围造成伤害」——主目标两段都吃，扩散只吃第二段。
 *
 * **只认这一种措辞**。全 272 人里有 45 个技能带多段 Damage，但多数第二段是条件加伤
 * （爱丽丝「能量充能时 ×1.5」、睦月「叠满 6 层时追加」）或随机三选一（小雪），
 * 那些取第一段才是对的，一律摊开会凭空翻倍。
 */
const SPLASH_DESC = (d) => /对1名敌方单位/.test(d) && /为中心的[^。]*范围/.test(d)

/**
 * 贯穿 / 弹跳的逐目标衰减。跟触发条件一样，**只存在于中文描述里**，没有结构化字段。
 * 全 272 人里 3 个：晴奈的贯穿（每个 −10%，最多 −30%）、泉（泳装）的弹跳、响。
 */
function parseFalloff(desc) {
  const d = String(desc || "")
  /**
   * **「同一个目标被打了几次」那种不是 falloff。**
   *
   * `falloff` 的语义是「第 i 个**目标** ×(1 − rate×i)」，而响的爱用品普技写的是
   * 「目标每受到 1 次该次技能的伤害，后续受到的伤害衰减 45%」—— 那是同一个目标身上的
   * **逐段**衰减，而且**原数据的 `Hits` 里已经摊好了**：`[10000, 5500, 1000, 1000, 1000]`
   * 正好是 100% / 55% / 10% / 10% / 10%。再套一层 falloff 就是双重衰减，维度还错了。
   *
   * 池内两个真 falloff 的措辞都指向**别的目标**：晴奈「每贯穿 1 名目标，后续对**其他目标**
   * 造成的伤害衰减」、泉（泳装）「椰子继续**弹跳至该目标**…但伤害衰减」。
   */
  if (/目标每受到\s*\d*\s*次/.test(d)) return null
  const step = /衰减\s*([\d.]+)\s*%/.exec(d)
  if (!step) return null
  /**
   * 「最多衰减 30%」是**衰减量**的上限；「最多衰减**至** 10%」是**剩余伤害**的下限，
   * 两者差一个字，含义正好相反 —— 后者要换算成 1 − 10% = 90% 的衰减上限。
   * 没有这一条时 `cap` 匹配不上（正则里没有那个「至」），会静默退成 `max: 1` = 衰减到 0。
   */
  const floor = /最多衰减至\s*([\d.]+)\s*%/.exec(d)
  if (floor) return { rate: Number(step[1]) / 100, max: 1 - Number(floor[1]) / 100 }
  const cap = /最多衰减\s*([\d.]+)\s*%/.exec(d)
  return { rate: Number(step[1]) / 100, max: cap ? Number(cap[1]) / 100 : 1 }
}

/**
 * 编队条件（池内是绿 ⇄ 桃 那一对）。两种写法：
 *   「编队内已编入桃井时：…」   条件成立才生效，目标不变（绿 EX 的中毒）
 *   「对绿(如在场)造成以下效果」 效果只给那一个队友（桃爱用品的增伤 + 加攻）
 *
 * 原数据的 `Target` 是笼统的 `Ally` / `AllyMain`，条件全在描述里。
 * **不能按顺序切块** —— 桃的爱用品描述是「增伤、攻击」，`Effects` 数组却是
 * 「命中、攻击、增伤」，顺序对不上。所以**按数值认**：条件那一段里出现的百分比，
 * 对上哪条效果就是哪条。描述里的数字是截断的（39.87% 印成 39.8%），留 0.1 容差。
 *
 * @returns {{name:string, named:boolean, nums:number[]}|null}
 */
function condClause(desc) {
  const m = /编队内已编入([^\s时]+)时|对([^\s（(]+)\(如在场\)/.exec(desc)
  if (!m) return null
  // 条件段从这里开始，到下一个「对…造成以下效果」或下一条「※」注释为止
  const from = desc.slice(m.index)
  const end = from.slice(1).search(/\n对[^\n]*造成以下效果|\n\s*※/)
  const body = end >= 0 ? from.slice(0, end + 1) : from
  return {
    name: ALLY_NAME_ALIAS[m[1] || m[2]] || (m[1] || m[2]),
    named: Boolean(m[2]),
    nums: [...body.matchAll(/([\d.]+)\s*%/g)].map((x) => Number(x[1])),
  }
}

/** 一条效果自己的百分比数值，用来跟条件段里的数字对号（Buff 看 Value，其余看 Scale） */
function pctOfEffect(e) {
  const raw = e.Type === "Buff" ? e.Value?.[0]?.[SKILL_LV] : e.Scale?.[SKILL_LV]
  return raw == null ? null : Math.abs(raw) / 100
}

/**
 * 己方选人，全部只写在描述里。不接的话 `resolveTarget` 会按有没有 Radius 乱猜：
 * 没半径的曾一律 `ally_all`（花江 / 千夏单奶变群奶），有半径的「对圆形范围内的 1 名」
 * （芹娜）也会被大圈收成全体。
 *
 * 人数和挑法以原文措辞为准，**别按 Radius 反推**：
 *   「对 1 名我方单位」                         玩家指定 / 对线，`ally_single`
 *   「对圆形范围内的 1 名我方单位」             还是单体 —— 圈是位移/瞄准，不是覆盖人数
 *   「对 N 名生命值百分比最低的我方单位」       `ally_lowest`，count = N（花子爱用品是 2）
 *   「对 1 名生命值不高于 N% 的我方单位」       `ally_hurt`（小春，原文没说最低）
 *   「对 1 名生命值上限最高的我方单位」         `ally_maxhp`（风香普技）
 *   「对圆形范围内的 4 名 / 对我方全体」        真·全体
 *   「对圆形范围内的我方单位」（没写人数）      交给几何，走 `resolveTarget`
 */
function allyPickOf(desc) {
  if (!desc) return null
  const except = /除自身外/.test(desc) ? { exceptSelf: true } : {}
  // 「对我方全体」是真·全体（绫音爱用品的前锋场地 = 4 个主力）。放在「对 N 名」前面。
  if (/对我方全体/.test(desc)) return { target: "ally_all", count: 4 }

  // 「的」可有可无：花江是「对 1 名我方单位」，绿才是「对 1 名…最低的我方单位」
  const one = /对(?:圆形范围内的|上述范围内的)?\s*(\d+)\s*名([^。\n]*?)的?我方单位/.exec(desc)
  if (!one) return null
  const n = Number(one[1])
  const mid = one[2] || ""

  const cap = /生命值不高于\s*([\d.]+)\s*%/.exec(mid)
  if (cap) return { target: "ally_hurt", count: 1, hpMax: Number(cap[1]) / 100, ...except }
  // **两种写法要分开**：绿写的是「生命值百分比**最低**」，按血量挑；
  // 小春写的是「生命值**不高于 50%**」，原文压根没说最低 —— 够格的人不止一个时
  // 按**站位**就近喂（同战场 → 最近），跟对线锁定同一套规则。
  if (/生命值百分比最低/.test(mid)) return { target: "ally_lowest", count: n, ...except }
  if (/生命值上限最高/.test(mid)) return { target: "ally_maxhp", count: n, ...except }

  // 「对 1 名我方单位」没有血量条件 = 玩家指定（EX）/ 对线（默认）
  // 「对圆形范围内的 1 名」也是单体 —— 芹娜那个 r=500 的圈是位移，不是奶 4 个人
  if (n <= 1) return { target: "ally_single", count: 1, ...except }
  if (n >= 4) return { target: "ally_all", count: 4 }
  return { target: "ally_adjacent", count: n, ...except }
}

/** summons.json 的 Name 是日文，中文名手工补 */
// 99999 的模板名是「遮蔽物」，但玩家在技能描述里读到的是「掩体」，按描述走。
// 静子 / 志美子 / 三森(泳装) / 伊吹(泳装) / 桐乃(泳装) 五个人共用它 —— 原作自己也没把
// 这几人的掩体分开（专属的是 99997 月咏(礼服) / 99998 星野(武装)，各挂在自己的 CH 代号下）
const SUMMON_CN = { 40002: "佩洛洛人偶", 99999: "掩体" }
/** 实际被用到的召唤物，最后一并输出成 SUMMONS 表 */
const usedSummons = new Map()

function summonTmpl(id) {
  const s = summonData.find((x) => x.Id === id)
  if (!s) return null
  return {
    id, name: SUMMON_CN[id] || s.Name,
    defType: ARMOR_CN[s.ArmorType] || "轻装",
    role: "召唤",
    hp: interp(s.MaxHP1, s.MaxHP100, LEVEL, 1),
    dfs: interp(s.DefensePower1, s.DefensePower100, LEVEL, 1),
    dodge: s.DodgePoint, crit: s.CriticalPoint,
    critRes: 100, critDmgRes: 5000, stability: s.StabilityPoint,
  }
}

/**
 * 召唤物效果。**只放行没有攻击力的挡刀型**——会打人的（雷ちゃん 那种炮台）
 * 要给召唤物单独的行动逻辑，现在没有，放行就是生成一个不会动的空壳。
 */
function buildSummon(e) {
  const s = summonData.find((x) => x.Id === e.SummonId)
  if (!s) return null
  /**
   * 闸门**不能只看 `AttackPower1`** —— 歌原的雷ちゃん自己的攻击力字段就是 0
   * （攻击力整个来自施法者的 `AttackPower_Base`），伤害写在它**自己的 `Skills`** 里。
   * 只看攻击力的话会放行一堵 2123 血、什么都不做的空壳。判据改成「有没有带伤害的技能」。
   */
  const armed = (s.Skills || []).some((k) => (k.Effects || []).some((x) => x.Type === "Damage"))
  if (armed || s.AttackPower1 > 0 || s.AttackPower100 > 0) return null
  // 入场技能里的 Provoke → 嘲讽。别走 CrowdControl 的通用分支，那条会变成眩晕
  const cc = (s.Skills || []).flatMap((k) => k.Effects || []).find((x) => x.Type === "CrowdControl")
  const taunt = cc && /Provoke/i.test(cc.Icon || "") ? msToTurns(cc.Scale?.[SKILL_LV]) ?? 1 : 0
  /**
   * **掩体和人偶是两种东西**，`summons.json` 的 `Type` 就分好了：
   *   `Summoned`（人偶）—— 抛出去的诱饵，扔进敌方半场，那一整个战场的刀都归它接
   *   `Obstacle`（掩体）—— 架在自己这边的**掩护**，只管自己那一路，而且只接
   *                       「打得中掩体」的那种攻击（见技能上的 `block`）
   * 两者的挡刀口径完全不同，别再合成一条。
   */
  const cover = s.Type === "Obstacle"
  // 血量 = 召唤物自身 + 施放者生命值 × Value（日富美是 160.06%，静子是 29.26%）
  const hpRate = e.Stat === "MaxHP_Base" && e.CasterStat === "MaxHP"
    ? Number(((e.Value?.[0]?.[SKILL_LV] ?? 0) / 1e4).toFixed(4)) : 0
  const baseHp = interp(s.MaxHP1, s.MaxHP100, LEVEL, 1)
  return {
    type: "summon", summonId: e.SummonId,
    hpRate,
    ...(cover ? { cover: true } : {}),
    /**
     * **两头都是 0 = 这个技能等级根本不部署它**。志美子的掩体 `Value` 是
     * `[0, 0, 2019, 2019, 3804]`，而模板 `MaxHP1` 也是 0 —— 原文里那句
     * 「掩体额外拥有志美子生命值 X% 的生命值」在 1/2 级压根不出现，不是我们漏接。
     * 立一堵 0 血的墙等于当场碎掉，跟星野 0 秒的眩晕同一条口径：标 inactive。
     */
    ...(baseHp <= 0 && hpRate <= 0 ? { inactive: true } : {}),
    /**
     * **没有 Duration 就是永久**（`null`），别退回默认 6 轮。
     * 人偶写的是 `Duration: 30000` = 6 轮；掩体那条 `Summon` 效果压根没有这个字段，
     * 原文也只写「重复使用该技能时，清除先前部署的掩体」—— 唯二的消失方式是被打掉、被自己顶掉。
     * `?? 6` 是当初给人偶写的兜底，套到掩体上会静默发明一个 6 轮的计时器。
     */
    turns: msToTurns(e.Duration),
    taunt,
  }
}

/**
 * N 次**独立**打击 → 打 N 个目标，不是一个目标吃 N 段。
 *
 * 判据是「N 个独立的爆炸源」这种措辞，**不能只看 `Hits` 求和 = N×10000**：
 * 日和（泳装）「发射5发子弹…※合计5发子弹的伤害」求和也是 50000，但明写了 5 发全打第 1 名。
 * 也刻意不匹配伊织「发射3发子弹，每发子弹各对其锁定的敌方单位…」—— 那是 3 发打同一批人。
 */
const INSTANCE_DESC = /对\s*(\d+)\s*个[^，。]*?范围|部署\s*(\d+)\s*个地雷|飞射\s*(\d+)\s*枚/

function instanceCount(sk, dmg) {
  if (!dmg?.Hits || dmg.Hits.length < 2) return 0
  const sum = dmg.Hits.reduce((a, b) => a + b, 0)
  const n = Math.round(sum / 1e4)
  if (n < 2 || Math.abs(sum - n * 1e4) > 50) return 0 // 不是整数倍 = 只是取整误差
  const m = INSTANCE_DESC.exec(String(sk.Desc || ""))
  if (!m) return 0
  const declared = Number(m[1] || m[2] || m[3])
  return declared === n ? n : 0
}

function buildSkill(sk, { isEx, student, codeOf, publicDesc }) {
  if (!sk) return null
  const desc = descOf(sk)
  const dmgs = (sk.Effects || []).filter((e) => e.Type === "Damage")
  const allTargets = (sk.Effects || []).flatMap((e) => (Array.isArray(e.Target) ? e.Target : e.Target ? [e.Target] : []))
  // 描述里的「对 N 名我方」优先于几何判定 ——
  // 没有 Radius 的己方技能不能一律判成 ally_all，有 Radius 的「1 名」也不能按圈收成全体
  const tg = allyPickOf(desc) || resolveTarget(sk, allTargets)
  const out = { name: sk.Name, ...tg, effects: [] }
  if (isEx) out.cost = sk.Cost[SKILL_LV]
  else out.trigger = parseTrigger(desc)

  // 「对最多 N 名敌方单位**按顺序**造成…共计 N 次」（绿）——从自己对位的号位起，
  // 按号位在存活敌人里**循环**打 N 次。不是弹射（不随机）、也不是连发（不重新对线）。
  // 4 人时有一个人吃两下，只剩 1 人时 5 发全落他身上。玩家指不了目标。
  const cyc = /对最多\s*(\d+)\s*名敌方单位按顺序/.exec(desc)

  // 「发射 N 发子弹，每发子弹各对其锁定的敌方单位」—— 每发单独锁目标、逐发换人。
  // 伊织原文就这么写；堇的扇形 3 段在回合制里按同一套拆成连发（用户口径）。
  const chain = /发射\s*(\d+)\s*发子弹[^。]*?每发子弹各对其锁定的/.exec(desc)
    || (isEx && student?.Id === 10012 && (dmgs[0]?.Hits?.length || 0) >= 2
      ? ["", String(hitsOf(dmgs[0]).length)] : null)
  const zone = dmgs.length ? zoneDot(dmgs[0]) : null
  const inst = chain || cyc || zone ? 0 : instanceCount(sk, dmgs[0])
  if (zone) {
    // 场地技没有直接伤害，全部化成持续伤害挂在目标身上
    out.effects.push(zone)
  } else if (cyc && dmgs.length) {
    out.hits = hitsOf(dmgs[0])
    out.target = "enemy_cycle"
    out.count = Number(cyc[1])
  } else if (chain && dmgs.length) {
    out.hits = hitsOf(dmgs[0])
    out.target = "enemy_chain"
    out.count = Number(chain[1])
  } else if (inst >= 4) {
    /**
     * **圈数比场上的人还多**：响的 EX 是 5 个圈，而战场上只有 4 个人。
     * 写死 5 会让第 5 发凭空浪费掉，所以圈数**在引擎里按存活敌人数现算**
     * （`enemy_instances`）—— 每圈的伤害不变，每圈仍按自己的半径铺
     * （响是半径 150 → 面积 70686 → 同战场同身位 2 人），圈心逐个落在不同的敌人身上。
     *
     * 全 272 人里只有响踩这条；睦月那两个 3 圈仍走下面的固定窗口（≤ 场上人数，没有浪费）。
     */
    out.hits = [hitsOf(dmgs[0])[0]]
    out.instances = inst
    out.target = "enemy_instances"
  } else if (inst) {
    // N 个爆炸源 → 打 N 个人，每人吃一份。不拆的话睦月的 EX 会变成 2 个人各吃 1229%
    out.hits = [hitsOf(dmgs[0])[0]]
    out.count = inst
    out.target = "enemy_adjacent"
  } else if (dmgs.length) {
    out.hits = hitsOf(dmgs[0])
    // 扩散段只在 enemy_adjacent 上成立 —— 那是唯一能保证 targets[0] 就是主目标的分支
    if (dmgs.length > 1 && out.target === "enemy_adjacent" && SPLASH_DESC(desc)) {
      out.splashHits = dmgs.slice(1).flatMap(hitsOf)
      out.hits = out.hits.concat(out.splashHits)
    }
    // 只在 AoE 上成立：弹射（enemy_random）逐段抽目标，没有「第几个」的概念
    const fo = parseFalloff(desc)
    if (fo && /adjacent|all/.test(out.target)) out.falloff = fo
    // 直线贯穿（晴奈、纯子）不问前中后，圈到谁打谁。横向圆/扇才锁同层。
    // 桃的 EX 原文是扇形，但那是个 850 长 / 45° 的窄锥，几何上就是一条线，
    // 按纯子那套走贯穿（用户口径，跟堇「原文是扇、口径按伊织」同类）。
    if (/对直线范围内/.test(desc) || student?.Id === 13011) out.depth = "through"
  }
  /**
   * **这一发挡不挡得住掩体**，原数据里是结构化字段（`Damage.Block`），不用按槽位猜。
   *
   * 规律是**物理的而不是槽位的**：直射单发 = 1（挡得住），范围 / 曲射 = 0（从掩体上面过去）。
   * 池内 56 人里普攻 35 个可挡、3 个不可挡（千世的圆形普攻、柚子、爱丽丝的光束），
   * EX 17 可挡 17 不可挡，普技 12 / 14 —— 跟「EX 一律穿墙」那种一刀切在 34 个技能上对不上。
   *
   * `Block` 还有 2 / 3 两档（全数据 15 处，全在池外：日向、时雨、未花、皋月、雪玲(泳装)…），
   * 遇到了再说，现在只认 1。
   */
  if (dmgs.length && dmgs[0].Block === 1) out.block = true

  // 「目标生命值百分比越低/越高，取值越高」——结构化字段，不是描述抠的。
  // 明日奈爱用品普技：满血 ×1、空血 ×1.5，Scale 是 100% 那一档。
  if (out.hits && dmgs[0]) {
    const hr = hpRateOf(dmgs[0])
    if (hr) out.hpRate = hr
  }

  // 附带在伤害上的效果（控制/减益/击退）原数据不写 Target，隐含跟随伤害目标
  const RIDES_DAMAGE = new Set(["CrowdControl", "DamageDebuff", "Knockback", "ConcentratedTarget"])
  // 编队条件（绿 ⇄ 桃）。哪几条效果落在条件段里，按数值认，见 condClause
  const cond = condClause(desc)
  const condCode = cond && codeOf ? codeOf(cond.name) : null
  for (const e of sk.Effects || []) {
    if (e.Type === "Damage") continue
    const dflt = RIDES_DAMAGE.has(e.Type) ? ["Enemy"] : ["Self"]
    const t = Array.isArray(e.Target) ? e.Target : e.Target ? [e.Target] : dflt
    let scope = t.every((x) => x === "Self") ? "self" : t.some((x) => /Ally/.test(x)) ? "ally_all" : "enemy"
    /**
     * `Any` = 「上述范围内」的单位，不分敌我（全 272 人 8 处）。
     * 非伤害效果落在**我方**那一半 —— 原文写得很清楚「对圆形范围内的**我方**单位…回复」。
     * 照原来「不含 Ally ⇒ 敌方」的判定，小春炸完还会给对面回血。
     *
     * 技能**同时带伤害**时（全 272 人只有小春的神圣手榴弹）标成 `circle_ally`，
     * 并在下面给技能补一个 `circle: true`：一个 r=200 的圈丢出去，
     * **圈里是敌人就只有伤害、是队友就只有治疗**。敌我两队隔着整个场地，
     * 一个圈装不下两边 —— 所以这两半永远只成立一个，见引擎的 `circle` 分支。
     */
    if (t.includes("Any")) scope = dmgs.length ? "circle_ally" : "ally_all"
    // 这条效果在不在编队条件那一段里
    const pct = pctOfEffect(e)
    const inCond = Boolean(cond && condCode && pct != null
      && cond.nums.some((n) => Math.abs(n - pct) < 0.1))
    const condFields = !inCond ? {}
      : cond.named ? { scope: "ally_named", ally: condCode } : { ifAlly: condCode }
    if (inCond && cond.named) scope = "ally_named"
    // 单体 / 点名奶里的 `Ally` 指的是**技能选中的那几个人**，不是全队。
    // 不收窄的话花江 / 千夏 / 芹娜的单奶会变成群奶，绿还会顺手奶到明确排除的自己。
    if (scope === "ally_all" && /^ally_(lowest|hurt|single|maxhp)$/.test(tg.target)) scope = "ally_target"
    const turns = msToTurns(levelDuration(sk, e) ?? e.Duration)
    /**
     * 「位移至指定位置」（`Reposition`，全 272 人 19 处，Self/Ally/Enemy 三种）。
     * 它是挂在 Buff 效果上的**附加字段**，不是独立效果，所以这里额外补一条，
     * 效果本体照常生成（泉奈的攻速、明日奈的闪避都还在）。
     *
     * **`Self` 折成「与相邻号位的队友交换站位」**（`range: 1`，池内只有泉奈）。
     * 回合制没有连续坐标，但**有站位** —— 战场分割（1·2 / 3·4）和对位锁定都由号位定，
     * 所以「换一格」是有意义的博弈：只有站在 2 / 3 号位时那一跳才跨得过战场分界线。
     * 换位而不是「挪过去」，四个格子仍然一格一人，战场图不会叠人。
     *
     * `Ally` / `Enemy`（把队友拉过来 / 把敌人扯过来）**仍然丢掉**：那是「谁被搬动」而不是
     * 「我站哪」，牵扯到多人重排，等真有角色进池再单独设计。
     */
    const before = out.effects.length
    if (e.Reposition) {
      const kinds = [].concat(e.Reposition)
      if (kinds.includes("Self")) out.effects.push({ type: "reposition", scope: "self", range: 1 })
      const rest = kinds.filter((k) => k !== "Self")
      if (rest.length) {
        out.effects.push({ type: "dropped", raw: `Reposition:${rest.join("/")}`, why: "搬动他人，待设计" })
      }
    }
    switch (e.Type) {
      case "Buff": {
        if (DROP_STAT.test(e.Stat || "")) { out.effects.push({ type: "dropped", raw: e.Stat, why: "回合制无对应物" }); break }
        // 射速的另一种写法，折成同一个 aa。详见 ignoreDelayToAa
        if (e.Stat === "IgnoreDelayCount_Base") {
          const v = ignoreDelayToAa(student, e.Value?.[0]?.[SKILL_LV])
          if (v == null) { out.effects.push({ type: "dropped", raw: e.Stat, why: "取不到射击帧数" }); break }
          out.effects.push({
            type: "buff", scope, stat: "aa", value: v, turns: turns ?? 2,
            ...(e.Channel != null ? { channel: e.Channel } : {}),
          })
          break
        }
        const stat = STAT_MAP[e.Stat]
        if (!stat) { out.effects.push({ type: "unmapped", raw: e.Stat }); break }
        const v = e.Value?.[0]?.[SKILL_LV] ?? 0
        out.effects.push({
          type: "buff", scope, stat,
          value: /_Base$/.test(e.Stat) && !BP_BASE_STAT.test(e.Stat) ? v : Number((v / 1e4).toFixed(4)),
          turns: turns ?? 2,
          // Channel 是原作的**槽位号**：同槽后来的顶掉先来的，不同槽才共存。
          // 一个 Channel 只装一种属性、且正负不混（全 272 人零例外），所以它本身就够唯一。
          ...(e.Channel != null ? { channel: e.Channel } : {}),
        })
        break
      }
      case "Heal": {
        /**
         * 「赋予特殊状态…生命值不高于 N% 时，消耗该状态并回复」（绫音爱用品）。
         * 不是当场群奶：技能每 30 秒照放（暴击抵抗那段会反复上），急救状态全场只赋予一次，
         * 每个人掉到阈值才消耗自己那层回血。
         */
        const em = /生命值不高于\s*([\d.]+)\s*%\s*时[^。\n]*消耗[^。\n]*回复/.exec(desc)
          || /拥有该特殊状态的我方单位生命值不高于\s*([\d.]+)\s*%\s*时/.exec(desc)
        if (em) {
          out.effects.push({
            type: "ward", scope,
            scale: Number((e.Scale[SKILL_LV] / 1e4).toFixed(4)), source: "heal",
            hpMax: Number(em[1]) / 100, once: true,
          })
          break
        }
        out.effects.push({ type: "heal", scope, scale: Number((e.Scale[SKILL_LV] / 1e4).toFixed(4)), source: "heal" })
        break
      }
      case "Regen": {
        const rg = {
          type: "regen", scope, scale: Number((e.Scale[SKILL_LV] / 1e4).toFixed(4)), source: "heal",
          turns: turns ?? 2, period: msToTurns(e.Period) ?? 1,
        }
        // 艾米的 EX 是全 272 人里唯一带 ExtraStatSource 的：
        // 每跳 = 治愈力 × Scale ＋ 已损生命值 × ExtraStatRate。漏掉后半截她的奶量少一半。
        if (e.ExtraStatSource === "TargetLostHP" && e.ExtraStatRate) {
          rg.lostHpRate = Number((e.ExtraStatRate[SKILL_LV] / 1e4).toFixed(4))
        }
        out.effects.push(rg)
        break
      }
      case "Shield":
        out.effects.push({ type: "shield", scope, scale: Number((e.Scale[SKILL_LV] / 1e4).toFixed(4)), source: "heal", turns: turns ?? 2 })
        break
      case "CrowdControl": {
        const sc = Array.isArray(e.Scale) ? e.Scale[SKILL_LV] : 0
        // **Provoke 必须从 CrowdControl 里分出来**：其余控制在引擎里都写 `t.stun`（整回合不能动），
        // 而嘲讽只是把敌人的刀拉过来。椿的 EX 不分流就变成「全场敌人晕 1 轮」，比原作强太多。
        // 原数据把它写成「对敌方施加 Provoke」，但引擎的嘲讽标记挂在**施法者**身上
        // （谁带标记谁挨打），所以 scope 固定 self —— 跟召唤物那条（buildSummon）同一套。
        if (/Provoke/i.test(e.Icon || "")) {
          out.effects.push({ type: "taunt", kind: "provoke", scope: "self", turns: sc ? msToTurns(sc) : 1 })
          break
        }
        out.effects.push({ type: "cc", scope, icon: e.Icon || "Stunned", chance: (e.Chance ?? 10000) / 1e4, turns: sc ? msToTurns(sc) : 0 })
        break
      }
      /**
       * 强化形态（`Key: "FormChange"`）：接下来一段时间的普攻换成另一套参数。
       * 池内两个，存续口径不同 ——
       *   鹤城「立即换弹…换弹1次后失效」：按**发数**，弹匣 = AmmoCount / AmmoCost（4/2 = 2 发）
       *   瞬「持续30秒」：按**轮数**，30 ÷ 5 = 6 轮，在 endTurn 里跳
       *
       * 强化后的普攻本身是结构化的（`Skills.Normal.FormChange`），倍率和分段都照抄那里，
       * 比拿描述里取整过的「倍率强化至138%」乘基础普攻准（鹤城实际是 138.71% 分 2 段，
       * 而基础普攻是 6 段）。没有这一段数据时才退回描述里的倍率。
       */
      case "Special": {
        /**
         * `Fury`（全 272 人只有妮露，Public 与 GearPublic 各一次）：一个纯粹的自身状态，
         * 本身不改任何面板，唯一作用是让她的 EX 倍率翻上去（见 buildSkill 末尾的 altHits）。
         * 她**没有** `Normal.FormChange`，所以不是形态转换，别往 charge 上套。
         * 时长跟同一技能里的闪避增益一样写在「持续20秒」里。
         */
        if (e.Key === "Fury") {
          const d = /持续\s*([\d.]+)\s*秒/.exec(desc)
          out.effects.push({ type: "state", key: "fury", scope: "self", turns: d ? secToTurns(Number(d[1])) : 4 })
          break
        }
        if (e.Key !== "FormChange") { out.effects.push({ type: "unmapped", raw: `Special:${e.Key}` }); break }
        const na = one(student?.Skills?.Normal)
        const fc = na?.FormChange
        const fcd = (fc?.Effects || []).find((x) => x.Type === "Damage")
        const nd = (na?.Effects || []).find((x) => x.Type === "Damage")
        const m = /倍率强化至\s*([\d.]+)\s*%/.exec(desc)
        const mult = m ? Number(m[1]) / 100 : 1
        const ch = {
          type: "charge",
          hits: fcd ? hitsOf(fcd)
            : nd ? hitsOf(nd).map((h) => Number((h * mult).toFixed(4)))
              : [100 * mult],
          // 扇形也在强化普攻自己身上（EX 的 Radius 描述的就是它），取不到才退回 EX 的范围
          count: (fc ? resolveTarget(fc, []).count : 0) || tg.count || 1,
        }
        const sec = /持续\s*([\d.]+)\s*秒/.exec(desc)
        if (sec && !/换弹[^)）]*后失效/.test(desc)) ch.turns = secToTurns(Number(sec[1]))
        else ch.shots = Math.max(1, Math.round((student?.AmmoCount || 2) / (student?.AmmoCost || 1)))
        // 瞬：「索敌机制改为优先攻击攻击力最高的敌方单位」。跟触发条件一样没有结构化字段，
        // 只能从描述里认。引擎侧 laneTarget 会因此绕开战场分割 / 坦克 / 挡刀，只有嘲讽拉得走。
        if (/索敌[^。]*攻击力最高/.test(desc)) ch.targeting = "max_atk"
        out.effects.push(ch)
        break
      }
      case "Summon": {
        const sm = buildSummon(e)
        if (sm) { out.effects.push(sm); usedSummons.set(sm.summonId, summonTmpl(e.SummonId)) }
        else out.effects.push({ type: "unmapped", raw: `Summon:${e.SummonId}` })
        break
      }
      case "Dispel": out.effects.push({ type: "cleanse", scope }); break
      /**
       * `CostChange` **不是往 Cost 池里加点**，全 272 人的 16 个无一例外都是「EX 费用打折」：
       *   `BaseAmount` + `Scale: -4` → 减 4 费（纯子 5 费变 1 费，描述里写「减少至1」）
       *   `Coefficient` + `Scale: -5000` → 减 50%（忧、圣娅、柚子（武装）…）
       *   `Uses` = 还能打几次折（纯子 2 次）
       * 往 Cost 池加点的技能反而**没有**结构化效果，只写在描述里（见 buildSkill 末尾的兜底）。
       * 曾经这里映射成 `{type:"cost", value: Scale/1e4}`，纯子会变成「Cost −0.0004」。
       */
      case "CostChange": {
        const sc = e.Scale?.[SKILL_LV] ?? 0
        const pct = e.ValueType === "Coefficient"
        out.effects.push({
          type: "ex_discount", scope,
          mode: pct ? "pct" : "flat",
          value: pct ? Number((-sc / 1e4).toFixed(4)) : -sc,
          uses: e.Uses ?? 1,
        })
        break
      }
      // 集火：把某个敌人点成「我方都打它」。跟 Provoke 是**两个不同的机制**，
      // 靠 kind 区分 —— 图标和底色都不一样（集火是蓝底减益，嘲讽是紫底），
      // 而且集火的标记落在被点的那个人身上，嘲讽的落在被拉走的人身上。池内是切里诺。
      // 集火的时长跟 CrowdControl 一样写在 `Scale`（毫秒）里，不是 `Duration` ——
      // 读 Duration 会拿到 undefined，切里诺 15 秒的集火就缩成 1 回合
      case "ConcentratedTarget":
        out.effects.push({
          type: "taunt", kind: "focus", scope,
          turns: msToTurns(Array.isArray(e.Scale) ? e.Scale[SKILL_LV] : 0) ?? turns ?? 1,
        })
        break
      // `DamageDebuff` **全都是持续伤害**（灼烧/中毒/冰冻/感电），不是「造成伤害降低」——
      // 全 272 人的 33 个无一例外都带 Icon 和 Period。当成 dmg_deal 减益的话，
      // 千世那条 54% 会变成 −54% 输出，方向都反了。
      case "DamageDebuff":
        out.effects.push({
          type: "dot", scope, icon: e.Icon || "Burn",
          scale: Number(((e.Scale?.[SKILL_LV] ?? 0) / 1e4).toFixed(4)),
          turns: turns ?? 4, period: msToTurns(e.Period) ?? 1,
        })
        break
      case "Knockback": out.effects.push({ type: "dropped", raw: "Knockback", why: "回合制无位置" }); break
      default: out.effects.push({ type: "unmapped", raw: e.Type })
    }
    // 编队条件盖在这一轮刚 push 进去的效果上（一个 Effect 可能 push 出不止一条）
    if (inCond) for (let i = before; i < out.effects.length; i++) Object.assign(out.effects[i], condFields)
  }
  /**
   * 「一个圈，砸哪边只有那边生效」——`Target: "Any"` 的效果跟伤害同时存在时才成立。
   * 指令层靠中间那个动词选边（`小春ex打白子` / `小春ex奶桃`），两半互斥。
   */
  if (out.effects.some((e) => e.scope === "circle_ally")) out.circle = true

  // 「获得 N 技能COST」（往 Cost 池加点，跟上面的 CostChange 打折是两回事）**没有结构化效果**
  // —— 瞬的普通技能 `Effects` 是个空数组（全 272 人里这样的技能有 9 个），数值只在描述里。
  if (!out.effects.some((e) => e.type === "cost")) {
    const gain = /获得\s*([\d.]+)\s*技能COST/.exec(desc)
    if (gain) out.effects.push({ type: "cost", scope: "self", value: Number(gain[1]) })
  }

  // 「不死」同样只在描述里（全 272 人 3 处：真里奈、纯子的 Public 与 GearPublic）。
  // 持续时间在两种位置都出现过 —— 纯子的 Public 写在「对自身造成以下效果(持续12.8秒)」、
  // GearPublic 写在「获得<s:Immortal>(持续12.8秒)」—— 所以整段找「持续 N 秒」。
  if (/<s:Immortal>/.test(desc)) {
    const d = /持续\s*([\d.]+)\s*秒/.exec(desc)
    out.effects.push({ type: "immortal", scope: "self", turns: d ? secToTurns(Number(d[1])) : 2 })
  }

  /**
   * 能量充能（爱丽丝，全 272 人只有她）：三档 `EnergyBatteryEmpty/Half/Full`，
   * **一个结构化字段都没有**，全在描述里。
   *   普通技能：「能量充能状态提升至…」→ 每次施放 +1 档（封顶 2）
   *   爱用品版另加「战术入场时：提升至 Half」→ 开局就带 1 档，写成技能上的 `stateStart`
   *   EX：按档位取倍率（见下面的 altHits），放完「重置为 Empty」
   */
  if (/能量充能状态提升至/.test(desc)) {
    out.effects.push({ type: "state", key: "energy", scope: "self", step: 1, max: 2 })
    if (/战术入场时/.test(desc)) out.stateStart = { key: "energy", value: 1 }
  }
  if (/重置自身能量充能状态/.test(desc)) out.effects.push({ type: "state", key: "energy", scope: "self", value: 0 })

  /**
   * 条件追伤：同一发技能的第 2 / 第 3 段 `Damage` 不是「多段」，而是「某个状态下换一套倍率」。
   * 三个人同一个形状，收成 `altHits`：引擎结算前查状态，命中哪一档就用哪一组倍率。
   *
   *   妮露   有 `Fury` 时 ×1.5（爱用品版描述改口为 ×2，倍率不在数据里，只能从描述抠）
   *   爱丽丝 半充 ×1.5 / 满充 ×2
   *
   * 不接的话三个人都是「能跑但残了」：妮露和爱丽丝会永远停在最低档。
   */
  if (dmgs.length > 1 && out.hits?.length && !out.splashHits) {
    const base = out.hits.reduce((a, b) => a + b, 0)
    const alts = []
    if (/<s:Fury>/.test(desc)) {
      // 爱用品把「提升至1.5倍」改口成「变为2倍」，而 ×2 这一档**原数据里没有**，
      // 只写在普通技能的描述里 —— 只有这种情况才靠乘，其余一律抄原数据那一段
      const up = publicDesc && /EX技能效果提升变为\s*([\d.]+)\s*倍/.exec(publicDesc)
      alts.push(up ? { state: "fury", min: 1, mult: Number(up[1]) } : { state: "fury", min: 1, src: dmgs[1] })
    }
    for (const [i, key] of [[1, "EnergyBatteryHalf"], [2, "EnergyBatteryFull"]]) {
      if (!new RegExp(`为<s:${key}>时`).test(desc) || !dmgs[i]) continue
      alts.push({ state: "energy", min: i, src: dmgs[i] })
    }
    // 高档排前面：引擎取第一个满足的
    // 倍率有原数据那一段就直接抄它的分段（精确），只有描述覆写（妮露爱用品 ×2）才乘出来
    if (alts.length) out.altHits = alts.sort((a, b) => b.min - a.min).map((a) => {
      const hits = a.src ? hitsOf(a.src) : out.hits.map((h) => Number((h * a.mult).toFixed(4)))
      return {
        state: a.state, min: a.min, hits,
        total: Number(hits.reduce((x, y) => x + y, 0).toFixed(2)),
      }
    })
  }

  /**
   * **概率追伤**（真白，全 272 人只有她）。跟 `altHits` 形状相似但不是一回事：
   * `altHits` 是「某个状态下换一整套倍率」，这里是「掷一次骰子，中了再多打一发」，
   * 所以它是**独立的一发**（单独 roll 命中和暴击），不是把第一段换掉。
   *
   * 第二段 `Damage` 就是那一发的倍率（623.28%，原数据里有，不用乘）。
   * 概率写在描述的 `<?2>` 里，技能 1 级是 50%。
   * 不接的话她的 EX 只剩 415%，整套 kit 的核心没了。
   */
  const bonus = /([\d.]+)\s*%\s*概率造成自身攻击力\s*[\d.]+\s*%\s*的追加伤害/.exec(desc)
  if (bonus && dmgs.length > 1 && !out.altHits && !out.splashHits) {
    out.bonus = { chance: Number(bonus[1]) / 100, hits: hitsOf(dmgs[1]) }
    // 第二段是「可能有」的追加，不能留在主 hits 里当必中的一段
    if (out.hits?.length > 1) out.hits = out.hits.slice(0, hitsOf(dmgs[0]).length)
  }
  /**
   * 「下 1 次 EX 技能造成追加伤害的概率加算 12.5%．※ 最多叠加 2 次」（真白的爱用品普技）。
   * 又是一条只写在描述里、`Effects` 里没有的规则 —— 那个数组里只有伤害和自身加攻两条。
   * 攒到下一发 EX 用掉就清空（原文写的是「下 1 次」，不是永久）。
   */
  const upC = /下\s*1\s*次EX技能造成追加伤害的概率加算\s*([\d.]+)\s*%/.exec(desc)
  if (upC) {
    const cap = /最多叠加\s*(\d+)\s*次/.exec(desc)
    const step = Number(upC[1]) / 100
    out.effects.push({
      type: "state", key: "bonusChance", scope: "self",
      step, max: Number((step * (cap ? Number(cap[1]) : 1)).toFixed(4)),
    })
  }

  // 「对 1 名攻击力最高的敌方单位」/「以 1 名攻击力最高的敌方单位为中心」——
  // 跟瞬的索敌改写一样，**只写在描述里**，没有结构化字段。引擎侧走 laneTarget 的 max_atk 分支：
  // 嘲讽仍然拉得走，其余（战场分割 / 前中后排 / 挡刀）一概绕开。
  // 池内是柚子的普通技能（带伤害，嘲讽拉得走）和切里诺的集火（选人条件，嘲讽改不了落点）。
  // 玩家指定目标时以玩家为准，所以只在没指定时生效。
  if (/攻击力最高的敌方单位/.test(desc) && String(out.target || "").startsWith("enemy")) out.pick = "max_atk"

  // 纯子 EX 的「失去25.7%的当前生命值」。跟艾米的 ExtraStatSource 一样是**全数据唯一一处**，
  // 没有结构化效果，也不会有第二个用例 —— 但漏了她就成了一个没有代价的 746% 直线 AoE。
  const hpCost = /失去\s*([\d.]+)\s*%\s*的当前生命值/.exec(desc)
  if (hpCost) out.effects.push({ type: "hp_cost", scope: "self", rate: Number(hpCost[1]) / 100 })

  /**
   * **「对上述范围内的我方单位」不是「对我方全体」**。
   *
   * 原数据的 `Target` 只写 `Ally` / `AllyMain`，圈多大只写在 `Radius` 里 —— 于是圈型的
   * 增益/治疗会被判成 `ally_all`，静子半径 200 的圈（同战场同身位 2 人）会给全队 4 个人加命中，
   * 绫音、花子、志美子、小玉、和香 全是同一个错法。
   *
   * 技能自己的 `target` 已经把覆盖面算好了（`ally_all` = 真·全体，`ally_adjacent` = 圈，
   * `ally_lowest` / `ally_hurt` / `ally_single` / `ally_maxhp` = 点名），所以**只要技能
   * 不是真·全体，`ally_all` 就收成 `ally_target`**（这一发实际圈到的人）。
   *
   * 反过来不能一律用 `ally_target`：绿 / 桃那种「打敌人的同时给全队加攻」的技能，
   * 目标是敌方，`dmgTargets` 里装的是敌人 —— 那种就得保留 `ally_all`。判据是技能的 target。
   */
  if (String(out.target || "").startsWith("ally") && out.target !== "ally_all") {
    for (const e of out.effects) if (e.scope === "ally_all") e.scope = "ally_target"
  }

  // 不打人、效果又全落在自己身上 = 目标就是自己。`Effects` 为空时 resolveTarget 无从判断
  // （瞬的开局回费），会退成 enemy_single —— 那会让指令层按敌方去解析「打谁」。
  const real = out.effects.filter((e) => e.type !== "dropped" && e.type !== "unmapped")
  if (!out.hits?.length && real.length && real.every((e) => e.scope === "self")) {
    out.target = "self"
    out.count = 1
  }

  const charge = out.effects.find((e) => e.type === "charge")
  // 「立即换弹」：EX 只上形态 / 增益，普攻留到 ③-b 跟别人一起打。
  // 鹤城、芹香都是这种。别把普攻塞进 EX 结算 —— 那会让转换技看起来像伤害技。
  // 换弹强化的第 1 发因此落在施放回合的普攻阶段，第 2 发落在下个己方回合。
  if (/立即换弹|马上换弹/.test(desc)) out.thenAutoAttack = true
  // 「换弹后失效」的增益没有 Duration 字段，让它跟强化射击同寿。
  // 进攻向 Buff 施放回合就算第 1 回合（那一回合他就要出手），而第 1 发也在施放回合，所以正好 = shots。
  // 按轮数存续的强化形态（瞬）不走这条：它的 Buff 自带 Duration，本来就跟强化同寿。
  if (charge?.shots) for (const e of out.effects) if (e.type === "buff") e.turns = charge.shots
  return out
}

/**
 * buildSkill 处理不了的效果类型：碰上就退回未强化版，别生成半个空技能。
 * `Special` 里只有 `FormChange` 一种做了（鹤城的换弹强化），其余 Key 仍然不认。
 */
const UNBUILDABLE = /^(Summon|Accumulation)$/
const SPECIAL_OK = new Set(["FormChange", "Fury"])
const unbuildable = (e) => UNBUILDABLE.test(e.Type) || (e.Type === "Special" && !SPECIAL_OK.has(e.Key))

/**
 * 普通技能取哪一条。`GearPublic` 与 `Public` 同结构，buildSkill 不用改。
 * 强化版含 Special / Summon（妮露、莲华、歌原）时退回 Public —— 那几类要手写逻辑。
 */
function pickPublicSkill(c) {
  const base = one(c.Skills.Public)
  if (!USE_GEAR_SKILL) return { sk: base, gear: false }
  const g = one(c.Skills.GearPublic)
  if (!g || (g.Effects || []).some(unbuildable)) return { sk: base, gear: false }
  return { sk: g, gear: true }
}

/** 角色名 → 内部代号。编队条件（绿 ⇄ 桃）要用它把描述里的名字换算成 id */
const codeOf = (name) => {
  const hit = IDS.find(([sid]) => arr.find((x) => x.Id === sid)?.Name === name)
  return hit ? hit[1] : null
}

const units = IDS.map(([sid, code]) => {
  const c = arr.find((x) => x.Id === sid)
  const m = starMul(FORCE_STAR)
  const na = Array.isArray(c.Skills.Normal) ? c.Skills.Normal[0] : c.Skills.Normal
  const nd = (na?.Effects || []).find((e) => e.Type === "Damage")
  const pub = pickPublicSkill(c)
  /**
   * 主力 / 支援。支援位**不站在场上**：不占号位、打不到、也不进 `settle` 的血量比，
   * 只在 ③-a 跟着主力一起放普通技能，外加自己的 EX。
   * 数值照主力同一套口径生成（Lv1 取 Stat1 / 统一 3★ / 官方 TRANS 表）—— 它们的血量和
   * 攻击力照样有用，因为发出去的召唤物和增益是按施法者自己的面板算的
   * （静子的掩体血量 = 她自己 HP 的 29.26%）。
   */
  const support = c.SquadType === "Support"
  return {
    id: code, sid, name: c.Name, star: FORCE_STAR, baseStar: c.StarGrade,
    squad: support ? "支援" : "主力",
    atkType: BULLET_CN[c.BulletType], defType: ARMOR_CN[c.ArmorType],
    role: ROLE_CN[c.TacticRole], line: LINE_CN[c.Position],
    bullet: c.BulletType, armor: c.ArmorType,
    hp: interp(c.MaxHP1, c.MaxHP100, LEVEL, m.hp),
    atk: interp(c.AttackPower1, c.AttackPower100, LEVEL, m.atk),
    dfs: interp(c.DefensePower1, c.DefensePower100, LEVEL, 1),
    healPower: interp(c.HealPower1, c.HealPower100, LEVEL, m.heal),
    acc: c.AccuracyPoint, dodge: c.DodgePoint, crit: c.CriticalPoint,
    critDmg: c.CriticalDamageRate, critRes: 100, critDmgRes: 5000, stability: c.StabilityPoint,
    // 普攻也可能是范围的（全 272 人里 11 个带 Radius，池内只有千世）——
    // 只取 hits 不看 Radius 的话，她的圆形普攻会被当成单体
    // 支援位**没有 `Skills.Normal`**（19 个无一例外），所以它们根本没有普攻这回事。
    // 以前那个 `: [1]` 的兜底会给它们造一个 1% 倍率的假普攻 —— 那本身就是「它们不该走
    // 普攻循环」的信号。这里直接给 null，引擎的 ③-b 也不遍历支援。
    autoAttack: support ? null : {
      hits: nd ? nd.Hits.map((h) => Number(((nd.Scale[0] * h) / 1e4 / 100).toFixed(4))) : [1],
      // 普攻同样按原数据认挡不挡得住：池内 35 个可挡，千世 / 柚子 / 爱丽丝那三个不可挡
      ...(nd?.Block === 1 ? { block: true } : {}),
      ...(na?.Radius ? (({ target, count }) => ({ target, count }))(resolveTarget(na, [])) : {}),
    },
    gearSkill: pub.gear,
    skill: buildSkill(pub.sk, { isEx: false, student: c, codeOf }),
    // EX 的条件倍率有时写在**普通技能**的描述里（妮露爱用品的「变为2倍」），所以要把它传进去
    ex: buildSkill(one(c.Skills.Ex), { isEx: true, student: c, codeOf, publicDesc: descOf(pub.sk) }),
  }
})

// ---- 报告未映射/丢弃的效果，然后把占位项剔出最终数据 ----
const warn = []
for (const u of units)
  for (const sk of [u.skill, u.ex]) {
    if (!sk) continue
    for (const e of sk.effects)
      if (e.type === "unmapped") warn.push(`${u.name} / ${sk.name}: 未映射 ${e.raw}`)
      else if (e.type === "dropped") warn.push(`${u.name} / ${sk.name}: 丢弃 ${e.raw}（${e.why}）`)
    sk.effects = sk.effects.filter((e) => e.type !== "dropped" && e.type !== "unmapped")
    // 技能等级 1 时数值为 0 的效果保留结构但标记，方便日后升级技能等级。
    // 控制是时长为 0（星野的战术镇压），Buff 是数值为 0（泉的攻速增益）。
    for (const e of sk.effects) {
      if (e.type === "cc" && !e.turns) e.inactive = true
      if (e.type === "buff" && !e.value) e.inactive = true
    }
    // 既不打人也不上效果 = 生成出了一个什么都不做的技能。多半是原数据的 `Effects` 是空数组
    // （全 272 人里 9 个），数值只写在描述里，得单独抠 —— 不告警的话它会静默上线。
    if (!sk.hits?.length && !sk.effects.length) warn.push(`${u.name} / ${sk.name}: 空技能（既无伤害也无效果）`)
  }

const js = `/**
 * 碧蓝档案 · 回合制群战 —— 角色表（自 SchaleDB 官方数据生成）
 *
 * 本文件由 scripts/emit-roster.mjs 生成，不要手改。
 * 折算口径：等级 ${LEVEL} / 无装备 / 统一 ${FORCE_STAR}★ / 技能 ${SKILL_LV + 1} 级 / 1 轮 = ${ROUND_SEC} 秒
 * ${USE_GEAR_SKILL ? "有爱用品的角色用强化版普通技能（GearPublic）；爱用品的属性加成不取，那是按满级标定的定值" : "不取爱用品"}
 * 战斗公式与克制表均取自官方实现，见 CFG 注释。
 */

/** 官方克制表（万分比）：SchaleDB config.TypeEffectiveness */
export const TYPE_EFFECTIVENESS = ${JSON.stringify(cfg.TypeEffectiveness, null, 2)}

// 短名与全称都认，避免调用方写全称时静默退化成 1.0
const ARMOR_KEY = {
  轻装: "LightArmor", 重装: "HeavyArmor", 特殊: "Unarmed", 弹力: "ElasticArmor", 复合: "CompositeArmor",
  轻装甲: "LightArmor", 重装甲: "HeavyArmor", 特殊装甲: "Unarmed", 弹力装甲: "ElasticArmor", 复合装甲: "CompositeArmor",
  // 召唤物专用的第六种：掩体。官方克制表里对**所有**攻击属性都是 ×0.5，拆墙没法 counter-pick
  构造物: "Structure", 构造: "Structure",
}
const BULLET_KEY = { 爆发: "Explosion", 贯通: "Pierce", 神秘: "Mystic", 振动: "Sonic", 变化: "Chemical" }

/** 属性克制系数：克制 2.0 / 普通 1.0 / 被抵抗 0.5（振动打特殊为 1.5） */
export function affinity(atkType, defType) {
  const row = TYPE_EFFECTIVENESS[BULLET_KEY[atkType]]
  const key = ARMOR_KEY[defType]
  if (!row || !key) throw new Error(\`未知属性组合: \${atkType} / \${defType}\`)
  return (row[key] ?? 10000) / 10000
}

export const CFG = {
  // ---- 官方战斗公式常数（取自 SchaleDB common.js 实现）----
  DEF_C: 6000, DEF_BASE: 10000000,   // 防御系数 = DEF_BASE / (防御 × DEF_C + DEF_BASE)
  HIT_C: 3, HIT_BASE: 2000,          // 命中率  = HIT_BASE / (max(闪避−命中,0) × HIT_C + HIT_BASE)
  CRIT_C: 6000, CRIT_BASE: 4000000,  // 暴击率  = 1 − CRIT_BASE / (max(暴击−暴抵,0) × CRIT_C + CRIT_BASE)
  STAB_BASE: 1000,                   // 伤害下限 = 稳定值/(稳定值+STAB_BASE) + 稳定率/10000
  DEFAULT_STAB_RATE: 2000,
  ROUND_SECONDS: ${ROUND_SEC},       // 1 轮（双方各行动一次）= 5 秒，技能时长与冷却都按这把尺子折算

  // ---- 对战框架（非 BA 原生，为回合制 PvP 而设）----
  // Cost 在每个回合「结束时」回复，因此首轮双方都是开局值直接开打：
  // 先手首轮 0，后手首轮 2，之后后手恒定领先 2 点。
  COST_START: 0,
  COST_REGEN_PER_UNIT: 0.5,          // 每人 0.5，**支援也算**：满编 4 主力 + 2 支援 = 3/回合
  COST_MAX: 10,                      // 与 BA 的 Cost 上限一致
  EX_COOLDOWN_SLACK: 3,              // EX 冷却长度 = 存活总人数（含支援）− 这个值，满编 6 人 = 3
  /**
   * 掩体的**格挡率**。原作公式是 \`30 + 攻击方遮蔽成功值 − 防御方遮蔽贯通率\`，
   * 地形适应每升一级 +15，基础就是 30%。它是**独立的一次判定**，不走命中/闪避那条公式 ——
   * 折成闪避值的话效果会随攻击者的命中浮动，而原作明确不是这样。
   * 遮蔽成功值（\`BlockRate_Base\`）全 272 人只有优香的武器被动带，生成器不读那个槽，暂时接不到。
   */
  COVER_BLOCK_RATE: 0.3,
  SECOND_BONUS: 2,                   // 后手方开局补偿；2000 局压测先手胜率约 51.4%
  /**
   * 支援把自己的基础面板按比例转给每个主力（官方编成加成，不是 buff）。
   * PvP 4+2：生命/攻击 10%，防御/治疗力 5%。两个支援叠加。
   * 只看支援自己的模板面板（技能 / 被动 / 爱用品属性都不算）；支援和召唤物自己拿不到。
   * 怒炎歼灭战那种 4 支援全 5% 不在本项目。
   */
  SUPPORT_GIFT_HP: 0.1,
  SUPPORT_GIFT_ATK: 0.1,
  SUPPORT_GIFT_DFS: 0.05,
  SUPPORT_GIFT_HEAL: 0.05,

  // ---- 白热化 / FEVER TIME（照搬原作，按 1 轮 = ${ROUND_SEC} 秒折算）----
  // 原作 PvP：总时长 ${BATTLE_SEC} 秒，剩余不足 ${FEVER_LEFT_SEC} 秒进入白热化，
  // 时间耗尽则比双方「当前血量 / 最大血量」的比值定胜负。
  FEVER_ROUND: ${(BATTLE_SEC - FEVER_LEFT_SEC) / ROUND_SEC},  // 第几轮进入白热化 = ${BATTLE_SEC - FEVER_LEFT_SEC} 秒
  FEVER_COST_MULT: 2,                // 白热化：存活的场上主力 Cost 回复 ×2（支援仍各回 0.5）
  FEVER_DEBUFF: 0.5,                 // 赛季附加规则：防御 / 闪避 / 受治疗下降，设 0 可关掉
  MAX_ROUND: ${BATTLE_SEC / ROUND_SEC},                   // 时间耗尽 = ${BATTLE_SEC} 秒 = ${BATTLE_SEC / ROUND_SEC} 轮
}

/**
 * 召唤物模板。它们**不进 ROSTER**，也不占号位——只作为 side.summons 里的挡刀物存在，
 * 所以 aliveOf / sideDead / settle / EX 冷却全都天然不把它们算进去。
 */
export const SUMMONS = ${JSON.stringify(Object.fromEntries(usedSummons), null, 2)}

export const ROSTER = ${JSON.stringify(units, null, 2)}

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
`

fs.writeFileSync(OUT, js)
console.log("生成完毕 → lib/ba/roster.js")
console.log("角色:", units.map((u) => `${u.name}(${u.id})`).join(" "))
const gearUnits = units.filter((u) => u.gearSkill)
console.log(`爱用品强化普通技能：${gearUnits.length}/${units.length} 人` +
  (gearUnits.length ? ` —— ${gearUnits.map((u) => `${u.name}「${u.skill.name}」`).join("　")}` : ""))
console.log("\n=== 转换告警 ===")
console.log(warn.length ? warn.join("\n") : "无")
console.log("\n=== 技能结构预览 ===")
for (const u of units) {
  console.log(`\n${u.name} ${u.atkType}/${u.defType} ${u.line}排/${u.role}`)
  console.log("  EX  ", JSON.stringify(u.ex))
  console.log("  普技", JSON.stringify(u.skill))
  console.log("  普攻", JSON.stringify(u.autoAttack))
}
