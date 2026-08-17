/**
 * 碧蓝档案 · 回合制群战
 *
 * 4v4 战场分割对线 / 暗配队 / 交替回合 / Cost 驱动 EX。
 * 数值与技能全部照搬原作（SchaleDB 生成），战斗内核在 lib/ba/engine.js，
 * 折算口径与各项约定见 .claude/skills/ba-battle/SKILL.md。
 *
 * 测试期约定：不做超时判负，一局靠 Redis TTL（3 小时）兜底；
 * 卡住了用 #结束对战 手动清。先把游戏性跑出来再补运营向的东西。
 */

import { Command, OnEvent, plugin } from "../../../src/core/plugin.js"
import { Segment } from "../../../src/api/client.js"
import { getRedis } from "../../../src/utils/redis.js"
import { logger } from "../../../src/utils/logger.js"

import { CFG, BY_ID, ROSTER, findUnit } from "../lib/ba/roster.js"
import { createBattle, playerTurn, validateAction, exCastableOf, exSealedOf, exLockedOf } from "../lib/ba/engine.js"
import { BattleStore } from "../lib/ba/store.js"
import { parseDraft, parseAction } from "../lib/ba/parse.js"
import { baBattleImageGenerator } from "../lib/ba/BaBattleImageGenerator.js"
import {
  renderRosterByType, renderOne, mergeTurnLog, SIDE_MARK,
} from "../lib/ba/format.js"

/**
 * 连续自动过的上限。正常打不到 —— 贪心打法 300 局的极值是 9 连
 * （开局 Cost 为 0，97% 的局先手第一回合就没得放）。
 * 纯粹是防某天改坏了 `exCastableOf` 之后一口气把整局刷完，撞上限就交还给玩家发「过」。
 */
const AUTO_PASS_MAX = 12

/** 把文本、图片段或段数组包成合并转发节点。群聊和私聊都能用。 */
function toNodes(items, botId, botName) {
  return items
    .filter((item) => item != null && (!Array.isArray(item) || item.length))
    .map((item) => ({
      type: "node",
      data: {
        user_id: botId,
        nickname: botName || "档案对战",
        content: Array.isArray(item)
          ? item
          : item && typeof item === "object" && item.type
            ? [item]
            : [Segment.text(String(item))],
      },
    }))
}

