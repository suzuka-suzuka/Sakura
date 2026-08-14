"""碧蓝档案·回合制群战 —— 战斗内核 v5（交替回合 + 2 槽 EX 技能牌）"""
import random
from dataclasses import dataclass
from typing import List, Dict, Any

CFG = dict(
    DEF_K            = 400,
    AFF_STRONG       = 1.35,
    AFF_NORMAL       = 1.00,
    AFF_WEAK         = 0.75,
    CRIT_DMG         = 1.50,
    DODGE_K          = 200,   # 闪避率 =(闪避-命中)/200，每 2 点差 1%
    DODGE_CAP        = 0.35,
    CRIT_CAP         = 0.60,
    # --- Cost（v4 锁定：回复只取决于场上存活人数，与本回合是否出招无关）---
    COST_START       = 0,     # 双方开局 Cost，对等
    COST_REGEN       = 0,     # 不随战损衰减的保底部分
    COST_REGEN_PER_UNIT = 0.5,  # 每存活角色 ×N：满编每个己方回合 2，剩 2 人时 1
    COST_MAX         = 10,
    COST_PASS_BONUS  = 0,     # v4 删除：「过 +1」让回复取决于玩家行为，不对等
    EX_HAND_SIZE     = 2,     # 4 张角色技能牌中同时只展示 2 张，用后补牌
    # --- 先手补偿（实验开关）---
    FIRST_SKIP_COST  = False,  # 先手方第 1 回合不回 Cost
    FIRST_PRICE      = None, # 备用计价方式：先手方自扣 N 点（默认改用 SECOND_BONUS 补偿制）  # 不为 None 时改用「先手方开局 Cost -N」计价
    SECOND_BONUS     = 3,     # 后手方开局补偿；技能牌窗口版扫描 0~3 后最接近五五开
    FIRST_NO_ACT     = False, # 先手方第 1 回合角色不自动行动
    # --- 白热化 ---
    ULT_COMMIT       = 8,     # 高费牌进窗口后留费；未抽到时先用其他可见牌轮转
    SD_START         = 10,
    SD_DMG_STEP      = 0.20,
    SD_HEAL_STEP     = 0.25,
    DMG_JITTER       = 0.05,
    RNG_MODE         = "pure",   # v4：暴击/闪避改真随机，给落后方留翻盘的运气空间
    MAX_ROUND        = 22,
    CHARGE_STEP      = 0.0,   # 充能（默认关闭，高费 EX 本身就是攒 Cost 的理由）
    CHARGE_MAX       = 3,
)

ATK_TYPES = ["爆发", "贯通", "神秘", "振动"]
DEF_TYPES = ["轻装", "重装", "特殊", "弹力"]
AFF_TABLE = {
    "爆发": {"轻装":"S", "重装":"W", "特殊":"N", "弹力":"N"},
    "贯通": {"轻装":"N", "重装":"S", "特殊":"W", "弹力":"N"},
    "神秘": {"轻装":"W", "重装":"N", "特殊":"S", "弹力":"N"},
    "振动": {"轻装":"N", "重装":"N", "特殊":"W", "弹力":"S"},
}
def affinity(at, dt):
    g = AFF_TABLE[at][dt]
    return CFG["AFF_STRONG"] if g=="S" else (CFG["AFF_WEAK"] if g=="W" else CFG["AFF_NORMAL"])

@dataclass
class Tmpl:
    id: str; name: str; atk_type: str; def_type: str
    hp: int; atk: int; dfs: int; crit: float; dodge: int; acc: int
    skill: Dict[str, Any]
    ex: Dict[str, Any]
    na_mult: float = 1.0

def D(mult, target="lane", **kw):
    d = dict(kind="damage", mult=mult, target=target); d.update(kw); return d

CURRENT_TURN_BUFF_STATS = {"atk", "dmg_deal", "crit", "crit_dmg"}
CURRENT_TURN_DEBUFF_STATS = {"dfs", "dmg_take"}

def source_key(side, idx): return f"{side}:{idx}"

def status_source_key(status):
    if status.get("source_key"): return status["source_key"]
    if isinstance(status.get("src_side"),int) and isinstance(status.get("src_idx"),int):
        return source_key(status["src_side"],status["src_idx"])
    return None

def upsert_status_layer(items, new):
    key=status_source_key(new)
    matches=lambda old: (key and status_source_key(old)==key and
                         old.get("effect_kind")==new.get("effect_kind") and
                         old.get("stat")==new.get("stat"))
    found=next((i for i,old in enumerate(items) if matches(old)),None)
    if found is None: items.append(new)
    else:
        items[found]=new
        items[:]=[old for i,old in enumerate(items) if i<=found or not matches(old)]
    return new

