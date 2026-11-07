"""SuiteCRM tools: the custom-rule reader, name matching, the planner and the dump check at intake."""
import gzip
import json
from pathlib import Path

from goose_engine import intake, plan
from goose_engine.suitecrm.inspect import analyse_hook, norm_name

ROOT = Path(__file__).resolve().parents[2]
INSP = json.loads((Path(__file__).parent / "fixtures" / "suitecrm-inspection.json").read_text())
GOAL = ("Our sales team needs a modern workspace for managing customers and deals. Preserve our customer history, record relationships, "
        "renewal dates, approval rule, and agreed access restrictions.")


def test_reads_the_approval_rule_with_its_lines():
    a = analyse_hook(Path(__file__).parent / "fixtures" / "suitecrm-hook", "custom/modules/Opportunities/DealApproval.php")
    r = a["rule"]
    assert a["recognised_as"] == "approval_rule"
    assert r["threshold_usd"] == 25000 and r["compares"] == "amount_usdollar" and r["won_stage"] == "Closed Won"
    assert r["manager_role"] == "Sales Manager" and r["same_team_required"] and r["withdraw_if_amount_exceeds_approved"]
    assert r["fallback_stage"] == "Negotiation/Review"
    assert r["messages"]["blocked"].startswith("Deals above $25,000")
    assert all(isinstance(v, int) for v in r["lines"].values())


def test_look_alike_names_normalise_together():
    assert norm_name("St. Mary's Clinic").replace(" ", "") == norm_name("Saint Marys Clinic").replace(" ", "")
    assert norm_name("ACME Supply Co.") == norm_name("Acme Supply")
    assert norm_name("Acme Supplies Ltd") != norm_name("Acme Supply")


def test_plan_asks_first_then_is_supported():
    p = plan.build(INSP, GOAL, [], {}, "local")
    assert p["recommended"] == "suitecrm-sales-workspace" and p["decision"] == "needs_information"
    assert {q["id"] for q in p["questions"] if q["blocking"]} == {"Q-crm-match", "Q-crm-new-accounts", "Q-crm-signin"}
    answers = {q: {"decision": d} for q, d in (("Q-crm-match", "suggest_exact"), ("Q-crm-new-accounts", "manual"), ("Q-crm-signin", "keep"))}
    p = plan.build(INSP, GOAL, [], answers, "local")
    assert p["decision"] == "supported" and not plan.validate(p, INSP, "local")
    assert sum(x["usd"] for x in p["price_lines"]) == 5600
    assert any(b["from"] == "Cases" and b["to"] == "Accounts" for b in p["boundary"])
    assert {o["recipe"]: o["executable_now"] for o in p["options"]} == {
        "suitecrm-sales-workspace": True, "suitecrm-inplace-upgrade": False, "crm-full-replacement": False}


def test_a_goal_outside_the_sales_workflow_is_not_quoted():
    p = plan.build(INSP, "Upgrade SuiteCRM and PHP to supported versions.", [], {}, "local")
    assert p["decision"] == "unsupported" and p["recommended"] is None


def test_intake_accepts_a_mysqldump(tmp_path):
    f = tmp_path / "db.sql.gz"
    with gzip.open(f, "wt") as g:
        g.write("-- MariaDB dump 10.19  Distrib 10.3.39-MariaDB\n--\nCREATE TABLE `accounts` (id char(36));\nINSERT INTO `accounts` VALUES ('1');\n")
    problems, info = intake.check_db(f)
    assert not problems and info["kind"] == "mysqldump" and info["tables"] == 1
