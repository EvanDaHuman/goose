"""Helpers that keep the original API's responses where FastAPI and Flask differ."""
import json
from datetime import date, datetime, timezone
from email.utils import format_datetime
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .settings import settings

CENT = Decimal("0.01")


def round_cents(value):
    """The agreed money rule: exact decimal arithmetic, rounded half up to the cent."""
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def _default(o):
    if isinstance(o, Decimal):
        return float(o)
    if settings.datetime_format == "http_date" and isinstance(o, date):
        # what Flask's JSON encoder sent for datetimes: 'Wed, 05 Feb 2025 14:03:00 GMT'
        if not isinstance(o, datetime):
            o = datetime(o.year, o.month, o.day)
        o = o.replace(tzinfo=timezone.utc) if o.tzinfo is None else o.astimezone(timezone.utc)
        return format_datetime(o, usegmt=True)
    if isinstance(o, datetime):
        if o.tzinfo is not None:
            o = o.astimezone(settings.zone)
        return o.strftime(settings.datetime_format)
    if isinstance(o, date):
        return o.isoformat()
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


class LegacyJSONResponse(JSONResponse):
    """JSON encoded the way the old API sent it: money as numbers, dates as shop-time text."""

    def render(self, content):
        return json.dumps(content, default=_default, sort_keys=True, separators=(",", ":")).encode("utf-8")


def jsonify(*args, status=200, **kwargs):
    if args and kwargs:
        raise TypeError("jsonify() takes either positional or keyword arguments")
    content = kwargs if kwargs else (args[0] if len(args) == 1 else list(args))
    return LegacyJSONResponse(content=content, status_code=status)


def respond(value, status=None, headers=None):
    """Turn what a Flask view returned into a response, keeping its status code."""
    if isinstance(value, Response):
        if status is not None:
            value.status_code = status
    elif isinstance(value, (dict, list)):
        value = LegacyJSONResponse(content=value, status_code=status or 200)
    else:
        value = Response(content=str(value), status_code=status or 200, media_type="text/html")
    if headers:
        for k, v in dict(headers).items():
            value.headers[k] = v
    return value


def abort(status_code, description=None):
    raise HTTPException(status_code=status_code, detail=description)


def json_body(force=False, silent=False):
    """Dependency that reads the request body like Flask's request.get_json(force, silent)."""

    async def read(request: Request):
        raw = await request.body()
        is_json = (request.headers.get("content-type") or "").split(";")[0].strip().endswith("json")
        if not force and not is_json:
            return None
        if not raw:
            if silent:
                return None
            raise HTTPException(status_code=400, detail="Failed to decode JSON object")
        try:
            return json.loads(raw)
        except ValueError:
            if silent:
                return None
            raise HTTPException(status_code=400, detail="Failed to decode JSON object")

    return read


def query_get(params, key, default=None, type=None):
    """request.args.get(key, default, type=...) from Flask, on Starlette's query parameters."""
    value = params.get(key)
    if value is None:
        return default
    if type is not None:
        try:
            return type(value)
        except (TypeError, ValueError):
            return default
    return value
