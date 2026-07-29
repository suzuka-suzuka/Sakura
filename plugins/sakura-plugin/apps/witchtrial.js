import Setting from "../lib/setting.js";
import { getCurrentBotSelfId } from "../../../src/api/client.js";
import { generateSetup } from "../lib/witchtrial/CaseGenerator.js";
import {
  pouchDetail,
  resolveInvestigateTurn,
  resolveTrialTurn,
  resolveVerdict,
  startChapter,
  votableConclusions,
} from "../lib/witchtrial/TrialEngine.js";
import { buildClosingText } from "../lib/witchtrial/prompts.js";
import {
  HELP_TEXT,
  buildNodes,
  renderCodex,
  renderCodexEntry,
  renderCourtRecord,
  renderCulpritNotice,
  renderFinale,
  renderFinding,
  renderGirlCard,
  renderIncident,
  renderInnocentNotice,
  renderInvestigationLeads,
  renderInvestigateTurn,
  renderPouch,
  renderPropositions,
  renderPrisonIntro,
  renderStatus,
  renderTrialOpening,
  renderTrialTurn,
  renderTurnDeadline,
  renderVerdict,
  renderVoteMenu,
  renderVoteProgress,
} from "../lib/witchtrial/render.js";
import { STANCE, recomputeSuspicion } from "../lib/witchtrial/logic.js";
import {
  girlByCode,
  girlOfUser,
  livingPlayers,
  locationByCode,
  safeString,
  toPlayerId,
} from "../lib/witchtrial/schema.js";
import {
  PHASES,
  acquireTurnLock,
  armTurnDeadline,
  claimUserIndex,
  clearTurnDeadline,
  createSession,
  deleteSession,
  dropUserIndex,
  findSessionByUser,
  isPlayer,
  isTurnDeadlineExpired,
  listSessionsBySelfId,
  loadSession,
  pouchOf,
  releaseTurnLock,
  saveSession,
} from "../lib/witchtrial/SessionStore.js";

/** 配置文件还没生成时的兜底，避免插件静默失效 */
const CONFIG_DEFAULTS = {
  enable: true,
  route: "",
  minPlayers: 2,
  maxPlayers: 6,
  rosterSize: 9,
  maxChapters: 3,
  investigateRounds: 3,
  trialRounds: 5,
  turnTimeoutMinutes: 15,
  playerCulpritChance: 50,
  suicideChance: 15,
  onlyWhiteCreate: false,
};

export class WitchTrial extends plugin {
  constructor() {
    super({
      name: "魔女审判",
      event: "message",
      priority: 1130,
      configWatch: "witchtrial",
    });
  }

  get config() {
    return { ...CONFIG_DEFAULTS, ...(Setting.getConfig("witchtrial") || {}) };
  }

  /** 审判路由没单独配就跟着 AI 的通用路由走 */
  getRoute() {
    return this.config.route || Setting.getConfig("AI")?.appsRoute || "";
  }

  /** Redis 里的毫秒值只在创建房间时固化；开局中途改配置不会偷改当前玩家的截止时间 */
  configuredTurnTimeoutMs() {
    const minutes = Number(this.config.turnTimeoutMinutes);
    return (Number.isFinite(minutes) ? Math.max(3, Math.min(120, minutes)) : 15) * 60_000;
  }

  /**
   * 本局要配几位 NPC 少女
   *
   * 人多时自动少配：一屋子十几个角色，AI 每轮都要顾到，庭审会糊掉。
   * 但有个硬下限——**NPC 不会降到 0**。「死者永远是 NPC」是承重规则，
   * NPC 一旦耗尽，玩家就会因为开局掷骰而出局，而不是因为输掉审判。
   * 下限取 maxChapters + 1：每章至少吃掉一个死者，再留一个当缓冲。
   */
  npcCountFor(playerCount) {
    const floor = this.config.maxChapters + 1;
    const wanted = this.config.rosterSize - playerCount;
    return Math.max(floor, Math.min(wanted, 12));
  }

  getGroupId(e) {
    if (e.message_type !== "group") return null;
    const groupId = Number(e.group_id);
    return Number.isFinite(groupId) ? groupId : null;
  }

  async getGroupSession(e) {
    const groupId = this.getGroupId(e);
    if (!groupId) return null;
    return loadSession(e.self_id, groupId);
  }

  /**
   * 群里和私聊都能用的指令：群内取本群的局，私聊按玩家反查
   * 这个游戏绝大多数动作都走私聊，反查是主路径不是备用路径
   */
  async resolveSession(e) {
    const groupId = this.getGroupId(e);
    if (groupId) {
      const session = await loadSession(e.self_id, groupId);
      return session ? { session, inGroup: true } : null;
    }
    const session = await findSessionByUser(e.self_id, e.user_id);
    return session ? { session, inGroup: false } : null;
  }

  /** 无论指令从哪来，播报一律发回开局的那个群 */
  async announce(e, session, message) {
    const groupId = Number(session.groupId) || session.groupId;
    try {
      return await e.bot.sendGroupMsg(groupId, message);
    } catch (error) {
      logger.error(`[魔女审判] 向群 ${groupId} 播报失败：${error.message}`);
      return null;
    }
  }

  async sendPrivate(e, userId, message) {
    return e.bot.sendPrivateMsg(userId, message);
  }

  async sendPrivateForward(e, userId, segments, info = {}) {
    const nodes = buildNodes(segments, { selfId: e.self_id, nickname: info.nickname || "典狱长" });
    if (!nodes.length) return null;
    return e.bot.sendForwardMsg({
      messages: nodes,
      user_id: userId,
      prompt: info.prompt,
      summary: info.summary,
      source: info.source,
    });
  }

