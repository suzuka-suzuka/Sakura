import fs from "node:fs/promises"
import path from "node:path"
import YAML from "js-yaml"
import { pluginRoot } from "../../path.js"

const PRIVATE_SKILLS_DIR = path.join(pluginRoot, "skills")
const MAX_INSTRUCTION_CHARS = 30000
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

async function listPackageDirs(rootDir) {
  let entries
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
}

function parseSkillDocument(raw, packageDir, scope) {
  const source = String(raw || "").replace(/^\uFEFF/, "")
  const frontmatter = source.match(FRONTMATTER_RE)
  if (!frontmatter) {
    throw new Error("SKILL.md 必须以 YAML frontmatter 开头")
  }

  const input = YAML.load(frontmatter[1]) || {}
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("SKILL.md frontmatter 必须是对象")
  }

  const id = path.basename(packageDir)
  const name = String(input.name || "").trim()
  const description = String(input?.description || "").trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(id)) {
    throw new Error("Skill 目录名必须是 1 到 80 位小写字母、数字、点、下划线或连字符")
  }
  if (!name || !description) {
    throw new Error("SKILL.md frontmatter 必须填写 name 和 description")
  }

  return {
    skill: {
      version: Number(input.version || 1),
      id,
      name,
      description,
      keywords: Array.isArray(input.keywords)
        ? input.keywords.map((item) => String(item).trim()).filter(Boolean)
        : [],
      scope,
      packageDir,
      instructionPath: path.join(packageDir, "SKILL.md"),
    },
    instructions: source.slice(frontmatter[0].length).trimStart(),
  }
}

async function loadSkillPackage(packageDir, scope) {
  const instructionPath = path.join(packageDir, "SKILL.md")
  const raw = await fs.readFile(instructionPath, "utf8")
  if (raw.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(`SKILL.md 超过 ${MAX_INSTRUCTION_CHARS} 字符限制`)
  }
  return parseSkillDocument(raw, packageDir, scope).skill
}

export async function loadSkillCatalog() {
  const skills = []
  const errors = []
  const seen = new Map()
  await fs.mkdir(PRIVATE_SKILLS_DIR, { recursive: true })
  const roots = [{ rootDir: PRIVATE_SKILLS_DIR, scope: "private" }]

  for (const { rootDir, scope } of roots) {
    for (const packageDir of await listPackageDirs(rootDir)) {
      try {
        const skill = await loadSkillPackage(packageDir, scope)
        if (seen.has(skill.id)) {
          throw new Error(`Skill ID 重复，已在 ${seen.get(skill.id)} 中定义`)
        }
        seen.set(skill.id, packageDir)
        skills.push(skill)
      } catch (error) {
        errors.push({ packageDir, message: error.message || String(error) })
      }
    }
  }

  skills.sort((a, b) => a.id.localeCompare(b.id))
  return { skills, errors }
}

function searchScore(skill, query) {
  const normalized = String(query || "").trim().toLowerCase()
  if (!normalized) return 1
  const tokens = normalized.split(/\s+/).filter(Boolean)
  const id = skill.id.toLowerCase()
  const name = skill.name.toLowerCase()
  const description = skill.description.toLowerCase()
  const keywords = skill.keywords.map((item) => item.toLowerCase())

  let score = 0
  for (const token of tokens) {
    if (id === token) score += 20
    else if (id.includes(token)) score += 10
    if (name.includes(token)) score += 8
    if (keywords.some((keyword) => keyword.includes(token) || token.includes(keyword))) score += 6
    if (description.includes(token)) score += 3
  }
  return score
}

export async function searchSkills(query = "", limit = 10) {
  const { skills, errors } = await loadSkillCatalog()
  const matches = skills
    .map((skill) => ({ skill, score: searchScore(skill, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, Math.max(1, Math.min(30, Number(limit) || 10)))
    .map(({ skill }) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      keywords: skill.keywords,
      scope: skill.scope,
    }))

  return { matches, errors }
}

export async function loadSkillInstructions(skillId) {
  const { skills, errors } = await loadSkillCatalog()
  const skill = skills.find((item) => item.id === skillId)
  if (!skill) {
    const suffix = errors.length ? `；另有 ${errors.length} 个 Skill 加载失败` : ""
    throw new Error(`未找到 Skill：${skillId}${suffix}`)
  }

  const raw = await fs.readFile(skill.instructionPath, "utf8")
  if (raw.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(`Skill ${skillId} 的说明超过 ${MAX_INSTRUCTION_CHARS} 字符限制`)
  }
  const { instructions } = parseSkillDocument(raw, skill.packageDir, skill.scope)

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    instructions,
  }
}
