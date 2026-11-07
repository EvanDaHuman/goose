"""Turn an inspection, the customer's goal and their constraints into a plan: the options considered, the one
recommended and why, what changes, what is kept, what the customer must decide, and what it needs to run.

This is the DETERMINISTIC planner used in local mode (keyword rules over the goal, fixed recipe preconditions).
In naive mode the assessment agent writes the plan instead, and the same validate() guard checks it.

Usage:  python -m goose_engine.plan --inspection I --goal-file G --constraints C [--answers A] --mode local|naive --out plan.json
"""
import argparse
import re

from .util import emit, read_json, write_json

INTENTS = {
    "update": r"\b(update|upgrad\w*|supported|security|end of life|out of date|modern\w*|keep\w* (its |the )?(current )?behaviou?r)\b",
    "move_database": r"\b(move|migrat\w*|switch|transfer)\b.*\b(database|data|postgres\w*)\b|\bpostgres\w*\b",
    "replace_service": r"\b(replace|rewrite|rebuild|new service|existing connections|fastapi)\b",
    "fix": r"\b(fix\w*|bugs?|maintenance|tests?|clean ?up|technical debt|future development|double[- ]book\w*)\b",
}
CONSTRAINTS = {
    "keep_framework": "Keep the current web framework",
    "keep_database": "Keep the current database",
    "keep_api": "Pages and API responses must not change",
    "keep_connections": "Existing connections (clients, scripts) must keep working",
    "no_data": "Our data cannot be shared",
}
RECIPES = {
    "flask-fastapi-postgres": {
        "title": "Replace the Flask service with FastAPI on PostgreSQL", "work_type": "combined", "framework": "Flask",
        "executor": "tool", "needs_database": True, "changes_framework": True, "changes_database": True,
        "tool": "flask-to-fastapi codemod + SQLite-to-PostgreSQL data move",
    },
    "flask-inplace-upgrade": {
        "title": "Upgrade Flask and Python in place and keep the code and the SQLite data", "work_type": "code", "framework": "Flask",
        "executor": "tool", "needs_database": False, "changes_framework": False, "changes_database": False,
        "tool": "current Flask releases on Python 3.13 + mechanical rewrites of removed Flask APIs",
    },
    "django-lts-upgrade": {
        "title": "Upgrade to Django 5.2 LTS on Python 3.13 and keep everything else", "work_type": "code", "framework": "Django",
        "executor": "tool", "needs_database": False, "changes_framework": False, "changes_database": False,
        "tool": "django-upgrade rewrite + settings that keep current behaviour + Django migrations on a copy",
    },
    "suitecrm-sales-workspace": {
        "title": "Move the sales team to a new sales workspace and keep SuiteCRM for support and the rest", "work_type": "combined",
        "framework": "SuiteCRM", "executor": "tool", "needs_database": True, "changes_framework": True, "changes_database": True,
        "tool": "Goose sales-workspace template configured from the inspection + controlled MySQL-to-PostgreSQL data move",
    },
    "suitecrm-inplace-upgrade": {
        "title": "Upgrade SuiteCRM itself to 7.15 on PHP 8.4", "work_type": "code", "framework": "SuiteCRM",
        "executor": "none", "needs_database": True, "changes_framework": False, "changes_database": False,
        "tool": "(no verified recipe yet)",
    },
    "crm-full-replacement": {
        "title": "Replace all of SuiteCRM, every module at once", "work_type": "combined", "framework": "SuiteCRM",
        "executor": "none", "needs_database": True, "changes_framework": True, "changes_database": True,
        "tool": "(not offered: not a bounded job)",
    },
    "agent-change": {
        "title": "Targeted code changes by the implementation agent", "work_type": "code", "framework": None,
        "executor": "agent", "needs_database": False, "changes_framework": False, "changes_database": False,
        "tool": "implementation agent on Naive, checked by the same frozen checks",
    },
}


def read_goal(text):
    t = (text or "").lower()
    hits = {k: sorted({m.group(0) for m in re.finditer(p, t)}) for k, p in INTENTS.items()}
    return {k: v for k, v in hits.items() if v}


def comps(insp, kind=None, prefix=None):
    return [c for c in insp["components"] if (not kind or c["kind"] == kind) and (not prefix or c["id"].startswith(prefix))]


