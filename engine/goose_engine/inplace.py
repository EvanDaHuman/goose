"""In-place framework upgrades that keep the application, its database and its behaviour.

Two deterministic execution tools:
  django  - Django to the 5.2 LTS release: rewrites removed APIs with django-upgrade (third-party, run unchanged),
            pins Django 5.2 and Python 3.13, and sets the settings whose defaults changed so behaviour stays the same.
  flask   - Flask and its libraries to the current releases on Python 3.13; rewrites the few removed imports that
            have a mechanical replacement.
Anything a tool cannot rewrite is reported in `manual`, for the implementation agent or the founder.

Usage:  python -m goose_engine.inplace --kind django|flask --repo SRC --out PKG --latest JSON --report R
"""
import argparse
import difflib
import re
import shutil
import subprocess
import sys
from pathlib import Path

from .inspect_app import DJANGO_REMOVALS, SKIP_DIRS
from .util import emit, read_json, write_json

DJANGO_LTS = "5.2"
TARGET_PYTHON = "3.13"
# Flask APIs removed in 2.x / 3.x: (pattern, what, mechanical replacement or None)
FLASK_REMOVALS = [
    (r"from flask import ([^\n]*\b)escape\b", "flask.escape", ("escape", "markupsafe")),
    (r"from flask import ([^\n]*\b)Markup\b", "flask.Markup", ("Markup", "markupsafe")),
    (r"\battachment_filename\s*=", "send_file(attachment_filename=)", ("attachment_filename", "download_name")),
    (r"\bcache_timeout\s*=", "send_file(cache_timeout=)", ("cache_timeout", "max_age")),
    (r"\bbefore_first_request\b", "before_first_request", None),
    (r"\bjson_encoder\b|\bjson_decoder\b|flask\.json\.JSONEncoder", "custom JSON encoder classes", None),
    (r"_request_ctx_stack|_app_ctx_stack", "context stacks", None),
    (r"JSON_SORT_KEYS|JSONIFY_PRETTYPRINT_REGULAR|JSON_AS_ASCII|JSONIFY_MIMETYPE", "JSON config keys", None),
    (r"from werkzeug\.urls import|werkzeug\.urls\.", "werkzeug.urls helpers", None),
]
FLASK_FAMILY = ("flask", "werkzeug", "jinja2", "markupsafe", "itsdangerous", "click", "blinker")


def copy_repo(src, out):
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(src, out, ignore=lambda d, names: [n for n in names if n in SKIP_DIRS or n.endswith((".pyc", ".db", ".sqlite"))])
    out.chmod(0o755)
    for p in out.rglob("*"):
        p.chmod(0o755 if p.is_dir() else 0o644)


def py_files(root):
    return sorted(p for p in root.rglob("*.py") if not any(x in SKIP_DIRS for x in p.parts))


def snapshot(root):
    return {str(p.relative_to(root)): p.read_text(errors="replace") for p in root.rglob("*")
            if p.is_file() and p.suffix in (".py", ".txt", ".html", ".cfg", ".toml", ".ini", ".md")}


def unified(before, after):
    out = []
    for name in sorted(set(before) | set(after)):
        a, b = before.get(name, ""), after.get(name, "")
        if a != b:
            out.extend(difflib.unified_diff(a.splitlines(), b.splitlines(), f"a/{name}", f"b/{name}", lineterm="", n=2))
    return "\n".join(out)


def set_pin(req, name, version, note=None):
    lines = req.read_text().splitlines() if req.exists() else []
    found = False
    for i, line in enumerate(lines):
        m = re.match(rf"^\s*({re.escape(name)})\s*(==|>=|~=|$)", line, re.I)
        if m:
            lines[i] = f"{m.group(1)}=={version}"     # keep the owner's spelling of the name
            found = True
    if not found:
        lines.append(f"{name}=={version}" + (f"  # {note}" if note else ""))
    req.write_text("\n".join(lines) + "\n")