  /**
   * 定时推进没有真实消息事件，补一个只含审判引擎所需字段的事件。
   * AI 路由只读取 self_id，群播报只读取 bot/group_id。
   */
  scheduledEvent(session) {
    const selfId = Number(session.selfId) || session.selfId;
    const groupId = Number(session.groupId) || session.groupId;
    const bot = this.getBot(selfId);
    if (!bot) return null;

    return {
      bot,
      self_id: selfId,
      group_id: groupId,
      user_id: Number(session.hostId) || session.hostId,
      message_type: "group",
      sender: null,
      isAdmin: false,
      isMaster: false,
      reply: (message) => bot.sendGroupMsg(groupId, message),
    };
  }

  /** 当前阶段是否需要回合截止时间 */
  hasTimedTurn(session) {
    return [PHASES.INVESTIGATE, PHASES.TRIAL, PHASES.VOTING].includes(session?.phase);
  }

  /**
   * 锁内处理一个已经截止（或管理员要求立即处理）的回合。
   * 先把截止时间顺延再调 AI：若供应商临时失败，定时器不会下一分钟就重复烧请求。
   */
  async resolveTimedTurnUnderLock(e, session, lockToken, { reason = "deadline" } = {}) {
    if (!this.hasTimedTurn(session)) return false;

    armTurnDeadline(session);
    await saveSession(session);

    const phaseLabel =
      session.phase === PHASES.VOTING
        ? "投票"
        : session.phase === PHASES.INVESTIGATE
          ? "调查"
          : "庭审";
    await this.announce(
      e,
      session,
      reason === "admin"
        ? `⚠ 管理员紧急结算本轮${phaseLabel}。未提交者按放弃本轮处理。`
        : `⏰ 本轮${phaseLabel}已到截止时间。未提交者按放弃本轮处理。`
    );

    if (session.phase === PHASES.VOTING) {
      await this.finishChapter(e, session, session.votes || {}, lockToken);
    } else {
      await this.resolveTurn(e, session, lockToken);
    }
    return true;
  }

  /** 自动推进或房主在截止后推进；会在锁内重新读取，避免拿旧快照结算 */
  async advanceExpiredTurn(e, session, { allowEarly = false, reason = "deadline" } = {}) {
    const lockRef = session;
    const lockToken = await acquireTurnLock(lockRef);
    if (!lockToken) return false;

    try {
      const current = await loadSession(session.selfId, session.groupId);
      if (!current || !this.hasTimedTurn(current)) return false;

      // 旧会话第一次被扫描时只补时钟，不把它当成已经超时。
      if (!current.turnDeadlineAt) {
        armTurnDeadline(current);
        await saveSession(current);
        return false;
      }
      if (!allowEarly && !isTurnDeadlineExpired(current)) return false;

      return this.resolveTimedTurnUnderLock(e, current, lockToken, { reason });
    } finally {
      await releaseTurnLock(lockRef, lockToken);
    }
  }

  /**
   * 每分钟扫一次到期局。截止时间在 Redis 会话里，因此重启后仍然有效；
   * 多进程同时扫到也只会有一个拿到分布式锁。
   */
  deadlineSweep = Cron("* * * * *", async () => {
    if (!this.config.enable) return;
    const selfId = getCurrentBotSelfId();
    if (selfId == null) return;

    let sessions;
    try {
      sessions = await listSessionsBySelfId(selfId);
    } catch (error) {
      logger.warn(`[魔女审判] 扫描回合截止时间失败：${error.message}`);
      return;
    }

    for (const session of sessions) {
      if (!this.hasTimedTurn(session)) continue;
      const e = this.scheduledEvent(session);
      if (!e) continue;

      try {
        await this.advanceExpiredTurn(e, session);
      } catch (error) {
        logger.error(
          `[魔女审判] 群 ${session.groupId} 自动推进失败：${error.stack || error}`
        );
      }
    }
  });

  // ===== 查找工具 =====

  /** 先认囚犯编号，再按名字模糊匹配。编号是精确的，优先级更高 */
  findGirl(session, text) {
    const name = safeString(text, 20);
    if (!name) return null;

    const byCode = girlByCode(session, name);
    if (byCode) return byCode;

    const all = Object.values(session.girls);
    return (
      all.find((girl) => girl.name === name) ||
      all.find((girl) => girl.name.includes(name) || name.includes(girl.name)) ||
      null
    );
  }

  /** 先认地点代号 A/B/C，再按名字模糊匹配 */
  findLocation(session, text) {
    const name = safeString(text, 20);
    if (!name) return null;

    const byCode = locationByCode(session, name);
    if (byCode) return byCode;

    const all = session.prison?.locations || [];
    return (
      all.find((item) => item.name === name) ||
      all.find((item) => item.name.includes(name) || name.includes(item.name)) ||
      null
    );
  }

  /** 取指令发起人在本局的少女，附带一堆前置校验 */
  async requireGirl(e, phases) {
    if (!this.config.enable) return null;
    const resolved = await this.resolveSession(e);
    if (!resolved) return null;

    const { session, inGroup } = resolved;
    if (phases && !phases.includes(session.phase)) return null;
    if (!isPlayer(session, e.user_id)) return null;

    const girl = girlOfUser(session, e.user_id);
    if (!girl) return null;

    return { session, inGroup, girl };
  }

  // ===== 开局 =====

