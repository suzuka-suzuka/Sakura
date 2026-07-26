# 钓鱼攻略图

`#钓鱼攻略` 会将本目录中的 8 张 JPG 以合并转发消息发送：

1. `01-fish-time.jpg`
2. `02-fish-location.jpg`
3. `03-weather-multipliers.jpg`
4. `04-boss-guide.jpg`
5. `05-nightmare-effects.jpg`
6. `06-item-effects.jpg`
7. `07-location-unlocks.jpg`
8. `08-dex-level-rewards.jpg`

重新生成：

```powershell
cd plugins/sakura-plugin
node scripts/generate-fishing-guides.mjs
```

生成脚本直接读取 `fish.json`、`rules.js`、`special_items.yaml`、`shop.yaml`
和等级/图鉴奖励规则，中文文字与数值不由图像模型生成。

两张底图由 Codex 内置生图工具生成：

- `guide-background-light.png`：樱花、薄雾与湖水构成的明亮竖版攻略底图，中央留白，无文字。
- `guide-background-dark.png`：月夜深水、风暴与暗色浪花构成的竖版首领/噩梦底图，中央留白，无文字、无血腥内容。

请勿只替换 JPG 而不保留生成脚本；数据调整后应重新运行脚本，避免攻略内容与实际规则不一致。
