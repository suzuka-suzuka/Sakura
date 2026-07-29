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

import {
  PHASE_LABEL,
  PHASES,
  turnDeadlineRemainingMs,
} from "./SessionStore.js";
import { VERDICT } from "./schema.js";

const VERDICT_LABEL = {
  [VERDICT.ACCUSE]: "指认",
  [VERDICT.SUICIDE]: "自杀",
  [VERDICT.ACCIDENT]: "意外",
};

/** 囚犯编号前缀，指令里可以直接打这个号 */
const tag = (girl) => (girl?.code ? `[${girl.code}] ` : "");

/** 地点代号前缀 */
const loc = (location) => (location?.code ? `${location.code}. ` : "");

/** 所有人看到同一个持久化截止时间；机器人重启也不会重新起算 */
export function renderTurnDeadline(session, now = Date.now()) {
  const deadline = Number(session?.turnDeadlineAt);
  if (!Number.isFinite(deadline) || deadline <= 0) return "本回合截止：正在设置";

  const clock = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(deadline));
  const remainingMs = turnDeadlineRemainingMs(session, now);
  if (remainingMs <= 0) return `本回合截止：${clock}（已到期，等待自动结算）`;

  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const remaining =
    minutes < 60
      ? `约 ${minutes} 分钟后`
      : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}后`;
  return `本回合截止：${clock}（${remaining}）`;
}

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
    `【区域】\n调查时打代号就行，比如【#调查 A】\n\n${prison.locations.map((item) => `${item.code}. ${item.name}\n   ${item.description}`).join("\n\n")}`,
  ];
}

export function renderGirlCard(girl) {
  return `━━━ 你的少女 ━━━
囚犯编号 ${girl.code}
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

⚠ 秘密只有你自己知道，而且不影响任何判定——它不会给你加嫌疑，
　 庭上也没有任何办法把它问出来。
　 它只会在一种情况下被翻出来：**你被送上处刑台的时候**。
　 到那一步，所有人才会知道你一直背着什么。`;
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

每章只能尝试一次伪证，而且最后一轮禁用。
它只有在另一位在场者确实握有破绽时才会落地；对方下一轮若用
【#揭穿 <证据编号>】命中，你会 +25。没有破绽可供反制，尝试本身就会失败并 +8。
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

/**
 * 真人每章收到一份仅含去向的私人线索。
 * 不透露证物名、内容或它支持/反驳什么；凶手仍可能抢先把地点上的线索抹掉。
 */
export function renderInvestigationLeads(session, girl) {
  const ids = session.investigationLeads?.[girl.id] || [];
  const destinations = [];

  for (const evidenceId of ids) {
    const evidence = session.caseFile?.evidence?.find((item) => item.id === evidenceId);
    if (!evidence) continue;
    if (evidence.via === "search") {
      const location = session.prison?.locations?.find(
        (item) => item.id === evidence.location
      );
      if (location) destinations.push(`· 搜查 ${location.code}「${location.name}」`);
    } else {
      const target = session.girls?.[evidence.askTarget];
      if (target) destinations.push(`· 询问 ${target.code} ${target.name}`);
    }
  }

  const counts = new Map();
  for (const destination of destinations) {
    counts.set(destination, (counts.get(destination) || 0) + 1);
  }
  const unique = [...counts].map(
    ([destination, count]) =>
      `${destination}${count > 1 ? `（至少有 ${count} 条不同线索，要查不止一次）` : ""}`
  );
  if (!unique.length) {
    return `━━━ 私人线索 ━━━

这一章没有指向明确的耳语。你仍可自由调查任何区域、询问任何在场者。`;
  }

  return `━━━ 私人线索 ━━━

你醒来时记得几处不自然的细节：
${unique.join("\n")}

这里只保证“那里原本有可查的东西”，不保证它还没被人拿走或毁掉，
也不代表它一定支持你眼下的猜测。`;
}

export function renderIncident(session, caseFile, victim) {
  const location = session.prison.locations.find((item) => item.id === caseFile.discovery.location);
  const finder = session.girls[caseFile.discovery.finder];

  return `━━━ 第 ${session.chapter} 章 · 案发 ━━━

【死者】${tag(victim)}${victim.name}
【地点】${loc(location)}${location?.name || "未知"}
【时间】${caseFile.discovery.time || "不明"}
【第一发现者】${tag(finder)}${finder?.name || "不明"}

${caseFile.discovery.body}

━━━━━━━━━━

猫头鹰落在栏杆上，慢慢转了转脑袋。

「魔女审判，即将开始。
　在那之前，给你们一点时间——去翻，去问，去撒谎。」

调查阶段共 ${session.investigateRounds} 轮。私聊我提交行动：
  #调查 A　　　　　　搜查 A 区（打代号，也可以打地名）
  #询问 001 <问题>　 向 001 号囚犯打听（打编号，也可以打名字）

【区域】
${session.prison.locations.map((item) => `${item.code}. ${item.name}`).join("　")}

【在场囚犯】
${Object.values(session.girls).filter((girl) => girl.alive).map((girl) => `${girl.code} ${girl.name}`).join("　")}

搜到什么只有你自己知道。群里只会公布谁去了哪。
${renderTurnDeadline(session)}
全员提前提交会立即结算；未提交者到点按放弃本轮处理。`;
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
        ? `· ${item.actorCode} ${item.actorName} 去了 ${item.locationCode}「${item.locationName}」`
        : `· ${item.actorCode} ${item.actorName} 找 ${item.targetCode} ${item.targetName} 说了话`
    );
  if (moves.length) parts.push(`【去向】\n${moves.join("\n")}`);

  if (result.encounters.length) {
    parts.push(
      `【撞见】\n${result.encounters
        .map((item) => `· ${(item.labels || item.names).join(" 和 ")} 在 ${item.locationCode}「${item.locationName}」碰上了`)
        .join("\n")}`
    );
  }

  parts.push(
    result.phaseDone
      ? "调查阶段结束。猫头鹰宣布——魔女审判，现在开庭。"
      : `还剩 ${session.investigateRounds - session.round} 轮调查。\n${renderTurnDeadline(session)}`
  );

  return parts.join("\n\n");
}

