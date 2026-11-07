"""Move the sales records of a SuiteCRM 7 snapshot (a workbench MySQL database) into the sales workspace's PostgreSQL schema.

Deterministic and re-runnable: with --replace the target schema is rebuilt from schema.sql and every row is written again in one
transaction, so a failed run leaves nothing half-moved. Ids are kept. Stored values are copied, not recomputed (for example the
US-dollar value of a deal is SuiteCRM's amount_usdollar, as the approval rule saw it). Rows that stay in SuiteCRM (notes on cases,
soft-deleted records) are counted in the report with the reason.

    TARGET_DSN=postgresql://... python -m goose_engine.suitecrm.migrate --source-db pw_1030_snapshot \
        --schema engine/targets/sales_workspace/schema.sql --config delivered/config.json --replace --report migration.json
"""
import argparse
import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import psycopg

from . import db as D

ENTITY = {"Accounts": "accounts", "Contacts": "contacts", "Leads": "leads", "Opportunities": "deals", "Notes": "notes", "Tasks": "tasks"}
PARENT = {"Accounts": "account", "Contacts": "contact", "Opportunities": "deal", "Leads": "lead"}
LEVEL = {90: "all", 80: "team", 75: "own", -99: "none", 89: "enabled", -98: "disabled"}
ACTIONS = {"access", "list", "view", "edit", "delete", "export"}


def utc(v):
    if v is None or v == "" or str(v).startswith("0000"):
        return None
    if isinstance(v, datetime):
        return v.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(str(v)).replace(tzinfo=timezone.utc)


def day(v):
    if v is None or v == "" or str(v).startswith("0000"):
        return None
    return str(v)[:10]


def blank(v):
    return None if v is None or (isinstance(v, str) and v.strip() == "") else v


