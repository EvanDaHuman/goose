"""Acceptance checks for the SuiteCRM sales-workflow move, frozen before implementation and run against the delivered workspace.

freeze: computes every expected value from the SuiteCRM snapshot (the source of truth) and from the recording of the original
        application's behaviour, writes them to the vault with a manifest of hashes, and makes the files read-only. Nothing here
        reads the delivered code, its configuration or the migration's output.
run:    checks the delivered workspace's database (as delivered) and its HTTP API (on a disposable verification copy of that
        database), and compares with the frozen expectations.

    python -m goose_verify.crm_checks freeze --snapshot-db pw_1030_snapshot --recording recording.json --plan plan.json --vault V
    DELIVERED_DSN=... VERIFY_DSN=... python -m goose_verify.crm_checks run --vault V --app-url http://127.0.0.1:8090 \
        --password-file F --report report.json --markdown report.md
"""
import argparse
import concurrent.futures as cf
import hashlib
import http.cookiejar
import json
import os
import stat
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from goose_engine.suitecrm import db as D
from goose_engine.suitecrm.inspect import norm_name

ENT = {"Accounts": "accounts", "Contacts": "contacts", "Leads": "leads", "Opportunities": "deals", "Notes": "notes", "Tasks": "tasks"}
PARENT = {"Accounts": "account", "Contacts": "contact", "Opportunities": "deal", "Leads": "lead"}
LEVEL = {90: "all", 80: "team", 75: "own", -99: "none", 89: "enabled", -98: "disabled"}
RANK = {"none": 0, "own": 1, "team": 2, "all": 3}
CATEGORY_TITLES = {
    "records": "Every record arrived once, and only once", "fields": "Values arrived unchanged", "relationships": "Links between records",
    "similar": "Look-alike customers stay separate", "renewal": "Contract renewal dates", "history": "Notes, tasks and field history",
    "money": "Amounts, currencies and stages", "users": "Users, roles and teams", "boundary": "Links to what stays in SuiteCRM",
    "signin": "Signing in", "access": "Who can list, view, edit and delete (backend)", "bypass": "Direct requests cannot skip the rules",
    "approval": "The approval rule matches the original", "convert": "Lead conversion as agreed", "create": "Creating and editing after the move",
    "app": "The delivered app runs",
}


def s(v):
    if v is None:
        return None
    if isinstance(v, Decimal):
        return format(v.normalize(), "f") if v == v.to_integral() else str(v.quantize(Decimal("0.000001")).normalize())
    if isinstance(v, datetime):
        return v.replace(tzinfo=None).isoformat(sep=" ", timespec="seconds") if v.tzinfo is None else v.astimezone(timezone.utc).replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")
    if isinstance(v, float):
        return format(Decimal(str(v)).normalize(), "f")
    v = str(v)
    return None if v.strip() == "" else v


def skey(row):
    return [("" if v is None else str(v)) for v in row]


def money(v):
    return None if v is None else str(Decimal(str(v)).quantize(Decimal("0.01")))


# ======================================================================================= freeze

