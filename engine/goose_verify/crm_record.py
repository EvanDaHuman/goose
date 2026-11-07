"""Record how the ORIGINAL SuiteCRM behaves, on Goose's disposable copy (never the customer's live system), before anything
is built: who can sign in, what each user can list, view and edit, and what the approval rule does in each scenario. The
verifier later replays the same requests against the delivered workspace and compares.

Users' passwords on the copy are replaced with a recording password (the copy is ours; the customer's hashes are untouched in the
snapshot). Every scenario starts from the snapshot's values for the deal it uses.

    python -m goose_verify.crm_record --url http://localhost:8181 --copy-db pw_1030_original --snapshot-db pw_1030_snapshot \
        --password-file F --out recording.json
"""
import argparse
import json
import random
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from goose_engine.suitecrm import db as D
from goose_engine.suitecrm.rest import SuiteCRM

MODULES = ["Accounts", "Contacts", "Leads", "Opportunities", "Notes", "Tasks"]
WON = "Closed Won"


def deal_state(c, id_):
    r = D.one(c, """SELECT o.sales_stage AS stage, o.amount, o.amount_usdollar AS usd, o.currency_id, o.deleted,
                           x.approval_status_c AS approval, x.user_id_c AS approved_by, x.approved_amount_c AS approved_amount
                    FROM opportunities o LEFT JOIN opportunities_cstm x ON x.id_c = o.id WHERE o.id = %s""", (id_,))
    if not r:
        return None
    return {"stage": r["stage"], "amount": float(r["amount"]), "usd": round(float(r["usd"]), 2), "approval": r["approval"] or "",
            "approved_by": r["approved_by"], "approved_amount": float(r["approved_amount"]) if r["approved_amount"] is not None else None}


def restore_deal(c, snap, id_):
    for t, k in (("opportunities", "id"), ("opportunities_cstm", "id_c")):
        D.rows(c, f"DELETE FROM `{t}` WHERE {k} = %s", (id_,))
        D.rows(c, f"INSERT INTO `{t}` SELECT * FROM `{snap}`.`{t}` WHERE {k} = %s", (id_,))


