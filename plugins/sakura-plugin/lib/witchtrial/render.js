/**
 * 消息排版
 *
 * 少女卡、牢狱介绍、证物袋都很长，走合并转发避免刷屏。
 * 回合播报走普通消息，保证群里能直接看到叙事。
 *
 * 编号约定（玩家指令里要用）：
 * - 命题编号：全局，按案件档案里的顺序，所有人看到的一样
 * - 证据编号：**每个人自己证物袋里的序号**，因人而异
 * 两套编号分开是因为证据本来就是私有的，硬凑成全局编号反而会泄露别人有几张牌。
 */

import { PHASE_LABEL, PHASES } from "./SessionStore.js";
import { VERDICT } from "./schema.js";

const VERDICT_LABEL = {
  [VERDICT.ACCUSE]: "指认",
  [VERDICT.SUICIDE]: "自杀",
  [VERDICT.ACCIDENT]: "意外",
};

/** 把若干段文本包成合并转发节点 */
export function buildNodes(segments, { selfId, nickname = "典狱长" } = {}) {
  return segments
    .filter((text) => String(text || "").trim())
    .map((text) => ({
      type: "node",
      data: {
        user_id: selfId,
        nickname,
        content: [{ type: "text", data: { text: String(text) } }],
      },
    }));
}

// ===== 开局 =====