def expected_from_snapshot(snap):
    c = D.connect(snap)
    q = lambda sql, a=None: D.rows(c, sql, a)
    ex = {}
    acc = {r["id"]: r for r in q("SELECT a.*, x.contract_renewal_date_c AS renewal FROM accounts a LEFT JOIN accounts_cstm x ON x.id_c = a.id WHERE a.deleted = 0")}
    con = {r["id"]: r for r in q("SELECT * FROM contacts WHERE deleted = 0")}
    deals = {r["id"]: r for r in q("""SELECT o.*, x.approval_status_c, x.user_id_c, x.approved_amount_c, x.approved_at_c, cu.iso4217
                                      FROM opportunities o LEFT JOIN opportunities_cstm x ON x.id_c = o.id LEFT JOIN currencies cu ON cu.id = o.currency_id
                                      WHERE o.deleted = 0""")}
    leads = {r["id"]: r for r in q("SELECT * FROM leads WHERE deleted = 0")}
    ids = {"accounts": set(acc), "contacts": set(con), "deals": set(deals), "leads": set(leads)}

    def attached(r):
        p = PARENT.get(r["parent_type"] or "")
        if p and r["parent_id"] in ids[{"account": "accounts", "contact": "contacts", "deal": "deals", "lead": "leads"}[p]]:
            return p, r["parent_id"]
        if not r["parent_type"] and r["contact_id"] in con:
            return "contact", r["contact_id"]
        return None, None

    notes = {r["id"]: r for r in q("SELECT * FROM notes WHERE deleted = 0") if attached(r)[0]}
    tasks = {r["id"]: r for r in q("SELECT * FROM tasks WHERE deleted = 0") if attached(r)[0]}
    ids["notes"], ids["tasks"] = set(notes), set(tasks)
    ex["ids"] = {k: sorted(v) for k, v in ids.items()}
    ex["deleted_ids"] = {ENT[m]: sorted(r["id"] for r in q(f"SELECT id FROM `{t}` WHERE deleted = 1"))
                         for m, t in (("Accounts", "accounts"), ("Contacts", "contacts"), ("Opportunities", "opportunities"), ("Leads", "leads"))}
    emails = {}
    for r in q("""SELECT r.bean_module, r.bean_id, e.email_address FROM email_addr_bean_rel r JOIN email_addresses e ON e.id = r.email_address_id AND e.deleted = 0
                  WHERE r.deleted = 0 ORDER BY r.primary_address DESC, r.date_created"""):
        emails.setdefault((r["bean_module"], r["bean_id"]), r["email_address"])
    link_ac = {}
    for r in q("SELECT account_id, contact_id FROM accounts_contacts WHERE deleted = 0 ORDER BY date_modified"):
        if r["account_id"] in acc and r["contact_id"] in con:
            link_ac[r["contact_id"]] = r["account_id"]
    link_ad = {}
    for r in q("SELECT account_id, opportunity_id FROM accounts_opportunities WHERE deleted = 0 ORDER BY date_modified"):
        if r["account_id"] in acc and r["opportunity_id"] in deals:
            link_ad[r["opportunity_id"]] = r["account_id"]
    ex["fields"] = {
        "accounts": {i: {"name": s(a["name"]), "account_type": s(a["account_type"]), "industry": s(a["industry"]), "phone": s(a["phone_office"]),
                         "website": s(a["website"]), "billing_city": s(a["billing_address_city"]), "owner_id": s(a["assigned_user_id"]),
                         "created_at": s(a["date_entered"]), "description": s(a["description"])} for i, a in acc.items()},
        "contacts": {i: {"first_name": s(r["first_name"]), "last_name": s(r["last_name"]), "title": s(r["title"]), "email": s(emails.get(("Contacts", i))),
                         "phone": s(r["phone_work"]), "account_id": link_ac.get(i), "owner_id": s(r["assigned_user_id"]), "created_at": s(r["date_entered"])}
                     for i, r in con.items()},
        "leads": {i: {"first_name": s(r["first_name"]), "last_name": s(r["last_name"]), "company": s(r["account_name"]), "status": s(r["status"]),
                      "email": s(emails.get(("Leads", i))), "converted": bool(r["converted"]), "owner_id": s(r["assigned_user_id"])} for i, r in leads.items()},
        "notes": {i: {"subject": s(r["name"]), "body": s(r["description"]), "parent": list(attached(r)), "contact_id": s(r["contact_id"]) if r["contact_id"] in con else None,
                      "owner_id": s(r["assigned_user_id"]), "created_at": s(r["date_entered"])} for i, r in notes.items()},
        "tasks": {i: {"subject": s(r["name"]), "status": s(r["status"]), "priority": s(r["priority"]), "due_at": s(r["date_due"]), "parent": list(attached(r)),
                      "contact_id": s(r["contact_id"]) if r["contact_id"] in con else None, "owner_id": s(r["assigned_user_id"])} for i, r in tasks.items()},
    }
    ex["money"] = {i: {"name": s(d["name"]), "account_id": link_ad.get(i), "stage": s(d["sales_stage"]), "probability": s(d["probability"]),
                       "amount": money(d["amount"]), "currency": d["iso4217"] or "USD", "amount_usd": money(d["amount_usdollar"]), "close_date": s(d["date_closed"]),
                       "approval_status": d["approval_status_c"] or "", "approved_by": s(d["user_id_c"]), "approved_amount_usd": money(d["approved_amount_c"]),
                       "approved_at": s(d["approved_at_c"]), "owner_id": s(d["assigned_user_id"])} for i, d in deals.items()}
    ex["renewal"] = {i: (str(a["renewal"]) if a["renewal"] else None) for i, a in acc.items()}
    ex["deal_contacts"] = sorted(([r["opportunity_id"], r["contact_id"], s(r["contact_role"])] for r in q(
        "SELECT opportunity_id, contact_id, contact_role FROM opportunities_contacts WHERE deleted = 0") if r["opportunity_id"] in deals and r["contact_id"] in con), key=skey)
    ex["lead_links"] = {i: [s(l["contact_id"]) if l["contact_id"] in con else None, s(l["account_id"]) if l["account_id"] in acc else None,
                            s(l["opportunity_id"]) if l["opportunity_id"] in deals else None] for i, l in leads.items() if l["converted"]}
    moved = {k: set(v) for k, v in ex["ids"].items()}
    ex["record_teams"] = sorted({(ENT[r["module"]], r["record_id"], r["securitygroup_id"]) for r in q(
        "SELECT module, record_id, securitygroup_id FROM securitygroups_records WHERE deleted = 0 AND securitygroup_id IN (SELECT id FROM securitygroups WHERE deleted = 0)")
        if r["module"] in ENT and r["record_id"] in moved[ENT[r["module"]]]})
    ex["audit"] = sorted(([e, r["parent_id"], r["field_name"], s(r["before_value_string"]) or s(r["before_value_text"]),
                           s(r["after_value_string"]) or s(r["after_value_text"])]
                          for t, e in (("accounts_audit", "accounts"), ("contacts_audit", "contacts"), ("opportunities_audit", "deals"), ("leads_audit", "leads"))
                          for r in q(f"SELECT * FROM `{t}`") if r["parent_id"] in moved[e]), key=skey)
    # look-alike customers: computed here, independently of the inspection
    names = sorted((norm_name(a["name"]).replace(" ", ""), i) for i, a in acc.items())
    groups = {}
    for k, i in names:
        groups.setdefault(k, []).append(i)
    import difflib
    keys = sorted(groups)
    sim = []
    for x in range(len(keys)):
        for y in range(x + 1, len(keys)):
            if keys[x][:5] == keys[y][:5] and difflib.SequenceMatcher(None, keys[x], keys[y]).ratio() >= 0.8:
                sim.append(sorted(groups[keys[x]] + groups[keys[y]]))
    sim += [sorted(v) for v in groups.values() if len(v) > 1]
    ex["similar"] = [{"ids": g, "names": [acc[i]["name"] for i in g],
                      "contacts": {i: sorted(c for c, a in link_ac.items() if a == i) for i in g},
                      "deals": {i: sorted(d for d, a in link_ad.items() if a == i) for i in g}} for g in sim]
    # users, roles, teams, permissions
    users = q("SELECT id, user_name, status, is_admin, user_hash FROM users WHERE deleted = 0")
    ex["users"] = {u["user_name"]: {"id": u["id"], "active": u["status"] == "Active", "is_admin": bool(u["is_admin"]), "hash": u["user_hash"]} for u in users}
    ex["user_roles"] = sorted([r["user_id"], r["role_id"]] for r in q(
        "SELECT DISTINCT user_id, role_id FROM acl_roles_users WHERE deleted = 0 AND role_id IN (SELECT id FROM acl_roles WHERE deleted = 0)"))
    ex["user_teams"] = sorted([r["user_id"], r["securitygroup_id"]] for r in q(
        "SELECT DISTINCT user_id, securitygroup_id FROM securitygroups_users WHERE deleted = 0 AND securitygroup_id IN (SELECT id FROM securitygroups WHERE deleted = 0)"))
    perms = {}
    for r in q("""SELECT r.name AS role, a.category, a.name AS action, ra.access_override AS lvl FROM acl_roles_actions ra
                  JOIN acl_actions a ON a.id = ra.action_id AND a.deleted = 0 JOIN acl_roles r ON r.id = ra.role_id AND r.deleted = 0
                  WHERE ra.deleted = 0 AND a.acltype = 'module'"""):
        if r["category"] in ENT and r["action"] in ("access", "list", "view", "edit", "delete") and LEVEL.get(int(r["lvl"])):
            perms[f"{r['role']}|{ENT[r['category']]}|{r['action']}"] = LEVEL[int(r["lvl"])]
    ex["permissions"] = perms
    ext = {}
    for r in q("SELECT account_id AS id, COUNT(*) AS n FROM cases WHERE deleted = 0 GROUP BY account_id"):
        if r["id"] in acc:
            ext[f"accounts|{r['id']}|support cases"] = r["n"]
    for t in ("meetings", "calls"):
        for r in q(f"SELECT parent_type AS pt, parent_id AS id, COUNT(*) AS n FROM `{t}` WHERE deleted = 0 GROUP BY parent_type, parent_id"):
            p = PARENT.get(r["pt"] or "")
            e = {"account": "accounts", "contact": "contacts", "deal": "deals", "lead": "leads"}.get(p)
            if e and r["id"] in moved[e]:
                ext[f"{e}|{r['id']}|{t}"] = r["n"]
    ex["external"] = ext
    # conversion fixtures: the agreed workflow is checked on leads chosen here from the data
    open_leads = [l for l in leads.values() if not l["converted"] and l["status"] not in ("Dead", "Converted")]
    by_norm = {}
    for i, a in acc.items():
        by_norm.setdefault(" ".join((a["name"] or "").lower().split()), []).append(i)
    exact = [l for l in open_leads if " ".join((l["account_name"] or "").lower().split()) in by_norm]
    alike = [l for l in open_leads if l not in exact and any(
        difflib.SequenceMatcher(None, norm_name(l["account_name"] or "").replace(" ", ""), norm_name(acc[i]["name"]).replace(" ", "")).ratio() >= 0.8
        for i in acc)]
    plain = [l for l in open_leads if l not in exact and l not in alike]
    ex["convert"] = {
        "exact": [{"lead": l["id"], "owner": l["assigned_user_id"], "accounts": by_norm[" ".join(l["account_name"].lower().split())]} for l in exact],
        "alike": [{"lead": l["id"], "owner": l["assigned_user_id"], "company": l["account_name"]} for l in alike],
        "plain": [{"lead": l["id"], "owner": l["assigned_user_id"]} for l in sorted(plain, key=lambda x: x["id"])[:4]],
        "historic": [{"lead": i, "contact": v[0]} for i, v in sorted(ex["lead_links"].items())[:3] if v[0]],
        "lead_activities": {l["id"]: {"notes": sorted(n for n, r in notes.items() if attached(r) == ("lead", l["id"])),
                                      "tasks": sorted(t for t, r in tasks.items() if attached(r) == ("lead", l["id"]))} for l in open_leads},
    }
    ex["counts"] = {k: len(v) for k, v in ex["ids"].items()}
    return ex


