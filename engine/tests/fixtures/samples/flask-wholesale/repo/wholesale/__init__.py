"""Sample Roasters - wholesale order API (SAMPLE APPLICATION (test fixture), synthetic data)."""
import os

from flask import Flask


def create_app():
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_mapping(
        DATABASE=os.environ.get("WHOLESALE_DB", os.path.join(app.instance_path, "wholesale.sqlite")),
    )
    os.makedirs(app.instance_path, exist_ok=True)

    from . import db, api
    db.init_app(app)
    app.register_blueprint(api.bp)

    @app.route("/ping")
    def ping():
        return {"ok": True}

    return app
