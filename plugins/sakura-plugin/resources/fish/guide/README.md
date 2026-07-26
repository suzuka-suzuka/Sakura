# 钓鱼攻略图

`#钓鱼攻略` 会将本目录中的 4 张 JPG 以合并转发消息发送：

1. `01-fish-time.jpg`
2. `02-fish-location-weather.jpg`
3. `03-location-unlocks.jpg`
4. `04-dex-level-rewards.jpg`

公开内容仅包含：

- 非全天渔获的限定出没时间；
- 严格地点限定与天气限定渔获，不展示天气概率或倍率；
- 钓点解锁等级；
- 图鉴与钓鱼等级奖励。

重新生成：

```powershell
cd plugins/sakura-plugin
node scripts/generate-fishing-guides.mjs
```

生成脚本直接读取 `fish.json`、`rules.js`、`special_items.yaml`、`shop.yaml`
和等级/图鉴奖励规则，中文文字与数值不由图像模型生成。

底图由 Codex 内置生图工具生成：

- `guide-background-light.png`：樱花、薄雾与湖水构成的明亮竖版攻略底图，中央留白，无文字。

请勿只替换 JPG 而不保留生成脚本；数据调整后应重新运行脚本，避免攻略内容与实际规则不一致。
