import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const projectRoot = process.cwd()
const _path = projectRoot.replace(/\\/g, "/")

const runtimeFilePath = fileURLToPath(import.meta.url)
const runtimeLibDir = path.dirname(runtimeFilePath)
const runtimePluginRoot = path.resolve(runtimeLibDir, "..")

const pluginName = path.basename(runtimePluginRoot)
const originalPluginRoot = path.join(projectRoot, "plugins", pluginName)

// 生产环境通常从项目根目录启动，资源取 `项目/plugins/<name>`；但脚本 / workspace 命令可能
// 直接从插件目录启动，此时旧逻辑会重复拼出 `plugins/<name>/plugins/<name>`。候选路径真实存在
// 才使用，否则退回当前模块所在的插件目录。这样不依赖 cwd，也不会让状态图静默变成空串。
const useOriginalPluginRoot = process.env.NODE_ENV === "production" && fs.existsSync(originalPluginRoot)
const pluginRoot = useOriginalPluginRoot ? originalPluginRoot : runtimePluginRoot

const plugindata = path.join(pluginRoot, "data")
const pluginresources = path.join(pluginRoot, "resources")
const configRoot = path.join(projectRoot, "config")
const pluginConfigDir = path.join(configRoot, pluginName)
const logRoot = path.join(projectRoot, "logs")

export {
  _path,
  projectRoot,
  pluginName,
  pluginRoot,
  originalPluginRoot,
  runtimePluginRoot,
  useOriginalPluginRoot,
  plugindata,
  pluginresources,
  configRoot,
  pluginConfigDir,
  logRoot,
}
