/**
 * 消息排版
 *
 * 角色卡和开场白都很长，走合并转发，避免刷屏。
 * 回合播报走普通消息，保证群里能直接看到叙事。
 */

import { CHECK_LEVELS } from "./dice.js";
import { PHASES } from "./SessionStore.js";

/** 成功等级对应的提示图标，让群里一眼看出成败 */
const LEVEL_ICON = {
  [CHECK_LEVELS.CRITICAL]: "🌟",
  [CHECK_LEVELS.EXTREME]: "✨",
  [CHECK_LEVELS.HARD]: "✅",
  [CHECK_LEVELS.REGULAR]: "☑️",
  [CHECK_LEVELS.FAIL]: "❌",
  [CHECK_LEVELS.FUMBLE]: "💥",
};

/** 把若干段文本包成合并转发节点 */
export function buildNodes(segments, { selfId, nickname = "KP" } = {}) {
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

export function renderCharacterCard(character) {
  const attrLine = Object.entries(character.attrs)
    .map(([key, value]) => `${key}${value}`)
    .join("  ");

  const skillLines = Object.entries(character.skills)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => `  ${name} ${value}`)
    .join("\n");

  return `━━━ 角色卡 ━━━
${character.name}　${character.age}岁　${character.occupation}

【属性】
${attrLine}

【状态】
HP ${character.hp}/${character.maxHp}　MP ${character.mp}/${character.maxMp}　SAN ${character.san}/${character.maxSan}　移动 ${character.move}

【技能】
${skillLines}

【外貌】
${character.appearance || "（未描述）"}

【背景】
${character.background || "（未描述）"}

【你的目标】
${character.goal || "（未描述）"}

【随身物品】
${character.inventory.length ? character.inventory.join("、") : "（空）"}`;
}

export function renderModuleIntro(module) {
  return [
    `《${module.title}》
题材：${module.genre || "未标注"}
基调：${module.tone || "未标注"}`,
    `【开场】
${module.hook}`,
    `【当前场景】
${module.scenes.find((scene) => scene.id === module.startScene)?.description || module.scenes[0]?.description || ""}`,
  ];
}

export function renderTurn({ round, narration, checks, events }) {
  const parts = [`━━━ 第 ${round} 回合 ━━━\n\n${narration}`];

  if (checks.length) {
    const lines = checks.map((check) => {
      const icon = LEVEL_ICON[check.level] || "🎲";
      const reason = check.reason ? `（${check.reason}）` : "";
      return `${icon} ${check.name} ${check.skill}${reason} ${check.roll}/${check.value} → ${check.level}`;
    });
    parts.push(`【本回合检定】\n${lines.join("\n")}`);
  }

  if (events.length) {
    parts.push(`【状态变化】\n${events.join("\n")}`);
  }

  return parts.join("\n\n");
}

export function renderStatus(session, characters) {
  const phaseText = {
    [PHASES.RECRUITING]: "招募中",
    [PHASES.GENERATING]: "正在生成模组",
    [PHASES.PLAYING]: "进行中",
    [PHASES.ENDED]: "已结束",
  }[session.phase] || session.phase;

  if (session.phase === PHASES.RECRUITING) {
    const roster = session.players
      .map((player, index) => `${index + 1}. ${player.nickname}${player.userId === session.hostId ? "（房主）" : ""}`)
      .join("\n");
    return `【跑团 · ${phaseText}】
题材：${session.theme || "由 AI 自选"}
已加入 ${session.players.length}/${session.maxPlayers} 人：
${roster}

房主发送【#开始跑团】即可开局。`;
  }

  const scene = session.module?.scenes.find((item) => item.id === session.currentScene);
  const submitted = Object.keys(session.pendingActions || {});
  const aliveList = characters.filter((character) => character.alive);

  const roster = characters
    .map((character) => {
      const mark = character.alive ? (submitted.includes(character.userId) ? "✅" : "⏳") : "💀";
      const status = character.status.length ? `［${character.status.join("、")}］` : "";
      return `${mark} ${character.name}　HP ${character.hp}/${character.maxHp}　SAN ${character.san}/${character.maxSan}${status}`;
    })
    .join("\n");

  return `【${session.module?.title || "跑团"} · ${phaseText}】
第 ${session.round} 回合　当前场景：${scene?.name || "未知"}

${roster}

本回合已宣告 ${submitted.length}/${aliveList.length} 人（✅已交 ⏳未交 💀出局）
${session.summaryLines.length ? `\n【剧情回顾】\n${session.summaryLines.slice(-5).join("\n")}` : ""}`;
}

export function renderEnding(module, ending, characters) {
  const survivors = characters.filter((character) => character.alive);

  return `━━━ 本局终 ━━━

【${ending.name}】

${ending.description}

——《${module.title}》完——

存活：${survivors.length ? survivors.map((character) => character.name).join("、") : "无人生还"}
出局：${characters.length - survivors.length} 人`;
}

export const HELP_TEXT = `【AI 跑团 · 指令】

开局
  #创建跑团 [题材]　　建局并成为房主
  #加入跑团　　　　　加入本群的局
  #退出跑团　　　　　离开
  #开始跑团　　　　　房主开局，AI 出模组并私聊发卡

游玩
  #行动 <你要做什么>　提交本回合宣告（群里或私聊都行）
  #推进　　　　　　　房主强制结算本回合
  #我的角色卡　　　　私聊补发角色卡
  #跑团状态　　　　　查看当前进度
  #结束跑团　　　　　房主或管理员终止本局

骰子
  .r 1d100　　　　　随手掷骰
  #检定 <技能>　　　主动做一次技能检定

全员交完宣告会自动结算，不用等房主。`;