export function renderTrialOpening(session, propositions) {
  // 不公布手法需要什么能力。
  // 那是推理的最后一步——从尸体和证物推出「这得靠什么本事才做得到」，
  // 再翻图鉴看谁有那个本事。直接念出来等于替玩家把题做完了。
  const methodBlock = `【尸检】
猫头鹰把一份验尸报告丢在地上，一个字也没多说。

「怎么弄的，你们自己看。
　我只要一个说得通的死因。」

⚠ 手法是什么、需要什么本事才做得到——报告里不会写，得你们自己从
　 尸体状态和搜到的证物里推。推出来之后，翻【#图鉴】看谁有那个本事，
　 谁又根本做不到。
⚠ 但记住：做得到不等于做了。所有人现在都是 0。`;

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

庭审共 ${session.trialRounds} 轮。**指令私聊我**，每轮一个：

  #主张 <命题编号>　　　　　　　　　把一个结论推上台面
  #出示 <证据编号> 支持 <命题编号>　用它撑起某个命题
  #出示 <证据编号> 反驳 <命题编号>　用它击碎某个命题
  #揭穿 <证据编号>　　　　　　　　拿一条牌检验台面上的可疑说辞
  #追问 001 <关于什么>　　　　　　　逼对方当众表态
  #回应 <结论编号> <说辞>　　　　　　被追问时用，不表态 +12

⚠ 主张或回应押中的结论会成为本轮焦点。
　 持有相关证据的 NPC 会优先围绕它出牌，所以主张能把藏在别人手里的信息逼上桌，
　 但如果你押错，真实反证出现时仍会 +10。

⚠ 追问不会给你带来证据——搜证是调查阶段的事。它是节奏交换：
　 你花一个动作，逼对方也花一个动作，而对方表的态会变成你下一轮的靶子。

⚠ 回应必须押一个**结论**（标着【指认】【自杀】【意外】的那些），
　 也就是当众说出「我认为她是怎么死的」，不能拿无关的事实搪塞。
　 除了真相之外，**每一个结论都有证据能把它打穿**——
　 押错了，别人一张牌下来你就是 +10。押对了，你等于替大家指了路。
　 不表态就是稳吃 +12。三条路都不好走，这是刻意的。

⚠ 出牌必须声明方向，而且可能打空。
　 你只看得见证物的名字和描述，看不见它到底能撑起什么、能击碎什么——
　 那要你自己从描述里推。推错了，牌白扔，人还多背一份嫌疑。

⚠ 反驳打不中会反噬：你涨嫌疑，牌还白白摊在了桌面上。

${renderTurnDeadline(session)}
全员提前提交会立即结算；未提交者到点按放弃本轮处理。`;
}

export function renderTrialTurn(session, result) {
  const parts = [`━━━ 庭审 ${session.round}/${session.trialRounds} ━━━\n\n${result.narration}`];

  // 判定行里也用编号，和发言格式对齐
  const label = (actorId, fallback) => {
    const girl = session.girls?.[actorId];
    return girl ? `${girl.code} ${girl.name}` : fallback;
  };
  result.moves.forEach((item) => {
    item.actorName = label(item.actorId, item.actorName);
  });

  const judged = result.moves
    .map((item) => {
      switch (item.kind) {
        case "play": {
          const dir = item.stance === "support" ? "支持" : "反驳";
          const tail = item.valid
            ? item.stance === "support"
              ? "——成立"
              : "——命中，命题倒台"
            : "——落空，反噬";
          return `${item.valid ? "✅" : "❌"} ${item.actorName} 出示「${item.evidenceName}」${dir}「${item.propText}」${tail}`;
        }
        case "claim":
          return `${item.stands ? "📌" : "💬"} ${item.actorName} 主张「${item.propText}」（支持 ${item.supports}/${item.threshold}${item.refuted ? "，已被否定" : ""}）`;
        case "question":
          return `❓ ${item.actorName} 追问 ${item.targetName}：${item.topic}\n　　└ 对方下一轮必须押一个结论表态，否则 +12`;
        case "answer":
          return `💬 ${item.actorName} 押「${item.propText}」表态${item.refuted ? "——可那条早就被推翻了" : ""}`;
        case "dodge":
          return `🙈 ${item.actorName} 回避了追问，嫌疑 +12`;
        case "fake":
          return `💬 ${item.actorName} 提出了一条暂时被法庭采信的说辞`;
        case "fake_failed":
          return `❌ ${item.actorName} 的说辞找不到任何可核验支点，当场被驳回，嫌疑 +8`;
        case "challenge":
          return item.success
            ? `🔥 ${item.actorName} 出示「${item.evidenceName}」揭穿了 ${item.fakerName} 的说辞；伪证撤下，伪造者 +25`
            : `❌ ${item.actorName} 用「${item.evidenceName}」揭穿失败；证据仍被公开，自己 +8`;
        case "fake_exposed":
          return `🔥 ${item.actorName} 先前的说辞被「${item.evidenceName}」戳穿并撤下，嫌疑 +25`;
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
    parts.push(
      `还剩 ${session.trialRounds - session.round} 轮。\n${renderTurnDeadline(session)}`
    );
  }

  return parts.join("\n\n");
}

export function renderSuspicionBoard(session) {
  const board = Object.values(session.girls)
    .filter((girl) => girl.alive)
    .sort((a, b) => b.suspicion - a.suspicion)
    .map((girl, index) => {
      const mark = index === 0 ? "⚠" : "·";
      return `${mark} ${girl.code} ${girl.name} ${girl.suspicion}`;
    });
  return `【嫌疑】\n${board.join("\n")}\n\n全员从 0 起算，只由证据和表现推动。\n超时未决时，最上面那个会被处刑。`;
}

// ===== 查询 =====

/**
 * 魔女图鉴
 *
 * 能力是公开信息，而且整个「设定系本格」的推理都建立在
 * 「谁的能力做得到这个手法」上——没有图鉴玩家就没法推理。
 * 已死和已处刑的少女也留在册子里：往前几章的推理还要用到她们的能力。
 * 唯一不进图鉴的是秘密，那是各人自己的事。
 */
export function renderCodex(session) {
  const girls = Object.values(session.girls || {});
  const alive = girls.filter((girl) => girl.alive);
  const gone = girls.filter((girl) => !girl.alive);

  const entry = (girl) => {
    const state = girl.alive
      ? `嫌疑 ${girl.suspicion}`
      : girl.fate === "victim"
        ? "已死亡"
        : "已处刑";
    return `${girl.alive ? "○" : "×"} ${girl.code}　${girl.name}　${girl.age}岁　${state}
　　能力：${girl.ability.name}
　　　可以：${girl.ability.can.join("、") || "（未定义）"}
　　　限制：${girl.ability.limit}`;
  };

  const pages = [
    `━━━ 魔女图鉴 ━━━
${session.prison?.name || "孤岛牢狱"}　第 ${session.chapter} 章

在场 ${alive.length} 人，退场 ${gone.length} 人。
能力是公开的——谁做得到、谁做不到，都写在这里。

⚠ 册子上不写谁是活人玩的、谁是这座牢狱自己长出来的。
　 你们之中有几个是真的，没有人知道——包括你以为你知道的那几个。

指令里可以直接打囚犯编号，比如【#询问 003 案发那晚你在哪】。`,
    `【在场】\n\n${alive.map(entry).join("\n\n") || "（无）"}`,
  ];

  if (gone.length) {
    pages.push(`【已退场】\n\n${gone.map(entry).join("\n\n")}`);
  }

  if (session.prison?.locations?.length) {
    pages.push(
      `【区域】\n\n${session.prison.locations.map((item) => `· ${item.name}\n  ${item.description}`).join("\n\n")}`
    );
  }
  if (session.prison?.rules?.length) {
    pages.push(`【牢狱规则】\n\n${session.prison.rules.map((item, i) => `${i + 1}. ${item}`).join("\n")}`);
  }

  return pages;
}