def migrate(source_db, target_dsn, schema_sql, config, replace=True, users_without_access=()):
    t0 = time.time()
    src = D.connect(source_db)
    S = lambda sql, a=None: D.rows(src, sql, a)
    report = {"source_db": source_db, "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "rows": {}, "left_in_suitecrm": {},
              "warnings": []}
    custom = {f["source"].split(".")[1]: f["column"] for f in config.get("custom_fields", []) if f["entity"] == "accounts"}

    with psycopg.connect(target_dsn, autocommit=False) as pg:
        cur = pg.cursor()
        if replace:
            cur.execute("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;")
            cur.execute(Path(schema_sql).read_text())

        def put(table, cols, rows):
            if not rows:
                report["rows"][table] = 0
                return
            ph = ", ".join(["%s"] * len(cols))
            cur.executemany(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({ph})", rows)
            report["rows"][table] = len(rows)

        # teams, roles, permissions
        teams = S("SELECT id, name FROM securitygroups WHERE deleted = 0")
        put("teams", ["id", "name", "source"], [(t["id"], t["name"], "suitecrm") for t in teams])
        roles = S("SELECT id, name, description FROM acl_roles WHERE deleted = 0")
        put("roles", ["id", "name", "description", "source"], [(r["id"], r["name"], r["description"], "suitecrm") for r in roles])
        perms = []
        for r in S("""SELECT ra.role_id, a.category, a.name AS action, ra.access_override AS lvl FROM acl_roles_actions ra
                      JOIN acl_actions a ON a.id = ra.action_id AND a.deleted = 0 JOIN acl_roles r ON r.id = ra.role_id AND r.deleted = 0
                      WHERE ra.deleted = 0 AND a.acltype = 'module'"""):
            ent, lvl = ENTITY.get(r["category"]), LEVEL.get(int(r["lvl"]))
            if ent and lvl and r["action"] in ACTIONS:
                perms.append((r["role_id"], ent, r["action"], lvl))
        put("role_permissions", ["role_id", "entity", "action", "level"], perms)

        # users (SuiteCRM's password hashes are kept as they are; see the sign-in decision in the plan)
        emails = {}
        for r in S("""SELECT r.bean_module, r.bean_id, e.email_address FROM email_addr_bean_rel r JOIN email_addresses e ON e.id = r.email_address_id
                      AND e.deleted = 0 WHERE r.deleted = 0 ORDER BY r.primary_address DESC, r.date_created"""):
            emails.setdefault((r["bean_module"], r["bean_id"]), r["email_address"])
        prefs = {}
        for r in S("SELECT assigned_user_id AS u, contents FROM user_preferences WHERE category = 'global' AND deleted = 0"):
            try:
                import base64
                raw = base64.b64decode(r["contents"]).decode("utf-8", "ignore")
                m = re.search(r's:8:"timezone";s:\d+:"([^"]+)"', raw)
                if m:
                    prefs[r["u"]] = m.group(1)
            except Exception:
                pass
        users = S("SELECT id, user_name, first_name, last_name, title, status, is_admin, reports_to_id, user_hash FROM users WHERE deleted = 0")
        uids = {u["id"] for u in users}
        rows = []
        for u in users:
            active = u["status"] == "Active" and u["user_name"] not in users_without_access
            rows.append((u["id"], u["user_name"], u["first_name"], u["last_name"], u["title"], emails.get(("Users", u["id"])),
                         "active" if active else "inactive", bool(u["is_admin"]), None, u["user_hash"],
                         "suitecrm-bcrypt-md5" if u["user_hash"] else None, prefs.get(u["id"], "UTC"), "suitecrm"))
        put("users", ["id", "user_name", "first_name", "last_name", "title", "email", "status", "is_admin", "reports_to",
                      "password_hash", "password_scheme", "timezone", "source"], rows)
        cur.executemany("UPDATE users SET reports_to = %s WHERE id = %s",
                        [(u["reports_to_id"], u["id"]) for u in users if u["reports_to_id"] in uids])
        report["users_without_workspace_access"] = sorted(users_without_access)
        put("user_roles", ["user_id", "role_id"], [(r["user_id"], r["role_id"]) for r in S(
            "SELECT DISTINCT user_id, role_id FROM acl_roles_users ru WHERE deleted = 0 AND role_id IN (SELECT id FROM acl_roles WHERE deleted = 0)") if r["user_id"] in uids])
        put("user_teams", ["user_id", "team_id"], [(r["user_id"], r["securitygroup_id"]) for r in S(
            "SELECT DISTINCT user_id, securitygroup_id FROM securitygroups_users WHERE deleted = 0 AND securitygroup_id IN (SELECT id FROM securitygroups WHERE deleted = 0)") if r["user_id"] in uids])

        owner = lambda v: v if v in uids else None
        # currencies: SuiteCRM's default currency has id -99 and lives in config
        cfg_cur = config.get("default_currency", {"code": "USD", "name": "US Dollars", "symbol": "$"})
        cur_rows = [(cfg_cur["code"], cfg_cur["name"], cfg_cur["symbol"], Decimal("1"), "-99")]
        cur_code = {"-99": cfg_cur["code"]}
        for c in S("SELECT id, name, symbol, iso4217, conversion_rate FROM currencies WHERE deleted = 0"):
            cur_rows.append((c["iso4217"], c["name"], c["symbol"], Decimal(str(c["conversion_rate"])), c["id"]))
            cur_code[c["id"]] = c["iso4217"]
        put("currencies", ["code", "name", "symbol", "rate_per_usd", "source_id"], cur_rows)

        # accounts (+ custom fields from accounts_cstm)
        cust_cols = "".join(f", c.`{src}` AS `{dst}`" for src, dst in custom.items())
        accts = S(f"""SELECT a.*{cust_cols} FROM accounts a LEFT JOIN accounts_cstm c ON c.id_c = a.id WHERE a.deleted = 0""")
        acc_ids = {a["id"] for a in accts}
        put("accounts", ["id", "name", "account_type", "industry", "phone", "website", "billing_city", "billing_state", "billing_country",
                         "employees", "description", "contract_renewal_date", "owner_id", "created_by", "created_at", "updated_at", "source"],
            [(a["id"], a["name"], blank(a["account_type"]), blank(a["industry"]), blank(a["phone_office"]), blank(a["website"]),
              blank(a["billing_address_city"]), blank(a["billing_address_state"]), blank(a["billing_address_country"]), blank(a["employees"]),
              blank(a["description"]), day(a.get("contract_renewal_date")), owner(a["assigned_user_id"]), owner(a["created_by"]),
              utc(a["date_entered"]), utc(a["date_modified"]), "suitecrm") for a in accts])
        report["left_in_suitecrm"]["accounts (soft-deleted)"] = D.scalar(src, "SELECT COUNT(*) FROM accounts WHERE deleted = 1")

        # contacts: one account each (inspection checked that no contact has several)
        links = {}
        for r in S("SELECT account_id, contact_id FROM accounts_contacts WHERE deleted = 0 ORDER BY date_modified"):
            if r["account_id"] in acc_ids:
                if r["contact_id"] in links and links[r["contact_id"]] != r["account_id"]:
                    report["warnings"].append(f"contact {r['contact_id']} is linked to more than one account; kept the most recent link")
                links[r["contact_id"]] = r["account_id"]
        contacts = S("SELECT * FROM contacts WHERE deleted = 0")
        con_ids = {c["id"] for c in contacts}
        put("contacts", ["id", "first_name", "last_name", "title", "email", "phone", "city", "state", "lead_source", "description", "account_id",
                         "owner_id", "created_by", "created_at", "updated_at", "source"],
            [(c["id"], blank(c["first_name"]), c["last_name"] or "", blank(c["title"]), emails.get(("Contacts", c["id"])), blank(c["phone_work"]),
              blank(c["primary_address_city"]), blank(c["primary_address_state"]), blank(c["lead_source"]), blank(c["description"]),
              links.get(c["id"]), owner(c["assigned_user_id"]), owner(c["created_by"]), utc(c["date_entered"]), utc(c["date_modified"]), "suitecrm")
             for c in contacts])
        report["left_in_suitecrm"]["contacts (soft-deleted)"] = D.scalar(src, "SELECT COUNT(*) FROM contacts WHERE deleted = 1")

        # deals
        deal_acct = {}
        for r in S("SELECT account_id, opportunity_id FROM accounts_opportunities WHERE deleted = 0 ORDER BY date_modified"):
            if r["account_id"] in acc_ids:
                deal_acct[r["opportunity_id"]] = r["account_id"]
        has_cstm = bool(D.scalar(src, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'opportunities_cstm'"))
        sel = (", c.approval_status_c, c.user_id_c, c.approved_amount_c, c.approved_at_c" if has_cstm else "")
        join = " LEFT JOIN opportunities_cstm c ON c.id_c = o.id" if has_cstm else ""
        deals = S(f"SELECT o.*{sel} FROM opportunities o{join} WHERE o.deleted = 0")
        deal_ids = {d["id"] for d in deals}
        put("deals", ["id", "name", "account_id", "stage", "probability", "amount", "currency_code", "amount_usd", "close_date", "lead_source",
                      "next_step", "description", "approval_status", "approved_by", "approved_amount_usd", "approved_at", "owner_id", "created_by",
                      "created_at", "updated_at", "source"],
            [(d["id"], d["name"] or "", deal_acct.get(d["id"]), d["sales_stage"] or "", int(d["probability"]) if d["probability"] not in (None, "") else None,
              Decimal(str(d["amount"] or 0)), cur_code.get(d["currency_id"] or "-99", cfg_cur["code"]), Decimal(str(d["amount_usdollar"] or 0)),
              day(d["date_closed"]), blank(d["lead_source"]), blank(d["next_step"]), blank(d["description"]),
              (d.get("approval_status_c") or ""), owner(d.get("user_id_c")),
              Decimal(str(d["approved_amount_c"])) if d.get("approved_amount_c") is not None else None, utc(d.get("approved_at_c")),
              owner(d["assigned_user_id"]), owner(d["created_by"]), utc(d["date_entered"]), utc(d["date_modified"]), "suitecrm") for d in deals])
        report["left_in_suitecrm"]["deals (soft-deleted)"] = D.scalar(src, "SELECT COUNT(*) FROM opportunities WHERE deleted = 1")
        dc = {}
        for r in S("SELECT opportunity_id, contact_id, contact_role FROM opportunities_contacts WHERE deleted = 0"):
            if r["opportunity_id"] in deal_ids and r["contact_id"] in con_ids:
                dc[(r["opportunity_id"], r["contact_id"])] = blank(r["contact_role"])
        put("deal_contacts", ["deal_id", "contact_id", "role"], [(k[0], k[1], v) for k, v in dc.items()])

        # leads and their conversions
        leads = S("SELECT * FROM leads WHERE deleted = 0")
        lead_ids = {l["id"] for l in leads}
        keep = lambda v, ids: v if v in ids else None
        put("leads", ["id", "first_name", "last_name", "company", "title", "email", "phone", "city", "status", "lead_source", "description", "converted",
                      "converted_contact_id", "converted_account_id", "converted_deal_id", "owner_id", "created_by", "created_at", "updated_at", "source"],
            [(l["id"], blank(l["first_name"]), l["last_name"] or "", blank(l["account_name"]), blank(l["title"]), emails.get(("Leads", l["id"])),
              blank(l["phone_work"]), blank(l["primary_address_city"]), l["status"] or "New", blank(l["lead_source"]), blank(l["description"]),
              bool(l["converted"]), keep(l["contact_id"], con_ids), keep(l["account_id"], acc_ids), keep(l["opportunity_id"], deal_ids),
              owner(l["assigned_user_id"]), owner(l["created_by"]), utc(l["date_entered"]), utc(l["date_modified"]), "suitecrm") for l in leads])
        put("lead_conversions", ["lead_id", "request_key", "contact_id", "account_id", "deal_id", "account_created", "converted_by", "converted_at"],
            [(l["id"], None, l["contact_id"], keep(l["account_id"], acc_ids), keep(l["opportunity_id"], deal_ids), False,
              owner(l["modified_user_id"]), utc(l["date_modified"])) for l in leads if l["converted"] and l["contact_id"] in con_ids])

        # notes and tasks attached to sales records (the rest stays with SuiteCRM's cases etc.)
        ids_by_parent = {"account": acc_ids, "contact": con_ids, "deal": deal_ids, "lead": lead_ids}

        def attach(r):
            p = PARENT.get(r["parent_type"] or "")
            if p and r["parent_id"] in ids_by_parent[p]:
                return p, r["parent_id"]
            if not r["parent_type"] and r.get("contact_id") in con_ids:
                return "contact", r["contact_id"]
            return None, None

        def why_left(r):
            return "on support cases" if (r["parent_type"] or "") == "Cases" else (
                "on soft-deleted records" if PARENT.get(r["parent_type"] or "") else f"on {r['parent_type'] or 'nothing'}")

        notes, left = [], {}
        for n in S("SELECT * FROM notes WHERE deleted = 0"):
            p, pid = attach(n)
            if not p:
                left[why_left(n)] = left.get(why_left(n), 0) + 1
                continue
            notes.append((n["id"], n["name"] or "", blank(n["description"]), p, pid, keep(n["contact_id"], con_ids), owner(n["assigned_user_id"]),
                          owner(n["created_by"]), utc(n["date_entered"]), utc(n["date_modified"]), "suitecrm"))
        put("notes", ["id", "subject", "body", "parent_type", "parent_id", "contact_id", "owner_id", "created_by", "created_at", "updated_at", "source"], notes)
        for k, v in left.items():
            report["left_in_suitecrm"][f"notes {k}"] = v
        tasks, left = [], {}
        for t in S("SELECT * FROM tasks WHERE deleted = 0"):
            p, pid = attach(t)
            if not p:
                left[why_left(t)] = left.get(why_left(t), 0) + 1
                continue
            tasks.append((t["id"], t["name"] or "", t["status"] or "Not Started", blank(t["priority"]), utc(t["date_due"]), p, pid,
                          keep(t["contact_id"], con_ids), blank(t["description"]), owner(t["assigned_user_id"]), owner(t["created_by"]),
                          utc(t["date_entered"]), utc(t["date_modified"]), "suitecrm"))
        put("tasks", ["id", "subject", "status", "priority", "due_at", "parent_type", "parent_id", "contact_id", "description", "owner_id", "created_by",
                      "created_at", "updated_at", "source"], tasks)
        for k, v in left.items():
            report["left_in_suitecrm"][f"tasks {k}"] = v

        # team membership of records
        moved = {"accounts": acc_ids, "contacts": con_ids, "leads": lead_ids, "deals": deal_ids,
                 "notes": {n[0] for n in notes}, "tasks": {t[0] for t in tasks}}
        team_ids = {t["id"] for t in teams}
        rt = set()
        for r in S("SELECT DISTINCT module, record_id, securitygroup_id FROM securitygroups_records WHERE deleted = 0"):
            ent = ENTITY.get(r["module"])
            if ent and r["record_id"] in moved[ent] and r["securitygroup_id"] in team_ids:
                rt.add((ent, r["record_id"], r["securitygroup_id"]))
        put("record_teams", ["entity", "record_id", "team_id"], sorted(rt))

        # field history
        audit = []
        for tbl, ent in (("accounts_audit", "accounts"), ("contacts_audit", "contacts"), ("opportunities_audit", "deals"), ("leads_audit", "leads")):
            try:
                for a in S(f"SELECT * FROM `{tbl}`"):
                    if a["parent_id"] in moved[ent]:
                        audit.append((ent, a["parent_id"], a["field_name"], blank(a.get("before_value_string")) or blank(a.get("before_value_text")),
                                      blank(a.get("after_value_string")) or blank(a.get("after_value_text")), a["created_by"], utc(a["date_created"]), "suitecrm"))
            except Exception as e:  # table may not exist in older installs
                report["warnings"].append(f"{tbl}: {e}")
        put("audit_log", ["entity", "record_id", "field", "before", "after", "changed_by", "changed_at", "source"], audit)

        # links to what stays in SuiteCRM
        url = config.get("external", {}).get("record_url", "")
        ext = []
        for r in S("SELECT account_id AS id, COUNT(*) AS n FROM cases WHERE deleted = 0 AND account_id IS NOT NULL AND account_id <> '' GROUP BY account_id"):
            if r["id"] in acc_ids:
                ext.append(("accounts", r["id"], "SuiteCRM", "support cases", r["n"], url.format(module="Accounts", id=r["id"])))
        for t, kind in (("meetings", "meetings"), ("calls", "calls")):
            for r in S(f"SELECT parent_type AS pt, parent_id AS id, COUNT(*) AS n FROM `{t}` WHERE deleted = 0 GROUP BY parent_type, parent_id"):
                p = PARENT.get(r["pt"] or "")
                if p and r["id"] in ids_by_parent[p]:
                    ent = {"account": "accounts", "contact": "contacts", "deal": "deals", "lead": "leads"}[p]
                    ext.append((ent, r["id"], "SuiteCRM", kind, r["n"], url.format(module=r["pt"], id=r["id"])))
        put("external_links", ["entity", "record_id", "system", "kind", "count", "url"], ext)

        meta = {"source_system": config.get("source_system"), "migration": {"source_db": source_db, "finished_at": None}}
        cur.execute("INSERT INTO app_meta (key, value) VALUES ('source', %s)", (json.dumps(meta, default=str),))
        report["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        cur.execute("UPDATE app_meta SET value = jsonb_set(value, '{migration,finished_at}', to_jsonb(%s::text)) WHERE key = 'source'", (report["finished_at"],))
        pg.commit()
    report["seconds"] = round(time.time() - t0, 2)
    return report


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-db", required=True)
    ap.add_argument("--schema", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--replace", action="store_true")
    ap.add_argument("--no-access", default="", help="comma-separated user names migrated without sign-in")
    ap.add_argument("--report", required=True)
    a = ap.parse_args(argv)
    dsn = os.environ["TARGET_DSN"]
    cfg = json.loads(Path(a.config).read_text())
    r = migrate(a.source_db, dsn, a.schema, cfg, a.replace, tuple(x for x in a.no_access.split(",") if x))
    r["schema_sha256"] = hashlib.sha256(Path(a.schema).read_bytes()).hexdigest()
    Path(a.report).write_text(json.dumps(r, indent=1, default=str))
    print(json.dumps({"rows": r["rows"], "left": r["left_in_suitecrm"], "warnings": len(r["warnings"]), "seconds": r["seconds"]}))


if __name__ == "__main__":
    main()
