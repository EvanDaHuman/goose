"""Optional ``Idempotency-Key`` support for requests that create records.

A client may send the header ``Idempotency-Key: <a unique string>``. If the same key arrives again
with the same body, the first response is sent back and nothing is created twice. Requests
without the header behave exactly as they always did.

The created record and the remembered key are saved in one transaction, and a lock on the key
makes a second copy of the request wait for the first one to finish.
"""
import hashlib
import json

from fastapi.responses import Response

from .compat import jsonify


def _fingerprint(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def run(db, key, payload, handler):
    fingerprint = _fingerprint(payload)
    db.lock("idempotency:" + key)
    row = db.execute(
        "SELECT request_hash, status_code, body FROM idempotency_keys WHERE key = %s", (key,)
    ).fetchone()
    if row is not None:
        if row["request_hash"] != fingerprint:
            return jsonify({"error": "Idempotency-Key was already used for a different request"}, status=422)
        return Response(content=row["body"], status_code=row["status_code"], media_type="application/json",
                        headers={"Idempotent-Replay": "true"})
    with db.deferred_commit():
        response = handler()
    if 200 <= response.status_code < 300:
        db.execute(
            "INSERT INTO idempotency_keys (key, request_hash, status_code, body) VALUES (%s, %s, %s, %s)",
            (key, fingerprint, response.status_code, bytes(response.body).decode("utf-8")),
        )
        db.commit_now()
    else:
        db.rollback()  # nothing is remembered for a refused request, so it can be retried
    return response
