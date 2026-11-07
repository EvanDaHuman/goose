"""Send the scenario's requests to one running application and record what came back."""
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from .common import http

REF = re.compile(r"\{([A-Za-z_][\w]*)\}")


def resolve(value, saved):
    if isinstance(value, str):
        m = REF.fullmatch(value)
        if m and m.group(1) in saved:
            return saved[m.group(1)]
        return REF.sub(lambda mm: str(saved.get(mm.group(1), mm.group(0))), value)
    if isinstance(value, list):
        return [resolve(v, saved) for v in value]
    if isinstance(value, dict):
        return {k: resolve(v, saved) for k, v in value.items()}
    return value


def run(base_url, scenario, timezone):
    zone = ZoneInfo(timezone)
    saved = dict(scenario.get("fixed") or {})   # refs bound to existing records
    started = datetime.now(zone).replace(microsecond=0)
    results = []
    for step in scenario["steps"]:
        path = resolve(step["path"], saved)
        body = resolve(step["body"], saved)
        res = http(base_url, step["method"], path, body, step.get("headers"))
        got = {}
        for name, field in (step.get("save") or {}).items():
            if isinstance(res.get("body"), dict) and field in res["body"]:
                got[name] = res["body"][field]
                saved[name] = res["body"][field]
        results.append({"step": step["id"], "method": step["method"], "path": path, "body_sent": body,
                        "status": res["status"], "body": res.get("body"), "kind": res.get("kind"),
                        "headers": res.get("headers", {}), "error": res.get("error"), "saved": got})
    finished = datetime.now(zone).replace(microsecond=0)
    return {"started": started.isoformat(), "finished": finished.isoformat(), "timezone": timezone,
            "base_url": base_url, "saved": saved, "results": results}
