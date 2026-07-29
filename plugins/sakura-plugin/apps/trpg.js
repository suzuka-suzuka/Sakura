import Setting from "../lib/setting.js";
import { generateCharacters, generateModule } from "../lib/trpg/ModuleGenerator.js";
import {
  effectiveSkillValue,
  isExhausted,
  prepareActions,
  runTurn,
  writeFinale,
} from "../lib/trpg/KpEngine.js";
import { formatCheck, rollExpression, skillCheck } from "../lib/trpg/dice.js";
import { getSkillValue, safeString, settleGoals } from "../lib/trpg/schema.js";
import {
  HELP_TEXT,
  OPTION_MARKS,
  buildNodes,
  renderCharacterCard,
  renderEnding,
  renderModuleIntro,
  renderStatus,
  renderTurn,
} from "../lib/trpg/render.js";
import { buildWipeoutText } from "../lib/trpg/prompts.js";
import {
  PHASES,
  acquireTurnLock,
  createSession,
  deleteSession,
  dropUserIndex,
  findSessionByUser,
  getCharacter,
  getCharacters,
  isPlayer,
  loadSession,
  releaseTurnLock,
  saveSession,
} from "../lib/trpg/SessionStore.js";

/** 回合耗尽时用的合成结局，让收场也能走终章而不是硬掐断 */
const UNFINISHED_ENDING = {
  id: "unfinished",
  name: "未竟",
  description: "调查在时间耗尽时中断，没有走到任何一个结局。该查的还没查完，该问的还没问出口。",
  requires: { all: [], any: [], none: [] },
};

/** 选项序号的各种写法：半角、全角、带圈 */
const OPTION_INPUT = Object.fromEntries(
  ["1234", "１２３４", "①②③④"].flatMap((set) =>
    [...set].map((char, index) => [char, index + 1])
  )
);

/** 配置文件还没生成时的兜底，避免插件静默失效 */
const CONFIG_DEFAULTS = {
  enable: true,
  route: "",
  minPlayers: 2,
  maxPlayers: 6,
  maxRounds: 30,
  onlyWhiteCreate: false,
  enableFreeDice: true,
};

export class Trpg extends plugin {
  constructor() {
    super({
      name: "AI跑团",
      event: "message",
      priority: 1130,
      configWatch: "trpg",
    });
  }

  get config() {
    return { ...CONFIG_DEFAULTS, ...(Setting.getConfig("trpg") || {}) };
  }

  /** 模组路由没单独配就跟着 AI 的通用路由走 */
  getRoute() {
    return this.config.route || Setting.getConfig("AI")?.appsRoute || "";
  }

  /**
   * 取群号，不是群消息就返回 null
   *
   * 用 message_type 而不是判断 e.group_id 的真假：前者是消息事件上一定存在的
   * 字段，语义也更直白。顺带对 Event 属性回退的行为不敏感。
   */
  getGroupId(e) {
    if (e.message_type !== "group") return null;
    const groupId = Number(e.group_id);
    return Number.isFinite(groupId) ? groupId : null;
  }

  /** 群指令：直接取本群的局 */
  async getGroupSession(e) {
    const groupId = this.getGroupId(e);
    if (!groupId) return null;
    return loadSession(e.self_id, groupId);
  }

  /**
   * 群里和私聊都能用的指令：群内取本群的局，私聊按玩家反查
   * @returns {Promise<{session: object, inGroup: boolean}|null>}
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

  /**
   * 无论指令从哪来，播报一律发回开局的那个群
   * groupId 在会话里是字符串，某些 OneBot 实现只认数字，这里转一次；
   * 群播报失败不该连累整个回合，所以吞掉异常只记日志
   */
  async announce(e, session, message) {
    const groupId = Number(session.groupId) || session.groupId;
    try {
      return await e.bot.sendGroupMsg(groupId, message);
    } catch (error) {
      logger.error(`[跑团] 向群 ${groupId} 播报失败：${error.message}`);
      return null;
    }
  }

  async sendPrivate(e, userId, message) {
    return e.bot.sendPrivateMsg(userId, message);
  }

  async sendPrivateForward(e, userId, segments, info = {}) {
    const nodes = buildNodes(segments, { selfId: e.self_id, nickname: info.nickname || "KP" });
    if (!nodes.length) return null;
    return e.bot.sendForwardMsg({
      messages: nodes,
      user_id: userId,
      prompt: info.prompt,
      summary: info.summary,
      source: info.source,
    });
  }

  // ===== 开局 =====