def finding(insp, fid):
    return next((f for f in insp["findings"] if f["id"] == fid), None)


def findings_titled(insp, pattern):
    return [f for f in insp["findings"] if re.search(pattern, f["title"], re.I)]


def preconditions(insp, rid, mode):
    """Why a recipe cannot run on this application now (empty list = it can)."""
    r, st, facts = RECIPES[rid], insp["stack"], insp.get("facts") or {}
    out = []
    if r["framework"] and st["framework"] != r["framework"]:
        out.append(f"only for {r['framework']} applications")
        return out
    if r["framework"] == "SuiteCRM":
        if r["executor"] == "none":
            out.append("no verified recipe for this yet")
        unknown = [f for f in insp.get("findings", []) if f["id"].startswith("F-crm-hook-")]
        if rid == "suitecrm-sales-workspace" and unknown and mode != "naive":
            out.append(f"{len(unknown)} custom rule(s) we cannot interpret automatically need the live agent team")
        if r["needs_database"] and not st["database"]["copy_supplied"]:
            out.append("needs a copy of your database")
        return out
    if r["executor"] == "agent" and mode != "naive":
        out.append("needs the live agent team on Naive (this run is local mode, with no AI model)")
    if r["framework"] == "Flask":
        if facts.get("unsupported_imports"):
            out.append("uses " + ", ".join(facts["unsupported_imports"]) + ", which this tool does not convert")
        if not facts.get("routes"):
            out.append("no JSON routes found")
        if st["database"]["engine"] not in ("sqlite", None):
            out.append("database is not SQLite")
    if r["framework"] == "Django":
        major = tuple(int(x) for x in (st.get("framework_version") or "0.0").split(".")[:2])
        if major >= (5, 2):
            out.append("already on Django 5.2 or later")
        manual = [h for h in facts.get("removals") or [] if not h["auto_fix"]]
        if manual and mode != "naive":
            out.append(f"{len(manual)} place(s) need hand-written changes ({', '.join(sorted({h['api'] for h in manual}))}), "
                       "which need the live implementation agent")
    if r["needs_database"] and not st["database"]["copy_supplied"]:
        out.append("needs a copy of your database")
    return out


def score(rid, intents, constraints):
    r = RECIPES[rid]
    s = 0
    if "move_database" in intents and r["changes_database"]:
        s += 3
    if "replace_service" in intents and r["changes_framework"]:
        s += 3
    if "update" in intents and rid in ("django-lts-upgrade", "flask-fastapi-postgres", "flask-inplace-upgrade"):
        s += 2
    if rid == "flask-inplace-upgrade" and "update" in intents and "replace_service" not in intents:
        s += 1          # the smallest change that reaches supported versions
    if "fix" in intents and rid == "agent-change":
        s += 3
    if r["changes_framework"] and ("keep_framework" in constraints or "keep_api" in constraints):
        s -= 6
    if r["changes_database"] and "keep_database" in constraints:
        s -= 6
    return s


def preserve_list(insp, rid):
    r = RECIPES[rid]
    st = insp["stack"]
    keep = []
    if not r["changes_framework"]:
        keep.append({"what": f"{st['framework']} and your application code", "reason": "The goal does not need a new framework; "
                     "changing less keeps the risk and the review small.", "component_ids": ["runtime:python"]})
    if not r["changes_database"]:
        keep.append({"what": f"Your {'SQLite' if st['database']['engine'] == 'sqlite' else st['database']['engine'] or ''} database, schema and data".replace("  ", " "),
                     "reason": "Nothing in the goal needs the data to move.", "component_ids": ["db:main"]})
    routes = comps(insp, "route")
    if routes and rid != "flask-fastapi-postgres":
        keep.append({"what": f"All {len(routes)} addresses (URLs) and what they return",
                     "reason": "Outside clients depend on them.", "component_ids": [c["id"] for c in routes]})
    elif routes:
        keep.append({"what": f"All {len(routes)} endpoint addresses and JSON shapes", "reason": "Outside clients depend on them; "
                     "the few agreed differences are listed separately.", "component_ids": [c["id"] for c in routes]})
    for c in comps(insp, "client") + comps(insp, "script"):
        if c["kind"] == "script" and r["changes_database"]:
            continue
        keep.append({"what": c["summary"][:140], "reason": "An existing connection found during inspection; it must keep working.",
                     "component_ids": [c["id"]]})
    return keep