function renderGuideFallback() {
  return [
    "【碧蓝档案 · 回合制群战】4v4",
    "角色数值、技能与战斗公式全部照搬原作（等级1 / 无装备 / 统一3★ / 技能1级）。",
    "",
    "一方完成一次行动叫 1 回合；先手、后手各完成 1 回合叫 1 轮。每个回合结算后发：战报转发 → 战场图 → @下一位。",
    "指令都可以不加 #。",
    "档案对战 @某人　发起（不 @ 则公开邀战）",
    "应战　　　　　　接受",
    "应战后角色图鉴以合并转发私聊发给双方；直接在私聊回 6 个角色名完成暗配队（前 4 主力 + 后 2 支援），例如：星野 白子 野宫 芹香 静子 芹娜",
    "配队顺序就是左起站位，决定普攻对位。",
    "",
    "出招：星野ex　/　星野ex打白子　/　星野ex给芹香　/　小春ex奶桃　/　泉奈ex换野宫（位移）　/　过",
    "一律写角色名，不用编号；同队不许重名，所以名字就能唯一定位。",
    "中间的字决定目标在哪一边，认的是意思不是某个字：打攻揍轰砸捶秒锤 都是敌方，给帮为治奶助换跳 都是己方；不写就按技能自己的目标类型判定。",
    "小春 EX 是丢一个圈：砸对面就只有伤害（小春ex打白子），砸自己人就只有治疗（小春ex奶桃 / 小春ex给桃 / 小春ex治桃 都行），二选一，都是同战场同身位 2 人。",
    "一次只放一个 EX。放完会先出图，还能再放就继续写；发「过」才结算普通技能和普攻、交给对方。",
    "只有在你确实有 EX 能放的时候才会 @ 你。一个都放不出来（Cost 不够 / 全在冷却 / 全员被嘲讽或恐惧）时机器人直接替你过，战报和战场图照发。",
    "普攻锁定对位；EX 由你指定主目标。放过 EX 的人本回合不再放小技能；换弹类（鹤城 / 芹香）本回合仍普攻，跟普攻阶段一起结算。",
    "动作顺序：玩家 EX（可停下来再放）→ 全体普通技能 → 全体普攻。技能一定赶在普攻前，减防/增伤不会白放。",
    "",
    "【战场分割】1·2 号位是一个战场，3·4 号位是另一个，两边各打各的（原作机制）。",
    "本战场的敌人全灭了才会越界打另一边。挡刀看角色自己的前/中/后排，不是职业：前排挡中排，中排挡后排。",
    "嘲讽最高，其次同战场的佩洛洛，再是前 → 中 → 后。两个前排就还是 2 打 2；前+中的多目标只打前排。被嘲讽的那一轮放不出 EX。",
    "",
    "【范围】原作的扇形/圆形按覆盖面积折算成打 2 / 3 / 全体，范围伤害不衰减，每个目标吃全额。",
    "多目标技能由你指定主目标，其余从主目标向外扩散，优先选百分比血量最低的。",
    "扩散不跨战场：指定 3 位就只波及 4 位；同战场只剩一人时范围技当场退化成单体。「敌方全体」不受此限。",
    "",
    "【分段】原作的多段攻击原样保留，每一段独立判定命中与暴击。",
    "段数越多伤害越稳，单段技能则是要么全中要么全空。",
    "",
    `Cost：在每个回合「结束时」回复 = 存活人数 × ${CFG.COST_REGEN_PER_UNIT}，上限 ${CFG.COST_MAX}（与原作一致）。`,
    `因此首轮双方都不回复：先手首轮 ${CFG.COST_START} 点，后手首轮 ${CFG.COST_START + CFG.SECOND_BONUS} 点，之后后手恒定领先 ${CFG.SECOND_BONUS} 点。`,
    "四个角色的 EX 随时可选，一次只放一个；同一角色每回合最多释放一次。",
    "放完 EX 要压冷却：得等本方之后再放出「存活人数 − 2」个 EX 才轮回来（满编 4 人＝隔 2 个）。",
    "轮到你时若比上回合少人，全员冷却立即清空（4 人减到 3 人，上回合放过的人也能再放）。",
    "",
    `【普通技能】原作是按秒自动触发，这里折成冷却（1 轮 = ${CFG.ROUND_SECONDS} 秒）；冷却和 Buff/护盾时长都只在自己方回合跳，对面行动时不动，所以「N 回合」= N 轮。`,
    "开局压满冷却，第一次发动要等冷却走完；血量条件类技能满足条件才触发，部分每场限用几次。",
    "命中失败只取消该段伤害，技能的附加效果仍然生效。",
    "Buff / Debuff 从施放瞬间生效；同一施加者刷新，不同施加者同类效果分层乘算。",
    "护盾是真血上方的独立蓝色假血条，重复施加以最后一次盾量和持续时间为准。",
    "",
    `【时限】原作一局 4 分钟 = ${CFG.MAX_ROUND} 轮；打满则比双方「当前血量 ÷ 最大血量」定胜负。`,
    `【白热化】剩余不足 1 分钟时进入，即第 ${CFG.FEVER_ROUND} 轮。`,
    `场上主力 Cost 回复 ×${CFG.FEVER_COST_MULT}（每人 1.0），不在场上的支援仍各回 0.5；并全场防御 / 闪避 / 受治疗 −${Math.round(CFG.FEVER_DEBUFF * 100)}%，持续到结束。`,
    "",
    "【目标】不指定目标时一律走对位：对位 → 同战场最近 → 全场最近。EX 想打谁就写谁。",
    "",
    "【克制】克制 ×2.0 / 普通 ×1.0 / 被抵抗 ×0.5，非对称（振动打特殊 ×1.5）。",
    "克制关系的杀伤力远大于原创版本，配队时优先看属性对位。",
    "",
    "档案图鉴　　　按属性列出全部角色（文字）",
    "档案图鉴 星野　发这个角色的完整数值卡（图片）",
    "档案攻略 / 认输 / 结束对战",
  ].join("\n")
}

