import { AbstractTool } from "./AbstractTool.js"
import {
  loadSkillCatalog,
  loadSkillInstructions,
} from "../skills/registry.js"

const MAX_CATALOG_CHARS = 4000
const MAX_SUBSKILL_CATALOG_CHARS = 4000

function buildSkillOptions(e, context = {}) {
  return {
    isMaster: Boolean(e?.isMaster),
    enabledTools: context?.enabledTools || [],
  }
}

function clipText(text, maxChars) {
  const value = String(text || "").replace(/\s+/g, " ").trim()
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

export function buildSkillCatalogText(skills, maxChars = MAX_CATALOG_CHARS) {
  const header = [
    "可用 Skill 元数据如下。先根据当前任务与 description 判断是否匹配；匹配时调用本工具并传入对应 id，不匹配时不要调用：",
  ]
  let output = header.join("\n")

  for (const skill of skills) {
    const displayName = skill.name && skill.name !== skill.id
      ? `${skill.id} (${skill.name})`
      : skill.id
    const line = `\n- ${displayName}: ${clipText(skill.description, 360)}`
    if (output.length + line.length > maxChars) {
      const marker = "\n- …目录已按上下文预算截断。"
      output += marker.slice(0, Math.max(0, maxChars - output.length))
      break
    }
    output += line
  }

  return output.slice(0, maxChars)
}

export function buildSubskillCatalogText(
  parentId,
  subskills,
  maxChars = MAX_SUBSKILL_CATALOG_CHARS,
) {
  let output = [
    `本 Skill 包含以下子 Skill。继续根据当前任务与 description 判断，只加载真正需要的子 Skill；调用 SkillGuide 时传入完整层级 ID：`,
  ].join("\n")

  for (const subskill of subskills) {
    const displayName = subskill.name && subskill.name !== subskill.id
      ? `${subskill.id} (${subskill.name})`
      : subskill.id
    const line = `\n- ${displayName}: ${clipText(subskill.description, 360)}`
    if (output.length + line.length > maxChars) {
      const marker = "\n- …子 Skill 目录已按上下文预算截断。"
      output += marker.slice(0, Math.max(0, maxChars - output.length))
      break
    }
    output += line
  }

  if (!subskills.length) {
    output += `\n- ${parentId} 当前没有子 Skill。`
  }
  return output.slice(0, maxChars)
}

export class SkillGuideTool extends AbstractTool {
  name = "SkillGuide"

  description = "按需加载任务 Skill。先根据可用父 Skill 的简短描述判断是否匹配；加载父 Skill 后若返回子 Skill 目录，再按 description 选择真正需要的子 Skill。简单且无匹配项的任务不要调用。"

  parameters = {
    properties: {
      id: {
        type: "string",
        description: "需要加载的 Skill ID。父 Skill ID 必须来自工具描述；子 Skill ID 必须来自已加载父 Skill 返回的子 Skill 目录",
      },
    },
    required: ["id"],
  }

  async function(e, context = {}) {
    const options = buildSkillOptions(e, context)
    const { skills } = await loadSkillCatalog(options)

    return {
      name: this.name,
      description: `${this.description}\n\n${buildSkillCatalogText(skills)}`,
      parameters: {
        ...this.parameters,
        type: this.parameters.type || "object",
        properties: {
          ...this.parameters.properties,
        },
      },
    }
  }

  func = async function (opts, e, context = {}) {
    const options = buildSkillOptions(e, context)
    const id = String(opts?.id || "").trim()
    if (!id) return "必须提供 Skill ID。"
    const skill = await loadSkillInstructions(id, options)
    const result = [
      `Skill: ${skill.id}`,
      `名称: ${skill.name}`,
      `用途: ${skill.description}`,
      "",
      skill.instructions,
    ]
    if (skill.subskills?.length) {
      result.push(
        "",
        buildSubskillCatalogText(skill.id, skill.subskills),
      )
    }
    if (skill.subskillErrors?.length) {
      result.push(
        "",
        `注意：另有 ${skill.subskillErrors.length} 个子 Skill 加载失败，不能使用。`,
      )
    }
    return result.join("\n")
  }
}
