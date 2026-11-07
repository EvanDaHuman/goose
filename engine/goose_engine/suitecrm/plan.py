"""Plan for a SuiteCRM 7 application, from its inspection, the customer's goal, their constraints and their answers.

DETERMINISTIC planner (local mode): keyword rules over the goal plus what inspection found. In naive mode the assessment
agent writes the plan and the same guard (plan.validate) checks it. Every change, kept item, boundary dependency and question
points at inspection components or findings, so the customer can see where each part of the plan comes from.
"""
import re

SALES = ["Accounts", "Contacts", "Leads", "Opportunities", "Notes", "Tasks"]
NAMES = {"Accounts": "accounts", "Contacts": "contacts", "Leads": "leads", "Opportunities": "deals", "Notes": "notes", "Tasks": "tasks"}


def _f(insp, fid):
    return next((x for x in insp["findings"] if x["id"] == fid), None)


def _ids(insp, prefix):
    return [c["id"] for c in insp["components"] if c["id"].startswith(prefix)]


def read_goal(goal):
    t = (goal or "").lower()
    return {
        "workspace": bool(re.search(r"workspace|modern|new (screens?|interface|app|tool)|easier|replace|rebuild", t)),
        "sales": bool(re.search(r"sales|deals?|pipeline|customers?|leads?|opportunit|accounts?", t)),
        "support": bool(re.search(r"support|cases?|tickets?|helpdesk", t)),
        "marketing": bool(re.search(r"campaigns?|marketing|newsletters?", t)),
        "inplace": bool(re.search(r"upgrade (suitecrm|php)|php ?8|supported version|security (fixes|updates|support)|keep (using )?suitecrm", t)),
        "move_database": bool(re.search(r"\b(move|migrat\w*)\b.*\bdatabase\b|postgres", t)),
        "preserve": [w for w in ("history", "relationships", "renewal", "approval", "access", "permissions", "data") if w in t],
    }


QUESTIONS = {
    "Q-crm-match": {
        "prompt": "When a salesperson converts a lead whose company name matches an existing account, what should happen?",
        "options": ["suggest_exact", "always_new", "auto_exact"],
        "options_help": {
            "suggest_exact": "Recommended. Suggest the account whose name matches exactly (ignoring case and spacing); the salesperson confirms. "
                             "Look-alike names are shown as a warning and never linked automatically.",
            "always_new": "Always create a new account; duplicates are cleaned up by hand.",
            "auto_exact": "Link to an exact match automatically, without asking."},
        "recommended": "suggest_exact", "blocking": True, "finding": "F-crm-similar-names"},
    "Q-crm-new-accounts": {
        "prompt": "Support keeps opening cases in SuiteCRM, which needs the account to exist there. Customers created in the new workspace "
                  "will not be in SuiteCRM. What should we do?",
        "options": ["manual", "sync_followup"],
        "options_help": {
            "manual": "Recommended for this job. Support adds the account in SuiteCRM when a new customer first needs a case.",
            "sync_followup": "Add a one-way copy of new and changed accounts to SuiteCRM. A separate, quoted follow-up, not in this price."},
        "recommended": "manual", "blocking": True, "finding": "F-crm-boundary"},
    "Q-crm-signin": {
        "prompt": "How should the sales team sign in to the new workspace?",
        "options": ["keep", "reset"],
        "options_help": {
            "keep": "Recommended. Keep their current SuiteCRM passwords: the workspace checks SuiteCRM's stored password hashes, nobody resets anything.",
            "reset": "Everyone sets a new password on first sign-in."},
        "recommended": "keep", "blocking": True, "finding": "F-crm-access"},
    "Q-crm-support": {
        "prompt": "Should the support desk (role Support) also get access to the new sales workspace?",
        "options": ["stay", "readonly"],
        "options_help": {
            "stay": "Recommended. Support keeps working in SuiteCRM, which still shows accounts and contacts as they were at the switch.",
            "readonly": "Give support read-only access to accounts and contacts in the workspace too."},
        "recommended": "stay", "blocking": False, "finding": "F-crm-access"},
    "Q-crm-inactive": {
        "prompt": "Some records belong to users who have left. Keep them assigned to those users, as SuiteCRM does?",
        "options": ["keep", "reassign"],
        "options_help": {
            "keep": "Recommended. Keep the owner; the team still sees the records, and history stays accurate.",
            "reassign": "Reassign them to the team's manager during the move."},
        "recommended": "keep", "blocking": False, "finding": "F-crm-inactive-owner"},
}


