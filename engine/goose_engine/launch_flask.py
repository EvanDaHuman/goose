"""Start a customer's Flask application on a given port, without running its own start-up block.

Runs inside the customer-code sandbox with the original app's own Python and libraries. Imports the
module that exposes the app as a normal (package-aware) import from APP_ROOT, then uses the Flask
object named `app` or `application`, or calls `create_app()`, and serves it with Werkzeug.

Usage:  APP_ROOT=DIR python launch_flask.py MODULE_FILE PORT
"""
import importlib
import os
import sys


def main():
    module_file, port = os.path.abspath(sys.argv[1]), int(sys.argv[2])
    root = os.path.abspath(os.environ.get("APP_ROOT") or os.path.dirname(module_file))
    sys.path.insert(0, root)
    parts = os.path.relpath(module_file, root)[:-3].split(os.sep)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    mod = importlib.import_module(".".join(parts))
    app = getattr(mod, "app", None) or getattr(mod, "application", None)
    if app is None and hasattr(mod, "create_app"):
        app = mod.create_app()
    if app is None:
        raise SystemExit("no Flask application object found")
    from werkzeug.serving import run_simple
    run_simple("127.0.0.1", port, app, threaded=True, use_reloader=False, use_debugger=False)


if __name__ == "__main__":
    main()
