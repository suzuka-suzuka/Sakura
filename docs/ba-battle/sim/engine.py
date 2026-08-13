"""碧蓝档案·回合制群战 —— 战斗内核 v2（交替玩家回合制）"""
import random
from dataclasses import dataclass
from typing import List, Optional, Dict, Any

CFG = dict(
    DEF_K            = 400,
    AFF_STRONG       = 1.35,
    AFF_NORMAL       = 1.00,
    AFF_WEAK         = 0.75,
    CRIT_DMG         = 1.50,
    DODGE_K          = 300,
    DODGE_CAP        = 0.35,
    CRIT_CAP         = 0.60,
    # --- Cost（v4 锁定：回复只取决于场上存活人数，与本回合是否出招无关）---
    COST_START       = 0,     # 双方开局 Cost，对等
    COST_REGEN       = 0,     # 不随战损衰减的保底部分
    COST_REGEN_PER_UNIT = 0.5,  # 每存活角色 ×N：满编 4 人 = 2/回合，剩 2 人 = 1/回合
    COST_MAX         = 10,
    COST_PASS_BONUS  = 0,     # v4 删除：「过 +1」让回复取决于玩家行为，不对等
    EX_CD            = 1,
    # --- 先手补偿（实验开关）---
    FIRST_SKIP_COST  = False,  # 先手方第 1 回合不回 Cost
    FIRST_PRICE      = None, # 备用计价方式：先手方自扣 N 点（默认改用 SECOND_BONUS 补偿制）  # 不为 None 时改用「先手方开局 Cost -N」计价
    SECOND_BONUS     = 3,     # 后手方开局额外 Cost = 先手方支付的价格（竞价时为中标额）
    FIRST_NO_ACT     = False, # 先手方第 1 回合角色不自动行动
    # --- 白热化 ---
    ULT_COMMIT       = 8,     # 队里有 EX 费用 ≥ 此值的角色时，AI 改走「终极流」：攒满前一个 EX 都不放
    SD_START         = 10,
    SD_DMG_STEP      = 0.20,
    SD_HEAL_STEP     = 0.25,
    DMG_JITTER       = 0.05,
    RNG_MODE         = "pure",   # v4：暴击/闪避改真随机，给落后方留翻盘的运气空间
    MAX_ROUND        = 22,
    CHARGE_STEP      = 0.0,   # 充能（默认关闭，高费 EX 本身就是攒 Cost 的理由）
    CHARGE_MAX       = 3,
    HP_SCALE         = 1.4,   # 拉长对局到 ~12 回合，给 10 费终极技留出攒满 5 回合的空间
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
    id: str; name: str; atk_type: str; def_type: str; role: str
    hp: int; atk: int; dfs: int; crit: float; dodge: int
    skill: Dict[str, Any]
    ex: Dict[str, Any]
    passive: Optional[Dict[str, Any]] = None
    na_mult: float = 1.0

def D(mult, target="lane", **kw):
    d = dict(kind="damage", mult=mult, target=target); d.update(kw); return d

ROSTER: List[Tmpl] = [
 # ---------- 爆发（克轻装 / 被重装抵抗） ----------
 Tmpl("YH","炎火","爆发","轻装","处决狙击", 4250, 940, 190, .28,  55,
      skill=dict(cd=3, **D(2.40)),
      ex=dict(cost=3, **D(3.50, target="enemy_single", exec_bonus=(0.50, 1.5)))),
 # 全场唯一 10 费：攒满条才放得出，Cost 公开可见 = 公开宣战
 Tmpl("ZP","重炮","爆发","重装","決戦炮击", 5750, 710, 335, .10,  10,
      skill=dict(cd=3, **D(1.90, target="lane_splash", splash=0.45)),
      ex=dict(cost=10, **D(6.20, target="enemy_all"))),
 # 普技 CD 从 2 改回 3：不再独占「最快普技」这个结构特权
 Tmpl("SG","闪光","爆发","特殊","高闪刺客", 4400, 740, 235, .30, 100,
      skill=dict(cd=3, **D(2.00)),
      ex=dict(cost=2, **D(1.70, target="enemy_single"))),
 Tmpl("LF","烈风","爆发","弹力","增伤辅助", 5300, 705, 285, .15,  55,
      skill=dict(cd=3, **D(1.80)),
      ex=dict(cost=4, kind="support", target="ally_all",
              buffs=[dict(stat="dmg_deal", value=0.65, turns=2)])),
 # ---------- 贯通（克重装 / 被特殊抵抗） ----------
 Tmpl("CJ","穿甲","贯通","重装","减防坦输", 6150, 765, 330, .12,  15,
      skill=dict(cd=3, **D(2.00, debuffs=[dict(stat="dfs", value=-0.25, turns=2)])),
      ex=dict(cost=3, **D(3.40, target="enemy_single",
                          debuffs=[dict(stat="dfs", value=-0.35, turns=3)]))),
 Tmpl("RF","锐锋","贯通","轻装","暴击流", 4000, 775, 195, .42,  60,
      skill=dict(cd=3, **D(2.20)),
      ex=dict(cost=2, **D(2.20, target="enemy_single", force_crit=True)),
      passive=dict(static={"crit_dmg":0.45})),
 Tmpl("LS","连射","贯通","特殊","多段散射", 4750, 740, 250, .20,  75,
      skill=dict(cd=3, **D(2.00)),
      ex=dict(cost=3, **D(1.50, target="enemy_random", hits=4))),
 Tmpl("GY","贯月","贯通","弹力","三格贯穿", 5150, 730, 285, .18,  50,
      skill=dict(cd=3, **D(2.10)),
      ex=dict(cost=4, **D(3.80, target="lane_splash", splash=0.75, ignore_dead_lane=True))),
 # ---------- 神秘（克特殊 / 被轻装抵抗） ----------
 Tmpl("MY","秘仪","神秘","特殊","主治疗", 4950, 680, 255, .10,  60,
      skill=dict(cd=3, kind="support", target="ally_lowest", heal=1.30),
      ex=dict(cost=5, kind="support", target="ally_all", heal=2.40)),
 Tmpl("ZF","咒缚","神秘","轻装","单体控制", 4650, 930, 195, .24,  80,
      skill=dict(cd=3, **D(2.00)),
      ex=dict(cost=4, **D(4.20, target="enemy_single", stun=1))),
 Tmpl("LH","灵护","神秘","重装","护盾坦", 6300, 670, 345, .08,  10,
      skill=dict(cd=3, kind="support", target="self", shield=2.80, shield_turns=2),
      ex=dict(cost=6, kind="support", target="ally_all", shield=3.00, shield_turns=2,
              buffs=[dict(stat="atk", value=0.25, turns=2)])),
 Tmpl("XS","虚数","神秘","弹力","灼烧引爆", 5050, 685, 280, .15,  50,
      skill=dict(cd=3, **D(1.50, dot=dict(value=0.55, turns=3))),
      ex=dict(cost=6, **D(2.30, target="enemy_all", detonate=1.70))),
 # ---------- 振动（克弹力 / 被特殊抵抗） ----------
 # 攻击力从 495 提到 690、被动从 +1 降到 +0.5（每人 0.5 规则下 = 本人算两个人）
 # 旧版把全部身价押在被动上，回复速率一动它就在 0.22 和 0.63 之间弹
 Tmpl("GM","共鸣","振动","弹力","Cost引擎", 4500, 620, 290, .12,  48,
      skill=dict(cd=3, **D(1.80)),
      ex=dict(cost=2, **D(2.00, target="enemy_single")),
      passive=dict(cost_regen=0.5)),
 Tmpl("ZD","震荡","振动","轻装","全体破防", 4450, 855, 200, .20,  65,
      skill=dict(cd=3, **D(2.10)),
      ex=dict(cost=4, **D(2.00, target="enemy_all",
                          debuffs=[dict(stat="dfs", value=-0.25, turns=3)]))),
 Tmpl("CX","潮汐","振动","特殊","嘲讽坦", 5450, 630, 300, .10,  40,
      skill=dict(cd=3, **D(1.80, self_buffs=[dict(stat="dmg_take", value=-0.20, turns=2)])),
      ex=dict(cost=3, kind="support", target="self", taunt=1, heal=1.20,
              reflect=0.80, reflect_turns=1,
              buffs=[dict(stat="dmg_take", value=-0.60, turns=1)])),
 Tmpl("HX","回响","振动","重装","团队续航", 5550, 615, 320, .10,  15,
      skill=dict(cd=3, **D(1.70, self_heal=0.80)),
      ex=dict(cost=4, kind="support", target="ally_all", heal=1.15, cleanse=True),
      passive=dict(revive=0.20)),
]
BY_ID = {t.id: t for t in ROSTER}
TUNE = {t.id:[1.0,1.0] for t in ROSTER}

class Unit:
    __slots__=("t","idx","side","hp","maxhp","buffs","dots","shield","shield_turns",
               "stun","taunt","skill_cd","ex_cd","crit_gauge","dodge_gauge",
               "revive_used","alive","dmg_dealt","dmg_taken","reflect","reflect_turns",
               "stun_st","taunt_st","reflect_st","shield_st")
    def __init__(self, t: Tmpl, idx: int, side: int):
        self.t=t; self.idx=idx; self.side=side
        self.maxhp=t.hp*CFG["HP_SCALE"]*TUNE[t.id][1]; self.hp=self.maxhp
        self.buffs=[]; self.dots=[]
        self.shield=0.0; self.shield_turns=0
        self.stun=0; self.taunt=0
        self.skill_cd=t.skill.get("cd",99)
        self.ex_cd=0
        self.crit_gauge=0.0; self.dodge_gauge=0.0
        self.revive_used=False; self.alive=True
        self.dmg_dealt=0.0; self.dmg_taken=0.0
        self.reflect=0.0; self.reflect_turns=0
        self.stun_st=self.taunt_st=self.reflect_st=self.shield_st=-1
        for k,v in ((t.passive or {}).get('static',{}) or {}).items():
            self.buffs.append(dict(stat=k,value=v,turns=9999,st=-1))
    def mod(self, stat): return sum(b["value"] for b in self.buffs if b["stat"]==stat)
    @property
    def atk(self):  return self.t.atk*TUNE[self.t.id][0] * max(0.2, 1+self.mod("atk"))
    @property
    def dfs(self):  return self.t.dfs * max(0.2, 1+self.mod("dfs"))
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
    @property
    def extra_regen(self):
        # 按存活计算：角色阵亡后不再提供 Cost 回复
        return sum((u.t.passive or {}).get("cost_regen",0) for u in self.units if u.alive)
    @property
    def base_regen(self):
        p=CFG["COST_REGEN_PER_UNIT"]
        # 人头模式下 COST_REGEN 充当不随战损衰减的保底，用来压制滚雪球
        return CFG["COST_REGEN"] if p is None else CFG["COST_REGEN"]+p*len(self.alive)
    @property
    def alive(self): return [u for u in self.units if u.alive]
    def dead(self): return not self.alive

class Battle:
    HOLD = 0
    def __init__(self, tA, tB, rng=None, log=False, first=None):
        self.rng = rng or random.Random()
        self.teams=[Team(tA,0), Team(tB,1)]
        # 先手：队伍总行动值高者；相同则随机
        if first is None: first = self.rng.randint(0,1)   # 行动值已废弃，先手随机或由竞价决定
        self.first=first
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
        return src.atk*mult*affinity(src.t.atk_type,tgt.t.def_type)*(CFG["DEF_K"]/(CFG["DEF_K"]+tgt.dfs))

    # ---------- 伤害 ----------
    def deal(self, src, tgt, mult, eff, mod=1.0):
        if not tgt.alive or not src.alive: return 0.0
        dr=min(CFG["DODGE_CAP"], tgt.t.dodge/(tgt.t.dodge+CFG["DODGE_K"]))
        if dr>0:
            if CFG["RNG_MODE"]=="gauge":
                tgt.dodge_gauge+=dr
                if tgt.dodge_gauge>=1.0:
                    tgt.dodge_gauge-=1.0; self.L(f"  {tgt.name} 闪避了 {src.name}"); return 0.0
            elif self.rng.random()<dr:
                self.L(f"  {tgt.name} 闪避了 {src.name}"); return 0.0
        cr=min(CFG["CRIT_CAP"], src.t.crit); crit=False
        if eff.get("force_crit"): crit=True
        elif CFG["RNG_MODE"]=="gauge":
            src.crit_gauge+=cr
            if src.crit_gauge>=1.0: src.crit_gauge-=1.0; crit=True
        elif self.rng.random()<cr: crit=True
        aff=affinity(src.t.atk_type,tgt.t.def_type)
        dmg=src.atk*mult*mod*aff*(CFG["DEF_K"]/(CFG["DEF_K"]+tgt.dfs))
        eb=eff.get("exec_bonus")
        if eb and tgt.hp/tgt.maxhp<=eb[0]: dmg*=eb[1]
        dmg*= (1+src.mod("dmg_deal"))
        dmg*= max(0.1, 1+tgt.mod("dmg_take"))
        dmg*= (1+self.sd_dmg())
        if crit: dmg*= CFG["CRIT_DMG"]+src.mod("crit_dmg")
        j=CFG["DMG_JITTER"]
        if j: dmg*= 1+self.rng.uniform(-j,j)
        dmg=max(1.0,dmg)
        self.apply_damage(src,tgt,dmg,crit,aff)
        if tgt.reflect>0 and tgt.alive and src.alive:
            r=dmg*tgt.reflect
            self.L(f"  ⟲ {tgt.name} 反伤 {r:.0f}")
            self.apply_damage(None,src,r)
        return dmg

    def apply_damage(self,src,tgt,dmg,crit=False,aff=1.0):
        absorbed=0.0
        if tgt.shield>0:
            absorbed=min(tgt.shield,dmg); tgt.shield-=absorbed; dmg-=absorbed
        tgt.hp-=dmg
        if src: src.dmg_dealt+=dmg
        tgt.dmg_taken+=dmg
        tag=("暴击" if crit else "")+("·克制" if aff>1.01 else ("·抵抗" if aff<0.99 else ""))
        ab=f"（护盾吸收 {absorbed:.0f}）" if absorbed>0 else ""
        self.L(f"  {src.name if src else '持续伤害'} → {tgt.name} {dmg:.0f}{ab} {tag}")
        if tgt.hp<=0:
            rv=(tgt.t.passive or {}).get("revive")
            if rv and not tgt.revive_used:
                tgt.revive_used=True; tgt.hp=tgt.maxhp*rv
                self.L(f"  ★ {tgt.name} 顽强，残存 {tgt.hp:.0f}")
            else:
                tgt.hp=0; tgt.alive=False; tgt.taunt=0
                self.L(f"  ✝ {tgt.name} 倒下")

    def heal(self,src,tgt,amount):
        if not tgt.alive: return
        amount*= self.sd_heal()
        h=min(amount, tgt.maxhp-tgt.hp); tgt.hp+=h
        if h>0: self.L(f"  {src.name} 治疗 {'自身' if tgt is src else tgt.name} +{h:.0f}")

    # ---------- 效果 ----------
    def execute(self, u, eff, label=""):
        me=self.teams[u.side]; foes=self.teams[1-u.side]
        tgs=self.resolve_targets(u,eff,foes,me)
        if not tgs: return
        self.L(f"[{'蓝' if u.side==0 else '红'}] {u.name} {label}")
        kind=eff.get("kind","damage")
        if kind=="damage":
            mult=eff["mult"]
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
                        tgt.dots.clear(); self.deal(u,tgt,mult+det,eff)
                    else:
                        self.deal(u,tgt,mult,eff)
                    if tgt.alive:
                        for db in eff.get("debuffs",[]): tgt.buffs.append(dict(db,st=self.turn_id))
                        if eff.get("dot"):
                            tgt.dots.append(dict(value=eff["dot"]["value"],turns=eff["dot"]["turns"],src_atk=u.atk,st=self.turn_id))
                        if eff.get("stun"): tgt.stun=max(tgt.stun,eff["stun"]); tgt.stun_st=self.turn_id
        else:
            for tgt in tgs:
                if eff.get("heal"): self.heal(u,tgt,u.atk*eff["heal"])
                if eff.get("shield"):
                    tgt.shield=max(tgt.shield,u.atk*eff["shield"]*self.sd_heal())
                    tgt.shield_turns=eff.get("shield_turns",2); tgt.shield_st=self.turn_id
                    self.L(f"  {tgt.name} 获得护盾 {tgt.shield:.0f}")
                if eff.get("cleanse"): tgt.buffs=[b for b in tgt.buffs if b["value"]>0]; tgt.dots.clear()
                if eff.get("taunt"): tgt.taunt=eff["taunt"]; tgt.taunt_st=self.turn_id
                if eff.get("reflect"): tgt.reflect=eff["reflect"]; tgt.reflect_turns=eff.get("reflect_turns",1); tgt.reflect_st=self.turn_id
                for b in eff.get("buffs",[]): tgt.buffs.append(dict(b,st=self.turn_id))
        for b in eff.get("self_buffs",[]): u.buffs.append(dict(b,st=self.turn_id))
        if eff.get("self_heal"): self.heal(u,u,u.atk*eff["self_heal"])

    # ---------- AI ----------
    def plan_ex(self, side):
        me=self.teams[side]; foes=self.teams[1-side]
        hold=self.holds[side]
        if hold<0: return []
        if hold>0 and me.cost<hold and me.cost<CFG["COST_MAX"]: return []
        # 终极流：队里有超高费 EX 时，攒满之前什么都不放（上限=终极费用，花任何钱都会推迟开大）
        uc=CFG["ULT_COMMIT"]
        if uc is not None:
            ult=next((u for u in me.alive if u.t.ex["cost"]>=uc), None)
            if ult is not None:
                if ult.ex_cd>0 or ult.stun>0: return []
                return [ult.idx] if me.cost>=ult.t.ex["cost"] else []
        budget=me.cost; plan=[]; cands=[]
        for u in me.alive:
            if u.ex_cd>0 or u.stun>0: continue
            ex=u.t.ex; sc=self.score_ex(u,ex,me,foes)
            if sc>0: cands.append((sc/max(1,ex["cost"]), ex["cost"], u.idx))
        cands.sort(reverse=True)
        for _,c,idx in cands:
            if c<=budget: budget-=c; plan.append(idx)
        return plan

    def score_ex(self,u,ex,me,foes):
        if ex.get("kind","damage")=="damage":
            tgs=self.resolve_targets(u,ex,foes,me)
            if not tgs: return 0
            tot=0
            for t in tgs:
                t0=t[0] if isinstance(t,tuple) else t
                m=ex["mult"]*(t[1] if isinstance(t,tuple) else 1.0)
                e=self.est_damage(u,t0,m)*ex.get("hits",1)
                tot+=min(e,t0.hp)+(600 if e>=t0.hp else 0)
            if ex.get("stun"): tot+=500
            if ex.get("debuffs"): tot+=300*len(foes.alive)
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

    # ---------- 主循环：交替玩家回合 ----------
    def run(self):
        for r in range(1, CFG["MAX_ROUND"]+1):
            self.round=r
            self.L(f"\n########## 第 {r} 回合 ##########")
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
            team.regen_acc += team.base_regen+team.extra_regen
            gain=int(team.regen_acc); team.regen_acc-=gain      # Cost 始终是整数
            before=team.cost
            team.cost=min(CFG["COST_MAX"], team.cost+gain)
            team.total_regen+=team.cost-before
            team.regen_lost+=gain-(team.cost-before)
        if CFG["FIRST_PRICE"] is not None and self.round==1 and side==self.first:
            team.cost=max(0, team.cost-CFG["FIRST_PRICE"])   # 先手权标价：第 1 回合可用 Cost 直接扣 N
        team.used_ex_this_turn=False
        self.L(f"\n--- {tag}方回合（Cost {team.cost}{'，首回合不回复' if skip else ''}"
               f"{'，充能×%d'%team.charge if (team.charge and CFG['CHARGE_STEP']) else ''}）---")
        # ② 玩家指令：EX
        for idx in self.plan_ex(side):
            u=team.units[idx]
            if not u.alive or u.stun>0 or u.ex_cd>0: continue
            c=u.t.ex["cost"]
            if team.cost<c: continue
            team.cost-=c; u.ex_cd=CFG["EX_CD"]+1
            ch = 0 if team.used_ex_this_turn else team.charge
            team.used_ex_this_turn=True
            ex=dict(u.t.ex)
            if ch and CFG["CHARGE_STEP"]:
                boost=1+CFG["CHARGE_STEP"]*ch
                for k in ("mult","heal","shield"):
                    if k in ex: ex[k]*=boost
            self.execute(u,ex,f"EX〔{u.t.role}〕(-{c})")
            if self.check_end(): return
        if not team.used_ex_this_turn: self.L(f"[{tag}] 过")
        # ③ 己方角色自动行动：按位置 1→4
        if self.round==1 and side==self.first and CFG["FIRST_NO_ACT"]:
            self.L(f"[{tag}] 首回合按兵不动")
            return self.end_turn(team)
        for u in team.units:
            if not u.alive: continue
            if self.teams[1-side].dead(): break
            if u.stun>0: self.L(f"[{tag}] {u.name} 眩晕，无法行动"); continue
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
        for u in team.units:
            if not u.alive: continue
            for d in list(u.dots):
                if d["st"]==T: continue          # 本回合刚挂上的不结算
                self.apply_damage(None,u,d["src_atk"]*d["value"]*(1+self.sd_dmg()))
                d["turns"]-=1
                if d["turns"]<=0: u.dots.remove(d)
            for b in list(u.buffs):
                if b.get("st")==T: continue
                b["turns"]-=1
                if b["turns"]<=0: u.buffs.remove(b)
            if u.shield_turns>0 and u.shield_st!=T:
                u.shield_turns-=1
                if u.shield_turns==0: u.shield=0
            if u.stun>0 and u.stun_st!=T: u.stun-=1
            if u.taunt>0 and u.taunt_st!=T: u.taunt-=1
            if u.reflect_turns>0 and u.reflect_st!=T:
                u.reflect_turns-=1
                if u.reflect_turns==0: u.reflect=0.0
            if u.ex_cd>0: u.ex_cd-=1
            if u.skill_cd>0: u.skill_cd-=1

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
