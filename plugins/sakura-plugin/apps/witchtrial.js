import Setting from "../lib/setting.js";
import { generateSetup } from "../lib/witchtrial/CaseGenerator.js";
import {
  pouchDetail,
  resolveInvestigateTurn,
  resolveTrialTurn,
  resolveVerdict,
  startChapter,
  votableConclusions,
} from "../lib/witchtrial/TrialEngine.js";
import { recomputeSuspicion } from "../lib/witchtrial/logic.js";
import { buildClosingText } from "../lib/witchtrial/prompts.js";
import {
  HELP_TEXT,
  buildNodes,
  renderCourtRecord,
  renderCulpritNotice,
  renderFinale,
  renderGirlCard,
  renderIncident,
  renderInnocentNotice,
  renderInvestigateTurn,
  renderPouch,
  renderPropositions,
  renderPrisonIntro,
  renderStatus,
  renderTrialOpening,
  renderTrialTurn,
  renderVerdict,
  renderVoteMenu,
} from "../lib/witchtrial/render.js";
import { girlOfUser, livingPlayers, safeString, toPlayerId } from "../lib/witchtrial/schema.js";
import {
  PHASES,
  acquireTurnLock,
  createSession,
  deleteSession,
  dropUserIndex,
  findSessionByUser,
  isPlayer,
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
  npcCount: 6,
  maxChapters: 3,
  investigateRounds: 3,
  trialRounds: 5,
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

  // ===== 查找工具 =====

  /** 按名字模糊找少女，找不到返回 null */
  findGirl(session, text) {
    const name = safeString(text, 20);
    if (!name) return null;
    const all = Object.values(session.girls);
    return (
      all.find((girl) => girl.name === name) ||
      all.find((girl) => girl.name.includes(name) || name.includes(girl.name)) ||
      null
    );
  }

  findLocation(session, text) {
    const name = safeString(text, 20);
    if (!name) return null;
    const all = session.prison?.locations || [];
    return (
      all.find((item) => item.name === name) ||
      all.find((item) => item.name.includes(name) || name.includes(item.name)) ||
      null
    );
  }

  /** 取指令发起人在本局的少女，附带一堆前置校验 */
  async requireGirl(e, phases) {
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

    const existing = await this.getGroupSession(e);
    if (existing && existing.phase !== PHASES.ENDED) {
      await e.reply("本群已经有一局在跑了，先【#结束审判】再开新的。");
      return true;
    }

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
      routeId: this.getRoute(),
    });
    await saveSession(session);

    await e.reply(
      `魔女审判已开局，房主是你。\n题材：${theme || "由 AI 自选"}\n\n其他人发【#加入审判】上车，满 ${this.config.minPlayers} 人后房主发【#开始审判】。\n上限 ${this.config.maxPlayers} 人，另有 ${this.config.npcCount} 位 NPC 少女陪你们一起被关进去。`
    );
    return true;
  });

  joinGame = Command(/^#加入审判$/, async (e) => {
    if (!this.config.enable) return false;
    const session = await this.getGroupSession(e);
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
    await saveSession(session);

    await e.reply(`已加入，当前 ${session.players.length}/${session.maxPlayers} 人。`);
    return true;
  });

  leaveGame = Command(/^#退出审判$/, async (e) => {
    if (!this.config.enable) return false;
    const session = await this.getGroupSession(e);
    if (!session) return false;
    if (!isPlayer(session, e.user_id)) return false;

    if (session.phase === PHASES.GENERATING) {
      await e.reply("正在生成牢狱，等开局后再退。");
      return true;
    }

    session.players = session.players.filter((player) => player.userId !== String(e.user_id));
    delete session.girls[toPlayerId(e.user_id)];
    delete session.pendingActions[toPlayerId(e.user_id)];
    await dropUserIndex(e.self_id, e.user_id);

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
  });

  // 开局是最烧钱的动作（出牢狱 + 出全体少女 + 出第一章案件），扣费挂在这里
  startGame = Command(
    /^#开始审判$/,
    { economy: { command: "开始审判", refundOnFalse: true } },
    async (e) => {
      if (!this.config.enable) return false;
      const session = await this.getGroupSession(e);
      if (!session) return false;

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

      // 先占位再生成，防止生成期间被重复触发
      session.phase = PHASES.GENERATING;
      await saveSession(session);

      await e.reply("典狱长正在挑选囚犯与牢房，大概要一两分钟…");

      try {
        const route = session.routeId || this.getRoute();

        const { prison, girls } = await generateSetup({
          e,
          route,
          players: session.players,
          npcCount: this.config.npcCount,
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
          const mentions = failed.flatMap((girl) => [
            segment.at(girl.userId),
            ` ${girl.name}\n`,
          ]);
          await e.reply([
            "以下玩家私聊发卡失败，请先加机器人好友，然后发【#我的少女】补发：\n",
            ...mentions,
          ]);
        }

        await e.reply("案件正在发生…");
        await this.openChapter(e, session);
      } catch (error) {
        logger.error(`[魔女审判] 群 ${session.groupId} 开局失败：${error.stack || error}`);
        session.phase = PHASES.RECRUITING;
        await saveSession(session);
        await e.reply(`开局失败：${error.message}\n已退回招募状态，可以再试一次【#开始审判】。`);
        return { handled: true, refund: true };
      }

      return true;
    }
  );

  /** 开一章：生成案件、私聊通知凶手、群里公告案发 */
  async openChapter(e, session) {
    const route = session.routeId || this.getRoute();

    const { victim, culprit } = await startChapter({
      e,
      route,
      session,
      playerCulpritChance: this.config.playerCulpritChance / 100,
      suicideChance: this.config.suicideChance / 100,
      onProgress: (text) => this.announce(e, session, text).catch(() => {}),
    });
    await saveSession(session);

    // 每位在场玩家都收到一条私聊。凶手拿到真相，其余人拿到一句无事发生——
    // 两条消息长度不同，但没人看得见别人收到了什么。
    for (const girl of livingPlayers(session)) {
      const isCulprit = girl.id === session.caseFile.culpritId;
      try {
        await this.sendPrivate(
          e,
          girl.userId,
          isCulprit ? renderCulpritNotice(session, session.caseFile, victim) : renderInnocentNotice()
        );
      } catch (error) {
        logger.warn(`[魔女审判] 给 ${girl.userId} 发本章通知失败：${error.message}`);
      }
    }

    await this.announce(e, session, renderIncident(session, session.caseFile, victim));
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
        `没有这个地方。可以去：${session.prison.locations.map((item) => item.name).join("、")}`
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

    return this.submitAction(e, session, girl, {
      kind: "claim",
      propId: prop.id,
      label: `主张「${prop.text}」`,
    });
  });

  refute = Command(/^#出示\s*(\d+)\s*(?:反驳|驳)\s*(\d+)$/, async (e) => {
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
    const prop = session.caseFile.propositions[Number(e.match[2]) - 1];
    if (!prop) {
      await e.reply("没有这个编号的命题，发【#命题】看清单。");
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "refute",
      evidenceId,
      propId: prop.id,
      label: "出示证据反驳",
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

    return this.submitAction(e, session, girl, {
      kind: "question",
      targetId: target.id,
      topic: safeString(e.match?.[2], 60) || "案发那晚你在哪",
      label: `追问 ${target.name}`,
    });
  });

  answer = Command(/^#回应\s*([\s\S]+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.TRIAL]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;

    return this.submitAction(e, session, girl, {
      kind: "answer",
      text: safeString(e.match?.[1], 120),
      label: "回应追问",
    });
  });

  fake = Command(/^#伪证\s*(\d+)\s*([\s\S]+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.TRIAL]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) return false;
    if (girl.id !== session.caseFile?.culpritId) return false;

    const prop = session.caseFile.propositions[Number(e.match[1]) - 1];
    if (!prop) {
      await e.reply("没有这个编号的命题。");
      return true;
    }

    return this.submitAction(e, session, girl, {
      kind: "fake",
      propId: prop.id,
      text: safeString(e.match?.[2], 200),
      label: "抛出一条说辞",
    });
  });

  // ===== 提交与结算 =====

  /**
   * 记下一个动作，全员交完就自动结算
   * 群里提交只播报「谁交了」，不播报交了什么——这个游戏的信息不对称是核心
   */
  async submitAction(e, session, girl, action) {
    session.pendingActions[girl.id] = action;
    await saveSession(session);

    const need = livingPlayers(session).length;
    const done = Object.keys(session.pendingActions).length;

    const inGroup = this.getGroupId(e) !== null;
    if (inGroup) {
      await e.reply(`${girl.name} 已提交（${done}/${need}）。下次建议私聊我，群里容易走漏。`, 0, true);
    } else {
      await e.reply(`已记下：${action.label}（${done}/${need}）`);
      await this.announce(e, session, `🤫 ${girl.name} 提交了行动（${done}/${need}）。`);
    }

    if (done >= need) await this.resolveTurn(e, session);
    return true;
  }

  forceTurn = Command(/^#推进$/, async (e) => {
    if (!this.config.enable) return false;
    const session = await this.getGroupSession(e);
    if (!session) return false;
    if (![PHASES.INVESTIGATE, PHASES.TRIAL].includes(session.phase)) return false;

    if (session.hostId !== String(e.user_id) && !e.isAdmin) {
      await e.reply("只有房主能强制推进。");
      return true;
    }
    if (!Object.keys(session.pendingActions).length) {
      await e.reply("还没有人提交，推进不了。");
      return true;
    }

    await this.resolveTurn(e, session);
    return true;
  });

  /** 结算一个回合，并处理阶段切换 */
  async resolveTurn(e, session) {
    if (!acquireTurnLock(session)) {
      await this.announce(e, session, "上一个回合还在推演，稍等一下。");
      return;
    }

    try {
      const route = session.routeId || this.getRoute();
      const actions = Object.entries(session.pendingActions).map(([girlId, action]) => ({
        girlId,
        ...action,
      }));

      if (session.phase === PHASES.INVESTIGATE) {
        await this.announce(e, session, "🔍 正在推演…");
        const result = await resolveInvestigateTurn({ e, route, session, actions });
        await saveSession(session);
        await this.announce(e, session, renderInvestigateTurn(session, result));

        if (result.phaseDone) {
          session.phase = PHASES.TRIAL;
          session.round = 0;
          // 手法在开庭时公布，「能力符合手法」这一项从这一刻起才计入嫌疑值
          recomputeSuspicion(session);
          await saveSession(session);
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
        await saveSession(session);
        await this.announce(e, session, renderTrialTurn(session, result));

        if (result.phaseDone) {
          session.phase = PHASES.VOTING;
          session.votes = {};
          await saveSession(session);

          if (result.truthEstablished) {
            // 真相是吸收态，证成即定案，不必投票
            await this.finishChapter(e, session, {});
          } else {
            await this.announce(e, session, renderVoteMenu(votableConclusions(session)));
          }
        }
      }
    } catch (error) {
      logger.error(`[魔女审判] 群 ${session.groupId} 回合结算失败：${error.stack || error}`);
      await this.announce(
        e,
        session,
        `本回合推演失败：${error.message}\n提交都还留着，房主可以发【#推进】重试。`
      );
    } finally {
      releaseTurnLock(session);
    }
  }

  // ===== 投票 =====

  vote = Command(/^#投票\s*(\d+)$/, async (e) => {
    const ctx = await this.requireGirl(e, [PHASES.VOTING]);
    if (!ctx) return false;
    const { session, girl } = ctx;
    if (!girl.alive) {
      await e.reply("你已经不在场上了，没有投票权。");
      return true;
    }

    const conclusions = votableConclusions(session);
    const picked = conclusions[Number(e.match[1]) - 1];
    if (!picked) {
      await e.reply("没有这个编号，重新看一下投票清单。");
      return true;
    }

    session.votes[girl.id] = picked.propId;
    await saveSession(session);

    const need = livingPlayers(session).length;
    const done = Object.keys(session.votes).length;
    await e.reply(`已投「${picked.text}」（${done}/${need}）`);

    if (done >= need) {
      await this.finishChapter(e, session, session.votes);
    }
    return true;
  });

  /** 收场一章：判决、处刑、然后开下一章或收尾 */
  async finishChapter(e, session, playerVotes) {
    if (!acquireTurnLock(session)) return;

    try {
      const route = session.routeId || this.getRoute();
      await this.announce(e, session, "📖 猫头鹰正在宣判…");

      const outcome = await resolveVerdict({ e, route, session, playerVotes });
      await saveSession(session);
      await this.announce(e, session, renderVerdict(session, outcome));

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
      await saveSession(session);
    } catch (error) {
      logger.error(`[魔女审判] 群 ${session.groupId} 收场失败：${error.stack || error}`);
      await this.announce(e, session, `宣判失败：${error.message}\n房主可以发【#推进】重试。`);
    } finally {
      releaseTurnLock(session);
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
    const session = await this.getGroupSession(e);
    if (!session) return false;

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
  });

  help = Command(/^#审判帮助$/, async (e) => {
    if (!this.config.enable) return false;
    await e.reply(HELP_TEXT);
    return true;
  });
}
