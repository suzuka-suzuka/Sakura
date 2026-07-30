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
│     │  ├─ state.js
│     │  ├─ tileResolver.js
│     │  ├─ property.js
│     │  ├─ settlement.js
│     │  ├─ chance.js
│     │  └─ victory.js
│     └─ presentation/
│        ├─ PublicView.js
│        ├─ BoardRenderer.js
│        └─ MessageFormatter.js
├─ resources/
│  └─ monopoly/
│     └─ maps/
│        └─ default-24.json

test/                         # 本地目录，受 .gitignore 排除
└─ monopoly/
   ├─ helpers.js
   ├─ map-validator.test.js
   ├─ game-engine.test.js
   ├─ settlement.test.js
   ├─ game-service.test.js
   ├─ session-store.test.js
   ├─ timeout-scheduler.test.js
   ├─ board-renderer.test.js
   └─ simulation.test.js
```

以上目录已经落地。`test/` 只用于本地验证，不加入 Git 或上传远端。棋盘渲染复用插件现有中文字体，并为字体不可用的环境保留系统字体回退，因此没有额外建立空的图片或字体目录。

## 3. 模块职责

### `apps/monopoly.js`

- 注册群命令；
- 使用 `selfId + groupId` 形成机器人账号隔离的群作用域；
- 把 `selfId`、`groupId`、`userId` 和命令参数交给 `GameService`；
- 将服务返回的消息、提及和图片发到群内；
- 不直接访问 Redis，不直接掷骰，不修改玩家现金。

### `GameService.js`

- 大富翁的应用服务和唯一写入口；
- 创建、加入、退出、开始、掷骰、选择、认输和强制结束；
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
decide(context, "purchase" | "upgrade" | "decline")
surrender(context)
status(context)
forceEnd(context)
handleTimeout(timeoutToken)
```

### `GameEngine.js`

- 接收旧状态和一个明确动作，返回新状态与领域事件；
- 不读取系统时间、Redis、QQ 资料或随机数；
- 骰子点数、洗牌结果和当前时间都由调用方作为输入传入；
- 负责状态机、玩家回合与轮次推进、不变量检查和连锁效果上限。

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

- Redis 键必须同时包含 `selfId` 和 `groupId`；
- 保存完整 JSON 会话并校验 `sessionId`；
- 用 Lua 或事务保证旧任务不能覆盖新会话；
- 提供群会话锁和玩家所在局索引；
- 延续 `witchtrial/SessionStore.js` 已采用的令牌锁、比较删除和自动续租思路。
- 未结束会话和玩家索引采用 48 小时滑动 TTL；索引命中失效会话时要自清理；
- 群锁采用 30 秒租期并在持有期间续租，进程退出后能够自动释放。

建议键名：

