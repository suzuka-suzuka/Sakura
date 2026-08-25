import { AbstractTool } from "./AbstractTool.js"
import { loadSkillInstructions, searchSkills } from "../skills/registry.js"

export class SkillGuideTool extends AbstractTool {
  name = "SkillGuide"

  description = "按需搜索和加载项目 Skill 指导。遇到复杂、陌生或需要 RunCommand 的任务时，先搜索相关 Skill，再加载最匹配的一项以减少试错。Skill 只提供指导，不替代 RunCommand。"

  parameters = {
    properties: {
      action: {
        type: "string",
        enum: ["search", "list", "load"],
        description: "search 按关键词搜索；list 列出可用 Skill；load 加载指定 Skill 的完整指导",
      },
      query: {
        type: "string",
        description: "search 使用的任务关键词",
      },
      id: {
        type: "string",
        description: "load 使用的 Skill ID",
      },
    },
    required: ["action"],
  }

  func = async function (opts) {
    const action = String(opts?.action || "").trim().toLowerCase()
    if (action === "list" || action === "search") {
      const result = await searchSkills(action === "list" ? "" : opts?.query || "")
      if (result.matches.length === 0) {
        return "没有找到匹配的 Skill。"
      }
      return JSON.stringify({ skills: result.matches }, null, 2)
    }

    if (action === "load") {
      const id = String(opts?.id || "").trim()
      if (!id) return "load 必须提供 Skill ID。"
      const skill = await loadSkillInstructions(id)
      return [
        `Skill: ${skill.id}`,
        `名称: ${skill.name}`,
        `用途: ${skill.description}`,
        "",
        skill.instructions,
      ].join("\n")
    }

    return "action 仅支持 search、list 或 load。"
  }
}
