"""Inspect a SuiteCRM 7 installation: its files (against the release's own checksums and a pristine install), its
configuration and metadata (read by php_meta.php in an isolated container) and a workbench copy of its database.

Everything reported cites a file and line, a configuration key, or a database query and its result. Customizations are
found by difference from SuiteCRM's own files.md5 and from a pristine install of the same version; nothing is assumed
from the customer's description. Custom PHP code is read with pattern rules: when a rule is recognised, its parameters
are extracted with the lines they come from; when it is not, the finding says the code needs a person or an agent.

    python -m goose_engine.suitecrm.inspect --repo SRC --meta meta.json --db pw_1030_snapshot \
        --baseline engine/data/suitecrm/7.11.23/baseline.json --compat engine/data/suitecrm/compat.json --out inspection.json
"""
import argparse
import difflib
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from . import db as D

SALES = ["Accounts", "Contacts", "Leads", "Opportunities", "Notes", "Tasks"]
STAYING = ["Cases", "Meetings", "Calls", "Campaigns", "AOS_Quotes", "AOS_Contracts", "AOS_Invoices", "Documents", "Project",
           "AOR_Reports", "AOW_WorkFlow", "Emails", "Bugs", "Prospects"]
TABLE = {"Accounts": "accounts", "Contacts": "contacts", "Leads": "leads", "Opportunities": "opportunities", "Notes": "notes",
         "Tasks": "tasks", "Cases": "cases", "Meetings": "meetings", "Calls": "calls", "Campaigns": "campaigns",
         "AOS_Quotes": "aos_quotes", "AOS_Contracts": "aos_contracts", "AOS_Invoices": "aos_invoices", "Documents": "documents",
         "Project": "project", "AOR_Reports": "aor_reports", "AOW_WorkFlow": "aow_workflow", "Emails": "emails", "Bugs": "bugs",
         "Prospects": "prospects"}
LABEL = {"Opportunities": "Opportunities (deals)", "AOS_Quotes": "Quotes", "AOS_Contracts": "Contracts", "AOS_Invoices": "Invoices",
         "AOR_Reports": "Reports", "AOW_WorkFlow": "Workflows", "Project": "Projects", "Prospects": "Targets"}
LEVEL = {90: "all", 89: "enabled", 80: "team", 75: "own", 0: "not set", -98: "disabled", -99: "none", 1: "normal", 99: "admin", 100: "admin"}


def md5(p):
    return hashlib.md5(p.read_bytes()).hexdigest()


def stock_files(repo):
    """SuiteCRM's own list of release files and their checksums (files.md5 ships with every release)."""
    text = (repo / "files.md5").read_text(errors="ignore")
    return {m.group(1)[2:]: m.group(2) for m in re.finditer(r"'(\./[^']+)'\s*=>\s*'([0-9a-f]{32})'", text)}


def lines_of(p):
    try:
        return p.read_text(errors="ignore").splitlines()
    except OSError:
        return []


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i + 1
    return None


def ev_file(rel, line, lines):
    return {"file": rel, "line": line, "text": (lines[line - 1].strip() if line and line <= len(lines) else "")}


def ev_db(query, result):
    return {"db": query, "result": result}


def norm_name(s):
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"\bst\.?\b", "saint", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\b(co|company|inc|ltd|llc|corp|corporation|group|the)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def analyse_hook(repo, rel):
    """Read a custom logic-hook class and extract what it does, with the line each fact comes from."""
    p = repo / rel
    L = lines_of(p)
    if not L:
        return None
    out = {"file": rel, "lines": len(L), "constants": {}, "messages": [], "reads": set(), "writes": set(), "evidence": {}}
    for i, line in enumerate(L, 1):
        m = re.search(r"\bconst\s+(\w+)\s*=\s*([^;]+);", line)
        if m:
            raw = m.group(2).strip()
            val = raw.strip("'\"") if raw[:1] in "'\"" else (float(raw) if re.fullmatch(r"-?\d+(\.\d+)?", raw) else raw)
            out["constants"][m.group(1)] = {"value": val, "line": i}
        for m in re.finditer(r"appendErrorMessage\(\s*\n?", line):
            # the message may continue on the next line
            text = " ".join(L[i - 1:i + 2])
            mm = re.search(r"appendErrorMessage\(\s*'((?:[^'\\]|\\.)*)'", text)
            if mm:
                out["messages"].append({"text": mm.group(1).replace("\\'", "'"), "line": i})
        for m in re.finditer(r"\$bean->(\w+)\s*=(?!=)", line):
            out["writes"].add(m.group(1))
        for m in re.finditer(r"\$bean->(\w+)", line):
            out["reads"].add(m.group(1))
    ev = out["evidence"]
    ev["usd"] = find_line(L, r"\$bean->amount_usdollar")
    ev["threshold_compare"] = find_line(L, r">\s*self::THRESHOLD") or find_line(L, r">\s*\d{4,}")
    ev["won_check"] = find_line(L, r"sales_stage\s*===?\s*self::WON_STAGE") or find_line(L, r"sales_stage\s*===?\s*'Closed Won'")
    ev["revert_stage"] = find_line(L, r"\$bean->sales_stage\s*=\s*\$oldStage")
    ev["fallback"] = find_line(L, r"'Negotiation/Review'|'Proposal/Price Quote'")
    ev["role_check"] = find_line(L, r"getUserRoleNames")
    ev["team_check"] = find_line(L, r"getUserSecurityGroups")
    ev["admin"] = find_line(L, r"isAdmin\(\)")
    ev["record_approval"] = find_line(L, r"approved_amount_c\s*=")
    ev["withdraw"] = find_line(L, r">\s*\(float\)\$bean->approved_amount_c")
    ev["only_manager"] = find_line(L, r"in_array\(\$status,\s*array\('approved',\s*'rejected'\)")
    ev["class"] = find_line(L, r"^\s*class\s+\w+")
    out["reads"] = sorted(out["reads"])
    out["writes"] = sorted(out["writes"])
    c = out["constants"]
    recognised = bool(ev["won_check"] and ev["threshold_compare"] and ev["role_check"])
    out["recognised_as"] = "approval_rule" if recognised else None
    if recognised:
        msgs = [m["text"] for m in out["messages"]]
        pick = lambda kw: next((m for m in msgs if kw in m.lower()), None)
        fallback_line = ev["fallback"]
        out["rule"] = {
            "threshold_usd": float(c.get("THRESHOLD_USD", {}).get("value", 0)) or None,
            "compares": "amount_usdollar" if ev["usd"] else "amount",
            "won_stage": c.get("WON_STAGE", {}).get("value", "Closed Won"),
            "fallback_stage": re.findall(r"'([^']*)'", L[fallback_line - 1])[-1] if fallback_line else None,
            "manager_role": c.get("MANAGER_ROLE", {}).get("value"),
            "same_team_required": bool(ev["team_check"]),
            "admin_can_approve": bool(ev["admin"]),
            "withdraw_if_amount_exceeds_approved": bool(ev["withdraw"]),
            "messages": {"not_manager": pick("only a sales manager"), "withdrawn": pick("withdrawn"), "blocked": pick("need approval")},
            "lines": {k: v for k, v in ev.items() if v},
        }
    return out


