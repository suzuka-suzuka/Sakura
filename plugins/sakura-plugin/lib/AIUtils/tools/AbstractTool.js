export class AbstractTool {
  name = ''

  parameters = {}

  description = ''

  // 工具调用转发里的动作名（转发标题），尽量四个字以内，如 "联网搜索"。
  // null 表示不在转发里展示（瞬间完成、本身就是聊天动作或会发出可见结果）。
  // 也可以是 (args) => string|null，按参数决定。
  progressText = null

  // 工具调用转发里跟在动作名后面的说明，如搜索词。字段名字符串或 (args) => string。
  progressDetail = null

  func = async function () {}

  getProgressDetail (args = {}) {
    const detail = typeof this.progressDetail === 'function'
      ? this.progressDetail(args)
      : args[this.progressDetail]
    if (Array.isArray(detail)) return detail.join(' ')
    return detail ? String(detail) : ''
  }

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