export function renderPrisonIntro(prison) {
  return [
    `《${prison.name}》\n\n${prison.intro}`,
    `【典狱长】\n${prison.warden}`,
    `【牢狱规则】\n${prison.rules.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    `【区域】\n${prison.locations.map((item) => `· ${item.name}\n  ${item.description}`).join("\n\n")}`,
  ];
}

export function renderGirlCard(girl) {
  return `━━━ 你的少女 ━━━
${girl.name}　${girl.age}岁

【外貌】
${girl.appearance || "（未描述）"}

【身世】
${girl.profile || "（未描述）"}

【魔法能力】
${girl.ability.name}
  可以：${girl.ability.can.join("、") || "（未定义）"}
  限制：${girl.ability.limit}

⚠ 你的能力是公开的。所有人都知道你能做到什么、做不到什么——
   它既可能成为你的不在场证明，也可能成为指控你的理由。

【你的秘密】
${girl.secret}

⚠ 秘密只有你自己知道。它和杀人无关，但一旦被翻出来，你的嫌疑值会上升。`;
}

/** 私聊告知本章的凶手 */
export function renderCulpritNotice(session, caseFile, victim) {
  const method = caseFile.method.description;
  const motive = caseFile.motive || {};
  const traces = caseFile.evidence
    .filter((item) => item.supports.includes(caseFile.truthId))
    .map((item) => `· ${item.name}：${item.description}`)
    .join("\n");

  return `━━━ 昨夜 ━━━

你魔女化了。

你杀死了 ${victim.name}。

【为什么】
${motive.trigger || "（想不起来了。只记得那一刻什么东西断了。）"}

${motive.backstory || ""}

【你做了什么】
${method}

【你留下的痕迹】
${traces || "（似乎什么都没留下——但别太乐观）"}

━━━━━━━━━━

审判开始后，你可以：
  #湮灭 <地点>　　销毁那个地点上一条还没被发现的证据
  #伪证 <命题编号> <说辞>　　庭上临时造一条证据去否定某个命题

伪证有破绽。如果有人手里正好攥着能戳破它的东西，你会当场翻车。
在证据被挖尽之前，让某个不指向你的结论站住——那是你唯一的活路。`;
}

export function renderInnocentNotice() {
  return `━━━ 昨夜 ━━━

你睡得很沉，一夜无梦。

醒来时，走廊尽头传来了尖叫。

━━━━━━━━━━

你不是凶手。但这不代表你安全——
审判只需要一个能让猫头鹰信服的死因，不一定是真的那个。`;
}

export function renderIncident(session, caseFile, victim) {
  const location = session.prison.locations.find((item) => item.id === caseFile.discovery.location);
  const finder = session.girls[caseFile.discovery.finder];

  return `━━━ 第 ${session.chapter} 章 · 案发 ━━━

【死者】${victim.name}
【地点】${location?.name || "未知"}
【时间】${caseFile.discovery.time || "不明"}
【第一发现者】${finder?.name || "不明"}

${caseFile.discovery.body}

━━━━━━━━━━

猫头鹰落在栏杆上，慢慢转了转脑袋。

「魔女审判，即将开始。
　在那之前，给你们一点时间——去翻，去问，去撒谎。」

调查阶段共 ${session.investigateRounds} 轮。私聊我提交行动：
  #调查 <地点>　　搜查某处
  #询问 <少女> <问题>　　向某人打听

搜到什么只有你自己知道。群里只会公布谁去了哪。`;
}

// ===== 回合播报 =====

export function renderInvestigateTurn(session, result) {
  const parts = [
    `━━━ 调查 ${session.round}/${session.investigateRounds} ━━━\n\n${result.narration}`,
  ];

  const moves = result.results
    .filter((item) => item.kind !== "destroy")
    .map((item) =>
      item.kind === "search"
        ? `· ${item.actorName} 去了「${item.locationName}」`
        : `· ${item.actorName} 找 ${item.targetName} 说了话`
    );
  if (moves.length) parts.push(`【去向】\n${moves.join("\n")}`);

  if (result.encounters.length) {
    parts.push(
      `【撞见】\n${result.encounters.map((item) => `· ${item.names.join(" 和 ")} 在「${item.locationName}」碰上了`).join("\n")}`
    );
  }

  parts.push(
    result.phaseDone
      ? "调查阶段结束。猫头鹰宣布——魔女审判，现在开庭。"
      : `还剩 ${session.investigateRounds - session.round} 轮调查。`
  );

  return parts.join("\n\n");
}

export function renderTrialOpening(session, propositions) {
  // 开庭时才公布手法需要什么能力。调查阶段不能公布——否则玩家还没查出
  // 死因，嫌疑榜就已经按能力把人排好了，等于开局直接点名。
  const required = session.caseFile?.method?.requiredAbilities || [];
  const suspects = Object.values(session.girls)
    .filter((girl) => girl.alive && required.length &&
      required.every((need) =>
        [girl.ability.name, ...girl.ability.can].some((have) => have.includes(need) || need.includes(have))
      ))
    .map((girl) => girl.name);

  const methodBlock = required.length
    ? `【尸检】
猫头鹰把一份验尸报告丢在地上。

「这个手法，需要用到——${required.join("、")}。
　做不到的人，就不必再解释了。」

做得到的人：${suspects.join("、") || "（一个都没有？）"}
她们的嫌疑值现在都涨了。`
    : `【尸检】
「手法很普通。谁都做得到。」`;

  return `━━━ 魔女审判 · 开庭 ━━━

猫头鹰停在高处，俯视着底下这一圈少女。

「规矩很简单。
　你们要投票选出一个死因——一个能说服我的死因。
　它不一定要是真的。
　但如果到最后你们连一个像样的说法都拿不出来……
　那我就自己挑一个人。」

${methodBlock}

【台面上的命题】
${propositions.map((item, index) => `${index + 1}. ${item.text}${item.conclusion ? `　【${VERDICT_LABEL[item.conclusion.type]}】` : ""}`).join("\n")}

庭审共 ${session.trialRounds} 轮。群里随便说话，机械动作私聊提交：
  #主张 <命题编号>　　把一个结论推上台面
  #出示 <证据编号> 反驳 <命题编号>　　用手里的牌击碎它
  #追问 <少女> <关于什么>　　逼对方开口
  #回应 <内容>　　回答别人的追问，不答会涨嫌疑

⚠ 反驳打不中会反噬：你涨嫌疑，牌还白白摊在了桌面上。`;
}

export function renderTrialTurn(session, result) {
  const parts = [`━━━ 庭审 ${session.round}/${session.trialRounds} ━━━\n\n${result.narration}`];

  const judged = result.moves
    .map((item) => {
      switch (item.kind) {
        case "refute":
          return `${item.valid ? "✅" : "❌"} ${item.actorName} 出示「${item.evidenceName}」反驳「${item.propText}」${item.valid ? "——命中" : "——落空，反噬"}`;
        case "claim":
          return `${item.stands ? "📌" : "💬"} ${item.actorName} 主张「${item.propText}」（支持 ${item.supports}/${item.threshold}${item.refuted ? "，已被否定" : ""}）`;
        case "question":
          return `❓ ${item.actorName} 追问 ${item.targetName}：${item.topic}`;
        case "dodge":
          return `🙈 ${item.actorName} 回避了追问，嫌疑上升`;
        case "fake":
          return item.exposed
            ? `🔥 ${item.actorName} 的说辞被当场戳穿`
            : `💬 ${item.actorName} 提出了一条说辞`;
        default:
          return "";
      }
    })
    .filter(Boolean);
  if (judged.length) parts.push(`【本轮判定】\n${judged.join("\n")}`);

  if (result.standing.length) {
    parts.push(
      `【当前站得住的结论】\n${result.standing.map((item) => `· ${item.text}（支持 ${item.supports}）`).join("\n")}`
    );
  } else {
    parts.push("【当前站得住的结论】\n（一个都没有）");
  }

  parts.push(renderSuspicionBoard(session));

  if (result.truthEstablished) {
    parts.push("⚖ 有一个结论已经被完整证成，且没有任何证据能反驳它。\n猫头鹰不再需要投票了。");
  } else if (result.phaseDone) {
    parts.push("庭审轮次用尽。猫头鹰要求投票。\n发【#投票 <编号>】，私聊或群里都行。");
  } else {
    parts.push(`还剩 ${session.trialRounds - session.round} 轮。`);
  }

  return parts.join("\n\n");
}

export function renderSuspicionBoard(session) {
  const board = Object.values(session.girls)
    .filter((girl) => girl.alive)
    .sort((a, b) => b.suspicion - a.suspicion)
    .map((girl, index) => {
      const mark = index === 0 ? "⚠" : "·";
      const kind = girl.kind === "player" ? "" : "（NPC）";
      return `${mark} ${girl.name}${kind} ${girl.suspicion}`;
    });
  return `【嫌疑】\n${board.join("\n")}\n\n超时未决时，最上面那个会被处刑。`;
}

// ===== 查询 =====

export function renderPouch(session, girl, evidence) {
  if (!evidence.length) {
    return `【${girl.name} 的证物袋】\n\n空的。去【#调查 <地点>】或【#询问 <少女> <问题>】找点东西。`;
  }
  return `【${girl.name} 的证物袋】

${evidence.map((item, index) => `${index + 1}. 「${item.name}」\n   ${item.description}`).join("\n\n")}

━━━━━━━━━━
出示时用这里的序号：#出示 <序号> 反驳 <命题编号>
这些编号只对你有效，别人的证物袋是另一套。`;
}

