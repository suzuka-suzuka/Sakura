import { AbstractTool } from "./AbstractTool.js"
import {
  loadSkillCatalog,
  loadSkillInstructions,
} from "../skills/registry.js"

const MAX_CATALOG_CHARS = 4000

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

export class SkillGuideTool extends AbstractTool {
  name = "SkillGuide"

  description = "按需加载任务 Skill。先根据可用 Skill 的简短描述判断是否匹配；只有匹配当前任务时才传入对应 id 读取完整指导，简单且无匹配项的任务不要调用。"

  parameters = {
    properties: {
      id: {
        type: "string",
        description: "需要加载的 Skill ID，必须来自工具描述中的可用 Skill 目录",
      },
    },
    required: ["id"],
  }

  async function(e) {
    const options = { includePrivate: Boolean(e?.isMaster) }
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

  func = async function (opts, e) {
    const options = { includePrivate: Boolean(e?.isMaster) }
    const id = String(opts?.id || "").trim()
    if (!id) return "必须提供 Skill ID。"
    const skill = await loadSkillInstructions(id, options)
    return [
      `Skill: ${skill.id}`,
      `名称: ${skill.name}`,
      `用途: ${skill.description}`,
      "",
      skill.instructions,
    ].join("\n")
  }
}