def record(url, copy_db, snap_db, password, seed=7):
    rnd = random.Random(seed)
    root = D.connect(copy_db, user="root")
    q = lambda sql, a=None: D.rows(root, sql, a)
    users = q("""SELECT u.id, u.user_name, u.status, u.is_admin,
                        (SELECT GROUP_CONCAT(r.name) FROM acl_roles_users ru JOIN acl_roles r ON r.id = ru.role_id AND r.deleted = 0
                          WHERE ru.user_id = u.id AND ru.deleted = 0) AS roles,
                        (SELECT GROUP_CONCAT(g.name) FROM securitygroups_users su JOIN securitygroups g ON g.id = su.securitygroup_id AND g.deleted = 0
                          WHERE su.user_id = u.id AND su.deleted = 0) AS teams
                 FROM users u WHERE u.deleted = 0 ORDER BY u.user_name""")
    out = {"recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "original": url, "copy_db": copy_db,
           "snapshot_db": snap_db, "users": {}, "lists": {}, "views": [], "edits": [], "deletes": [], "scenarios": [], "observations": []}
    sessions = {}
    for u in users:
        try:
            sessions[u["user_name"]] = SuiteCRM(url, u["user_name"], password)
            ok = True
        except PermissionError:
            ok = False
        out["users"][u["user_name"]] = {"id": u["id"], "status": u["status"], "is_admin": bool(u["is_admin"]),
                                        "roles": (u["roles"] or "").split(",") if u["roles"] else [],
                                        "teams": (u["teams"] or "").split(",") if u["teams"] else [], "can_sign_in": ok}
    # what each user can list (SuiteCRM applies roles and security groups to get_entry_list)
    for name, s in sessions.items():
        out["lists"][name] = {}
        for m in MODULES:
            ids = s.ids(m)
            out["lists"][name][m] = sorted(ids) if isinstance(ids, list) else {"error": str(ids)[:200]}
        for m in MODULES:
            whole = out["lists"][name][m]
            if isinstance(whole, list) and len(whole) > 200:
                paged = s.paged_ids(m)
                if len(set(paged)) != len(whole):
                    out["observations"].append({"user": name, "what": f"SuiteCRM's API repeats and skips {m.lower()} when it reads them 200 at a time",
                                                "count": len(paged), "distinct": len(set(paged)), "listable": len(whole)})
        cnt = s.count("Accounts")
        if isinstance(out["lists"][name]["Accounts"], list) and cnt != len(out["lists"][name]["Accounts"]):
            out["observations"].append({"user": name, "what": "get_entries_count('Accounts') ignores record visibility",
                                        "count": cnt, "listable": len(out["lists"][name]["Accounts"])})
    # view: a deterministic sample of records per module, across owners and teams
    sample = {}
    for m, t in (("Accounts", "accounts"), ("Contacts", "contacts"), ("Leads", "leads"), ("Opportunities", "opportunities"),
                 ("Notes", "notes"), ("Tasks", "tasks")):
        rows = q(f"""SELECT x.id, u.user_name AS owner, (SELECT g.name FROM securitygroups_records r JOIN securitygroups g ON g.id = r.securitygroup_id
                     WHERE r.record_id = x.id AND r.deleted = 0 LIMIT 1) AS team FROM `{t}` x LEFT JOIN users u ON u.id = x.assigned_user_id
                     WHERE x.deleted = 0 {"AND (x.parent_type IS NULL OR x.parent_type <> 'Cases')" if t in ("notes", "tasks") else ""} ORDER BY x.id""")
        by = {}
        for r in rows:
            by.setdefault((r["owner"], r["team"]), []).append(r["id"])
        pick = []
        for k in sorted(by, key=lambda k: (str(k[0]), str(k[1]))):
            pick += rnd.sample(by[k], min(2, len(by[k])))
        sample[m] = pick
    out["sample"] = sample
    for name, s in sessions.items():
        for m, ids in sample.items():
            for i in ids:
                out["views"].append({"user": name, "module": m, "id": i, "visible": s.get(m, i, ["id"]) is not None})
    # edit: a harmless change to the description, read back from the database, then put back
    table = {"Accounts": "accounts", "Contacts": "contacts", "Leads": "leads", "Opportunities": "opportunities", "Notes": "notes", "Tasks": "tasks"}
    for name, s in sessions.items():
        for m, ids in sample.items():
            for i in ids:
                before = D.one(root, f"SELECT description, date_modified FROM `{table[m]}` WHERE id = %s", (i,))
                marker = f"gs-probe-{name}"
                r = s.set(m, {"id": i, "description": marker})
                after = D.one(root, f"SELECT description FROM `{table[m]}` WHERE id = %s", (i,))
                changed = (after or {}).get("description") == marker
                out["edits"].append({"user": name, "module": m, "id": i, "allowed": changed,
                                     "response": "error" if isinstance(r, dict) and r.get("name") else "ok"})
                D.rows(root, f"UPDATE `{table[m]}` SET description = %s, date_modified = %s WHERE id = %s",
                       (before["description"], before["date_modified"], i))
                if m == "Opportunities":
                    restore_deal(root, snap_db, i)
    # delete: observed on notes and tasks (no linked records to restore); for other modules the verifier uses the role settings
    for name, s in sessions.items():
        for m in ("Notes", "Tasks"):
            for i in sample[m]:
                s.set(m, {"id": i, "deleted": 1})
                d = D.scalar(root, f"SELECT deleted FROM `{table[m]}` WHERE id = %s", (i,))
                out["deletes"].append({"user": name, "module": m, "id": i, "allowed": int(d or 0) == 1})
                D.rows(root, f"UPDATE `{table[m]}` SET deleted = 0 WHERE id = %s", (i,))
                D.rows(root, "UPDATE securitygroups_records SET deleted = 0 WHERE record_id = %s", (i,))

    # approval scenarios
    out["scenarios"] = scenarios(root, snap_db, sessions, out["users"])
    return out