def upsert_dot_layer(items, new):
    key=status_source_key(new)
    found=next((i for i,old in enumerate(items) if key and status_source_key(old)==key),None)
    if found is None: items.append(new)
    else:
        items[found]=new
        items[:]=[old for i,old in enumerate(items) if i<=found or status_source_key(old)!=key]
    return new

def timed_friendly_buff(buff, turn_id, source):
    return dict(buff,effect_kind="buff",source_key=source_key(source.side,source.idx),
                src_side=source.side,src_idx=source.idx,st=turn_id,
                count_current=buff.get("stat") in CURRENT_TURN_BUFF_STATS)

def timed_enemy_debuff(debuff, turn_id, source, target_side):
    count_current = debuff.get("stat") in CURRENT_TURN_DEBUFF_STATS
    return dict(debuff,effect_kind="debuff",source_key=source_key(source.side,source.idx),
                src_side=source.side,src_idx=source.idx,st=turn_id,count_current=count_current,
                tick_side=source.side if count_current else target_side)

ROSTER: List[Tmpl] = [
 # ---------- 爆发（克轻装 / 被重装抵抗） ----------
 # 精准狙击：高攻击与高命中并存，代价落在全场最低一档的体质与闪避上。
 Tmpl("YH","炎火","爆发","轻装", 5530, 975, 160, .28,  25, 60,
      skill=dict(cd=3, **D(2.40)),
      ex=dict(cost=3, **D(3.50, target="enemy_single", exec_bonus=(0.50, 1.5)))),
 # 全场唯一 10 费：攒满条才放得出，Cost 公开可见 = 公开宣战
 Tmpl("ZP","重炮","爆发","重装", 7560, 610, 340, .10,   5, 45,
      skill=dict(cd=3, **D(1.90, target="lane_splash", splash=0.45)),
      ex=dict(cost=10, **D(6.20, target="enemy_all"))),
 # 普技 CD 从 2 改回 3：不再独占「最快普技」这个结构特权
 # 低费高闪：靠闪避生存，面板防御很薄；便宜 EX 用低命中偿还效率。
 Tmpl("SG","闪光","爆发","特殊", 6160, 730, 150, .30, 105, 30,
      skill=dict(cd=3, **D(2.00)),
      ex=dict(cost=2, **D(1.70, target="enemy_single"))),
 Tmpl("LF","烈风","爆发","弹力", 7350, 660, 260, .15,  65, 55,
      skill=dict(cd=3, **D(1.80)),
      ex=dict(cost=4, kind="support", target="ally_all",
              buffs=[dict(stat="dmg_deal", value=1.00, turns=2)])),
 # ---------- 贯通（克重装 / 被特殊抵抗） ----------
 # 防御型坦输：高防御、低闪避，和潮汐走完全不同的生存路线。
 Tmpl("CJ","穿甲","贯通","重装", 7700, 685, 360, .12,   5, 45,
      skill=dict(cd=3, **D(2.00, debuffs=[dict(stat="dfs", value=-0.25, turns=2)])),
      ex=dict(cost=3, **D(3.40, target="enemy_single",
                          debuffs=[dict(stat="dfs", value=-0.35, turns=3)]))),
 Tmpl("RF","锐锋","贯通","轻装", 5950, 860, 175, .42,  70, 35,
      skill=dict(cd=3, **D(2.20)),
      ex=dict(cost=2, **D(2.20, target="enemy_single", force_crit=True))),
 # 多段散射允许单段落空，以命中换取低费四段和跨线随机覆盖。
 Tmpl("LS","连射","贯通","特殊", 6650, 730, 220, .20,  60, 30,
      skill=dict(cd=3, **D(2.00)),
      ex=dict(cost=3, **D(1.50, target="enemy_random", hits=4))),
 Tmpl("GY","贯月","贯通","弹力", 6930, 710, 280, .18,  45, 50,
      skill=dict(cd=3, **D(2.10)),
      ex=dict(cost=4, **D(3.80, target="lane_splash", splash=0.75, ignore_dead_lane=True))),
 # ---------- 神秘（克特殊 / 被轻装抵抗） ----------
 Tmpl("MY","秘仪","神秘","特殊", 6790, 710, 230, .10,  65, 55,
      skill=dict(cd=3, kind="support", target="ally_lowest", heal=1.30),
      ex=dict(cost=5, kind="support", target="ally_all", heal=2.40)),
 # 控制位需要可靠命中，但不再同时占有顶级基础攻击。
 Tmpl("ZF","咒缚","神秘","轻装", 6300, 845, 180, .24,  75, 65,
      skill=dict(cd=3, **D(2.00)),
      ex=dict(cost=4, **D(4.20, target="enemy_single", stun=1))),
 # 纯防御坦：血防全场最高、几乎不闪，和高闪低防的潮汐互为镜像。
 Tmpl("LH","灵护","神秘","重装", 8470, 655, 400, .08,   5, 50,
      skill=dict(cd=3, kind="support", target="self", shield=2.80, shield_turns=2),
      ex=dict(cost=6, kind="support", target="ally_all", shield=3.00, shield_turns=2,
              buffs=[dict(stat="atk", value=0.55, turns=2)])),
 Tmpl("XS","虚数","神秘","弹力", 7140, 700, 250, .15,  40, 45,
      skill=dict(cd=3, **D(1.50, dot=dict(value=0.60, turns=3))),
      ex=dict(cost=6, **D(2.30, target="enemy_all", detonate=1.70))),
 # ---------- 振动（克弹力 / 被特殊抵抗） ----------
 # 低费轮转辅助，因此基础输出、体质与统一命中都偏低。
 Tmpl("GM","共鸣","振动","弹力", 6510, 625, 240, .12,  55, 30,
      skill=dict(cd=3, cost_gain=3, **D(1.80)),
      ex=dict(cost=2, **D(2.00, target="enemy_single"))),
 # 4 费同时覆盖全体并挂破防，靠最低档命中承担范围与功能预算。
 Tmpl("ZD","震荡","振动","轻装", 6580, 885, 190, .20,  50, 25,
      skill=dict(cd=3, **D(2.10)),
      ex=dict(cost=4, **D(2.00, target="enemy_all",
                          debuffs=[dict(stat="dfs", value=-0.25, turns=3)]))),
 # 闪避坦：主动吸引火力但基础防御很低，遇到高命中对手会明显变脆。
 Tmpl("CX","潮汐","振动","特殊", 7350, 670, 160, .10,  95, 45,
      skill=dict(cd=3, **D(1.80, self_buffs=[dict(stat="dmg_take", value=-0.20, turns=2)])),
      ex=dict(cost=3, kind="support", target="self", taunt=1, heal=1.20,
              reflect=0.80, reflect_turns=1,
              buffs=[dict(stat="dmg_take", value=-0.60, turns=1)])),
 # 血量坦：主要靠血池、自愈与团队治疗续航，不复制灵护的高防模板。
 Tmpl("HX","回响","振动","重装", 11600, 570, 180, .10,  20, 50,
      skill=dict(cd=3, **D(1.70, self_heal=0.80)),
      ex=dict(cost=4, kind="support", target="ally_all", heal=1.15, cleanse=True)),
]
BY_ID = {t.id: t for t in ROSTER}
# 正式数值已经把 autotune 输出烘焙进上面的角色表；每次扫描都从 1.0 开始。
TUNE = {t.id:[1.0,1.0] for t in ROSTER}