/** 图鉴的单人条目，比名录多出身世 */
export function renderCodexEntry(session, girl) {
  const state = girl.alive
    ? `在场　嫌疑 ${girl.suspicion}`
    : girl.fate === "victim"
      ? "已死亡"
      : "已处刑";

  return `━━━ ${girl.code}　${girl.name} ━━━
${girl.age}岁　${state}

【外貌】
${girl.appearance || "（未描述）"}

【身世】
${girl.profile || "（未描述）"}

【魔法能力】
${girl.ability.name}
  可以：${girl.ability.can.join("、") || "（未定义）"}
  限制：${girl.ability.limit}

${girl.secretExposed ? `【已曝光的秘密】\n${girl.secret}` : "【秘密】\n（还没有人翻出来）"}`;
}

/**
 * 私聊回执：你这一轮到底搜到了什么
 *
 * 群播报只公布「谁去了哪」，搜到什么是私密的——所以必须单独告诉当事人，
 * 否则玩家做完动作根本不知道自己拿到了什么，只能一遍遍去翻证物袋。
 * 回执里带编号，因为庭上出牌要用它。
 */
export function renderFinding(session, item) {
  const head = {
    search: `你搜查了 ${item.locationCode}「${item.locationName}」`,
    ask: `你找 ${item.targetCode} ${item.targetName} 问了话`,
    destroy: `你在 ${item.locationCode}「${item.locationName}」动了手脚`,
  }[item.kind];

  if (item.kind === "destroy") {
    const body = item.destroyed
      ? `你抹掉了「${item.evidenceName}」。\n${item.evidenceDesc}\n\n这条再也不会被任何人搜到了。`
      : "这里已经没有什么值得抹掉的了。";
    const seen = item.witnessed
      ? `\n\n⚠ 但${item.witnessNames.join("、")}也在这里。\n　 她们看见你在翻什么了——现场留下了被翻动的痕迹。`
      : "\n\n没有人看见。";
    return `━━━ 回执 ━━━\n\n${head}\n\n${body}${seen}`;
  }

  if (!item.found) {
    const empty =
      item.kind === "search"
        ? "什么也没找到——这里能翻的，你都翻过了。"
        : "她什么有用的都没说。该问的你已经问完了。";
    return `━━━ 回执 ━━━\n\n${head}\n\n${empty}`;
  }

  const related = (item.relatedPropIds || [])
    .map((propId) => session.caseFile?.propositions?.findIndex((prop) => prop.id === propId) + 1)
    .filter((index) => index > 0);
  const relationLine = related.length
    ? `\n　 涉及命题：${[...new Set(related)].join("、")}（方向仍要自己判断）`
    : "";

  return `━━━ 回执 ━━━

${head}

到手了：
  ${item.pouchIndex}. 「${item.evidenceName}」
　 ${item.evidenceDesc}${relationLine}

━━━━━━━━━━
这条只有你知道，群里不会公布。
庭上打出去用：#出示 ${item.pouchIndex} 支持 <命题编号>
　　　　　　　 #出示 ${item.pouchIndex} 反驳 <命题编号>
方向要自己判断——打空了会反噬。`;
}