def changes_for(insp, rid):
    st, facts = insp["stack"], insp.get("facts") or {}
    out = []
    if rid == "django-lts-upgrade":
        rm = facts.get("removals") or []
        files = sorted({h["file"] for h in rm})
        out.append({"id": "C-django-version", "title": f"Django {st['framework_version']} to 5.2 LTS, Python {st['python'] or '3.9'} to 3.13",
                    "reason": "Django 3.2 and Python 3.9 no longer receive security fixes; 5.2 is supported until April 2028.",
                    "kind": "dependencies", "files": ["requirements.txt", "runtime.txt"], "component_ids": ["runtime:python"],
                    "finding_ids": [f["id"] for f in findings_titled(insp, r"end of life|no longer receives")]})
        if rm:
            out.append({"id": "C-removed-apis", "title": f"Rewrite {len(rm)} uses of removed Django features",
                        "reason": "They would stop the app from starting on Django 5.2. Rewritten mechanically (django-upgrade).",
                        "kind": "code", "files": files, "component_ids": sorted({c for f in [finding(insp, 'F-django-removed')] if f for c in f["component_ids"]}),
                        "finding_ids": ["F-django-removed"]})
        if finding(insp, "F-use-tz"):
            out.append({"id": "C-keep-use-tz", "title": "Set USE_TZ = False explicitly",
                        "reason": "Django 5.0 changed the default to True, which would shift every stored appointment time. Setting it "
                        "keeps times exactly as they are today.", "kind": "config", "files": [finding(insp, "F-use-tz")["evidence"][0]["file"]],
                        "component_ids": ["db:main"], "finding_ids": ["F-use-tz"]})
        out.append({"id": "C-migrations", "title": "Record the model changes as a Django migration and apply it to a copy",
                    "reason": "Rewriting a removed field type changes Django's record of the model; the migration is checked on a copy "
                    "of your data so no row changes.", "kind": "data", "files": ["*/migrations/"], "component_ids": [c["id"] for c in comps(insp, "table")],
                    "finding_ids": []})
        if finding(insp, "F-use-l10n"):
            out.append({"id": "C-drop-use-l10n", "title": "Remove the USE_L10N setting", "reason": "It no longer exists in Django 5.",
                        "kind": "config", "files": [insp["facts"]["settings_file"]], "component_ids": [], "finding_ids": ["F-use-l10n"]})
    elif rid == "flask-inplace-upgrade":
        pins = insp.get("pins") or {}
        out.append({"id": "C-flask-version", "title": f"Flask {pins.get('flask', '?')} to the current release, Python {st['python'] or '3.9'} to 3.13",
                    "reason": "The pinned Flask, Werkzeug and Jinja releases and Python 3.9 no longer receive fixes. Upgrading in place keeps "
                    "every route, query and response as it is.", "kind": "dependencies", "files": ["requirements.txt", "runtime.txt"],
                    "component_ids": ["runtime:python"], "finding_ids": [f["id"] for f in findings_titled(insp, r"behind|end of life")]})
        out.append({"id": "C-flask-removed", "title": "Rewrite any Flask APIs removed since 1.1", "reason": "Only where a mechanical "
                    "replacement exists; anything else is listed for the implementation agent.", "kind": "code",
                    "files": sorted({c["file"] for c in comps(insp, "function") if c["file"]}), "component_ids": [], "finding_ids": []})
    elif rid == "flask-fastapi-postgres":
        out.append({"id": "C-scope", "title": "Full scope from the conversion playbook (listed in the proposal)", "reason": "The goal "
                    "asks for a replacement service; the proposal lists each change and difference.", "kind": "code",
                    "files": [], "component_ids": [], "finding_ids": []})
    elif rid == "agent-change":
        for f in insp["findings"]:
            if f["severity"] == "high" and f["area"] in ("code", "data") and f["id"] not in ("F-django-removed", "F-use-tz"):
                out.append({"id": f"C-fix-{f['id']}", "title": f"Fix: {f['title']}", "reason": f["detail"][:220], "kind": "code",
                            "files": sorted({e["file"] for e in f["evidence"] if e.get("file")}), "component_ids": f["component_ids"],
                            "finding_ids": [f["id"]]})
    return out


