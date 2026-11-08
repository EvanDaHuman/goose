"""Candidate-side protocol only. Expected values and reports stay on the host."""
import importlib.util
import json
import math
import sys
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location("candidate",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def restore(value):
    if isinstance(value,dict):
        if set(value)=={"__object__"}:return SimpleNamespace(**{k:restore(v) for k,v in value["__object__"].items()})
        return {k:restore(v) for k,v in value.items()}
    if isinstance(value,list):return [restore(v) for v in value]
    return value

def clean(value):
    if isinstance(value,float) and not math.isfinite(value):return {"__number__":str(value)}
    if isinstance(value,(list,tuple)):return [clean(v) for v in value]
    return value

for line in sys.stdin:
    try:
        request=json.loads(line)
        if request["op"] not in {"index_of_point","point_of_index","informationGain","discount","pathCost","gridValue","select_goal"}:raise ValueError("Unknown operation")
        result=getattr(module,request["op"])(*restore(request["args"]),**restore(request.get("kwargs",{})))
        response={"id":request["id"],"value":clean(result)}
    except Exception as exc:
        response={"id":request.get("id"),"error":f"{type(exc).__name__}: {exc}"}
    print(json.dumps(response,allow_nan=False),flush=True)