export class BaBattle extends plugin {
  constructor() {
    // 1130：早于 AI 聊天（1135），否则「过」「ex 1」这种短指令会被聊天先吃掉
    super({ name: "档案对战", priority: 1130 })
    this.store = null
  }

  async init() {
    this.store = new BattleStore(getRedis())
  }

  // ---------------- 工具 ----------------

  scopeOf(e) {
    return this.getScopeKey(e.group_id)
  }

  displayName(e) {
    return e.sender?.card || e.sender?.nickname || String(e.user_id)
  }

  async sendForward(e, texts, info = {}) {
    return e.sendForwardMsg(toNodes(texts, e.bot.self_id, e.bot.nickname), info)
  }

  /** 群里发一条普通消息（launch 是从私聊触发的，拿不到群 event） */
  async sayToGroup(bot, groupId, message) {
    if (!message) return false
    try {
      await bot.pickGroup(groupId).sendMsg(message)
      return true
    } catch (error) {
      logger.warn(`[档案对战] 群消息发送失败：${error.message}`)
      return false
    }
  }

  async forwardToGroup(bot, groupId, items) {
    const nodes = toNodes(items, bot.self_id, bot.nickname)
    if (!nodes.length) return false
    try {
      await bot.pickGroup(groupId).sendForwardMsg(nodes)
      return true
    } catch (error) {
      logger.warn(`[档案对战] 战报转发失败：${error.message}`)
      return false
    }
  }

  /**
   * 一步之后 @ 当前该动手的人。图里已经有 Cost / EX / 血量，这里只喊一声。
   * **只在他真有得选的时候才喊** —— 没有可放的 EX 时 `autoSteps` 已经把回合过掉了。
   */
  async pingTurn(bot, groupId, session) {
    const st = session.state
    const player = session.players[st.activeSide]
    let text = " 轮到你了，请行动"
    // 走到这儿还没得放，只可能是连过撞了 AUTO_PASS_MAX。说清楚原因，别让他对着空名单发呆
    if (!exCastableOf(st, st.activeSide).length) {
      const reasons = new Set(
        st.sides[st.activeSide].units
          .filter((u) => u.alive)
          .map((u) => exLockedOf(st, u))
          .filter(Boolean)
      )
      const why = reasons.size === 1 ? [...reasons][0] : "控制"
      text = exSealedOf(st, st.activeSide)
        ? ` 全员被${why}，发「过」继续`
        : " 现在没有能放的 EX，发「过」继续"
    }
    await this.sayToGroup(bot, groupId, [
      Segment.at(player.uid),
      Segment.text(text),
    ])
  }

  /**
   * 没有可放的 EX 就替他把回合过掉。
   *
   * 那一步玩家没有任何选择权 —— 名单是空的，发「过」是唯一的合法输入，
   * 让他打这一句只是多一次往返（开局 Cost 为 0，97% 的局第一回合就是这样）。
   * **有得选才停下来等指令**，这条是「回合停在哪」的唯一判据。
   *
   * 嘲讽 / 恐惧封住全队时 `exCastableOf` 同样返回空，所以走同一条路自动过 ——
   * 原先在这儿停下来，是为了给**支援位**留出手的余地（那类角色不站在场上、
   * 吃不到场地嘲讽，被封的那一轮仍能行动）。现在池里一个支援位都没有，
   * 停下来只是让被控的一方多打一句「过」。等支援位进池要把这条改回去。
   *
   * @returns {Array<{state, log, events}>} 自动过掉的每一回合，按顺序播报
   */
  autoSteps(state) {
    const steps = []
    let st = state
    while (st.phase !== "done"
      && !exCastableOf(st, st.activeSide).length
      && steps.length < AUTO_PASS_MAX) {
      const { state: next, log, events, error } = playerTurn(st, { type: "pass" })
      if (error) {
        logger.warn(`[档案对战] 自动过回合失败：${error}`)
        break
      }
      st = next
      steps.push({ state: st, log, events })
    }
    return steps
  }

