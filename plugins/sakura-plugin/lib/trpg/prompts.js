/**
 * 跑团提示词
 *
 * 分四类：
 * 1. 出模组   —— 开局一次，产出剧情「不变量」，含结局所依赖的剧情标记词表
 * 2. 出角色卡 —— 开局一次，n 张一起出，顺带给每人一个个人目标标记
 * 3. KP 回合  —— 每回合一次，在模组框架内即兴，并给出建议选项
 * 4. 终章     —— 收场时一次，把预写的结局落到本局实际发生的事情上
 *
 * 两条贯穿始终的设计约束：
 * - 骰子由本地预掷，并把「该骰点对每项技能的判定结果」算好一并给出，
 *   KP 只读结果不做算术，也无法篡改成败。
 * - 是否达成结局由本地对剧情标记求值决定，KP 无权宣布收场，只能设置标记。
 */

import { compactCharacter, compactModule } from "./schema.js";

export const PACING = {
  OPENING: "opening",
  MIDDLE: "middle",
  CLOSING: "closing",
  FINAL: "final",
};

const PACING_GUIDE = {
  [PACING.OPENING]: "铺陈阶段。多给环境细节和能查的线索，让玩家自己摸索，不用急着推主线。",
  [PACING.MIDDLE]: "加压阶段。让 NPC 摊牌或提要求，把危险从传闻变成眼前的东西，主线该往前挪了。",
  [PACING.CLOSING]: "收束阶段。主动把还没达成的关键线索推到玩家面前，制造必须做选择的局面，不要再铺新支线。",
  [PACING.FINAL]: "终局阶段。这是最后一两个回合，把悬而未决的东西全摊开，逼出结果，绝对不要引入新线索或新角色。",
};

/**
 * 把「已跑回合数 / 回合上限」换算成叙事阶段
 *
 * 给 KP 裸数字它容易机械反应（每回合都在写「时间不多了」），
 * 所以主要给阶段和对应的行动指令，数字只作为辅助。
 * @param {number} round 已完成的回合数
 * @param {number} maxRounds 回合上限，<=0 表示不限
 */
export function describePacing(round, maxRounds) {
  if (!maxRounds || maxRounds <= 0) {
    return { unlimited: true, phase: PACING.MIDDLE, remaining: null, maxRounds: 0, round };
  }

  const remaining = Math.max(0, maxRounds - round);
  const ratio = round / maxRounds;

  let phase = PACING.OPENING;
  if (remaining <= 2) phase = PACING.FINAL;
  else if (ratio >= 0.75) phase = PACING.CLOSING;
  else if (ratio >= 1 / 3) phase = PACING.MIDDLE;

  return { unlimited: false, phase, remaining, maxRounds, round };
}

export function pacingGuide(pacing) {
  return PACING_GUIDE[pacing.phase] || PACING_GUIDE[PACING.MIDDLE];
}

export const MODULE_SYSTEM = `你是一位资深的 TRPG 模组作者，擅长写克苏鲁神话调查员风格的短篇模组。
你的模组要能被 4 到 8 个玩家在两三个小时内跑完，节奏紧凑、线索清晰、有真相可挖。

硬性要求：
- 只输出 JSON，不要任何解释、前言或代码围栏之外的文字。
- 场景之间要能互相抵达，出口填其他场景的 id。
- 必须先定义一份「剧情标记」词表，再用这些标记拼出结局条件。结局能不能达成由系统按标记判定，不是靠描述。
- 标记要写成客观可判定的事件，比如「找到地窖钥匙」「得知四楼死过人」，不要写成「玩家感到害怕」这种主观状态。
- 至少写一个坏结局和一个好结局。
- 隐藏内容要标明该用什么技能才能发现。`;