export function renderPropositions(session) {
  const props = session.caseFile?.propositions || [];
  const publicIds = session.publicEvidence || [];
  const refuted = new Set(session.refutedProps || []);

  const lines = props.map((item, index) => {
    const supports = (session.caseFile.evidence || []).filter(
      (e) => publicIds.includes(e.id) && e.supports.includes(item.id)
    ).length;
    const mark = refuted.has(item.id) ? "❌" : item.conclusion ? "⚖" : "·";
    const tag = item.conclusion ? `【${VERDICT_LABEL[item.conclusion.type]}】` : "";
    return `${index + 1}. ${mark} ${item.text}${tag}　支持 ${supports}`;
  });

  return `【命题清单】\n\n${lines.join("\n")}\n\n❌ 已被证据否定　⚖ 可以被投票采纳`;
}

export function renderCourtRecord(session) {
  const caseFile = session.caseFile;
  if (!caseFile) return "现在还没有案件。";

  const publicEvidence = (caseFile.evidence || []).filter((item) =>
    session.publicEvidence.includes(item.id)
  );

  const claims = session.claims
    .filter((item) => item.chapter === session.chapter)
    .map((item) => {
      const prop = caseFile.propositions.find((p) => p.id === item.propId);
      const by = session.girls[item.byId];
      return `· ${by?.name || "某人"} 主张「${prop?.text || "?"}」`;
    });

  const testimony = session.testimony
    .slice(-8)
    .map((item) => `· 第${item.chapter}章 ${item.name}：${item.text}`);

  return `【法庭记录 · 第 ${session.chapter} 章】

▎台面上的证据（${publicEvidence.length}）
${publicEvidence.length ? publicEvidence.map((item) => `· 「${item.name}」${item.description}`).join("\n") : "（无）"}

▎已提出的主张
${claims.length ? claims.join("\n") : "（无）"}

▎证言记录（跨章保留）
${testimony.length ? testimony.join("\n") : "（无）"}`;
}

