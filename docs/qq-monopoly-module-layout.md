# QQ群大富翁模块目录设计

## 1. 设计原则

- 命令入口只负责解析事件和发送结果，不直接修改游戏对象；
- 游戏规则写成可测试的纯状态迁移，不依赖 QQ 事件、Redis 或 Canvas；
- 每次变更都在群会话锁内完成，保存成功后再对外发送消息；
- 地图只允许声明式数据和白名单效果，不加载动态 JavaScript；
- 渲染器只读取公开视图，不持有或修改真实会话；
- 先实现单张默认地图，但接口允许以后增加经过审核的地图。

## 2. 已实现目录

```text
plugins/sakura-plugin/
├─ apps/
│  └─ monopoly.js
├─ lib/
│  └─ monopoly/
│     ├─ constants.js
│     ├─ commands.js
│     ├─ GameService.js
│     ├─ GameEngine.js
│     ├─ SessionStore.js
│     ├─ TimeoutScheduler.js
│     ├─ map/
│     │  ├─ MapLoader.js
│     │  └─ MapValidator.js
│     ├─ rules/
│     │  ├─ dice.js
│     │  ├─ movement.js
│     │  ├─ buildings.js
│     │  ├─ assets.js
│     │  ├─ state.js
│     │  ├─ tileResolver.js
│     │  ├─ property.js
│     │  ├─ settlement.js
│     │  ├─ liquidation.js
│     │  ├─ auction.js
│     │  ├─ chance.js
│     │  ├─ items.js
│     │  ├─ itemActions.js
│     │  └─ victory.js
│     └─ presentation/
│        ├─ PublicView.js
│        ├─ BoardRenderer.js
│        └─ MessageFormatter.js
├─ resources/
│  └─ monopoly/
│     └─ maps/
│        └─ default-40.json

test/                         # 本地目录，受 .gitignore 排除
└─ monopoly/
   ├─ helpers.js
   ├─ map-validator.test.js
   ├─ building-rules.test.js
   ├─ game-engine.test.js
   ├─ settlement.test.js
   ├─ game-service.test.js
   ├─ session-store.test.js
   ├─ timeout-scheduler.test.js
   ├─ command-patterns.test.js
   ├─ board-renderer.test.js
   └─ simulation.test.js
```

以上目录已经落地。`test/` 只用于本地验证，不加入 Git 或上传远端。棋盘渲染复用插件现有中文字体，并为字体不可用的环境保留系统字体回退，因此没有额外建立空的图片或字体目录。

## 3. 模块职责

### `apps/monopoly.js`

- 注册群命令；
- 所有命令接受可选 `#` 前缀；除创建外，没有本群会话时直接返回 `false`；
- 以 `groupId` 形成全机器人账号共享的唯一群会话作用域；
- 把 `selfId`、`groupId`、`userId` 和命令参数交给 `GameService`；
- 把改变盘面的结果渲染为独立图片，随后按顺序补发掷骰回执和下一回合提及；发送失败只记日志，不回滚已提交的状态；
- 不直接访问 Redis，不直接掷骰，不修改玩家现金。

### `GameService.js`

- 大富翁的应用服务和唯一写入口；
- 创建、加入、退出、开始、资产操作、掷骰、购买、欠款处理、认输和强制结束；
- 创建时不自动加入创建者；创建和强制结束只允许管理员或白名单用户；
- 获取群锁、加载会话、调用纯规则引擎、保存会话、释放锁；
- 校验调用者、当前状态和当前玩家回合；
- 保存成功后返回结构化的展示事件；
- 安排或取消超时任务。

建议公开接口：

```text
createGame(context)
joinGame(context)
leaveLobby(context)
startGame(context)
roll(context)
payBail(context)
decide(context, "purchase" | "decline")
build(context, propertyName)
sellBuilding(context, propertyName)
mortgage(context, propertyName)
redeem(context, propertyName)
useItem(context, itemRef, args, atUserId)
forceBuy(context, propertyName)
respondToCounter(context, pass)
placeBid(context, amount)
resolveDebt(context)
surrender(context)
status(context)
forceEnd(context)
handleTimeout(timeoutToken)
sweep(selfId)
```

### `GameEngine.js`

