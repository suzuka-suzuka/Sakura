"""验证：队内出手顺序（=配队位置）是否真的重要"""
import random
from engine import *
import tune
def test(team_ids, moved, n=4000):
    """把 moved 角色放 1 号位 vs 放 4 号位，对手随机且随机排序 → 抵消对线影响"""
    others=[BY_ID[i] for i in team_ids if i!=moved]; m=BY_ID[moved]
    res={}
    for name,team in (("放1号位",[m]+others), ("放4号位",others+[m])):
        rng=random.Random(77); w=0; g=0
        while g<n:
            tB=tune.rand_team(rng)
            if any(t.id in team_ids for t in tB): continue
            r,_=tune.play(list(team),tB,rng.random()*1e9,first=g%2)
            if r==0: w+=1
            g+=1
        res[name]=round(w/g,3)
    return res
print("队伍 [穿甲(普技减防→影响队友后续输出) 炎火 锐锋 闪光]：")
print("  ", test(["CJ","YH","RF","SG"],"CJ"))
print("队伍 [虚数(普技挂灼烧) 炎火 锐锋 闪光]：")
print("  ", test(["XS","YH","RF","SG"],"XS"))
print("队伍 [烈风(全体增伤) 炎火 锐锋 连射]：")
print("  ", test(["LF","YH","RF","LS"],"LF"))
print("队伍 [秘仪(治疗) 炎火 锐锋 闪光]：")
print("  ", test(["MY","YH","RF","SG"],"MY"))