export function buildModulePrompt({ playerCount, theme, tone }) {
  const themeText = theme ? `题材要求：${theme}` : "题材自选，优先近现代都市怪谈或民国怪谈。";
  const toneText = tone ? `基调要求：${tone}` : "基调偏悬疑惊悚，可以有超自然元素。";

  return `请为 ${playerCount} 位玩家设计一个可跑的短篇模组。

${themeText}
${toneText}

按这个 JSON 结构输出：
{
  "title": "模组标题",
  "genre": "题材",
  "tone": "基调，一句话",
  "background": "世界观与案件背景，300-500字，写清楚到底发生了什么、真相是什么",
  "hook": "开场引子，200-300字，玩家为什么会聚在一起、当下身处何地",
  "startScene": "起始场景的 id",
  "storyFlags": [
    { "name": "标记名，6-12字的客观事件", "description": "什么情况下算达成，一句话" }
  ],
  "scenes": [
    {
      "id": "英文或拼音小写下划线id",
      "name": "场景名",
      "description": "场景描述，150-250字",
      "features": ["可交互的物件或人"],
      "exits": ["能去往的其他场景 id"],
      "secrets": [{ "description": "藏在这里的线索或真相", "skill": "需要的技能，如 侦查", "note": "发现后的额外提示" }]
    }
  ],
  "npcs": [
    { "name": "姓名", "role": "身份", "personality": "性格，一句话", "motive": "他想要什么", "secret": "他瞒着什么" }
  ],
  "mainline": [
    { "id": "beat_1", "title": "事件名", "trigger": "触发条件，要具体可判定", "outcome": "触发后发生什么" }
  ],
  "endings": [
    {
      "id": "ending_good",
      "name": "结局名",
      "description": "结局叙述，150-250字",
      "requires": {
        "all": ["必须全部达成的标记名"],
        "any": ["达成其中任意一个即可的标记名，可以是空数组"],
        "none": ["只要达成了任意一个就不算这个结局，可以是空数组"]
      }
    }
  ],
  "dangers": ["这个模组里会伤害或掉SAN的东西"]
}

要求：
- 场景 5-7 个，NPC 3-5 个，主线 4-6 条。
- storyFlags 写 6-10 个，要覆盖「查明真相」「拿到关键道具」「触发危险」这几类。
- endings 写 2-3 个，requires 里出现的标记名必须来自 storyFlags，一个字都不能差。
- 好结局的条件要比坏结局难，但不能难到必须集齐全部标记。`;
}

export const CHARACTER_SYSTEM = `你是 TRPG 的角色卡设计师。你要为同一桌玩家设计一组互补的调查员。

硬性要求：
- 只输出 JSON，不要任何解释。
- 职业不能重复，技能特长要互补：至少有人擅长查资料、有人擅长交涉、有人能打或能跑。
- 每个人都要有一条和模组主线勾连的个人目标，但不能让任何一个人一上来就知道全部真相。
- 个人目标要能被客观判定是否完成，因为系统会在收场时逐人结算。
- 技能值范围 5-80，每人给 8-12 项技能。不要给属性值，属性由系统掷骰决定。`;

export function buildCharacterPrompt({ module, players }) {
  const roster = players
    .map((player, index) => `${index + 1}. QQ ${player.userId}，群昵称「${player.nickname}」`)
    .join("\n");

  return `模组信息：
标题：${module.title}
基调：${module.tone}
背景：${module.background}
引子：${module.hook}
主要NPC：${module.npcs.map((npc) => `${npc.name}(${npc.role})`).join("、")}
已有的剧情标记：${module.storyFlags.map((flag) => flag.name).join("、")}

本桌玩家：
${roster}

请为这 ${players.length} 位玩家各设计一张角色卡，按玩家顺序一一对应。输出：
{
  "characters": [
    {
      "userId": "对应玩家的QQ号，原样抄回",
      "name": "角色姓名",
      "occupation": "职业",
      "age": 年龄数字,
      "appearance": "外貌，一两句",
      "background": "角色背景，150-250字，说明他为什么会卷进这件事",
      "goal": "个人目标，和模组主线相关，要能判定完成与否",
      "goalFlag": "这个个人目标的标记名，6-12字，不要和已有剧情标记重名",
      "skills": { "技能名": 数值 },
      "inventory": ["随身物品"]
    }
  ]
}`;
}