def upgrade_django(out, latest, report):
    files = [str(p.relative_to(out)) for p in py_files(out) if "migrations" not in p.parts]
    tool = Path(sys.executable).with_name("django-upgrade")
    r = subprocess.run([str(tool), "--target-version", DJANGO_LTS, "--exit-zero-even-if-changed", *files],
                       cwd=out, capture_output=True, text=True)
    rewritten = sorted({m.strip().removeprefix("./") for m in re.findall(r"^Rewriting (.+)$", r.stdout + r.stderr, re.M)})
    report["actions"].append({"tool": f"django-upgrade {django_upgrade_version(tool)} --target-version {DJANGO_LTS}",
                              "files": rewritten, "exit": r.returncode})
    settings = next((p for p in py_files(out) if re.search(r"^INSTALLED_APPS\s*=", p.read_text(), re.M)), None)
    if settings:
        text = settings.read_text()
        added = []
        if not re.search(r"^USE_TZ\s*=", text, re.M):
            added.append("USE_TZ = False  # set explicitly: Django 5.0 changed the default to True, which would shift stored times")
        if not re.search(r"^DEFAULT_AUTO_FIELD\s*=", text, re.M):
            added.append('DEFAULT_AUTO_FIELD = "django.db.models.AutoField"  # the primary key type the tables already use')
        if added:
            settings.write_text(text.rstrip("\n") + "\n\n# --- kept as before by the Goose upgrade to Django 5.2 ---\n" + "\n".join(added) + "\n")
            report["actions"].append({"tool": "settings that keep current behaviour", "files": [str(settings.relative_to(out))],
                                      "settings": [a.split("  #")[0] for a in added]})
    set_pin(out / "requirements.txt", "Django", latest.get("django_lts", "5.2.19"))
    (out / "runtime.txt").write_text(f"python-{TARGET_PYTHON}\n")
    report["actions"].append({"tool": "pins", "files": ["requirements.txt", "runtime.txt"],
                              "pins": {"Django": latest.get("django_lts", "5.2.19"), "python": TARGET_PYTHON}})
    for p in py_files(out):
        if "migrations" in p.parts:
            continue
        for i, line in enumerate(p.read_text().splitlines(), 1):
            for pat, what, removed_in, _auto in DJANGO_REMOVALS:
                if re.search(pat, line) and not line.strip().startswith("#"):
                    report["manual"].append({"file": str(p.relative_to(out)), "line": i, "api": what, "text": line.strip()[:120]})
    for tpl in out.rglob("*.html"):
        for i, line in enumerate(tpl.read_text(errors="replace").splitlines(), 1):
            if re.search(r"\{\{\s*form\s*\}\}", line):
                report["manual"].append({"file": str(tpl.relative_to(out)), "line": i, "api": "{{ form }} rendering (div layout since 5.0)",
                                         "text": line.strip()[:120]})
    report["needs_makemigrations"] = True


def django_upgrade_version(tool):
    r = subprocess.run([str(tool), "--version"], capture_output=True, text=True)
    return (r.stdout or r.stderr).strip().split()[-1] if r.returncode == 0 else "?"


def upgrade_flask(out, latest, report):
    req = out / "requirements.txt"
    pinned = {m.group(1).lower(): m.group(2) for m in re.finditer(r"^\s*([A-Za-z0-9_.\-]+)\s*==\s*([\w.\-]+)", req.read_text() if req.exists() else "", re.M)}
    changed = {}
    for name in FLASK_FAMILY:
        if name in pinned or (name == "blinker" and "flask" in pinned):
            if latest.get(name) and pinned.get(name) != latest[name]:
                set_pin(req, name, latest[name], "required by Flask 2.3 and later" if name == "blinker" and name not in pinned else None)
                changed[name] = {"from": pinned.get(name), "to": latest[name]}
    (out / "runtime.txt").write_text(f"python-{TARGET_PYTHON}\n")
    report["actions"].append({"tool": "pins", "files": ["requirements.txt", "runtime.txt"], "pins": changed, "python": TARGET_PYTHON})
    for p in py_files(out):
        text = p.read_text()
        new = text
        for pat, what, fix in FLASK_REMOVALS:
            if not re.search(pat, new):
                continue
            if fix and fix[1] == "markupsafe":
                new = re.sub(rf"^(from flask import .*?)\b{fix[0]}\b,?\s*", r"\1", new, flags=re.M)
                new = re.sub(r"^from flask import\s*$\n", "", new, flags=re.M)
                new = f"from markupsafe import {fix[0]}\n" + new
            elif fix:
                new = re.sub(rf"\b{fix[0]}\s*=", f"{fix[1]}=", new)
            else:
                for i, line in enumerate(new.splitlines(), 1):
                    if re.search(pat, line):
                        report["manual"].append({"file": str(p.relative_to(out)), "line": i, "api": what, "text": line.strip()[:120]})
        if new != text:
            p.write_text(new)
            report["actions"].append({"tool": "mechanical Flask rewrites", "files": [str(p.relative_to(out))]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=["django", "flask"], required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--latest", required=True)
    ap.add_argument("--report", required=True)
    a = ap.parse_args()
    src, out = Path(a.repo), Path(a.out)
    copy_repo(src, out)
    before = snapshot(out)
    latest = read_json(a.latest)
    versions = {**latest.get("versions", {}), **{f"{k}_lts": v for k, v in (latest.get("lts") or {}).items()}}
    report = {"kind": a.kind, "actions": [], "manual": [], "target_python": TARGET_PYTHON}
    (upgrade_django if a.kind == "django" else upgrade_flask)(out, versions, report)
    after = snapshot(out)
    report["diff"] = unified(before, after)
    report["files_changed"] = sorted(n for n in set(before) | set(after) if before.get(n) != after.get(n))
    write_json(a.report, report)
    emit("inplace.done", kind=a.kind, files_changed=len(report["files_changed"]), manual=len(report["manual"]))


if __name__ == "__main__":
    main()