export function renderPouch(session, girl, evidence) {
  if (!evidence.length) {
    return `【${girl.name} 的证物袋】\n\n空的。去【#调查 <地点>】或【#询问 <少女> <问题>】找点东西。`;
  }
  return `【${girl.name} 的证物袋】

${evidence.map((item, index) => {
  const state = session.destroyedEvidence?.includes(item.id)
    ? "　【已销毁】"
    : session.publicEvidence?.includes(item.id)
      ? "　【已公开】"
      : "";
  const related = [...new Set([...(item.supports || []), ...(item.refutes || [])])]
    .map((propId) => session.caseFile?.propositions?.findIndex((prop) => prop.id === propId) + 1)
    .filter((number) => number > 0);
  const relation = related.length
    ? `\n   涉及命题：${related.join("、")}（支持或反驳仍要自己判断）`
    : "";
  return `${index + 1}. 「${item.name}」${state}\n   ${item.description}${relation}`;
}).join("\n\n")}

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

export function renderVoteMenu(conclusions, session = null) {
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

采纳要获得**仍在场玩家票的过半数**，所以平票是没用的。
NPC 也会投票并在宣判时公开票型，但不能替玩家决定结论。
没有任何结论过半且成立时，猫头鹰会自己挑嫌疑最高的那个处刑。
而如果那时连一个人的嫌疑都是 0——她会把你们**全都**送上去。

${session ? `${renderTurnDeadline(session)}\n全员提前投完会立即点票；未投者到点按弃权处理。` : ""}`;
}

