---
name: style-brushwork
description: 当用户指定画风、绘画媒介、笔触、线稿、上色、主色调、年代风格或视觉特效，或需要从官方 NAI 标签中选择稳定组合时加载。仅指定普通 anime style 而无特殊风格要求时可以不加载。
version: 1
---

# NAI 画风、媒介与笔触标签表

以下表格优先采用 NovelAI 官方画风教程列出的标签。V5 仍完整支持 Tag；官方建议把影响整幅画面的画风标签靠近提示词前部。通常选择少量相容项即可，不要把整张表塞进一次提示。

推荐组合层级：

1. 一种主要媒介。
2. 一种画风或绘画形式。
3. 一种上色方式或色彩主题。
4. 零到两种视觉特效。
5. 必要时用完整英文自然语言描述具体笔触。

## 媒介类别

| 目的 | 官方 Tag | 含义与搭配 |
|---|---|---|
| 传统材料感 | `traditional media` | 看起来由真实传统工具完成；与具体 `(medium)` 标签搭配 |
| 数字模拟传统材料 | `faux traditional media` | 数字绘制但模拟纸张、颜料或手绘质感 |
| 混合材料 | `mixed media` | 传统与数字或多种材料混合 |
| 非常规材料 | `unconventional media` | 不属于常见数字或传统媒介的总括标签 |

## 具体绘画工具与材料

| 类别 | 官方 Tag | 典型倾向 |
|---|---|---|
| 丙烯颜料 | `acrylic paint (medium)` | 覆盖力强、色块和颜料质感 |
| 圆珠笔 | `ballpoint pen (medium)` | 细密排线、硬质笔迹 |
| 毛笔 | `calligraphy brush (medium)` | 有粗细变化的墨线和书写性笔锋 |
| 彩色铅笔 | `colored pencil (medium)` | 颗粒纸感、细腻叠色 |
| 石墨 | `graphite (medium)` | 铅笔灰阶、擦抹与排线感 |
| 墨水 | `ink (medium)` | 高对比墨线或墨块 |
| 马克笔 | `marker (medium)` | 均匀色块、边缘清晰 |
| 针管笔 | `millipen (medium)` | 稳定细线、设计稿或线描感 |
| 蘸水笔 | `nib pen (medium)` | 线条粗细变化、漫画墨线感 |
| 油画 | `oil painting (medium)` | 厚重颜料、柔和混色、绘画性 |
| 泛绘画媒介 | `painting (medium)` | 不限定具体颜料的绘画效果 |
| 粉彩 | `pastel (medium)` | 柔软粉质、低硬边 |
| 钢笔 | `pen (medium)` | 清晰笔线、速写或插画感 |
| 水彩 | `watercolor (medium)` | 透明叠色、水痕与纸张感 |
| 水彩铅笔 | `watercolor pencil (medium)` | 铅笔纹理与水溶晕染结合 |

## 数字媒介与成像形式

| 官方 Tag | 典型倾向 |
|---|---|
| `3d` / `blender (medium)` | 三维渲染、体积与材质感 |
| `anime screencap` | 动画截帧式构图和上色 |
| `pixel art` | 像素图形；可与 `dithering` 搭配 |
| `ai-generated` / `ai-assisted` | AI 图像或 AI 辅助创作的外观倾向；通常没有明确需求时不必主动加入 |

## 艺术流派

| 官方 Tag | 视觉方向 |
|---|---|
| `abstract` / `surreal` | 抽象或超现实表达 |
| `art nouveau` | 新艺术运动式装饰曲线与图案 |
| `impressionism` | 印象派的光色与概括笔触 |
| `ligne claire` | 清晰均匀线条、简洁平涂 |
| `nihonga` | 日本画材料与审美倾向 |
| `ukiyo-e` | 浮世绘构图、线条和版画色块 |
| `realistic` / `photorealistic` | 写实或照片式真实感 |
| `retro artstyle` | 复古插画总体倾向 |

年代也可用 `year XXXX`，如 `year 2014`。它用于偏向相应年代的常见画风，但官方说明结果可能有波动。

## 绘画形式、线条和笔触

| 官方 Tag | 含义 |
|---|---|
| `painterly` | 强调绘画性、可见笔触与非纯平涂效果 |
| `sketch` | 草图、速写或未完全收束的线条 |
| `lineart` | 以清晰线稿为主要结构 |
| `no lineart` | 弱化或去除外轮廓线，依靠色块和明暗塑形 |
| `jaggy lines` | 锯齿、锐利或不平滑的线条 |
| `outline` | 明确外轮廓 |
| `vector trace` | 矢量描摹式边缘与图形感 |
| `color trace` | 使用有色描线；官方建议可尝试结合 `production art, animation paper` |
| `game cg` | 游戏 CG 式精修插画 |
| `official art` | 官方宣传插画般的完成度倾向 |
| `shikishi` | 色纸作品感，通常会出现可见边框 |
| `oekaki` | 简单数字绘图工具产生的尖细线条感 |
| `tegaki` | 手写、鼠绘式自由笔迹 |

官方没有为每一种具体笔触都提供固定 Tag。需要“松散可见笔刷”“厚涂堆叠”“干笔刮擦”等细节时，在上述 Tag 后追加完整英文自然语言，例如：

