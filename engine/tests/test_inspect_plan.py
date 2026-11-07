"""Inspection builds the map from the code and data; the planner's answer depends on the goal; the guard catches invented parts."""
import json
import shutil
from pathlib import Path

from goose_engine import inspect_app, plan

from conftest import CLINIC, ORDERS


def clinic():
    return inspect_app.inspect(CLINIC / "repo", str(CLINIC / "data" / "clinic.db"), today="2026-11-04")


def orders(tmp_path):
    shutil.copytree(ORDERS / "repo", tmp_path / "repo")
    latest = json.loads((Path(__file__).resolve().parents[1] / "data" / "pypi_latest.json").read_text())["versions"]
    insp = inspect_app.inspect(tmp_path / "repo", str(ORDERS / "data" / "orders.db"), "America/Chicago", None, "2026-11-04")
    return insp, latest


def test_clinic_map_and_findings_come_from_the_code_and_data():
    insp = clinic()
    assert insp["stack"]["framework"] == "Django" and insp["stack"]["framework_version"] == "3.2.25"
    kinds = [c["kind"] for c in insp["components"]]
    assert kinds.count("route") == 7 and kinds.count("table") == 4 and "script" in kinds
    f = {x["id"]: x for x in insp["findings"]}
    assert f["F-double-booking"]["data_rows"] == 7
    assert any(e.get("file") == "bookings/views.py" for e in f["F-double-booking"]["evidence"])
    assert "F-use-tz" in f and f["F-django-removed"]["severity"] == "high"


def test_goal_decides_the_plan():
    insp = clinic()
    up = plan.build(insp, "Update this application to a supported version while keeping its current behaviour.", ["keep_database"], {}, "local")
    assert up["decision"] == "supported" and up["recommended"] == "django-lts-upgrade" and up["work_type"] == "code"
    assert any(c["id"] == "C-keep-use-tz" for c in up["changes"])
    move = plan.build(insp, "Move our booking database to PostgreSQL.", [], {}, "local")
    assert move["decision"] == "unsupported"
    fix = plan.build(insp, "Fix the double booking problem.", [], {}, "local")
    assert fix["decision"] in ("needs_information", "needs_live_agents") and fix["recommended"] == "agent-change"


def test_same_flask_app_three_goals(tmp_path):
    insp, _ = orders(tmp_path)
    inplace = plan.build(insp, "Update this application while keeping its current behaviour.", ["keep_database", "keep_api"], {}, "local")
    assert inplace["recommended"] == "flask-inplace-upgrade" and inplace["decision"] == "supported"
    replace = plan.build(insp, "Replace this old service while preserving its existing connections.", ["keep_connections"], {}, "local")
    assert replace["recommended"] == "flask-fastapi-postgres" and replace["requires_database"]
    keep = plan.build(insp, "Move our database to PostgreSQL without changing the app.", ["keep_framework"], {}, "local")
    assert keep["decision"] == "unsupported"


def test_guard_rejects_invented_components_and_agent_work_in_local_mode():
    insp = clinic()
    p = plan.build(insp, "Update while keeping behaviour.", [], {}, "local")
    p["changes"].append({"id": "C-x", "title": "x", "component_ids": ["route:GET /does-not-exist"], "by": "agent"})
    problems = plan.validate(p, insp, "local")
    assert any("did not find" in x for x in problems) and any("implementation agent" in x for x in problems)
