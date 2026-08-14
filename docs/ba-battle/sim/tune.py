import random, statistics, itertools, sys
from collections import defaultdict
from engine import *

def rand_team(rng): return rng.sample(ROSTER,4)
def play(tA,tB,seed,first=None,holds=(0,0)):
    b=Battle(tA,tB,rng=random.Random(seed),first=first); b.holds=holds
    return b.run(), b.round

def exp_length(n=2000):
    rng=random.Random(7); rounds=[];draws=0
    for i in range(n):
        w,t=play(rand_team(rng),rand_team(rng),rng.random()*1e9,first=i%2)
        rounds.append(t)
        if w==-1: draws+=1
    rounds.sort()
    return dict(mean=round(statistics.mean(rounds),2), median=rounds[len(rounds)//2],
                p10=rounds[n//10], p90=rounds[n*9//10],
                maxed=sum(1 for t in rounds if t>=CFG["MAX_ROUND"]), draw=draws)

def exp_first(n=2500):
    """同一对阵，分别让 A/B 先手，统计先手方胜率"""
    rng=random.Random(19); fw=0; g=0; draw=0
    for _ in range(n):
        tA,tB=rand_team(rng),rand_team(rng); sd=rng.random()*1e9
        for f in (0,1):
            r,_=play(tA,tB,sd,first=f)
            if r==-1: draw+=1
            elif r==f: fw+=1
            g+=1
    return dict(先手胜率=round(fw/g,3), 平局率=round(draw/g,3))

def order_score(p,tB):
    return sum(affinity(p[i].atk_type,tB[i].def_type)-affinity(tB[i].atk_type,p[i].def_type) for i in range(4))

def exp_counter(n=1200):
    rng=random.Random(11); wo=0; wr=0; g=0
    for i in range(n):
        tA,tB=rand_team(rng),rand_team(rng)
        best=list(max(itertools.permutations(tA),key=lambda p:order_score(p,tB)))
        rnd=list(tA); rng.shuffle(rnd); sd=rng.random()*1e9
        if play(best,tB,sd,first=i%2)[0]==0: wo+=1
        if play(rnd ,tB,sd,first=i%2)[0]==0: wr+=1
        g+=1
    return dict(最优站位胜率=round(wo/g,3), 随机站位胜率=round(wr/g,3))

def exp_extreme(n=800):
    rng=random.Random(13); w=0;g=0
    for _ in range(n):
        tB=rand_team(rng); tA=[]; ok=True
        for i in range(4):
            cand=[t for t in ROSTER if AFF_TABLE[t.atk_type][tB[i].def_type]=="S" and t not in tA]
            if not cand: ok=False;break
            tA.append(rng.choice(cand))
        if not ok: continue
        if play(tA,tB,rng.random()*1e9,first=g%2)[0]==0: w+=1
        g+=1
    return dict(全踩克制胜率=round(w/max(1,g),3), 样本=g)

def exp_power(n=6000):
    rng=random.Random(23); win=defaultdict(int); app=defaultdict(int)
    for i in range(n):
        tA,tB=rand_team(rng),rand_team(rng)
        r,_=play(tA,tB,rng.random()*1e9,first=i%2)
        for t in tA: app[t.id]+=1
        for t in tB: app[t.id]+=1
        if r==0:
            for t in tA: win[t.id]+=1
        elif r==1:
            for t in tB: win[t.id]+=1
    rows=[(BY_ID[k].name,BY_ID[k].atk_type+"/"+BY_ID[k].def_type,
           round(win[k]/app[k],3),app[k]) for k in app]
    rows.sort(key=lambda r:-r[2]); return rows

def exp_variance(mode,pairs=120,reps=40):
    old=CFG["RNG_MODE"]; CFG["RNG_MODE"]=mode
    rng=random.Random(29); devs=[]
    for i in range(pairs):
        tA,tB=rand_team(rng),rand_team(rng); w=0
        for _ in range(reps):
            if play(tA,tB,rng.random()*1e9,first=i%2)[0]==0: w+=1
        devs.append(abs(w/reps-0.5))
    CFG["RNG_MODE"]=old
    return round(statistics.mean(devs)*2,3)

def exp_hold(hold, n=2000):
    """蓄力方(hold=攒到 N Cost 才开始花) vs 贪心方，双向各打一次消除阵营偏差"""
    rng=random.Random(41); w=0;g=0
    for i in range(n):
        tA,tB=rand_team(rng),rand_team(rng); sd=rng.random()*1e9
        for swap in (0,1):
            t0,t1 = (tB,tA) if swap else (tA,tB)
            holds = (0,hold) if swap else (hold,0)     # tA 是蓄力方
            r,_=play(t0,t1,sd,first=i%2,holds=holds)
            if (r==1 if swap else r==0): w+=1
            g+=1
    return round(w/g,3)

if __name__=="__main__":
    w=sys.argv[1] if len(sys.argv)>1 else "all"
    if w in ("all","len"):   print("对局长度  ", exp_length())
    if w in ("all","first"): print("先手公平  ", exp_first())
    if w in ("all","cnt"):   print("站位博弈  ", exp_counter())
    if w in ("all","ext"):   print("极端克制  ", exp_extreme())
    if w in ("all","var"):   print("配队决定度 gauge=",exp_variance("gauge")," pure=",exp_variance("pure"))
    if w in ("all","hold"):
        print("Cost 策略（对手=贪心）:")
        print("   完全不放 EX     ", exp_hold(-1,1200))
        for h in (5,6,7,8,10,12): print(f"   攒到 {h:>2} 再花     ", exp_hold(h,1200))
    if w in ("all","pow"):
        print("\n角色强度")
        for r in exp_power(): print(f"  {r[0]:<4} {r[1]:<6} {r[2]:.3f}")