def scenarios(root, snap, sessions, users):
    T = 25000.0
    rows = lambda sql, a=None: D.rows(root, sql, a)
    team_of = {n: u["teams"] for n, u in users.items()}
    managers = {t: [n for n, u in users.items() if "Sales Manager" in u["roles"] and t in u["teams"] and u["can_sign_in"]]
                for u in users.values() for t in u["teams"]}
    sellers = {t: [n for n, u in users.items() if "Salesperson" in u["roles"] and t in u["teams"] and u["can_sign_in"]]
               for u in users.values() for t in u["teams"]}
    open_deals = rows("""SELECT o.id, o.name, o.amount, o.amount_usdollar AS usd, o.currency_id, u.user_name AS owner, x.approval_status_c AS approval
                         FROM opportunities o JOIN users u ON u.id = o.assigned_user_id LEFT JOIN opportunities_cstm x ON x.id_c = o.id
                         WHERE o.deleted = 0 AND o.sales_stage NOT IN ('Closed Won','Closed Lost') AND u.status = 'Active' ORDER BY o.id""")
    def owner_ok(d):
        return d["owner"] in sessions and any(managers.get(t) for t in team_of.get(d["owner"], []))
    big = [d for d in open_deals if owner_ok(d) and float(d["usd"]) > T and not d["approval"] and d["currency_id"] in ("-99", None)]
    eur = [d for d in open_deals if owner_ok(d) and float(d["amount"]) <= T < float(d["usd"])]
    just = [d for d in open_deals if owner_ok(d) and T < float(d["usd"]) <= T + 1]
    rejected = [d for d in open_deals if owner_ok(d) and d["approval"] == "rejected"]
    out = []

    def run(name, deal, steps, why):
        restore_deal(root, snap, deal["id"])
        initial = deal_state(root, deal["id"])
        results = []
        for who, changes in steps:
            s = sessions[who]
            resp = s.set("Opportunities", {"id": deal["id"], **changes})
            st = deal_state(root, deal["id"])
            approver = D.scalar(root, "SELECT user_name FROM users WHERE id = %s", (st["approved_by"],)) if st["approved_by"] else None
            results.append({"user": who, "changes": changes, "refused": bool(isinstance(resp, dict) and resp.get("name")),
                            "after": {**{k: v for k, v in st.items() if k != "approved_by"}, "approved_by": approver}})
        out.append({"id": name, "why": why, "deal_id": deal["id"], "deal_name": deal["name"], "initial": initial, "steps": results})
        restore_deal(root, snap, deal["id"])

    if big:
        d = big[0]
        t = team_of[d["owner"]][0]
        mgr = managers[t][0]
        mate = next((x for x in sellers[t] if x != d["owner"]), None)
        other_t = next((x for x in managers if x != t and managers[x]), None)
        run("S-close-blocked", d, [(d["owner"], {"sales_stage": WON})], "A salesperson marks a deal above the threshold as won without approval.")
        run("S-self-approve", d, [(d["owner"], {"approval_status_c": "approved"})], "A salesperson tries to approve their own deal.")
        if mate:
            run("S-teammate-approve", d, [(mate, {"approval_status_c": "approved"})], "Another salesperson on the team tries to approve it.")
        if other_t:
            run("S-other-team-manager", d, [(managers[other_t][0], {"approval_status_c": "approved"})], "A manager of another team tries to approve it.")
        run("S-manager-approve-then-close", d, [(mgr, {"approval_status_c": "approved"}), (d["owner"], {"sales_stage": WON})],
            "The team's manager approves; then the salesperson marks it won.")
        run("S-raise-after-approval", d, [(mgr, {"approval_status_c": "approved"}), (d["owner"], {"amount": round(float(d["amount"]) * 1.1, 2)}),
                                          (d["owner"], {"sales_stage": WON})],
            "After approval the salesperson raises the amount, then tries to close.")
        run("S-manager-approves-and-closes", d, [(mgr, {"approval_status_c": "approved", "sales_stage": WON})],
            "The team's manager approves and closes in one save.")
        run("S-request", d, [(d["owner"], {"approval_status_c": "requested"})], "A salesperson requests approval.")
        if "admin" in sessions:
            run("S-admin-close-without-approval", d, [("admin", {"sales_stage": WON})], "An administrator marks it won without an approval.")
    if eur:
        d = eur[0]
        run("S-converted-currency", d, [(d["owner"], {"sales_stage": WON})],
            "A deal entered below $25,000 in another currency but worth more in US dollars is marked won.")
    if just:
        d = just[0]
        run("S-just-above", d, [(d["owner"], {"sales_stage": WON})], "A deal one cent above the threshold is marked won.")
    if rejected:
        d = rejected[0]
        run("S-rejected-close", d, [(d["owner"], {"sales_stage": WON})], "A deal whose approval was rejected is marked won.")
    # a new deal at exactly the threshold, created and closed by a salesperson
    seller = next((n for t, xs in sellers.items() for n in xs if managers.get(t)), None)
    acct = D.one(root, """SELECT a.id FROM accounts a JOIN users u ON u.id = a.assigned_user_id WHERE a.deleted = 0 AND u.user_name = %s ORDER BY a.id LIMIT 1""",
                 (seller,)) if seller else None
    if seller and acct:
        s = sessions[seller]
        r = s.set("Opportunities", {"name": "Goose recording: threshold deal", "account_id": acct["id"], "amount": T,
                                     "sales_stage": "Negotiation/Review", "date_closed": "2026-12-31", "currency_id": "-99"})
        new_id = r.get("id") if isinstance(r, dict) else None
        if new_id:
            s.set("Opportunities", {"id": new_id, "sales_stage": WON})
            st = deal_state(root, new_id)
            out.append({"id": "S-exactly-threshold-new", "why": "A new deal of exactly $25,000.00 is created and marked won by a salesperson.",
                        "deal_id": None, "create": {"user": seller, "account_id": acct["id"], "amount": T, "stage": "Negotiation/Review"},
                        "steps": [{"user": seller, "changes": {"sales_stage": WON}, "after": {**{k: v for k, v in st.items() if k != "approved_by"},
                                                                                               "approved_by": None}}]})
            D.rows(root, "UPDATE opportunities SET deleted = 1 WHERE id = %s", (new_id,))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--copy-db", required=True)
    ap.add_argument("--snapshot-db", required=True)
    ap.add_argument("--password-file", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    t0 = time.time()
    rec = record(a.url, a.copy_db, a.snapshot_db, Path(a.password_file).read_text().strip())
    rec["seconds"] = round(time.time() - t0, 1)
    Path(a.out).write_text(json.dumps(rec, indent=1, default=str))
    print(json.dumps({"users": len(rec["users"]), "views": len(rec["views"]), "edits": len(rec["edits"]), "deletes": len(rec["deletes"]),
                      "scenarios": [s["id"] for s in rec["scenarios"]], "observations": len(rec["observations"]), "seconds": rec["seconds"]}))


if __name__ == "__main__":
    main()
