"""The service layer: every rule in SPEC.md, shared by the JSON API (``app.api``) and the HTML pages (``app.pages``).

Handlers never touch SQL themselves; they call these functions with a ``Ctx`` (connection, signed-in actor,
workspace config) and map ``ServiceError`` subclasses to HTTP status codes.
"""
