"""先手权的"价格曲线"：先手方开局 Cost 扣 N 点时，先手方胜率是多少"""
from engine import CFG
import tune, first_test
CFG["FIRST_SKIP_COST"]=False
print(f"{'先手方开局扣 Cost':<18}{'先手胜率':<10}{'先手更优对阵占比':<18}{'后手更优对阵占比'}")
for n in (0,1,2,3,4,5,6):
    CFG["FIRST_PRICE"]=n
    r=first_test.per_matchup(160,16)
    print(f"  -{n:<16}{r['先手方平均胜率']:<12}{r['先手更优的对阵占比']:<20}{r['后手更优的对阵占比']}")
CFG["FIRST_PRICE"]=None; CFG["FIRST_SKIP_COST"]=True
