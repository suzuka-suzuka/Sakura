/**
 * 碧蓝档案 · 回合制群战
 *
 * 4v4 单排对线 / 暗配队 / 交替玩家回合 / Cost 驱动 EX。
 * 设计与数值验证见 docs/ba-battle/设计文档.md，战斗内核在 lib/ba/engine.js。
 *
 * 测试期约定：不做超时判负，一局靠 Redis TTL（3 小时）兜底；
 * 卡住了用 #结束对战 手动清。先把游戏性跑出来再补运营向的东西。
 */

import { Command, OnEvent, plugin } from "../../../src/core/plugin.js"
import { Segment } from "../../../src/api/client.js"
import { getRedis } from "../../../src/utils/redis.js"
import { logger } from "../../../src/utils/logger.js"

import { ROSTER, CFG, BY_ID, findUnit } from "../lib/ba/roster.js"
import { createBattle, playerTurn, validateAction, tmplOf, aliveOf } from "../lib/ba/engine.js"
import { BattleStore } from "../lib/ba/store.js"
import { parseDraft, parseAction } from "../lib/ba/parse.js"
import {
  renderReveal, renderTurn, renderResult, renderField,
  renderRoster, renderOne, SIDE_NAME, SIDE_MARK,
} from "../lib/ba/format.js"