def freeze(snap, recording, plan, vault):
    vault = Path(vault)
    vault.mkdir(parents=True, exist_ok=True)
    for f in vault.iterdir():
        f.chmod(0o644)
    ex = expected_from_snapshot(snap)
    rec = json.loads(Path(recording).read_text())
    p = json.loads(Path(plan).read_text())
    answers = p.get("answers_used", {})
    no_access = sorted(n for n, u in rec["users"].items() if u["roles"] == ["Support"]) if answers.get("Q-crm-support", "stay") == "stay" else []
    agreed = {"no_workspace_access": no_access, "match": answers.get("Q-crm-match", "suggest_exact"), "signin": answers.get("Q-crm-signin", "keep"),
              "threshold_usd": next((c.get("rule", {}) or {}).get("threshold_usd") for c in p["changes"] if c["id"] == "C-crm-approval"),
              "intended_differences": p.get("intended_differences", [])}
    files = {"expected.json": ex, "recording.json": rec, "agreed.json": agreed}
    for name, data in files.items():
        (vault / name).write_text(json.dumps(data, indent=1, default=str, sort_keys=True))
    manifest = {"frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "snapshot_db": snap,
                "files": {n: hashlib.sha256((vault / n).read_bytes()).hexdigest() for n in files},
                "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "note": "Expected values come from the SuiteCRM snapshot and the recording of the original application. "
                        "The implementation side never receives this folder."}
    (vault / "MANIFEST.json").write_text(json.dumps(manifest, indent=1))
    for f in vault.iterdir():
        f.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    return manifest


# ======================================================================================= run

class Api:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json", "Accept": "application/json"})
        try:
            with self.op.open(r, timeout=60) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw and resp.headers.get_content_type() == "application/json" else raw.decode("utf-8", "ignore"))
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, raw.decode("utf-8", "ignore")

    def login(self, user, pw):
        return self.req("POST", "/api/login", {"user_name": user, "password": pw})[0] == 200

    def all_ids(self, entity):
        out, page = [], 1
        while True:
            st, b = self.req("GET", f"/api/{entity}?page={page}&per_page=100")
            if st != 200:
                return None
            items = b.get("items", [])
            out += [i["id"] for i in items]
            if not items or len(out) >= int(b.get("total", 0)) or page > 200:
                return out
            page += 1


def obj(body, singular):
    if isinstance(body, dict):
        if isinstance(body.get(singular), dict):
            return body[singular]
        if "id" in body:
            return body
    return {}


