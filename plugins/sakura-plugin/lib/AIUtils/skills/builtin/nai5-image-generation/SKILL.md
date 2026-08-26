---
name: nai5-image-generation
description: 为 NovelAI Diffusion V5 / V4.5 的 NaiPainting 工具规划高质量英文 Tag、完整英文自然语言或混合提示，并按需提供画风笔触、构图光线、多人位置、互动、中文文字与文本框等专题子 Skill。用户要求 NAI 绘图、复杂二次元构图、特定画风、多角色或画面文字时使用；普通单人简单图可直接调用工具。
version: 2
masterOnly: false
requiredTools:
  - Nai
---

# NovelAI V5 绘图总指南

本 Skill 是 `NaiPainting` 的总入口，负责共通规则和子 Skill 路由。加载本 Skill 后会返回子 Skill 元数据目录；只继续加载当前画面真正需要的子 Skill，不要为了“更全面”把所有子 Skill 全部读入上下文。

不要向用户展示隐藏推理。完成必要的内部构图后，直接调用 `NaiPainting`，并用简洁结果说明回应用户。

## 何时继续加载子 Skill

- 不确定应使用 Tag、完整英文自然语言还是混合提示，或需要权重语法时，加载提示语言子 Skill。
- 用户指定画风、媒介、笔触、线稿、上色方式、色彩主题或视觉特效时，加载画风与笔触子 Skill。
- 用户要求特定景别、镜头角度、透视、光线、焦点、复杂场景或透明背景时，加载构图与光线子 Skill。
- 两个及以上角色、明确站位、人物互动或需要避免特征串色时，加载多人角色子 Skill。
- 画面内要生成英文、日文、中文、招牌、对白气泡或视觉小说文本框时，加载文字渲染子 Skill。
- 一个请求可以加载多个相关子 Skill，例如“水彩风双人中文对白”应加载画风、多人与文字三个子 Skill。

只有一个主体、没有特殊画风与文字、构图也很简单时，可以遵守本页共通规则后直接调用工具。

## 工具参数

`NaiPainting` 接收：

- `prompt`：基础提示词，负责人数、场景、画风、构图、镜头、光线、全局关系和画面文字。
- `aspectRatio`：`portrait`、`landscape` 或 `square`。
- `negativePrompt`：只填写本次额外不希望出现的内容；公共负面词由配置自动加入。
- `characters`：角色数组。每项包含 `prompt`、可选坐标 `x`/`y`（0 到 100）和可选 `undesired`。
- `vibe`：用户明确指定的已保存画风名称。不要猜测或编造。

模型由机器人配置决定，不要在参数中自行填写模型名。V5 暂不支持 Vibe Transfer；填写 `vibe` 时底层会自动改用 V4.5。

## 共通工作流

1. 提取用户不可违背的要求：主体、人数、身份、动作、环境、画风、镜头、画幅、文字和透明度。
2. 根据上面的路由只加载所需子 Skill。
3. 默认使用准确的英文 Tag；复杂关系与叙事使用完整英文句子补充。不要使用残缺的自然语言短句。
4. 多人时把人数放在基础提示词，把每个人的外观和动作拆到 `characters`。
5. 选择与布局一致的画幅；横向多人通常使用 `landscape`，单人立绘通常使用 `portrait`。
6. 检查正负提示是否互相冲突，尤其是文字、色彩、线稿和特效要求。
7. 只有用户明确点名已保存画风时才填写 `vibe`。
8. 调用一次 `NaiPainting`。工具已经发送图片后，不要再伪造图片占位符。

## 共通硬规则

- 英文和日文是 V5 正式支持的提示语言；中文画面描述可以尝试但效果可能波动，因此默认忠实转换为英文 Tag 或完整英文描述。
- Tag 对明确属性与重复一致性通常更稳定；自然语言必须是完整描述，混合提示适合复杂画面。
- 重要主体和约束放在提示词前半部分，避免重复堆砌同义质量词。
- 不要同时要求明显互斥的结果，例如 `lineart` 与 `no lineart`、`close-up` 与 `full body`、`monochrome` 与多种鲜艳色彩主题。
- 需要画面文字时，真正内容必须位于基础提示词末尾的 `Text:` 块；后面不能再添加任何画面提示。
- 不要编造模型能力、角色位置、保存画风名称或用户未要求的文字。
- V5 额度不足时只有符合免费条件的请求才会降级 V4.5；设计超过 6 个角色或依赖 V5 精细定位、中文文字、透明通道时，不要假定降级后仍能保持同等效果。

## 维护依据

- NovelAI V5 发布说明：https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/
- NovelAI 提示基础：https://docs.novelai.net/en/image/basics/
- NovelAI Tag 文档：https://docs.novelai.net/en/image/tags/
- NovelAI 画风教程：https://docs.novelai.net/en/image/tutorial-artstyles/
- NovelAI 多角色文档：https://docs.novelai.net/en/image/multiplecharacters/
- NovelAI 文字渲染：https://docs.novelai.net/en/image/textrendering/
