import fs from "node:fs/promises"
import path from "node:path"
import { pluginresources } from "../../path.js"
import { validateMap } from "./MapValidator.js"

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

export class MapLoader {
  constructor({ mapsDir = path.join(pluginresources, "monopoly", "maps") } = {}) {
    this.mapsDir = mapsDir
    this.cache = new Map()
  }

  resolvePath(mapFile) {
    const normalized = String(mapFile || "")
    if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
      throw new TypeError("大富翁地图文件名只能包含小写字母、数字和连字符")
    }
    return path.join(this.mapsDir, `${normalized}.json`)
  }

  async load(mapFile = "default-24", { reload = false } = {}) {
    if (!reload && this.cache.has(mapFile)) return this.cache.get(mapFile)

    const filePath = this.resolvePath(mapFile)
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8"))
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`大富翁地图 JSON 无法解析：${error.message}`)
      }
      throw error
    }

    const map = deepFreeze(validateMap(parsed))
    this.cache.set(mapFile, map)
    return map
  }

  clear() {
    this.cache.clear()
  }
}

export { deepFreeze }
