/**
 * 碧蓝档案 · 回合制群战
 *
 * 4v4 单排对线 / 暗配队 / 交替回合 / Cost 驱动 EX。
 * 设计与数值验证见 docs/ba-battle/设计文档.md，战斗内核在 lib/ba/engine.js。
 *
 * 测试期约定：不做超时判负，一局靠 Redis TTL（3 小时）兜底；
 * 卡住了用 #结束对战 手动清。先把游戏性跑出来再补运营向的东西。
 */

import { Command, OnEvent, plugin } from "../../../src/core/plugin.js"
import { Segment } from "../../../src/api/client.js"
import { getRedis } from "../../../src/utils/redis.js"
import { logger } from "../../../src/utils/logger.js"

import { CFG, BY_ID, findUnit } from "../lib/ba/roster.js"
import { createBattle, playerTurn, validateAction, turnCostOf } from "../lib/ba/engine.js"
import { BattleStore } from "../lib/ba/store.js"
import { parseDraft, parseAction } from "../lib/ba/parse.js"
import { baBattleImageGenerator } from "../lib/ba/BaBattleImageGenerator.js"
import {
  renderRosterByType, renderExWindow, renderOne, SIDE_MARK,
} from "../lib/ba/format.js"

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
    "应战后角色图鉴按属性发在群里；双方再私聊 bot 发 4 个角色名完成暗配队，例如：星野 白子 野宫 芹香",
    "配队顺序就是左起站位，决定普攻对位。",
    "",
    "出招：星野ex　/　星野ex打白子　/　星野ex给芹香　/　星野ex打白子 芹香ex　/　过",
    "一律写角色名，不用编号；同队不许重名，所以名字就能唯一定位。",
    "中间的字决定目标在哪一边：打/攻/揍 是敌方，给/帮/治 是己方；不写就按技能自己的目标类型判定。",
    "一条指令连放多个用空格隔开，按写的先后依次结算，先放的先进冷却。",
    "普攻锁定对位；EX 与范围型普通技能由你指定主目标。",
    "动作优先级：EX → 普通技能 → 普攻；同一角色每回合只行动一次。",
    "放过 EX 后本回合不再自动出手（换弹类 EX 除外，它会紧接着补一次普攻）。",
    "",
    "【战场分割】1·2 号位是一个战场，3·4 号位是另一个，两边各打各的（原作机制）。",
    "本战场的敌人全灭了才会越界打另一边；所以坦克放 1 位只保护 1·2，站位是有讲究的。",
    "同一战场里优先打坦克 —— 坦克相当于站前一格替队友挡刀。嘲讽优先级最高，直接无视分割。",
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
    "四个角色的 EX 随时可选，一条指令可以连续释放多个；同一角色每回合最多释放一次。",
    "放完 EX 要压冷却：得等本方之后再放出「存活人数 − 2」个 EX 才轮回来（满编 4 人＝隔 2 个）。",
    "自己回合开始时若有人阵亡，全员冷却立即清空，不会出现谁都放不出来的死局。",
    "",
    "【普通技能】原作是按秒自动触发，这里折成回合冷却（1 回合 = 5 秒）；血量条件类技能满足条件才触发，部分每场限用几次。",
    "命中失败只取消该段伤害，技能的附加效果仍然生效。",
    "Buff / Debuff 从施放瞬间生效；同一施加者刷新，不同施加者同类效果分层乘算。",
    "护盾是真血上方的独立蓝色假血条，重复施加以最后一次盾量和持续时间为准。",
    "",
    `【时限】原作一局 4 分钟 = ${CFG.MAX_ROUND * 2} 回合（${CFG.MAX_ROUND} 轮）；打满则比双方「当前血量 ÷ 最大血量」定胜负。`,
    `【白热化】剩余不足 1 分钟时进入，即第 ${CFG.FEVER_TURN} 回合（第 ${CFG.FEVER_TURN / 2} 轮）。`,
    `Cost 回复 ×${CFG.FEVER_COST_MULT}（原作 FEVER 的核心效果），并全场防御 / 闪避 / 受治疗 −${Math.round(CFG.FEVER_DEBUFF * 100)}%，持续到结束。`,
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
   * 一个回合结束后固定发三条：战报转发 → 战场图 → @下一个人。
   * 拆成三条是有意的：转发要点开才看，图要直接看到，@ 要能在通知里点开。
   */
  async pingTurn(bot, groupId, session) {
    const st = session.state
    const player = session.players[st.activeSide]
    const side = st.sides[st.activeSide]
    await this.sayToGroup(bot, groupId, [
      Segment.at(player.uid),
      Segment.text(
        ` 轮到你了　${SIDE_MARK[st.activeSide]} 第 ${st.round} 轮　Cost ${turnCostOf(side)}/${CFG.COST_MAX}\n` +
        `${renderExWindow(st, st.activeSide)}\n` +
        "出招：星野ex打白子　多个用空格隔开　不动就发「过」"
      ),
    ])
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

  /** 图鉴按攻击属性拆开发，一个属性一条 —— 配队时要比的就是属性对位 */
  async sendRosterByType(bot, groupId) {
    for (const block of renderRosterByType()) {
      await this.sayToGroup(bot, groupId, block)
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
      "角色图鉴按属性发在下面，双方私聊回复 4 个角色名完成配队。\n" +
      "配队是暗的，两边都提交后才揭晓。要看某人的完整数值：档案图鉴 星野"
    )
    await this.sendRosterByType(e.bot, session.groupId)
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
      await e.reply(`${parsed.error}\n格式：4 个角色名，例「星野 白子 野宫 芹香」`)
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
    await this.pingTurn(e.bot, session.groupId, session)
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

        fresh.state = next
        if (next.phase === "done") fresh.phase = "done"
        await this.store.save(scope, fresh)
        return { session: fresh, log, events }
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

      await this.report(e, r.session, r.log, r.events)
      return true
    }
  )

  /** 战报转发 → 战场图 → @下一个人（或结算） */
  async report(e, session, log, events) {
    const st = session.state
    const bot = e.bot
    const gid = session.groupId

    await this.forwardToGroup(bot, gid, log?.length ? log : ["（本回合没有产生日志）"])
    await this.sendBattleImage(bot, gid, st, log, events)

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
      await this.sendRosterByType(e.bot, String(e.group_id))
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
