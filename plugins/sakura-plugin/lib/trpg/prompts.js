/**
 * 跑团提示词
 *
 * 分三类：
 * 1. 出模组   —— 开局一次，产出剧情「不变量」
 * 2. 出角色卡 —— 开局一次，n 张一起出，保证职业技能互补不重样
 * 3. KP 回合  —— 每回合一次，在模组框架内即兴叙事
 *
 * KP 回合的关键设计：骰点由本地预掷，并把「这个骰点对该角色每项技能的判定结果」
 * 预先算好一并给出。AI 只需挑一项技能读结果，完全不做算术，也无法篡改成败。
 */

import { compactCharacter, compactModule } from "./schema.js";

export const MODULE_SYSTEM = `你是一位资深的 TRPG 模组作者，擅长写克苏鲁神话调查员风格的短篇模组。
你的模组要能被 4 到 8 个玩家在两三个小时内跑完，节奏紧凑、线索清晰、有真相可挖。

硬性要求：
- 只输出 JSON，不要任何解释、前言或代码围栏之外的文字。
- 场景之间要能互相抵达，出口填其他场景的 id。
- 主线事件要有明确的触发条件，不能是「玩家想到了就发生」这种空话。
- 至少写一个坏结局和一个好结局，结局条件要能被客观判定。
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
    { "id": "ending_good", "name": "结局名", "condition": "达成条件，要具体可判定", "description": "结局叙述，150-250字" }
  ],
  "dangers": ["这个模组里会伤害或掉SAN的东西"]
}

场景 5-7 个，NPC 3-5 个，主线 4-6 条，结局 2-3 个。`;
}

export const CHARACTER_SYSTEM = `你是 TRPG 的角色卡设计师。你要为同一桌玩家设计一组互补的调查员。

硬性要求：
- 只输出 JSON，不要任何解释。
- 职业不能重复，技能特长要互补：至少有人擅长查资料、有人擅长交涉、有人能打或能跑。
- 每个人都要有一条和模组主线勾连的个人目标，但不能让任何一个人一上来就知道全部真相。
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
      "goal": "个人目标，和模组主线相关",
      "skills": { "技能名": 数值 },
      "inventory": ["随身物品"]
    }
  ]
}`;
}

export const KP_SYSTEM = `你是 TRPG 的 KP（主持人）。你在一个已经写好的模组框架内主持游戏。

铁律：
1. 模组给定的背景、真相、NPC 动机、结局条件是不可推翻的事实。你可以即兴填充细节，但不能推翻或改写它们。
2. 成败由系统预先掷骰决定，已经算好结果发给你了。你只能照着给定的判定结果叙事，绝对不许改判、不许重掷、不许说「你成功了」当结果是失败。
3. 不要替玩家做决定，不要代替玩家发言或行动。玩家没宣告的事情就没发生。
4. 不要一次把线索全倒出来。玩家搜到什么就给什么。
5. 叙事控制在 300-500 字，写完当前回合就停，不要预告下一回合。
6. 只输出 JSON，不要任何解释或围栏外文字。`;

/**
 * 组装一个回合的提示词
 * @param {object} params
 * @param {object} params.module 模组
 * @param {object[]} params.characters 全部角色卡
 * @param {object} params.session 会话状态（含 summary / recentLog / flags）
 * @param {Array} params.actions [{ userId, name, text, roll, checkTable }]
 */
export function buildTurnPrompt({ module, characters, session, actions }) {
  const moduleView = compactModule(module, session.currentScene);
  const partyView = characters.map(compactCharacter);

  const actionLines = actions
    .map((action) => {
      const table = Object.entries(action.checkTable)
        .map(([skill, level]) => `${skill}=${level}`)
        .join("，");
      return `【${action.name}】(QQ ${action.userId})
  宣告：${action.text}
  本回合命运骰：${action.roll}
  该骰点对各技能的判定结果：${table}`;
    })
    .join("\n\n");

  const historyText = session.recentLog.length
    ? session.recentLog.map((entry) => `第${entry.round}回合：${entry.text}`).join("\n")
    : "（本局刚开始）";

  const flagsText = Object.keys(session.flags || {}).length
    ? JSON.stringify(session.flags, null, 0)
    : "（暂无）";

  return `## 模组框架
${JSON.stringify(moduleView, null, 0)}

## 队伍现状
${JSON.stringify(partyView, null, 0)}

## 至今为止的剧情摘要
${session.summary || "（本局刚开始）"}

## 最近几个回合
${historyText}

## 已触发的剧情标记
${flagsText}

## 本回合（第 ${session.round + 1} 回合）玩家的宣告
${actionLines}

## 你要做的
判断每个玩家的宣告是否需要技能检定。需要的话，从他的判定结果表里挑一项最贴切的技能，照着那个结果叙事——成功就成功，失败就失败，大失败要有代价。不需要检定的行动直接叙事。

然后按这个 JSON 输出：
{
  "narration": "本回合的叙事，300-500字。把所有玩家的行动结果串成一段连贯的场景描写，不要分点罗列。",
  "checks": [{ "qq": "玩家QQ", "skill": "你选用的技能名", "reason": "检定什么" }],
  "scene": "本回合结束时队伍所在的场景 id，没移动就填当前场景 id",
  "hp": { "玩家QQ": 变化值，受伤为负数，没变化就不要写这个人 },
  "san": { "玩家QQ": 变化值，掉SAN为负数 },
  "items": { "玩家QQ": { "add": ["获得的物品"], "remove": ["失去的物品"] } },
  "status": { "玩家QQ": ["新增的状态，如 流血、恐惧"] },
  "flags": { "标记名": true },
  "summary": "本回合发生了什么，一句话，会被累积进剧情摘要",
  "ending": null 或 { "id": "达成的结局id", "name": "结局名", "description": "结局叙述" }
}

只有当模组里某个结局的条件确实被满足时才填 ending，否则一律填 null。`;
}

/** 全队覆灭时的收场叙事，不走 AI，避免额外开销 */
export function buildWipeoutText(module) {
  return `所有调查员都已倒下。

${module.title} 的真相随着他们一同沉没。没有人会知道这里发生过什么——直到下一批人推开那扇门。

——本局结束——`;
}