export const KP_SYSTEM = `你是 TRPG 的 KP（主持人）。你在一个已经写好的模组框架内主持游戏。

铁律：
1. 模组给定的背景、真相、NPC 动机是不可推翻的事实。你可以即兴填充细节，但不能推翻或改写它们。
2. 成败由系统预先掷骰决定，已经算好结果发给你了。你只能照着给定的判定结果叙事，绝对不许改判、不许重掷、不许说「你成功了」当结果是失败。
3. 你无权宣布游戏结束。是否达成结局由系统按剧情标记判定，你只负责在条件真的发生时设置对应标记。
4. 剧情标记只能从给定的词表里选，一个字都不能改，也不许自己发明新标记。
5. 不要替玩家做决定，不要代替玩家发言或行动。玩家没宣告的事情就没发生。
6. 不要一次把线索全倒出来。玩家搜到什么就给什么。
7. 只输出 JSON，不要任何解释或围栏外文字。

你的职责不止是响应玩家，还要推着故事走：
- 玩家宣告了做不到的事（角色能力、当前处境、物理常识不允许），要直接驳回，在叙事里写清楚为什么没做成，不要强行圆。
- 每回合至少让世界发生一件玩家没主动触发的事：NPC 找上门、时间流逝带来变化、危险逼近、线索自己浮现。不能整回合都在被动等玩家戳。
- 玩家原地打转两回合以上时，主动施压：制造响动、让 NPC 催促、让威胁具体化。
- 剧烈行动（搏斗、狂奔、强行破拆、长时间搜索）之后，给对应角色挂上「力竭」状态。系统会让力竭角色的检定更难，你不用管数值。
- 会告诉你本局还剩多少回合。这个信息只用来决定你推进的力度，**绝对不许在叙事里提到回合数、剩余回合或任何游戏机制术语**，玩家读到的必须是纯粹的故事。`;

/**
 * 组装一个回合的提示词
 * @param {object} params
 * @param {object} params.module 模组
 * @param {object[]} params.characters 全部角色卡
 * @param {object} params.session 会话状态（含 summary / recentLog / flags）
 * @param {Array} params.actions [{ userId, name, text, roll, checkTable, exhausted }]
 * @param {string[]} params.flagVocabulary 允许使用的剧情标记名
 * @param {string[]} params.pendingFlags 尚未达成、且结局还用得上的标记
 */