class Unit:
    __slots__=("t","idx","side","hp","maxhp","buffs","dots","shield","shield_max","shield_turns","shield_tick_side",
               "stun","taunt","skill_cd","crit_gauge","dodge_gauge",
               "alive","dmg_dealt","dmg_taken","reflect","reflect_turns",
               "stun_st","taunt_st","reflect_st","shield_st")
    def __init__(self, t: Tmpl, idx: int, side: int):
        self.t=t; self.idx=idx; self.side=side
        self.maxhp=t.hp*TUNE[t.id][1]; self.hp=self.maxhp
        self.buffs=[]; self.dots=[]
        self.shield=0.0; self.shield_max=0.0; self.shield_turns=0; self.shield_tick_side=1-side
        self.stun=0; self.taunt=0
        self.skill_cd=t.skill.get("cd",99)
        self.crit_gauge=0.0; self.dodge_gauge=0.0
        self.alive=True
        self.dmg_dealt=0.0; self.dmg_taken=0.0
        self.reflect=0.0; self.reflect_turns=0
        self.stun_st=self.taunt_st=self.reflect_st=self.shield_st=-1
    def factor(self, stat):
        value=1.0
        for status in self.buffs:
            if status["stat"]==stat: value*=1+status["value"]
        return value
    @property
    def atk(self):  return self.t.atk*TUNE[self.t.id][0] * max(0.2,self.factor("atk"))
    @property
    def dfs(self):  return self.t.dfs * max(0.2,self.factor("dfs"))
    @property
    def name(self): return self.t.name

