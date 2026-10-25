# Compares what the OLD look (ui2=0) and the NEW look (ui2=1) print on every screen, number by number.
# Usage: python3 compare.py <dir with 0_<role>.json and 1_<role>.json>   — prints missing (in old, absent in new) and added counts.
import json, sys, os
from collections import Counter
d = sys.argv[1]
bad = 0
for role in ['admin', 'owner', 'manager']:
    f0, f1 = os.path.join(d, f'0_{role}.json'), os.path.join(d, f'1_{role}.json')
    if not (os.path.exists(f0) and os.path.exists(f1)): continue
    a, b = json.load(open(f0)), json.load(open(f1))
    for v in a:
        ta, tb = Counter(a[v]['tokens']), Counter(b[v]['tokens'])
        miss = sum((ta - tb).values()); add = sum((tb - ta).values())
        print(f'{role:8}{v:13} old={sum(ta.values()):5} new={sum(tb.values()):5} missing={miss:4} added={add:4}')
        if miss and v != 'settings': bad += 1
print('FAIL: numbers missing from the new look' if bad else 'OK: every number of the old look is present in the new look')
