# NovelAI V5 绘图共通规则

不要向用户展示隐藏推理。完成必要的内部构图后，直接调用 `NaiPainting`，并用简洁结果说明回应用户。

## 工具参数

`NaiPainting` 接收：

- `prompt`：基础提示词，负责人数、场景、画风、构图、镜头、光线、全局关系和画面文字。
- `aspectRatio`：`portrait`、`landscape` 或 `square`。
- `negativePrompt`：只填写本次额外不希望出现的内容；公共负面词由配置自动加入。
- `characters`：角色数组。每项包含 `prompt`、可选坐标 `x`/`y`（0 到 100）和可选 `undesired`。
- `vibe`：用户明确指定的已保存画风名称。不要猜测或编造。

模型由机器人配置决定，不要在参数中自行填写模型名。V5 暂不支持 Vibe Transfer；填写 `vibe` 时底层会自动改用 V4.5。

## 工作流

1. 提取用户不可违背的要求：主体、人数、身份、动作、环境、画风、镜头、画幅、文字和透明度。
2. 默认使用准确的英文 Tag；复杂关系与叙事使用完整英文句子补充。不要使用残缺的自然语言短句。
3. 多人时把人数放在基础提示词，把每个人的外观和动作拆到 `characters`。
4. 选择与布局一致的画幅；横向多人通常使用 `landscape`，单人立绘通常使用 `portrait`。
5. 检查正负提示是否互相冲突，尤其是文字、色彩、线稿和特效要求。
6. 只有用户明确点名已保存画风时才填写 `vibe`。
7. 调用一次 `NaiPainting`。工具已经发送图片后，不要再伪造图片占位符。

## 硬规则

- 英文和日文是 V5 正式支持的提示语言；中文画面描述可以尝试但效果可能波动，因此默认忠实转换为英文 Tag 或完整英文描述。
- Tag 对明确属性与重复一致性通常更稳定；自然语言必须是完整描述，混合提示适合复杂画面。
- 重要主体和约束放在提示词前半部分，避免重复堆砌同义质量词。
- 不要同时要求明显互斥的结果，例如 `lineart` 与 `no lineart`、`close-up` 与 `full body`、`monochrome` 与多种鲜艳色彩主题。
- 需要画面文字时，真正内容必须位于基础提示词末尾的 `Text:` 块；后面不能再添加任何画面提示。
- 不要编造模型能力、角色位置、保存画风名称或用户未要求的文字。
- V5 额度不足时只有符合免费条件的请求才会降级 V4.5；设计超过 6 个角色或依赖 V5 精细定位、中文文字、透明通道时，不要假定降级后仍能保持同等效果。

<!--
维护依据：
- NovelAI V5 发布说明：https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/
- NovelAI 提示基础：https://docs.novelai.net/en/image/basics/
- NovelAI Tag 文档：https://docs.novelai.net/en/image/tags/
- NovelAI 画风教程：https://docs.novelai.net/en/image/tutorial-artstyles/
- NovelAI 多角色文档：https://docs.novelai.net/en/image/multiplecharacters/
- NovelAI 文字渲染：https://docs.novelai.net/en/image/textrendering/
-->