- 接收旧状态和一个明确动作，返回新状态与领域事件；
- 不读取系统时间、Redis、QQ 资料或随机数；
- 骰子点数、洗牌结果和当前时间都由调用方作为输入传入；
- 负责状态机、玩家回合推进、不变量检查和连锁效果上限；游戏不设置轮数上限。

建议入口：

```text
transition(state, action, map, runtimeInput)
```

返回：

```text
{
  state: nextState,
  events: domainEvents
}
```

### `SessionStore.js`

- 会话键和群锁只按 `groupId` 唯一，确保同一群即使接入多个机器人账号也只能开一局；
- 保存完整 JSON 会话并校验 `sessionId`；
- 用 Lua 或事务保证旧任务不能覆盖新会话；
- 提供群会话锁和玩家所在局索引；
- 群锁使用令牌标识所有者，通过比较删除避免误删其他进程持有的锁，并在任务存活期间自动续租；
- 未结束会话和玩家索引采用 48 小时滑动 TTL；索引命中失效会话时要自清理；
- 群锁采用 30 秒租期并在持有期间续租，进程退出后能够自动释放。

建议键名：

```text
sakura:monopoly:session:{groupId}
sakura:monopoly:lock:{groupId}
sakura:monopoly:user:{selfId}:{userId}
sakura:monopoly:cancelled:{groupId}:{sessionId}
```

建议接口：

```text
loadSession(selfId, groupId)
saveSession(session)
deleteSession(session)
claimUserIndex(selfId, userId, groupId)
dropUserIndex(selfId, userId, groupId)
acquireSessionLock({ selfId, groupId })
releaseSessionLock({ selfId, groupId }, token)
```

### `TimeoutScheduler.js`

- 根据会话内的绝对 `deadlineAt` 调度，而不是只依赖内存计时器；
- 超时令牌包含 `sessionId`、`turnSeq` 和 `phase`；
- 插件的 5 秒截止扫描会在进程启动后重新发现未结束会话并恢复计时器；
- 同一超时可以重复投递，但 `GameService` 必须保证处理幂等。

### `map/MapLoader.js`

- 从 `resources/monopoly/maps` 读取地图；
- 读取 JSON，并拒绝当前实现不支持的 `schemaVersion`；
- 深度冻结加载后的地图，防止一局游戏修改共享配置；
- 新局保存 `mapId + mapVersion`，恢复时必须加载同一版本。

### `map/MapValidator.js`

最低校验项：

- `path` 数量与外圈布局一致，默认地图恰好包含 40 个不重复格子并首尾闭环；
- `tiles` 的 ID、路径和坐标一一对应；
- 坐标都位于声明的外圈网格且不重复，默认地图为 11×11；
- 起点、看守所和前往看守所引用有效；
- 每块地产只属于一个有效色组；
- 街区 `rentByLevel` 覆盖空地、1～4 间房和旅馆；车站与公共设施使用各自租金表；
- 房屋和旅馆库存配置完整，并与棋盘建筑数量保持守恒；
- 卡牌只使用允许的效果类型，移动目标存在；
- 玩家数、超时、金额、租金倍率、建筑售价和抵押利率处于合理范围；
- 不允许未知字段悄悄生效，错误必须阻止开局。

### `rules/dice.js`

- 生成并校验两枚六面骰结果，移动使用两枚骰子的总点数；
- 生产环境随机数由 `crypto.randomInt(1, 7)` 生成；
- 测试使用固定点数，不在规则内部伪造随机。

### `rules/movement.js`

- 按地图路径计算新位置；
- 计算经过起点的次数与奖励；
- 区分正常移动、卡牌移动和前往看守所；
- 不负责处理到达格的经济效果。

### `rules/tileResolver.js`

- 按格子类型分发；
- 创建落地购买决策并处理租金、税费和欠款暂停；
- 控制移动后的再次解析；
- 限制单次行动最多解析 4 个格子。

### `rules/buildings.js`、`rules/property.js` 与 `rules/assets.js`

- 管理 32 间房、12 家旅馆的银行库存和建筑归还；
- 购买、自由建造、反向均衡卖房、抵押和赎回；
- 资产操作只允许在当前玩家掷骰前，欠款中只允许欠款人卖房或抵押；
- 计算街区、车站和公共设施的当前租金；
- 保证一块地产最多只有一个所有者；
- 不直接完成现金不足时的破产处理。