/**
 * 投票进度播报
 *
 * 只公布「谁投了」，不公布「投给了谁」——票型要到宣判才揭晓。
 * 但把没投的人点出来是必要的：投票卡住的时候得让大家知道在等谁。
 */
export function renderVoteProgress(session, justVoted) {
  const players = Object.values(session.girls).filter(
    (girl) => girl.alive && girl.kind === "player"
  );
  const voted = players.filter((girl) => session.votes?.[girl.id]);
  const pending = players.filter((girl) => !session.votes?.[girl.id]);

  // 点名「谁投了」等于点名谁是玩家——只有玩家用指令投票，NPC 的票是本地算的。
  // 所以只报进度，不报名字。票型到宣判才揭晓。
  const lines = [`🗳 又有人投了票（${voted.length}/${players.length}）`];
  if (pending.length) {
    lines.push(`还差 ${pending.length} 张。`);
  } else {
    lines.push("票齐了。猫头鹰开始点票…");
  }
  lines.push("\n谁投了谁、投给了谁，都要到宣判才揭晓。");

  return lines.join("\n");
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

  // 逐人标「已提交/未提交」会直接点破谁是玩家——只有玩家需要提交。
  // 所以这里不给个人标记，只给总数。
  const roster = Object.values(session.girls)
    .sort((a, b) => b.suspicion - a.suspicion)
    .map((girl) => {
      const mark = !girl.alive ? (girl.fate === "victim" ? "💀" : "⚰") : "·";
      const state = girl.alive ? `嫌疑 ${girl.suspicion}` : girl.fate === "victim" ? "已死亡" : "已处刑";
      return `${mark} ${girl.code} ${girl.name}　${state}`;
    })
    .join("\n");

  const roundText =
    session.phase === PHASES.INVESTIGATE
      ? `调查 ${session.round}/${session.investigateRounds}`
      : session.phase === PHASES.TRIAL
        ? `庭审 ${session.round}/${session.trialRounds}`
        : session.phase === PHASES.GENERATING && session.advancePending
          ? "上一章已结算，等待生成下一章"
        : phaseText;

  const historyBlock = session.history.length
    ? `\n【前几章】\n${session.history
        .map(
          (item) =>
            `第${item.chapter}章：${item.victimName} 死亡 → ${item.executedName || "无人"}被处刑 ${item.correct ? "✔判对" : "✘判错"}`
        )
        .join("\n")}`
    : "";

  const progressText =
    session.phase === PHASES.VOTING
      ? `玩家票已提交 ${Object.keys(session.votes || {}).length}/${livingPlayerCount} 人`
      : `本回合已提交 ${submitted.length}/${livingPlayerCount} 人`;

  const deadlineText = [PHASES.INVESTIGATE, PHASES.TRIAL, PHASES.VOTING].includes(
    session.phase
  )
    ? `\n${renderTurnDeadline(session)}`
    : "";

  return `【${session.prison?.name || "魔女审判"} · 第 ${session.chapter} 章】
${roundText}

${roster}

${progressText}${deadlineText}${historyBlock}`;
}

