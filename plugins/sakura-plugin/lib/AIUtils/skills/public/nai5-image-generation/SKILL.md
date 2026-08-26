---
name: nai5-image-generation
description: 为 NovelAI Diffusion V5 / V4.5 的 NaiPainting 工具编写高质量提示词并组织多角色、自由坐标、交互、画幅、负面提示和已保存画风。用户要求 NAI 绘图、复杂二次元构图、多人分区站位或指定 Vibe 画风时使用；普通单人简单图可直接调用工具。
version: 1
---

# NovelAI V5 绘图指南

本 Skill 用于把用户的画面意图整理为 `NaiPainting` 工具参数。不要向用户展示内部推理；先在心里完成构图，再调用工具。

## 先判断是否需要本 Skill

- 用户明确要求 NovelAI、NAI、二次元或动漫风格生图时适用。
- 多角色、明确站位、人物交互、复杂镜头、透明背景、画面文字或指定已保存画风时应使用。
- 只有一个主体且要求很简单时，可以不加载本 Skill，直接调用 `NaiPainting`。
- 现实照片或通用图片如果没有要求 NAI，优先考虑更合适的图片工具。

## 工具参数

`NaiPainting` 接收以下参数：

- `prompt`：基础提示词，必填。负责人数、场景、画风、构图、镜头、光线和全局动作。
- `aspectRatio`：`portrait`、`landscape` 或 `square`。
- `negativePrompt`：本次额外不希望出现的内容。只写与本次画面有关的补充项，公共负面词由配置自动加入。
- `characters`：角色提示词数组。每项含 `prompt`、可选坐标 `x`/`y`（0 到 100）以及可选 `undesired`。
- `vibe`：已保存的画风名称。只有用户明确指定已保存画风时才填写，不要编造名称。

模型由机器人配置决定，不要在参数里猜模型。V5 不支持 Vibe Transfer；一旦填写 `vibe`，底层会自动切换到 V4.5。

## 组织提示词

### 1. 基础提示词

基础提示词优先按以下顺序组织，使用逗号分隔的英文标签，并在需要时加入一两句简短自然语言：

1. 主体数量：`1girl`、`2girls`、`1boy, 1girl` 等。
2. 场景与时间：地点、天气、季节、昼夜、背景物件。
3. 画风与媒介：例如 `anime coloring`、`watercolor (medium)`、`visual novel cg`。
4. 构图与镜头：例如 `upper body`、`cowboy shot`、`full body`、`wide shot`、`from above`、`dutch angle`。
5. 光线与色彩：例如 `rim lighting`、`warm backlight`、`neon lighting`、明确的色调。
6. 全局关系或布局：例如 `side-by-side`、`facing each other`、`depth of field`。
7. 复杂画面可加入 `high complexity`；不要机械地堆叠互相重复的质量词。

V5 官方主要支持英文和日文。即使用户用中文描述，也应整理成准确的英文标签或短句；只有画面内文字需要中文时才保留中文内容。

### 2. 角色提示词

两人或以上时，把人物外观从基础提示词拆到 `characters`，避免角色特征串色。

- 人数标签只放基础提示词。
- 每个角色提示以不带数字的 `girl`、`boy` 或 `other` 开头。
- 接着写身份或角色名、发型发色、瞳色、服装、配饰、姿势、动作、表情和视线。
- 不要在基础提示词重复每个人的完整外观。
- 若某个特征容易串到其他人，在该角色的 `undesired` 中写不属于他的特征。
- 角色数组顺序尽量按“从上到下、从左到右”，与坐标相互印证。

### 3. 坐标

坐标采用百分比数值，不带 `%`：

- `x: 0` 是最左，`x: 100` 是最右。
- `y: 0` 是最上，`y: 100` 是最下。
- 正中央是 `x: 50, y: 50`。
- 站位很重要时，除了坐标，还要在基础提示词或角色提示词中用 `on the left`、`on the right`、`in the foreground` 等短语加强。
- 不要把多个角色放在完全相同的位置；除非画面确实要求紧密重叠。

V5 使用连续自由坐标，最多接受 32 个角色提示词。V4.5 只有 5×5 粗略位置并最多 6 个角色，底层会自动将坐标吸附到网格中心。若希望 V5 额度不足时仍能免费降级到 V4.5，角色数保持在 6 个以内。

### 4. 角色交互

多人互动可使用动作前缀：

- 主动者：`source#hug`、`source#holding hands`、`source#pointing at another`。
- 被动者：`target#hug`、`target#pointing`。
- 双向动作：双方都用 `mutual#hug`、`mutual#holding hands`。

同时用自然语言补强谁在对谁做什么。动作前缀是引导，不保证百分之百可靠。

### 5. 画面文字和透明背景

- 要生成可见文字时，在基础提示词中加入 `text` 与对应语言标签，并把 `Text: 实际文字` 放在提示词最后。
- V5 可以尝试英文、日文和中文画面文字。文字越短越可靠。
- 透明背景使用 `transparent background, has alpha`；需要更强引导时可使用 `2.1::transparent background::`。
- 用户没有要求文字时，不要主动添加招牌、对白或水印。

## 画幅选择

- `portrait`：人物立绘、单人半身或全身、竖向海报。
- `landscape`：两人以上横向站位、宽场景、战斗或环境叙事。
- `square`：头像、居中构图、图标式作品或用户未给出明显方向时。

多人横向排布通常优先 `landscape`。不要只因角色是站立姿势就无条件使用竖图。

## 常见错误

- 不要把 `2girls` 写进每个角色提示；人数只在基础提示词出现。
- 不要同时要求互斥的镜头，如 `close-up` 与 `full body`。
- 不要把所有人的发色、衣服和动作堆在基础提示词中。
- 不要仅靠坐标表达复杂互动；坐标、数组顺序和文字描述应一致。
- 不要为了“更详细”无边界堆标签。优先保留能改变构图、身份和动作的内容。
- 不要编造 `vibe` 名称。用户未明确说使用已保存画风时省略它。
- 使用 `vibe` 时按 V4.5 能力设计：最多 6 个角色，位置只是 5×5 粗略引导。

## 示例

### 两人交互

```json
{
  "prompt": "2girls, rainy city street at night, visual novel cg, high complexity, neon reflections, cowboy shot, facing each other, cinematic lighting",
  "aspectRatio": "landscape",
  "negativePrompt": "extra people, duplicated umbrella",
  "characters": [
    {
      "prompt": "girl, black bob cut, blue eyes, navy school uniform, holding a transparent umbrella, gentle smile, source#holding hands, on the left",
      "x": 28,
      "y": 52,
      "undesired": "pink hair, red coat"
    },
    {
      "prompt": "girl, long pink hair, green eyes, red hooded coat, surprised expression, target#holding hands, on the right",
      "x": 72,
      "y": 52,
      "undesired": "black hair, school uniform"
    }
  ]
}
```

### 单人透明立绘

```json
{
  "prompt": "1girl, visual novel sprite, high complexity, full body, facing viewer, soft studio lighting, transparent background, has alpha",
  "aspectRatio": "portrait",
  "characters": [
    {
      "prompt": "girl, silver braided hair, amber eyes, ornate witch hat, dark blue robe, holding a wooden staff, calm smile",
      "x": 50,
      "y": 50
    }
  ]
}
```

## 维护依据

- NovelAI V5 发布说明：https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/
- NovelAI 多角色提示文档：https://docs.novelai.net/en/image/multiplecharacters/
- NovelAI 提示基础：https://docs.novelai.net/en/image/basics/
- NovelAI 文字渲染：https://docs.novelai.net/en/image/textrendering/
