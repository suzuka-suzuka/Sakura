"""先后手到底值多少？逐对阵测量，而不是只看总平均"""
import random, statistics
from engine import *
import tune

def per_matchup(n_pairs=250, reps=24):
    """同一对阵，分别固定 A 先手 / B 先手各跑 reps 场，看胜率差"""
    rng=random.Random(61); gaps=[]; wr_first=[]
    for _ in range(n_pairs):
        tA,tB=tune.rand_team(rng),tune.rand_team(rng)
        w=[0,0]
        for f in (0,1):
            for _ in range(reps):
                r,_=tune.play(tA,tB,rng.random()*1e9,first=f)
                if r==0: w[f]+=1
        a0,a1=w[0]/reps, w[1]/reps          # A 在先手/后手时的胜率
        gaps.append(a0-a1)                   # >0 表示先手更好
        wr_first.append(a0); wr_first.append(1-a1)
    ag=[abs(g) for g in gaps]; ag.sort()
    return dict(
        平均先手收益=round(statistics.mean(gaps),3),
        先手方平均胜率=round(statistics.mean(wr_first),3),
        逐局摆幅中位数=round(ag[len(ag)//2],3),
        逐局摆幅P90=round(ag[int(len(ag)*0.9)],3),
        摆幅超过20pp的比例=round(sum(1 for g in ag if g>0.20)/len(ag),3),
        先手更优的对阵占比=round(sum(1 for g in gaps if g>0.02)/len(gaps),3),
        后手更优的对阵占比=round(sum(1 for g in gaps if g<-0.02)/len(gaps),3))

def oracle_choice(n_pairs=250, reps=24):
    """如果揭晓后允许一方看着阵容选先手/后手，这个选择权值多少？"""
    rng=random.Random(71); w=0
    for _ in range(n_pairs):
        tA,tB=tune.rand_team(rng),tune.rand_team(rng)
        s=[0,0]
        for f in (0,1):
            for _ in range(reps):
                r,_=tune.play(tA,tB,rng.random()*1e9,first=f)
                if r==0: s[f]+=1
        w+= max(s)/reps                       # A 总是选对自己更好的那边
    return round(w/n_pairs,3)

if __name__=="__main__":
    print("逐对阵先后手影响:", per_matchup())
    print("揭晓后可自选先后手的一方胜率(上限):", oracle_choice())