  createGame = Command(/^#创建跑团(?:\s+(.+))?$/, async (e) => {
    if (!this.config.enable) return false;
    const groupId = this.getGroupId(e);
    if (!groupId) {
      await e.reply("跑团要在群里开局哦。");
      return true;
    }
    if (this.config.onlyWhiteCreate && !(e.isWhite || e.isAdmin)) {
      await e.reply("只有白名单用户或管理员可以开局。");
      return true;
    }

    const existing = await this.getGroupSession(e);
    if (existing && existing.phase !== PHASES.ENDED) {
      await e.reply("本群已经有一局在跑了，先【#结束跑团】再开新的。");
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
      maxRounds: this.config.maxRounds,
      routeId: this.getRoute(),
    });
    await saveSession(session);

    await e.reply(
      `跑团已开局，房主是你。\n题材：${theme || "由 AI 自选"}\n\n其他人发【#加入跑团】上车，满 ${this.config.minPlayers} 人后房主发【#开始跑团】。\n上限 ${this.config.maxPlayers} 人。`
    );
    return true;
  });

  joinGame = Command(/^#加入跑团$/, async (e) => {
    if (!this.config.enable) return false;
    const session = await this.getGroupSession(e);
    if (!session) return false;

    if (session.phase !== PHASES.RECRUITING) {
      await e.reply("这局已经开跑了，中途不能加入。");
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

  leaveGame = Command(/^#退出跑团$/, async (e) => {
    if (!this.config.enable) return false;
    const session = await this.getGroupSession(e);
    if (!session) return false;
    if (!isPlayer(session, e.user_id)) return false;

    if (session.phase === PHASES.GENERATING) {
      await e.reply("正在出模组，等开局后再退。");
      return true;
    }

    session.players = session.players.filter((player) => player.userId !== String(e.user_id));
    delete session.characters[String(e.user_id)];
    delete session.pendingActions[String(e.user_id)];
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

  // 开局是唯一烧钱的动作（出模组 + 出全部角色卡），扣费挂在这里
  startGame = Command(/^#开始跑团$/, { economy: { command: "开始跑团", refundOnFalse: true } }, async (e) => {
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
      await e.reply(`至少要 ${this.config.minPlayers} 人才能开跑，现在只有 ${session.players.length} 人。`);
      return true;
    }

    // 先占位再生成，防止生成期间被重复触发
    session.phase = PHASES.GENERATING;
    await saveSession(session);

    await e.reply(`KP 正在为 ${session.players.length} 人量身写模组，大概要一两分钟，写好会私聊发角色卡…`);

    try {
      const route = session.routeId || this.getRoute();

      const module = await generateModule({
        e,
        route,
        playerCount: session.players.length,
        theme: session.theme,
        tone: session.tone,
        onProgress: (text) => e.reply(text).catch(() => {}),
      });

      await e.reply(`模组《${module.title}》已就位，正在生成角色卡…`);

      const characters = await generateCharacters({ e, route, module, players: session.players });

      session.module = module;
      session.characters = Object.fromEntries(characters.map((character) => [character.userId, character]));
      session.currentScene = module.startScene;
      session.round = 0;
      session.phase = PHASES.PLAYING;
      await saveSession(session);

      // 私聊发卡，发不出去的（多半没加好友）在群里点名
      const failed = [];
      for (const character of characters) {
        try {
          await this.sendPrivateForward(e, character.userId, [renderCharacterCard(character)], {
            prompt: `《${module.title}》你的角色卡`,
            source: "角色卡",
            summary: character.name,
          });
        } catch (error) {
          logger.warn(`[跑团] 给 ${character.userId} 私聊发卡失败：${error.message}`);
          failed.push(character);
        }
      }

      await e.sendForwardMsg(renderModuleIntro(module), {
        prompt: `《${module.title}》开场`,
        source: module.title,
        summary: module.tone,
      });

      if (failed.length) {
        const mentions = failed.flatMap((character) => [
          segment.at(character.userId),
          ` ${character.name}\n`,
        ]);
        await e.reply([
          "以下玩家私聊发卡失败，请先加机器人好友，然后发【#我的角色卡】补发：\n",
          ...mentions,
        ]);
      }

      await e.reply(
        `开跑！第 1 回合开始。\n\n每人发【#行动 你要做什么】提交宣告，全员交完自动结算。\n第一回合先自由发挥，之后每回合 KP 都会给几条建议行动，届时发【#行动 2】就能直接选。\n房主也可以发【#推进】提前结算。`
      );
    } catch (error) {
      logger.error(`[跑团] 群 ${session.groupId} 开局失败：${error.stack || error}`);
      session.phase = PHASES.RECRUITING;
      await saveSession(session);
      await e.reply(`开局失败：${error.message}\n已退回招募状态，可以再试一次【#开始跑团】。`);
      return { handled: true, refund: true };
    }

    return true;
  });

  // ===== 游玩 =====

  // 空格可选：中文输入下「#行动观察镜子」是很自然的写法
  submitAction = Command(/^#(?:行动|宣告)\s*([\s\S]+)$/, async (e) => {
    if (!this.config.enable) return false;
    const resolved = await this.resolveSession(e);
    if (!resolved) return false;

    const { session, inGroup } = resolved;
    if (session.phase !== PHASES.PLAYING) return false;
    if (!isPlayer(session, e.user_id)) return false;

    const character = getCharacter(session, e.user_id);
    if (!character) return false;
    if (!character.alive) {
      await e.reply(`${character.name} 已经出局了，只能围观。`);
      return true;
    }

    const raw = safeString(e.match?.[1], 300);
    if (!raw) {
      await e.reply("宣告不能是空的。");
      return true;
    }

    // 纯数字/序号视为选 KP 给的建议，其余一律当自由宣告
    const picked = OPTION_INPUT[raw];
    let text = raw;
    if (picked) {
      const option = session.currentOptions?.[picked - 1];
      if (!option) {
        await e.reply(
          session.currentOptions?.length
            ? `只有 ${session.currentOptions.length} 个建议可选。`
            : "现在还没有建议选项，直接写你想做什么吧。"
        );
        return true;
      }
      text = option.text;
    }

    session.pendingActions[String(e.user_id)] = text;
    await saveSession(session);

    const alive = getCharacters(session).filter((item) => item.alive);
    const submitted = Object.keys(session.pendingActions).length;

    if (inGroup) {
      await e.reply(`${character.name} 的宣告已记下（${submitted}/${alive.length}）。`, 0, true);
    } else {
      await e.reply(`宣告已记下（${submitted}/${alive.length}），内容不会公开。`);
      await this.announce(e, session, `🤫 ${character.name} 私下提交了行动（${submitted}/${alive.length}）。`);
    }

    if (submitted >= alive.length) {
      await this.resolveTurn(e, session);
    }
    return true;
  });

  forceTurn = Command(/^#推进$/, async (e) => {
    if (!this.config.enable) return false;
    const session = await this.getGroupSession(e);
    if (!session || session.phase !== PHASES.PLAYING) return false;

    if (session.hostId !== String(e.user_id) && !e.isAdmin) {
      await e.reply("只有房主能强制推进。");
      return true;
    }
    if (!Object.keys(session.pendingActions).length) {
      await e.reply("还没有人提交宣告，推进不了。");
      return true;
    }

    await this.resolveTurn(e, session);
    return true;
  });

  /** 结算一个回合 */
  async resolveTurn(e, session) {
    if (!acquireTurnLock(session)) {
      await this.announce(e, session, "上一个回合还在推演，稍等一下。");
      return;
    }

    try {
      const characters = getCharacters(session);
      const actions = prepareActions(session, characters);
      if (!actions.length) {
        await this.announce(e, session, "没有有效的宣告，本回合跳过。");
        return;
      }

      await this.announce(e, session, "🎲 KP 正在推演本回合…");

      const route = session.routeId || this.getRoute();
      // 回合上限在开局时就固定在会话里，旧存档回落到当前配置
      const maxRounds = Number.isFinite(session.maxRounds) ? session.maxRounds : this.config.maxRounds;
      const result = await runTurn({ e, route, session, characters, actions, maxRounds });
      await saveSession(session);

      await this.announce(
        e,
        session,
        renderTurn({
          round: session.round,
          narration: result.narration,
          checks: result.checks,
          events: result.events,
          options: result.options,
          newFlags: result.newFlags,
          pacing: result.pacing,
        })
      );

      // 收场判定：结局由本地对剧情标记求值得出，KP 无权宣布
      if (result.ending) {
        await this.announce(e, session, "📖 KP 正在写终章…");
        const finale = await writeFinale({ e, route, session, characters, ending: result.ending });
        await this.announce(
          e,
          session,
          renderEnding(session.module, result.ending, characters, finale.text, finale.goalResults)
        );
        await this.endSession(session);
        return;
      }

      if (characters.every((character) => !character.alive)) {
        await this.announce(
          e,
          session,
          `${buildWipeoutText(session.module)}\n\n${this.renderGoalReport(session, characters)}`
        );
        await this.endSession(session);
        return;
      }

      // 回合耗尽也走终章，不再甩一句「达到上限」硬掐断
      if (maxRounds > 0 && session.round >= maxRounds) {
        await this.announce(e, session, "📖 时间到了，KP 正在收尾…");
        const finale = await writeFinale({ e, route, session, characters, ending: UNFINISHED_ENDING });
        await this.announce(
          e,
          session,
          `${renderEnding(session.module, UNFINISHED_ENDING, characters, finale.text, finale.goalResults)}\n\n发【#创建跑团】开新的一局吧。`
        );
        await this.endSession(session);
      }
    } catch (error) {
      logger.error(`[跑团] 群 ${session.groupId} 回合结算失败：${error.stack || error}`);
      await this.announce(e, session, `本回合推演失败：${error.message}\n宣告都还留着，房主可以发【#推进】重试。`);
    } finally {
      releaseTurnLock(session);
    }
  }

  /** 逐人结算个人目标，用于没有走到结局的那些收场路径 */
  renderGoalReport(session, characters) {
    const results = settleGoals(characters, session.flags);
    if (!results.length) return "";
    return `【个人目标】\n${results
      .map((item) => `${item.achieved ? "✔" : "✘"} ${item.name}：${item.goal}`)
      .join("\n")}\n`;
  }

  async endSession(session) {
    session.phase = PHASES.ENDED;
    await deleteSession(session);
  }

  // ===== 查询与骰子 =====

  showCard = Command(/^#我的角色卡$/, async (e) => {
    if (!this.config.enable) return false;
    const resolved = await this.resolveSession(e);
    if (!resolved) return false;

    const character = getCharacter(resolved.session, e.user_id);
    if (!character) return false;

    try {
      await this.sendPrivateForward(e, e.user_id, [renderCharacterCard(character)], {
        prompt: `${character.name} 的角色卡`,
        source: "角色卡",
        summary: character.occupation,
      });
      if (resolved.inGroup) await e.reply("角色卡已私聊发送。", 0, true);
    } catch (error) {
      logger.warn(`[跑团] 补发角色卡给 ${e.user_id} 失败：${error.message}`);
      await e.reply("私聊发不出去，请先加机器人好友再试。", 0, true);
    }
    return true;
  });

  showStatus = Command(/^#跑团状态$/, async (e) => {
    if (!this.config.enable) return false;
    const resolved = await this.resolveSession(e);
    if (!resolved) return false;

    await e.reply(renderStatus(resolved.session, getCharacters(resolved.session)));
    return true;
  });

  skillCheckCmd = Command(/^#检定\s+(\S+)$/, async (e) => {
    if (!this.config.enable) return false;
    const resolved = await this.resolveSession(e);
    if (!resolved) return false;

    const character = getCharacter(resolved.session, e.user_id);
    if (!character) return false;

    const skillName = safeString(e.match?.[1], 20);
    const baseValue = getSkillValue(character, skillName);
    // 和回合结算走同一套折算，否则力竭时手动检定看到的数字偏乐观、跟实战对不上
    const exhausted = isExhausted(character);
    const result = skillCheck(effectiveSkillValue(baseValue, exhausted));

    await e.reply(
      formatCheck({
        name: character.name,
        skillName,
        skill: result.skill,
        roll: result.roll,
        level: result.level,
        note: exhausted ? `力竭，原 ${baseValue}` : "",
      })
    );
    return true;
  });

  // 骰子表达式必须整体匹配，否则 .rest 这类普通消息会被误当成掷骰
  rollDice = Command(/^(?:[.。]r|#骰)\s*(\d*d\d+(?:[+-]\d+)?)?$/i, async (e) => {
    if (!this.config.enable || !this.config.enableFreeDice) return false;

    const result = rollExpression(e.match?.[1] || "1d100");
    if (!result.ok) {
      await e.reply(result.error);
      return true;
    }

    const detail = result.rolls.length > 1 ? `[${result.rolls.join("+")}]${result.modifier ? (result.modifier > 0 ? `+${result.modifier}` : result.modifier) : ""} = ` : "";
    await e.reply(`🎲 ${result.expression} → ${detail}${result.total}`);
    return true;
  });

  endGame = Command(/^#结束跑团$/, async (e) => {
    if (!this.config.enable) return false;
    const session = await this.getGroupSession(e);
    if (!session) return false;

    if (session.hostId !== String(e.user_id) && !e.isAdmin) {
      await e.reply("只有房主或管理员能结束本局。");
      return true;
    }

    await deleteSession(session);
    await e.reply(
      session.module
        ? `《${session.module.title}》在第 ${session.round} 回合被中止。`
        : "本局已解散。"
    );
    return true;
  });

  help = Command(/^#跑团帮助$/, async (e) => {
    if (!this.config.enable) return false;
    await e.reply(HELP_TEXT);
    return true;
  });
}
