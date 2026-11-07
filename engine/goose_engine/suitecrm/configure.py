"""Configure Goose's sales-workspace template for one job: write config.json from the inspection (dropdowns, custom fields,
the approval rule's parameters with their source lines, access settings), the accepted plan and the customer's answers, and copy
the template into the delivery folder. Nothing is invented here: a value missing from the inspection stops the run.

    python -m goose_engine.suitecrm.configure --inspection I --plan P --template engine/targets/sales_workspace \
        --job GS-1030 --source-url http://localhost:8081 --out-dir delivered/
"""
import argparse
import json
import shutil
from pathlib import Path


def options(d):
    return [{"key": k, "label": v} for k, v in (d or {}).items() if k != ""]


def build_config(insp, plan, job, source_url, snapshot_taken_at):
    facts = insp["facts"]
    lists = facts["lists"]
    prob = lists.get("sales_probability_dom") or {}
    stages = []
    for k, label in (lists.get("sales_stage_dom") or {}).items():
        if k == "":
            continue
        st = {"key": k, "label": label, "probability": int(prob[k]) if str(prob.get(k, "")).isdigit() else None}
        if k == "Closed Won":
            st["won"] = True
        if k == "Closed Lost":
            st["lost"] = True
        stages.append(st)
    if not stages:
        raise SystemExit("inspection has no sales stages; cannot configure the workspace")
    rule_f = next((f for f in insp["findings"] if f["id"] == "F-crm-approval-rule"), None)
    rule = (rule_f or {}).get("rule")
    if rule and not all(rule.get(k) for k in ("threshold_usd", "won_stage", "manager_role")):
        raise SystemExit("the approval rule was found but its parameters are incomplete; this needs a person or the agent team")
    custom = []
    for f in facts.get("custom_fields", []):
        if f["custom_module"] == "Accounts" and f["type"] == "date":
            custom.append({"entity": "accounts", "column": "contract_renewal_date", "label": "Contract renewal date", "type": "date",
                           "source": f"{f['table']}.{f['name']}"})
    sec = facts["access"]["settings"]
    cfg = facts["config"]
    answers = plan.get("answers_used", {})
    return {
        "workspace_name": f"{job.get('customer_short', 'Sales')} Sales",
        "customer": job.get("customer", ""),
        "synthetic": bool(job.get("synthetic", True)),
        "job_id": job["id"],
        "source_system": {"name": "SuiteCRM", "version": insp["stack"]["framework_version"], "base_url": source_url,
                          "snapshot_taken_at": snapshot_taken_at},
        "default_currency": {"code": cfg.get("default_currency_iso4217") or "USD", "name": cfg.get("default_currency_name") or "US Dollars", "symbol": "$"},
        "stages": stages,
        "lead_statuses": options(lists.get("lead_status_dom")),
        "task_statuses": options(lists.get("task_status_dom")),
        "task_priorities": options(lists.get("task_priority_dom")),
        "account_types": options(lists.get("account_type_dom")),
        "industries": options(lists.get("industry_dom")),
        "lead_sources": options(lists.get("lead_source_dom")),
        "contact_roles": options(lists.get("opportunity_relationship_type_dom")),
        "approval_rule": ({"enabled": True, "threshold_usd": rule["threshold_usd"], "compares": rule["compares"], "won_stage": rule["won_stage"],
                           "fallback_stage": rule.get("fallback_stage") or "Negotiation/Review", "manager_role": rule["manager_role"],
                           "same_team_required": rule["same_team_required"], "admin_can_approve": rule["admin_can_approve"],
                           "withdraw_if_amount_exceeds_approved": rule["withdraw_if_amount_exceeds_approved"], "messages": rule["messages"],
                           "source": {"file": rule_f["evidence"][1]["file"], "lines": rule["lines"]}}
                          if rule else {"enabled": False}),
        "access": {"additive": bool(sec.get("securitysuite_additive", True)), "inherit_creator": bool(sec.get("securitysuite_inherit_creator", True)),
                   "inherit_assigned": bool(sec.get("securitysuite_inherit_assigned", True)), "inherit_parent": bool(sec.get("securitysuite_inherit_parent", True))},
        "lead_conversion": {"activities": facts["lead_conversion"]["lead_conv_activity_opt"] or "donothing",
                            "account_match": {"suggest_exact": "exact_suggest", "always_new": "always_new", "auto_exact": "exact_auto"}[
                                answers.get("Q-crm-match", "suggest_exact")],
                            "similar_threshold": 0.8, "default_contact_role": "Primary Decision Maker"},
        "custom_fields": custom,
        "renewal_window_days": 90,
        "external": {"record_url": source_url.rstrip("/") + "/index.php?module={module}&action=DetailView&record={id}"},
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--inspection", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--job", required=True, help="JSON: {id, customer, customer_short, synthetic}")
    ap.add_argument("--source-url", required=True)
    ap.add_argument("--snapshot-taken-at", default=None)
    ap.add_argument("--out-dir", required=True)
    a = ap.parse_args(argv)
    insp = json.loads(Path(a.inspection).read_text())
    plan = json.loads(Path(a.plan).read_text())
    job = json.loads(a.job)
    out = Path(a.out_dir)
    if out.exists():
        shutil.rmtree(out)
    tpl = Path(a.template)
    shutil.copytree(tpl, out, ignore=shutil.ignore_patterns("tests", "screens", "__pycache__", "*.pyc", ".pytest_cache", "config.example.json",
                                                             "node_modules", "*.mjs", "*.png"))
    cfg = build_config(insp, plan, job, a.source_url, a.snapshot_taken_at)
    (out / "config.json").write_text(json.dumps(cfg, indent=1))
    print(json.dumps({"out": str(out), "stages": len(cfg["stages"]), "approval_rule": cfg["approval_rule"].get("enabled"),
                      "custom_fields": [c["column"] for c in cfg["custom_fields"]]}))


if __name__ == "__main__":
    main()