export function renderVoteMenu(conclusions) {
  const lines = conclusions.map((item, index) => {
    const mark = item.refuted ? "❌" : item.stands ? "✅" : "⏳";
    const target = item.targetName ? `（${item.targetName}）` : "";
    return `${index + 1}. ${mark} ${item.text}${target}\n   支持 ${item.supports}/${item.threshold}${item.refuted ? "　已被否定" : item.stands ? "　可以采纳" : "　证据不足"}`;
  });

  return `━━━ 投票 ━━━

猫头鹰：「说吧。你们认为她是怎么死的。」

${lines.join("\n")}

发【#投票 <编号>】。
✅ 才是能被采纳的。投一个证据不足或已被否定的，等于弃权。
如果没有任何结论过半且成立——猫头鹰会自己挑嫌疑最高的那个。`;
}

export function renderStatus(session) {
  const phaseText = PHASE_LABEL[session.phase] || session.phase;

  if (session.phase === PHASES.RECRUITING) {
    const roster = session.players
      .map((player, index) => `${index + 1}. ${player.nickname}${player.userId === session.hostId ? "（房主）" : ""}`)
      .join("\n");
    return `【魔女审判 · ${phaseText}】
题材：${session.theme || "由 AI 自选"}
已加入 ${session.players.length}/${session.maxPlayers} 人：
${roster}

房主发送【#开始审判】即可开局。`;
  }

  const submitted = Object.keys(session.pendingActions || {});
  const livingPlayerCount = Object.values(session.girls).filter(
    (girl) => girl.alive && girl.kind === "player"
  ).length;

  const roster = Object.values(session.girls)
    .sort((a, b) => b.suspicion - a.suspicion)
    .map((girl) => {
      const mark = !girl.alive
        ? girl.fate === "victim"
          ? "💀"
          : "⚰"
        : submitted.includes(girl.id)
          ? "✅"
          : girl.kind === "player"
            ? "⏳"
            : "·";
      const kind = girl.kind === "npc" ? "（NPC）" : "";
      const state = girl.alive ? `嫌疑 ${girl.suspicion}` : girl.fate === "victim" ? "已死亡" : "已处刑";
      return `${mark} ${girl.name}${kind}　${state}`;
    })
    .join("\n");

  const roundText =
    session.phase === PHASES.INVESTIGATE
      ? `调查 ${session.round}/${session.investigateRounds}`
      : session.phase === PHASES.TRIAL
        ? `庭审 ${session.round}/${session.trialRounds}`
        : phaseText;

  const historyBlock = session.history.length
    ? `\n【前几章】\n${session.history
        .map(
          (item) =>
            `第${item.chapter}章：${item.victimName} 死亡 → ${item.executedName || "无人"}被处刑 ${item.correct ? "✔判对" : "✘判错"}`
        )
        .join("\n")}`
    : "";

  return `【${session.prison?.name || "魔女审判"} · 第 ${session.chapter} 章】
${roundText}

${roster}

本回合已提交 ${submitted.length}/${livingPlayerCount} 人${historyBlock}`;
}

// ===== 收场 =====

