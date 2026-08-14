"""v5 机制表征 —— 先把机制测准，再照着它设计角色

锁定的机制（engine.py CFG）：
    开局 Cost 0（双方对等，后手另给固定补偿）
    回复 = 每存活角色 0.5  →  满编每个己方回合 2，剩 2 人时 1
    上限 10，无「过 +1」（回复与玩家行为无关）
    暴击/闪避 真随机
    4 张 EX 技能牌、2 张可见窗口；用一张补一张

本脚本使用当前角色表测结构指标；角色强度与极差由 `autotune.py` 单独复测。

用法：python mechanic.py [budget|first|len|snow|var]
"""
import sys, random, statistics
from engine import *
import tune


def _battles(n, seed, **kw):
    rng = random.Random(seed)
    for i in range(n):
        tA, tB = tune.rand_team(rng), tune.rand_team(rng)
        b = Battle(tA, tB, rng=random.Random(rng.random() * 1e9), first=i % 2, **kw)
        r = b.run()
        yield b, r


def run_budget(n=1500):
    """一局下来每方总共到手多少 Cost —— 这是 EX 费用曲线的预算上限"""
    tot, lost, rounds = [], [], []
    for b, _ in _battles(n, 61):
        rounds.append(b.round)
        for t in b.teams:
            tot.append(t.total_regen); lost.append(t.regen_lost)
    tot.sort()
    print("\n== Cost 预算 ==")
    print(f"  平均轮数          {statistics.mean(rounds):.2f}")
    print(f"  每方全场总收入    平均 {statistics.mean(tot):.1f}   P10 {tot[len(tot)//10]}   P90 {tot[len(tot)*9//10]}")
    print(f"  撞上限浪费        平均 {statistics.mean(lost):.2f} 点/方  ← 接近 0 说明上限 10 基本不起作用")


def run_first(n=1200):
    """后手补偿多少点才公平"""
    print("\n== 先手胜率 vs 后手补偿 ==（目标 50%）")
    old = CFG["SECOND_BONUS"]
    try:
        for bonus in (0, 1, 2, 3):
            CFG["SECOND_BONUS"] = bonus
            r = tune.exp_first(n)
            print(f"  补偿 {bonus} 点   先手胜率 {r['先手胜率']:.1%}")
    finally:
        CFG["SECOND_BONUS"] = old


def run_len(n=1500):
    r = tune.exp_length(n)
    print("\n== 对局长度 ==")
    print(f"  平均 {r['mean']}  中位 {r['median']}  P10 {r['p10']}  P90 {r['p90']}  "
          f"打满上限 {r['maxed']/n:.1%}  平局 {r['draw']}")


def run_snow(n=1200):
    surv = [len(b.teams[r].alive) for b, r in _battles(n, 53) if r in (0, 1)]
    print("\n== 滚雪球程度 ==")
    print(f"  获胜方平均剩余 {statistics.mean(surv):.2f} 人   "
          f"零封(4人全活) {sum(1 for x in surv if x==4)/len(surv):.1%}   "
          f"惨胜(剩1人) {sum(1 for x in surv if x==1)/len(surv):.1%}")


def run_var():
    """真随机的代价：配队决定度（1=全靠配队，0=全靠运气）"""
    print("\n== 配队决定度 ==")
    print(f"  真随机 pure   {tune.exp_variance('pure'):.3f}   ← v4 采用")
    print(f"  期望槽 gauge  {tune.exp_variance('gauge'):.3f}")


LONG = dict(SD_START=10, MAX_ROUND=22)   # 当前正式对局配置；生命值已直接烘焙进角色表


class UltBattle(Battle):
    """模拟「终极流」玩家：终极牌进窗口后开始留费；此前用其他牌轮转牌组。"""
    ULT_ID = "YH"

    def plan_ex(self, side):
        if side == 0:
            u = next((x for x in self.teams[0].units
                      if x.t.id == self.ULT_ID and x.alive), None)
            team = self.teams[0]
            team.normalize_ex_window()
            if u is not None and u.idx in team.ex_hand:
                if u.stun > 0: return []
                return [u.idx] if self.teams[0].cost >= u.t.ex["cost"] else []
        return super().plan_ex(side)

def run_ult(n=900):
    """给 10 费终极技定价：终极牌进窗口后攒满再放，倍率要多高才回本？

    载体用炎火（爆发/轻装）；当前 3 费技能作为常规基线，再覆盖成不同 10 费方案。
    终极牌未出现时正常轮牌，出现后留费；对手正常贪心。
    胜率 50% = 攒它和不攒一样好；低于 50% = 这是个陷阱选项。
    """
    carrier = BY_ID["YH"]
    old_ex = carrier.ex
    old_cfg = {k: CFG[k] for k in LONG}
    CFG.update(LONG)
    print("\n== 10 费终极技定价 ==（正式生命值 / 2 槽技能牌窗口）")
    print(f"{'方案':<28} {'持有方胜率':>10}")
    trials = [
        ("3费 350% 单体（当前·贪心）",  dict(old_ex),                                             False),
        ("10费 900% 单体",   dict(kind="damage", mult=9.0,  target="enemy_single", cost=10), True),
        ("10费 1400% 单体",  dict(kind="damage", mult=14.0, target="enemy_single", cost=10), True),
        ("10费 2000% 单体",  dict(kind="damage", mult=20.0, target="enemy_single", cost=10), True),
        ("10费 3000% 单体",  dict(kind="damage", mult=30.0, target="enemy_single", cost=10), True),
        ("10费 450% 全体",   dict(kind="damage", mult=4.5,  target="enemy_all",    cost=10), True),
        ("10费 700% 全体",   dict(kind="damage", mult=7.0,  target="enemy_all",    cost=10), True),
        ("10费 1000% 全体",  dict(kind="damage", mult=10.0, target="enemy_all",    cost=10), True),
        ("10费 1500% 全体",  dict(kind="damage", mult=15.0, target="enemy_all",    cost=10), True),
    ]
    try:
        for label, ex, commit in trials:
            carrier.ex = ex
            cls = UltBattle if commit else Battle
            rng = random.Random(71); w = 0; g = 0
            others = [t for t in ROSTER if t.id != "YH"]
            for i in range(n):
                tA = [carrier] + rng.sample(others, 3)
                tB = rng.sample(ROSTER, 4)
                b = cls(tA, tB, rng=random.Random(rng.random() * 1e9), first=i % 2)
                if b.run() == 0: w += 1
                g += 1
            print(f"{label:<28} {w/g:>10.1%}")
    finally:
        carrier.ex = old_ex; CFG.update(old_cfg)


if __name__ == "__main__":
    w = sys.argv[1] if len(sys.argv) > 1 else "all"
    if w in ("all", "ult"):    run_ult()
    if w in ("all", "budget"): run_budget()
    if w in ("all", "len"):    run_len()
    if w in ("all", "first"):  run_first()
    if w in ("all", "snow"):   run_snow()
    if w in ("all", "var"):    run_var()