def follow_ups(insp, rid, changes):
    covered = {fid for c in changes for fid in c["finding_ids"]}
    if rid == "flask-fastapi-postgres":
        covered |= {"F5", "F6", "F7", "F8", "F9", "F10", "F11", "F16", "F17"}   # handled by the conversion playbook
    out = []
    for f in insp["findings"]:
        if f["id"] in covered or f["severity"] not in ("high", "medium"):
            continue
        behaviour = f["area"] in ("code", "data") and f["severity"] == "high"
        out.append({"finding_id": f["id"], "title": f["title"], "why_not_now": (
            "It changes what the app does, so it needs your approval as a separate change." if behaviour else
            "Outside the goal of this job; we can quote it separately.")})
    return out


def acceptance(insp, rid):
    routes, tables = comps(insp, "route"), comps(insp, "table")
    rows = sum(c["attrs"].get("rows") or 0 for c in tables)
    checks = []
    if rid == "flask-fastapi-postgres":
        return [{"id": "A-playbook", "text": "The 11-item acceptance checklist in the proposal", "mandatory": True}]
    checks.append({"id": "A-same-responses", "text": f"Every request in the recorded scenario gets the same answer as today "
                   f"({len(routes)} addresses)", "mandatory": True})
    seen = set()
    for c in comps(insp, "client"):
        target = next((e["to"] for e in insp["edges"] if e["from"] == c["id"] and e["to"].startswith("route:")), None)
        if target and target not in seen:
            seen.add(target)
            checks.append({"id": f"A-client-{len(checks)}", "text": f"{target.split(' ', 1)[-1]} returns exactly what its client reads today",
                           "mandatory": True})
    if rows:
        checks.append({"id": "A-rows", "text": f"All {rows:,} rows arrive unchanged" + (" in PostgreSQL" if RECIPES[rid]["changes_database"] else
                       " after the migrations"), "mandatory": True})
    for s in comps(insp, "script"):
        if not RECIPES[rid]["changes_database"]:
            checks.append({"id": f"A-script-{len(checks)}", "text": f"{s['file']} still runs against the database", "mandatory": True})
    if comps(insp, "test"):
        checks.append({"id": "A-own-tests", "text": "Your own automated tests pass on the upgraded app", "mandatory": True})
    if rid == "django-lts-upgrade":
        checks.append({"id": "A-django-check", "text": "Django's system check reports no errors on 5.2", "mandatory": True})
        checks.append({"id": "A-no-pending", "text": "No model change is left without a migration", "mandatory": True})
    if RECIPES[rid]["changes_database"]:
        checks.append({"id": "A-retry", "text": "Running the data move twice creates no duplicates", "mandatory": True})
    checks.append({"id": "A-clean-start", "text": "The upgraded app installs from scratch and starts", "mandatory": True})
    return checks


def differences(insp, rid):
    out = []
    if rid == "flask-inplace-upgrade":
        # found by verification (job GS-1015): Werkzeug 3 changed the markup of its built-in error pages
        out.append({"id": "D-error-pages", "title": "Built-in 'Not Found' pages use newer HTML",
                    "reason": "Werkzeug 3 writes its default error page with a modern HTML header. Pages and JSON your app returns "
                    "itself are unchanged; only addresses the app does not handle show the new markup."})
    if rid == "agent-change" and finding(insp, "F-double-booking"):
        out.append({"id": "D-double-booking", "title": "Booking a slot that is already booked is refused",
                    "reason": "This is the requested fix. The page says the slot is taken and no second booking is saved. Every other request "
                    "answers as today, every other row stays the same, and the bookings that are already doubled stay as they are."})
    if rid == "flask-postgres-dbswap" and findings_titled(insp, r"LIKE"):
        out.append({"id": "D-unicode-search", "title": "Search also ignores case for accented letters",
                    "reason": "PostgreSQL's ILIKE treats É like é; SQLite only did that for A-Z. Matching A-Z is unchanged."})
    return out


