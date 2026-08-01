import { createCanvas, GlobalFonts } from "@napi-rs/canvas"
import path from "node:path"
import { pluginresources } from "../../path.js"

// 规则长图：不画棋盘，只把全部规则和回合流程排成一张海报。
// 所有数字、道具、色组、租金表都从地图读，改地图就自动跟着变，
// 免得像文档那样和代码各说各话。
//
// 为手机看做的分页单栏：决定字在手机上多大的不是画布像素宽，而是整图
// 横向能塞多少字——图片 fit-to-width 之后多栏会被按栏数等比压小。
// 所以这里改成一栏到底，再按高度切成若干张，用合并转发一次发出去。

const FONT_FAMILY = "MonopolyRounded"
const MARGIN = 28
const COL_WIDTH = 600
// 单页正文的目标高度，超过就翻页；单节本身超高时不拆，让它独占一页
const MAX_PAGE_BODY = 1180
const CARD_PAD = 22
const SECTION_GAP = 20

const INK = "#263238"
const MUTED = "#607D8B"
const FAINT = "#90A4AE"
const CARD_BG = "#FFFFFF"
const CARD_LINE = "#E3DACB"

let fontReady = false

function ensureFont() {
  if (fontReady) return
  fontReady = true
  try {
    GlobalFonts.registerFromPath(
      path.join(pluginresources, "sign", "font", "FZFWZhuZiAYuanJWD.ttf"),
      FONT_FAMILY
    )
  } catch (error) {
    globalThis.logger?.warn?.(
      `[大富翁] 规则图字体加载失败，将使用系统字体：${error.message}`
    )
  }
}

