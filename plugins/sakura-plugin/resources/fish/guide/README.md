# 钓鱼攻略图

`#钓鱼攻略` 会将本目录中的 5 张 JPG 以合并转发消息发送：

1. `01-fish-time.jpg`
2. `02-fish-location-weather.jpg`
3. `03-location-unlocks.jpg`
4. `04-dex-level-rewards.jpg`
5. `05-waterway-encounter.jpg`

公开内容仅包含：

- 非全天渔获的限定出没时间；
- 严格地点限定与天气限定渔获，不展示天气概率或倍率；
- 钓点解锁条件：上一钓点专属图鉴成功收录 15 种，包含跨钓点鱼、不包含全钓点通用鱼；樱花池塘初始开放；
- 图鉴与钓鱼等级奖励；
- 水路遭遇的触发阶段、护符和首领例外、输入、地形行动成本、必须恰好用完规定行动数、时限与奖励规则。

重新生成：

```powershell
cd plugins/sakura-plugin
node scripts/generate-fishing-guides.mjs
```

只重新生成钓点解锁攻略图：`node scripts/generate-fishing-guides.mjs --unlocks-only`。

只重新生成遭遇攻略图：`node scripts/generate-fishing-guides.mjs --encounter-only`。
第五张通过本机 Chrome 渲染 HTML，规则示例由同一判题模块校验。

生成脚本直接读取 `fish.json`、`rules.js`、`special_items.yaml`、`shop.yaml`
和等级/图鉴奖励规则，中文文字与数值不由图像模型生成。

底图由 Codex 内置生图工具生成：

- `guide-background-light.png`：樱花、薄雾与湖水构成的明亮竖版攻略底图，中央留白，无文字。

请勿只替换 JPG 而不保留生成脚本；数据调整后应重新运行脚本，避免攻略内容与实际规则不一致。