def questions(insp, rid):
    qs = []
    if RECIPES[rid]["needs_database"]:
        for q in (insp.get("facts") or {}).get("questions") or []:
            qs.append(q)
    if RECIPES[rid]["framework"] == "SuiteCRM":
        return qs
    if rid == "agent-change" and finding(insp, "F-double-booking") and (finding(insp, "F-double-booking").get("data_rows") or 0) > 0:
        qs.append({"id": "Q-existing-double-bookings", "to": "customer", "blocking": True,
                   "prompt": f"{finding(insp, 'F-double-booking')['data_rows']} slots already have two active bookings. When we stop new "
                   "double bookings, what should happen to these?",
                   "fields": [{"type": "choice", "key": "decision", "label": "Decision", "options": ["keep_both", "keep_earliest"]}],
                   "options_help": {"keep_both": "Recommended. Leave them as they are and list them for reception to call.",
                                    "keep_earliest": "Keep the earliest booking and cancel the later one in each pair."},
                   "recommended": "keep_both"})
    return qs


def build(insp, goal, constraints, answers, mode):
    intents = read_goal(goal)
    if not intents:
        intents = {"update": ["(no clear goal: assumed an update that keeps behaviour)"]}
    st = insp["stack"]
    if st.get("framework") == "SuiteCRM":
        from .suitecrm.plan import build as crm_build
        return crm_build(insp, goal, constraints, answers, mode, RECIPES)
    if not st["framework"]:
        langs = ", ".join(f"{k} ({v['files']} files)" for k, v in st["languages"].items()) or "no recognised source files"
        return {"decision": "unsupported", "goal_reading": intents, "constraints": constraints, "recommended": None, "options": [],
                "reasons": [f"We read the code ({langs}) but can only plan and verify work on Python web apps built with Flask or Django today."],
                "work_type": None}
    options = []
    for rid, r in RECIPES.items():
        if r["framework"] not in (None, st["framework"]):
            continue
        blocked = preconditions(insp, rid, mode)
        options.append({"recipe": rid, "title": r["title"], "work_type": r["work_type"], "executor": r["executor"], "tool": r["tool"],
                        "score": score(rid, intents, constraints), "blocked_by": blocked, "executable_now": not blocked,
                        "needs_database": r["needs_database"], "changes_framework": r["changes_framework"],
                        "changes_database": r["changes_database"]})
    options.sort(key=lambda o: (-o["score"], not o["executable_now"]))
    fitting = [o for o in options if o["score"] > 0]
    if st["framework"] == "Flask" and "move_database" in intents and "keep_framework" in constraints and not any(o["changes_database"] for o in fitting):
        return {"decision": "unsupported", "goal_reading": intents, "constraints": constraints, "recommended": None, "options": options,
                "reasons": ["Moving the database to PostgreSQL while keeping the Flask app is not something we can carry out and verify yet. "
                            "We can replace the service with FastAPI on PostgreSQL (which changes the framework), or upgrade Flask in place "
                            "and keep SQLite."], "work_type": None}
    if not fitting:
        return {"decision": "unsupported", "goal_reading": intents, "constraints": constraints, "recommended": None, "options": options,
                "reasons": ["None of the upgrades we can carry out today matches this goal for a "
                            f"{st['framework']} application. " + ("Moving a Django database is not supported yet." if
                                                                   st["framework"] == "Django" and "move_database" in intents else "")],
                "work_type": None}
    best = fitting[0]
    rid = best["recipe"]
    for o in options:
        o["why"] = why(o, best, intents, constraints)
    chg = changes_for(insp, rid)
    qs = [q for q in questions(insp, rid) if q["id"] not in (answers or {})]
    blocking = [q for q in qs if q.get("blocking")]
    needs_db_only = best["blocked_by"] == ["needs a copy of your database"]
    decision = ("needs_information" if blocking or needs_db_only else
                "needs_live_agents" if best["executor"] == "agent" and mode != "naive" else
                "supported" if best["executable_now"] else "blocked")
    st_db = st["database"]
    return {
        "decision": decision, "goal_reading": intents, "constraints": constraints, "recommended": rid, "title": best["title"],
        "work_type": best["work_type"], "options": options, "changes": chg, "preserve": preserve_list(insp, rid),
        "intended_differences": differences(insp, rid), "acceptance_checks": acceptance(insp, rid), "questions": qs,
        "follow_ups": follow_ups(insp, rid, chg), "blocked_by": best["blocked_by"],
        "database_use": ("moves to PostgreSQL" if best["changes_database"] else
                         "a copy is used only for checks" if st_db["copy_supplied"] else
                         "not needed: checks run on a test database built from your migrations"),
        "requires_database": best["needs_database"],
        "reasons": [best["why"]] + ([] if st_db["copy_supplied"] or best["needs_database"] else [
            "Without a copy of your data the checks run on an empty test database, so flows that need existing records may not be "
            "exercised; the coverage check then blocks delivery. A copy, or a small sample, gives stronger proof."]),
    }


