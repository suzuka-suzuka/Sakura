---
name: multi-character
description: 当画面包含两个及以上独立角色、需要角色坐标、避免发色服装串色、表达主动/被动/双向互动，或需要兼顾 V5 与 V4.5 位置限制时加载。单人图不用加载。
version: 1
---

# 多角色、坐标与互动

## 基础提示与角色提示分工

- 人数标签只放基础 `prompt`：`2girls`、`1boy, 1girl`、`3others`。
- 每个 `characters[].prompt` 只以不带数字的 `girl`、`boy` 或 `other` 开头。
- 基础提示负责场景、时间、画风、镜头、光线、全局动作和人物关系。
- 角色提示负责该角色的身份或名字、发型发色、瞳色、服装、配饰、姿势、动作、表情和视线。
- 不要在基础提示重复每个人的完整外观，避免特征串色。
- 某个角色容易获得另一个人的特征时，在该角色的 `undesired` 中写入不属于他的发色、服装或配饰。

## 数组顺序

官方说明角色提示通常按“从上到下、从左到右”的顺序映射到画面。角色数组顺序应与坐标和文字描述相互印证。

两人左右横排时：

1. 左侧角色放在数组第一项。
2. 右侧角色放在第二项。
3. 基础提示加入 `side-by-side` 或准确关系。
4. 每个角色提示可补 `on the left`、`on the right`。

## 坐标

工具坐标采用 0 到 100 的数值，不带 `%`：

| 坐标 | 含义 |
|---|---|
| `x: 0` | 最左 |
| `x: 50` | 水平中央 |
| `x: 100` | 最右 |
| `y: 0` | 最上 |
| `y: 50` | 垂直中央 |
| `y: 100` | 最下 |

- V5 使用连续自由坐标，当前工具最多接受 32 个角色提示。
- V4.5 最多 6 个角色，只有 5×5 粗略位置；底层会把坐标吸附到网格中心。
- 不要把不同角色放在完全相同坐标，除非画面确实要求拥抱、背负等紧密重叠。
- 坐标只提供位置引导；复杂关系仍要用 Tag 和完整英文自然语言说明。
- 希望额度不足时仍能安全降级 V4.5，角色数保持在 6 个以内，并避免依赖极精细位置。

## 互动动作前缀

官方多角色语法：

| 角色关系 | 写法 | 示例 |
|---|---|---|
| 主动者 | `source#动作` | `source#hug`, `source#pointing at another` |
| 被动者 | `target#动作` | `target#hug`, `target#pointing` |
| 双向动作 | 双方都写 `mutual#动作` | `mutual#hug`, `mutual#holding hands` |

这些前缀是引导，不保证绝对可靠。再用完整英文句子说明主谓宾、接触方式、朝向和视线，例如：

```text
The black-haired girl on the left reaches across with her right hand and gently holds the pink-haired girl's left hand. The pink-haired girl turns toward her with a surprised expression, while both remain clearly separated from the background crowd.
```

## 两人结构化示例

```json
{
  "prompt": "2girls, rainy city street at night, visual novel cg, high complexity, neon reflections, cowboy shot, facing each other. The black-haired girl on the left gently takes the pink-haired girl's hand while they stand beneath the same umbrella.",
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

## 常见失败

- 把 `2girls` 重复写进每个角色提示。
- 基础提示堆满所有人的发色和衣服。
- 数组第一项说“右侧”，坐标却在左侧。
- 只靠坐标表达拥抱、递物或攻击。
- 主动与被动角色都误写成 `source#`。
- 多人共享同一件物品时不说明谁拿着、物品位于何处。
- Vibe 自动切到 V4.5 后仍按 7 个以上角色或连续精细坐标设计。

## 官方依据

- https://docs.novelai.net/en/image/multiplecharacters/
- https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/
