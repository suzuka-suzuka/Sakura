import fs from "node:fs/promises"
import path from "node:path"
import YAML from "js-yaml"
import { pluginRoot } from "../../path.js"

const USER_SKILLS_DIR = path.join(pluginRoot, "skills")
const BUILTIN_SKILLS_DIR = path.join(pluginRoot, "lib", "AIUtils", "skills", "builtin")
const MAX_INSTRUCTION_CHARS = 30000
const MAX_SUBSKILLS = 32
const SUBSKILLS_DIRNAME = "subskills"
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

function parseRequiredTools(value) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new Error("SKILL.md frontmatter 的 requiredTools 必须是数组")
  }

  const tools = value.map((item) => String(item || "").trim())
  if (tools.some((item) => !item)) {
    throw new Error("SKILL.md frontmatter 的 requiredTools 不能包含空值")
  }
  return [...new Set(tools)]
}

function parseMasterOnly(value) {
  if (value == null) {
    throw new Error("SKILL.md frontmatter 必须填写 masterOnly")
  }
  if (typeof value !== "boolean") {
    throw new Error("SKILL.md frontmatter 的 masterOnly 必须是布尔值")
  }
  return value
}

function normalizeEnabledTools(enabledTools) {
  if (enabledTools == null) return null
  if (!Array.isArray(enabledTools) && !(enabledTools instanceof Set)) {
    throw new TypeError("enabledTools 必须是数组或 Set")
  }
  return new Set(
    [...enabledTools]
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )
}

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

async function listMarkdownFiles(rootDir) {
  let entries
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(rootDir, entry.name))
    .sort((a, b) => a.localeCompare(b))
  if (files.length > MAX_SUBSKILLS) {
    throw new Error(`单个 Skill 最多包含 ${MAX_SUBSKILLS} 个子 Skill`)
  }
  return files
}

function parseMarkdownDocument(raw) {
  const document = String(raw || "").replace(/^\uFEFF/, "")
  const frontmatter = document.match(FRONTMATTER_RE)
  if (!frontmatter) {
    throw new Error("SKILL.md 必须以 YAML frontmatter 开头")
  }

  const input = YAML.load(frontmatter[1]) || {}
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("SKILL.md frontmatter 必须是对象")
  }

  return {
    input,
    instructions: document.slice(frontmatter[0].length).trimStart(),
  }
}

function parseSkillDocument(raw, packageDir, skillSource) {
  const { input, instructions } = parseMarkdownDocument(raw)

  const id = path.basename(packageDir)
  const name = String(input.name || "").trim()
  const description = String(input?.description || "").trim()
  const requiredTools = parseRequiredTools(input.requiredTools)
  const masterOnly = parseMasterOnly(input.masterOnly)
  if (!SKILL_ID_RE.test(id)) {
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
      requiredTools,
      masterOnly,
      source: skillSource,
      packageDir,
      instructionPath: path.join(packageDir, "SKILL.md"),
    },
    instructions,
  }
}

function parseSubskillDocument(raw, instructionPath, parentSkill) {
  const { input, instructions } = parseMarkdownDocument(raw)
  const id = path.basename(instructionPath, ".md")
  const name = String(input.name || "").trim()
  const description = String(input.description || "").trim()
  if (!SKILL_ID_RE.test(id)) {
    throw new Error("子 Skill 文件名必须是 1 到 80 位小写字母、数字、点、下划线或连字符")
  }
  if (!name || !description) {
    throw new Error("子 Skill frontmatter 必须填写 name 和 description")
  }
  if (input.masterOnly != null || input.requiredTools != null) {
    throw new Error("子 Skill 继承父 Skill 的 masterOnly 和 requiredTools，不能单独覆盖")
  }

  return {
    subskill: {
      version: Number(input.version || 1),
      id: `${parentSkill.id}/${id}`,
      localId: id,
      parentId: parentSkill.id,
      name,
      description,
      requiredTools: parentSkill.requiredTools,
      masterOnly: parentSkill.masterOnly,
      source: parentSkill.source,
      packageDir: parentSkill.packageDir,
      instructionPath,
    },
    instructions,
  }
}

async function loadSkillPackage(packageDir, source) {
  const instructionPath = path.join(packageDir, "SKILL.md")
  const raw = await fs.readFile(instructionPath, "utf8")
  if (raw.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(`SKILL.md 超过 ${MAX_INSTRUCTION_CHARS} 字符限制`)
  }
  return parseSkillDocument(raw, packageDir, source).skill
}

