"""Minimal client for SuiteCRM 7's REST API v4.1 (service/v4_1/rest.php), used only against Goose's own copies."""
import hashlib
import json
import urllib.parse
import urllib.request


class SuiteCRM:
    def __init__(self, base, user, password):
        self.url = base.rstrip("/") + "/service/v4_1/rest.php"
        r = self.call("login", {"user_auth": {"user_name": user, "password": hashlib.md5(password.encode()).hexdigest()},
                                "application_name": "goose-recorder", "name_value_list": []}, session=False)
        if not isinstance(r, dict) or "id" not in r:
            raise PermissionError(f"login refused for {user}: {r}")
        self.session = r["id"]
        self.user = user

    def call(self, method, args, session=True):
        rest = ({"session": self.session} if session else {}) | args
        data = urllib.parse.urlencode({"method": method, "input_type": "JSON", "response_type": "JSON",
                                       "rest_data": json.dumps(rest)}).encode()
        with urllib.request.urlopen(urllib.request.Request(self.url, data=data), timeout=60) as r:
            body = r.read().decode("utf-8", "ignore")
        try:
            return json.loads(body)
        except ValueError:
            return {"raw": body[:500]}

    @staticmethod
    def flat(entry):
        return {k: v["value"] for k, v in (entry.get("name_value_list") or {}).items()}

    def count(self, module, query=""):
        r = self.call("get_entries_count", {"module_name": module, "query": query, "deleted": 0})
        return int(r.get("result_count", -1)) if isinstance(r, dict) else -1

    def ids(self, module, query=""):
        """Every record id this user may list. One page: SuiteCRM 7.11 pages with an unordered OFFSET, and for some users
        the pages repeat some records and skip others (seen for the administrator's contacts and notes)."""
        r = self.call("get_entry_list", {"module_name": module, "query": query, "order_by": "", "offset": 0, "select_fields": ["id"],
                                          "link_name_to_fields_array": [], "max_results": 100000, "deleted": 0})
        if not isinstance(r, dict) or "entry_list" not in r:
            return {"error": r}
        out = [e["id"] for e in r["entry_list"]]
        total = int(r.get("total_count") or len(out))
        if len(set(out)) != total:
            return {"error": f"SuiteCRM returned {len(set(out))} distinct records of {total}"}
        return sorted(set(out))

    def paged_ids(self, module, page=200):
        """The same list read in pages, as SuiteCRM's own screens and most integrations do (kept to document the quirk)."""
        out, offset = [], 0
        while True:
            r = self.call("get_entry_list", {"module_name": module, "query": "", "order_by": "", "offset": offset, "select_fields": ["id"],
                                              "link_name_to_fields_array": [], "max_results": page, "deleted": 0})
            got = [e["id"] for e in (r or {}).get("entry_list", [])] if isinstance(r, dict) else []
            out += got
            if not got or int(r.get("next_offset", 0)) <= offset:
                return out
            offset = int(r["next_offset"])

    def get(self, module, id_, fields=()):
        r = self.call("get_entry", {"module_name": module, "id": id_, "select_fields": list(fields), "link_name_to_fields_array": []})
        if isinstance(r, dict) and r.get("entry_list"):
            e = r["entry_list"][0]
            vals = self.flat(e)
            if vals.get("warning") or (e.get("id") in (None, "") and not vals):
                return None
            return vals if vals.get("id") or vals else None
        return None

    def set(self, module, fields):
        r = self.call("set_entry", {"module_name": module, "name_value_list": [{"name": k, "value": v} for k, v in fields.items()]})
        return r