class Team:
    def __init__(self, tmpls, side):
        self.units=[Unit(t,i,side) for i,t in enumerate(tmpls)]
        self.side=side
        self.cost=CFG["COST_START"]
        self.charge=0
        self.used_ex_this_turn=False
        self.regen_acc=0.0   # 小数回复累加器：每人 0.5 之类的非整数只在攒满 1 点时到账
        self.total_regen=0   # 全场实际到手的 Cost（已扣掉溢出），用于推导 EX 费用预算
        self.regen_lost=0    # 因撞上限而浪费掉的 Cost，用来检验上限 10 有没有在做事
        self.ex_hand=[]      # 当前显示的 EX 技能牌（角色位置）
        self.ex_deck=[]      # 尚未抽到的牌
        self.ex_discard=[]   # 已用牌；牌库空时按使用顺序回填
    @property
    def base_regen(self):
        p=CFG["COST_REGEN_PER_UNIT"]
        # 人头模式下 COST_REGEN 充当不随战损衰减的保底，用来压制滚雪球
        return CFG["COST_REGEN"] if p is None else CFG["COST_REGEN"]+p*len(self.alive)
    @property
    def alive(self): return [u for u in self.units if u.alive]
    def dead(self): return not self.alive
    def setup_ex_window(self, order):
        self.ex_hand=list(order[:CFG["EX_HAND_SIZE"]])
        self.ex_deck=list(order[CFG["EX_HAND_SIZE"]:])
        self.ex_discard=[]
        self.normalize_ex_window()
    def normalize_ex_window(self):
        """移除阵亡/重复牌并补满窗口；规则与 JS 运行时一致。"""
        live={u.idx for u in self.units if u.alive}
        seen=set()
        def clean(cards):
            out=[]
            for pos in cards:
                if pos not in live or pos in seen: continue
                seen.add(pos); out.append(pos)
            return out
        self.ex_hand=clean(self.ex_hand)
        self.ex_deck=clean(self.ex_deck)
        self.ex_discard=clean(self.ex_discard)
        for pos in range(len(self.units)):
            if pos in live and pos not in seen:
                self.ex_deck.append(pos); seen.add(pos)
        target=min(CFG["EX_HAND_SIZE"],len(live))
        while len(self.ex_hand)<target:
            if not self.ex_deck:
                if not self.ex_discard: break
                self.ex_deck=self.ex_discard
                self.ex_discard=[]
            self.ex_hand.append(self.ex_deck.pop(0))
    def cycle_ex(self, pos):
        self.normalize_ex_window()
        if pos not in self.ex_hand: return False
        self.ex_hand.remove(pos)
        if self.units[pos].alive: self.ex_discard.append(pos)
        self.normalize_ex_window()
        return True