```text
sakura:monopoly:session:{selfId}:{groupId}
sakura:monopoly:lock:{selfId}:{groupId}
sakura:monopoly:user:{selfId}:{userId}
sakura:monopoly:cancelled:{selfId}:{groupId}:{sessionId}
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

- `path` 恰好包含 24 个不重复格子，并首尾形成逻辑闭环；
- `tiles` 的 ID、路径和坐标一一对应；
- 坐标都位于 7×7 外圈且不重复；
- 起点、看守所和前往看守所引用有效；
- 每块地产只属于一个有效色组；
- `rentByLevel` 长度等于最高等级加一，且数值为非负整数；
- 卡牌只使用允许的效果类型，移动目标存在；
- 玩家数、超时、金额、倍率和回收率处于合理范围；
- 不允许未知字段悄悄生效，错误必须阻止开局。

### `rules/dice.js`

- 校验服务端传入的骰子结果；
- 生产环境随机数由 `crypto.randomInt(1, 7)` 生成；
- 测试使用固定点数，不在规则内部伪造随机。

### `rules/movement.js`

- 按地图路径计算新位置；
- 计算经过起点的次数与奖励；
- 区分正常移动、卡牌移动和前往看守所；
- 不负责处理到达格的经济效果。

### `rules/tileResolver.js`

- 按格子类型分发；
- 创建购买或升级决策；
- 控制移动后的再次解析；
- 限制单次行动最多解析 4 个格子。

### `rules/property.js`

- 购买、升级、所有权和同色组判定；
- 计算当前租金；
- 保证一块地产最多只有一个所有者；
- 不直接完成现金不足时的破产处理。

### `rules/settlement.js`

- 所有现金转移的统一入口；
- 税费、租金、卡牌付款共用同一套强制变卖规则；
- 保证现金不为负、收款不超过实际支付；
- 输出变卖、付款和破产领域事件。

### `rules/chance.js`

- 管理牌堆索引和重新洗牌；
- 只解释白名单效果；
- 卡牌需要移动时交给 `movement.js`；
- 卡牌需要付款时交给 `settlement.js`。

### `rules/victory.js`

- 检查仅剩一人和轮次上限；
- 计算强制变卖口径的净资产；
- 生成排名与需要自动进行的平局骰子。

### `presentation/PublicView.js`

- 从真实会话生成只读公开视图；
- 隐去锁令牌、超时任务、内部版本和幂等字段；
- 给文字格式化和图片渲染提供同一份输入。

### `presentation/BoardRenderer.js`

- 使用现有 `@napi-rs/canvas`；
- 将 7×7 外圈坐标渲染为 24 格棋盘；
- 显示棋子、地产颜色、所有者、等级、轮次和当前玩家；
- MVP 不远程加载 QQ 头像，直接使用颜色棋子和昵称首字，避免网络资源阻断玩家回合。

### `presentation/MessageFormatter.js`

- 把领域事件合并为一条简短结算摘要；
- 只在需要操作时提及当前玩家；
- 购买、升级和超时提示必须明确可用命令；
- 不输出 Redis 键、内部状态名或堆栈错误。

## 4. 核心会话结构

下面是字段边界，不是要求逐字照搬的最终代码：

```json
{
  "version": 1,
  "sessionId": "uuid",
  "selfId": "bot qq",
  "groupId": "group qq",
  "mapId": "sakura-city-24",
  "mapVersion": 1,
  "phase": "awaiting_roll",
  "hostUserId": "qq",
  "turnSeq": 12,
  "round": 3,
  "roundLimit": 18,
  "turnIndex": 1,
  "players": [
    {
      "userId": "qq",
      "displayName": "snapshot only",
      "color": "#EF5350",
      "cash": 7200,
      "position": 7,
      "jailTurns": 0,
      "consecutiveRollTimeouts": 0,
      "status": "active"
    }
  ],
  "propertyStates": {
    "1": { "ownerId": "qq", "level": 1 },
    "3": { "ownerId": null, "level": 0 }
  },
  "chance": {
    "deckId": "city_chance",
    "order": ["card id"],
    "cursor": 0
  },
  "pendingDecision": null,
  "deadlineAt": 0,
  "createdAt": 0,
  "updatedAt": 0
}
```

QQ 昵称只用于展示快照，玩家身份始终以字符串化的 `userId` 判断。

`propertyStates` 是地产归属和等级的唯一事实来源；玩家地产列表、地产数量和净资产全部在读取时派生，不能再在玩家对象里保存一份可变副本。`round` 表示当前轮次，`turnSeq` 是每次玩家回合递增的单调序号。

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
  -> MessageFormatter / BoardRenderer
  -> 回复群消息
```

渲染失败不能回滚已完成的游戏状态；此时发送纯文字结果，并记录可定位的错误日志。

## 6. 测试边界

### 地图

- 24 个格子、路径、坐标和色组全覆盖；
- 非法移动目标、重复格子和非法卡牌效果拒绝加载。

### 规则引擎

- 固定骰子下的位置、起点奖励、玩家回合和轮次推进；
- 购买、升级、同色租金和满级；
- 强制变卖顺序、部分付款和破产；
- 卡牌移动连锁与 4 次上限；
- 看守所跳过一个玩家回合；
- 动态轮次上限、净资产排名和平局处理。

### 会话可靠性

- 同群并发两条 `#掷骰` 只结算一次；
- 旧局超时不能修改新局；
- 保存后模拟重启可以恢复；
- 玩家索引在认输、破产和结束时正确清理。

### 命令

- 非当前玩家不能操作；
- 裸“是/否”和裸数字不会触发；
- 管理员权限、房主移交和人数限制正确；
- 掷骰移动完成后生成棋盘；存在购买或升级选择时，选择完成后再生成更新棋盘。

## 7. 实现状态

地图校验、纯规则引擎、Redis 会话与群锁、命令入口、截止恢复和 Canvas 棋盘均已实现。下一阶段是部署到测试群，根据真实局长、破产率和购买率调整地图 JSON 中的经济数值。