def _question(insp, qid):
    q = QUESTIONS[qid]
    f = _f(insp, q["finding"])
    return {"id": qid, "to": "customer", "blocking": q["blocking"], "prompt": q["prompt"],
            "fields": [{"type": "choice", "key": "decision", "label": "Decision", "options": q["options"]}],
            "options_help": q["options_help"], "recommended": q["recommended"], "because": f["title"] if f else None}


def _answer(answers, qid):
    a = (answers or {}).get(qid)
    if isinstance(a, dict):
        return a.get("decision")
    return a


def build(insp, goal, constraints, answers, mode, recipes):
    g = read_goal(goal)
    facts = insp["facts"]
    counts = facts["module_counts"]
    rule_f = _f(insp, "F-crm-approval-rule")
    rule = (rule_f or {}).get("rule")
    renewal = _f(insp, "F-crm-renewal-field")
    unknown_hooks = [x for x in insp["findings"] if x["id"].startswith("F-crm-hook-")]
    options = []

    def option(rid, why, blocked):
        r = recipes[rid]
        options.append({"recipe": rid, "title": r["title"], "work_type": r["work_type"], "executor": r["executor"], "tool": r["tool"],
                        "score": 0, "blocked_by": blocked, "executable_now": not blocked, "needs_database": r["needs_database"],
                        "changes_framework": r["changes_framework"], "changes_database": r["changes_database"], "why": why})

    ws_blocked = []
    if unknown_hooks and mode != "naive":
        ws_blocked.append(f"{len(unknown_hooks)} custom rule(s) we cannot interpret automatically need the live agent team")
    if not insp["stack"]["database"]["copy_supplied"]:
        ws_blocked.append("needs a copy of your database")
    stays = [m for m, c in counts.items() if m not in SALES and c["rows"]]
    option("suitecrm-sales-workspace",
           "Matches your goal: a modern workspace for the sales team, with the data, the relationships, the renewal dates, the approval rule and the "
           f"access rules carried over. Support ({', '.join(stays)}) keeps running in SuiteCRM, so the change stays bounded.",
           ws_blocked)
    option("suitecrm-inplace-upgrade",
           "Would make SuiteCRM supported again (7.15 on PHP 8.4) but keeps the screens your team wants to leave. We have no verified recipe for "
           "SuiteCRM upgrades yet, so we would not quote it.", ["no verified recipe for upgrading SuiteCRM itself yet"])
    option("crm-full-replacement",
           f"Replacing every module, including support cases, calendar and the {len(facts.get('unused_modules', []))} unused modules, is far more than "
           "the goal asks and much riskier to switch at once.", ["not a bounded job: we only take on work we can verify end to end"])
    for o in options:
        o["score"] = (3 if o["recipe"] == "suitecrm-sales-workspace" and (g["workspace"] or g["sales"]) else
                      2 if o["recipe"] == "suitecrm-inplace-upgrade" and g["inplace"] else 0)
    options.sort(key=lambda o: -o["score"])
    best = options[0]
    if best["score"] == 0:
        return {"decision": "unsupported", "goal_reading": g, "constraints": constraints, "recommended": None, "options": options, "work_type": None,
                "reasons": ["We read the whole SuiteCRM installation, but the only SuiteCRM job we can carry out and verify today is moving the "
                            "sales workflow (accounts, contacts, leads, deals, notes, tasks) to a new workspace."]}
    if best["recipe"] != "suitecrm-sales-workspace":
        return {"decision": "unsupported", "goal_reading": g, "constraints": constraints, "recommended": None, "options": options, "work_type": None,
                "reasons": [best["why"]]}

    sales_ids = [f"mod:{m}" for m in SALES]
    rel = facts["relationships"]
    notes_sales = sum(n for k, n in rel["notes_by_parent"].items() if k in SALES or k == "(none)")
    tasks_sales = sum(n for k, n in rel["tasks_by_parent"].items() if k in SALES or k == "(none)")
    audit_rows = sum(rel["audit"].values())
    match = _answer(answers, "Q-crm-match") or QUESTIONS["Q-crm-match"]["recommended"]
    signin = _answer(answers, "Q-crm-signin") or QUESTIONS["Q-crm-signin"]["recommended"]
    support = _answer(answers, "Q-crm-support") or QUESTIONS["Q-crm-support"]["recommended"]
    inactive = _answer(answers, "Q-crm-inactive") or QUESTIONS["Q-crm-inactive"]["recommended"]
    new_accts = _answer(answers, "Q-crm-new-accounts") or QUESTIONS["Q-crm-new-accounts"]["recommended"]

    changes = [
        {"id": "C-crm-workspace", "title": "A new sales workspace for accounts, contacts, leads, deals, notes and tasks", "by": "tool",
         "reason": "Your goal: a modern place for the sales team to manage customers and deals. Search, customer pages with their history, a "
                   "pipeline, lead conversion, manager approvals, creating and editing records.", "component_ids": sales_ids + ["ui:web"]},
        {"id": "C-crm-data", "title": f"Move {sum(counts[m]['rows'] for m in SALES):,} sales records and their links in a controlled snapshot", "by": "tool",
         "reason": "Customer history and relationships must survive: every record keeps its SuiteCRM id, owner, team, dates and links. "
                   f"{sum(facts['deleted_records'].values())} soft-deleted records stay behind.",
         "component_ids": [c for c in _ids(insp, "table:")] + ["db:main"]},
        {"id": "C-crm-approval", "title": "Carry the approval rule over exactly as it works today", "by": "tool",
         "reason": (f"Found in {rule_f['evidence'][1]['file'] if rule_f else 'custom code'}: deals above ${rule['threshold_usd']:,.0f} (US-dollar value) "
                    f"need approval from a '{rule['manager_role']}' on the same team before '{rule['won_stage']}'. Enforced in the workspace's backend, "
                    "so it cannot be skipped by a direct request." if rule else "No approval rule found."),
         "component_ids": _ids(insp, "rule:") + [c for c in _ids(insp, "field:Opportunities")], "rule": rule},
        {"id": "C-crm-renewal", "title": "Keep the contract renewal date on every account", "by": "tool",
         "reason": (renewal["title"] + ". Shown on the customer page and in a 'renewals coming up' list.") if renewal else "",
         "component_ids": _ids(insp, "field:Accounts")},
        {"id": "C-crm-access", "title": "Carry over the roles and teams, enforced in the backend", "by": "tool",
         "reason": "Salespeople see their team's records and edit their own; managers edit and delete their team's records; the levels come from "
                   "your SuiteCRM roles, and records keep their teams.", "component_ids": _ids(insp, "role:") + _ids(insp, "team:")},
        {"id": "C-crm-convert", "title": "Lead conversion as agreed", "by": "tool",
         "reason": {"suggest_exact": "An exact company-name match is suggested and confirmed by the salesperson; look-alike names are never linked "
                                     "automatically; converting twice creates nothing new. The lead's notes and tasks stay on the lead, as today.",
                    "always_new": "Conversion always creates a new account; converting twice creates nothing new.",
                    "auto_exact": "An exact company-name match is linked automatically; look-alikes never; converting twice creates nothing new."}[match],
         "component_ids": ["mod:Leads", "mod:Contacts", "mod:Accounts"]},
        {"id": "C-crm-signin", "title": "Sign in with existing SuiteCRM passwords" if signin == "keep" else "New passwords on first sign-in",
         "by": "tool", "reason": "SuiteCRM 7 stores bcrypt hashes of an MD5 of the password; the workspace checks them as they are."
         if signin == "keep" else "Everyone sets a new password on first sign-in.", "component_ids": _ids(insp, "role:")},
        {"id": "C-crm-links", "title": "Links from customer pages to the cases, meetings and calls that stay in SuiteCRM", "by": "tool",
         "reason": "Those records stay in SuiteCRM; the workspace shows how many there are and opens them there.",
         "component_ids": [f"mod:{m}" for m in ("Cases", "Meetings", "Calls") if counts.get(m, {}).get("rows")]},
        {"id": "C-crm-cutover", "title": "Switch over with a short, measured pause in sales edits", "by": "tool",
         "reason": "Sales edits in SuiteCRM pause (its sales roles become read-only), the final snapshot is taken and moved, the checks run, then the "
                   "team signs in to the workspace. SuiteCRM's sales screens stay read-only afterwards. Not zero downtime.",
         "component_ids": _ids(insp, "role:")},
    ]
    preserve = [
        {"what": f"Customer history: {notes_sales:,} notes, {tasks_sales:,} tasks and {audit_rows} field-history rows on sales records "
                 "(the few on soft-deleted records stay behind with them)",
         "reason": "You asked to preserve it; each stays attached to the same record and contact.", "component_ids": ["mod:Notes", "mod:Tasks"]},
        {"what": f"Relationships: {rel['account_contact']:,} account-contact links, {rel['account_deal']:,} account-deal links, "
                 f"{rel['deal_contact']:,} deal-contact links with their roles, {rel['converted_leads']} converted leads",
         "reason": "You asked to preserve them.", "component_ids": ["mod:Contacts", "mod:Opportunities", "mod:Leads"]},
        {"what": "Look-alike accounts stay separate customers", "reason": (_f(insp, "F-crm-similar-names") or {}).get("title", ""),
         "component_ids": ["mod:Accounts"]},
        {"what": "Renewal dates", "reason": renewal["title"] if renewal else "", "component_ids": _ids(insp, "field:Accounts")},
        {"what": "The approval rule and the approval history (who approved, when, which amount)", "reason": "You asked to preserve it.",
         "component_ids": _ids(insp, "rule:")},
        {"what": "Access: who can see, edit and delete which records", "reason": "You asked to preserve the agreed restrictions.",
         "component_ids": _ids(insp, "role:") + _ids(insp, "team:")},
        {"what": "Deal stages, probabilities, amounts in their own currency and the stored US-dollar value",
         "reason": (_f(insp, "F-crm-usd-threshold") or {}).get("title", "Stages and amounts keep their meaning."), "component_ids": ["mod:Opportunities"]},
        {"what": "Record owners, including people who have left" if inactive == "keep" else "Records of people who left move to their manager",
         "reason": (_f(insp, "F-crm-inactive-owner") or {}).get("title", ""), "component_ids": sales_ids},
        {"what": "SuiteCRM itself, its database and every module outside sales",
         "reason": "Support, calendar and the rest keep running there unchanged; we never touch your live system.", "component_ids": ["runtime:suitecrm", "db:main"]},
    ]
    boundary = []
    for b in facts.get("boundary", []):
        if not b["rows"]:
            continue
        if b["from"] == "Cases" and b["to"] == "Accounts":
            how = ("Cases keep pointing at SuiteCRM's copy of the account, which stays as it was at the switch (read-only for sales). "
                   + ("New customers from the workspace are added to SuiteCRM by support when needed." if new_accts == "manual"
                      else "A one-way copy of new accounts to SuiteCRM is quoted separately."))
        elif b["from"] == "Cases" and b["to"] == "Contacts":
            how = "Unchanged in SuiteCRM; the contact also exists in the workspace with the same id."
        elif b["from"] in ("Meetings", "Calls"):
            how = "Stay in SuiteCRM's calendar; the workspace links to them from the customer, deal or lead page."
        elif b.get("stays"):
            how = "Stay in SuiteCRM with their case."
        else:
            how = "Stays as it is."
        boundary.append({**b, "handling": how})
    intended = [
        {"id": "D-crm-api-403", "what": "Asking the workspace's approval endpoint to approve, as a non-manager, is refused with 403",
         "why": "SuiteCRM silently keeps the old value and shows a message. Both block the approval; the workspace's answer is clearer to other programs."},
        {"id": "D-crm-no-export", "what": "No import, export or mass update in the workspace",
         "why": "Not part of the goal. Managers can still export the data as it was at the switch from SuiteCRM."},
        {"id": "D-crm-reports", "what": "Reports, dashboards and SuiteCRM's global search stay in SuiteCRM",
         "why": "The workspace has its own search and home page; SuiteCRM's reports show the data as it was at the switch."},
        {"id": "D-crm-calendar", "what": "Meetings and calls are links, not managed in the workspace", "why": "The calendar stays in SuiteCRM."},
    ]
    if support == "stay":
        intended.append({"id": "D-crm-support", "what": "The Support role gets no workspace access", "why": "Your answer: support stays in SuiteCRM."})
    acceptance = [
        {"id": "A-records", "what": "Every active sales record arrives once, with the same id, values, owner and team; soft-deleted ones do not"},
        {"id": "A-relationships", "what": "Every account-contact, account-deal and deal-contact link (with its role) survives"},
        {"id": "A-similar", "what": "Look-alike accounts stay separate, each with its own contacts and deals"},
        {"id": "A-renewal", "what": "Every contract renewal date has the same value"},
        {"id": "A-history", "what": "Every note and task stays attached to the same record and contact; field history is kept"},
        {"id": "A-money", "what": "Amounts, currencies, US-dollar values, stages and probabilities keep their meaning"},
        {"id": "A-access", "what": "What each user can list, view, edit and delete matches SuiteCRM, checked by direct requests to the backend"},
        {"id": "A-bypass", "what": "Manager-only actions cannot be done by a salesperson through direct requests"},
        {"id": "A-approval", "what": "The approval rule gives the same result as the original SuiteCRM in every recorded scenario"},
        {"id": "A-convert", "what": "Lead conversion follows the agreed workflow, and converting twice creates no duplicates"},
        {"id": "A-create", "what": "New records can be created and edited after the move, and follow the same access rules"},
    ]
    qs = [_question(insp, q) for q in QUESTIONS if q not in (answers or {})]
    blocking = [q for q in qs if q["blocking"]]
    decision = "needs_information" if blocking else ("supported" if not best["blocked_by"] else
                                                     "needs_live_agents" if any("agent" in b for b in best["blocked_by"]) else "blocked")
    customizations = (1 if rule else 0) + (1 if renewal else 0)
    price = [{"label": "Sales workflow moved to a new workspace, with the data (code and data)", "usd": 4800},
             {"label": f"{customizations} customizations carried over and verified (approval rule, renewal date)", "usd": 400 * customizations}]
    if sum(counts[m]["rows"] for m in SALES) > 5000:
        price.append({"label": "More than 5,000 sales records", "usd": 100 * ((sum(counts[m]["rows"] for m in SALES) - 1) // 5000)})
    return {
        "decision": decision, "goal_reading": g, "constraints": constraints, "recommended": best["recipe"], "title": best["title"],
        "work_type": "combined", "options": options, "changes": changes, "preserve": preserve, "boundary": boundary,
        "stays_in_original": [{"module": m, "rows": counts[m]["rows"]} for m in stays] +
                             [{"module": m, "rows": 0} for m in facts.get("unused_modules", [])],
        "intended_differences": intended, "acceptance_checks": acceptance, "questions": qs,
        "follow_ups": ([{"id": "FU-crm-sync", "title": "One-way copy of new accounts to SuiteCRM for support", "quote": "separate"}]
                       if new_accts == "sync_followup" else []) +
                      [{"id": "FU-crm-retire", "title": "Retire the rest of SuiteCRM later (support, calendar), or upgrade it to 7.15", "quote": "separate"}],
        "blocked_by": best["blocked_by"], "database_use": "the sales records move to a new PostgreSQL database; SuiteCRM keeps its own for everything else",
        "requires_database": True,
        "target": {
            "architecture": "Python 3.13 + FastAPI backend with server-rendered pages, PostgreSQL 17",
            "why": ["The job is records, relationships and rules for a small team: a server-rendered web app with one backend that enforces every rule is "
                    "the simplest thing that is fast, accessible and hard to bypass.",
                    "PostgreSQL gives the guarantees the rules need: foreign keys for every relationship, exact decimals for money, one conversion row per lead.",
                    "It runs on supported versions, unlike SuiteCRM 7.11 (PHP 7.4, MariaDB 10.3)."],
            "modernized": ["Accounts, contacts, leads, deals, notes and tasks: new code (Goose's sales-workspace template, configured from this inspection)"],
            "still_used": ["SuiteCRM 7.11.23 for " + ", ".join(stays) + ", and as a read-only record of the sales data at the switch"],
        },
        "cutover": {"steps": ["Pause sales edits in SuiteCRM (sales roles read-only; the previous settings are saved)",
                              "Take the final database snapshot", "Move it into the workspace's database", "Run the data checks on the moved data",
                              "Open the workspace to the sales team"],
                    "downtime": "Sales edits pause from the first step to the last; measured and reported, not zero.",
                    "rollback": "Restore the saved SuiteCRM role settings and keep using SuiteCRM. Anything entered in the workspace after the switch "
                                "would have to be re-entered there: there is no copy back."},
        "price_lines": price,
        "reasons": [best["why"]],
        "answers_used": {k: _answer(answers, k) for k in QUESTIONS if _answer(answers, k)},
    }