class Battle:
    HOLD = 0
    def __init__(self, tA, tB, rng=None, log=False, first=None):
        self.rng = rng or random.Random()
        self.teams=[Team(tA,0), Team(tB,1)]
        # 先手：队伍总行动值高者；相同则随机
        if first is None: first = self.rng.randint(0,1)   # 行动值已废弃，先手随机或由竞价决定
        self.first=first
        for team in self.teams:
            order=list(range(len(team.units)))
            self.rng.shuffle(order)
            team.setup_ex_window(order)
        self.teams[1-first].cost += CFG["SECOND_BONUS"]

        self.round=0; self.turn_id=0; self.log=log; self.lines=[]; self.winner=None
        self.holds=(0,0)

    def sd_dmg(self):
        n=self.round-CFG["SD_START"]+1
        return max(0.0,n)*CFG["SD_DMG_STEP"]
    def sd_heal(self):
        n=self.round-CFG["SD_START"]+1
        return max(0.15, 1-max(0,n)*CFG["SD_HEAL_STEP"])
    def L(self,s):
        if self.log: self.lines.append(s)

    # ---------- 目标选择 ----------
    def lane_target(self, u, foes):
        tt=[f for f in foes.units if f.alive and f.taunt>0]
        if tt: return tt[0]
        d=foes.units[u.idx]
        if d.alive: return d
        cands=foes.alive
        if not cands: return None
        return min(cands, key=lambda f:(abs(f.idx-u.idx), f.idx))

    def resolve_targets(self, u, eff, foes, allies):
        tg=eff.get("target","lane")
        if tg=="lane":
            t=self.lane_target(u,foes); return [t] if t else []
        if tg=="lane_splash":
            base = foes.units[u.idx] if eff.get("ignore_dead_lane") else self.lane_target(u,foes)
            if base is None or not base.alive: base=self.lane_target(u,foes)
            if base is None: return []
            out=[(base,1.0)]
            for j in (base.idx-1, base.idx+1):
                if 0<=j<4 and foes.units[j].alive: out.append((foes.units[j], eff.get("splash",0.5)))
            return [o for o in out if o[0].alive]
        if tg=="enemy_all":   return foes.alive
        if tg=="enemy_random":return foes.alive
        if tg=="enemy_single":return [self.pick_best_enemy(u,eff,foes)] if foes.alive else []
        if tg=="ally_all":    return allies.alive
        if tg=="ally_lowest": return [min(allies.alive,key=lambda a:a.hp/a.maxhp)] if allies.alive else []
        if tg=="self":        return [u]
        return []

    def hit_rate(self,src,tgt):
        """角色只有一个统一命中值，普攻、普通技能与 EX 全部共用。"""
        dr=min(CFG["DODGE_CAP"], max(0.0,(tgt.t.dodge-src.t.acc)/CFG["DODGE_K"]))
        return 1.0-dr

    def pick_best_enemy(self,u,eff,foes):
        best=None;bs=-1e18
        for f in foes.alive:
            est=self.est_damage(u,f,eff.get("mult",1.0))
            s=est
            if est>=f.hp+f.shield: s+=100000
            s += (1-f.hp/f.maxhp)*300 + f.atk*0.3
            if s>bs: bs=s;best=f
        return best

    def est_damage(self,src,tgt,mult):
        raw=src.atk*mult*affinity(src.t.atk_type,tgt.t.def_type)*(CFG["DEF_K"]/(CFG["DEF_K"]+tgt.dfs))
        return raw*self.hit_rate(src,tgt)

    # ---------- 伤害 ----------
    def deal(self, src, tgt, mult, eff, mod=1.0):
        if not tgt.alive or not src.alive: return 0.0
        dr=min(CFG["DODGE_CAP"], max(0.0,(tgt.t.dodge-src.t.acc)/CFG["DODGE_K"]))
        if dr>0:
            if CFG["RNG_MODE"]=="gauge":
                tgt.dodge_gauge+=dr
                if tgt.dodge_gauge>=1.0:
                    tgt.dodge_gauge-=1.0; self.L(f"  {tgt.name} 闪避了 {src.name}"); return 0.0
            elif self.rng.random()<dr:
                self.L(f"  {tgt.name} 闪避了 {src.name}"); return 0.0
        cr=min(CFG["CRIT_CAP"], max(0.0,src.t.crit*src.factor("crit"))); crit=False
        if eff.get("force_crit"): crit=True
        elif CFG["RNG_MODE"]=="gauge":
            src.crit_gauge+=cr
            if src.crit_gauge>=1.0: src.crit_gauge-=1.0; crit=True
        elif self.rng.random()<cr: crit=True
        aff=affinity(src.t.atk_type,tgt.t.def_type)
        dmg=src.atk*mult*mod*aff*(CFG["DEF_K"]/(CFG["DEF_K"]+tgt.dfs))
        eb=eff.get("exec_bonus")
        if eb and tgt.hp/tgt.maxhp<=eb[0]: dmg*=eb[1]
        dmg*= max(0.1,src.factor("dmg_deal"))
        dmg*= max(0.1,tgt.factor("dmg_take"))
        dmg*= (1+self.sd_dmg())
        if crit: dmg*= CFG["CRIT_DMG"]*max(0.1,src.factor("crit_dmg"))
        j=CFG["DMG_JITTER"]
        if j: dmg*= 1+self.rng.uniform(-j,j)
        dmg=max(1.0,dmg)
        self.apply_damage(src,tgt,dmg,crit,aff)
        if tgt.reflect>0 and tgt.alive and src.alive:
            r=dmg*tgt.reflect
            self.L(f"  ⟲ {tgt.name} 反伤 {r:.0f}")
            self.apply_damage(None,src,r)
        return dmg

    def apply_damage(self,src,tgt,dmg,crit=False,aff=1.0,burn=False):
        absorbed=0.0
        if tgt.shield>0:
            absorbed=min(tgt.shield,dmg); tgt.shield-=absorbed; dmg-=absorbed
            if tgt.shield<=0:
                tgt.shield=0.0; tgt.shield_max=0.0; tgt.shield_turns=0
        tgt.hp-=dmg
        if src: src.dmg_dealt+=dmg
        tgt.dmg_taken+=dmg
        tag=("暴击" if crit else "")+("·克制" if aff>1.01 else ("·抵抗" if aff<0.99 else ""))+("·灼烧" if burn else "")
        ab=f"（护盾吸收 {absorbed:.0f}）" if absorbed>0 else ""
        self.L(f"  {src.name if src else '持续伤害'} → {tgt.name} {dmg:.0f}{ab} {tag}")
        if tgt.hp<=0:
            tgt.hp=0; tgt.alive=False; tgt.taunt=0
            self.L(f"  ✝ {tgt.name} 倒下")

    def heal(self,src,tgt,amount):
        if not tgt.alive: return
        amount*= self.sd_heal()
        h=min(amount, tgt.maxhp-tgt.hp); tgt.hp+=h
        if h>0: self.L(f"  {src.name} 治疗 {'自身' if tgt is src else tgt.name} +{h:.0f}")

    def trigger_burns(self,src,standalone=False):
        """按施加者的行动时点结算灼烧；不受其眩晕/阵亡影响，也不进行命中判定。"""
        foes=self.teams[1-src.side]
        pending=[]
        for tgt in foes.units:
            if not tgt.alive: continue
            for dot in list(tgt.dots):
                if dot.get("src_side")!=src.side or dot.get("src_idx")!=src.idx: continue
                if dot.get("st")==self.turn_id or dot.get("last_proc_turn")==self.turn_id: continue
                pending.append((tgt,dot))
        if standalone and pending:
            self.L(f"[{'蓝' if src.side==0 else '红'}] {src.name} 灼烧结算")
        for tgt,dot in pending:
            if not tgt.alive or dot not in tgt.dots: continue
            dot["last_proc_turn"]=self.turn_id
            self.apply_damage(src,tgt,dot["src_atk"]*dot["value"]*(1+self.sd_dmg()),burn=True)
            dot["turns"]-=1
            if dot["turns"]<=0: tgt.dots.remove(dot)
            if not tgt.alive: tgt.dots.clear()

    # ---------- 效果 ----------
    def execute(self, u, eff, label=""):
        me=self.teams[u.side]; foes=self.teams[1-u.side]
        tgs=self.resolve_targets(u,eff,foes,me)
        if not tgs: return
        self.L(f"[{'蓝' if u.side==0 else '红'}] {u.name} {label}")
        kind=eff.get("kind","damage")
        if kind=="damage":
            mult=eff["mult"]
            dots_to_apply=[]
            if eff.get("target")=="enemy_random":
                for _ in range(eff.get("hits",1)):
                    al=foes.alive
                    if not al: break
                    self.deal(u,self.rng.choice(al),mult,eff)
            elif eff.get("target")=="lane_splash":
                for tgt,m in tgs: self.deal(u,tgt,mult,eff,mod=m)
            else:
                for tgt in tgs:
                    det=eff.get("detonate")
                    if det and tgt.dots:
                        hit=self.deal(u,tgt,mult+det,eff)>0
                        if hit: tgt.dots.clear()
                    else:
                        self.deal(u,tgt,mult,eff)
                    if tgt.alive:
                        # 降防、易伤等属性减益立刻影响本回合后续攻击；MISS 也不阻止附加效果。
                        for db in eff.get("debuffs",[]):
                            upsert_status_layer(tgt.buffs,timed_enemy_debuff(db,self.turn_id,u,tgt.side))
                        if eff.get("dot"):
                            dots_to_apply.append((tgt,dict(value=eff["dot"]["value"],turns=eff["dot"]["turns"],
                                                 src_atk=u.atk,src_side=u.side,src_idx=u.idx,
                                                 source_key=source_key(u.side,u.idx),effect_kind="dot",st=self.turn_id)))
                        if eff.get("stun"): tgt.stun=max(tgt.stun,eff["stun"]); tgt.stun_st=self.turn_id
            self.trigger_burns(u)
            for tgt,dot in dots_to_apply:
                if tgt.alive: upsert_dot_layer(tgt.dots,dot)
        else:
            for tgt in tgs:
                if eff.get("heal"): self.heal(u,tgt,u.atk*eff["heal"])
                if eff.get("shield"):
                    amount=max(0.0,u.atk*eff["shield"]*self.sd_heal())
                    tgt.shield=amount; tgt.shield_max=amount
                    tgt.shield_turns=eff.get("shield_turns",2); tgt.shield_tick_side=1-tgt.side; tgt.shield_st=self.turn_id
                    self.L(f"  {tgt.name} 获得护盾 {tgt.shield:.0f}（{tgt.shield_turns}回合）")
                if eff.get("cleanse"): tgt.buffs=[b for b in tgt.buffs if b.get("effect_kind")!="debuff"]; tgt.dots.clear()
                if eff.get("taunt"): tgt.taunt=eff["taunt"]; tgt.taunt_st=self.turn_id
                if eff.get("reflect"): tgt.reflect=eff["reflect"]; tgt.reflect_turns=eff.get("reflect_turns",1); tgt.reflect_st=self.turn_id
                for b in eff.get("buffs",[]): upsert_status_layer(tgt.buffs,timed_friendly_buff(b,self.turn_id,u))
        # 回费是技能自身效果；伤害 MISS 也照常生效，且留到后续回合使用。
        if eff.get("cost_gain"):
            before=me.cost
            me.cost=min(CFG["COST_MAX"],me.cost+eff["cost_gain"])
            recovered=me.cost-before
            me.total_regen+=recovered
            me.regen_lost+=eff["cost_gain"]-recovered
            self.L(f"  {u.name} 回复 Cost {recovered}" +
                   (f"（溢出 {eff['cost_gain']-recovered}）" if recovered<eff["cost_gain"] else ""))
        for b in eff.get("self_buffs",[]): upsert_status_layer(u.buffs,timed_friendly_buff(b,self.turn_id,u))
        if eff.get("self_heal"): self.heal(u,u,u.atk*eff["self_heal"])

    # ---------- AI ----------
    def plan_ex(self, side):
        me=self.teams[side]; foes=self.teams[1-side]
        me.normalize_ex_window()
        hold=self.holds[side]
        if hold<0: return []
        if hold>0 and me.cost<hold and me.cost<CFG["COST_MAX"]: return []

        # 在牌区副本上逐张规划，保证同一回合连放时也按「用一张、补一张」推进。
        hand=list(me.ex_hand); deck=list(me.ex_deck); discard=list(me.ex_discard)
        alive={u.idx for u in me.alive}
        def cycle(pos):
            hand.remove(pos); discard.append(pos)
            while len(hand)<min(CFG["EX_HAND_SIZE"],len(alive)):
                if not deck:
                    if not discard: break
                    deck.extend(discard); discard.clear()
                hand.append(deck.pop(0))

        budget=me.cost; plan=[]
        # 终极流：牌在窗口里就留费；还没抽到时必须先打其他牌来轮转，不能原地等死。
        uc=CFG["ULT_COMMIT"]
        ult=next((u for u in me.alive if uc is not None and u.t.ex["cost"]>=uc), None)

        while hand:
            if ult is not None and ult.idx in hand:
                cost=ult.t.ex["cost"]
                if ult.stun>0 or budget<cost: break
                plan.append(ult.idx); budget-=cost; cycle(ult.idx)
                break

            cands=[]
            for idx in hand:
                u=me.units[idx]
                if not u.alive or u.stun>0: continue
                ex=u.t.ex; cost=ex["cost"]
                if cost>budget: continue
                sc=self.score_ex(u,ex,me,foes)
                if sc>0: cands.append((sc/max(1,cost), cost, idx))
            if not cands: break
            cands.sort(reverse=True)
            _,cost,idx=cands[0]
            budget-=cost; plan.append(idx); cycle(idx)
        return plan

    def score_ex(self,u,ex,me,foes):
        if ex.get("kind","damage")=="damage":
            tgs=self.resolve_targets(u,ex,foes,me)
            if not tgs: return 0
            damage_scores=[]; hit_rates=[]
            for t in tgs:
                t0=t[0] if isinstance(t,tuple) else t
                m=ex["mult"]*(t[1] if isinstance(t,tuple) else 1.0)
                e=self.est_damage(u,t0,m)
                damage_scores.append(min(e,t0.hp)+(600 if e>=t0.hp else 0))
                hit_rates.append(self.hit_rate(u,t0))
            if ex.get("target")=="enemy_random":
                # 随机多段总共只有 hits 段，不能按「敌人数 × hits」重复估值。
                tot=sum(damage_scores)/len(damage_scores)*ex.get("hits",1)
            else:
                tot=sum(damage_scores)
            if ex.get("stun"): tot+=500*len(hit_rates)
            if ex.get("debuffs"): tot+=300*len(hit_rates)
            return tot
        sc=0
        if ex.get("heal"):
            miss=sum(min(a.maxhp-a.hp, u.atk*ex["heal"]) for a in me.alive)
            sc+= miss if miss> u.atk*ex["heal"]*0.8 else 0
        if ex.get("shield"): sc+= u.atk*ex["shield"]*len(me.alive)*0.55
        if ex.get("taunt"):  sc+= 350*len(me.alive)+sum(f.atk for f in foes.alive)*ex.get("reflect",0)*0.9
        for b in ex.get("buffs",[]):
            if b["stat"]=="dmg_deal": sc+= b["value"]*sum(a.atk for a in me.alive)*b["turns"]*0.85
            if b["stat"]=="dmg_take": sc+= -b["value"]*400
        return sc

    # ---------- 主循环：每轮依次结算先手、后手两个回合 ----------
    def run(self):
        for r in range(1, CFG["MAX_ROUND"]+1):
            self.round=r
            self.L(f"\n########## 第 {r} 轮 ##########")
            for side in (self.first, 1-self.first):
                self.player_turn(side)
                if self.check_end(): return self.finish()
        return self.finish()

    def player_turn(self, side):
        self.turn_id+=1
        team=self.teams[side]
        tag='蓝' if side==0 else '红'
        # ① Cost 回复
        skip = (CFG["FIRST_PRICE"] is None and self.round==1 and side==self.first and CFG["FIRST_SKIP_COST"])
        if not skip:
            team.regen_acc += team.base_regen
            gain=int(team.regen_acc); team.regen_acc-=gain      # Cost 始终是整数
            before=team.cost
            team.cost=min(CFG["COST_MAX"], team.cost+gain)
            team.total_regen+=team.cost-before
            team.regen_lost+=gain-(team.cost-before)
        if CFG["FIRST_PRICE"] is not None and self.round==1 and side==self.first:
            team.cost=max(0, team.cost-CFG["FIRST_PRICE"])   # 先手权标价：第 1 回合可用 Cost 直接扣 N
        team.used_ex_this_turn=False
        ex_actors=set()
        self.L(f"\n--- {tag}方回合（Cost {team.cost}{'，首回合不回复' if skip else ''}"
               f"{'，充能×%d'%team.charge if (team.charge and CFG['CHARGE_STEP']) else ''}）---")
        # ② 玩家指令：EX
        for idx in self.plan_ex(side):
            team.normalize_ex_window()
            u=team.units[idx]
            if not u.alive or u.stun>0 or idx not in team.ex_hand: continue
            c=u.t.ex["cost"]
            if team.cost<c: continue
            team.cost-=c; team.cycle_ex(idx)
            ex_actors.add(idx)
            ch = 0 if team.used_ex_this_turn else team.charge
            team.used_ex_this_turn=True
            ex=dict(u.t.ex)
            if ch and CFG["CHARGE_STEP"]:
                boost=1+CFG["CHARGE_STEP"]*ch
                for k in ("mult","heal","shield"):
                    if k in ex: ex[k]*=boost
            self.execute(u,ex,f"EX(-{c})")
            team.normalize_ex_window()
            if self.check_end(): return
        if not team.used_ex_this_turn: self.L(f"[{tag}] 过")
        # ③ 己方角色自动行动：按位置 1→4
        if self.round==1 and side==self.first and CFG["FIRST_NO_ACT"]:
            self.L(f"[{tag}] 首回合按兵不动")
            return self.end_turn(team)
        for u in team.units:
            if self.teams[1-side].dead(): break
            if not u.alive:
                self.trigger_burns(u,standalone=True)
                if self.check_end(): return
                continue
            # 同一角色每回合只执行一种动作；放过 EX 后不再自动放普技或普攻。
            if u.idx in ex_actors:
                self.trigger_burns(u,standalone=True)
                if self.check_end(): return
                continue
            if u.stun>0:
                if u.skill_cd<=0:
                    u.skill_cd=u.t.skill["cd"]
                    self.L(f"[{tag}] {u.name} 眩晕，普通技能被吞掉并进入冷却")
                else: self.L(f"[{tag}] {u.name} 眩晕，无法行动")
                self.trigger_burns(u,standalone=True)
                if self.check_end(): return
                continue
            if u.skill_cd<=0:
                u.skill_cd=u.t.skill["cd"]; self.execute(u,u.t.skill,"普通技能")
            else:
                self.execute(u,dict(kind="damage",mult=u.t.na_mult,target="lane"),"普攻")
            if self.check_end(): return
        return self.end_turn(team)

    def end_turn(self, team):
        if not team.used_ex_this_turn:
            team.cost=min(CFG["COST_MAX"],team.cost+CFG["COST_PASS_BONUS"])
            team.charge=min(CFG["CHARGE_MAX"],team.charge+1)
        else: team.charge=0
        T=self.turn_id
        ticking_side=team.units[0].side
        # 减益可能挂在敌方，却跟随施放方的攻击窗口倒计时，因此单独扫描双方。
        for affected_team in self.teams:
            for u in affected_team.units:
                if not u.alive: continue
                for b in list(u.buffs):
                    if b.get("tick_side",u.side)!=ticking_side or b["turns"]>=9999: continue
                    if b.get("st")==T and not b.get("count_current"): continue
                    b["turns"]-=1
                    if b["turns"]<=0: u.buffs.remove(b)
                if u.shield_turns>0 and u.shield_tick_side==ticking_side and u.shield_st!=T:
                    u.shield_turns-=1
                    if u.shield_turns<=0:
                        u.shield=0.0; u.shield_max=0.0; u.shield_turns=0
        for u in team.units:
            if not u.alive: continue
            if u.stun>0 and u.stun_st!=T: u.stun-=1
            if u.taunt>0 and u.taunt_st!=T: u.taunt-=1
            if u.reflect_turns>0 and u.reflect_st!=T:
                u.reflect_turns-=1
                if u.reflect_turns==0: u.reflect=0.0
            if u.skill_cd>0: u.skill_cd-=1
        team.normalize_ex_window()

    def check_end(self): return self.teams[0].dead() or self.teams[1].dead()
    def finish(self):
        a,b=self.teams[0].dead(), self.teams[1].dead()
        if a and b: self.winner=-1
        elif b: self.winner=0
        elif a: self.winner=1
        else:
            ra=sum(u.hp for u in self.teams[0].units)/sum(u.maxhp for u in self.teams[0].units)
            rb=sum(u.hp for u in self.teams[1].units)/sum(u.maxhp for u in self.teams[1].units)
            self.winner=0 if ra>rb else (1 if rb>ra else -1)
        return self.winner
