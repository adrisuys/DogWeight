"""Web Push: the reminder that the dog hasn't been on the scale in a while.

iOS delivers Web Push to a PWA added to the Home Screen (16.4+), over HTTPS,
which Tailscale already provides. So the reminder reaches the phone without an
account, an app store, or a third-party service — the same shape as the rest
of this app.

Three things the rest of the code leans on:

* **The VAPID keypair is generated once and never rotated.** Rotating it
  silently invalidates every subscription already on a phone, and nothing
  tells you: the sends just stop arriving. It lives in `data/vapid.json`,
  mode 600, and is the one file here worth keeping in a backup.

* **Subscriptions are keyed by endpoint**, so re-subscribing from the same
  phone is a correction rather than a duplicate — otherwise reinstalling the
  PWA would earn you two notifications per reminder, then three.

* **A push service that says the subscription is gone is believed.** 404 and
  410 mean the phone uninstalled the app or the endpoint expired; the row is
  deleted rather than retried forever. Anything else is recorded and kept.
"""

from __future__ import annotations

import json
from datetime import datetime

from . import db
from .config import DATA_DIR, VAPID_PATH, VAPID_SUBJECT
from .errors import BadRequest


def _generate_keys() -> dict:
    """A fresh P-256 keypair, in the two shapes the two sides need.

    The browser's `applicationServerKey` is the raw uncompressed EC point —
    65 bytes, base64url, **unpadded**; a trailing `=` makes Chrome reject the
    subscription. pywebpush wants the private half as a PKCS#8 PEM.
    """
    import base64

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    private = ec.generate_private_key(ec.SECP256R1())

    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()

    raw_point = private.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return {
        "private_pem": private_pem,
        "public_key": base64.urlsafe_b64encode(raw_point).rstrip(b"=").decode(),
    }


def keys() -> dict:
    """The VAPID keypair, generated on first use.

    Written with mode 600 before anything is put in it — a keyfile that is
    briefly world-readable is a keyfile that was world-readable.
    """
    if VAPID_PATH.exists():
        return json.loads(VAPID_PATH.read_text())
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    generated = _generate_keys()
    VAPID_PATH.touch(mode=0o600)
    VAPID_PATH.write_text(json.dumps(generated, indent=2))
    return generated


def public_key() -> str:
    return keys()["public_key"]


# --------------------------------------------------------------------------
# Subscriptions
# --------------------------------------------------------------------------

def subscribe(subscription: dict) -> dict:
    endpoint = (subscription or {}).get("endpoint") or ""
    sub_keys = (subscription or {}).get("keys") or {}
    p256dh = sub_keys.get("p256dh") or ""
    auth = sub_keys.get("auth") or ""

    # Everything here comes from the browser's PushManager, so a malformed
    # one means a bug rather than a user mistake — but it would be stored and
    # then fail silently on every send, so it is refused at the door.
    if not endpoint.startswith("https://") or not p256dh or not auth:
        raise BadRequest("Abonnement push invalide.")

    now = datetime.now().isoformat(timespec="seconds")
    with db.cursor() as conn:
        conn.execute(
            "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, "
            "last_error) VALUES (?, ?, ?, ?, '') "
            "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, "
            "auth = excluded.auth, last_error = ''",
            (endpoint, p256dh, auth, now),
        )
    return status()


def unsubscribe(endpoint: str) -> dict:
    with db.cursor() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    return status()


def status() -> dict:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT endpoint, created_at, last_sent, last_error "
            "FROM push_subscriptions ORDER BY created_at"
        ).fetchall()
    return {
        "public_key": public_key(),
        "count": len(rows),
        "devices": [dict(row) for row in rows],
    }


# --------------------------------------------------------------------------
# Sending
# --------------------------------------------------------------------------

def send(title: str, body: str, *, tag: str = "dog", url: str = "/") -> dict:
    """Push one notification to every subscribed device.

    Never raises: a reminder is a background job, and a phone that has been
    off for a week must not be able to fail the run for the others.
    """
    from py_vapid import Vapid
    from pywebpush import WebPushException, webpush

    # pywebpush reads a *string* key as either a filesystem path or a raw
    # base64 key — never as PEM content. Handing it the parsed Vapid object
    # instead is unambiguous, and it is built once for the whole run rather
    # than re-parsed per device.
    signer = Vapid.from_pem(keys()["private_pem"].encode())
    payload = json.dumps({"title": title, "body": body, "tag": tag, "url": url})
    now = datetime.now().isoformat(timespec="seconds")

    with db.cursor() as conn:
        rows = conn.execute("SELECT * FROM push_subscriptions").fetchall()

    delivered, failed, gone = [], [], []
    for row in rows:
        try:
            webpush(
                subscription_info={
                    "endpoint": row["endpoint"],
                    "keys": {"p256dh": row["p256dh"], "auth": row["auth"]},
                },
                data=payload,
                vapid_private_key=signer,
                # Apple rejects a JWT whose subject is not a mailto: or https: URL.
                vapid_claims={"sub": VAPID_SUBJECT},
                ttl=86400,
            )
        except WebPushException as exc:
            code = getattr(exc.response, "status_code", None)
            if code in (404, 410):
                # The push service is authoritative about this: the endpoint
                # is gone for good, so stop carrying it.
                gone.append(row["endpoint"])
            else:
                failed.append({"endpoint": row["endpoint"], "error": str(exc)[:200]})
            continue
        except Exception as exc:                       # network, DNS, TLS…
            failed.append({"endpoint": row["endpoint"], "error": str(exc)[:200]})
            continue
        delivered.append(row["endpoint"])

    with db.cursor() as conn:
        for endpoint in gone:
            conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
        for item in failed:
            conn.execute("UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?",
                         (item["error"], item["endpoint"]))
        for endpoint in delivered:
            conn.execute(
                "UPDATE push_subscriptions SET last_sent = ?, last_error = '' "
                "WHERE endpoint = ?", (now, endpoint))

    return {"sent": len(delivered), "failed": failed, "removed": len(gone)}
