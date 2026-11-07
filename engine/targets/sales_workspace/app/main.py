"""Application factory."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import psycopg
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.concurrency import run_in_threadpool

from . import __version__, api, pages
from .auth import SessionCodec
from .config import Settings, WorkspaceConfig, load_workspace_config
from .db import make_pool
from .services.base import ServiceError

log = logging.getLogger("sales_workspace")
STATIC_DIR = Path(__file__).resolve().parent / "static"

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
        "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"
    ),
}


def _is_api(request: Request) -> bool:
    return request.url.path.startswith("/api/") or request.url.path == "/api"


def create_app(settings: Settings | None = None, cfg: WorkspaceConfig | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    cfg = cfg or load_workspace_config(settings.workspace_config)
    pool = make_pool(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        pool.open(wait=False)
        try:
            yield
        finally:
            pool.close()

    app = FastAPI(
        title=f"{cfg.workspace_name} API",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings
    app.state.cfg = cfg
    app.state.pool = pool
    app.state.sessions = SessionCodec(settings.session_secret, settings.session_hours * 3600)
    app.state.templates = pages.make_templates(cfg)

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    app.include_router(api.router)
    app.include_router(pages.router)

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        def check():
            with pool.connection(timeout=5) as conn:
                conn.execute("SELECT 1")

        try:
            await run_in_threadpool(check)
        except Exception:  # database unreachable
            return api.out({"ok": False, "detail": "database unavailable"}, 503)
        return api.out({"ok": True})

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        if not request.url.path.startswith("/static/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(ServiceError)
    async def service_error(request: Request, exc: ServiceError):
        if _is_api(request):
            return api.out(exc.payload(), exc.status)
        return pages.error_response(request, exc.status, exc.detail)

    @app.exception_handler(pages.LoginRequired)
    async def login_required(request: Request, exc: pages.LoginRequired):
        return pages.login_redirect(request)

    @app.exception_handler(psycopg.DataError)
    async def data_error(request: Request, exc: psycopg.DataError):
        # A value the database cannot take (e.g. a NUL character in a query parameter): the request is invalid.
        detail = "The request contains a value the database cannot store or compare."
        if _is_api(request):
            return api.out({"detail": detail}, 422)
        return pages.error_response(request, 422, detail)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        errors = []
        for err in exc.errors():
            loc = ".".join(str(p) for p in err.get("loc", ()) if p not in ("query", "path", "body"))
            errors.append({"field": loc, "message": err.get("msg", "Invalid value.")})
        detail = "; ".join(f"{e['field']}: {e['message']}" if e["field"] else e["message"] for e in errors) or "Invalid request."
        if _is_api(request):
            return api.out({"detail": detail, "errors": errors}, 422)
        return pages.error_response(request, 422, detail)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
        if exc.status_code == 404:
            detail = "Not found."
        if _is_api(request) or exc.status_code not in (404, 405):
            response = api.out({"detail": detail}, exc.status_code)
        else:
            response = pages.error_response(request, exc.status_code, detail)
        for name, value in (exc.headers or {}).items():
            response.headers[name] = value
        return response

    return app