async function loadSubskillCatalog(parentSkill) {
  const subskills = []
  const errors = []
  const subskillsDir = path.join(parentSkill.packageDir, SUBSKILLS_DIRNAME)

  let files
  try {
    files = await listMarkdownFiles(subskillsDir)
  } catch (error) {
    return {
      subskills,
      errors: [{ instructionPath: subskillsDir, message: error.message || String(error) }],
    }
  }

  for (const instructionPath of files) {
    try {
      const raw = await fs.readFile(instructionPath, "utf8")
      if (raw.length > MAX_INSTRUCTION_CHARS) {
        throw new Error(`子 Skill 超过 ${MAX_INSTRUCTION_CHARS} 字符限制`)
      }
      subskills.push(
        parseSubskillDocument(raw, instructionPath, parentSkill).subskill,
      )
    } catch (error) {
      errors.push({ instructionPath, message: error.message || String(error) })
    }
  }

  subskills.sort((a, b) => a.id.localeCompare(b.id))
  return { subskills, errors }
}

export async function loadSkillCatalog({
  isMaster = true,
  enabledTools = null,
} = {}) {
  const skills = []
  const errors = []
  const seen = new Map()
  const enabledToolSet = normalizeEnabledTools(enabledTools)
  await fs.mkdir(USER_SKILLS_DIR, { recursive: true })
  const roots = [
    { rootDir: BUILTIN_SKILLS_DIR, source: "builtin" },
    { rootDir: USER_SKILLS_DIR, source: "user" },
  ]

  for (const { rootDir, source } of roots) {
    for (const packageDir of await listPackageDirs(rootDir)) {
      try {
        const skill = await loadSkillPackage(packageDir, source)
        if (seen.has(skill.id)) {
          throw new Error(`Skill ID 重复，已在 ${seen.get(skill.id)} 中定义`)
        }
        seen.set(skill.id, packageDir)
        const visibleToCaller = Boolean(isMaster) || !skill.masterOnly
        const dependenciesSatisfied = enabledToolSet == null
          || skill.requiredTools.every((toolName) => enabledToolSet.has(toolName))
        if (visibleToCaller && dependenciesSatisfied) {
          skills.push(skill)
        }
      } catch (error) {
        errors.push({ packageDir, message: error.message || String(error) })
      }
    }
  }

  skills.sort((a, b) => a.id.localeCompare(b.id))
  return { skills, errors }
}

export async function loadSkillInstructions(skillId, options = {}) {
  const requestedId = String(skillId || "").trim()
  const idParts = requestedId.split("/")
  if (
    idParts.length < 1
    || idParts.length > 2
    || idParts.some((item) => !SKILL_ID_RE.test(item))
  ) {
    throw new Error(`Skill ID 格式不合法：${requestedId}`)
  }

  const [parentId, subskillId] = idParts
  const { skills, errors } = await loadSkillCatalog(options)
  const skill = skills.find((item) => item.id === parentId)
  if (!skill) {
    const suffix = errors.length ? `；另有 ${errors.length} 个 Skill 加载失败` : ""
    throw new Error(`未找到 Skill：${requestedId}${suffix}`)
  }

  const { subskills, errors: subskillErrors } = await loadSubskillCatalog(skill)
  if (subskillId) {
    const subskill = subskills.find((item) => item.localId === subskillId)
    if (!subskill) {
      const suffix = subskillErrors.length
        ? `；另有 ${subskillErrors.length} 个子 Skill 加载失败`
        : ""
      throw new Error(`未找到子 Skill：${requestedId}${suffix}`)
    }

    const raw = await fs.readFile(subskill.instructionPath, "utf8")
    if (raw.length > MAX_INSTRUCTION_CHARS) {
      throw new Error(`子 Skill ${requestedId} 的说明超过 ${MAX_INSTRUCTION_CHARS} 字符限制`)
    }
    const { instructions } = parseSubskillDocument(
      raw,
      subskill.instructionPath,
      skill,
    )

    return {
      id: subskill.id,
      parentId: skill.id,
      name: subskill.name,
      description: subskill.description,
      requiredTools: subskill.requiredTools,
      masterOnly: subskill.masterOnly,
      source: subskill.source,
      instructions,
      subskills: [],
      subskillErrors: [],
    }
  }

  const raw = await fs.readFile(skill.instructionPath, "utf8")
  if (raw.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(`Skill ${skillId} 的说明超过 ${MAX_INSTRUCTION_CHARS} 字符限制`)
  }
  const { instructions } = parseSkillDocument(raw, skill.packageDir, skill.source)

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    requiredTools: skill.requiredTools,
    masterOnly: skill.masterOnly,
    source: skill.source,
    instructions,
    subskills: subskills.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      version: item.version,
    })),
    subskillErrors,
  }
}