  async battleMapSegment(state, log = [], events = [], options = {}) {
    try {
      return Segment.image(await baBattleImageGenerator.generateBattleMap(state, { log, events, ...options }))
    } catch (error) {
      logger.warn(`[档案对战] 战场图渲染失败：${error.message}`)
      return null
    }
  }

  async characterCardSegment(tmpl) {
    try {
      return Segment.image(await baBattleImageGenerator.generateCharacterCard(tmpl))
    } catch (error) {
      logger.warn(`[档案对战] 角色卡渲染失败，已回退文字：${error.message}`)
      return null
    }
  }

  /** 图鉴总览图。渲染失败就少发这一条，后面的文字节点才是配队的必要信息 */
  async rosterGridSegment() {
    try {
      return Segment.image(await baBattleImageGenerator.generateRosterGrid())
    } catch (error) {
      logger.warn(`[档案对战] 图鉴总览渲染失败：${error.message}`)
      return null
    }
  }

  /**
   * 图鉴的合并转发节点：**首条是全员总览图**，之后按攻击属性一个属性一个节点 ——
   * 配队时要比的就是属性对位，图给「有谁、什么属性装甲、几费」，文字给技能详情。
   * **一律走合并转发**，不管发给谁：拆成一个属性一条普通消息会刷三屏，
   * 而且配队时还得往回翻聊天记录。
   * @param {string|null} hint 总览图之后的用法说明，私聊配队时才给
   */
  async rosterNodes(hint = null) {
    return [await this.rosterGridSegment(), hint, ...renderRosterByType()].filter(Boolean)
  }

  /** 私聊发不出去时的兜底：图鉴照样以合并转发发在群里 */
  async sendRosterByType(bot, groupId) {
    return this.forwardToGroup(bot, groupId, await this.rosterNodes())
  }

  /**
   * 图鉴私聊发给一个玩家。配队本来就在私聊做，图鉴跟着走私聊。
   * @returns {Promise<boolean>} 没加好友 / 被风控时返回 false，调用方兜回群里
   */
  async sendRosterToUser(bot, uid) {
    const nodes = toNodes(await this.rosterNodes(
      "📖 角色图鉴　直接回复 6 个角色名完成配队（前 4 主力 + 后 2 支援）\n" +
      "例：星野 白子 野宫 芹香\n" +
      "写的顺序就是左起站位，决定普攻对位"
    ), bot.self_id, bot.nickname)
    try {
      await bot.pickFriend(uid).sendForwardMsg(nodes)
      return true
    } catch (error) {
      logger.warn(`[档案对战] 图鉴私聊发送失败（${uid}）：${error.message}`)
      return false
    }
  }

  async guidePageSegments() {
    try {
      const pages = await baBattleImageGenerator.generateGuidePages()
      return pages.map((buffer) => Segment.image(buffer))
    } catch (error) {
      logger.warn(`[档案对战] 攻略图渲染失败，已回退文字攻略：${error.message}`)
      return null
    }
  }

  // ---------------- 发起与应战 ----------------