### `rules/settlement.js`

- 所有现金转移的统一入口；
- 税费、租金和卡牌付款共用同一套欠款队列；
- 现金不足时持久化欠款和剩余付款，等待玩家卖房、抵押或强制结算；强制结算前先由 `rules/liquidation.js` 自动变现；
- 保证现金不为负、收款不超过实际支付；
- 输出欠款、付款和破产领域事件。

### `rules/chance.js`

- 管理牌堆索引和重新洗牌；
- 只解释白名单效果；
- 卡牌需要移动时交给 `movement.js`；
- 卡牌需要付款时交给 `settlement.js`；
- 卡牌发放道具时交给 `items.js`。

### `rules/liquidation.js`

- 强制结算前的自动变现；
- 先抵押无建筑地产，再按“每换一块钱损失多少租金”拆建筑；
- 只输出一条汇总事件，不刷屏。

### `rules/auction.js`

- 暗拍的开标、出价校验和裁决；
- 出价只存在会话里，公开视图和棋盘播报都拿不到明细；
- 平价按提交先后裁决，保证可复现且不泄露信息。

### `rules/items.js` 与 `rules/itemActions.js`

- `items.js` 负责背包的发放、消耗、汇总和清空，不设持有上限；
- `itemActions.js` 定义可主动使用道具的参数、目标校验和实际效果，强制收购与强制征收共用其中的买断过户逻辑；
- 否决链的开窗、翻转和结算由 `GameEngine.js` 统一驱动。

### `rules/victory.js`

- 检查是否仅剩一名在场玩家；
- 按现金、地产价值、建筑成本和抵押价值计算净资产；
- 生成排名与需要自动进行的平局骰子。

### `presentation/PublicView.js`

- 从真实会话生成只读公开视图；
- 隐去锁令牌、超时任务、内部版本和幂等字段；
- 给棋盘渲染和下一回合提及提供同一份输入。

### `presentation/BoardRenderer.js`

- 使用现有 `@napi-rs/canvas`；
- 将 11×11 外圈坐标渲染为 40 格棋盘；
- 地名最多 4 个字符并居中，金额以同字号只显示数字，玩家颜色棋子位于数字下方；无金额格只显示名称；
- 未购买格子保持白色，购买后按所有者颜色着色并在外圈显示占领条；只有可建房街区显示朝向棋盘内圈的色组线，车站和公共设施不显示；
- 本回合起点失焦，以灰点和虚线箭头连向深色描边的终点；情境状态只放在棋盘中央信息区；
- 中央顶部先显示当前玩家颜色和阶段，再复用飞行棋骰面资源显示双骰、总点数、移动起终点、购买或结算状态、无 `#` 的按钮式命令、拆分卡片后的当前玩家资产，以及分开的房屋和旅馆库存；抵押地产直接标为“抵押”；
- 在棋盘下方纵向显示净资产排名，每名玩家只显示固定颜色名、净资产和当前现金；
- MVP 不远程加载 QQ 头像，直接使用颜色棋子，避免网络资源阻断玩家回合。

### `presentation/MessageFormatter.js`

- 生成掷骰回执（点数、落点、结算摘要、现金与待办）和下一回合提及，收件人相同则合并成一条；
- 否决窗口和暗拍公告也由这里出文案，暗拍公告不带提及；
- 显示名只使用棋子颜色，不使用 QQ 昵称。

## 4. 核心会话结构

下面是字段边界，不是要求逐字照搬的最终代码：