function font(size, weight = "normal") {
  return `${weight} ${size}px "${FONT_FAMILY}", "Microsoft YaHei", sans-serif`
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function fillRounded(ctx, x, y, width, height, radius, color) {
  roundedRect(ctx, x, y, width, height, radius)
  ctx.fillStyle = color
  ctx.fill()
}

function strokeRounded(ctx, x, y, w, h, radius, color, lineWidth = 1) {
  roundedRect(ctx, x, y, w, h, radius)
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.stroke()
}

// 行首不该出现的收尾标点，换行后往回收一个字
const TRAILING = "。，、；：）」』】？！%·"

function wrapText(ctx, text, maxWidth) {
  const paragraphs = String(text).split("\n")
  const lines = []
  for (const paragraph of paragraphs) {
    let line = ""
    for (const ch of paragraph) {
      if (line && ctx.measureText(line + ch).width > maxWidth) {
        if (TRAILING.includes(ch) && line.length > 1) {
          lines.push(line.slice(0, -1))
          line = line.slice(-1) + ch
        } else {
          lines.push(line)
          line = ch
        }
        continue
      }
      line += ch
    }
    lines.push(line)
  }
  return lines
}

// —— 地图取数 ——

function itemDeckCounts(map) {
  const counts = {}
  for (const deck of map.chanceDecks || []) {
    for (const card of deck.cards) {
      if (card.effect?.type !== "grant_item") continue
      const id = card.effect.itemId
      counts[id] ||= []
      counts[id].push(`${deck.name} ${card.count ?? 1}`)
    }
  }
  return counts
}

function deckTotal(deck) {
  return deck.cards.reduce((sum, card) => sum + (card.count ?? 1), 0)
}

function tilesOfKind(map, propertyKind) {
  return map.tiles.filter(
    (tile) =>
      tile.type === "property" &&
      (tile.propertyKind || "street") === propertyKind
  )
}

function streetGroups(map) {
  const streetIds = new Set(tilesOfKind(map, "street").map((tile) => tile.id))
  return (map.propertyGroups || []).filter((group) =>
    group.tileIds.every((id) => streetIds.has(id))
  )
}

function taxTiles(map) {
  return map.tiles.filter((tile) => tile.type === "tax")
}

const money = (value) => `${Number(value).toLocaleString("en-US")}`

// 抵押金额是每块地自己的字段，不在 gameDefaults 里。
// 全图比例一致时才敢写成「购地价的 xx%」，否则退回笼统说法
function mortgageRatioLabel(map) {
  const ratios = new Set(
    map.tiles
      .filter((tile) => tile.type === "property" && tile.price > 0)
      .map((tile) => Math.round((tile.mortgageValue / tile.price) * 100))
  )
  return ratios.size === 1 ? `购地价的 ${[...ratios][0]}%` : "地图标注的抵押金额"
}

// —— 内容 ——

function buildSections(map) {
  const g = map.gameDefaults
  const itemDecks = itemDeckCounts(map)
  const station = tilesOfKind(map, "station")[0]
  const utility = tilesOfKind(map, "utility")[0]
  const groups = streetGroups(map)
  const sale = Math.round(g.buildingSaleRate * 100)
  const interest = Math.round(g.mortgageInterestRate * 100)
  const audit = Math.round(g.taxAuditRate * 100)

  return [
    {
      accent: "#42A5F5",
      title: "开局",
      blocks: [
        {
          t: "steps",
          items: [
            `群管理员或白名单用户发【创建大富翁】，一个群同时只能有一局。`,
            `所有人发【加入大富翁】入座，创建者也必须自己发一次。开局前可发【退出大富翁】离场。`,
            `房主或管理员发【开始大富翁】。${g.minPlayers}～${g.maxPlayers} 人可开，行动顺序、棋子颜色和两副牌堆的洗牌结果由服务端一次性随机决定。`,
          ],
        },
        {
          t: "kv",
          rows: [
            ["初始现金", money(g.startingCash)],
            ["经过或落在起点", `+${money(g.passStartReward)}`],
            ["房间有效期", `${g.lobbyTimeoutSeconds / 60} 分钟无人开局自动解散`],
          ],
        },
        {
          t: "note",
          tone: "#42A5F5",
          text: "局内现金完全独立，不读也不改樱花币账户。同一个人同时只能参与一局，不能在两个群各开一局。",
        },
      ],
    },

    {
      accent: "#EF5350",
      title: "回合流程",
      blocks: [{ t: "flow", map }],
    },

    {
      accent: "#78909C",
      title: "看守所",
      blocks: [
        {
          t: "bullets",
          items: [
            `踩到「前往监狱」、抽到入狱牌、或同回合连续第 ${g.maxConsecutiveDoubles} 次对子，都会被送进看守所，途中不领起点奖励。`,
            `轮到自己时照常行动，只是掷骰按看守所规则结算，共 ${g.jailMaxTurns} 次机会。`,
            `掷出对子当场出狱并按点数前进，但不再追加掷骰——狱中的对子不计入连对。`,
            `没掷出对子就消耗一次机会，本回合到此结束。`,
            `${g.jailMaxTurns} 次用尽强制赎身：有保释令优先顶掉罚金，否则付 ${money(g.jailBailAmount)}；掏不出就进筹款流程。`,
            `也可以在掷骰前直接发【保释】提前出狱，同样是有卡先用卡，出狱后这一回合完全照常。`,
            `在看守所里建房、卖房、抵押、赎回和使用道具全都照常可用。`,
          ],
        },
      ],
    },

    {
      accent: "#66BB6A",
      title: "地产与租金",
      blocks: [
        {
          t: "bullets",
          items: [
            `只能买本次移动刚到达的无主地，现金正好等于标价也能买。`,
            `发【放弃】或 ${g.decisionTimeoutSeconds} 秒超时都算放弃，该地保持无主，本版本不拍卖流拍地。`,
            `落在他人未抵押地产上立即付租金；落在自己地上没有任何效果。`,
          ],
        },
        {
          t: "table",
          head: ["类型", "租金算法"],
          widths: [0.26, 0.74],
          rows: [
            ["街区", "按当前建筑阶段查该地的租金表"],
            [
              "完整色组",
              `整组齐全时，组内仍是空地的按基础租金 ×${g.completeSetRentMultiplier}`,
            ],
            [
              "车站",
              station
                ? `持有 1～${station.rentByOwnedCount.length} 座 → ${station.rentByOwnedCount.join(" / ")}`
                : "按持有数量阶梯计价",
            ],
            [
              "公共设施",
              utility
                ? `持有 1～${utility.rentDiceMultipliers.length} 个 → 本次骰点 ×${utility.rentDiceMultipliers.join(" / ×")}`
                : "按持有数量乘骰点",
            ],
          ],
        },
        {
          t: "note",
          tone: "#66BB6A",
          text: `抵押中的地自己不收租，但仍然计入色组是否齐全、车站和公共设施的持有数量。所以组里押掉一块，其余未抵押的空地照样按 ${g.completeSetRentMultiplier} 倍收。`,
        },
        {
          t: "groups",
          groups,
          stations: tilesOfKind(map, "station").length,
          utilities: tilesOfKind(map, "utility").length,
        },
      ],
    },

    {
      accent: "#FFA726",
      title: "建房与卖房",
      blocks: [
        {
          t: "bullets",
          items: [
            `必须完整持有该色组，且整组没有任何抵押。`,
            `均衡建造：每次只能选组内建筑数最低的那块，一条指令建一层，可连发。`,
            `每块先建 ${g.housesPerHotel} 间房，再建一次就归还 ${g.housesPerHotel} 间房、领 1 家旅馆。`,
            `卖房反向均衡：只能从组内建筑数最高的拆，返还造价的 ${sale}%。`,
            `拆旅馆需要银行拿得出 ${g.housesPerHotel} 间房，否则暂时降不了级。`,
            `车站和公共设施不能建房；空地也不能卖回银行。`,
          ],
        },
        {
          t: "kv",
          rows: [
            ["银行房屋库存", `${g.houseSupply} 间`],
            ["银行旅馆库存", `${g.hotelSupply} 家`],
            ["库存用尽", "买不到，只能等别人拆房还回来"],
          ],
        },
      ],
    },

    {
      accent: "#8D6E63",
      title: "抵押与赎回",
      blocks: [
        {
          t: "bullets",
          items: [
            `没有建筑的自有地可以抵押，银行按${mortgageRatioLabel(map)}放款。`,
            `抵押街区前必须先卖光整个色组的房子和旅馆。`,
            `抵押后仍保留所有权，但不收租，其色组也不能继续建房。`,
            `掷骰前发【赎回 地名】，付抵押本金加 ${interest}% 利息，小数向上取整。`,
            `欠款阶段只开放卖房和抵押，建房和赎回都会被拒。`,
          ],
        },
      ],
    },

    {
      accent: "#AB47BC",
      title: `强制收购（常驻规则 · 每局 ${g.forceBuyLimit} 次）`,
      blocks: [
        {
          t: "p",
          text: "不需要卡牌，掷骰前发【收购 地名】就能强买。这是本作最硬的一条主动进攻手段。",
        },
        {
          t: "steps",
          items: [
            `目标必须是别人名下、没有建筑的地产。`,
            `必须是关键地——买下它之后你正好凑成一个完整色组，否则不允许收购。`,
            `成交价为标价的 ${g.forceBuyPriceRate} 倍，全额给原主。`,
            `每人整局只能用 ${g.forceBuyLimit} 次，打出即算用掉，被否决令挡下也不退还。`,
          ],
        },
        {
          t: "note",
          tone: "#AB47BC",
          text: "目标是抵押地时，成交额先替银行清偿抵押（本金加一成利息），余额归原主，买家拿到一张已解除抵押的干净地契。所以抵押当不成免疫。",
        },
        {
          t: "p",
          text: "被盯上的人手里只剩这一块、凑不齐色组，因此建不了房——建房防御在这个机制下不成立。唯一的防御手段是否决令。",
        },
      ],
    },

    {
      accent: "#26A69A",
      title: "道具",
      blocks: [
        {
          t: "p",
          text: "道具只能由机会或命运牌发放，不能购买或交易，持有数量没有上限——每种在牌堆里的份数本身就是上限。破产和认输时背包全部作废，不随地产转给债主。",
        },
        {
          t: "items",
          items: (map.items || []).filter((item) => itemDecks[item.id]),
          decks: itemDecks,
        },
        {
          t: "bullets",
          items: [
            `主动道具只能在自己掷骰前使用，目标玩家可以 @、写 QQ 号或写棋子颜色名。`,
            `对任何在场玩家都能用，不限制对方净资产高低。`,
            `交换和征收的目标地块不能有建筑；接手抵押地契要当场向银行付一成过户利息。`,
            `拆迁令在多块并列最高时随机选一块；拆旅馆需要银行有 ${g.housesPerHotel} 间房。`,
          ],
        },
      ],
    },

    {
      // 紧跟道具：否决链是道具系统的一部分，也是强制收购唯一的防御手段
      accent: "#5C6BC0",
      title: `否决链（${g.counterTimeoutSeconds} 秒）`,
      blocks: [
        {
          t: "bullets",
          items: [
            `只有当目标手上确实有否决令时才会开窗口，否则道具直接结算，不让全场干等。`,
            `每加一层否决翻转一次结果：偶数层生效，奇数层作废。否决令也能否决别人的否决。`,
            `窗口超时视为不否决，道具照常生效。`,
            `否决链结算完，回合仍归使用者，不换人——他还没掷骰。`,
          ],
        },
      ],
    },

    {
      accent: "#EC407A",
      title: `暗拍（${g.auctionTimeoutSeconds} 秒）`,
      blocks: [
        {
          t: "p",
          text: "拍卖令的标的可以是任意一块没有建筑的地：无主地、别人的地，甚至自己的地。",
        },
        {
          t: "steps",
          items: [
            `全场暂停 ${g.auctionTimeoutSeconds} 秒，群里公告标的、归属和底价。底价为该地的抵押价。`,
            `所有在场玩家私聊机器人发【出价 金额】，出价互相保密，只回执给出价人自己。`,
            `不得低于底价，也不得超过自己现金；截止前可重复发送修改，以最后一次为准。`,
            `到点开标，价高者得，平价时先报价的人胜。群里只公布中标者和成交价。`,
            `拍走别人的地全额给原主，无主地则归银行。`,
            `原主也可以出价保住自己的地，但中标时这笔钱要交给银行。`,
          ],
        },
        {
          t: "note",
          tone: "#EC407A",
          text: "暗拍期间掷骰和一切资产操作都被挡住，所以开标时每个人的现金和出价时完全一致。无人出价则流拍，地保持原状。",
        },
      ],
    },

    {
      accent: "#EF5350",
      title: `欠款、自救与破产（${g.debtTimeoutSeconds} 秒）`,
      blocks: [
        {
          t: "steps",
          items: [
            `付不起时暂停当前结算，棋盘中央显示应付金额、缺口和可用命令。`,
            `只有欠款玩家能用【卖房 地名】和【抵押 地名】筹款，现金一够就自动付款并继续。`,
            `也可以发【强制结算】，或等超时——两者等价。`,
            `强制结算会先自动变现：优先抵押所有无建筑的地（不减净资产），仍不够才拆建筑（只退半价，净资产实打实缩水）。`,
            `变现后仍不足即破产，收款方只拿到实际支付金额。`,
          ],
        },
        {
          t: "table",
          head: ["清算对象", "地产去向"],
          widths: [0.24, 0.76],
          rows: [
            [
              "欠玩家",
              "建筑折回银行，空地连同抵押状态过户给债主。债主为每块抵押地付一成利息，现金不足时只扣到见底",
            ],
            ["欠银行", "建筑折回银行，地产全部变回无主"],
            ["主动认输", "现金清零、道具作废，名下地产一律归还银行，不给任何人"],
          ],
        },
      ],
    },

    {
      accent: "#FFB300",
      title: "超时与判定",
      blocks: [
        {
          t: "kv",
          rows: [
            ["掷骰", `${g.rollTimeoutSeconds} 秒，前 2 次超时自动掷骰`],
            ["购买", `${g.decisionTimeoutSeconds} 秒，等同于放弃`],
            ["筹款", `${g.debtTimeoutSeconds} 秒，等同于强制结算`],
            ["否决", `${g.counterTimeoutSeconds} 秒，等同于不管`],
            ["暗拍", `${g.auctionTimeoutSeconds} 秒，到点即开标不加时`],
          ],
        },
        {
          t: "bullets",
          items: [
            `连续第 ${g.maxConsecutiveRollTimeouts} 次掷骰超时按认输处理，一次主动有效掷骰会清零计数。`,
            `被插曲打断后回到等待掷骰，会重新给满 ${g.rollTimeoutSeconds} 秒；但建房、抵押、赎回和保释不重置倒计时。`,
          ],
        },
      ],
    },

    {
      accent: "#546E7A",
      title: "结束与排名",
      blocks: [
        {
          t: "p",
          text: "没有轮数上限，仅剩一名在场玩家时自然结束。管理员强制结束时不计算胜者。",
        },
        {
          t: "formula",
          lines: [
            "净资产 ＝ 现金",
            "＋ 未抵押地产的购地价",
            "＋ 未抵押地产上的全部建造成本",
            "＋ 已抵押地产的抵押价值",
          ],
        },
        {
          t: "p",
          text: "在场玩家排在破产和认输玩家之前。净资产相同依次比现金、地产数量，仍相同由服务端掷骰决定。",
        },
      ],
    },

    {
      accent: "#37474F",
      title: "命令速查",
      blocks: [
        {
          t: "p",
          text: "带不带 # 都可以。局内命令只有本局在场玩家发才会被接管，其他人和路人一样静默放行。",
        },
        { t: "cmdgroups", groups: commandGroups() },
      ],
    },
  ]
}

function commandGroups() {
  return [
    {
      title: "房间",
      rows: [
        ["创建大富翁", "管理员 / 白名单创建"],
        ["加入大富翁", "入座，创建者也要发"],
        ["退出大富翁", "开局前离场"],
        ["开始大富翁", "房主或管理员开局"],
        ["结束大富翁", "管理员强制结束"],
        ["认输", "中途退出本局"],
      ],
    },
    {
      title: "回合",
      rows: [
        ["r", "掷骰移动，兼容 扔 / 扔骰子"],
        ["购买 · 放弃", "处理刚到的无主地，兼容 y / n"],
        ["保释", "狱中出狱，兼容 赎身"],
        ["否决 · 不管", "否决窗口内表态"],
        ["强制结算", "放弃筹款，自动变现"],
        ["大富翁规则", "随时查看这张图"],
      ],
    },
    {
      title: "资产与道具",
      rows: [
        ["建房 地名", "建一层，兼容 升级"],
        ["卖房 地名", "拆一层，返还半价"],
        ["抵押 地名 · 赎回 地名", "融资与赎身"],
        ["收购 地名", "双倍标价强制收购"],
        ["使用 道具名 [参数]", "掷骰前使用道具"],
        ["出价 金额", "暗拍报价，仅私聊有效"],
      ],
    },
  ]
}

// —— 排版：先量后画 ——

function measureBlock(ctx, block, width) {
  const inner = width - CARD_PAD * 2
  switch (block.t) {
    case "p": {
      ctx.font = font(19)
      return wrapText(ctx, block.text, inner).length * 28 + 6
    }
    case "bullets": {
      ctx.font = font(19)
      let height = 0
      for (const item of block.items) {
        height += wrapText(ctx, item, inner - 22).length * 28 + 8
      }
      return height + 2
    }
    case "steps": {
      ctx.font = font(19)
      let height = 0
      for (const item of block.items) {
        height +=
          Math.max(1, wrapText(ctx, item, inner - 38).length) * 28 + 12
      }
      return height + 2
    }
    case "kv": {
      return block.rows.length * 34 + 6
    }
    case "table": {
      ctx.font = font(18)
      let height = 34
      for (const row of block.rows) {
        const cellWidth = inner * block.widths[1] - 14
        height += Math.max(1, wrapText(ctx, row[1], cellWidth).length) * 26 + 12
      }
      return height + 4
    }
    case "note": {
      ctx.font = font(18)
      return wrapText(ctx, block.text, inner - 30).length * 26 + 26
    }
    case "items": {
      ctx.font = font(17)
      let height = 0
      for (const item of block.items) {
        height +=
          26 + wrapText(ctx, item.description, inner - 24).length * 24 + 16
      }
      return height
    }
    case "groups": {
      const rows = Math.ceil(block.groups.length / 2)
      return rows * 32 + 34
    }
    case "formula": {
      return block.lines.length * 28 + 24
    }
    case "cmdgroups": {
      // 窄栏放不下三列并排，改成分组纵向堆叠
      return block.groups.reduce(
        (sum, group) => sum + 34 + group.rows.length * 32 + 10,
        6
      )
    }
    case "flow":
      return measureFlow(ctx, block.map, width)
    default:
      return 0
  }
}

function sectionHeight(ctx, section, width) {
  let height = 52
  for (const block of section.blocks) {
    height += measureBlock(ctx, block, width) + 12
  }
  return height + CARD_PAD - 4
}

// 按数组顺序分页，装不下就翻页。一节永远不跨页拆开——规则读到一半
// 换图最难受，宁可让某页矮一点。单节本身超过上限时独占一页。
function paginate(ctx, sections, width) {
  const pages = []
  let current = []
  let used = 0

  for (const section of sections) {
    const height = sectionHeight(ctx, section, width)
    if (current.length > 0 && used + height > MAX_PAGE_BODY) {
      pages.push({ sections: current, bodyHeight: used - SECTION_GAP })
      current = []
      used = 0
    }
    current.push({ section, height })
    used += height + SECTION_GAP
  }
  if (current.length > 0) {
    pages.push({ sections: current, bodyHeight: used - SECTION_GAP })
  }
  return pages
}

// —— 回合流程图 ——

function flowNodes(map) {
  const g = map.gameDefaults
  return [
    {
      kind: "phase",
      tone: "#42A5F5",
      label: "等待掷骰",
      time: `${g.rollTimeoutSeconds}s`,
      subs: [
        "建房 · 卖房 · 抵押 · 赎回，可反复执行",
        "收购 地名 · 使用 道具名 · 保释（在狱中时）",
        "不要求棋子站在目标地产上",
      ],
    },
    {
      kind: "branch",
      label: "掷骰前打出道具可能岔出三条支线",
      items: [
        `目标持有否决令 → 等待否决 ${g.counterTimeoutSeconds}s，逐层翻转`,
        `打出拍卖令 → 暗拍 ${g.auctionTimeoutSeconds}s，全场私聊出价`,
        `稽查逼出欠款 → 对方筹款 ${g.debtTimeoutSeconds}s`,
      ],
      tail: `三条支线结算完，回合都还给使用者，并重新给满 ${g.rollTimeoutSeconds} 秒`,
    },
    { kind: "arrow", label: "发送　r" },
    {
      kind: "phase",
      tone: "#EF5350",
      label: "掷骰移动",
      subs: [
        `两枚骰子点数相加前进，跨过或落在起点 +${money(g.passStartReward)}`,
        "在狱中：对子当场出狱并前进，未中则耗一次机会",
        `同回合连续第 ${g.maxConsecutiveDoubles} 次对子：不移动，直接入狱`,
      ],
    },
    { kind: "arrow" },
    {
      kind: "phase",
      tone: "#FFA726",
      label: "结算落点",
      subs: [
        `无主地 → 等待购买 ${g.decisionTimeoutSeconds}s，购买 / 放弃`,
        "他人未抵押地 → 立即付租金",
        "机会 / 命运 → 抽牌并执行",
        `现金不足 → 等待筹款 ${g.debtTimeoutSeconds}s`,
      ],
    },
    { kind: "arrow" },
    {
      kind: "split",
      tone: "#66BB6A",
      left: "本次掷出对子",
      leftSub: "同一玩家再掷一次，不换人",
      right: "非对子",
      rightSub: "轮到下一名在场玩家",
    },
  ]
}

function flowMetrics(ctx, node, width) {
  const inner = width - CARD_PAD * 2
  if (node.kind === "phase") {
    ctx.font = font(17)
    let height = 40
    for (const sub of node.subs) {
      height += wrapText(ctx, sub, inner - 40).length * 24
    }
    return height + 12
  }
  if (node.kind === "branch") {
    ctx.font = font(17)
    let height = 30
    for (const item of node.items) {
      height += wrapText(ctx, item, inner - 46).length * 24 + 6
    }
    ctx.font = font(16)
    height += wrapText(ctx, node.tail, inner - 30).length * 22 + 12
    return height + 8
  }
  if (node.kind === "arrow") return 40
  if (node.kind === "split") {
    ctx.font = font(16)
    const half = inner / 2 - 16
    const left = wrapText(ctx, node.leftSub, half).length
    const right = wrapText(ctx, node.rightSub, half).length
    return 36 + Math.max(left, right) * 22 + 20
  }
  return 0
}

function measureFlow(ctx, map, width) {
  return flowNodes(map).reduce(
    (sum, node) => sum + flowMetrics(ctx, node, width) + 8,
    0
  )
}

function drawFlow(ctx, map, x, y, width) {
  const inner = width - CARD_PAD * 2
  let cursor = y
  for (const node of flowNodes(map)) {
    const height = flowMetrics(ctx, node, width)

    if (node.kind === "arrow") {
      const cx = x + inner / 2
      ctx.strokeStyle = "#B0BEC5"
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx, cursor + 4)
      ctx.lineTo(cx, cursor + height - 12)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - 6, cursor + height - 16)
      ctx.lineTo(cx, cursor + height - 7)
      ctx.lineTo(cx + 6, cursor + height - 16)
      ctx.fillStyle = "#B0BEC5"
      ctx.fill()
      if (node.label) {
        ctx.font = font(16, "bold")
        ctx.fillStyle = MUTED
        ctx.textAlign = "left"
        ctx.fillText(node.label, cx + 14, cursor + height / 2 + 2)
      }
      cursor += height + 8
      continue
    }

    if (node.kind === "phase") {
      fillRounded(ctx, x, cursor, inner, height, 14, "#FAFAF7")
      strokeRounded(ctx, x, cursor, inner, height, 14, CARD_LINE, 1)
      fillRounded(ctx, x, cursor, 5, height, 3, node.tone)

      ctx.textAlign = "left"
      ctx.font = font(19, "bold")
      ctx.fillStyle = node.tone
      ctx.fillText(node.label, x + 18, cursor + 26)
      if (node.time) {
        ctx.font = font(15)
        ctx.fillStyle = FAINT
        ctx.textAlign = "right"
        ctx.fillText(node.time, x + inner - 16, cursor + 26)
        ctx.textAlign = "left"
      }

      let sy = cursor + 50
      ctx.font = font(17)
      ctx.fillStyle = "#455A64"
      for (const sub of node.subs) {
        for (const line of wrapText(ctx, sub, inner - 40)) {
          ctx.fillText(line, x + 20, sy)
          sy += 24
        }
      }
      cursor += height + 8
      continue
    }

    if (node.kind === "branch") {
      fillRounded(ctx, x + 14, cursor, inner - 14, height, 14, "#FFF8E9")
      strokeRounded(ctx, x + 14, cursor, inner - 14, height, 14, "#F0DFB8", 1)

      ctx.textAlign = "left"
      ctx.font = font(16, "bold")
      ctx.fillStyle = "#B8860B"
      ctx.fillText(node.label, x + 30, cursor + 22)

      let sy = cursor + 46
      ctx.font = font(17)
      ctx.fillStyle = "#5D4037"
      for (const item of node.items) {
        const lines = wrapText(ctx, item, inner - 46)
        ctx.fillStyle = "#C9A227"
        ctx.fillText("┃", x + 30, sy)
        ctx.fillStyle = "#5D4037"
        lines.forEach((line, index) => {
          ctx.fillText(line, x + 46, sy + index * 24)
        })
        sy += lines.length * 24 + 6
      }
      ctx.font = font(16)
      ctx.fillStyle = "#8D6E63"
      for (const line of wrapText(ctx, node.tail, inner - 30)) {
        ctx.fillText(line, x + 30, sy + 6)
        sy += 22
      }
      cursor += height + 8
      continue
    }

    if (node.kind === "split") {
      const half = inner / 2 - 8
      const cells = [
        { label: node.left, sub: node.leftSub, tone: node.tone, dx: 0 },
        { label: node.right, sub: node.rightSub, tone: "#90A4AE", dx: half + 16 },
      ]
      for (const cell of cells) {
        const cx = x + cell.dx
        fillRounded(ctx, cx, cursor, half, height, 12, "#FAFAF7")
        strokeRounded(ctx, cx, cursor, half, height, 12, CARD_LINE, 1)
        ctx.textAlign = "center"
        ctx.font = font(18, "bold")
        ctx.fillStyle = cell.tone
        ctx.fillText(cell.label, cx + half / 2, cursor + 26)
        ctx.font = font(16)
        ctx.fillStyle = "#546E7A"
        let sy = cursor + 50
        for (const line of wrapText(ctx, cell.sub, half - 24)) {
          ctx.fillText(line, cx + half / 2, sy)
          sy += 22
        }
      }
      ctx.textAlign = "left"
      cursor += height + 8
      continue
    }
  }
}