def inspect(repo, meta, dbname, baseline, compat, today=None):
    repo = Path(repo)
    today = today or date.today().isoformat()
    conn = D.connect(dbname)
    q = lambda sql, args=None: D.rows(conn, sql, args)
    scalar = lambda sql, args=None: D.scalar(conn, sql, args)
    tables = {r["t"] for r in q("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = %s", (dbname,))}
    comps, edges, findings, facts = [], [], [], {}

    def comp(id_, kind, name, summary, group, file=None, line=None, **attrs):
        comps.append({"id": id_, "kind": kind, "name": name, "summary": summary, "file": file, "line": line, "group": group, "attrs": attrs})

    def edge(a, b, kind):
        edges.append({"from": a, "to": b, "kind": kind})

    # ---------------------------------------------------------------- files
    stock = stock_files(repo)
    modified, missing = [], 0
    for rel, h in stock.items():
        p = repo / rel
        if not p.exists():
            missing += 1
        elif md5(p) != h:
            modified.append(rel)
    skip = ("vendor/", "cache/", "upload/", "custom/", ".git/")
    pristine_src = set(baseline.get("source_files", []))
    added = sorted(str(p.relative_to(repo)) for p in repo.rglob("*.php")
                   if p.is_file() and str(p.relative_to(repo)) not in stock and str(p.relative_to(repo)) not in pristine_src
                   and not str(p.relative_to(repo)).startswith(skip) and str(p.relative_to(repo)) not in ("config.php", "config_override.php"))
    base_custom = baseline["custom_files"]
    customer_files = []
    for p in sorted((repo / "custom").rglob("*")):
        if not p.is_file():
            continue
        rel = str(p.relative_to(repo))
        if base_custom.get(rel) == md5(p):
            continue
        ov = re.search(r"/Ext/Vardefs/_override_sugarfield_(\w+)\.php$", rel)
        mod_of = re.search(r"custom/Extension/modules/([^/]+)/", rel)
        if ov and mod_of and f"{mod_of.group(1)}{ov.group(1)}" in baseline["fields_meta_data"]:
            continue   # written by Studio/Quick Repair for SuiteCRM's own fields (Google Maps), not by the customer
        if rel in baseline.get("generated_files", []):
            continue
        kind = ("compiled" if "/Ext/" in rel and "/Extension/" not in rel
                else "field settings" if ov
                else "labels" if "/Language/" in rel or "/language/" in rel
                else "extension" if rel.startswith("custom/Extension/")
                else "hook registration" if rel.endswith("logic_hooks.php")
                else "layout" if "/metadata/" in rel else "code")
        customer_files.append({"file": rel, "kind": kind, "lines": len(lines_of(p)), "new": rel not in base_custom})
    facts["files"] = {"stock_checked": len(stock), "stock_modified": modified, "stock_missing": missing,
                      "added_outside_custom": added, "customer_custom_files": customer_files}
    php_files = [p for p in repo.rglob("*.php") if not str(p.relative_to(repo)).startswith(("vendor/", "cache/"))]
    custom_code_lines = sum(f["lines"] for f in customer_files if f["kind"] != "compiled")

    # ---------------------------------------------------------------- version and runtime
    ver = meta.get("suitecrm_version") or "?"
    line = ".".join(ver.split(".")[:2])
    support = compat["lines"].get(line, {})
    cfg = meta.get("config", {})
    comp("runtime:suitecrm", "runtime", f"SuiteCRM {ver}", f"Released {meta.get('suitecrm_timestamp', '?')[:10]}; "
         f"the newest SuiteCRM 7 is {compat['latest_suitecrm_7']['version']} ({compat['latest_suitecrm_7']['date']})", "code",
         "suitecrm_version.php", find_line(lines_of(repo / "suitecrm_version.php"), r"suitecrm_version\s*="))
    comp("runtime:php", "runtime", f"PHP {support.get('php', ['?'])[-1]} at most",
         f"SuiteCRM {line}.x runs on PHP {', '.join(support.get('php', []))} ({support.get('php_note', '')}); PHP 7.4 reached end of life on "
         f"{compat['eol']['php 7.4']}", "code")
    db_kind = cfg.get("dbconfig", {}).get("db_type", "mysql")
    comp("db:main", "database", "MySQL / MariaDB database", f"{len(tables)} tables in the copy you sent; SuiteCRM {line} supports MariaDB "
         f"{support.get('mariadb', ['?'])[-1]} and MySQL {support.get('mysql', ['?'])[-1]} at most", "data", "config.php",
         find_line(lines_of(repo / "config.php"), r"'db_type'"), engine=db_kind)
    comp("ui:web", "interface", "SuiteCRM web screens", "index.php: list, detail and edit views for every module", "entry", "index.php", 1)
    comp("api:v4", "interface", "Legacy REST API v4.1", "service/v4_1/rest.php (session login)", "entry", "service/v4_1/rest.php", 1)
    comp("api:v8", "interface", "REST API v8 (JSON:API, OAuth2)", "Api/V8", "entry")

    # ---------------------------------------------------------------- modules and data
    def count(table, deleted=0):
        return scalar(f"SELECT COUNT(*) FROM `{table}` WHERE deleted = %s", (deleted,)) if table in tables else None

    mod_counts = {}
    for m in SALES + STAYING:
        t = TABLE[m]
        n, d = count(t), count(t, 1)
        if n is None:
            continue
        mod_counts[m] = {"rows": n, "deleted": d}
    facts["module_counts"] = mod_counts
    for m in SALES:
        c = mod_counts[m]
        comp(f"mod:{m}", "module", LABEL.get(m, m), f"{c['rows']:,} records" + (f", {c['deleted']} soft-deleted" if c["deleted"] else ""),
             "code", f"modules/{m}/vardefs.php", None, rows=c["rows"], deleted=c["deleted"], area="sales")
        comp(f"table:{TABLE[m]}", "table", TABLE[m], f"{c['rows']:,} rows (deleted = 0)", "data", rows=c["rows"])
        edge(f"mod:{m}", f"table:{TABLE[m]}", "stored in")
        edge(f"table:{TABLE[m]}", "db:main", "stored in")
        edge("ui:web", f"mod:{m}", "shows")
    for m in STAYING:
        c = mod_counts.get(m)
        if not c or c["rows"] == 0:
            continue
        comp(f"mod:{m}", "module", LABEL.get(m, m), f"{c['rows']:,} records", "code", f"modules/{m}/vardefs.php", None, rows=c["rows"], area="other")
        edge("ui:web", f"mod:{m}", "shows")
    unused = [LABEL.get(m, m) for m in STAYING if mod_counts.get(m, {}).get("rows", 0) == 0]
    facts["unused_modules"] = unused

    # ---------------------------------------------------------------- customizations: fields
    base_fmd = set(baseline["fields_meta_data"])
    fields = q("SELECT id, name, custom_module, type, ext1, ext2, ext3, audited, default_value FROM fields_meta_data WHERE deleted = 0 ORDER BY custom_module, name")
    cust_fields = [f for f in fields if f["id"] not in base_fmd]
    facts["custom_fields"] = []
    for f in cust_fields:
        mod = f["custom_module"]
        cstm = f"{TABLE.get(mod, mod.lower())}_cstm"
        parent = TABLE.get(mod, mod.lower())
        filled = None
        if cstm in tables and f["type"] not in ("relate",):
            filled = scalar(f"SELECT COUNT(*) FROM `{cstm}` c JOIN `{parent}` p ON p.id = c.id_c AND p.deleted = 0 "
                            f"WHERE c.`{f['name']}` IS NOT NULL AND c.`{f['name']}` <> ''")
        facts["custom_fields"].append({**f, "table": cstm, "filled": filled, "of": mod_counts.get(mod, {}).get("rows")})
    renewal = next((f for f in facts["custom_fields"] if f["custom_module"] == "Accounts" and f["type"] == "date"), None)

    # layouts and labels for the custom fields
    def layout_hits(field):
        hits = []
        for cf in customer_files:
            if cf["kind"] == "layout":
                L = lines_of(repo / cf["file"])
                ln = find_line(L, re.escape(field)) or find_line(L, re.escape(field.upper()))
                if ln:
                    hits.append(ev_file(cf["file"], ln, L))
        return hits

    # ---------------------------------------------------------------- customizations: hooks
    base_hooks = set(baseline["hooks"])
    cust_hooks = [h for h in meta.get("hooks", []) if f"{h['module']}|{h['event']}|{h['label']}|{h['file']}" not in base_hooks]
    analysed = []
    for h in cust_hooks:
        a = analyse_hook(repo, h["file"])
        decl = lines_of(repo / h["declared_in"])
        analysed.append({"hook": h, "analysis": a, "declared_line": find_line(decl, re.escape(f"'{h['class']}'")) or find_line(decl, re.escape(h["class"]))})
    facts["custom_hooks"] = analysed

    # dropdown lists added or changed by the customer
    base_lists = baseline.get("lists", {})
    facts["custom_lists"] = {k: v for k, v in meta.get("lists", {}).items() if k not in base_lists or base_lists[k] != v}

    # ---------------------------------------------------------------- access: roles, teams, settings
    roles = q("SELECT r.id, r.name, r.description FROM acl_roles r WHERE r.deleted = 0 ORDER BY r.name")
    acts = q("""SELECT ra.role_id, a.category AS module, a.name AS action, ra.access_override AS level
                FROM acl_roles_actions ra JOIN acl_actions a ON a.id = ra.action_id AND a.deleted = 0
                WHERE ra.deleted = 0 AND a.acltype = 'module'""")
    matrix = defaultdict(lambda: defaultdict(dict))
    for r in acts:
        matrix[r["role_id"]][r["module"]][r["action"]] = int(r["level"])
    users = q("""SELECT u.id, u.user_name, CONCAT_WS(' ', u.first_name, u.last_name) AS name, u.status, u.is_admin, u.reports_to_id, u.title
                 FROM users u WHERE u.deleted = 0 ORDER BY u.user_name""")
    user_roles = defaultdict(list)
    for r in q("SELECT ru.user_id, r.name FROM acl_roles_users ru JOIN acl_roles r ON r.id = ru.role_id AND r.deleted = 0 WHERE ru.deleted = 0"):
        user_roles[r["user_id"]].append(r["name"])
    teams = q("SELECT id, name FROM securitygroups WHERE deleted = 0 ORDER BY name")
    user_teams = defaultdict(list)
    for r in q("SELECT su.user_id, g.name FROM securitygroups_users su JOIN securitygroups g ON g.id = su.securitygroup_id AND g.deleted = 0 WHERE su.deleted = 0"):
        user_teams[r["user_id"]].append(r["name"])
    rec_teams = {r["module"]: r["n"] for r in q("SELECT module, COUNT(DISTINCT record_id) AS n FROM securitygroups_records WHERE deleted = 0 GROUP BY module")}
    sec = {k: v for k, v in cfg.items() if k.startswith("securitysuite_")}
    facts["access"] = {
        "roles": [{"id": r["id"], "name": r["name"], "description": r["description"],
                   "modules": {m: {a: LEVEL.get(v, str(v)) for a, v in acts_.items()} for m, acts_ in matrix[r["id"]].items()}} for r in roles],
        "users": [{**u, "roles": user_roles[u["id"]], "teams": user_teams[u["id"]]} for u in users],
        "teams": [{"id": t["id"], "name": t["name"], "members": sum(1 for u in users if t["name"] in user_teams[u["id"]])} for t in teams],
        "records_in_teams": rec_teams, "settings": sec,
    }
    cfg_lines = lines_of(repo / "config.php")
    for r in roles:
        mods = matrix[r["id"]]
        sales_view = {LEVEL.get(mods.get(m, {}).get("view"), "?") for m in SALES if m in mods}
        sales_edit = {LEVEL.get(mods.get(m, {}).get("edit"), "?") for m in SALES if m in mods}
        n_users = sum(1 for u in users if r["name"] in user_roles[u["id"]])
        comp(f"role:{r['name']}", "role", f"Role: {r['name']}",
             f"{n_users} users; sales records: view {'/'.join(sorted(sales_view)) or 'n/a'}, edit {'/'.join(sorted(sales_edit)) or 'n/a'}", "access")
        for m in SALES:
            if m in mods and mods[m].get("access", 89) != -98:
                edge(f"role:{r['name']}", f"mod:{m}", "controls access to")
    for t in teams:
        n = sum(1 for u in users if t["name"] in user_teams[u["id"]])
        comp(f"team:{t['name']}", "team", f"Team: {t['name']}", f"Security group with {n} members", "access")
        for m in SALES:
            if rec_teams.get(m):
                edge(f"team:{t['name']}", f"mod:{m}", "groups records of")
    comp("cfg:securitysuite", "setting", "Security group settings", ", ".join(f"{k.replace('securitysuite_', '')}={v}" for k, v in sec.items()),
         "code", "config.php", find_line(cfg_lines, r"securitysuite_additive"))

    # ---------------------------------------------------------------- relationships and history
    def nz(sql):
        return scalar(sql) or 0

    rel = {
        "account_contact": nz("""SELECT COUNT(*) FROM accounts_contacts ac JOIN accounts a ON a.id = ac.account_id AND a.deleted = 0
                                 JOIN contacts c ON c.id = ac.contact_id AND c.deleted = 0 WHERE ac.deleted = 0"""),
        "contacts_with_several_accounts": nz("""SELECT COUNT(*) FROM (SELECT ac.contact_id FROM accounts_contacts ac JOIN accounts a ON a.id = ac.account_id
                                 AND a.deleted = 0 WHERE ac.deleted = 0 GROUP BY ac.contact_id HAVING COUNT(*) > 1) x"""),
        "account_deal": nz("""SELECT COUNT(*) FROM accounts_opportunities ao JOIN accounts a ON a.id = ao.account_id AND a.deleted = 0
                              JOIN opportunities o ON o.id = ao.opportunity_id AND o.deleted = 0 WHERE ao.deleted = 0"""),
        "deals_with_several_accounts": nz("""SELECT COUNT(*) FROM (SELECT opportunity_id FROM accounts_opportunities WHERE deleted = 0
                                             GROUP BY opportunity_id HAVING COUNT(*) > 1) x"""),
        "deal_contact": nz("""SELECT COUNT(*) FROM opportunities_contacts oc JOIN opportunities o ON o.id = oc.opportunity_id AND o.deleted = 0
                              JOIN contacts c ON c.id = oc.contact_id AND c.deleted = 0 WHERE oc.deleted = 0"""),
        "notes_by_parent": {r["k"] or "(none)": r["n"] for r in q("SELECT parent_type AS k, COUNT(*) AS n FROM notes WHERE deleted = 0 GROUP BY parent_type")},
        "tasks_by_parent": {r["k"] or "(none)": r["n"] for r in q("SELECT parent_type AS k, COUNT(*) AS n FROM tasks WHERE deleted = 0 GROUP BY parent_type")},
        "notes_with_contact": nz("SELECT COUNT(*) FROM notes WHERE deleted = 0 AND contact_id IS NOT NULL AND contact_id <> ''"),
        "converted_leads": nz("SELECT COUNT(*) FROM leads WHERE deleted = 0 AND converted = 1"),
        "converted_with_deal": nz("SELECT COUNT(*) FROM leads WHERE deleted = 0 AND converted = 1 AND opportunity_id IS NOT NULL AND opportunity_id <> ''"),
        "email_links": nz("SELECT COUNT(*) FROM email_addr_bean_rel WHERE deleted = 0 AND bean_module IN ('Accounts','Contacts','Leads')"),
        "audit": {t: nz(f"SELECT COUNT(*) FROM `{t}`") for t in ("accounts_audit", "contacts_audit", "opportunities_audit", "leads_audit") if t in tables},
    }
    facts["relationships"] = rel
    edge("mod:Contacts", "mod:Accounts", "belongs to")
    edge("mod:Opportunities", "mod:Accounts", "belongs to")
    edge("mod:Opportunities", "mod:Contacts", "involves")
    edge("mod:Notes", "mod:Accounts", "attached to")
    edge("mod:Notes", "mod:Opportunities", "attached to")
    edge("mod:Tasks", "mod:Accounts", "attached to")
    edge("mod:Leads", "mod:Contacts", "converts to")
    for t in ("accounts_contacts", "accounts_opportunities", "opportunities_contacts", "securitygroups_records", "email_addr_bean_rel"):
        if t in tables:
            n = nz(f"SELECT COUNT(*) FROM `{t}` WHERE deleted = 0")
            comp(f"table:{t}", "table", t, f"{n:,} links", "data", rows=n)
            edge(f"table:{t}", "db:main", "stored in")
    edge("mod:Contacts", "table:accounts_contacts", "linked through")
    edge("mod:Opportunities", "table:accounts_opportunities", "linked through")
    edge("mod:Opportunities", "table:opportunities_contacts", "linked through")
    edge("mod:Contacts", "table:email_addr_bean_rel", "e-mail addresses in")

    # ---------------------------------------------------------------- data patterns
    accts = q("""SELECT a.id, a.name, a.assigned_user_id,
                        (SELECT g.name FROM securitygroups_records r JOIN securitygroups g ON g.id = r.securitygroup_id
                          WHERE r.record_id = a.id AND r.module = 'Accounts' AND r.deleted = 0 LIMIT 1) AS team,
                        (SELECT COUNT(*) FROM accounts_contacts ac WHERE ac.account_id = a.id AND ac.deleted = 0) AS contacts,
                        (SELECT COUNT(*) FROM accounts_opportunities ao WHERE ao.account_id = a.id AND ao.deleted = 0) AS deals
                 FROM accounts a WHERE a.deleted = 0""")
    def key(n):
        return norm_name(n).replace(" ", "")

    def alike(x, y):
        kx, ky = key(x), key(y)
        if kx == ky:
            return 1.0
        r = difflib.SequenceMatcher(None, kx, ky).ratio()
        return r if (r >= 0.8 and kx[:5] == ky[:5]) else 0.0

    groups, seen = [], set()
    for i, a in enumerate(accts):
        if a["id"] in seen:
            continue
        grp, best = [a], 0.0
        for b in accts[i + 1:]:
            if b["id"] in seen:
                continue
            r = alike(a["name"], b["name"])
            if r:
                grp.append(b)
                best = max(best, r)
        if len(grp) > 1:
            seen.update(x["id"] for x in grp)
            groups.append((best, len(grp), [{k: x[k] for k in ("id", "name", "team", "contacts", "deals")} for x in grp]))
    groups = [g for _, _, g in sorted(groups, key=lambda t: (-t[1], -t[0]))]
    facts["similar_accounts"] = groups
    same_contacts = q("""SELECT c.first_name, c.last_name, COUNT(DISTINCT ac.account_id) AS accounts FROM contacts c
                         JOIN accounts_contacts ac ON ac.contact_id = c.id AND ac.deleted = 0 WHERE c.deleted = 0
                         GROUP BY c.first_name, c.last_name HAVING COUNT(DISTINCT ac.account_id) > 1 ORDER BY c.last_name""")
    facts["same_name_contacts"] = same_contacts
    currencies = q("SELECT id, name, iso4217, conversion_rate FROM currencies WHERE deleted = 0")
    by_cur = {r["c"]: r["n"] for r in q("SELECT currency_id AS c, COUNT(*) AS n FROM opportunities WHERE deleted = 0 GROUP BY currency_id")}
    facts["currencies"] = [{"id": "-99", "name": cfg.get("default_currency_name", "US Dollars"), "iso4217": cfg.get("default_currency_iso4217", "USD"),
                            "conversion_rate": 1.0, "deals": by_cur.get("-99", 0)}] + \
                          [{**c, "conversion_rate": float(c["conversion_rate"]), "deals": by_cur.get(c["id"], 0)} for c in currencies]
    owners_inactive = {}
    for m in SALES:
        n = nz(f"""SELECT COUNT(*) FROM `{TABLE[m]}` x JOIN users u ON u.id = x.assigned_user_id WHERE x.deleted = 0 AND u.status <> 'Active'""")
        if n:
            owners_inactive[m] = n
    facts["owned_by_inactive_users"] = owners_inactive
    facts["deleted_records"] = {m: c["deleted"] for m, c in mod_counts.items() if m in SALES and c["deleted"]}

    # boundary: what outside the sales modules points at sales records
    boundary = []
    if "cases" in tables:
        n = nz("SELECT COUNT(*) FROM cases c JOIN accounts a ON a.id = c.account_id AND a.deleted = 0 WHERE c.deleted = 0")
        na = nz("SELECT COUNT(DISTINCT c.account_id) FROM cases c JOIN accounts a ON a.id = c.account_id AND a.deleted = 0 WHERE c.deleted = 0")
        if n:
            boundary.append({"from": "Cases", "to": "Accounts", "rows": n, "distinct": na, "column": "cases.account_id",
                             "query": "SELECT COUNT(*) FROM cases JOIN accounts ON accounts.id = cases.account_id WHERE cases.deleted = 0"})
    for t, mod in (("meetings", "Meetings"), ("calls", "Calls")):
        if t in tables:
            for r in q(f"SELECT parent_type AS p, COUNT(*) AS n FROM `{t}` WHERE deleted = 0 AND parent_type IN ('Accounts','Opportunities','Leads','Contacts') GROUP BY parent_type"):
                boundary.append({"from": mod, "to": r["p"], "rows": r["n"], "column": f"{t}.parent_type/parent_id",
                                 "query": f"SELECT parent_type, COUNT(*) FROM {t} WHERE deleted = 0 GROUP BY parent_type"})
    for t, mod in (("notes", "Notes"), ("tasks", "Tasks")):
        n = nz(f"SELECT COUNT(*) FROM `{t}` WHERE deleted = 0 AND parent_type = 'Cases'")
        if n:
            boundary.append({"from": f"{mod} on cases", "to": "Cases", "rows": n, "column": f"{t}.parent_type = 'Cases'", "stays": True,
                             "query": f"SELECT COUNT(*) FROM {t} WHERE deleted = 0 AND parent_type = 'Cases'"})
    if "contacts_cases" in tables:
        n = nz("SELECT COUNT(*) FROM contacts_cases WHERE deleted = 0")
        if n:
            boundary.append({"from": "Cases", "to": "Contacts", "rows": n, "column": "contacts_cases", "query": "SELECT COUNT(*) FROM contacts_cases WHERE deleted = 0"})
    for t, col, frm, to in (("leads", "campaign_id", "Leads", "Campaigns"), ("aos_quotes", "opportunity_id", "Quotes", "Opportunities")):
        if t in tables:
            n = nz(f"SELECT COUNT(*) FROM `{t}` WHERE deleted = 0 AND `{col}` IS NOT NULL AND `{col}` <> ''")
            boundary.append({"from": frm, "to": to, "rows": n, "column": f"{t}.{col}", "query": f"SELECT COUNT(*) FROM {t} WHERE {col} <> ''"})
    facts["boundary"] = boundary
    for b in boundary:
        if b["rows"] and f"mod:{b['from']}" in {c["id"] for c in comps} and f"mod:{b['to']}" in {c["id"] for c in comps}:
            edge(f"mod:{b['from']}", f"mod:{b['to']}", f"refers to ({b['rows']})")

    # approval data
    appr = {}
    if "opportunities_cstm" in tables and any(f["name"] == "approval_status_c" for f in cust_fields):
        appr["by_status"] = {(r["s"] or ""): r["n"] for r in q("""SELECT c.approval_status_c AS s, COUNT(*) AS n FROM opportunities o
                              JOIN opportunities_cstm c ON c.id_c = o.id WHERE o.deleted = 0 GROUP BY c.approval_status_c""")}
        appr["won_above_without_approval"] = q("""SELECT o.id, o.name, o.amount_usdollar AS usd, o.date_closed FROM opportunities o
                              JOIN opportunities_cstm c ON c.id_c = o.id WHERE o.deleted = 0 AND o.sales_stage = 'Closed Won'
                              AND o.amount_usdollar > 25000 AND (c.approval_status_c IS NULL OR c.approval_status_c <> 'approved') ORDER BY o.date_closed""")
        appr["approvers"] = {r["u"]: r["n"] for r in q("""SELECT u.user_name AS u, COUNT(*) AS n FROM opportunities_cstm c JOIN users u ON u.id = c.user_id_c
                              JOIN opportunities o ON o.id = c.id_c AND o.deleted = 0 WHERE c.approval_status_c = 'approved' GROUP BY u.user_name""")}
        appr["non_usd_near_threshold"] = q("""SELECT o.id, o.name, o.amount, o.amount_usdollar AS usd, cu.iso4217 FROM opportunities o
                              JOIN currencies cu ON cu.id = o.currency_id WHERE o.deleted = 0 AND o.amount <= 25000 AND o.amount_usdollar > 25000
                              AND o.sales_stage NOT IN ('Closed Won','Closed Lost')""")
        appr["boundary_deals"] = q("""SELECT o.id, o.name, o.amount_usdollar AS usd, o.sales_stage FROM opportunities o WHERE o.deleted = 0
                              AND o.amount_usdollar BETWEEN 24999.99 AND 25000.02""")
    facts["approvals"] = appr
    facts["lead_conversion"] = {"lead_conv_activity_opt": cfg.get("lead_conv_activity_opt")}
    facts["lists"] = {k: meta.get("lists", {}).get(k) for k in ("sales_stage_dom", "sales_probability_dom", "lead_status_dom", "task_status_dom",
                                                               "task_priority_dom", "account_type_dom", "industry_dom", "lead_source_dom",
                                                               "opportunity_relationship_type_dom")}
    facts["config"] = {k: cfg.get(k) for k in ("site_url", "system_name", "default_currency_iso4217", "default_currency_name",
                                               "lead_conv_activity_opt", "aod", "datef", "timef")}
    facts["date_range"] = {t: q(f"SELECT MIN(date_entered) AS first, MAX(date_entered) AS last FROM `{t}` WHERE deleted = 0")[0]
                           for t in ("accounts", "opportunities", "notes") if t in tables}

    # ---------------------------------------------------------------- customization components and findings
    hook_comp = None
    for h in analysed:
        a, hk = h["analysis"], h["hook"]
        cid = f"rule:{hk['class']}"
        hook_comp = cid if a and a.get("recognised_as") == "approval_rule" else hook_comp
        rule = (a or {}).get("rule")
        summary = (f"before_save on {hk['module']}: deals above ${rule['threshold_usd']:,.0f} ({rule['compares']}) need a "
                   f"'{rule['manager_role']}' on the same team before '{rule['won_stage']}'" if rule else f"{hk['event']} hook on {hk['module']}")
        comp(cid, "rule", f"Custom rule: {hk['label'][:60]}", summary, "code", hk["file"], (a or {}).get("evidence", {}).get("class"), custom=True)
        edge(cid, f"mod:{hk['module']}", f"runs on every save of")
        for f in cust_fields:
            if f["custom_module"] == hk["module"] and a and f["name"] in a["writes"]:
                edge(cid, f"field:{f['custom_module']}.{f['name']}", "writes")
    for f in facts["custom_fields"]:
        cid = f"field:{f['custom_module']}.{f['name']}"
        label = {"contract_renewal_date_c": "Contract renewal date"}.get(f["name"], f["name"])
        comp(cid, "field", f"Custom field: {label}", f"{f['type']} on {f['custom_module']} in {f['table']}" +
             (f"; filled for {f['filled']:,} of {f['of']:,} records" if f["filled"] is not None and f["of"] else ""), "code", None, None, custom=True)
        edge(cid, f"mod:{f['custom_module']}", "adds a field to")
        edge(cid, f"table:{TABLE.get(f['custom_module'])}", "stored beside")

    F = findings.append
    for h in analysed:
        a, hk = h["analysis"], h["hook"]
        if not a:
            continue
        L = lines_of(repo / hk["file"])
        decl = lines_of(repo / hk["declared_in"])
        ev = [ev_file(hk["declared_in"], h["declared_line"], decl)]
        if a.get("rule"):
            r = a["rule"]
            for k in ("threshold_compare", "usd", "won_check", "revert_stage", "role_check", "team_check", "only_manager", "record_approval", "withdraw"):
                if r["lines"].get(k):
                    ev.append(ev_file(hk["file"], r["lines"][k], L))
            by = appr.get("by_status", {})
            data = (f" In the data: {by.get('approved', 0)} deals approved, {by.get('requested', 0)} waiting, {by.get('rejected', 0)} rejected"
                    f"; approvals by {', '.join(f'{u} ({n})' for u, n in appr.get('approvers', {}).items())}.")
            pre = appr.get("won_above_without_approval", [])
            if pre:
                data += (f" {len(pre)} deals above the threshold were won without an approval, all closed by "
                         f"{max(str(x['date_closed']) for x in pre)[:10]}: the rule checks the moment a deal is closed, it does not re-check old deals.")
            F({"id": "F-crm-approval-rule", "severity": "high", "area": "customization", "component_ids": [f"rule:{hk['class']}", "mod:Opportunities"],
               "title": f"Custom approval rule: deals above ${r['threshold_usd']:,.0f} need a sales manager's approval before they can be won",
               "detail": (f"{hk['file']} runs before every save of an opportunity, from the edit screen, inline edit, mass update, import or the API. "
                          f"It compares the US-dollar value ({r['compares']}), not the amount typed in. Only a user with the role '{r['manager_role']}' who shares a "
                          f"team (security group) with the deal's salesperson, or an administrator, can approve or reject. A blocked 'Closed Won' keeps the "
                          f"previous stage and sets the approval to Requested. Approving records who, when and the approved US-dollar amount; raising the "
                          f"amount afterwards withdraws the approval." + data + " Not part of standard SuiteCRM: added under custom/."),
               "evidence": ev + [ev_db("SELECT approval_status_c, COUNT(*) FROM opportunities JOIN opportunities_cstm ... GROUP BY approval_status_c",
                                       appr.get("by_status"))],
               "rule": r})
            nonusd = appr.get("non_usd_near_threshold", [])
            if nonusd and r["compares"] == "amount_usdollar":
                x = nonusd[0]
                F({"id": "F-crm-usd-threshold", "severity": "high", "area": "customization", "component_ids": [f"rule:{hk['class']}", "mod:Opportunities"],
                   "title": f"{len(nonusd)} open deal(s) look below $25,000 but need approval, because the rule converts to US dollars",
                   "detail": (f"'{x['name']}' is {x['iso4217']} {float(x['amount']):,.0f}, worth ${float(x['usd']):,.2f}. A rebuild that compared the amount "
                              f"as typed would let it be won without approval. The new workspace must keep the stored US-dollar value and its conversion."),
                   "evidence": [ev_file(hk["file"], r["lines"]["usd"], L),
                                ev_db("SELECT name, amount, amount_usdollar, iso4217 FROM opportunities JOIN currencies ... WHERE amount <= 25000 AND amount_usdollar > 25000",
                                      [{"name": y["name"], "amount": float(y["amount"]), "usd": round(float(y["usd"]), 2), "currency": y["iso4217"]} for y in nonusd])]})
        else:
            F({"id": f"F-crm-hook-{hk['class']}", "severity": "medium", "area": "customization", "component_ids": [f"rule:{hk['class']}"],
               "title": f"Custom code we cannot interpret automatically: {hk['label']}",
               "detail": f"{hk['file']} ({a['lines']} lines) runs on {hk['event']} of {hk['module']}. Carrying it over needs the agent team or a person.",
               "evidence": ev})
    if renewal:
        hits = layout_hits(renewal["name"])
        F({"id": "F-crm-renewal-field", "severity": "medium", "area": "customization", "component_ids": [f"field:Accounts.{renewal['name']}", "mod:Accounts"],
           "title": f"Custom field 'Contract renewal date' on accounts, filled for {renewal['filled']:,} of {renewal['of']:,}",
           "detail": (f"Added with Studio: a {renewal['type']} column {renewal['name']} in {renewal['table']} (a separate table joined on id), "
                      f"shown on the account detail, edit and list screens. Not part of standard SuiteCRM. The values must arrive unchanged."),
           "evidence": [ev_db(f"SELECT * FROM fields_meta_data WHERE id = '{renewal['id']}'", {"type": renewal["type"], "audited": renewal["audited"]}),
                        ev_db(f"SELECT COUNT(*) FROM {renewal['table']} WHERE {renewal['name']} IS NOT NULL", renewal["filled"])] + hits})
    approval_fields = [f for f in facts["custom_fields"] if f["custom_module"] == "Opportunities"]
    if approval_fields:
        F({"id": "F-crm-approval-fields", "severity": "low", "area": "customization", "component_ids": [f"field:Opportunities.{f['name']}" for f in approval_fields],
           "title": f"{len(approval_fields)} custom fields on opportunities hold the approval state",
           "detail": ", ".join(f"{f['name']} ({f['type']})" for f in approval_fields) + " in opportunities_cstm, with a custom dropdown "
                     + ", ".join(f"{k} ({', '.join(v2 for v2 in v.values() if v2)})" for k, v in facts["custom_lists"].items() if isinstance(v, dict)) + ".",
           "evidence": [ev_db("SELECT id, type FROM fields_meta_data WHERE custom_module = 'Opportunities'", [f["id"] for f in approval_fields])]})
    if groups:
        sample = groups[0]
        F({"id": "F-crm-similar-names", "severity": "high", "area": "data", "component_ids": ["mod:Accounts"],
           "title": f"{sum(len(g) for g in groups)} accounts in {len(groups)} groups have near-identical names but are different customers",
           "detail": ("For example " + ", ".join(f"'{x['name']}' ({x['team'] or 'no team'}, {x['contacts']} contacts, {x['deals']} deals)" for x in sample) +
                      ". Each has its own contacts and deals. Moving the data must keep them apart, and converting a lead must not link it to a "
                      "look-alike account."),
           "evidence": [ev_db("accounts whose normalised names are equal, or at least 0.8 alike with the same first five letters", [[x["name"] for x in g] for g in groups])]})
    if same_contacts:
        F({"id": "F-crm-same-name-contacts", "severity": "low", "area": "data", "component_ids": ["mod:Contacts"],
           "title": f"{len(same_contacts)} contact names appear at more than one account",
           "detail": ", ".join(f"{c['first_name']} {c['last_name']} ({c['accounts']} accounts)" for c in same_contacts[:6]) +
                     (f" and {len(same_contacts) - 6} more" if len(same_contacts) > 6 else "") + ". Each is linked to its own account; they must not be merged.",
           "evidence": [ev_db("SELECT first_name, last_name, COUNT(DISTINCT account_id) FROM contacts JOIN accounts_contacts ... HAVING > 1", same_contacts)]})
    acc = facts["access"]
    sp = next((r for r in acc["roles"] if r["name"] == "Salesperson"), None)
    role_text = "; ".join(f"{r['name']}: view {r['modules'].get('Accounts', {}).get('view', 'not set')}, edit {r['modules'].get('Accounts', {}).get('edit', 'not set')}, "
                          f"delete {r['modules'].get('Accounts', {}).get('delete', 'not set')} (accounts)" for r in acc["roles"])
    F({"id": "F-crm-access", "severity": "high", "area": "access", "component_ids": [f"role:{r['name']}" for r in acc["roles"]] + [f"team:{t['name']}" for t in acc["teams"]],
       "title": f"Access is limited by {len(acc['roles'])} roles and {len(acc['teams'])} teams",
       "detail": (f"{role_text}. 'team' means the record belongs to one of the user's security groups or is assigned to them; 'own' means assigned to them. "
                  f"Records join a team when created (settings: {', '.join(k.replace('securitysuite_', '') + '=' + str(v) for k, v in acc['settings'].items() if 'inherit' in k or 'additive' in k)}). "
                  f"{sum(acc['records_in_teams'].get(m, 0) for m in SALES):,} sales records are in a team. These restrictions are standard SuiteCRM features, configured by the customer."),
       "evidence": [ev_db("SELECT r.name, a.category, a.name, ra.access_override FROM acl_roles_actions ra JOIN acl_actions a ... JOIN acl_roles r ...",
                          {r["name"]: r["modules"].get("Accounts") for r in acc["roles"]}),
                    ev_file("config.php", find_line(cfg_lines, r"securitysuite_inherit_creator"), cfg_lines)]})
    if boundary:
        F({"id": "F-crm-boundary", "severity": "medium", "area": "boundary", "component_ids": [f"mod:{b['from']}" for b in boundary if f"mod:{b['from']}" in {c['id'] for c in comps}],
           "title": "Support cases, meetings and calls point at sales records",
           "detail": "; ".join(f"{b['from']} → {b['to']}: {b['rows']:,}" + (f" (on {b['distinct']} accounts)" if b.get("distinct") else "") for b in boundary if b["rows"]) +
                     ". If the sales records move, these links cross the boundary between the new workspace and SuiteCRM.",
           "evidence": [ev_db(b["query"], b["rows"]) for b in boundary]})
    if owners_inactive:
        F({"id": "F-crm-inactive-owner", "severity": "low", "area": "data", "component_ids": [f"mod:{m}" for m in owners_inactive],
           "title": f"{sum(owners_inactive.values())} sales records belong to users who are no longer active",
           "detail": ", ".join(f"{m}: {n}" for m, n in owners_inactive.items()) + ". SuiteCRM keeps them assigned; their team can still see them.",
           "evidence": [ev_db("SELECT COUNT(*) FROM <table> JOIN users ON users.id = assigned_user_id WHERE users.status <> 'Active'", owners_inactive)]})
    if facts["deleted_records"]:
        F({"id": "F-crm-deleted", "severity": "low", "area": "data", "component_ids": [f"mod:{m}" for m in facts["deleted_records"]],
           "title": f"{sum(facts['deleted_records'].values())} soft-deleted records are still in the database",
           "detail": "SuiteCRM marks deleted records with deleted = 1 and hides them: " + ", ".join(f"{m}: {n}" for m, n in facts["deleted_records"].items()) + ".",
           "evidence": [ev_db("SELECT COUNT(*) FROM <table> WHERE deleted = 1", facts["deleted_records"])]})
    conv = cfg.get("lead_conv_activity_opt")
    F({"id": "F-crm-lead-conversion", "severity": "medium", "area": "workflow", "component_ids": ["mod:Leads", "mod:Contacts"],
       "title": f"Lead conversion: {rel['converted_leads']} leads converted; activities stay on the lead",
       "detail": (f"Converting a lead creates a contact and links or creates an account, optionally a deal ({rel['converted_with_deal']} of the converted leads have one). "
                  f"The setting lead_conv_activity_opt = '{conv}' leaves the lead's notes and tasks on the lead."),
       "evidence": [ev_file("config.php", find_line(cfg_lines, r"lead_conv_activity_opt"), cfg_lines),
                    ev_db("SELECT COUNT(*) FROM leads WHERE converted = 1", rel["converted_leads"])]})
    F({"id": "F-crm-runtime", "severity": "high", "area": "runtime", "component_ids": ["runtime:suitecrm", "runtime:php", "db:main"],
       "title": f"SuiteCRM {ver} needs PHP 7.4 or older and MariaDB 10.3 / MySQL 8.0 or older",
       "detail": (f"{ver} ({meta.get('suitecrm_timestamp', '')[:10]}) is the last 7.11 release. PHP 7.4 reached end of life on {compat['eol']['php 7.4']} and MariaDB 10.3 "
                  f"on {compat['eol']['mariadb 10.3']}. SuiteCRM 7 itself is now at {compat['latest_suitecrm_7']['version']}."),
       "evidence": [ev_file("suitecrm_version.php", find_line(lines_of(repo / "suitecrm_version.php"), r"suitecrm_version\s*="), lines_of(repo / "suitecrm_version.php")),
                    {"doc": compat["_sources"]["compatibility_matrix"], "result": support}]})
    if cfg.get("dbconfig", {}).get("db_password") == "[redacted]":
        F({"id": "F-crm-secret", "severity": "medium", "area": "security", "component_ids": ["db:main"],
           "title": "config.php contains the database password in plain text",
           "detail": "Normal for SuiteCRM, but the file must not be shared or committed. We redacted it in everything we store; rotate it after the move.",
           "evidence": [ev_file("config.php", find_line(cfg_lines, r"'db_password'"), ["(value redacted)"] * len(cfg_lines))]})
    F({"id": "F-crm-core-files", "severity": "low" if not modified else "medium", "area": "code", "component_ids": ["runtime:suitecrm"],
       "title": ("No SuiteCRM file was changed" if not modified else f"{len(modified)} SuiteCRM files were changed") +
                f"; {len([f for f in customer_files if f['kind'] != 'compiled'])} customer files under custom/ ("
                + ", ".join(f"{k} {n}" for k, n in Counter(f["kind"] for f in customer_files if f["kind"] != "compiled").most_common()) + ")",
       "detail": (f"Checked {len(stock):,} files against the checksums SuiteCRM ships in files.md5. Customizations live in custom/ "
                  f"({custom_code_lines} lines written by the customer or Studio, plus files compiled by Quick Repair)." +
                  (f" Changed: {', '.join(modified[:8])}." if modified else "")),
       "evidence": [{"file": f["file"], "line": 1, "text": f"{f['kind']}, {f['lines']} lines"} for f in customer_files if f["kind"] != "compiled"][:12]})
    if unused:
        F({"id": "F-crm-unused", "severity": "low", "area": "scope", "component_ids": [],
           "title": f"{len(unused)} SuiteCRM modules hold no records", "detail": ", ".join(unused) + ".",
           "evidence": [ev_db("SELECT COUNT(*) FROM <module table> WHERE deleted = 0", 0)]})

    size = {"files": len(php_files), "custom_files": len(customer_files), "custom_code_lines": custom_code_lines,
            "tables": len(tables), "rows": sum(c["rows"] for c in mod_counts.values()),
            "sales_rows": sum(mod_counts[m]["rows"] for m in SALES), "components": len(comps), "connections": len(edges),
            "customizations": len(cust_hooks) + (1 if renewal else 0)}
    return {
        "schema_version": 2, "inspected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "today": today,
        "stack": {"language": "PHP", "languages": {"PHP": {"files": len(php_files), "lines": None}}, "framework": "SuiteCRM",
                  "framework_version": ver, "python": None, "php_supported": support.get("php"),
                  "database": {"engine": "mysql", "copy_supplied": True, "tables": len(tables)}, "imports": []},
        "pins": {"suitecrm": ver}, "problems": [], "size": size, "components": comps, "edges": edges, "findings": findings, "facts": facts,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--compat", required=True)
    ap.add_argument("--today")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    r = inspect(a.repo, json.loads(Path(a.meta).read_text()), a.db, json.loads(Path(a.baseline).read_text()),
                json.loads(Path(a.compat).read_text()), a.today)
    Path(a.out).write_text(json.dumps(r, indent=1, default=str))
    print(json.dumps({"components": len(r["components"]), "findings": [f["id"] for f in r["findings"]], "size": r["size"]}, default=str))


if __name__ == "__main__":
    main()
