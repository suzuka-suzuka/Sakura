---
name: prompt-language
description: 当需要把中文画面需求整理成 NAI5 提示词、选择 Tag/完整英文自然语言/混合提示、安排信息顺序或使用强化弱化语法时加载。已经有清晰简单 Tag 且不需要改写时不用加载。
version: 1
---

# NAI5 提示语言与组织

## 三种有效表达

| 方式 | 写法 | 优势 | 适用情况 |
|---|---|---|---|
| Tag | 逗号分隔的已知英文标签 | 控制直接、简洁、一致性通常最好 | 人物属性、服装、画风、镜头、颜色、常见动作 |
| 完整自然语言 | 完整连贯的英文句子或段落 | 擅长关系、叙事、空间逻辑和难以标签化的要求 | 复杂场景、非标准动作、气氛、文字样式、漫画布局 |
| 混合提示 | Tag 锚点在前，完整英文描述在后 | 同时保留标签控制与语言理解 | 默认用于复杂画面 |

官方说明 V5 显著增强了自然语言理解，并继续完整支持 Tag；Tag 的特点是简洁与一致。不要把自然语言误解成 `a girl in rain` 这类碎片，也不要把若干 Tag 去掉逗号后伪装成句子。

## Tag 组织顺序

重要信息放在提示词前半部分。推荐顺序：

1. 数据集或全局模式标签，如确实需要的 `background dataset`。
2. 主体数量：`1girl`、`2girls`、`1boy, 1girl`。
3. 核心画风、媒介和绘画形式。
4. 主场景、时间、天气和关键环境物件。
5. 景别、镜头角度、透视和布局。
6. 光线、色彩主题和视觉特效。
7. 全局动作、关系、氛围和复杂度。
8. 完整英文自然语言补充。
9. 若有画面文字，末尾才放 `Text:` 块。

角色外观不要全部堆在基础提示词中；多人任务交给 `characters`。

## 完整英文自然语言

完整描述至少应覆盖其中大部分：

- 谁或什么是主体。
- 主体正在做什么、与谁互动。
- 场景在哪里、是什么时间和天气。
- 主体在画面中的相对位置与前后关系。
- 镜头拍到哪里、从什么角度观察。
- 光源方向、色调和情绪。
- 特殊材质、笔触或文字如何呈现。

合格示例：

```text
An anime-style illustration of a silver-haired witch standing alone on a rain-soaked railway platform at dusk. She holds a closed umbrella against her chest while looking toward the warm light of an approaching train. The camera frames her from the knees up, with wet rails leading into the distance and soft reflections glowing across the platform. The scene feels quiet, wistful, and cinematic.
```

用户用中文描述时，忠实转换成英文，不要擅自删除身份、动作对象、空间关系或关键小物件。英文和日文是 V5 正式支持的提示语言；中文等其他提示语言可以工作，但官方说明效果可能波动。中文只在需要实际显示于画面时原样保留到 `Text:`。

## 混合提示模板

```text
1girl, visual novel cg, rainy railway platform, dusk, cowboy shot, warm backlight, depth of field, high complexity. A silver-haired witch stands slightly left of center and holds a closed umbrella against her chest while watching an approaching train. Warm window light reflects across the wet platform, creating a quiet and wistful cinematic mood.
```

Tag 负责可枚举属性，完整句子负责谁在何处做什么以及画面为什么这样组织。不要在两部分反复写同一信息。

## 强化与弱化

官方支持用花括号强化、方括号弱化文本向量：

| 写法 | 含义 | 使用建议 |
|---|---|---|
| `{watercolor (medium)}` | 提高一次权重，约乘 1.05 | 关键风格偶尔被忽略时使用 |
| `{{watercolor (medium)}}` | 叠加强化 | 谨慎使用，避免压制主体与构图 |
| `[bloom]` | 降低一次权重，约除 1.05 | 想保留但不希望过强时使用 |
| `2.1::transparent background::` | 数值权重语法 | 仅对确实需要强引导的内容使用 |

先修改提示本身，再考虑加权。不要把每个标签都强化，也不要同时强化互相冲突的结果。

## 输出前检查

- 是否用了准确 Tag，或真正完整的英文描述。
- 最重要的主体和风格是否位于前半部分。
- 是否存在同义重复或互相冲突。
- 多人外观是否已经拆入角色提示。
- 正负提示是否包含同一属性。
- `Text:` 是否位于绝对末尾。

## 官方依据

- https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/
- https://docs.novelai.net/en/image/basics/
- https://docs.novelai.net/en/image/tags/
- https://docs.novelai.net/en/image/strengthening-weakening/