// —— 各类区块绘制 ——

function drawBlock(ctx, block, x, y, width, accent) {
  const inner = width - CARD_PAD * 2
  const left = x + CARD_PAD

  switch (block.t) {
    case "p": {
      ctx.font = font(19)
      ctx.fillStyle = "#455A64"
      ctx.textAlign = "left"
      let cy = y + 20
      for (const line of wrapText(ctx, block.text, inner)) {
        ctx.fillText(line, left, cy)
        cy += 28
      }
      break
    }
    case "bullets": {
      ctx.textAlign = "left"
      let cy = y + 20
      for (const item of block.items) {
        ctx.font = font(19)
        const lines = wrapText(ctx, item, inner - 22)
        ctx.fillStyle = accent
        ctx.beginPath()
        ctx.arc(left + 5, cy - 6, 3.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = "#455A64"
        lines.forEach((line, index) => {
          ctx.fillText(line, left + 22, cy + index * 28)
        })
        cy += lines.length * 28 + 8
      }
      break
    }
    case "steps": {
      ctx.textAlign = "left"
      let cy = y + 20
      block.items.forEach((item, index) => {
        ctx.font = font(19)
        const lines = wrapText(ctx, item, inner - 38)
        ctx.fillStyle = accent
        ctx.beginPath()
        ctx.arc(left + 11, cy - 6, 11, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = "#FFFFFF"
        ctx.font = font(15, "bold")
        ctx.textAlign = "center"
        ctx.fillText(String(index + 1), left + 11, cy - 1)
        ctx.textAlign = "left"
        ctx.font = font(19)
        ctx.fillStyle = "#455A64"
        lines.forEach((line, i) => {
          ctx.fillText(line, left + 34, cy + i * 28)
        })
        cy += lines.length * 28 + 12
      })
      break
    }
    case "kv": {
      let cy = y + 20
      for (const [label, value] of block.rows) {
        ctx.font = font(18)
        ctx.fillStyle = MUTED
        ctx.textAlign = "left"
        ctx.fillText(label, left, cy)
        ctx.font = font(18, "bold")
        ctx.fillStyle = INK
        ctx.textAlign = "right"
        ctx.fillText(value, left + inner, cy)
        cy += 34
      }
      ctx.textAlign = "left"
      break
    }
    case "table": {
      const c0 = inner * block.widths[0]
      let cy = y + 6
      fillRounded(ctx, left, cy, inner, 28, 8, "#F1ECE2")
      ctx.font = font(16, "bold")
      ctx.fillStyle = MUTED
      ctx.textAlign = "left"
      ctx.fillText(block.head[0], left + 12, cy + 19)
      ctx.fillText(block.head[1], left + c0 + 12, cy + 19)
      cy += 34
      for (const row of block.rows) {
        ctx.font = font(18, "bold")
        ctx.fillStyle = INK
        ctx.fillText(row[0], left + 12, cy + 18)
        ctx.font = font(18)
        ctx.fillStyle = "#455A64"
        const lines = wrapText(ctx, row[1], inner * block.widths[1] - 14)
        lines.forEach((line, index) => {
          ctx.fillText(line, left + c0 + 12, cy + 18 + index * 26)
        })
        cy += lines.length * 26 + 12
      }
      break
    }
    case "note": {
      ctx.font = font(18)
      const lines = wrapText(ctx, block.text, inner - 30)
      const height = lines.length * 26 + 22
      fillRounded(ctx, left, y + 2, inner, height, 12, `${block.tone}14`)
      fillRounded(ctx, left, y + 2, 4, height, 2, block.tone)
      ctx.fillStyle = "#455A64"
      ctx.textAlign = "left"
      lines.forEach((line, index) => {
        ctx.fillText(line, left + 18, y + 26 + index * 26)
      })
      break
    }
    case "items": {
      let cy = y + 4
      for (const item of block.items) {
        ctx.font = font(19, "bold")
        ctx.fillStyle = INK
        ctx.textAlign = "left"
        ctx.fillText(item.name, left, cy + 18)

        const badge = (block.decks[item.id] || []).join(" · ")
        ctx.font = font(15)
        ctx.fillStyle = FAINT
        ctx.textAlign = "right"
        ctx.fillText(badge, left + inner, cy + 17)

        ctx.textAlign = "left"
        ctx.font = font(17)
        ctx.fillStyle = "#607D8B"
        const lines = wrapText(ctx, item.description, inner - 24)
        lines.forEach((line, index) => {
          ctx.fillText(line, left + 12, cy + 44 + index * 24)
        })
        cy += 26 + lines.length * 24 + 16
      }
      break
    }
    case "groups": {
      ctx.font = font(16, "bold")
      ctx.fillStyle = MUTED
      ctx.textAlign = "left"
      ctx.fillText(
        `可建房色组 ${block.groups.length} 组 · 车站 ${block.stations} 座 · 公共设施 ${block.utilities} 个`,
        left,
        y + 18
      )
      const cellWidth = inner / 2 - 6
      block.groups.forEach((group, index) => {
        const gx = left + (index % 2) * (cellWidth + 12)
        const gy = y + 32 + Math.floor(index / 2) * 32
        fillRounded(ctx, gx, gy, cellWidth, 26, 7, `${group.color}1F`)
        fillRounded(ctx, gx, gy, 5, 26, 2, group.color)
        ctx.font = font(17)
        ctx.fillStyle = "#455A64"
        ctx.fillText(group.name, gx + 14, gy + 18)
        ctx.font = font(15)
        ctx.fillStyle = FAINT
        ctx.textAlign = "right"
        ctx.fillText(`${group.tileIds.length} 块`, gx + cellWidth - 10, gy + 18)
        ctx.textAlign = "left"
      })
      break
    }
    case "formula": {
      const height = block.lines.length * 28 + 18
      fillRounded(ctx, left, y + 4, inner, height, 12, "#F1ECE2")
      ctx.font = font(19, "bold")
      ctx.fillStyle = INK
      ctx.textAlign = "left"
      block.lines.forEach((line, index) => {
        ctx.fillText(line, left + 18, y + 32 + index * 28)
      })
      break
    }
    case "cmdgroups": {
      let cy = y + 6
      for (const group of block.groups) {
        ctx.textAlign = "left"
        ctx.font = font(18, "bold")
        ctx.fillStyle = accent
        ctx.fillText(group.title, left, cy + 20)
        cy += 34
        for (const [cmd, desc] of group.rows) {
          fillRounded(ctx, left, cy - 2, inner, 28, 7, "#F5F1E8")
          ctx.font = font(17, "bold")
          ctx.fillStyle = INK
          ctx.fillText(cmd, left + 12, cy + 18)
          const used = ctx.measureText(cmd).width
          ctx.font = font(15)
          ctx.fillStyle = MUTED
          ctx.fillText(desc, left + Math.max(used + 22, 190), cy + 18)
          cy += 32
        }
        cy += 10
      }
      break
    }
    case "flow": {
      drawFlow(ctx, block.map, left, y + 4, width)
      break
    }
  }
}

function drawSection(ctx, section, x, y, width) {
  const height = sectionHeight(ctx, section, width)
  fillRounded(ctx, x, y, width, height, 18, CARD_BG)
  strokeRounded(ctx, x, y, width, height, 18, CARD_LINE, 1)
  fillRounded(ctx, x, y, width, 5, 2, section.accent)

  ctx.textAlign = "left"
  ctx.font = font(23, "bold")
  ctx.fillStyle = INK
  ctx.fillText(section.title, x + CARD_PAD, y + 38)

  let cursor = y + 52
  for (const block of section.blocks) {
    drawBlock(ctx, block, x, cursor, width, section.accent)
    cursor += measureBlock(ctx, block, width) + 12
  }
  return height
}

// —— 页眉与命令速查 ——

function headerStats(map) {
  const g = map.gameDefaults
  const decks = (map.chanceDecks || [])
    .map((deck) => `${deck.name} ${deckTotal(deck)}`)
    .join(" / ")
  return [
    ["人数", `${g.minPlayers}–${g.maxPlayers} 人`],
    ["棋盘", `${map.board.size} 格`],
    ["骰子", `${g.diceCount} × D${g.diceSides}`],
    ["初始现金", money(g.startingCash)],
    ["过起点", `+${money(g.passStartReward)}`],
    ["建筑上限", `${g.housesPerHotel} 房 → 旅馆`],
    ["牌堆", decks],
    ["强制收购", `${g.forceBuyLimit} 次 · ${g.forceBuyPriceRate} 倍价`],
  ]
}

// 数字条按可用宽度折行：窄图硬塞一行会让「机会 17 / 命运 17」压到下一格
function headerLayout(ctx, map, width) {
  const stats = headerStats(map)
  ctx.font = font(20, "bold")
  const widest = Math.max(
    ...stats.map(([, value]) => ctx.measureText(value).width)
  )
  const usable = width - 68
  const fits = Math.max(
    1,
    Math.min(stats.length, Math.floor(usable / (widest + 28)))
  )
  // 先算出最多能放几个，再摊平成每行一样多，免得出现 6 + 2 这种尾巴
  const rows = Math.ceil(stats.length / fits)
  const perRow = Math.ceil(stats.length / rows)
  return { stats, perRow, rows, height: 118 + rows * 46 + 6 }
}

function drawHeader(ctx, map, x, y, width) {
  const { stats, perRow, height } = headerLayout(ctx, map, width)
  fillRounded(ctx, x, y, width, height, 20, "#263238")

  ctx.textAlign = "left"
  ctx.font = font(32, "bold")
  ctx.fillStyle = "#FFFFFF"
  ctx.fillText(`${map.name} · 规则全书`, x + 26, y + 50)

  ctx.font = font(16)
  ctx.fillStyle = "#90A4AE"
  ctx.fillText(
    `地图 ${map.id} v${map.version}　·　群内发送【大富翁规则】随时查看`,
    x + 26,
    y + 78
  )

  const cellWidth = (width - 52) / perRow
  stats.forEach(([label, value], index) => {
    const cx = x + 26 + (index % perRow) * cellWidth
    const cy = y + 116 + Math.floor(index / perRow) * 46
    ctx.font = font(15)
    ctx.fillStyle = "#78909C"
    ctx.fillText(label, cx, cy)
    ctx.font = font(20, "bold")
    ctx.fillStyle = "#FFD54F"
    ctx.fillText(value, cx, cy + 26)
  })
  return height
}

function drawPageFooter(ctx, map, x, y, width, index, total) {
  ctx.textAlign = "left"
  ctx.font = font(15)
  ctx.fillStyle = FAINT
  ctx.fillText(`${map.name} · 规则`, x, y)
  ctx.textAlign = "right"
  ctx.fillText(`${index + 1} / ${total}`, x + width, y)
  ctx.textAlign = "left"
}

/**
 * 渲染规则长图，按高度切成若干页。
 * @returns {Promise<Array<{title: string, image: Buffer}>>} 每页的小标题和 PNG
 */
export async function renderRulesPages(map) {
  ensureFont()

  const scratch = createCanvas(10, 10).getContext("2d")
  const pages = paginate(scratch, buildSections(map), COL_WIDTH)
  const headerHeight = headerLayout(scratch, map, COL_WIDTH).height
  const canvasWidth = COL_WIDTH + MARGIN * 2
  const FOOTER = 34

  return pages.map((page, index) => {
    const top = index === 0 ? MARGIN + headerHeight + 20 : MARGIN
    const canvasHeight = top + page.bodyHeight + FOOTER + MARGIN

    const canvas = createCanvas(canvasWidth, canvasHeight)
    const ctx = canvas.getContext("2d")

    const gradient = ctx.createLinearGradient(0, 0, canvasWidth, canvasHeight)
    gradient.addColorStop(0, "#F7F2E8")
    gradient.addColorStop(1, "#E8DED0")
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)

    if (index === 0) drawHeader(ctx, map, MARGIN, MARGIN, COL_WIDTH)

    let cursor = top
    for (const entry of page.sections) {
      drawSection(ctx, entry.section, MARGIN, cursor, COL_WIDTH)
      cursor += entry.height + SECTION_GAP
    }

    drawPageFooter(
      ctx,
      map,
      MARGIN,
      canvasHeight - MARGIN - 6,
      COL_WIDTH,
      index,
      pages.length
    )

    return {
      title: page.sections.map((entry) => entry.section.title).join(" · "),
      image: canvas.toBuffer("image/png"),
    }
  })
}
