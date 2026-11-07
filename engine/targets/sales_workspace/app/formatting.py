"""Display formatting for the pages: money with tabular figures, dates as "31 Mar 2027" with a relative hint."""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "CAD": "CA$", "AUD": "A$", "CHF": "CHF "}


def _decimal(value) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _group(amount: Decimal, places: int) -> str:
    quant = Decimal(1).scaleb(-places) if places else Decimal(1)
    rounded = amount.quantize(quant, rounding=ROUND_HALF_UP)
    return f"{rounded:,.{places}f}"


def money(amount, code: str | None = "USD", symbol: str | None = None, places: int = 2) -> str:
    value = _decimal(amount)
    if value is None:
        return "—"
    code = code or "USD"
    sym = symbol if symbol else SYMBOLS.get(code)
    sign = "-" if value < 0 else ""
    body = _group(abs(value), places)
    return f"{sign}{sym}{body}" if sym else f"{sign}{body} {code}"


def usd(amount, places: int = 2) -> str:
    return money(amount, "USD", "$", places)


def usd0(amount) -> str:
    return money(amount, "USD", "$", 0)


def usd_compact(amount) -> str:
    value = _decimal(amount)
    if value is None:
        return "—"
    absval = abs(value)
    if absval >= Decimal("1000000"):
        return f"${(value / Decimal(1000000)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP):,}M".replace(".00M", "M")
    if absval >= Decimal("1000"):
        return f"${(value / Decimal(1000)).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP):,}k".replace(".0k", "k")
    return usd0(value)


def as_date(value) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def today() -> date:
    return datetime.now(timezone.utc).date()


def date_fmt(value) -> str:
    d = as_date(value)
    if d is None:
        return "—"
    return f"{d.day} {d:%b} {d.year}"


def date_input(value) -> str:
    d = as_date(value)
    return d.isoformat() if d else ""


def days_from_today(value) -> int | None:
    d = as_date(value)
    return None if d is None else (d - today()).days


def plural(n: int, word: str) -> str:
    if n == 1:
        return f"{n} {word}"
    suffix = "es" if word.endswith(("s", "x", "ch", "sh")) else "s"
    return f"{n} {word}{suffix}"


def relative_day(value) -> str:
    days = days_from_today(value)
    if days is None:
        return ""
    if days == 0:
        return "today"
    if days == 1:
        return "tomorrow"
    if days == -1:
        return "yesterday"
    return f"in {plural(days, 'day')}" if days > 0 else f"{plural(-days, 'day')} ago"


def renewal_hint(value) -> str:
    days = days_from_today(value)
    if days is None:
        return ""
    if days == 0:
        return "renews today"
    if days == 1:
        return "renews tomorrow"
    if days > 0:
        return f"renews in {plural(days, 'day')}"
    return f"renewal was {plural(-days, 'day')} ago"


def renewal_tone(value, window: int = 90) -> str:
    days = days_from_today(value)
    if days is None:
        return "none"
    if days < 0:
        return "overdue"
    if days <= 30:
        return "urgent"
    if days <= window:
        return "soon"
    return "later"


def _local(value, tz: str | None = None) -> datetime | None:
    if value is None or value == "":
        return None
    if not isinstance(value, datetime):
        try:
            value = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    try:
        return value.astimezone(ZoneInfo(tz or "UTC"))
    except Exception:
        return value.astimezone(timezone.utc)


def datetime_fmt(value, tz: str | None = None) -> str:
    local = _local(value, tz)
    if local is None:
        return "—"
    return f"{local.day} {local:%b} {local.year}, {local:%H:%M}"


def ago(value) -> str:
    local = _local(value)
    if local is None:
        return ""
    seconds = (datetime.now(timezone.utc) - local).total_seconds()
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{plural(int(seconds // 60), 'minute')} ago"
    if seconds < 86400:
        return f"{plural(int(seconds // 3600), 'hour')} ago"
    days = int(seconds // 86400)
    if days < 45:
        return "yesterday" if days == 1 else f"{days} days ago"
    return date_fmt(local)


def due_label(value, is_open: bool = True) -> tuple[str, str]:
    """(text, tone) for a task due date: tone is overdue | today | soon | later | none."""
    d = as_date(value)
    if d is None:
        return "No due date", "none"
    days = (d - today()).days
    if not is_open:
        return f"Due {date_fmt(d)}", "none"
    if days < 0:
        return f"Overdue · {date_fmt(d)}", "overdue"
    if days == 0:
        return "Due today", "today"
    if days == 1:
        return "Due tomorrow", "soon"
    if days <= 7:
        return f"Due in {days} days", "soon"
    return f"Due {date_fmt(d)}", "later"


def initials(name: str | None) -> str:
    parts = [p for p in (name or "").replace("(", " ").split() if p[:1].isalpha()]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def percent(value) -> str:
    return "—" if value is None else f"{int(value)}%"


APPROVAL_LABELS = {"": "Not requested", "requested": "Approval requested", "approved": "Approved", "rejected": "Rejected"}
APPROVAL_SHORT = {"": "", "requested": "Requested", "approved": "Approved", "rejected": "Rejected"}


def approval_label(status: str | None, short: bool = False) -> str:
    return (APPROVAL_SHORT if short else APPROVAL_LABELS).get(status or "", status or "")


def short_deal_name(name: str | None, account_name: str | None) -> str:
    """'Acme Supply – Warehouse shelving' shown on Acme Supply's own page as 'Warehouse shelving'."""
    name = name or ""
    if account_name and name.lower().startswith(account_name.lower()):
        rest = name[len(account_name):].lstrip()
        for sep in ("–", "—", "-", ":", "|", "·"):
            if rest.startswith(sep) and rest[len(sep):].strip():
                return rest[len(sep):].strip()
    return name


def wbr(text: str | None):
    """Allow a line break after '/' in labels such as 'Negotiation/Review' instead of mid-word."""
    from markupsafe import Markup, escape

    return Markup(str(escape(text or "")).replace("/", "/<wbr>"))


def register(env) -> None:
    env.filters.update(
        money=money, usd=usd, usd0=usd0, usd_compact=usd_compact, date_fmt=date_fmt, date_input=date_input,
        relative_day=relative_day, renewal_hint=renewal_hint, renewal_tone=renewal_tone, datetime_fmt=datetime_fmt,
        ago=ago, initials=initials, percent=percent, approval_label=approval_label, days_from_today=days_from_today,
        short_deal_name=short_deal_name, wbr=wbr,
    )
    env.globals.update(due_label=due_label, plural=plural, today=today)