  // e.msg 只拼接 text 段，at 段会被丢掉，所以正则里不用管 @，直接读 e.at
  start = Command(
    /^#?档案对战$/,
    { event: "message.group" },
    async function (e) {
      const scope = this.scopeOf(e)

      if (await this.store.load(scope)) {
        await e.reply("本群已经有一局在进行中，先打完或者 #结束对战")
        return true
      }

      const targetId = e.at && String(e.at) !== String(e.self_id) ? String(e.at) : null
      if (targetId && targetId === String(e.user_id)) {
        await e.reply("不能跟自己打")
        return true
      }

      await this.store.setInvite(scope, {
        from: String(e.user_id),
        fromName: this.displayName(e),
        to: targetId,
        at: Date.now(),
      })

      await e.reply(
        targetId
          ? [Segment.at(targetId), Segment.text(` ${this.displayName(e)} 向你发起档案对战，发送「#应战」接受（3 分钟内）`)]
          : `${this.displayName(e)} 发起了档案对战，任意群友发送「#应战」即可接受（3 分钟内）`
      )
      return true
    }
  )

  accept = Command(/^#?应战$/, { event: "message.group" }, async function (e) {
    const scope = this.scopeOf(e)

    if (await this.store.load(scope)) {
      await e.reply("本群已经有一局在进行中了")
      return true
    }

    const invite = await this.store.getInvite(scope)
    if (!invite) {
      await e.reply("当前没有待接受的对战，先让人发「#档案对战」")
      return true
    }
    if (String(e.user_id) === invite.from) {
      await e.reply("不能应自己的战")
      return true
    }
    if (invite.to && invite.to !== String(e.user_id)) {
      await e.reply("这局是指名邀战，你不是被邀请的那位")
      return true
    }

    await this.store.clearInvite(scope)

    // 蓝方 = 发起方，红方 = 应战方
    const session = {
      scope,
      groupId: String(e.group_id),
      selfId: String(e.self_id),
      phase: "draft",
      players: [
        { uid: invite.from, name: invite.fromName, picks: null },
        { uid: String(e.user_id), name: this.displayName(e), picks: null },
      ],
      state: null,
      createdAt: Date.now(),
    }
    await this.store.saveWithRouting(scope, e.self_id, session)

    await e.reply(
      `⚔️ ${session.players[0].name}（${SIDE_MARK[0]}蓝方） vs ${session.players[1].name}（${SIDE_MARK[1]}红方）\n` +
      "角色图鉴已私聊发给双方，直接回私聊 6 个角色名完成配队（前 4 主力 + 后 2 支援）。\n" +
      "配队是暗的，两边都提交后才揭晓。要看某人的完整数值：档案图鉴 星野"
    )

    // 私聊发不出去（没加好友/被风控）就兜回群里，否则这局根本开不起来
    const failed = []
    for (const p of session.players) {
      if (!(await this.sendRosterToUser(e.bot, p.uid))) failed.push(p.name)
    }
    if (failed.length) {
      await this.sayToGroup(e.bot, session.groupId,
        `私聊发不出图鉴（${failed.join("、")}），先加 bot 好友；这次改发群里`)
      await this.sendRosterByType(e.bot, session.groupId)
    }
    return true
  })

  // ---------------- 配队（私聊） ----------------

  draft = OnEvent("message.private", async function (e) {
    const scope = await this.store.findByUser(e.self_id, e.user_id)
    if (!scope) return false

    const session = await this.store.load(scope)
    if (!session || session.phase !== "draft") return false

    const me = session.players.find((p) => p.uid === String(e.user_id))
    if (!me) return false
    if (me.picks) {
      await e.reply("你已经提交过配队了，等对手")
      return true
    }

    const parsed = parseDraft(e.msg || "")
    if (!parsed.ok) {
      await e.reply(`${parsed.error}\n格式：6 个角色名，前 4 主力 + 后 2 支援，例「星野 白子 野宫 芹香 静子 芹娜」`)
      return true
    }

    me.picks = parsed.picks
    await this.store.save(scope, session)

    // 顺序就是左起站位，会影响对位，所以用箭头把顺序说清楚，但不给角色编号
    const names = parsed.picks.map((id) => BY_ID[id].name).join(" → ")
    await e.reply(`✅ 配队已提交\n${names}\n（左起站位，决定普攻对位）`)

    const other = session.players.find((p) => p.uid !== me.uid)
    if (!other.picks) {
      await e.reply("等待对手配队中…")
      return true
    }

    // 双方都交了 → 开局
    await this.launch(e, scope, session)
    return true
  })

  /** 双方配队齐了，建局并在群里揭晓 */
  async launch(e, scope, session) {
    const first = Math.random() < 0.5 ? 0 : 1
    session.state = createBattle(
      { uid: session.players[0].uid, name: session.players[0].name, picks: session.players[0].picks },
      { uid: session.players[1].uid, name: session.players[1].name, picks: session.players[1].picks },
      { first }
    )
    session.phase = "battle"
    await this.store.save(scope, session)

    const st = session.state
    const roster = (side) => st.sides[side].units.map((u) => BY_ID[u.id].name).join(" / ")
    await this.forwardToGroup(e.bot, session.groupId, [
      `⚔️ 配队揭晓　第 1 轮`,
      `${SIDE_MARK[0]} ${session.players[0].name}\n${roster(0)}`,
      `${SIDE_MARK[1]} ${session.players[1].name}\n${roster(1)}`,
      `先手：${SIDE_MARK[st.first]} ${session.players[st.first].name}`,
    ])
    await this.sendBattleImage(e.bot, session.groupId, st)
    // 开局 Cost 为 0，97% 的局先手第一回合根本没得放 —— 直接推到第一个有得选的回合
    const steps = this.autoSteps(st)
    if (steps.length) {
      session.state = steps.at(-1).state
      if (session.state.phase === "done") session.phase = "done"
      await this.store.save(scope, session)
    }
    await this.report(e, session, steps)
  }

  async sendBattleImage(bot, groupId, state, log = [], events = []) {
    const map = await this.battleMapSegment(state, log, events)
    if (map) await this.sayToGroup(bot, groupId, map)
  }

  // ---------------- 出招 ----------------

  // 宽松匹配「<名字>ex…」，真正的把关在 parseAction：施放者认不出来就返回 null 放行
  act = Command(
    /^(?:过|pass|p|[^\s]{1,12}\s*ex.*)$/i,
    { event: "message.group" },
    async function (e) {
      const scope = this.scopeOf(e)
      const session = await this.store.load(scope)
      // 没有对局就放行，别把正常聊天里的「过」吃掉
      if (!session || session.phase !== "battle") return false

      const st = session.state
      const active = session.players[st.activeSide]
      if (active.uid !== String(e.user_id)) {
        // 是这局的另一位玩家 → 提醒；路人 → 静默放行
        if (session.players.some((p) => p.uid === String(e.user_id))) {
          await e.reply(`还没轮到你，现在是 ${SIDE_MARK[st.activeSide]} ${active.name} 的回合`)
          return true
        }
        return false
      }

      const parsed = parseAction(e.msg || "")
      if (!parsed) return false
      if (!parsed.ok) {
        await e.reply(parsed.error)
        return true
      }

      const invalid = validateAction(st, parsed.action)
      if (invalid) {
        await e.reply(invalid)
        return true
      }

      const lock = await this.store.withLock(scope, async () => {
        // 拿到锁之后重新读一次，防止两条指令并发时用了过期状态
        const fresh = await this.store.load(scope)
        if (!fresh || fresh.phase !== "battle") return null
        if (fresh.state.activeSide !== st.activeSide) return null

        const { state: next, log, events, error } = playerTurn(
          fresh.state,
          parsed.action
        )
        if (error) return { error }

        // 这一步之后对方（或他自己，如果还能接着放）没得选的话，顺手把那些回合过掉，
        // 一并在锁里推完再统一播报 —— 免得中间插进来另一条指令用了半路的状态
        const steps = [{ state: next, log, events }, ...this.autoSteps(next)]
        fresh.state = steps.at(-1).state
        if (fresh.state.phase === "done") fresh.phase = "done"
        await this.store.save(scope, fresh)
        return { session: fresh, steps }
      })

      if (!lock.locked) {
        await e.reply("上一条指令还在结算，稍等一下")
        return true
      }
      const r = lock.result
      if (!r) return true
      if (r.error) {
        await e.reply(r.error)
        return true
      }

      await this.report(e, r.session, r.steps)
      return true
    }
  )

  /**
   * 每一回合各发一份「战报转发 → 战场图」，最后 @ 下一个人（或结算）。
   * 自动过掉的回合照样出图出战报 —— 省掉的只是玩家那句「过」，不是他该看的东西。
   */
  async report(e, session, steps) {
    const st = session.state
    const bot = e.bot
    const gid = session.groupId

    for (const s of steps) {
      const nodes = mergeTurnLog(s.log)
      await this.forwardToGroup(bot, gid, nodes.length ? nodes : ["（本回合没有产生日志）"])
      await this.sendBattleImage(bot, gid, s.state, s.log, s.events)
    }

    if (st.phase !== "done") {
      await this.pingTurn(bot, gid, session)
      return
    }
    const winner = st.winner
    await this.sayToGroup(bot, gid, winner === -1
      ? `第 ${st.round} 轮结束 —— 平局`
      : [
        Segment.at(session.players[winner].uid),
        Segment.text(` ${SIDE_MARK[winner]} ${session.players[winner].name} 获胜！（第 ${st.round} 轮）`),
      ])
    await this.store.clear(session.scope, session.selfId, session)
  }

  // ---------------- 辅助指令 ----------------

  surrender = Command(/^#?(认输|投降)$/, { event: "message.group" }, async function (e) {
    const scope = this.scopeOf(e)
    const session = await this.store.load(scope)
    if (!session) {
      await e.reply("本群当前没有对战")
      return true
    }
    const idx = session.players.findIndex((p) => p.uid === String(e.user_id))
    if (idx < 0) {
      await e.reply("你不在这局里")
      return true
    }
    await this.store.clear(scope, session.selfId, session)
    await e.reply(`${session.players[idx].name} 认输，${SIDE_MARK[1 - idx]} ${session.players[1 - idx].name} 获胜！`)
    return true
  })

  cancel = Command(/^#?结束对战$/, { event: "message.group" }, async function (e) {
    const scope = this.scopeOf(e)
    const session = await this.store.load(scope)
    if (!session) {
      await this.store.clearInvite(scope)
      await e.reply("本群当前没有对战")
      return true
    }
    const inGame = session.players.some((p) => p.uid === String(e.user_id))
    if (!inGame && !e.isMaster && !e.isAdmin) {
      await e.reply("只有对局双方或管理员能结束对战")
      return true
    }
    await this.store.clear(scope, session.selfId, session)
    await e.reply("对战已结束")
    return true
  })

  // 点名某人才发角色卡图（那是唯一需要完整数值面板的场合），否则只发文字
  guide = Command(/^#?档案图鉴\s*(.*)$/, { event: "message.group" }, async function (e) {
    const key = (e.match?.[1] || "").trim()
    if (!key) {
      await this.sendForward(e, await this.rosterNodes(), {
        source: "档案对战 · 角色图鉴",
        summary: `${ROSTER.length} 名角色，总览图 + 按攻击属性分组`,
      })
      return true
    }
    const t = findUnit(key)
    if (!t) {
      await e.reply(`找不到角色「${key}」`)
      return true
    }
    await e.reply(await this.characterCardSegment(t) || renderOne(t))
    return true
  })

  help = Command(/^#?档案(?:对战)?(?:帮助|攻略)$/, async function (e) {
    const pages = await this.guidePageSegments()
    await this.sendForward(e, pages || [renderGuideFallback()], {
      source: "档案对战 · 攻略",
      summary: pages ? `${pages.length} 页图片攻略` : "玩法攻略",
    })
    return true
  })
}
