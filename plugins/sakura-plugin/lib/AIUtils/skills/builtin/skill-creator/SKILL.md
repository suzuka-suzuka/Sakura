---
name: skill-creator
description: 当主人明确要求为 Sakura 的 AI 创建、修改、重写或检查一个按需加载的 Skill 时使用。负责确定父 Skill、按需子 Skill、触发描述、工具依赖和安全边界，并通过 RunCommand 写入或更新相关 Markdown；普通任务、仅讨论 Skill 原理或没有文件修改要求时不要加载。
version: 2
masterOnly: true
requiredTools:
  - RunCommand
---

# Sakura AI Skill 创建指南

本 Skill 只负责创建和维护 Sakura 机器人自己的按需 Skill，不是 Codex、Claude 或其他客户端的 Skill。执行者必须尊重用户当前请求的范围，不要因为加载了本 Skill 就自行创建无关文件。

## 当前运行约定

- 内置 Skill 根目录：`plugins/sakura-plugin/lib/AIUtils/skills/builtin/`，随 Sakura 仓库分发并接受版本控制。
- 用户 Skill 根目录：`plugins/sakura-plugin/skills/`，仅保存在部署机器并被 Git 忽略。
- 每个 Skill 使用独立目录，入口必须叫 `SKILL.md`。
- `builtin` 或 `user` 只表示文件来源，与谁能加载无关。
- `masterOnly` 单独控制可见权限；内置 Skill 可以只对主人开放，用户 Skill 也可以向所有用户开放。
- 父 Skill 使用 `SKILL.md`；可选子 Skill 放在同一包的 `subskills/<id>.md`。
- 初始工具目录只暴露父 Skill 元数据。加载父 Skill 后才返回其子 Skill 元数据，再以 `父ID/子ID` 按需加载正文。
- 子 Skill 只允许一层，单个父 Skill 最多 32 个子 Skill。
- Skill 目录会在每次生成工具目录或加载正文时重新读取，创建后无需重启。
- 父 Skill 和每个子 Skill 文件分别最多 30000 字符。

除非主人明确提出“内置”“自带”“随仓库分发”或“提交到仓库”等要求，否则一律创建到用户 Skill 根目录。不要把私人规则、凭据、账号信息或部署环境细节写入内置 Skill。

## 文件格式

`SKILL.md` 必须以 YAML frontmatter 开头：

```markdown
---
name: example-skill
description: 清楚描述这个 Skill 解决什么任务，以及用户提出哪些请求时应该加载；同时写明不适用的常见情况，帮助模型避免误加载。
version: 1
masterOnly: true
requiredTools:
  - ExampleTool
---

# Skill 标题

这里开始写完整指导。
```

字段规则：

- Skill ID 来自目录名，必须匹配 `^[a-z0-9][a-z0-9._-]{0,79}$`。
- `name` 和 `description` 必填。
- `version` 默认使用 `1`；发生不兼容的指导变更时再提高版本。
- `masterOnly` 必须是布尔值：`true` 表示只有主人可见和可加载，`false` 表示普通用户也可以使用。
- 文件是否位于内置或用户目录，不自动决定 `masterOnly`。
- 新建用户 Skill 时如果主人没有说明受众，默认使用 `masterOnly: true`；明确要求所有用户可用时写成 `false`。
- `requiredTools` 可选，必须是数组，填写工具组配置使用的工具 key，例如 `Nai`、`RunCommand`。
- 多个 `requiredTools` 表示全部都必须实际开放；任意一个未开放时，该 Skill 不会出现在 `SkillGuide` 目录中，也不能按 ID 加载。
- 不依赖任何工具的知识型 Skill 可以省略 `requiredTools`。

`description` 是初始目录中唯一帮助模型判断是否加载的信息，因此必须同时包含：

1. 能解决的任务。
2. 典型触发请求。
3. 容易误判时的排除条件。

不要把完整步骤堆进 `description`；具体流程放在正文中。

## 子 Skill 格式

当一个 Skill 包含多个只在部分任务中需要的大型专题时，保留 `SKILL.md` 作为总入口和共通规则，把专题放进：

```text
<skill-id>/
├─ SKILL.md
└─ subskills/
   ├─ topic-a.md
   └─ topic-b.md
```

子 Skill 文件同样使用 YAML frontmatter，但只填写自身元数据：

```markdown
---
name: topic-a
description: 清楚说明什么情况下需要继续加载这个专题，以及什么情况下不用加载。
version: 1
---

# 专题指导
```

子 Skill 规则：

- 文件名就是子 ID，必须匹配父 Skill 相同的 ID 正则。
- 完整调用 ID 为 `父ID/子ID`。
- 子 Skill 自动继承父 Skill 的来源、`masterOnly` 和 `requiredTools`，不得在子文件中重复或覆盖这些字段。
- 父 `SKILL.md` 只保留路由、共通约束、通用流程和所有专题都必须知道的规则。
- 子 Skill 的 `description` 会在父 Skill 被加载后提供给模型，必须足以判断该专题是否相关。
- 子 Skill 正文彼此独立；不要要求模型必须把所有兄弟子 Skill 一起加载。
- 只有正文已经明显过长，或专题可以独立按需使用时才拆分；不要为几行内容制造子 Skill。