```json
{
  "version": 8,
  "sessionId": "uuid",
  "selfId": "bot qq",
  "groupId": "group qq",
  "mapId": "sakura-city-40",
  "mapVersion": 10,
  "phase": "awaiting_roll",
  "hostUserId": "qq",
  "turnSeq": 12,
  "turnIndex": 1,
  "players": [
    {
      "userId": "qq",
      "displayName": "snapshot only",
      "color": "#EF5350",
      "cash": 720,
      "position": 7,
      "jailTurns": 0,
      "consecutiveDoubles": 1,
      "consecutiveRollTimeouts": 0,
      "forceBuysUsed": 1,
      "status": "active",
      "items": [{ "itemId": "negate", "cardId": "veto_writ" }]
    }
  ],
  "propertyStates": {
    "1": { "ownerId": "qq", "level": 1, "mortgaged": false },
    "3": { "ownerId": null, "level": 0, "mortgaged": false }
  },
  "buildingSupply": {
    "houses": 31,
    "hotels": 12
  },
  "chance": {
    "deckId": "city_chance",
    "order": ["card id"],
    "cursor": 0
  },
  "pendingDecision": null,
  "pendingDebt": null,
  "pendingAction": null,
  "lastDice": {
    "playerId": "qq",
    "values": [3, 3],
    "total": 6,
    "isDouble": true,
    "turnSeq": 12
  },
  "deadlineAt": 0,
  "createdAt": 0,
  "updatedAt": 0
}
```

QQ 昵称只保留在内部会话快照中，不用于对局展示；界面和提示统一用固定颜色名指代玩家，身份仍以字符串化的 `userId` 判断。

`propertyStates` 是地产归属、建筑阶段和抵押状态的唯一事实来源，`level` 的 0～4 表示空地或房屋数，5 表示旅馆；`buildingSupply` 是银行剩余实体房屋和旅馆库存。`pendingDebt` 保存当前付款及后续付款队列。`lastDice` 保存两枚骰面、总点数和对子状态，`consecutiveDoubles` 只在同一个玩家回合中累计。玩家资产和净资产均在读取时派生。`turnSeq` 只在进入新的玩家回合时递增，对子额外掷骰不会递增；会话不保存轮数或轮数上限。

## 5. 一次命令的处理链

```text
QQ事件
  -> monopoly.js 解析命令
  -> GameService 获取群锁
  -> SessionStore 读取并校验 sessionId
  -> GameEngine.transition 生成新状态和领域事件
  -> SessionStore 原子保存
  -> TimeoutScheduler 更新截止任务
  -> 释放群锁
  -> BoardRenderer 生成独立棋盘图片
  -> 如有 turn_started，再由 MessageFormatter 生成下一玩家提及
  -> 依次回复群消息
```

渲染失败不能回滚已完成的游戏状态；入口记录可定位的错误日志，不回退到普通文字结算。

## 6. 测试边界

### 地图

- 40 个格子、路径、坐标、色组、车站和公共设施全覆盖；
- 非法移动目标、重复格子和非法卡牌效果拒绝加载。

### 规则引擎

- 固定双骰下的位置、起点奖励、对子额外掷骰、连续三次对子入狱和玩家回合推进；
- 购买、均衡建房、4 房升级旅馆、库存限制和同色租金；
- 半价反向均衡卖房、旅馆降级、抵押、赎回和免租；
- 欠款暂停、自救、后续付款队列、强制结算和破产；
- 卡牌移动连锁与 4 次上限；
- 看守所 3 次掷骰机会、对子出狱、保释金与强制赎身；
- 道具发放、主动使用和否决链翻转；
- 强制收购的关键地判定、每局次数上限与抵押清偿；
- 无轮数上限的持续对局、净资产排名和平局处理。

### 会话可靠性

- 同群并发两条 `掷骰` 只结算一次，跨机器人账号也不能重复建局；
- 旧局超时不能修改新局；
- 保存后模拟重启可以恢复；
- 玩家索引在认输、破产和结束时正确清理。

### 命令

- 非当前玩家不能操作；
- 所有命令的带 `#` 和不带 `#` 形式等价，无会话时除创建外均返回 `false`；
- 创建者不会自动加入，创建和强停权限只授予管理员或白名单用户；
- 裸“是/否”和裸数字不会触发；
- 管理员权限、房主移交和人数限制正确；
- 改变盘面的命令生成独立棋盘图片，放弃购买、开启否决窗口和道具被否决只回文字；`turn_started` 与否决窗口会产生额外提及文字。

## 7. 实现状态

40 格地图、经典金额、双骰与对子规则、经典看守所规则、资产与欠款规则、五种道具与否决链、Redis 会话与群锁、截止恢复和 Canvas 棋盘均已实现。玩家自由交易和拍卖暂不进入本阶段。
