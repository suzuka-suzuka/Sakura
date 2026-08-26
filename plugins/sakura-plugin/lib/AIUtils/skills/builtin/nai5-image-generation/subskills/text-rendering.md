---
name: text-rendering
description: 当画面需要英文、日文或中文文字、招牌、漫画对白气泡、视觉小说文本框、多段文字，或需要控制文字样式与位置时加载。没有画面文字时不用加载。
version: 1
---

# V5 文字与中文文本框

## V5 能力

V5 发布说明明确支持生成英文、日文和中文文字，并允许用自然语言描述文字的样式和位置。网页端可以把引号中的内容自动准备为 `Text:` 块，但 `NaiPainting` 直接请求 API，不经过该网页前端转换，因此本工具必须显式构造 `Text:`。

## 基本结构

1. 在基础提示词加入 `text` 与语言标签。
2. 加入文字载体或所在物件。
3. 在 `Text:` 之前用完整英文句子描述文字的样式、颜色、位置和归属。
4. 把真正文字放入基础提示词绝对末尾的 `Text:` 块。

| 目标 | 建议提示 |
|---|---|
| 英文文字 | `text, english text` |
| 日文文字 | `text, japanese text` |
| 中文文字 | `text, chinese text` |
| 漫画对白 | `speech bubble` |
| 视觉小说对话框 | `dialogue box` |
| 一般文本框 | `text box` |
| 招牌 | `sign`, `signboard`，并说明材质和位置 |
| 海报文字 | `poster`，并说明标题区域 |

`Text:` 必须位于绝对末尾。它后面不能再写 Tag、自然语言、质量词或说明，否则后续内容可能被当作要画进图片的文字。

## 中文文本框模板

```text
1girl, visual novel cg, upper body, classroom, dialogue box, text, chinese text, high complexity. A wide rectangular dialogue box with a dark blue border is placed along the bottom of the image. It contains clear white Chinese characters and belongs to the silver-haired girl speaking with a gentle smile.
Text: 今天放学后一起回家吗？
```

工具会把公共质量词放到 `Text:` 之前，并在检测到文字意图时避免补入 `no text`。

## 多段文字

官方文字文档建议多段独立文字之间留一个空行：

```text
Text: 第一段对白

第二段对白
```

- 所有待渲染文字放在基础提示词通常最可靠。
- 不要优先把 `Text:` 放入角色提示词；当前基础提示的公共质量处理也以基础文字块为准。
- 尽量把总文字控制在 120 个字符以内。V5 比 V4.5 支持更长文字，但短而明确仍更稳定。
- 需要多个气泡时，在 `Text:` 之前说明每段文字属于谁、气泡分别位于哪里，并用空行按顺序列出内容。

## 样式和位置

使用完整英文句子描述：

- `handwritten`、印刷、霓虹或像素字体外观。
- 文字颜色与背景颜色。
- 文本框形状、边框和透明度。
- 位于顶部、底部、人物头部旁、招牌中央等位置。
- 哪个角色说话或文字属于哪个物件。

示例：

```text
A rounded white speech bubble floats beside the black-haired girl's head in the upper-left area. The Chinese text is handwritten in dark green, centered inside the bubble, with enough empty margin around every character.
```

完整描述负责样式和位置，末尾 `Text:` 负责真正字符内容。

## 中文视觉小说示例

```json
{
  "prompt": "1girl, visual novel cg, upper body, classroom, dialogue box, text, chinese text, high complexity. A wide rectangular dialogue box with a dark blue border is placed along the bottom of the image. It contains clear white Chinese characters and belongs to the silver-haired girl speaking with a gentle smile.\nText: 今天放学后一起回家吗？",
  "aspectRatio": "landscape",
  "negativePrompt": "garbled letters, duplicated dialogue box",
  "characters": [
    {
      "prompt": "girl, long silver hair, blue eyes, navy school uniform, gentle smile, looking at viewer",
      "x": 50,
      "y": 48
    }
  ]
}
```

## 禁止事项

- 不要只在引号中写内容并假定 API 会自动生成 `Text:`。
- 不要在 `Text:` 后继续写画面要求。
- 不要在 `negativePrompt` 中加入 `no text`、`textless` 等冲突项。
- 不要编造用户没有提供的对白。
- 不要要求长篇文章、密集小字或多个未说明位置的文本块。
- 不要把乱码问题简单归因于提示长度；先检查语言标签、文字载体、样式描述和 `Text:` 位置。

## 官方依据

- https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/
- https://docs.novelai.net/en/image/textrendering/