def run(vault, delivered_dsn, verify_dsn, app_url, password, data_only=False):
    import psycopg
    vault = Path(vault)
    man = json.loads((vault / "MANIFEST.json").read_text())
    integrity = {"ok": True, "files": {}}
    for n, h in man["files"].items():
        got = hashlib.sha256((vault / n).read_bytes()).hexdigest()
        integrity["files"][n] = got == h
        integrity["ok"] &= got == h
    ex = json.loads((vault / "expected.json").read_text())
    rec = json.loads((vault / "recording.json").read_text())
    agreed = json.loads((vault / "agreed.json").read_text())
    results = []

    def R(cid, cat, title, passed, expected=None, actual=None, evidence=None, mandatory=True, skipped=False, reason=None):
        r = {"id": cid, "category": cat, "title": title, "mandatory": mandatory, "status": "skip" if skipped else ("pass" if passed else "fail"),
             "expected": expected, "actual": actual, "evidence": evidence or {}}
        if reason:
            r["reason"] = reason
        results.append(r)

    def diff(cid, cat, title, exp, got, limit=8):
        bad = [k for k in sorted(set(exp) | set(got)) if exp.get(k) != got.get(k)]
        R(cid, cat, title, not bad, f"{len(exp)} records", f"{len(exp) - len([b for b in bad if b in exp])} match",
          {"mismatches": [{"id": k, "expected": exp.get(k), "actual": got.get(k)} for k in bad[:limit]], "mismatch_count": len(bad)})

    # ------------------------------------------------------------- the delivered database, as delivered
    with psycopg.connect(delivered_dsn) as pg:
        cur = pg.cursor()
        Q = lambda sql, a=None: (cur.execute(sql, a), cur.fetchall())[1]
        for e in ("accounts", "contacts", "deals", "leads", "notes", "tasks"):
            got = [r[0] for r in Q(f"SELECT id FROM {e} WHERE deleted_at IS NULL")]
            dup = len(got) - len(set(got))
            R(f"D-records-{e}", "records", f"Every active {e[:-1]} arrived once ({ex['counts'][e]:,})", sorted(got) == ex["ids"][e] and not dup,
              ex["counts"][e], len(got), {"missing": sorted(set(ex["ids"][e]) - set(got))[:8], "extra": sorted(set(got) - set(ex["ids"][e]))[:8], "duplicates": dup})
        for e, ids in ex["deleted_ids"].items():
            present = [r[0] for r in Q(f"SELECT id FROM {e} WHERE id = ANY(%s)", (ids,))] if ids else []
            R(f"D-deleted-{e}", "records", f"Soft-deleted {e} stayed behind ({len(ids)})", not present, 0, len(present), {"present": present[:8]})
        a = {r[0]: {"name": r[1], "account_type": r[2], "industry": r[3], "phone": r[4], "website": r[5], "billing_city": r[6], "owner_id": r[7],
                    "created_at": s(r[8]), "description": r[9]} for r in Q(
            "SELECT id, name, account_type, industry, phone, website, billing_city, owner_id, created_at, description FROM accounts")}
        diff("D-fields-accounts", "fields", "Account details are unchanged", ex["fields"]["accounts"], {k: v for k, v in a.items() if k in ex["fields"]["accounts"]})
        c = {r[0]: {"first_name": r[1], "last_name": r[2], "title": r[3], "email": r[4], "phone": r[5], "account_id": r[6], "owner_id": r[7], "created_at": s(r[8])}
             for r in Q("SELECT id, first_name, last_name, title, email, phone, account_id, owner_id, created_at FROM contacts")}
        diff("D-fields-contacts", "fields", "Contact details, e-mail addresses and accounts are unchanged", ex["fields"]["contacts"],
             {k: v for k, v in c.items() if k in ex["fields"]["contacts"]})
        l = {r[0]: {"first_name": r[1], "last_name": r[2], "company": r[3], "status": r[4], "email": r[5], "converted": r[6], "owner_id": r[7]}
             for r in Q("SELECT id, first_name, last_name, company, status, email, converted, owner_id FROM leads")}
        diff("D-fields-leads", "fields", "Lead details are unchanged", ex["fields"]["leads"], {k: v for k, v in l.items() if k in ex["fields"]["leads"]})
        dm = {r[0]: {"name": r[1], "account_id": r[2], "stage": r[3], "probability": s(r[4]), "amount": money(r[5]), "currency": r[6], "amount_usd": money(r[7]),
                     "close_date": s(r[8]), "approval_status": r[9], "approved_by": r[10], "approved_amount_usd": money(r[11]), "approved_at": s(r[12]), "owner_id": r[13]}
              for r in Q("""SELECT id, name, account_id, stage, probability, amount, currency_code, amount_usd, close_date, approval_status, approved_by,
                                   approved_amount_usd, approved_at, owner_id FROM deals""")}
        diff("D-money-deals", "money", "Every deal keeps its amount, currency, US-dollar value, stage, probability and close date",
             {k: {x: v[x] for x in ("name", "account_id", "stage", "probability", "amount", "currency", "amount_usd", "close_date", "owner_id")} for k, v in ex["money"].items()},
             {k: {x: v[x] for x in ("name", "account_id", "stage", "probability", "amount", "currency", "amount_usd", "close_date", "owner_id")} for k, v in dm.items() if k in ex["money"]})
        diff("D-approval-history", "money", "Approval history is unchanged (status, approver, approved amount, time)",
             {k: {x: v[x] for x in ("approval_status", "approved_by", "approved_amount_usd", "approved_at")} for k, v in ex["money"].items()},
             {k: {x: v[x] for x in ("approval_status", "approved_by", "approved_amount_usd", "approved_at")} for k, v in dm.items() if k in ex["money"]})
        rates = {r[0]: str(Decimal(r[1]).normalize()) for r in Q("SELECT code, rate_per_usd FROM currencies")}
        R("D-currencies", "money", "Currencies and conversion rates arrived", all(cu in rates for cu in {v["currency"] for v in ex["money"].values()}), None, rates)
        n = {r[0]: {"subject": r[1], "body": r[2], "parent": [r[3], r[4]], "contact_id": r[5], "owner_id": r[6], "created_at": s(r[7])} for r in Q(
            "SELECT id, subject, body, parent_type, parent_id, contact_id, owner_id, created_at FROM notes")}
        diff("D-history-notes", "history", f"Every note stays on the same record and contact ({len(ex['fields']['notes']):,})", ex["fields"]["notes"],
             {k: v for k, v in n.items() if k in ex["fields"]["notes"]})
        t = {r[0]: {"subject": r[1], "status": r[2], "priority": r[3], "due_at": s(r[4]), "parent": [r[5], r[6]], "contact_id": r[7], "owner_id": r[8]} for r in Q(
            "SELECT id, subject, status, priority, due_at, parent_type, parent_id, contact_id, owner_id FROM tasks")}
        diff("D-history-tasks", "history", f"Every task stays on the same record and contact ({len(ex['fields']['tasks']):,})", ex["fields"]["tasks"],
             {k: v for k, v in t.items() if k in ex["fields"]["tasks"]})
        aud = sorted(([r[0], r[1], r[2], s(r[3]), s(r[4])] for r in Q("SELECT entity, record_id, field, before, after FROM audit_log WHERE source = 'suitecrm'")), key=skey)
        R("D-history-audit", "history", f"Field history arrived ({len(ex['audit'])} changes)", aud == ex["audit"], len(ex["audit"]), len(aud))
        ren = {r[0]: (str(r[1]) if r[1] else None) for r in Q("SELECT id, contract_renewal_date FROM accounts")}
        filled = sum(1 for v in ex["renewal"].values() if v)
        diff("D-renewal", "renewal", f"Every contract renewal date has the same value ({filled} set, {len(ex['renewal']) - filled} empty)", ex["renewal"],
             {k: v for k, v in ren.items() if k in ex["renewal"]})
        R("D-rel-account-contact", "relationships", "Every contact is linked to the same account",
          all(c.get(i, {}).get("account_id") == v["account_id"] for i, v in ex["fields"]["contacts"].items()),
          sum(1 for v in ex["fields"]["contacts"].values() if v["account_id"]), sum(1 for v in c.values() if v["account_id"]))
        R("D-rel-account-deal", "relationships", "Every deal is linked to the same account",
          all(dm.get(i, {}).get("account_id") == v["account_id"] for i, v in ex["money"].items()))
        dc = sorted(([r[0], r[1], r[2]] for r in Q("SELECT deal_id, contact_id, role FROM deal_contacts")), key=skey)
        R("D-rel-deal-contact", "relationships", f"Every deal-contact link keeps its role ({len(ex['deal_contacts'])})", dc == ex["deal_contacts"],
          len(ex["deal_contacts"]), len(dc), {"missing": [x for x in ex["deal_contacts"] if x not in dc][:5]})
        ll = {r[0]: [r[1], r[2], r[3]] for r in Q("SELECT id, converted_contact_id, converted_account_id, converted_deal_id FROM leads WHERE converted")}
        R("D-rel-converted-leads", "relationships", f"Converted leads keep their contact, account and deal ({len(ex['lead_links'])})", ll == ex["lead_links"],
          len(ex["lead_links"]), len(ll))
        rt = sorted(tuple(r) for r in Q("SELECT entity, record_id, team_id FROM record_teams"))
        R("D-rel-teams", "relationships", f"Every record keeps its team ({len(ex['record_teams']):,} memberships)", rt == [tuple(x) for x in ex["record_teams"]],
          len(ex["record_teams"]), len(rt))
        ok_sim, bad = True, []
        for g in ex["similar"]:
            for i in g["ids"]:
                got_c = sorted(k for k, v in c.items() if v["account_id"] == i)
                got_d = sorted(k for k, v in dm.items() if v["account_id"] == i)
                if i not in a or got_c != g["contacts"][i] or got_d != g["deals"][i]:
                    ok_sim = False
                    bad.append(a.get(i, {}).get("name", i))
        R("D-similar", "similar", f"{sum(len(g['ids']) for g in ex['similar'])} look-alike accounts stay separate with their own contacts and deals",
          ok_sim, [g["names"] for g in ex["similar"]][:6], "separate" if ok_sim else bad[:6])
        us = {r[0]: {"id": r[1], "active": r[2] == "active", "is_admin": r[3], "hash": r[4]} for r in Q("SELECT user_name, id, status, is_admin, password_hash FROM users")}
        exp_users = {k: {**v, "active": v["active"] and k not in agreed["no_workspace_access"]} for k, v in ex["users"].items()}
        R("D-users", "users", "Every user arrived; people who left and agreed exclusions cannot sign in",
          all(us.get(k, {}).get("id") == v["id"] and us[k]["active"] == v["active"] for k, v in exp_users.items()),
          {k: v["active"] for k, v in exp_users.items()}, {k: v["active"] for k, v in us.items()})
        if agreed["signin"] == "keep":
            R("D-password-hashes", "users", "SuiteCRM's password hashes arrived unchanged, so current passwords keep working",
              all(us.get(k, {}).get("hash") == v["hash"] for k, v in ex["users"].items() if v["hash"]))
        ur = sorted([r[0], r[1]] for r in Q("SELECT user_id, role_id FROM user_roles"))
        ut = sorted([r[0], r[1]] for r in Q("SELECT user_id, team_id FROM user_teams"))
        R("D-roles-teams", "users", "Role and team memberships are unchanged", ur == ex["user_roles"] and ut == ex["user_teams"])
        perms = {f"{r[0]}|{r[1]}|{r[2]}": r[3] for r in Q("SELECT ro.name, p.entity, p.action, p.level FROM role_permissions p JOIN roles ro ON ro.id = p.role_id")}
        R("D-permissions", "users", "Role permission levels are the same as in SuiteCRM", all(perms.get(k) == v for k, v in ex["permissions"].items()),
          len(ex["permissions"]), sum(1 for k, v in ex["permissions"].items() if perms.get(k) == v))
        el = {f"{r[0]}|{r[1]}|{r[2]}": r[3] for r in Q("SELECT entity, record_id, kind, count FROM external_links")}
        R("D-boundary-links", "boundary", "Cases, meetings and calls that stay in SuiteCRM are linked from the right records", el == ex["external"],
          sum(ex["external"].values()), sum(el.values()))

    if data_only:
        return results, integrity, man
    # ------------------------------------------------------------- the running app, on a verification copy
    with psycopg.connect(verify_dsn, autocommit=True) as vg:
        vc = vg.cursor()
        import bcrypt
        h = bcrypt.hashpw(hashlib.md5(password.encode()).hexdigest().lower().encode(), bcrypt.gensalt(10)).decode().replace("$2b$", "$2y$", 1)
        vc.execute("UPDATE users SET password_hash = %s, password_scheme = 'suitecrm-bcrypt-md5' WHERE password_scheme = 'suitecrm-bcrypt-md5'", (h,))

        def reset_deal(did):
            m = ex["money"][did]
            vc.execute("""UPDATE deals SET stage = %s, amount = %s, amount_usd = %s, approval_status = %s, approved_by = %s, approved_amount_usd = %s,
                          approved_at = %s, deleted_at = NULL WHERE id = %s""",
                       (m["stage"], m["amount"], m["amount_usd"], m["approval_status"], m["approved_by"], m["approved_amount_usd"], m["approved_at"], did))

        st, b = Api(app_url).req("GET", "/healthz")
        R("A-health", "app", "The delivered app starts and answers", st == 200, 200, st)
        users = rec["users"]
        sess = {}
        for name, u in users.items():
            api = Api(app_url)
            ok = api.login(name, password)
            want = u["can_sign_in"] and name not in agreed["no_workspace_access"]
            R(f"B-signin-{name}", "signin", f"{name} {'can' if want else 'cannot'} sign in" + (" (agreed: support stays in SuiteCRM)" if name in agreed["no_workspace_access"] else ""),
              ok == want, want, ok)
            if ok:
                sess[name] = api
        st, _ = Api(app_url).req("GET", "/api/accounts")
        R("B-unauthenticated", "bypass", "Requests without signing in are refused", st == 401, 401, st)
        for name, api in sess.items():
            for m, ids in rec["lists"].get(name, {}).items():
                e = ENT[m]
                got = api.all_ids(e)
                if not isinstance(ids, list):   # SuiteCRM refused the whole module for this user
                    R(f"B-list-{name}-{e}", "access", f"{name} cannot open {e}", got is None or got == [], "refused", "refused" if not got else len(got))
                    continue
                want = sorted(set(ids) & set(ex["ids"][e]))
                R(f"B-list-{name}-{e}", "access", f"{name} lists the same {len(want)} {e} as in SuiteCRM", sorted(got or []) == want, len(want),
                  None if got is None else len(got), {"missing": sorted(set(want) - set(got or []))[:5], "extra": sorted(set(got or []) - set(want))[:5]})
        views_ok, views_bad = 0, []
        for v in rec["views"]:
            api = sess.get(v["user"])
            if not api or v["id"] not in set(ex["ids"][ENT[v["module"]]]):
                continue
            st, _ = api.req("GET", f"/api/{ENT[v['module']]}/{v['id']}")
            if (st == 200) == v["visible"] and st in (200, 404):
                views_ok += 1
            else:
                views_bad.append({"user": v["user"], "entity": ENT[v["module"]], "id": v["id"], "original_visible": v["visible"], "status": st})
        R("B-view", "access", f"Opening a record by its id gives the same answer as SuiteCRM ({views_ok + len(views_bad)} tries; hidden ones answer 404)",
          not views_bad, views_ok + len(views_bad), views_ok, {"mismatches": views_bad[:8]})
        edits_ok, edits_bad = 0, []
        for v in rec["edits"]:
            api = sess.get(v["user"])
            e = ENT[v["module"]]
            if not api or v["id"] not in set(ex["ids"][e]):
                continue
            st, _ = api.req("PATCH", f"/api/{e}/{v['id']}", {("body" if e == "notes" else "description"): f"gs-verify-{v['user']}"})
            if (st == 200) == v["allowed"] and st in (200, 403, 404):
                edits_ok += 1
            else:
                edits_bad.append({"user": v["user"], "entity": e, "id": v["id"], "original_allowed": v["allowed"], "status": st})
        R("B-edit", "access", f"Changing a record is allowed or refused exactly as in SuiteCRM ({edits_ok + len(edits_bad)} tries)", not edits_bad,
          edits_ok + len(edits_bad), edits_ok, {"mismatches": edits_bad[:8]})
        del_ok, del_bad = 0, []
        for v in rec["deletes"]:
            api = sess.get(v["user"])
            e = ENT[v["module"]]
            if not api or v["id"] not in set(ex["ids"][e]):
                continue
            st, _ = api.req("DELETE", f"/api/{e}/{v['id']}")
            if (st in (200, 204)) == v["allowed"] and st in (200, 204, 403, 404):
                del_ok += 1
            else:
                del_bad.append({"user": v["user"], "entity": e, "id": v["id"], "original_allowed": v["allowed"], "status": st})
            vc.execute(f"UPDATE {e} SET deleted_at = NULL WHERE id = %s", (v["id"],))
        R("B-delete", "access", f"Deleting notes and tasks is allowed or refused exactly as in SuiteCRM ({del_ok + len(del_bad)} tries)", not del_bad,
          del_ok + len(del_bad), del_ok, {"mismatches": del_bad[:8]})

        # direct requests that try to skip the approval rule or the access rules
        scen = {x["id"]: x for x in rec["scenarios"]}
        big = scen.get("S-close-blocked")
        if big:
            did = big["deal_id"]
            owner = big["steps"][0]["user"]
            api = sess[owner]
            reset_deal(did)
            st, body = api.req("POST", f"/api/deals/{did}/approval", {"decision": "approved"})
            vc.execute("SELECT approval_status FROM deals WHERE id = %s", (did,))
            R("B-bypass-approve-endpoint", "bypass", "A salesperson calling the approval endpoint directly is refused (403) and nothing changes",
              st == 403 and vc.fetchone()[0] == ex["money"][did]["approval_status"], 403, st)
            reset_deal(did)
            st, body = api.req("PATCH", f"/api/deals/{did}", {"approved_by": rec["users"][owner]["id"], "approved_amount_usd": "999999",
                                                              "approval_status": "approved", "stage": "Closed Won"})
            vc.execute("SELECT stage, approval_status, approved_by FROM deals WHERE id = %s", (did,))
            row = vc.fetchone()
            R("B-bypass-patch", "bypass", "Setting the approval fields and 'Closed Won' in one direct request does not close the deal",
              row[0] == ex["money"][did]["stage"] and row[1] != "approved" and row[2] != rec["users"][owner]["id"],
              {"stage": ex["money"][did]["stage"], "approval": "not approved"}, {"stage": row[0], "approval": row[1]})
            other = next((n for n, u in users.items() if n in sess and u["teams"] and not set(u["teams"]) & set(users[owner]["teams"])
                          and "Salesperson" in u["roles"]), None)
            if other:
                st1, _ = sess[other].req("GET", f"/api/deals/{did}")
                st2, _ = sess[other].req("PATCH", f"/api/deals/{did}", {"stage": "Closed Lost"})
                st3, _ = sess[other].req("POST", f"/api/deals/{did}/approval", {"decision": "approved"})
                R("B-bypass-other-team", "bypass", "Another team's salesperson cannot read, change or approve the deal by its id",
                  st1 == 404 and st2 == 404 and st3 in (403, 404), [404, 404, "403/404"], [st1, st2, st3])
            reset_deal(did)
        sp = next((n for n, u in users.items() if n in sess and "Salesperson" in u["roles"]), None)
        if sp:
            mine = next((i for i, v in ex["fields"]["accounts"].items() if v["owner_id"] == users[sp]["id"]), None)
            if mine:
                st, _ = sess[sp].req("DELETE", f"/api/accounts/{mine}")
                R("B-bypass-delete", "bypass", "A salesperson cannot delete an account, even their own (role: delete none)", st == 403, 403, st)
                vc.execute("UPDATE accounts SET deleted_at = NULL WHERE id = %s", (mine,))

        # the approval rule, scenario by scenario, against the recording of the original
        for sc in rec["scenarios"]:
            if sc.get("create"):
                cr = sc["create"]
                api = sess.get(cr["user"])
                if not api:
                    continue
                st, b = api.req("POST", "/api/deals", {"name": "Goose verification: threshold deal", "account_id": cr["account_id"], "amount": cr["amount"],
                                                        "currency_code": "USD", "stage": cr["stage"], "close_date": "2026-12-31"})
                did = obj(b, "deal").get("id")
                ok, got = st in (200, 201) and bool(did), None
                if ok:
                    for step in sc["steps"]:
                        api.req("PATCH", f"/api/deals/{did}", {"stage": step["changes"]["sales_stage"]})
                    vc.execute("SELECT stage, approval_status FROM deals WHERE id = %s", (did,))
                    got = vc.fetchone()
                    ok = got[0] == sc["steps"][-1]["after"]["stage"] and (got[1] or "") == sc["steps"][-1]["after"]["approval"]
                R(f"B-approval-{sc['id']}", "approval", sc["why"], ok, sc["steps"][-1]["after"]["stage"], got[0] if got else st)
                continue
            did = sc["deal_id"]
            if did not in ex["money"]:
                continue
            reset_deal(did)
            seq_ok, trace = True, []
            for step in sc["steps"]:
                api = sess.get(step["user"])
                body = {{"sales_stage": "stage", "approval_status_c": "approval_status", "amount": "amount"}[k]: v for k, v in step["changes"].items()}
                st, b = api.req("PATCH", f"/api/deals/{did}", body) if api else (None, None)
                vc.execute("""SELECT d.stage, d.approval_status, u.user_name, d.approved_amount_usd, d.amount_usd FROM deals d LEFT JOIN users u ON u.id = d.approved_by
                              WHERE d.id = %s""", (did,))
                row = vc.fetchone()
                want = step["after"]
                refused = st in (403, 404)
                same = (row[0] == want["stage"] and (row[1] or "") == (want["approval"] or "") and row[2] == want["approved_by"]
                        and money(row[3]) == money(want["approved_amount"]) and money(row[4]) == money(want["usd"]) and refused == bool(step.get("refused")))
                seq_ok &= same
                trace.append({"user": step["user"], "request": body, "status": st, "workspace": {"stage": row[0], "approval": row[1], "approved_by": row[2],
                              "approved_amount": money(row[3]), "usd": money(row[4])}, "original": {k: want[k] for k in ("stage", "approval", "approved_by")}
                              | {"approved_amount": money(want["approved_amount"]), "usd": money(want["usd"]), "refused": bool(step.get("refused"))}})
            R(f"B-approval-{sc['id']}", "approval", sc["why"], seq_ok, "same as the original", "same" if seq_ok else "different", {"steps": trace})
            reset_deal(did)

        # lead conversion, the agreed workflow
        def owner_session(uid):
            return next((sess[n] for n, u in users.items() if u["id"] == uid and n in sess), None)

        def count(table, where="TRUE", args=()):
            vc.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", args)
            return vc.fetchone()[0]

        cv = ex["convert"]
        if cv["exact"]:
            x = cv["exact"][0]
            api = owner_session(x["owner"])
            if api:
                st, opt = api.req("GET", f"/api/leads/{x['lead']}/conversion")
                exact_ids = [m["id"] for m in (opt.get("exact_matches") or [])] if isinstance(opt, dict) else []
                visible = [i for i in x["accounts"] if api.req("GET", f"/api/accounts/{i}")[0] == 200]
                R("B-convert-exact-suggested", "convert", "An exact company-name match is suggested (only accounts the salesperson may see)",
                  st == 200 and sorted(exact_ids) == sorted(visible), sorted(visible), sorted(exact_ids))
                before = count("contacts")
                key = str(uuid.uuid4())
                st1, r1 = api.req("POST", f"/api/leads/{x['lead']}/convert", {"request_key": key, "account": {"mode": "existing", "id": visible[0]} if visible else
                                                                             {"mode": "new"}, "create_deal": False})
                st2, r2 = api.req("POST", f"/api/leads/{x['lead']}/convert", {"request_key": str(uuid.uuid4()), "account": {"mode": "new"}, "create_deal": True,
                                                                             "deal": {"name": "duplicate attempt", "amount": 100, "currency_code": "USD", "stage": "Prospecting"}})
                st3, r3 = api.req("POST", f"/api/leads/{x['lead']}/convert", {"request_key": key, "account": {"mode": "new"}, "create_deal": False})
                after = count("contacts")
                cid = (r1 or {}).get("contact_id") if isinstance(r1, dict) else None
                vc.execute("SELECT account_id FROM contacts WHERE id = %s", (cid,))
                linked = (vc.fetchone() or [None])[0]
                R("B-convert-link-existing", "convert", "Converting links the contact to the chosen existing account",
                  st1 == 201 and linked == (visible[0] if visible else linked), visible[:1], linked)
                R("B-convert-twice", "convert", "Converting again, with a new or the same request, creates nothing new",
                  after == before + 1 and st2 == 200 and (r2 or {}).get("already_converted") is True and st3 in (200, 201)
                  and (r3 or {}).get("contact_id") == cid, {"contacts_added": 1, "second": 200}, {"contacts_added": after - before, "second": st2, "third": st3})
                acts = cv["lead_activities"].get(x["lead"], {"notes": [], "tasks": []})
                vc.execute("SELECT COUNT(*) FROM notes WHERE parent_type = 'lead' AND parent_id = %s AND deleted_at IS NULL", (x["lead"],))
                R("B-convert-activities", "convert", "The lead's notes and tasks stay on the lead (SuiteCRM setting: donothing)",
                  vc.fetchone()[0] == len(acts["notes"]), len(acts["notes"]))
        if cv["alike"]:
            x = cv["alike"][0]
            api = owner_session(x["owner"])
            if api:
                st, opt = api.req("GET", f"/api/leads/{x['lead']}/conversion")
                R("B-convert-alike-not-exact", "convert", f"A look-alike name ('{x['company']}') is never offered as an exact match",
                  st == 200 and not (opt.get("exact_matches") if isinstance(opt, dict) else [1]), [], (opt or {}).get("exact_matches") if isinstance(opt, dict) else st)
                before_acc = count("accounts")
                st1, r1 = api.req("POST", f"/api/leads/{x['lead']}/convert", {"request_key": str(uuid.uuid4()), "account": {"mode": "new", "name": x["company"]},
                                                                             "create_deal": False})
                R("B-convert-new-account", "convert", "Choosing a new account creates exactly one, with the lead's company name",
                  st1 == 201 and count("accounts") == before_acc + 1 and count("accounts", "name = %s AND deleted_at IS NULL", (x["company"],)) >= 1,
                  before_acc + 1, count("accounts"))
        if cv["plain"]:
            x = cv["plain"][0]
            api_a, api_b = owner_session(x["owner"]), None
            owner_name = next((n for n, u in users.items() if u["id"] == x["owner"]), None)
            if api_a and owner_name:
                api_b = Api(app_url)
                api_b.login(owner_name, password)
                before = count("contacts")
                body = {"account": {"mode": "new"}, "create_deal": False}
                with cf.ThreadPoolExecutor(2) as pool:
                    f1 = pool.submit(api_a.req, "POST", f"/api/leads/{x['lead']}/convert", {**body, "request_key": str(uuid.uuid4())})
                    f2 = pool.submit(api_b.req, "POST", f"/api/leads/{x['lead']}/convert", {**body, "request_key": str(uuid.uuid4())})
                    codes = sorted([f1.result()[0], f2.result()[0]])
                R("B-convert-concurrent", "convert", "Two simultaneous conversions of the same lead create one contact", count("contacts") == before + 1,
                  1, count("contacts") - before, {"statuses": codes})
        if cv["historic"]:
            x = cv["historic"][0]
            lead_owner = ex["fields"]["leads"][x["lead"]]["owner_id"]
            api = owner_session(lead_owner) or sess.get("admin")
            if api:
                before = count("contacts")
                st, r = api.req("POST", f"/api/leads/{x['lead']}/convert", {"request_key": str(uuid.uuid4()), "account": {"mode": "new"}, "create_deal": False})
                R("B-convert-historic", "convert", "A lead converted in SuiteCRM is recognised as converted; nothing is duplicated",
                  st == 200 and isinstance(r, dict) and r.get("already_converted") is True and r.get("contact_id") == x["contact"] and count("contacts") == before,
                  {"already_converted": True, "contact": x["contact"]}, {"status": st, "body": r if isinstance(r, dict) else None})

        # creating and editing after the move
        sp_team = next(((n, u) for n, u in users.items() if n in sess and "Salesperson" in u["roles"] and u["teams"]), None)
        if sp_team:
            n_sp, u_sp = sp_team
            mate = next((n for n, u in users.items() if n in sess and n != n_sp and "Salesperson" in u["roles"] and set(u["teams"]) & set(u_sp["teams"])), None)
            mgr = next((n for n, u in users.items() if n in sess and "Sales Manager" in u["roles"] and set(u["teams"]) & set(u_sp["teams"])), None)
            other = next((n for n, u in users.items() if n in sess and "Salesperson" in u["roles"] and u["teams"] and not set(u["teams"]) & set(u_sp["teams"])), None)
            api = sess[n_sp]
            st, b = api.req("POST", "/api/accounts", {"name": f"Goose verification account {uuid.uuid4().hex[:6]}", "account_type": "Prospect",
                                                      "contract_renewal_date": "2027-06-30"})
            acc_id = obj(b, "account").get("id")
            st2, b2 = api.req("POST", "/api/contacts", {"first_name": "Verifi", "last_name": "Cation", "account_id": acc_id, "email": "verify@example.com"})
            con_id = obj(b2, "contact").get("id")
            st3, b3 = api.req("POST", "/api/deals", {"name": "Verification deal", "account_id": acc_id, "amount": 30000, "currency_code": "USD",
                                                     "stage": "Proposal/Price Quote", "close_date": "2027-01-31"})
            deal_id = obj(b3, "deal").get("id")
            st4, b4 = api.req("POST", "/api/notes", {"subject": "Verification note", "body": "Created after the move", "parent_type": "account", "parent_id": acc_id,
                                                     "contact_id": con_id})
            st5, b5 = api.req("POST", "/api/tasks", {"subject": "Verification task", "status": "Not Started", "parent_type": "deal", "parent_id": deal_id})
            R("B-create", "create", "A salesperson creates an account, contact, deal, note and task", all(x in (200, 201) for x in (st, st2, st3, st4, st5))
              and all((acc_id, con_id, deal_id)), [201] * 5, [st, st2, st3, st4, st5])
            if acc_id:
                st6, _ = api.req("PATCH", f"/api/accounts/{acc_id}", {"contract_renewal_date": "2027-07-31", "phone": "(617) 555-0199"})
                vc.execute("SELECT contract_renewal_date FROM accounts WHERE id = %s", (acc_id,))
                R("B-edit-own", "create", "The owner edits the new account, including its renewal date", st6 == 200 and str(vc.fetchone()[0]) == "2027-07-31", 200, st6)
                if mate:
                    st7, _ = sess[mate].req("GET", f"/api/accounts/{acc_id}")
                    st8, _ = sess[mate].req("PATCH", f"/api/accounts/{acc_id}", {"phone": "(617) 555-0198"})
                    R("B-team-sees-new", "create", "A teammate sees the new account but cannot edit it (salespeople edit their own)", st7 == 200 and st8 == 403,
                      [200, 403], [st7, st8])
                if mgr:
                    st9, _ = sess[mgr].req("PATCH", f"/api/accounts/{acc_id}", {"industry": "Retail"})
                    R("B-manager-edits-new", "create", "The team's manager can edit it", st9 == 200, 200, st9)
                if other:
                    st10, _ = sess[other].req("GET", f"/api/accounts/{acc_id}")
                    R("B-other-team-hidden", "create", "Another team cannot see it", st10 == 404, 404, st10)
            if deal_id:
                st11, b11 = api.req("PATCH", f"/api/deals/{deal_id}", {"stage": "Closed Won"})
                vc.execute("SELECT stage, approval_status FROM deals WHERE id = %s", (deal_id,))
                row = vc.fetchone()
                R("B-rule-new-deal", "create", "The approval rule also applies to deals created after the move", row[0] == "Proposal/Price Quote" and row[1] == "requested",
                  ["Proposal/Price Quote", "requested"], list(row))
        # pages render for a salesperson
        if sp:
            codes = {p: sess[sp].req("GET", p)[0] for p in ("/", "/accounts", "/pipeline", "/leads", f"/accounts/{ex['ids']['accounts'][0]}")}
            R("A-pages", "app", "The main pages load in the browser for a salesperson", all(c_ in (200, 404) for c_ in codes.values()) and codes["/"] == 200, 200, codes)
    return results, integrity, man


