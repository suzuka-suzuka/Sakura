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

import { ROSTER, CFG, BY_ID, findUnit } from "../lib/ba/roster.js"
import { createBattle, playerTurn, validateAction } from "../lib/ba/engine.js"
import { BattleStore } from "../lib/ba/store.js"
import { parseDraft, parseAction } from "../lib/ba/parse.js"
import { baBattleImageGenerator } from "../lib/ba/BaBattleImageGenerator.js"
import {
  renderRoster, renderOne, SIDE_MARK,
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
    "【碧蓝档案 · 回合制群战】4v4 · v5",
    "",
    "一方完成一次行动叫 1 回合；先手、后手各完成 1 回合叫 1 轮。开局与每个回合结算后都只发送 1 张战场图。",
    "#档案对战 @某人　发起（不 @ 则公开邀战）",
    "#应战　　　　　　接受",
    "应战后完整角色图鉴会在群里统一发送；双方再私聊 bot 发 4 个编号完成暗配队，例如：14 5 9 1",
    "",
    "出招：过 / ex 1 / ex 1>3 / ex 2>友3 / ex 1>3 4",
    "普攻和普通技能锁定对位，EX 按技能规则指定目标。",
    "动作优先级：EX → 普通技能 → 普攻；同一角色每回合只行动一次。",
    "放过 EX 后，本回合不再触发小技能或普攻；已就绪的小技能保留到该角色下个回合。",
    "",
    `Cost：开局图已经进入先手回合，满编时显示先手可用 2、后手下回合预计 ${CFG.COST_START + CFG.SECOND_BONUS + 2}；每个己方回合回复 = 存活人数 × ${CFG.COST_REGEN_PER_UNIT}，上限 ${CFG.COST_MAX}。`,
    "每队 4 张角色 EX 牌，同时显示 2 张窗口牌与后续补牌顺序；一条指令可以按显示顺序连续释放多张。",
    "同一角色每回合最多释放一次 EX；四名 2 费角色有 10 Cost 时可以连续放完四张，剩余 2 Cost。",
    "阵亡角色的 EX 牌会自动移出牌组。",
    "",
    "命中失败只取消伤害，技能附加 Debuff 仍生效；灼烧伤害固定命中。",
    "Buff / Debuff 从施放瞬间生效；同一施加者刷新，不同施加者同类效果分层乘算。",
    "护盾是位于真血上方的独立白色假血条；重复施加以最后一次盾量和持续时间为准。",
    "",
    "#档案图鉴 [角色]（仅群聊） / #档案攻略 / #认输 / #结束对战",
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

  /** 开局和每次回合结算都只向群里发送这一张独立战场图。 */
  async sendBattleImageToGroup(bot, groupId, image) {
    if (!image) return false
    try {
      await bot.pickGroup(groupId).sendMsg(image)
      return true
    } catch (error) {
      logger.warn(`[档案对战] 战场图发送失败：${error.message}`)
      return false
    }
  }

  async battleMapSegment(state, log = [], events = [], options = {}) {
    try {
      return Segment.image(await baBattleImageGenerator.generateBattleMap(state, { log, events, ...options }))
    } catch (error) {
      logger.warn(`[档案对战] 战场图渲染失败：${error.message}`)
      return null
    }
  }

  async rosterCardSegments(templates = ROSTER) {
    try {
      // @napi-rs/canvas 并发绘制中文时偶发缺字；首次顺序生成，之后命中生成器缓存。
      const buffers = templates === ROSTER
        ? await baBattleImageGenerator.generateRosterCards()
        : []
      if (templates !== ROSTER) {
        for (const tmpl of templates) {
          buffers.push(await baBattleImageGenerator.generateCharacterCard(tmpl))
        }
      }
      return buffers.map((buffer) => Segment.image(buffer))
    } catch (error) {
      logger.warn(`[档案对战] 角色卡渲染失败，已回退文字图鉴：${error.message}`)
      return null
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
      "角色图鉴将在本群统一发送一次，双方私聊回复 4 个编号完成配队。\n" +
      "配队是暗的，两边都提交后才揭晓。"
    )

    const cards = await this.rosterCardSegments()
    const nodes = cards || renderRoster()
    await this.sendForward(e, nodes, {
      source: "档案对战 · 配队图鉴",
      summary: `${ROSTER.length} 张独立角色卡`,
    })
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
    const map = await this.battleMapSegment(st)
    await this.sendBattleImageToGroup(e.bot, session.groupId, map)
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

  /** 把刚结算的行动回放画进唯一一张战场图。 */
  async report(e, session, log, events) {
    const st = session.state
    const map = await this.battleMapSegment(st, log, events)
    await this.sendBattleImageToGroup(e.bot, session.groupId, map)

    if (st.phase === "done") {
      await this.store.clear(session.scope, session.selfId, session)
    }
  }

  // ---------------- 辅助指令 ----------------

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

  guide = Command(/^#档案图鉴\s*(.*)$/, { event: "message.group" }, async function (e) {
    const key = (e.match?.[1] || "").trim()
    if (key) {
      const t = findUnit(key)
      if (!t) {
        await e.reply(`找不到角色「${key}」`)
        return true
      }
      const cards = await this.rosterCardSegments([t])
      await e.reply(cards?.[0] || renderOne(t))
      return true
    }
    const cards = await this.rosterCardSegments()
    await this.sendForward(e, cards || renderRoster(), {
      source: "档案对战 · 角色图鉴",
      summary: `${ROSTER.length} 张独立角色卡`,
    })
    return true
  })

  help = Command(/^#档案(?:对战)?(?:帮助|攻略)$/, async function (e) {
    const pages = await this.guidePageSegments()
    await this.sendForward(e, pages || [renderGuideFallback()], {
      source: "档案对战 · 攻略",
      summary: pages ? `${pages.length} 页图片攻略` : "玩法攻略",
    })
    return true
  })
}
