import { loadSkillInstructions } from "../skills/registry.js";

const SKILL_FRIENDLY_NAMES = Object.freeze({
  "nai5-image-generation": "NovelAI 绘图指南",
  "nai5-image-generation/composition-lighting": "构图与光线",
  "nai5-image-generation/multi-character": "多角色构图",
  "nai5-image-generation/prompt-language": "提示词语言",
  "nai5-image-generation/style-brushwork": "画风与笔触",
  "nai5-image-generation/text-rendering": "画面文字",
  "skill-creator": "Skill 创建指南",
});

function shortenText(text, maxLength = 80) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function buildTextNode(e, nickname, text) {
  return {
    user_id: e?.self_id || e?.bot?.self_id,
    nickname,
    content: [{ type: "text", data: { text } }],
  };
}

function buildNaiVisualPayload(e, toolArgs = {}) {
  const mainPrompt = String(toolArgs?.prompt || "").trim() || "（未提供 Prompt）";
  const characterPrompts = Array.isArray(toolArgs?.characters)
    ? toolArgs.characters
      .map((character) => String(character?.prompt || "").trim())
      .filter(Boolean)
    : [];

  return {
    nodes: [
      buildTextNode(e, "主 Prompt", mainPrompt),
      ...characterPrompts.map((prompt, index) =>
        buildTextNode(e, `角色 ${index + 1} Prompt`, prompt)
      ),
    ],
    info: {
      source: "NAI 绘画",
      prompt: shortenText(mainPrompt),
      news: [{ text: shortenText(mainPrompt) }],
    },
  };
}

function humanizeSkillName(skill, skillId) {
  if (SKILL_FRIENDLY_NAMES[skillId]) {
    return SKILL_FRIENDLY_NAMES[skillId];
  }

  const metadataName = String(skill?.name || "").trim();
  const localId = String(skillId || "").split("/").pop() || "";
  if (metadataName && metadataName !== skillId && metadataName !== localId) {
    return metadataName;
  }

  const readableName = (metadataName || localId)
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .trim();
  return readableName || "Skill";
}

async function resolveSkillDisplayName(e, toolArgs = {}, toolContext = {}) {
  const skillId = String(toolArgs?.id || "").trim();
  if (!skillId) return "Skill";

  try {
    const skill = await loadSkillInstructions(skillId, {
      isMaster: Boolean(e?.isMaster),
      enabledTools: toolContext?.enabledTools || [],
    });
    return humanizeSkillName(skill, skillId);
  } catch {
    return SKILL_FRIENDLY_NAMES[skillId] || "Skill";
  }
}

function buildSkillVisualPayload(e, skillName) {
  const detail = `正在加载 Skill：${skillName}`;
  return {
    nodes: [buildTextNode(e, "Skill 加载", skillName)],
    info: {
      source: "Skill 加载",
      prompt: detail,
      news: [{ text: detail }],
    },
  };
}

export async function buildSpecialToolStartVisualPayloads(
  e,
  functionCalls = [],
  toolContext = {},
) {
  const payloads = [];
  for (const functionCall of functionCalls) {
    if (functionCall?.name === "NaiPainting") {
      payloads.push(buildNaiVisualPayload(e, functionCall.args));
    } else if (functionCall?.name === "SkillGuide") {
      const skillName = await resolveSkillDisplayName(
        e,
        functionCall.args,
        toolContext,
      );
      payloads.push(buildSkillVisualPayload(e, skillName));
    }
  }
  return payloads;
}