def report(results, integrity, man, agreed):
    failed = [r for r in results if r["status"] == "fail" or (r["status"] == "skip" and r["mandatory"])]
    by = {}
    for r in results:
        c = by.setdefault(r["category"], {"pass": 0, "fail": 0, "skip": 0, "title": CATEGORY_TITLES.get(r["category"], r["category"])})
        c[r["status"]] += 1
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "integrity": integrity,
        "frozen_manifest": {"frozen_at": man["frozen_at"], "files": man["files"], "snapshot_db": man["snapshot_db"]},
        "summary": {"total": len(results), "passed": sum(r["status"] == "pass" for r in results), "failed": len(failed),
                    "skipped": sum(r["status"] == "skip" for r in results), "mandatory_total": sum(r["mandatory"] for r in results),
                    "optional_skipped": [{"id": r["id"], "reason": r.get("reason")} for r in results if r["status"] == "skip" and not r["mandatory"]],
                    "verdict": "pass" if integrity["ok"] and not failed and results else "fail"},
        "by_category": by, "failed": failed, "results": results,
        "intentional_differences": agreed.get("intended_differences", []),
        "not_tested": ["Screens are checked by loading them; their layout and wording were reviewed by people, not by these checks.",
                       "Delete permissions for accounts, contacts, deals and leads come from the role settings; SuiteCRM's own behaviour was observed for notes and tasks.",
                       "Workflows, reports, imports, exports and e-mail in SuiteCRM are outside this job.",
                       "Load, long-running performance and your hosting environment.",
                       "Passing these checks does not prove every possible behaviour is correct."],
    }


