"""Independent, source-derived migration checks. Never supplied to the agent."""
import argparse
import importlib.util
import json
import math
import random
import sys
from pathlib import Path
from types import SimpleNamespace
from baseline import grid, load_legacy, source_hash


def verify(source, candidate, module=None):
    legacy = load_legacy(source)
    if module is None:
        spec = importlib.util.spec_from_file_location("candidate_core", candidate)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    checks = []

    def check(name, expected, call):
        try:
            actual = call()
            equal = actual == expected
            if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
                equal = math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-9)
            elif isinstance(expected, (list, tuple)) and isinstance(actual, (list, tuple)):
                equal = len(actual) == len(expected) and all(math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9) for a,b in zip(actual,expected))
            checks.append({"name": name, "passed": bool(equal), "expected": expected, "actual": actual})
        except Exception as exc:
            checks.append({"name": name, "passed": False, "expected": expected, "error": f"{type(exc).__name__}: {exc}"})

    rng = random.Random(193081)
    for n in range(20):
        width,height = rng.choice([12,16,20]), rng.choice([12,15,18])
        res = rng.choice([0.25, 0.5, 1.0])
        origin = (rng.choice([-3.5,0.,2.]), rng.choice([-2.,0.,4.]))
        data = [rng.choice([0,0,0,-1,-1,100]) for _ in range(width*height)]
        m=grid(width,height,res,origin,data)
        col,row=rng.randrange(3,width-3),rng.randrange(3,height-3)
        pt=[origin[0]+col*res,origin[1]+row*res]
        i=row*width+col
        check(f"index parity {n}",legacy["index_of_point"](m,pt),lambda m=m,pt=pt:module.index_of_point(m,pt))
        check(f"cell coordinate parity {n}",list(legacy["point_of_index"](m,i)),lambda m=m,i=i:module.point_of_index(m,i))
        check(f"occupancy parity {n}",legacy["gridValue"](m,pt),lambda m=m,pt=pt:module.gridValue(m,pt))
        radius=2*res
        check(f"information gain parity {n}",legacy["informationGain"](m,pt,radius),lambda m=m,pt=pt,radius=radius:module.informationGain(m,pt,radius))
        centroids=[pt,[pt[0]+res,pt[1]+res]]
        expected=legacy["discount"](m,pt,centroids,[4.,5.],radius)
        check(f"discount parity {n}",expected,lambda m=m,pt=pt,centroids=centroids,radius=radius:module.discount(m,pt,centroids,[4.,5.],radius))

    m=grid()
    for n,pt in enumerate([[-1.01,0.], [0.,-1.01], [5.,0.], [0.,5.], [100.,100.]]):
        check(f"authorized bounds guard {n}",100,lambda pt=pt:module.gridValue(m,pt))
    check("empty frontier set",None,lambda:module.select_goal(m,[0.,0.],[]))
    check("occupied/outside frontier rejection",None,lambda:module.select_goal(m,[0.,0.],[[-0.9,-0.9],[100.,100.]]))
    pts=[[1.5,1.],[1.5,2.],[0.,1.]]
    pos=[0.,0.]
    scores=[]
    for pt in pts:
        gain=legacy["informationGain"](m,pt,1.)
        dist=math.dist(pt,pos)
        scores.append(gain*3.*(2. if dist<=3. else 1.)-dist)
    best=pts[max(range(len(pts)),key=lambda n:scores[n])]
    check("goal scoring/hysteresis",best,lambda:module.select_goal(m,pos,pts))
    route=[SimpleNamespace(pose=SimpleNamespace(position=SimpleNamespace(x=float(x),y=0.))) for x in range(5)]
    check("path cost integer division",legacy["pathCost"](route),lambda:module.pathCost(route))
    check("empty path cost",math.inf,lambda:module.pathCost([]))
    # Negative control: the independent parity checks must notice a wrong candidate.
    original=module.gridValue
    module.gridValue=lambda *_:42
    caught=any(module.gridValue(m,p)!=legacy["gridValue"](m,p) for p in pts)
    module.gridValue=original
    checks.append({"name":"negative control detects corrupted occupancy", "passed":caught})
    failed=sum(not c["passed"] for c in checks)
    return {"kind":"source_algorithm_parity", "baseline":"upstream Python2 functions executed with explicit integer-division compatibility", "ros1RuntimeExecuted":False,
        "sourceSha256":source_hash(source),"candidateSha256":source_hash(candidate),"total":len(checks),"passed":len(checks)-failed,"failed":failed,"verdict":"pass" if not failed else "fail","checks":checks}


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--source",required=True)
    parser.add_argument("--candidate",required=True)
    parser.add_argument("--out",required=True)
    args=parser.parse_args()
    report=verify(args.source,args.candidate)
    Path(args.out).parent.mkdir(parents=True,exist_ok=True)
    report = json.loads(json.dumps(report, allow_nan=True), parse_constant=lambda value: value)
    Path(args.out).write_text(json.dumps(report,indent=2,allow_nan=False)+"\n")
    print(json.dumps({k:report[k] for k in ["kind","total","passed","failed","verdict"]}))
    for c in report["checks"]:
        if not c["passed"]:print(json.dumps(c))
    sys.exit(0 if report["verdict"]=="pass" else 1)
