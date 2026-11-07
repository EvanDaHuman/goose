"""Command line for independent verification.

    python -m goose_verify.cli scenario  --assessment A --scope S --source-db DB --out scenario.json
    python -m goose_verify.cli record    --scenario F --url URL --timezone TZ --out baseline.json
    python -m goose_verify.cli freeze    --vault DIR --assessment A --scope S --scenario F --baseline B --source-db DB --job ID
    python -m goose_verify.cli integrity --vault DIR --manifest-sha SHA
    python -m goose_verify.cli data      --vault DIR --dsn DSN --out data.json --digests digests.json
    python -m goose_verify.cli retry     --vault DIR --dsn DSN --digests digests.json --rerun-log LOG --out retry.json
    python -m goose_verify.cli behavior  --vault DIR --url URL --out behavior.json --recording rec.json
    python -m goose_verify.cli fresh     --vault DIR --package DIR --url URL --install-log F --junit F --out fresh.json
    python -m goose_verify.cli report    --vault DIR --attempt N --manifest-sha SHA --inputs a.json b.json --out report
"""
import argparse
import sys
from pathlib import Path

from . import behavior, datachecks, fresh, freeze, preserve, record, report, scenario
from .common import emit, read_json, write_json


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("scenario")
    for a in ("--assessment", "--scope", "--source-db", "--out"):
        p.add_argument(a, required=True)
    p = sub.add_parser("record")
    for a in ("--scenario", "--url", "--timezone", "--out"):
        p.add_argument(a, required=True)
    p = sub.add_parser("freeze")
    for a in ("--vault", "--assessment", "--scope", "--scenario", "--baseline", "--source-db", "--job"):
        p.add_argument(a, required=True)
    p = sub.add_parser("integrity")
    p.add_argument("--vault", required=True)
    p.add_argument("--manifest-sha", required=True)
    p = sub.add_parser("data")
    for a in ("--vault", "--dsn", "--out", "--digests"):
        p.add_argument(a, required=True)
    p = sub.add_parser("retry")
    for a in ("--vault", "--dsn", "--digests", "--rerun-log", "--out"):
        p.add_argument(a, required=True)
    p = sub.add_parser("behavior")
    for a in ("--vault", "--url", "--out", "--recording"):
        p.add_argument(a, required=True)
    p.add_argument("--dsn")
    p = sub.add_parser("fresh")
    for a in ("--vault", "--package", "--url", "--install-log", "--junit", "--out"):
        p.add_argument(a, required=True)
    p.add_argument("--dsn")
    p = sub.add_parser("report")
    p.add_argument("--vault", required=True)
    p.add_argument("--attempt", type=int, required=True)
    p.add_argument("--manifest-sha", required=True)
    p.add_argument("--inputs", nargs="+", required=True)
    p.add_argument("--out", required=True)
    # behaviour-preserving upgrades (preserve.py)
    p = sub.add_parser("web-scenario")
    for x in ("--inspection", "--repo", "--source-db", "--out"):
        p.add_argument(x, required=True)
    p = sub.add_parser("web-record")
    for x in ("--scenario", "--url", "--timezone", "--out"):
        p.add_argument(x, required=True)
    p = sub.add_parser("dump")
    for x in ("--db", "--out"):
        p.add_argument(x, required=True)
    p = sub.add_parser("freeze-preserve")
    for x in ("--vault", "--plan", "--scenario", "--baseline", "--baseline-dump", "--job", "--kind"):
        p.add_argument(x, required=True)
    for x in ("--tests", "--scripts", "--source-db"):
        p.add_argument(x)
    p = sub.add_parser("compare")
    for x in ("--vault", "--recording", "--dump", "--timezone", "--out"):
        p.add_argument(x, required=True)
    for x in ("--tests", "--scripts", "--framework", "--app"):
        p.add_argument(x)
    p = sub.add_parser("report-preserve")
    p.add_argument("--vault", required=True)
    p.add_argument("--attempt", type=int, required=True)
    p.add_argument("--manifest-sha", required=True)
    p.add_argument("--inputs", nargs="+", required=True)
    p.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "web-scenario":
        sc = preserve.web_scenario(read_json(a.inspection), a.repo, a.source_db)
        write_json(a.out, sc)
        emit("scenario.done", steps=len(sc["steps"]), coverage=sc["coverage"])
        return
    if a.cmd == "web-record":
        rec = preserve.web_record(a.url, read_json(a.scenario), a.timezone)
        write_json(a.out, rec)
        emit("record.done", steps=len(rec["results"]), errors=sum(1 for r in rec["results"] if r.get("status") is None))
        return
    if a.cmd == "dump":
        d = preserve.dump_sqlite(a.db)
        write_json(a.out, d)
        emit("dump.done", tables=len(d), rows=sum(len(t["rows"]) for t in d.values()))
        return
    if a.cmd == "freeze-preserve":
        sha, info = preserve.freeze_preserve(a.vault, a.plan, a.scenario, a.baseline, a.baseline_dump, a.tests, a.scripts,
                                             a.source_db, a.job, a.kind)
        emit("freeze.done", manifest_sha256=sha, files=info["files"], checks=info["checks"])
        return
    if a.cmd == "compare":
        res = preserve.compare(a.vault, a.recording, a.dump, a.tests, a.scripts, a.framework, a.app, a.timezone)
        write_json(a.out, res)
        emit("compare.done", total=len(res), failed=sum(1 for r in res if r["status"] == "fail"),
             skipped=sum(1 for r in res if r["status"] == "skip"))
        return
    if a.cmd == "report-preserve":
        ok, problems = freeze.check_integrity(a.vault, a.manifest_sha)
        rep, md = preserve.report_preserve(a.vault, a.inputs, a.attempt, {"ok": ok, "problems": problems})
        write_json(a.out + ".json", rep)
        Path(a.out + ".md").write_text(md)
        emit("report.done", verdict=rep["summary"]["verdict"], total=rep["summary"]["total"], failed=rep["summary"]["failed"])
        return

    if a.cmd == "scenario":
        sc = scenario.build(read_json(a.assessment), read_json(a.scope), a.source_db)
        write_json(a.out, sc)
        emit("scenario.done", steps=len(sc["steps"]), coverage=sc["coverage"])
    elif a.cmd == "record":
        sc = read_json(a.scenario)
        rec = record.run(a.url, sc, a.timezone)
        write_json(a.out, rec)
        errors = sum(1 for r in rec["results"] if r["status"] is None)
        emit("record.done", steps=len(rec["results"]), unreachable=errors)
        return 1 if errors == len(rec["results"]) else 0
    elif a.cmd == "freeze":
        sha, manifest = freeze.freeze(a.vault, a.assessment, a.scope, a.scenario, a.baseline, a.source_db, a.job)
        emit("freeze.done", manifest_sha256=sha, files=list(manifest["files"]))
    elif a.cmd == "integrity":
        ok, problems = freeze.check_integrity(a.vault, a.manifest_sha)
        emit("integrity", ok=ok, problems=problems)
        return 0 if ok else 3
    elif a.cmd == "data":
        res, digests = datachecks.run_data(a.vault, a.dsn)
        write_json(a.out, res)
        write_json(a.digests, digests)
        emit("data.done", checks=len(res), failed=sum(1 for r in res if r["status"] == "fail"))
    elif a.cmd == "retry":
        log = Path(a.rerun_log).read_text() if Path(a.rerun_log).exists() else ""
        res = datachecks.run_retry(a.vault, a.dsn, read_json(a.digests), log)
        write_json(a.out, res)
        emit("retry.done", checks=len(res), failed=sum(1 for r in res if r["status"] == "fail"))
    elif a.cmd == "behavior":
        res, rec = behavior.run_behavior(a.vault, a.url, a.dsn)
        write_json(a.out, res)
        write_json(a.recording, rec)
        emit("behavior.done", checks=len(res), failed=sum(1 for r in res if r["status"] == "fail"))
    elif a.cmd == "fresh":
        res = fresh.run_fresh(a.vault, a.package, a.url, a.install_log, a.junit, a.dsn)
        write_json(a.out, res)
        emit("fresh.done", checks=len(res), failed=sum(1 for r in res if r["status"] == "fail"))
    elif a.cmd == "report":
        ok, problems = freeze.check_integrity(a.vault, a.manifest_sha)
        rep, md = report.build(a.vault, a.inputs, a.attempt, {"ok": ok, "problems": problems})
        write_json(a.out + ".json", rep)
        Path(a.out + ".md").write_text(md)
        emit("report.done", verdict=rep["summary"]["verdict"], passed=rep["summary"]["passed"],
             failed=rep["summary"]["failed"], total=rep["summary"]["total"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