## 编写原则

- 把稳定、可复用、能明显改善执行质量的规则写进 Skill。
- 不要把一次性用户需求、聊天记录或当前任务结果写成 Skill。
- 指令应直接说明判断条件、参数含义、执行顺序、失败处理和验证方法。
- 只引用当前 Sakura 实际存在的工具名和能力，不要虚构工具。
- 如果 Skill 依赖某个工具，必须填写 `requiredTools`，避免模型看到无法执行的指导。
- 大型 Skill 优先使用“轻量父入口 + 按需子 Skill”，不要让初次加载直接塞入所有参考表和专题规则。
- 复杂任务可以提供少量高价值示例，但不要用大量重复示例占用上下文。
- 不要要求模型展示隐藏推理；只要求必要的检查、行动和用户可见结果。
- 不要在 Skill 中保存密码、Token、Cookie、私聊内容或其他秘密。

## 创建或更新流程

1. 判断用户是在创建新 Skill、更新已有 Skill，还是只询问设计方案。只有前两种情况才修改文件。
2. 从请求中确定 Skill 的任务范围、触发条件、排除条件、所需工具和验证方式。
3. 分别确定文件来源和使用受众：选择 `builtin` 或 `user` 目录，再独立选择 `masterOnly: true` 或 `false`。
4. 选择简短稳定的英文 Skill ID。不要仅通过大小写或标点创建近似重复项。
5. 使用 `RunCommand` 同时检查两个根目录，避免与另一来源的 Skill ID 重复。
6. 如果文件已经存在，先读取完整内容；用户没有明确要求覆盖时，不得直接重写。
7. 判断是否需要子 Skill；若需要，设计父入口和每个子专题的独立触发描述，避免内容重复。
8. 生成完整父 `SKILL.md` 和必要的 `subskills/*.md`，检查 frontmatter、路径、可见权限、工具 key 和各文件正文长度。
9. 使用 `RunCommand` 写入文件。只允许写入本节规定的 Skill 包目录，不得使用 `..`、绝对路径或软链接绕过目录边界。
10. 写入后先调用 `SkillGuide` 加载父 ID，确认返回正确的子 Skill 目录；再逐个加载新增或修改的 `父ID/子ID` 验证正文。
11. 如果因为 `masterOnly` 或 `requiredTools` 条件而无法在目标用户身份下加载，改用 `RunCommand` 读取并检查文件，同时明确告诉主人它的可见条件。
12. 最终说明创建或修改了哪个 Skill、有哪些子 Skill、文件来源、保存位置、可见受众、工具依赖和验证结果。

## 使用 RunCommand 写文件

优先使用项目已有的 Node.js。对于包含多行 Markdown 的内容，使用多行 `node -e` 脚本，并把完整文档作为 JSON 字符串写进脚本；`RunCommand` 会把多行 Node 脚本放入临时文件执行，可避免把 Markdown 直接交给 shell 解释。

脚本必须完成以下检查：

- 从已配置的 Sakura 工作区开始解析路径。
- 对 Skill ID 再执行一次正则校验。
- 使用明确的用户或内置根目录。
- 用 `path.resolve` 得到目标，再确认目标仍位于选定根目录之内。
- 新建目录时使用递归创建。
- 使用 UTF-8 写入 `SKILL.md` 和 `subskills/*.md`。
- 未获覆盖授权时使用排他创建或在文件已存在时退出。

不要使用拼接出来的删除命令，不要递归删除 Skill 根目录，也不要为了修正一个 Skill 改动其他 Skill。

## 更新与发布

- 更新用户 Skill 时保留原有的有效规则，只修改请求涉及的部分。
- 将用户 Skill 转为内置 Skill 属于代码变更，必须由主人明确要求；移动后仍保留或按要求修改其 `masterOnly`，不能因为目录改变而擅自改变受众。
- 转为内置前移除私人路径、账号信息、密钥和只在本机成立的假设。
- 内置 Skill 应保持通用；部署者自己的偏好继续留在用户 Skill。
- 如果只是调整父或子 Skill Markdown，动态注册器会自动读取，不需要重启机器人。

## 完成标准

只有同时满足以下条件才算完成：

- 目标路径正确且没有越界。
- YAML frontmatter 能被注册器解析。
- `description` 足以让模型在初始目录中正确判断是否加载。
- 文件来源与 `masterOnly` 受众分别符合主人的要求。
- 所有执行依赖都列入 `requiredTools`。
- 正文给出了完成任务所需的完整指导。
- 父 Skill 能返回预期的子 Skill 元数据，且初始全局目录没有提前暴露子 Skill。
- 新增或修改的每个子 Skill 都能通过完整层级 ID 实际加载。
- 新 Skill 已通过 `SkillGuide` 实际加载，或已明确证明它仅因当前身份或工具依赖不满足而被隐藏。
