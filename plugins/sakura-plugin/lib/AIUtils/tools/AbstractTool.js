export class AbstractTool {
  name = ''

  parameters = {}

  description = ''

  // 执行时给用户看的阶段名，如 "搜索" → “正在搜索…”。null 表示不显示进度（瞬间完成或本身就会发出可见结果）。
  // 也可以是 (args) => string|null，按参数决定。
  progressText = null

  func = async function () {}

  getProgressText (args = {}) {
    const text = typeof this.progressText === 'function'
      ? this.progressText(args)
      : this.progressText
    return text ? String(text) : null
  }

  function () {
    if (!this.parameters.type) {
      this.parameters.type = 'object'
    }
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters
    }
  }
} 