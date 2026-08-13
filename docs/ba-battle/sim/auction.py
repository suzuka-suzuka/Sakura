"""验证「先手权竞价」：让真正更需要先手的一方拿到先手并付出价格，结果还平衡吗"""
import random
from engine import CFG
import tune
def run(price, n=200, reps=16):
    rng=random.Random(83); wins=0
    for _ in range(n):
        tA,tB=tune.rand_team(rng),tune.rand_team(rng)
        # 先测出双方"先手值多少"：各自先手 vs 后手的胜率差
        CFG["FIRST_PRICE"]=price
        wa=[0,0]
        for f in (0,1):
            for _ in range(reps):
                r,_=tune.play(tA,tB,rng.random()*1e9,first=f)
                if r==0: wa[f]+=1
        vA=(wa[0]-wa[1])/reps          # A 从先手中得到的收益
        vB=-vA                          # 零和：B 的收益正好相反
        first = 0 if vA>vB else 1       # 更需要先手的一方赢下竞价
        w=0
        for _ in range(reps):
            r,_=tune.play(tA,tB,rng.random()*1e9,first=first)
            if r==first: w+=1
        wins+= w/reps
    return round(wins/n,3)
if __name__=="__main__":
    print("「更需要先手的一方拿到先手」时，该方的胜率：")
    for p in (3,4,5): print(f"  标价 {p} Cost → {run(p)}")
