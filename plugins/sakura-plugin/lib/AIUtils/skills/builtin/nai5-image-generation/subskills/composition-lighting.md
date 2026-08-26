---
name: composition-lighting
description: 当用户要求特定画幅、景别、镜头角度、透视、主体焦点、光线、复杂场景、漫画布局或透明背景时加载。普通居中单人图且没有镜头要求时可以不加载。
version: 1
---

# 构图、镜头、光线与透明背景

## 先选画幅

| `aspectRatio` | 典型用途 | 注意 |
|---|---|---|
| `portrait` | 单人立绘、半身、全身、竖向海报 | 竖画幅会影响人物身材和可见范围，不等于自动保证全身 |
| `landscape` | 横向多人、宽场景、战斗、环境叙事、视觉小说文本框 | 两人以上横排通常优先 |
| `square` | 头像、图标、中心构图、无明显方向要求 | 复杂横向互动可能空间不足 |

画幅、景别和服装细节会共同影响裁切。例如提示中强调鞋、靴子或脚部，模型可能为了表现这些细节而拉远镜头。

## 官方景别标签

按从近到远排列：

| Tag | 大致范围 |
|---|---|
| `close-up` | 面部或局部特写 |
| `portrait` | 面部到肩部 |
| `upper body` | 面部到躯干 |
| `lower body` | 躯干以下 |
| `cowboy shot` | 面部到大腿 |
| `feet out of frame` / `foot out of frame` | 面部到膝部以下但脚不入镜 |
| `full body` | 全身 |
| `wide shot` | 远距离全身并展示环境 |
| `very wide shot` | 更远的环境主导画面 |

不要同时使用明显互斥的景别。若用户要求全身，角色提示中的鞋袜和脚部细节可以辅助，但不要再加入 `close-up`。

## 官方镜头与视角标签

| 类别 | Tag | 作用 |
|---|---|---|
| 正面关系 | `facing viewer` | 主体面向观者 |
| 高机位 | `from above` | 从上向下观察 |
| 低机位 | `from below` | 从下向上观察 |
| 背面 | `from behind` | 从主体背后观察 |
| 侧面 | `from side`, `profile` | 侧向或侧脸构图 |
| 倾斜 | `dutch angle` | 倾斜画面，增加不稳定或动感 |
| 主观镜头 | `pov` | 第一人称视角，可能生成观者的手 |
| 极端方向 | `sideways`, `upside-down`, `rotated` | 旋转或非常规方向 |
| 广域与畸变 | `panorama`, `fisheye` | 全景或鱼眼效果 |
| 空间结构 | `perspective`, `vanishing point`, `atmospheric perspective` | 透视、消失点或空气透视 |

## 焦点标签

当画面应聚焦特定对象而不是泛泛展示场景时，可使用：

| Tag | 焦点 |
|---|---|
| `animal focus` | 动物 |
| `eye focus` | 眼睛 |
| `cloud focus` | 云层 |
| `vehicle focus` | 车辆 |
| `weapon focus` | 武器 |
| `object focus` | 一般物体 |
| `soft focus` | 柔焦成像，而不是具体对象焦点 |

## 布局与空间关系

常用 Tag：`centered composition`、`side-by-side`、`facing each other`、`symmetrical composition`、`foreground`、`background`、`depth of field`。

Tag 无法完整表达复杂空间时，加入完整英文说明：

```text
The black-haired girl stands in the left foreground, while the pink-haired girl waits several steps behind her on the right. A diagonal line of streetlights leads from the foreground toward the distant station entrance, keeping both characters clearly separated.
```

描述必须包含左右、前后、距离、朝向和镜头，不要只写 `cinematic composition` 让模型猜。

## 光线与颜色

以下是常用 NAI 提示项；按场景选择一到三个相容项：

| 目的 | Tag 或短语 |
|---|---|
| 逆光轮廓 | `backlighting`, `rim lighting` |
| 柔和环境光 | `soft lighting`, `diffused light` |
| 暖色背光 | `warm backlight`, `golden hour` |
| 冷色夜景 | `moonlight`, `blue lighting`, `night` |
| 城市霓虹 | `neon lighting`, `neon reflections` |
| 戏剧明暗 | `dramatic lighting`, `high contrast` |
| 体积光束 | `volumetric lighting`, `light rays` |
| 高光泛光 | `bloom` |
| 镜头光晕 | `lens flare` |

同时写清光从哪里来、照到谁、背景是否更暗。仅堆 `cinematic lighting, beautiful lighting` 不足以确定照明结构。

## V5 复杂度

| Tag | 用途 |
|---|---|
| `low complexity` | 极简、符号化、特殊平面风格 |
| `medium complexity` | 中等细节 |
| `high complexity` | 官方建议的常规精致画面优先项 |
| `ultra complexity` | 刻意繁复或高度风格化；不一定普遍优于 high |
| `depthness` | 增强阴影与空间纵深感 |

复杂度不是通用质量分数。简单图标、水墨留白或极简海报不应机械添加 `ultra complexity`。

## 透明背景

V5 原生支持透明通道：

- 基础写法：`transparent background, has alpha`。
- 需要更强引导时：`2.1::transparent background::`。
- 半透明魔法、火焰、伞等可加入 `alpha transparency` 并用完整英文描述哪些物体应半透明。
- 透明角色立绘通常使用 `portrait` 和 `visual novel sprite`。
- 不要同时要求复杂实体背景与完全透明背景。

## 构图检查

- 画幅是否容纳人数和动作。
- 景别是否与要展示的服装或物件一致。
- 镜头角度是否与主体姿势冲突。
- 多人左右前后关系是否同时由坐标与文本说明。
- 光源方向、颜色和被照亮对象是否明确。
- 焦点、景深与模糊效果是否会遮掉用户最关心的细节。
- 透明背景是否与场景要求冲突。

## 官方依据

- https://docs.novelai.net/en/image/basics/
- https://docs.novelai.net/en/image/tutorial-charactercreation/
- https://docs.novelai.net/en/image/tutorial-artstyles/
- https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/