  createGame = Command(/^#创建审判(?:\s+(.+))?$/, async (e) => {
    if (!this.config.enable) return false;
    const groupId = this.getGroupId(e);
    if (!groupId) {
      await e.reply("审判要在群里开局哦。");
      return true;
    }
    if (this.config.onlyWhiteCreate && !(e.isWhite || e.isAdmin)) {
      await e.reply("只有白名单用户或管理员可以开局。");
      return true;
    }

    const lockRef = { selfId: String(e.self_id), groupId: String(groupId) };
    const lockToken = await acquireTurnLock(lockRef);
    if (!lockToken) {
      await e.reply("本群的审判状态正在变更，稍后再试。");
      return true;
    }

    let createdSession = null;
    let ownershipConfirmed = false;
    try {
      const existing = await loadSession(e.self_id, groupId);
      if (existing && existing.phase !== PHASES.ENDED) {
        await e.reply("本群已经有一局在跑了，先【#结束审判】再开新的。");
        return true;
      }
      if (existing) await deleteSession(existing);

      const theme = safeString(e.match?.[1], 60);
      const session = createSession({
        selfId: e.self_id,
        groupId,
        hostId: e.user_id,
        hostNickname: e.sender?.card || e.sender?.nickname || e.nickname,
        theme,
        maxPlayers: this.config.maxPlayers,
        maxChapters: this.config.maxChapters,
        investigateRounds: this.config.investigateRounds,
        trialRounds: this.config.trialRounds,
        turnTimeoutMs: this.configuredTurnTimeoutMs(),
        routeId: this.getRoute(),
      });
      createdSession = session;
      await saveSession(session);

      const ownership = await claimUserIndex(e.self_id, e.user_id, groupId);
      if (!ownership.ok) {
        await e.reply("你已经在另一个群的审判中，不能同时创建或加入第二局。");
        return true;
      }
      ownershipConfirmed = true;

      await e.reply(
        `魔女审判已开局，房主是你。\n题材：${theme || "由 AI 自选"}\n\n其他人发【#加入审判】上车，满 ${this.config.minPlayers} 人后房主发【#开始审判】。\n上限 ${this.config.maxPlayers} 人。\n\n牢狱里总共关 ${this.config.rosterSize} 人左右，玩家之外由 NPC 少女补齐——\n人少时 NPC 多，人多时 NPC 少，但永远不会没有：死者只会从 NPC 里出。`
      );
      return true;
    } finally {
      try {
        if (createdSession && !ownershipConfirmed) {
          await deleteSession(createdSession);
        }
      } finally {
        await releaseTurnLock(lockRef, lockToken);
      }
    }
  });

  joinGame = Command(/^#加入审判$/, async (e) => {
    if (!this.config.enable) return false;
    const groupId = this.getGroupId(e);
    if (!groupId) return false;
    const lockRef = { selfId: String(e.self_id), groupId: String(groupId) };
    const lockToken = await acquireTurnLock(lockRef);
    if (!lockToken) {
      await e.reply("本群的审判状态正在变更，稍后再试。");
      return true;
    }

    let joinedSession = null;
    let ownershipConfirmed = false;
    try {
      const session = await loadSession(e.self_id, groupId);
      if (!session) return false;
      if (session.phase !== PHASES.RECRUITING) {
        await e.reply("这局已经开庭了，中途不能加入。");
        return true;
      }
      if (isPlayer(session, e.user_id)) {
        await e.reply("你已经在这局里了。");
        return true;
      }
      if (session.players.length >= session.maxPlayers) {
        await e.reply(`人满了（${session.maxPlayers} 人）。`);
        return true;
      }

      session.players.push({
        userId: String(e.user_id),
        nickname: e.sender?.card || e.sender?.nickname || e.nickname || String(e.user_id),
      });
      joinedSession = session;
      await saveSession(session);

      const ownership = await claimUserIndex(e.self_id, e.user_id, groupId);
      if (!ownership.ok) {
        await e.reply("你已经在另一个群的审判中，不能同时加入第二局。");
        return true;
      }
      ownershipConfirmed = true;

      await e.reply(`已加入，当前 ${session.players.length}/${session.maxPlayers} 人。`);
      return true;
    } finally {
      try {
        if (joinedSession && !ownershipConfirmed) {
          joinedSession.players = joinedSession.players.filter(
            (player) => player.userId !== String(e.user_id)
          );
          await saveSession(joinedSession);
          await dropUserIndex(e.self_id, e.user_id, groupId);
        }
      } finally {
        await releaseTurnLock(lockRef, lockToken);
      }
    }
  });

  leaveGame = Command(/^#退出审判$/, async (e) => {
    if (!this.config.enable) return false;
    const groupId = this.getGroupId(e);
    if (!groupId) return false;
    const lockRef = { selfId: String(e.self_id), groupId: String(groupId) };
    const lockToken = await acquireTurnLock(lockRef);
    if (!lockToken) {
      await e.reply("本群的审判状态正在变更，稍后再试。");
      return true;
    }

    try {
      const session = await loadSession(e.self_id, groupId);
      if (!session || !isPlayer(session, e.user_id)) return false;
      if (session.phase !== PHASES.RECRUITING) {
        await e.reply("开局后不能中途退出，以免案件引用和投票失效；请让房主或管理员结束本局。");
        return true;
      }

      session.players = session.players.filter(
        (player) => player.userId !== String(e.user_id)
      );
      delete session.girls[toPlayerId(e.user_id)];
      delete session.pendingActions[toPlayerId(e.user_id)];
      await dropUserIndex(e.self_id, e.user_id, groupId);

      if (!session.players.length) {
        await deleteSession(session);
        await e.reply("最后一个人也走了，本局解散。");
        return true;
      }

      if (session.hostId === String(e.user_id)) {
        session.hostId = session.players[0].userId;
        await saveSession(session);
        await e.reply(`你已退出，房主移交给 ${session.players[0].nickname}。`);
        return true;
      }

      await saveSession(session);
      await e.reply(`你已退出，当前 ${session.players.length} 人。`);
      return true;
    } finally {
      await releaseTurnLock(lockRef, lockToken);
    }
  });

  // 开局是最烧钱的动作（出牢狱 + 出全体少女 + 出第一章案件），扣费挂在这里
  startGame = Command(
    /^#开始审判$/,
    { economy: { command: "开始审判", refundOnFalse: true } },
    async (e) => {
      if (!this.config.enable) return false;
      let session = await this.getGroupSession(e);
      if (!session) return false;

      const lockRef = session;
      const lockToken = await acquireTurnLock(lockRef);
      if (!lockToken) {
        await e.reply("本群的审判状态正在变更，稍后再试。");
        return { handled: true, refund: true };
      }
      try {
        session = await loadSession(session.selfId, session.groupId);
        if (!session) return { handled: true, refund: true };
        if (session.hostId !== String(e.user_id) && !e.isAdmin) {
          await e.reply("只有房主能开局。");
          return true;
        }
        if (session.phase !== PHASES.RECRUITING) {
          await e.reply("这局已经开始了。");
          return true;
        }
        if (session.players.length < this.config.minPlayers) {
          await e.reply(
            `至少要 ${this.config.minPlayers} 人才能开庭，现在只有 ${session.players.length} 人。`
          );
          return true;
        }

        // 先占位再生成，防止生成期间被重复触发或结束后被旧任务复活
        session.phase = PHASES.GENERATING;
        session.advancePending = false;
        clearTurnDeadline(session);
        await saveSession(session);

        await e.reply("典狱长正在挑选囚犯与牢房，大概要一两分钟…");

        try {
          const route = session.routeId || this.getRoute();
          const { prison, girls } = await generateSetup({
            e,
            route,
            players: session.players,
            npcCount: this.npcCountFor(session.players.length),
            theme: session.theme,
            onProgress: (text) => e.reply(text).catch(() => {}),
          });

          session.prison = prison;
          session.girls = girls;
          await saveSession(session);

          // 私聊发少女卡，发不出去的（多半没加好友）在群里点名
          const failed = [];
          for (const player of session.players) {
            const girl = session.girls[toPlayerId(player.userId)];
            if (!girl) continue;
            try {
              await this.sendPrivateForward(e, player.userId, [renderGirlCard(girl)], {
                prompt: `${girl.name} 的少女卡`,
                source: "少女卡",
                summary: girl.ability.name,
              });
            } catch (error) {
              logger.warn(`[魔女审判] 给 ${player.userId} 私聊发卡失败：${error.message}`);
              failed.push(girl);
            }
          }

          await e.sendForwardMsg(renderPrisonIntro(prison), {
            prompt: `《${prison.name}》`,
            source: prison.name,
            summary: `${Object.keys(girls).length} 位少女`,
          });

          if (failed.length) {
            // 只 @ 人，绝不带上她分到的少女名——那等于当众公布 QQ 到囚犯的映射
            await e.reply([
              "以下几位私聊发卡失败，请先加机器人好友，然后私聊发【#我的少女】补发：\n",
              ...failed.map((girl) => segment.at(girl.userId)),
            ]);
          }

          await e.reply("案件正在发生…");
          await this.openChapter(e, session);
        } catch (error) {
          logger.error(`[魔女审判] 群 ${session.groupId} 开局失败：${error.stack || error}`);
          session.phase = PHASES.RECRUITING;
          session.advancePending = false;
          session.prison = null;
          session.girls = {};
          session.caseFile = null;
          clearTurnDeadline(session);
          await saveSession(session);
          await e.reply(`开局失败：${error.message}\n已退回招募状态，可以再试一次【#开始审判】。`);
          return { handled: true, refund: true };
        }

        return true;
      } finally {
        await releaseTurnLock(lockRef, lockToken);
      }
    }
  );

  /** 开一章：生成案件、私聊通知凶手、群里公告案发 */
  async openChapter(e, session) {
    const route = session.routeId || this.getRoute();

    const { victim } = await startChapter({
      e,
      route,
      session,
      playerCulpritChance: this.config.playerCulpritChance / 100,
      suicideChance: this.config.suicideChance / 100,
      onProgress: (text) => this.announce(e, session, text).catch(() => {}),
    });
    armTurnDeadline(session);
    await saveSession(session);

    // 每位在场玩家都收到一条私聊。凶手拿到真相，其余人拿到一句无事发生——
    // 两条消息长度不同，但没人看得见别人收到了什么。
    const failed = [];
    for (const girl of livingPlayers(session)) {
      const isCulprit = girl.id === session.caseFile.culpritId;
      try {
        const roleNotice = isCulprit
          ? renderCulpritNotice(session, session.caseFile, victim)
          : renderInnocentNotice();
        await this.sendPrivate(
          e,
          girl.userId,
          `${roleNotice}\n\n${renderInvestigationLeads(session, girl)}`
        );
      } catch (error) {
        logger.warn(`[魔女审判] 给 ${girl.userId} 发本章通知失败：${error.message}`);
        failed.push(girl);
      }
    }

    await this.announce(e, session, renderIncident(session, session.caseFile, victim));
    if (failed.length) {
      await this.announce(e, session, [
        "以下几位没有收到本章私聊，请加机器人好友后私聊发送【#本章身份】补领：\n",
        ...failed.map((girl) => segment.at(girl.userId)),
      ]);
    }
  }

  // ===== 调查阶段 =====

  investigate = Command(/^#调查\s*(.+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.INVESTIGATE]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) {
      await e.reply("你已经不在场上了，只能围观。");
      return true;
    }

    const location = this.findLocation(session, e.match?.[1]);
    if (!location) {
      await e.reply(
        `没有这个地方。可以去：\n${session.prison.locations.map((item) => `${item.code}. ${item.name}`).join("\n")}`
      );
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "search",
      locationId: location.id,
      label: `搜查「${location.name}」`,
    });
  });

  ask = Command(/^#询问\s*(\S+)\s*(.*)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.INVESTIGATE]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;

    const target = this.findGirl(session, e.match?.[1]);
    if (!target) {
      await e.reply("没有这个人。");
      return true;
    }
    if (!target.alive) {
      await e.reply(`${target.name} 已经不在了，问不出什么。`);
      return true;
    }
    if (target.id === girl.id) {
      await e.reply("自己问自己？");
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "ask",
      targetId: target.id,
      question: safeString(e.match?.[2], 60) || "案发那晚的事",
      label: `询问 ${target.name}`,
    });
  });

  destroy = Command(/^#湮灭\s*(.+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.INVESTIGATE]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;

    if (girl.id !== session.caseFile?.culpritId) {
      // 不是凶手的人用这条指令，不能给任何反馈——否则就成了排除法的探针
      return false;
    }

    const location = this.findLocation(session, e.match?.[1]);
    if (!location) {
      await e.reply("没有这个地方。");
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "destroy",
      locationId: location.id,
      label: `在「${location.name}」抹掉痕迹`,
    });
  });

  // ===== 庭审阶段 =====

  claim = Command(/^#主张\s*(\d+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.TRIAL]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;

    const prop = session.caseFile.propositions[Number(e.match[1]) - 1];
    if (!prop) {
      await e.reply("没有这个编号的命题，发【#命题】看清单。");
      return true;
    }
    if (!prop.conclusion) {
      await e.reply("主张必须选择标有【指认】【自杀】或【意外】的结论。");
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "claim",
      propId: prop.id,
      label: `主张「${prop.text}」`,
    });
  });

  // 出牌必须声明方向。不用声明就能公开证据的话，出牌就没有风险了——
  // 玩家只看得见证物的名字和描述，往哪打全靠推，打空要反噬。
  playEvidence = Command(/^#出示\s*(\d+)\s*(支持|反驳|驳)\s*(\d+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.TRIAL]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;

    const bag = pouchOf(session, girl.id);
    const evidenceId = bag[Number(e.match[1]) - 1];
    if (!evidenceId) {
      await e.reply("你证物袋里没有这个编号，发【#证物袋】看看手里有什么。");
      return true;
    }
    if (
      session.publicEvidence.includes(evidenceId) ||
      session.destroyedEvidence.includes(evidenceId)
    ) {
      await e.reply("这条证据已经公开或被销毁，不能重复出示。");
      return true;
    }
    const prop = session.caseFile.propositions[Number(e.match[3]) - 1];
    if (!prop) {
      await e.reply("没有这个编号的命题，发【#命题】看清单。");
      return true;
    }

    const stance = e.match[2] === "支持" ? STANCE.SUPPORT : STANCE.REFUTE;
    return this.submitAction(e, session, girl, {
      kind: "play",
      stance,
      evidenceId,
      propId: prop.id,
      label: `出示证据${stance === STANCE.SUPPORT ? "支持" : "反驳"}命题`,
    });
  });

  challengeFake = Command(/^#揭穿\s*(\d+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.TRIAL]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;

    const bag = pouchOf(session, girl.id);
    const evidenceId = bag[Number(e.match[1]) - 1];
    if (!evidenceId) {
      await e.reply("你证物袋里没有这个编号，发【#证物袋】核对。");
      return true;
    }
    if (
      session.publicEvidence.includes(evidenceId) ||
      session.destroyedEvidence.includes(evidenceId)
    ) {
      await e.reply("这条证据已经公开或被销毁，不能再拿来揭穿。");
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "challenge",
      evidenceId,
      label: "尝试揭穿台面上的伪证",
    });
  });

  question = Command(/^#追问\s*(\S+)\s*(.*)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.TRIAL]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;

    const target = this.findGirl(session, e.match?.[1]);
    if (!target?.alive) {
      await e.reply("没有这个人，或者她已经不在了。");
      return true;
    }
    if (target.id === girl.id) {
      await e.reply("不能在庭上追问自己。");
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "question",
      targetId: target.id,
      topic: safeString(e.match?.[2], 60) || "案发那晚你在哪",
      label: `追问 ${target.name}`,
    });
  });

  // 回应必须押一个命题当辩解。光说漂亮话不算数——你得指出你的说法
  // 靠台面上的哪一条撑着，而那一条随即变成别人可以攻击的靶子。
  answer = Command(/^#回应\s*(\d+)\s*([\s\S]+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.TRIAL]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;

    const prop = session.caseFile.propositions[Number(e.match[1]) - 1];
    if (!prop) {
      await e.reply("没有这个编号的命题。发【#命题】看清单。");
      return true;
    }
    if (!prop.conclusion) {
      await e.reply(
        "回应必须押一个**结论**——就是那些标着【指认】【自杀】【意外】的。\n" +
          "被追问了，你得当众说出你认为她是怎么死的，不能拿一句无关痛痒的事实搪塞。\n" +
          "发【#命题】看哪几条是结论。"
      );
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "answer",
      propId: prop.id,
      text: safeString(e.match?.[2], 120),
      label: `押「${prop.text}」表态`,
    });
  });

  fake = Command(/^#伪证\s*(\d+)\s*([\s\S]+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.TRIAL]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;
    if (girl.id !== session.caseFile?.culpritId) return false;
    if (session.fakeUsed) {
      await e.reply("本章的伪证机会已经用掉了。");
      return true;
    }
    if (session.round >= session.trialRounds - 1) {
      await e.reply("最后一轮不能再造伪证——对方必须至少有下一轮可以反制。");
      return true;
    }

    const prop = session.caseFile.propositions[Number(e.match[1]) - 1];
    if (!prop) {
      await e.reply("没有这个编号的命题。");
      return true;
    }
    if (!prop.conclusion) {
      await e.reply("伪证只能用来否定一个【指认】【自杀】或【意外】结论。");
      return true;
    }
    const text = safeString(e.match?.[2], 200);
    if (text.replace(/\s/g, "").length < 12) {
      await e.reply("说辞太短，至少写 12 个有效字符，让它成为一条可以被核验的具体陈述。");
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "fake",
      propId: prop.id,
      text,
      label: "抛出一条说辞",
    });
  });

  // ===== 提交与结算 =====

  /**
   * 记下一个动作，全员交完就自动结算
   * 群里提交只播报「谁交了」，不播报交了什么——这个游戏的信息不对称是核心
   */
  async submitAction(e, session, girl, action) {
    const lockToken = await acquireTurnLock(session);
    if (!lockToken) {
      await e.reply("本局正在推演或保存，请稍后重新提交。");
      return true;
    }

    try {
      const current = await loadSession(session.selfId, session.groupId);
      if (!current || ![PHASES.INVESTIGATE, PHASES.TRIAL].includes(current.phase)) {
        await e.reply("阶段已经变化，这条行动没有提交。");
        return true;
      }
      if (isTurnDeadlineExpired(current)) {
        await e.reply("这轮已经截止，这条行动没有计入。");
        await this.resolveTimedTurnUnderLock(e, current, lockToken);
        return true;
      }
      const currentGirl = girlOfUser(current, e.user_id);
      if (!currentGirl?.alive) return true;

      const living = livingPlayers(current);
      const livingIds = new Set(living.map((item) => item.id));
      current.pendingActions = Object.fromEntries(
        Object.entries(current.pendingActions || {}).filter(([id]) => livingIds.has(id))
      );
      current.pendingActions[currentGirl.id] = action;
      await saveSession(current);

      const need = living.length;
      const done = Object.keys(current.pendingActions).length;
      const inGroup = this.getGroupId(e) !== null;
      if (inGroup) {
        await e.reply(`已提交（${done}/${need}）。下次私聊我——在群里发，谁都知道那是你。`, 0, true);
      } else {
        await e.reply(`已记下：${action.label}（${done}/${need}）`);
        await this.announce(e, current, `🤫 有人提交了行动（${done}/${need}）。`);
      }

      if (done >= need) await this.resolveTurn(e, current, lockToken);
      return true;
    } finally {
      await releaseTurnLock(session, lockToken);
    }
  }

  forceTurn = Command(/^#推进$/, async (e) => {
    if (!this.config.enable) return false;
    const session = await this.getGroupSession(e);
    if (!session) return false;
    const privileged = Boolean(e.isAdmin || e.isMaster);
    if (session.hostId !== String(e.user_id) && !privileged) {
      await e.reply("只有房主、管理员或主人能推进。");
      return true;
    }

    if (this.hasTimedTurn(session)) {
      if (!session.turnDeadlineAt) {
        const lockToken = await acquireTurnLock(session);
        if (!lockToken) {
          await e.reply("本局正在保存，请稍后再试。");
          return true;
        }
        try {
          const current = await loadSession(session.selfId, session.groupId);
          if (current && this.hasTimedTurn(current) && !current.turnDeadlineAt) {
            armTurnDeadline(current);
            await saveSession(current);
          }
        } finally {
          await releaseTurnLock(session, lockToken);
        }
        await e.reply("已为本回合补上截止时间，届时会自动推进。");
        return true;
      }

      if (!privileged && !isTurnDeadlineExpired(session)) {
        const remaining = renderTurnDeadline(session);
        await e.reply(
          `截止前不能提前结算，避免房主截断其他人的推理或投票。\n${remaining}\n全员提前提交仍会立即结算。`
        );
        return true;
      }

      const advanced = await this.advanceExpiredTurn(e, session, {
        allowEarly: privileged,
        reason: privileged && !isTurnDeadlineExpired(session) ? "admin" : "deadline",
      });
      if (!advanced) await e.reply("本局正在结算，或阶段刚刚发生了变化。");
      return true;
    }
    if (session.phase === PHASES.GENERATING && session.advancePending) {
      await this.resumePendingChapter(e, session);
      return true;
    }

    return false;
  });

  /**
   * 把这一轮的搜查结果私聊发给各人
   * 群里只公布谁去了哪，搜到什么必须单独告诉当事人——否则玩家做完动作
   * 根本不知道自己拿到了什么。NPC 不需要收。
   */
  async sendFindings(e, session, results) {
    for (const item of results) {
      const girl = session.girls[item.actorId];
      if (girl?.kind !== "player" || !girl.userId) continue;
      try {
        await this.sendPrivate(e, girl.userId, renderFinding(session, item));
      } catch (error) {
        logger.warn(`[魔女审判] 给 ${girl.userId} 发调查回执失败：${error.message}`);
      }
    }
  }

  /** 结算一个回合，并处理阶段切换 */
  async resolveTurn(e, session, existingLockToken = null) {
    const lockRef = session;
    const lockToken = existingLockToken || await acquireTurnLock(lockRef);
    if (!lockToken) {
      await this.announce(e, session, "上一个回合还在推演，稍等一下。");
      return;
    }
    const releaseHere = !existingLockToken;

    try {
      session = await loadSession(session.selfId, session.groupId);
      if (!session || ![PHASES.INVESTIGATE, PHASES.TRIAL].includes(session.phase)) return;
      const route = session.routeId || this.getRoute();
      const actions = Object.entries(session.pendingActions).map(([girlId, action]) => ({
        girlId,
        ...action,
      }));

      if (session.phase === PHASES.INVESTIGATE) {
        await this.announce(e, session, "🔍 正在推演…");
        const result = await resolveInvestigateTurn({ e, route, session, actions });

        if (result.phaseDone) {
          session.phase = PHASES.TRIAL;
          session.round = 0;
          recomputeSuspicion(session);
        }
        armTurnDeadline(session);
        await saveSession(session);
        await this.announce(e, session, renderInvestigateTurn(session, result));
        await this.sendFindings(e, session, result.results);

        if (result.phaseDone) {
          await this.announce(
            e,
            session,
            renderTrialOpening(session, session.caseFile.propositions)
          );
        }
        return;
      }

      if (session.phase === PHASES.TRIAL) {
        await this.announce(e, session, "⚖ 法庭正在推演…");
        const result = await resolveTrialTurn({ e, route, session, actions });
        if (result.phaseDone) {
          session.phase = PHASES.VOTING;
          session.votes = {};
        }
        armTurnDeadline(session);
        await saveSession(session);
        await this.announce(e, session, renderTrialTurn(session, result));

        // 被追问的玩家私聊提醒一下，免得漏看群消息白挨 12 点
        for (const move of result.moves) {
          if (move.kind !== "question") continue;
          const target = session.girls[move.targetId];
          if (target?.kind !== "player" || !target.alive) continue;
          try {
            await this.sendPrivate(
              e,
              target.userId,
              `━━━ 你被追问了 ━━━\n\n${move.actorName} 当庭问你：${move.topic}\n\n下一轮你必须押一个**结论**表态：\n  #回应 <命题编号> <说辞>\n\n不表态就是 +12。但押上去的结论会变成靶子——\n除了真相之外，每一个结论都有证据能把它打穿。`
            );
          } catch (error) {
            logger.warn(`[魔女审判] 给 ${target.userId} 发追问提醒失败：${error.message}`);
          }
        }

        if (result.phaseDone) {
          if (result.truthEstablished) {
            // 真相是吸收态，证成即定案，不必投票
            await this.finishChapter(e, session, {}, lockToken);
          } else {
            await this.announce(
              e,
              session,
              renderVoteMenu(votableConclusions(session), session)
            );
          }
        }
      }
    } catch (error) {
      logger.error(`[魔女审判] 群 ${session.groupId} 回合结算失败：${error.stack || error}`);
      try {
        const retrySession = await loadSession(session.selfId, session.groupId);
        if (retrySession && this.hasTimedTurn(retrySession)) {
          armTurnDeadline(retrySession);
          await saveSession(retrySession);
          session = retrySession;
        }
      } catch (saveError) {
        logger.warn(`[魔女审判] 群 ${session.groupId} 重设重试时间失败：${saveError.message}`);
      }
      await this.announce(
        e,
        session,
        `本回合推演失败：${error.message}\n提交仍然保留；系统会在新的截止时间重试，管理员也可紧急【#推进】。`
      );
    } finally {
      if (releaseHere) await releaseTurnLock(lockRef, lockToken);
    }
  }

  // ===== 投票 =====

  vote = Command(/^#投票\s*(\d+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.VOTING]);
    if (!ctx) return false;
    const { session } = ctx;
    const lockToken = await acquireTurnLock(session);
    if (!lockToken) {
      await e.reply("正在点票或保存，请稍后再试。");
      return true;
    }

    try {
      const current = await loadSession(session.selfId, session.groupId);
      if (!current || current.phase !== PHASES.VOTING) {
        await e.reply("投票已经结束。");
        return true;
      }
      if (isTurnDeadlineExpired(current)) {
        await e.reply("投票已经截止，这张票没有计入。");
        await this.resolveTimedTurnUnderLock(e, current, lockToken);
        return true;
      }
      const girl = girlOfUser(current, e.user_id);
      if (!girl?.alive) {
        await e.reply("你已经不在场上了，没有投票权。");
        return true;
      }

      const conclusions = votableConclusions(current);
      const picked = conclusions[Number(e.match[1]) - 1];
      if (!picked) {
        await e.reply("没有这个编号，重新看一下投票清单。");
        return true;
      }

      const living = livingPlayers(current);
      const livingIds = new Set(living.map((item) => item.id));
      current.votes = Object.fromEntries(
        Object.entries(current.votes || {}).filter(([id]) => livingIds.has(id))
      );
      current.votes[girl.id] = picked.propId;
      await saveSession(current);

      const need = living.length;
      const done = Object.keys(current.votes).length;
      const progress = renderVoteProgress(current, girl);
      if (this.getGroupId(e) !== null) {
        await e.reply(progress);
      } else {
        await e.reply(`已投「${picked.text}」（${done}/${need}）`);
        await this.announce(e, current, progress);
      }

      if (done >= need) {
        await this.finishChapter(e, current, current.votes, lockToken);
      }
      return true;
    } finally {
      await releaseTurnLock(session, lockToken);
    }
  });

  /** 收场一章：判决、处刑、然后开下一章或收尾 */
  async finishChapter(e, session, playerVotes, existingLockToken = null) {
    const lockRef = session;
    const lockToken = existingLockToken || await acquireTurnLock(lockRef);
    if (!lockToken) return;
    const releaseHere = !existingLockToken;
    let settlementPersisted = false;

    try {
      session = await loadSession(session.selfId, session.groupId);
      if (!session || session.phase !== PHASES.VOTING) return;
      const route = session.routeId || this.getRoute();
      await this.announce(e, session, "📖 猫头鹰正在宣判…");

      const outcome = await resolveVerdict({
        e,
        route,
        session,
        // 锁内重载后的票才是权威值；调用方传入的快照可能在等锁时已经过期。
        playerVotes: session.votes ?? playerVotes ?? {},
      });
      const verdictMessage = renderVerdict(session, outcome);
      session.votes = {};
      session.advancePending = !outcome.over.over;
      session.phase = outcome.over.over ? PHASES.ENDED : PHASES.GENERATING;
      clearTurnDeadline(session);
      await saveSession(session);
      settlementPersisted = true;
      await this.announce(e, session, verdictMessage);

      if (outcome.over.over) {
        await this.announce(
          e,
          session,
          renderFinale(session, outcome.over.reason, buildClosingText(session, outcome.over.reason))
        );
        await deleteSession(session);
        return;
      }

      await this.announce(
        e,
        session,
        `\n夜又来了。\n\n第 ${session.chapter + 1} 章即将开始…`
      );
      await this.openChapter(e, session);
    } catch (error) {
      logger.error(`[魔女审判] 群 ${session.groupId} 收场失败：${error.stack || error}`);
      if (!settlementPersisted) {
        try {
          const retrySession = await loadSession(session.selfId, session.groupId);
          if (retrySession?.phase === PHASES.VOTING) {
            armTurnDeadline(retrySession);
            await saveSession(retrySession);
            session = retrySession;
          }
        } catch (saveError) {
          logger.warn(`[魔女审判] 群 ${session.groupId} 重设宣判时间失败：${saveError.message}`);
        }
      }
      const message = settlementPersisted
        ? session?.advancePending
          ? `下一章生成失败：${error.message}\n上一章已经安全结算，房主可发【#推进】继续生成，不会重复处刑。`
          : `本局结束后的清理失败：${error.message}\n判决与终局状态已经安全落库，不会重复处刑。`
        : `宣判失败：${error.message}\n投票尚未结算；系统会在新的截止时间重试，管理员也可紧急【#推进】。`;
      await this.announce(e, session, message);
    } finally {
      if (releaseHere) await releaseTurnLock(lockRef, lockToken);
    }
  }

  /** 章间生成失败后的幂等续跑，不会重新判决上一章 */
  async resumePendingChapter(e, session) {
    const lockRef = session;
    const lockToken = await acquireTurnLock(lockRef);
    if (!lockToken) {
      await this.announce(e, session, "下一章正在生成，稍等一下。");
      return;
    }

    try {
      session = await loadSession(session.selfId, session.groupId);
      if (!session || session.phase !== PHASES.GENERATING || !session.advancePending) return;
      await this.announce(e, session, `第 ${session.chapter + 1} 章重新生成中…`);
      await this.openChapter(e, session);
    } catch (error) {
      logger.error(`[魔女审判] 群 ${session.groupId} 续章失败：${error.stack || error}`);
      await this.announce(
        e,
        session,
        `下一章生成失败：${error.message}\n状态已保留，稍后仍可发【#推进】重试。`
      );
    } finally {
      await releaseTurnLock(lockRef, lockToken);
    }
  }

  // ===== 查询 =====

  showCard = Command(/^#我的少女$/, async (e) => {
    const ctx = await this.requireGirl(e, null);
    if (!ctx) return false;

    try {
      await this.sendPrivateForward(e, e.user_id, [renderGirlCard(ctx.girl)], {
        prompt: `${ctx.girl.name} 的少女卡`,
        source: "少女卡",
        summary: ctx.girl.ability.name,
      });
      if (ctx.inGroup) await e.reply("已私聊发送。", 0, true);
    } catch (error) {
      logger.warn(`[魔女审判] 补发少女卡给 ${e.user_id} 失败：${error.message}`);
      await e.reply("私聊发不出去，请先加机器人好友再试。", 0, true);
    }
    return true;
  });

  showChapterRole = Command(/^#本章身份$/, async (e) => {
    const ctx = await this.requireGirl(e, null);
    if (!ctx?.session.caseFile) return false;
    const { session, girl } = ctx;
    const victim = session.girls[session.caseFile.victimId];
    if (!victim) return false;

    const text =
      girl.id === session.caseFile.culpritId
        ? renderCulpritNotice(session, session.caseFile, victim)
        : renderInnocentNotice();
    try {
      await this.sendPrivate(
        e,
        e.user_id,
        `${text}\n\n${renderInvestigationLeads(session, girl)}`
      );
      if (ctx.inGroup) await e.reply("本章身份已私聊发送。", 0, true);
    } catch {
      await e.reply("私聊发不出去，请先加机器人好友再试。", 0, true);
    }
    return true;
  });

  showPouch = Command(/^#证物袋$/, async (e) => {
    const ctx = await this.requireGirl(e, null);
    if (!ctx) return false;
    if (!ctx.session.caseFile) return false;

    const text = renderPouch(ctx.session, ctx.girl, pouchDetail(ctx.session, ctx.girl.id));
    try {
      await this.sendPrivate(e, e.user_id, text);
      if (ctx.inGroup) await e.reply("证物袋已私聊发送——别在群里问这个。", 0, true);
    } catch {
      await e.reply("私聊发不出去，请先加机器人好友再试。", 0, true);
    }
    return true;
  });

  // 能力是公开信息，整套推理都靠它——所以图鉴不设权限，群里私聊都能查
  showCodex = Command(/^#图鉴\s*(.*)$/, async (e) => {
    if (!this.config.enable) return false;
    const resolved = await this.resolveSession(e);
    if (!resolved?.session.prison) return false;
    const { session } = resolved;

    const query = safeString(e.match?.[1], 20);
    if (query) {
      const girl = this.findGirl(session, query);
      if (!girl) {
        await e.reply("图鉴里没有这个人。");
        return true;
      }
      await e.reply(renderCodexEntry(session, girl));
      return true;
    }

    await e.sendForwardMsg(renderCodex(session), {
      prompt: "魔女图鉴",
      source: session.prison.name,
      summary: `${Object.keys(session.girls).length} 位少女`,
    });
    return true;
  });

  showProps = Command(/^#命题$/, async (e) => {
    const resolved = await this.resolveSession(e);
    if (!resolved?.session.caseFile) return false;
    await e.reply(renderPropositions(resolved.session));
    return true;
  });

  showRecord = Command(/^#法庭记录$/, async (e) => {
    const resolved = await this.resolveSession(e);
    if (!resolved?.session.caseFile) return false;
    await e.reply(renderCourtRecord(resolved.session));
    return true;
  });

  showStatus = Command(/^#审判状态$/, async (e) => {
    const resolved = await this.resolveSession(e);
    if (!resolved) return false;
    await e.reply(renderStatus(resolved.session));
    return true;
  });

  endGame = Command(/^#结束审判$/, async (e) => {
    if (!this.config.enable) return false;
    let session = await this.getGroupSession(e);
    if (!session) return false;

    const lockRef = session;
    const lockToken = await acquireTurnLock(lockRef);
    if (!lockToken) {
      await e.reply("本局正在生成或结算，请等当前操作完成后再结束。");
      return true;
    }

    try {
      session = await loadSession(session.selfId, session.groupId);
      if (!session) return true;
      if (session.hostId !== String(e.user_id) && !e.isAdmin) {
        await e.reply("只有房主或管理员能结束本局。");
        return true;
      }

      await deleteSession(session);
      await e.reply(
        session.prison
          ? `《${session.prison.name}》在第 ${session.chapter} 章被中止。`
          : "本局已解散。"
      );
      return true;
    } finally {
      await releaseTurnLock(lockRef, lockToken);
    }
  });

  help = Command(/^#审判帮助$/, async (e) => {
    if (!this.config.enable) return false;
    await e.reply(HELP_TEXT);
    return true;
  });
}