// ===== 收场 =====

export function renderVerdict(session, { verdict, executed, text }) {
  const sourceLabel = {
    truth: "真相被完整证成，当庭定案",
    vote: "投票通过",
    timeout: "超时未决，猫头鹰自行裁定",
    collapse: "审判崩坏 —— 无结论，且无一人被查出嫌疑",
  }[verdict.source];

  const executedLabel = verdict.collapsed
    ? `全员 ${verdict.executedIds.length} 人`
    : executed?.name || "无人";

  // 票型摊开。「2-2 打平」和「压根没人投」都会掉进超时，但玩家有权知道是哪一种。
  const props = session.caseFile?.propositions || [];
  const tallyLines = Object.entries(verdict.tally || {})
    .sort((a, b) => b[1] - a[1])
    .map(([propId, count]) => {
      const prop = props.find((item) => item.id === propId);
      return `　${count} 票　${prop?.text || propId}`;
    });

  const playerTallyLines = Object.entries(verdict.playerTally || {})
    .sort((a, b) => b[1] - a[1])
    .map(([propId, count]) => {
      const prop = props.find((item) => item.id === propId);
      return `　${count} 票　${prop?.text || propId}`;
    });
  const voteBlock = `【玩家票型】
${playerTallyLines.length ? playerTallyLines.join("\n") : "　没有玩家投出有效的一票。"}

【全场票型（含 NPC）】
${tallyLines.length ? tallyLines.join("\n") : "　没有人投出有效的一票。"}`;

  const parts = [
    `━━━ 第 ${session.chapter} 章 · 宣判 ━━━

【裁定方式】${sourceLabel}
【采纳的结论】${verdict.conclusionText || "（无）"}
【被处刑者】${executedLabel}

${voteBlock}`,
  ];

  if (text) parts.push(text);

  // 判对了才公布真相，判错时留着——玩家要在下一章开场才意识到自己错了
  if (verdict.collapsed) {
    parts.push(
      "⚖ 一整场审判，没有人拿出任何有分量的东西。\n\n" +
        "凶手确实死了——她和所有人一起死的。\n" +
        "但没有任何人知道她是谁。"
    );
  } else if (verdict.correct && executed) {
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
      // 自杀/意外的章节没有凶手，死者就是"凶手"，措辞要换掉
      const selfInflicted = item.truthType === VERDICT.SUICIDE || item.truthType === VERDICT.ACCIDENT;
      const culpritLine = selfInflicted
        ? `　真相：${item.truthType === VERDICT.SUICIDE ? "自杀" : "意外"}，没有凶手`
        : `　真凶：${item.culpritName}`;

      // 「她是无辜的」只在真的处刑了人、且判错时才成立
      const executedLine = item.executedName
        ? `　处刑：${item.executedName}${item.correct || item.collapsed ? "" : "　← 她是无辜的"}`
        : "　处刑：无人";

      const head = `第${item.chapter}章　${item.correct ? "✔" : "✘"}
　死者：${item.victimName}
${culpritLine}
${executedLine}`;

      if (!item.motive) return head;

      // 动机在判对的那一章已经当众讲过了，这里只补没讲过的
      const motiveLine = selfInflicted ? `　她为什么：${item.motive}` : `　动机：${item.motive}`;
      const unheard = item.correct
        ? ""
        : `\n　（这段话当时没有人听见）${item.confession ? `\n　「${item.confession}」` : ""}`;
      return `${head}\n${motiveLine}${unheard}`;
    })
    .join("\n\n");

  const label = {
    caught: "真凶伏法 —— 幸存者全部获释",
    wipeout: "玩家全灭 —— 魔女胜",
    lastOne: "只剩一人 —— 审判失去意义",
    exhausted: "章节耗尽 —— 真相沉入海底",
    collapse: "审判崩坏 —— 全员处刑，无人查出任何东西",
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
⚠ 牢里关着的少女，有些是活人在玩，有些是这座牢狱自己长出来的。
　 没有人知道哪个是哪个——她们搜证、举证、反驳、回避，做的事一模一样。
　 凶手可能是其中任何一个。

开局
  #创建审判 [题材]　建局并成为房主
  #加入审判 / #退出审判　每人同时只能参加一局；退出仅限招募阶段
  #开始审判　　　　房主开局

地点用代号 A/B/C，囚犯用编号 001/002，也都可以直接打名字。

调查阶段（私聊提交）
  #调查 A　　　　　　　 搜查 A 区，可能找到证据
  #询问 001 <问题>　　　私下向 001 号打听，问出来的只进你的袋子
  #湮灭 A　　　　　　　 仅凶手：销毁一条未被发现的证据

庭审阶段（私聊提交）
  #主张 <命题编号>　　　　　　　把结论推上台面
  #出示 <证据编号> 支持 <命题编号>
  #出示 <证据编号> 反驳 <命题编号>
  #揭穿 <证据编号>　　　　　　　检验一条可疑说辞；猜错会公开牌并 +8
  #追问 001 <关于什么>　　　　　 逼对方当众表态
  #回应 <结论编号> <说辞>　　　 押一个结论表态，不表态 +12
  #伪证 <命题编号> <说辞>　　　 仅凶手；每章一次，最后一轮不可用

  主张不是空喊：本轮被主张或回应押中的结论会成为焦点，
  持有相关证据的 NPC 会优先围绕它出牌。

【询问 vs 追问】
  #询问 只能在调查阶段用，是**搜证**：私下问出来的证言只进你的袋子。
  问题文本会影响取得哪条证言；完全没有关键词命中时才随机。
  #追问 只能在庭审阶段用，是**施压**：不给你任何证据，只逼对方表态。
  庭上挖不到新东西——该问的必须在调查阶段问完。

【三种代价】
  出牌打空　　+8　　你看不见证物的真实关系，方向得自己推
  押的结论被打穿　+10　除真相外每个结论都有证据能否定它
  回避追问　　+12　　不表态最贵，所以哪怕站不稳也该开口

秘密不影响任何判定，也问不出来。它只在你被处刑时才会被翻出来。

投票
  #投票 <编号>
  结论须获得仍在场玩家票的过半数；NPC 票只参与剧情和票型展示

查询
  #图鉴　　　　全体少女的能力与限制（推理的基础，含已退场的人）
  #图鉴 <名字>　单人详情，带身世
  #我的少女　　查看自己的能力与秘密
  #本章身份　　补领本章的凶手/无事发生私聊通知
  #证物袋　　　查看手里的牌
  #命题　　　　查看全部命题与支持数
  #法庭记录　　台面上的证据与证言
  #审判状态　　嫌疑排行与进度

其他
  #推进　　　　房主仅能在截止后兜底推进；管理员可紧急结算
  #结束审判　　房主或管理员终止本局`;