export function buildTurnPrompt({ module, characters, session, actions, flagVocabulary, pendingFlags, pacing }) {
  const moduleView = compactModule(module, session.currentScene);
  const partyView = characters.map(compactCharacter);

  const actionLines = actions
    .map((action) => {
      const table = Object.entries(action.checkTable)
        .map(([skill, level]) => `${skill}=${level}`)
        .join("，");
      return `【${action.name}】(QQ ${action.userId})
  宣告：${action.text}
  本回合命运骰：${action.roll}${action.exhausted ? "（该角色处于力竭，下面的判定已按惩罚后的技能值算过）" : ""}
  该骰点对各技能的判定结果：${table}`;
    })
    .join("\n\n");

  const historyText = session.recentLog.length
    ? session.recentLog.map((entry) => `第${entry.round}回合：${entry.text}`).join("\n")
    : "（本局刚开始）";

  const achievedFlags = Object.keys(session.flags || {}).filter((key) => session.flags[key]);

  // 没传节奏信息就按不限回合处理，不要因为少个可选参数就崩
  const pace = pacing && !pacing.unlimited ? pacing : null;
  const pacingText = pace
    ? `本局上限 ${pace.maxRounds} 回合，这是第 ${session.round + 1} 回合，打完之后还剩 ${Math.max(0, pace.remaining - 1)} 回合。
${pacingGuide(pace)}`
    : "本局不限回合，按故事自然的节奏走。";

  return `## 模组框架
${JSON.stringify(moduleView, null, 0)}

## 队伍现状
${JSON.stringify(partyView, null, 0)}

## 至今为止的剧情摘要
${session.summary || "（本局刚开始）"}

## 最近几个回合
${historyText}

## 剧情标记
可用的标记词表（只能从这里选）：${flagVocabulary.join("、") || "（无）"}
已经达成的：${achievedFlags.join("、") || "（暂无）"}
还没达成、且结局还用得上的：${pendingFlags.join("、") || "（无）"}

## 节奏
${pacingText}

## 本回合（第 ${session.round + 1} 回合）玩家的宣告
${actionLines}

## 你要做的
判断每个玩家的宣告是否需要技能检定。需要的话，从他的判定结果表里挑一项最贴切的技能，照着那个结果叙事——成功就成功，失败就失败，大失败要有代价。不需要检定的行动直接叙事。做不到的事直接驳回。

然后按这个 JSON 输出：
{
  "narration": "本回合的叙事，300-500字。把所有玩家的行动结果串成一段连贯的场景描写，不要分点罗列。记得让世界也发生点什么。",
  "checks": [{ "qq": "玩家QQ", "skill": "你选用的技能名", "reason": "检定什么" }],
  "scene": "本回合结束时队伍所在的场景 id，没移动就填当前场景 id",
  "hp": { "玩家QQ": 变化值，受伤为负数，没变化就不要写这个人 },
  "san": { "玩家QQ": 变化值，掉SAN为负数 },
  "items": { "玩家QQ": { "add": ["获得的物品"], "remove": ["失去的物品"] } },
  "status": { "玩家QQ": ["新增的状态，如 流血、恐惧、力竭"] },
  "flags": ["本回合真正达成的标记名，必须逐字来自词表；没达成就给空数组"],
  "options": [
    { "text": "一条具体的建议行动，20字以内，写成玩家视角的祈使句", "hint": "会用到的技能或风险提示，10字以内，可以留空" }
  ],
  "summary": "本回合发生了什么，一句话，会被累积进剧情摘要"
}

options 给 3 到 4 条，要求：
- 必须至少有一条能推动「还没达成、且结局还用得上的」标记，但不要在文字里直接点破标记名。
- 各条之间要有实质差别，不要是同一件事的不同说法。
- 只写当前场景和处境下真的做得到的事。`;
}

/** 达成结局时追加的一次调用：把预写的结局落到本局实际发生的事情上 */
export function buildFinalePrompt({ module, ending, session, characters, goalResults }) {
  const goalText = goalResults
    .map((item) => `${item.name}：${item.goal}（${item.achieved ? "已完成" : "未完成"}）`)
    .join("\n");

  return `本局跑团结束了，请写终章。

## 模组
${module.title}｜${module.tone}
${module.background}

## 达成的结局
${ending.name}
预写的结局梗概：${ending.description}

## 这一局实际发生了什么
${session.summaryLines.join("\n") || "（无记录）"}

## 队伍最终状态
${characters.map((c) => `${c.name}（${c.occupation}）HP ${c.hp}/${c.maxHp}　SAN ${c.san}/${c.maxSan}${c.alive ? "" : "　已出局"}`).join("\n")}

## 各人的个人目标
${goalText || "（无）"}

请写一段 400-600 字的终章，直接输出正文，不要 JSON、不要标题、不要任何前后缀。要求：
- 承接预写的结局梗概，但必须用这一局真实发生过的事情和人物来收尾。
- 逐个交代每位角色的下场，个人目标完成与否要体现出来，但不要写成清单。
- 已经出局的角色也要给个交代。
- 最后一句留一点余味，不要总结陈词。`;
}

/** 全队覆灭时的收场叙事，不走 AI，避免额外开销 */
export function buildWipeoutText(module) {
  return `所有调查员都已倒下。

${module.title} 的真相随着他们一同沉没。没有人会知道这里发生过什么——直到下一批人推开那扇门。

——本局结束——`;
}