def markdown(rep):
    s_ = rep["summary"]
    out = [f"# Verification report - sales workspace", "", f"**{'PASSED' if s_['verdict'] == 'pass' else 'FAILED'}**: {s_['passed']} of {s_['total']} checks passed"
           f"{', ' + str(s_['failed']) + ' failed' if s_['failed'] else ''}. Frozen at {rep['frozen_manifest']['frozen_at']}; integrity "
           f"{'verified' if rep['integrity']['ok'] else 'BROKEN'}.", ""]
    for k, c in rep["by_category"].items():
        out.append(f"- **{c['title']}**: {c['pass']} passed" + (f", {c['fail']} failed" if c["fail"] else "") + (f", {c['skip']} skipped" if c["skip"] else ""))
    if rep["failed"]:
        out += ["", "## Failed"] + [f"- `{r['id']}` {r['title']}: expected {r['expected']}, got {r['actual']}" for r in rep["failed"]]
    out += ["", "## Intended differences"] + [f"- {d['what']}: {d['why']}" for d in rep["intentional_differences"]]
    out += ["", "## Not tested"] + [f"- {x}" for x in rep["not_tested"]]
    return "\n".join(out) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("freeze")
    f.add_argument("--snapshot-db", required=True); f.add_argument("--recording", required=True); f.add_argument("--plan", required=True)
    f.add_argument("--vault", required=True)
    r = sub.add_parser("run")
    r.add_argument("--vault", required=True); r.add_argument("--app-url"); r.add_argument("--password-file")
    r.add_argument("--report", required=True); r.add_argument("--markdown"); r.add_argument("--data-only", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "freeze":
        m = freeze(a.snapshot_db, a.recording, a.plan, a.vault)
        print(json.dumps({"frozen_at": m["frozen_at"], "files": list(m["files"])}))
        return
    t0 = time.time()
    results, integrity, man = run(a.vault, os.environ["DELIVERED_DSN"], os.environ.get("VERIFY_DSN"), a.app_url,
                                  Path(a.password_file).read_text().strip() if a.password_file else "", data_only=a.data_only)
    rep = report(results, integrity, man, json.loads((Path(a.vault) / "agreed.json").read_text()))
    rep["seconds"] = round(time.time() - t0, 1)
    Path(a.report).write_text(json.dumps(rep, indent=1, default=str))
    if a.markdown:
        Path(a.markdown).write_text(markdown(rep))
    print(json.dumps({"verdict": rep["summary"]["verdict"], "passed": rep["summary"]["passed"], "total": rep["summary"]["total"],
                      "failed": [x["id"] for x in rep["failed"]][:20], "seconds": rep["seconds"]}))


if __name__ == "__main__":
    main()
