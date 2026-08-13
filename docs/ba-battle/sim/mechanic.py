"""v4 机制表征 —— 先把机制测准，再照着它设计角色

锁定的机制（engine.py CFG）：
    开局 Cost 0（双方对等，后手另给固定补偿）
    回复 = 每存活角色 0.5  →  满编 4 人 2/回合，剩 2 人 1/回合
    上限 10，无「过 +1」（回复与玩家行为无关）
    暴击/闪避 真随机

注意：本脚本跑在**旧角色表**上。长度、先后手、Cost 预算这类结构指标不敏感，
可以当探针用；角色强度/极差这次一律不测，那要等角色重设计之后。

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
    print(f"  平均回合数        {statistics.mean(rounds):.2f}")
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


def run_scale(n=1200):
    """拉长对局：扫描 HP_SCALE，看要多厚的血量才撑得起 10 费终极技
    白热化起点与回合上限按同比例后移，否则它会把拉长的部分又压回去"""
    print("\n== 拉长对局 ==（目标：能攒满 10 费还剩得下打完的回合）")
    print(f"{'HP×':>5} {'白热化':>6} {'上限':>5} | {'平均回合':>8} {'P90':>5} "
          f"{'每方总收入':>10} {'攒满10费需':>10} {'零封率':>7}")
    old = {k: CFG[k] for k in ("HP_SCALE", "SD_START", "MAX_ROUND")}
    try:
        for s in (1.0, 1.4, 1.8, 2.2):
            CFG["HP_SCALE"] = s
            CFG["SD_START"] = round(7 * s)
            CFG["MAX_ROUND"] = round(16 * s)
            rounds, tot, surv = [], [], []
            for b, r in _battles(n, 67):
                rounds.append(b.round)
                for t in b.teams: tot.append(t.total_regen)
                if r in (0, 1): surv.append(len(b.teams[r].alive))
            rounds.sort()
            print(f"{s:>5} {CFG['SD_START']:>6} {CFG['MAX_ROUND']:>5} | "
                  f"{statistics.mean(rounds):>8.2f} {rounds[len(rounds)*9//10]:>5} "
                  f"{statistics.mean(tot):>10.1f} {'5 回合':>10} "
                  f"{sum(1 for x in surv if x==4)/len(surv):>7.1%}")
    finally:
        CFG.update(old)


LONG = dict(HP_SCALE=1.4, SD_START=10, MAX_ROUND=22)   # 拉长后的对局配置


class UltBattle(Battle):
    """模拟「终极流」玩家：认准终极技，攒满之前一个 EX 都不放；载体阵亡后退回正常贪心。
    贪心 AI 按性价比买，便宜 EX 会先吃光预算，10 费永远凑不齐——那不是人类的打法。"""
    ULT_ID = "YH"

    def plan_ex(self, side):
        if side == 0:
            u = next((x for x in self.teams[0].units
                      if x.t.id == self.ULT_ID and x.alive), None)
            if u is not None:
                if u.ex_cd > 0 or u.stun > 0: return []
                return [u.idx] if self.teams[0].cost >= u.t.ex["cost"] else []
        return super().plan_ex(side)

def run_ult(n=900):
    """给 10 费终极技定价：攒满 5 回合放一发，倍率要多高才回本？

    载体用炎火（爆发/轻装，原本 6 费 700% 单体处决）。
    持有方按 hold=10 强制攒满再花，对手正常贪心。
    胜率 50% = 攒它和不攒一样好；低于 50% = 这是个陷阱选项。
    """
    carrier = BY_ID["YH"]
    old_ex = carrier.ex
    old_cfg = {k: CFG[k] for k in LONG}
    CFG.update(LONG)
    print("\n== 10 费终极技定价 ==（HP×1.4 / 12 回合 / 预算 22.5）")
    print(f"{'方案':<28} {'持有方胜率':>10}")
    trials = [
        ("6费 700% 单体（原案·贪心）",  dict(old_ex),                                             False),
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
    if w in ("all", "scale"):  run_scale()
    if w in ("all", "ult"):    run_ult()
    if w in ("all", "budget"): run_budget()
    if w in ("all", "len"):    run_len()
    if w in ("all", "first"):  run_first()
    if w in ("all", "snow"):   run_snow()
    if w in ("all", "var"):    run_var()