export function renderVerdict(session, { verdict, executed, text }) {
  const sourceLabel = {
    truth: "真相被完整证成，当庭定案",
    vote: "投票通过",
    timeout: "超时未决，猫头鹰自行裁定",
  }[verdict.source];

  const parts = [
    `━━━ 第 ${session.chapter} 章 · 宣判 ━━━

【裁定方式】${sourceLabel}
【采纳的结论】${verdict.conclusionText || "（无）"}
【被处刑者】${executed?.name || "无人"}`,
  ];

  if (text) parts.push(text);

  // 判对了才公布真相，判错时留着——玩家要在下一章开场才意识到自己错了
  if (verdict.correct && executed) {
    parts.push(`⚖ 判决正确。真凶就是 ${executed.name}。`);
  } else if (verdict.correct) {
    // 自杀/意外被正确认定：没有人被处刑，但这一章也结束了
    parts.push("⚖ 判决正确。没有凶手——从一开始就没有。");
  } else if (verdict.executedId) {
    parts.push("⚖ 猫头鹰接受了这个说法。\n\n审判结束了。");
  } else {
    parts.push("⚖ 无人被处刑。猫头鹰似乎有点失望，但也没说什么。");
  }

  return parts.join("\n\n");
}

export function renderFinale(session, reason, closingText) {
  const survivors = Object.values(session.girls).filter(
    (girl) => girl.alive && girl.kind === "player"
  );

  // 判错的章节，动机当时没人听见。这里一次性摊开——包括那些没被讲出来的。
  const truthBlock = session.history
    .map((item) => {
      const head = `第${item.chapter}章　${item.correct ? "✔" : "✘"}
　死者：${item.victimName}
　真凶：${item.culpritName}
　处刑：${item.executedName || "无人"}${item.correct ? "" : "　← 她是无辜的"}`;
      if (!item.motive) return head;
      return `${head}
　动机：${item.motive}${item.correct ? "" : `\n　（这段话当时没有人听见）${item.confession ? `\n　「${item.confession}」` : ""}`}`;
    })
    .join("\n\n");

  const label = {
    caught: "真凶伏法 —— 幸存者全部获释",
    wipeout: "玩家全灭 —— 魔女胜",
    lastOne: "只剩一人 —— 审判失去意义",
    exhausted: "章节耗尽 —— 真相沉入海底",
  }[reason];

  return `━━━ 终 ━━━

【${label}】

${closingText}

【全部真相】
${truthBlock || "（无记录）"}

【幸存】
${survivors.length ? survivors.map((girl) => girl.name).join("、") : "无人生还"}

——《${session.prison?.name || "孤岛牢狱"}》完——

发【#创建审判】开新的一局。`;
}

export const HELP_TEXT = `【魔女审判 · 指令】

一群被检测出魔女因子的少女被关进孤岛牢狱。
有人死了。猫头鹰要你们投票选出一个「魔女」送上处刑台。

⚠ 审判不需要找出真凶，只需要一个能说服猫头鹰的死因。
⚠ 但真相一旦被完整证成，就没有任何证据能反驳它。
⚠ 凶手可能是你们中的某个人，也可能是某位 NPC 少女。

开局
  #创建审判 [题材]　建局并成为房主
  #加入审判 / #退出审判
  #开始审判　　　　房主开局

调查阶段（私聊提交）
  #调查 <地点>　　　　　搜查某处，可能找到证据
  #询问 <少女> <问题>　 向某人打听
  #湮灭 <地点>　　　　　仅凶手：销毁一条未被发现的证据

庭审阶段（私聊提交）
  #主张 <命题编号>　　　　　　　把结论推上台面
  #出示 <证据编号> 反驳 <命题编号>
  #追问 <少女> <关于什么>
  #回应 <内容>　　　　　　　　　回答追问，不答涨嫌疑
  #伪证 <命题编号> <说辞>　　　 仅凶手

投票
  #投票 <编号>

查询
  #我的少女　　查看自己的能力与秘密
  #证物袋　　　查看手里的牌
  #命题　　　　查看全部命题与支持数
  #法庭记录　　台面上的证据与证言
  #审判状态　　嫌疑排行与进度

其他
  #推进　　　　房主强制结算本回合
  #结束审判　　房主或管理员终止本局`;
