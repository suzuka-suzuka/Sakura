"""Cost 参数对照实验 —— 「开局 3 / 上限 12」 vs 原作对齐的「开局 0 / 上限 10」

用法：
    python cost_test.py         # 全部
    python cost_test.py len     # 对局长度
    python cost_test.py first   # 先手公平（补偿是否仍需 3）
    python cost_test.py hold    # 攒 Cost 策略曲线
    python cost_test.py pow     # 角色强度（重点看 6 费角色与 Cost 引擎）
"""
import sys, statistics, random
from collections import defaultdict
from engine import *
import tune

_B = dict(COST_START=0, COST_MAX=10, COST_PASS_BONUS=0)   # 开局 0 / 上限 10 / 无过+1 已定

# (名称, CFG 补丁, 共鸣 cost_regen)
# 共鸣的自然定价 = 「本人算两个人」：定额模式 +1，按人头模式 +N（等于多一个存活角色）
VARIANTS = [
    ("A 现行 定额3 过+1", dict(COST_START=3, COST_MAX=12, COST_REGEN=3, COST_PASS_BONUS=1), 1.0),
    ("E      定额3",      dict(_B, COST_REGEN=3),                      1.0),
    ("F      定额2",      dict(_B, COST_REGEN=2),                      1.0),
    ("H      人头0.5(满编2)", dict(_B, COST_REGEN=0, COST_REGEN_PER_UNIT=0.5),  0.5),
    ("J      人头1.0(满编4)", dict(_B, COST_REGEN=0, COST_REGEN_PER_UNIT=1.0),  1.0),
    ("K 折中 保底2+每人0.5", dict(_B, COST_REGEN=2, COST_REGEN_PER_UNIT=0.5),   0.5),
    ("L 折中 保底1+每人0.75", dict(_B, COST_REGEN=1, COST_REGEN_PER_UNIT=0.75), 0.75),
]

def with_cfg(patch, fn, *a, **kw):
    """patch 可含 'gm' 键（共鸣 cost_regen），其余进 CFG"""
    gm = BY_ID["GM"]; gm_old = gm.passive["cost_regen"]
    patch = dict(patch)
    if "gm" in patch: gm.passive["cost_regen"] = patch.pop("gm")
    old = {k: CFG[k] for k in patch}
    CFG.update(patch)
    try:
        return fn(*a, **kw)
    finally:
        CFG.update(old); gm.passive["cost_regen"] = gm_old


def run_len():
    print("\n== 对局长度 ==")
    print(f"{'配置':<22} {'平均':>6} {'中位':>5} {'P90':>5} {'打满上限':>9}")
    for name, patch, gm in VARIANTS:
        r = with_cfg(dict(patch, gm=gm), tune.exp_length, 1500)
        print(f"{name:<22} {r['mean']:>6} {r['median']:>5} {r['p90']:>5} "
              f"{r['maxed']/1500:>8.1%}")


def run_first():
    """先手补偿 SECOND_BONUS 的价格曲线是否随开局 Cost 变化"""
    print("\n== 先手胜率 vs 补偿点数 ==（目标 50%）")
    hdr = "  ".join(f"补偿{n}" for n in (2, 3, 4))
    print(f"{'配置':<22} {hdr}")
    for name, patch, gm in VARIANTS:
        cells = []
        for bonus in (2, 3, 4):
            p = dict(patch, SECOND_BONUS=bonus, gm=gm)
            r = with_cfg(p, tune.exp_first, 1200)
            cells.append(f"{r['先手胜率']:>6.1%}")
        print(f"{name:<22} " + "  ".join(cells))


def run_hold():
    print("\n== 攒 Cost 策略（对手=贪心，胜率>50% 说明攒得值）==")
    holds = (5, 6, 7, 8, 10)
    print(f"{'配置':<22} {'不放EX':>7} " + " ".join(f"{'攒'+str(h):>6}" for h in holds))
    for name, patch, gm in VARIANTS:
        p = dict(patch, gm=gm)
        never = with_cfg(p, tune.exp_hold, -1, 700)
        cells = [with_cfg(p, tune.exp_hold, h, 700) for h in holds]
        print(f"{name:<22} {never:>7.3f} " + " ".join(f"{c:>6.3f}" for c in cells))


WATCH = ["炎火", "重炮", "共鸣", "闪光", "秘仪", "灵护"]

def run_pow():
    print("\n== 角色强度 ==（6 费=炎火/重炮，2 费=共鸣/闪光）")
    print(f"{'配置':<22} " + " ".join(f"{w:>6}" for w in WATCH) + f" {'极差':>7}")
    for name, patch, gm in VARIANTS:
        rows = with_cfg(dict(patch, gm=gm), tune.exp_power, 4000)
        d = {r[0]: r[3] for r in rows}
        rng = max(d.values()) - min(d.values())
        print(f"{name:<22} " + " ".join(f"{d[w]:>6.3f}" for w in WATCH) + f" {rng:>7.3f}")


def run_gm():
    """回复速率变了之后，Cost 引擎被动要重新定价 —— 在 F 下扫描共鸣的 cost_regen"""
    F = dict(_B, COST_REGEN=2, COST_PASS_BONUS=0)
    gm = BY_ID["GM"]
    old = gm.passive["cost_regen"]
    print("\n== F(回复2/过+0) 下共鸣被动定价 ==")
    print(f"{'共鸣 cost_regen':<16} {'共鸣胜率':>9} {'次高':>16} {'极差':>7}")
    try:
        for v in (1.0, 0.67, 0.5, 0.34, 0.0):
            gm.passive["cost_regen"] = v
            rows = with_cfg(F, tune.exp_power, 4000)
            d = {r[0]: r[3] for r in rows}
            other = sorted(((k, x) for k, x in d.items() if k != "共鸣"), key=lambda r: -r[1])[0]
            rng = max(d.values()) - min(d.values())
            print(f"{v:<16} {d['共鸣']:>9.3f} {other[0]+' '+format(other[1],'.3f'):>16} {rng:>7.3f}")
    finally:
        gm.passive["cost_regen"] = old


def _survivors(n=1200):
    rng = random.Random(53); surv = []
    for i in range(n):
        tA, tB = tune.rand_team(rng), tune.rand_team(rng)
        b = Battle(tA, tB, rng=random.Random(rng.random() * 1e9), first=i % 2)
        r = b.run()
        if r in (0, 1): surv.append(len(b.teams[r].alive))
    return surv

def run_snow():
    """滚雪球程度：人头掉了收入就掉，会不会让翻盘彻底消失"""
    print("\n== 滚雪球程度 ==（获胜方剩余人数，越高=碾压局越多）")
    print(f"{'配置':<22} {'胜方剩余':>9} {'4人全活':>9} {'惨胜(剩1)':>10}")
    for name, patch, gm in VARIANTS:
        s = with_cfg(dict(patch, gm=gm), _survivors)
        print(f"{name:<22} {statistics.mean(s):>9.2f} "
              f"{sum(1 for x in s if x == 4)/len(s):>8.1%} {sum(1 for x in s if x == 1)/len(s):>9.1%}")


if __name__ == "__main__":
    w = sys.argv[1] if len(sys.argv) > 1 else "all"
    if w in ("all", "snow"):  run_snow()
    if w in ("all", "gm"):    run_gm()
    if w in ("all", "len"):   run_len()
    if w in ("all", "first"): run_first()
    if w in ("all", "hold"):  run_hold()
    if w in ("all", "pow"):   run_pow()