/** 把纯文本数组包成合并转发节点。群聊和私聊都能用，不依赖 event 上下文。 */
function toNodes(texts, botId, botName) {
  return texts
    .filter((t) => t != null && String(t).length)
    .map((t) => ({
      type: "node",
      data: {
        user_id: botId,
        nickname: botName || "档案对战",
        content: [Segment.text(String(t))],
      },
    }))
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

  /** 从任意上下文往指定群发转发消息（配队私聊完成后要往群里播报） */
  async forwardToGroup(bot, groupId, texts, info = {}) {
    const nodes = toNodes(texts, bot.self_id, bot.nickname)
    return bot.sendForwardMsg({ messages: nodes, group_id: groupId, ...info })
  }

  // ---------------- 发起与应战 ----------------

  // e.msg 只拼接 text 段，at 段会被丢掉，所以正则里不用管 @，直接读 e.at
  start = Command(
    /^#档案对战$/,
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

  accept = Command(/^#应战$/, { event: "message.group" }, async function (e) {
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
      version: 1,
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
      "已私聊发送角色图鉴，双方私聊回复 4 个编号完成配队。\n" +
      "配队是暗的，两边都提交后才揭晓。"
    )

    const nodes = renderRoster()
    for (const p of session.players) {
      try {
        await e.bot.pickFriend(p.uid).sendForwardMsg(toNodes(nodes, e.bot.self_id, e.bot.nickname))
      } catch (err) {
        logger.warn(`[档案对战] 给 ${p.uid} 发图鉴失败：${err.message}`)
        await e.reply(`给 ${p.name} 发私聊失败，可能需要先加好友。可以在群里发 #档案图鉴 查看，然后私聊 bot 提交配队。`)
      }
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
      await e.reply(`${parsed.error}\n格式：4 个编号或角色名，例「14 5 9 1」`)
      return true
    }

    me.picks = parsed.picks
    await this.store.save(scope, session)

    const names = parsed.picks.map((id, i) => `${i + 1}.${BY_ID[id].name}`).join(" ")
    await e.reply(`✅ 配队已提交\n${names}`)

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
    const active = session.players[st.activeSide]
    await this.forwardToGroup(
      e.bot,
      session.groupId,
      [
        renderReveal(st),
        renderField(st),
        `轮到 ${SIDE_MARK[st.activeSide]} ${active.name} 出招\n` +
        "指令：「过」或「ex 1」「ex 1>3」「ex 1 4」",
      ],
      { source: "档案对战 · 开局", summary: `${session.players[0].name} vs ${session.players[1].name}` }
    )
  }

  // ---------------- 出招 ----------------

  act = Command(
    /^(?:过|pass|p|ex\s*.+|EX\s*.+|技\s*.+|大\s*.+)$/i,
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

        const side = fresh.state.activeSide
        const { state: next, log, error, costBefore, gained, spent } = playerTurn(
          fresh.state,
          parsed.action
        )
        if (error) return { error }

        fresh.state = next
        if (next.phase === "done") fresh.phase = "done"
        await this.store.save(scope, fresh)
        return { session: fresh, log, side, meta: { costBefore, gained, spent } }
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

      await this.report(e, r.session, r.log, r.side, r.meta)
      return true
    }
  )

  /** 发战报 */
  async report(e, session, log, side, meta) {
    const st = session.state
    const nodes = renderTurn(st, log, side, meta)

    if (st.phase === "done") {
      nodes.push(renderResult(st))
      await this.sendForward(e, nodes, {
        source: "档案对战 · 结算",
        summary: `${session.players[0].name} vs ${session.players[1].name}`,
      })
      await this.store.clear(session.scope, session.selfId, session)
      return
    }

    const next = session.players[st.activeSide]
    nodes.push(
      `轮到 ${SIDE_MARK[st.activeSide]} ${next.name} 出招\n` +
      `Cost ${st.sides[st.activeSide].cost}（回合开始会先回复）`
    )
    await this.sendForward(e, nodes, {
      source: `档案对战 · 第 ${st.round} 回合`,
      summary: `${SIDE_NAME[side]} ${session.players[side].name}`,
    })
  }

  // ---------------- 辅助指令 ----------------

  status = Command(/^#战况$/, { event: "message.group" }, async function (e) {
    const session = await this.store.load(this.scopeOf(e))
    if (!session) {
      await e.reply("本群当前没有对战")
      return true
    }
    if (session.phase === "draft") {
      const waiting = session.players.filter((p) => !p.picks).map((p) => p.name)
      await e.reply(`配队阶段，等待：${waiting.join("、") || "无"}`)
      return true
    }
    const st = session.state
    await this.sendForward(e, [
      renderField(st),
      `轮到 ${SIDE_MARK[st.activeSide]} ${session.players[st.activeSide].name} 出招`,
    ], { source: "档案对战 · 战况" })
    return true
  })

  surrender = Command(/^#(认输|投降)$/, { event: "message.group" }, async function (e) {
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

  cancel = Command(/^#结束对战$/, { event: "message.group" }, async function (e) {
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

  guide = Command(/^#档案图鉴\s*(.*)$/, async function (e) {
    const key = (e.match?.[1] || "").trim()
    if (key) {
      const t = findUnit(key)
      if (!t) {
        await e.reply(`找不到角色「${key}」`)
        return true
      }
      await e.reply(renderOne(t))
      return true
    }
    await this.sendForward(e, renderRoster(), {
      source: "档案对战 · 角色图鉴",
      summary: `${ROSTER.length} 名角色`,
    })
    return true
  })

  help = Command(/^#档案对战帮助$/, async function (e) {
    await e.reply(
      [
        "【碧蓝档案 · 回合制群战】4v4",
        "",
        "#档案对战 @某人　发起（不@则任意人可应战）",
        "#应战　　　　　　接受",
        "然后私聊 bot 发 4 个编号完成暗配队，例「14 5 9 1」",
        "",
        "配队顺序 = 1~4 号位，蓝1 对红1、蓝2 对红2……",
        "普攻和普通技能被对位锁死，只有 EX 能自由选目标。",
        "",
        "出招指令（群内公开）：",
        "  过　　　　本回合不放 EX",
        "  ex 1　　　1 号位放 EX，目标走默认",
        "  ex 1>3　　1 号位 EX 打敌方 3 号位",
        "  ex 2>友3　目标是己方 3 号位（治疗/护盾）",
        "  ex 1 4　　一次放多个",
        "",
        `Cost：开局 0，每回合回复 = 存活人数 × 0.5，上限 ${CFG.COST_MAX}`,
        "人越少回得越慢，所以保人就是保资源。",
        "",
        "#战况 / #认输 / #结束对战 / #档案图鉴 [角色]",
      ].join("\n")
    )
    return true
  })
}