def why(o, best, intents, constraints):
    if o["recipe"] == best["recipe"]:
        bits = [f"Matches your goal ({', '.join(sorted(intents))})"]
        if not o["changes_framework"]:
            bits.append("keeps your framework")
        if not o["changes_database"]:
            bits.append("keeps your database")
        if o["blocked_by"]:
            bits.append("but " + "; ".join(o["blocked_by"]))
        return "; ".join(bits) + "."
    if o["score"] <= 0:
        clash = [CONSTRAINTS[c] for c in constraints if (c in ("keep_framework", "keep_api") and o["changes_framework"]) or
                 (c == "keep_database" and o["changes_database"])]
        return ("Conflicts with: " + "; ".join(clash) + ".") if clash else "Does more than your goal asks."
    return "Also possible, but a bigger change than the recommended option." + (f" Needs: {'; '.join(o['blocked_by'])}." if o["blocked_by"] else "")


def validate(plan, insp, mode):
    """Guard applied to every plan, whoever wrote it: unknown recipes, missing preconditions, files or components that do not
    exist, and work the recipe cannot do all make the plan invalid."""
    problems = []
    ids = {c["id"] for c in insp["components"]}
    rid = plan.get("recommended")
    if plan.get("decision") == "unsupported":
        return problems
    if rid not in RECIPES:
        return [f"unknown recipe {rid!r}"]
    pre = preconditions(insp, rid, mode)
    if plan.get("decision") == "supported" and pre:
        problems.append("recipe preconditions not met: " + "; ".join(pre))
    for ch in plan.get("changes") or []:
        for cid in ch.get("component_ids") or []:
            if cid not in ids:
                problems.append(f"change {ch.get('id')} names a component that inspection did not find: {cid}")
    known_files = {c["file"] for c in insp["components"] if c.get("file")} | {e.get("file") for f in insp["findings"] for e in f["evidence"] if e.get("file")}
    for ch in plan.get("changes") or []:
        if ch.get("by") == "agent" and mode != "naive":
            problems.append(f"change {ch.get('id')} needs the implementation agent, which is not running in local mode")
    for f in plan.get("findings_added") or []:
        if f.get("file") and f["file"] not in known_files and not any(k and k.endswith(f["file"]) for k in known_files):
            problems.append(f"finding \"{f.get('title')}\" cites a file inspection did not see: {f['file']}")
    if RECIPES[rid]["needs_database"] and not insp["stack"]["database"]["copy_supplied"] and plan.get("decision") == "supported":
        problems.append("the recipe moves data but no database copy was supplied")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inspection", required=True)
    ap.add_argument("--validate", help="check a plan file instead of writing one")
    ap.add_argument("--goal-file")
    ap.add_argument("--constraints")
    ap.add_argument("--answers")
    ap.add_argument("--mode", default="local")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    insp = read_json(a.inspection)
    if a.validate:
        problems = validate(read_json(a.validate), insp, a.mode)
        write_json(a.out, {"guard_problems": problems})
        emit("plan.validated", problems=len(problems))
        return
    goal = open(a.goal_file).read()
    constraints = read_json(a.constraints)
    answers = read_json(a.answers) if a.answers else {}
    plan = build(insp, goal, constraints, answers, a.mode)
    plan["author"] = {"kind": "tool", "name": "deterministic planner (keyword rules + recipe preconditions)", "model": None}
    plan["guard_problems"] = validate(plan, insp, a.mode)
    write_json(a.out, plan)
    emit("plan.done", decision=plan["decision"], recommended=plan.get("recommended"), changes=len(plan.get("changes") or []),
         questions=len(plan.get("questions") or []))


if __name__ == "__main__":
    main()