```text
The image is painted with broad, visible brushstrokes and layered patches of opaque color. Fine dry-brush texture remains visible around the edges of the cloak, while the face is rendered with softer blended strokes.
```

这段自然语言是 V5 描述方式，不应冒充官方 Tag。

## 上色与色调

| 官方 Tag | 含义 |
|---|---|
| `anime coloring` | 硬边阴影、较少明暗层级的动画式上色 |
| `colorful` | 多彩、高颜色丰富度 |
| `dark` | 整体偏暗 |
| `limited palette` | 只使用少量受限颜色 |
| `partially colored` | 只有局部区域上色 |
| `spot color` | 用单个局部色彩形成强调 |
| `monochrome` | 单一主色或黑白倾向 |
| `greyscale` | 灰阶黑白 |
| `muted color` | 低饱和、克制颜色 |
| `pale color` | 浅淡颜色 |
| `pastel colors` | 粉彩式柔和配色 |
| `flat color` | 平涂、较少渐变塑形 |
| `high contrast` | 明暗或颜色对比强烈 |
| `sepia` | 棕褐老照片色调 |

单色主题可使用 `aqua theme`、`black theme`、`blue theme`、`brown theme`、`green theme`、`grey theme`、`orange theme`、`pink theme`、`purple theme`、`red theme`、`white theme`、`yellow theme`。

`monochrome` 或 `greyscale` 不要同时搭配互相冲突的多种发色、瞳色和鲜艳主题；若某个角色颜色必须保留，改用 `spot color` 或完整自然语言说明局部例外。

## 视觉特效

| 官方 Tag | 效果 |
|---|---|
| `backlighting` | 逆光 |
| `bloom` | 高光泛光 |
| `bokeh` | 散景光斑 |
| `chromatic aberration` | 色差边缘 |
| `depth of field` | 景深 |
| `diffraction spikes` | 强光衍射星芒 |
| `dithering` | 抖动网点着色，常与像素画搭配 |
| `drop shadow` | 投影或图形阴影 |
| `emphasis lines` / `speed lines` / `motion lines` | 强调、速度或运动线 |
| `glitch` | 数字故障效果 |
| `halftone` | 半色调网点 |
| `lens flare` | 镜头光晕 |
| `motion blur` | 运动模糊 |
| `soft focus` | 柔焦 |

某些 Undesired Content 预设可能包含 `chromatic aberration` 等词，正向要求特效时检查本次 `negativePrompt`，不要再写入同名冲突项。

## V5 新增或重点标签

| Tag | 用途 |
|---|---|
| `depthness` | 增加阴影与画面的纵深感 |
| `low complexity` | 低复杂度，适合极简或特殊风格 |
| `medium complexity` | 中等复杂度 |
| `high complexity` | 常规精致画面的优先复杂度 |
| `ultra complexity` | 极高复杂度，更适合刻意繁复或风格化画面 |
| `visual novel art` | 视觉小说总体画风 |
| `visual novel bg` | 视觉小说背景 |
| `visual novel cg` | 视觉小说事件 CG |
| `visual novel chibi` | 视觉小说 Q 版画面 |
| `visual novel sprite` | 视觉小说角色立绘 |

## 组合建议（非官方固定配方）

下表是基于官方标签含义整理的实用组合，不代表官方保证：

| 目标 | 建议组合 |
|---|---|
| 柔和水彩绘本 | `traditional media, watercolor (medium), lineart, pale color, soft focus` |
| 日系透明水彩 | `faux traditional media, watercolor (medium), colored pencil (medium), pastel colors, delicate lineart` |
| 厚涂油画 | `oil painting (medium), painterly, no lineart, high contrast, depthness` |
| 墨线漫画 | `ink (medium), nib pen (medium), lineart, monochrome, halftone` |
| 清晰赛璐璐动画 | `anime screencap, anime coloring, flat color, lineart` |
| 像素游戏画面 | `pixel art, dithering, limited palette` |
| 视觉小说事件 CG | `visual novel cg, game cg, anime coloring, high complexity, depth of field` |
| 复古印刷海报 | `retro artstyle, limited palette, halftone, high contrast` |
| 浮世绘风 | `ukiyo-e, traditional media, ink (medium), flat color, limited palette` |
| 清晰法漫线条 | `ligne claire, lineart, flat color, limited palette` |

同一组合仍需加入主体、场景、构图和光线。不要只提交一串风格词让模型自行猜画面内容。

## 冲突检查

- `lineart` 与 `no lineart` 二选一。
- `flat color` 与厚重混色笔触通常不要同时作为主目标。
- `monochrome`、`greyscale` 与多色主题不要并列。
- `motion blur`、`soft focus` 会削弱锐利线稿，只在确实需要时使用。
- `photorealistic` 可能冲淡纯动漫风格；用户没有要求写实时不要主动加入。
- 画风标签靠近提示词前部，但人数和不可违背的主体信息仍需清晰。
- 官方画风教程提醒默认质量标签可能把结果推向特定审美；当前工具自动添加公共质量词，因此要减少互相竞争的风格堆叠，并用少量明确标签或完整英文描述强化真正目标。

## 官方依据

- https://docs.novelai.net/en/image/tutorial-artstyles/
- https://docs.novelai.net/en/image/tags/
- https://docs.novelai.net/en/image/basics/
- https://docs.novelai.net/en/image/strengthening-weakening/
- https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/
