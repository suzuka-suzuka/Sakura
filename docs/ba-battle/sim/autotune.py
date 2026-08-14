"""自动配平：±15% 微调各角色攻击/生命；tune.json 仅记录待烘焙倍率。"""
import random, json
from collections import defaultdict
from engine import *
import tune

def measure(n=9000, seed=31):
    rng=random.Random(seed); win=defaultdict(int); app=defaultdict(int)
    for i in range(n):
        tA,tB=tune.rand_team(rng),tune.rand_team(rng)
        r,_=tune.play(tA,tB,rng.random()*1e9,first=i%2)
        for t in tA: app[t.id]+=1
        for t in tB: app[t.id]+=1
        if r==0:
            for t in tA: win[t.id]+=1
        elif r==1:
            for t in tB: win[t.id]+=1
    return {k: win[k]/app[k] for k in app}

if __name__=="__main__":
    for it in range(8):
        wr=measure(); sp=max(wr.values())-min(wr.values())
        print(f"round {it}: spread={sp:.3f} min={min(wr.values()):.3f} max={max(wr.values()):.3f}")
        # 阈值比目标(0.09)收紧一档：单轮测量有噪声，卡着目标停会导致独立种子复测超标
        if sp<0.06: break
        for k,v in wr.items():
            d=0.5-v
            TUNE[k][0]=min(1.15,max(0.85,TUNE[k][0]*(1+0.55*d)))
            TUNE[k][1]=min(1.15,max(0.85,TUNE[k][1]*(1+0.35*d)))
    wr=measure(12000,seed=99)
    rows=sorted(((BY_ID[k].name,v,round(BY_ID[k].atk*TUNE[k][0]/5)*5,
                  round(BY_ID[k].hp*TUNE[k][1]/50)*50) for k,v in wr.items()),key=lambda r:-r[1])
    print("\n独立种子复测 12000 场")
    for r in rows: print(f"  {r[0]:<4} {r[1]:.3f}  ATK={r[2]} HP={r[3]}")
    print("spread=",round(max(wr.values())-min(wr.values()),3))
    with open("tune.json", "w", encoding="utf-8") as out:
        json.dump({k:[round(a,4),round(b,4)] for k,(a,b) in TUNE.items()}, out)
