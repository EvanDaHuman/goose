"""Combine phase results into the verification report (JSON for the system, Markdown for people)."""
from datetime import datetime, timezone

from .common import read_json

CATEGORY_TITLES = {
    "records": "Every record arrived", "relationships": "Links between records", "same_name": "Customers who share a name",
    "money": "Totals and the discount rule", "stock": "Stock when orders are placed and cancelled",
    "retries": "Repeated requests", "dates_statuses": "Dates and statuses", "read_update": "Reading and changing moved data",
    "migration_retry": "Running the data move again", "app_starts": "The delivered app starts",
    "compatibility": "Old and new app give the same answers",
}

NOT_TESTED = [
    "Load beyond 12 simultaneous orders, and long-running performance.",
    "Requests the scenario does not send (only the recorded representative requests are compared).",
    "The shop front-end and warehouse scripts themselves; only the API they call was tested.",
    "Server, network and backup setup in your hosting environment.",
    "Passing these checks does not prove every possible behaviour is correct.",
]


def build(vault, phase_files, attempt, integrity):
    scope = read_json(f"{vault}/scope.json")
    scenario = read_json(f"{vault}/scenario.json")
    manifest = read_json(f"{vault}/MANIFEST.json")
    results = []
    for f in phase_files:
        results += read_json(f)
    by_cat = {}
    for r in results:
        c = by_cat.setdefault(r["category"], {"pass": 0, "fail": 0, "skip": 0})
        c[r["status"]] += 1
    # a mandatory check that did not run counts as a failure; an optional one is reported with its reason
    failed = [r for r in results if r["status"] == "fail" or (r["status"] == "skip" and r.get("mandatory", True))]
    passed = sum(1 for r in results if r["status"] == "pass")
    optional_skipped = [{"id": r["id"], "reason": r.get("reason") or r.get("evidence", {}).get("reason")}
                        for r in results if r["status"] == "skip" and not r.get("mandatory", True)]
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "attempt": attempt,
        "integrity": integrity,
        "frozen_manifest": {"frozen_at": manifest["frozen_at"], "source_db_sha256": manifest["source_db_sha256"]},
        "summary": {"total": len(results), "passed": passed, "failed": len(failed),
                    "skipped": sum(1 for r in results if r["status"] == "skip"),
                    "mandatory_total": sum(1 for r in results if r.get("mandatory", True)), "optional_skipped": optional_skipped,
                    "verdict": "pass" if integrity["ok"] and not failed and results else "fail"},
        "by_category": {k: {**v, "title": CATEGORY_TITLES.get(k, k)} for k, v in by_cat.items()},
        "failed": failed,
        "results": results,
        "coverage": scenario["coverage"],
        "intentional_differences": scope["intentional_differences"],
        "not_tested": NOT_TESTED,
    }
    return report, markdown(report, scope)


def markdown(rep, scope):
    s = rep["summary"]
    lines = [f"# Verification report - {scope.get('app_title') or scope['app_slug']}", "",
             f"Attempt {rep['attempt']} - {rep['generated_at']}", "",
             f"**Verdict: {'PASS' if s['verdict'] == 'pass' else 'FAIL'}** - {s['passed']} of {s['total']} checks passed, "
             f"{s['failed']} failed (a skipped mandatory check counts as failed), {s['skipped']} skipped.", "",
             *([f"Optional checks skipped: " + "; ".join(f"{x['id']} ({x['reason']})" for x in s["optional_skipped"]), ""] if s.get("optional_skipped") else []),
             f"Frozen checks: integrity {'confirmed' if rep['integrity']['ok'] else 'FAILED'} "
             f"(frozen {rep['frozen_manifest']['frozen_at']}, source database sha256 "
             f"{rep['frozen_manifest']['source_db_sha256'][:16]}...).", "", "## By area", "",
             "| Area | Passed | Failed | Skipped |", "| --- | --- | --- | --- |"]
    for k, v in rep["by_category"].items():
        lines.append(f"| {v['title']} | {v['pass']} | {v['fail']} | {v['skip']} |")
    if rep["failed"]:
        lines += ["", "## Failed checks", ""]
        for f in rep["failed"]:
            lines.append(f"- **{f['id']}** - {f['title']}. Expected `{_short(f['expected'])}`, got `{_short(f['actual'])}`.")
    lines += ["", "## Agreed differences between the old and new app", ""]
    lines += [f"- {d['title']}. {d['detail']}" for d in rep["intentional_differences"]]
    cov = rep["coverage"]
    lines += ["", "## What was tested", "",
              f"- {cov['routes_covered']} of {cov['routes_total']} endpoints exercised by the recorded scenario.",
              "- Every row of every table compared field by field after the agreed conversions.",
              "- The data move run a second time to prove it creates no duplicates."]
    lines += [f"- Note: {n}" for n in cov["notes"]]
    lines += ["", "## What was not tested", ""] + [f"- {n}" for n in rep["not_tested"]]
    return "\n".join(lines) + "\n"


def _short(v):
    t = str(v)
    return t if len(t) < 140 else t[:137] + "..."
