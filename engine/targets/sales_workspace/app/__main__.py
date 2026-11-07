"""``python -m app``: serve the workspace with uvicorn.

Environment: DATABASE_URL, SESSION_SECRET, WORKSPACE_CONFIG (path to config.json), HOST (default 127.0.0.1),
PORT (default 8090).
"""
from __future__ import annotations

import logging
import sys

import uvicorn

from .config import ConfigError, Settings, load_workspace_config
from .main import create_app


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        settings = Settings.from_env()
        cfg = load_workspace_config(settings.workspace_config)
    except ConfigError as exc:
        print(f"sales workspace: {exc}", file=sys.stderr)
        return 2
    app = create_app(settings, cfg)
    uvicorn.run(app, host=settings.host, port=settings.port, proxy_headers=False, access_log=True,
                log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
