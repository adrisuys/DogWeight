"""FastAPI: the JSON API plus the static PWA."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import (advice, db, images, kibbles, profile as profile_mod, push,
               reminders, vaccines, weights)
from .config import ACTIVITY_LEVELS, MAX_IMAGE_BYTES, STATIC_DIR
from .errors import BadRequest, NotFound


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Carnet de santé du chien", docs_url="/api/docs", redoc_url=None, lifespan=lifespan)


# --------------------------------------------------------------------------
# Request bodies
# --------------------------------------------------------------------------
# Deliberately loose: every field arrives as whatever the form produced, and
# the real parsing lives in the module that owns the table — that is where the
# French error messages are, and where a "12,4" has to become 12.4 anyway.

class ProfileIn(BaseModel):
    name: str = ""
    breed: str = ""
    birth_date: str = ""
    sex: str = ""
    neutered: bool = False
    activity: str = ""
    exercise: str = ""
    target_weight: float | str | None = None
    microchip: str = ""
    notes: str = ""


class SubscriptionIn(BaseModel):
    """Exactly what PushManager.subscribe() hands back, forwarded as-is."""
    endpoint: str = ""
    keys: dict = Field(default_factory=dict)


class EndpointIn(BaseModel):
    endpoint: str = ""


class TargetIn(BaseModel):
    target_weight: float | str | None = None


class KibbleIn(BaseModel):
    brand: str = ""
    variety: str = ""
    kcal_per_100g: float | str | None = None
    notes: str = ""
    archived: bool = False
    photos: list[str] = Field(default_factory=list)


class VaccinationIn(BaseModel):
    date: str = ""
    vaccine: str = ""
    diseases: list[str] | str = Field(default_factory=list)
    batch: str = ""
    valid_from: str | None = None
    valid_until: str | None = None
    vet: str = ""
    notes: str = ""


class WeightIn(BaseModel):
    date: str = ""
    weight: float | str | None = None
    kibble_id: int | str | None = None
    grams: float | str | None = None
    notes: str = ""


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------

@app.exception_handler(NotFound)
def _not_found(_request, exc: NotFound):
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(BadRequest)
def _bad_request(_request, exc: BadRequest):
    return JSONResponse({"detail": str(exc)}, status_code=400)


def _fresh(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------

@app.get("/api/dashboard")
def api_dashboard(response: Response):
    """One request for the whole front page.

    The charts, the headline numbers and the hints are all derived from the
    same list of weighings; fetching them separately would mean three round
    trips to tell one story, and a window where they disagree.
    """
    _fresh(response)
    dog = profile_mod.get()
    entries = weights.list_entries()
    return {
        "profile": dog,
        "entries": entries,
        "stats": weights.stats(entries, dog["target_weight"]),
        "periods": weights.kibble_periods(entries),
        "advice": advice.latest(),
        "activity_levels": ACTIVITY_LEVELS,
        "reminder": reminders.state(),
        "vaccines": vaccines.overview(),
    }


# --------------------------------------------------------------------------
# Profile
# --------------------------------------------------------------------------

@app.get("/api/profile")
def api_profile(response: Response):
    _fresh(response)
    return profile_mod.get()


@app.put("/api/profile")
def api_profile_update(payload: ProfileIn):
    return profile_mod.update(payload.model_dump())


@app.put("/api/profile/target")
def api_set_target(payload: TargetIn):
    return profile_mod.set_target(payload.target_weight)


# --------------------------------------------------------------------------
# Croquettes
# --------------------------------------------------------------------------

@app.get("/api/kibbles")
def api_kibbles(response: Response, archived: bool = True):
    _fresh(response)
    return {"kibbles": kibbles.list_kibbles(include_archived=archived)}


@app.get("/api/kibbles/{kibble_id}")
def api_kibble(kibble_id: int, response: Response):
    _fresh(response)
    return kibbles.get_kibble(kibble_id)


@app.post("/api/kibbles", status_code=201)
def api_kibble_create(payload: KibbleIn):
    return kibbles.create_kibble(payload.model_dump())


@app.put("/api/kibbles/{kibble_id}")
def api_kibble_update(kibble_id: int, payload: KibbleIn):
    return kibbles.update_kibble(kibble_id, payload.model_dump())


@app.delete("/api/kibbles/{kibble_id}")
def api_kibble_delete(kibble_id: int):
    kibbles.delete_kibble(kibble_id)
    return {"deleted": kibble_id}


# --------------------------------------------------------------------------
# Pesées
# --------------------------------------------------------------------------
# Every write schedules the hints for that weighing and returns without
# waiting. The row is marked pending inside the request, so the response the
# browser already holds tells it to start polling.

@app.get("/api/weights")
def api_weights(response: Response):
    _fresh(response)
    return {"entries": weights.list_entries()}


@app.post("/api/weights", status_code=201)
def api_weight_add(payload: WeightIn, background: BackgroundTasks):
    entry = weights.add_entry(payload.model_dump())
    advice.mark_pending(entry["id"])
    background.add_task(advice.generate, entry["id"])
    return entry


@app.put("/api/weights/{entry_id}")
def api_weight_update(entry_id: int, payload: WeightIn, background: BackgroundTasks):
    entry = weights.update_entry(entry_id, payload.model_dump())
    advice.mark_pending(entry["id"])
    background.add_task(advice.generate, entry["id"])
    return entry


@app.delete("/api/weights/{entry_id}")
def api_weight_delete(entry_id: int):
    weights.delete_entry(entry_id)
    return {"deleted": entry_id}


# --------------------------------------------------------------------------
# Conseils
# --------------------------------------------------------------------------

@app.get("/api/advice/latest")
def api_advice_latest(response: Response):
    """What the dashboard polls while a generation is in flight."""
    _fresh(response)
    return advice.latest() or {"status": "none"}


@app.get("/api/weights/{entry_id}/advice")
def api_advice_for(entry_id: int, response: Response):
    _fresh(response)
    return advice.for_weight(entry_id) or {"status": "none"}


@app.post("/api/weights/{entry_id}/advice")
def api_advice_retry(entry_id: int, background: BackgroundTasks):
    """Re-run a generation that failed.

    This is error recovery, not an on-demand button: the front end only
    exposes it on a row whose status is already `error`.
    """
    weights.get_entry(entry_id)          # 404 before scheduling anything
    advice.mark_pending(entry_id)
    background.add_task(advice.generate, entry_id, True)
    return {"status": "pending", "weight_id": entry_id}


# --------------------------------------------------------------------------
# Vaccins
# --------------------------------------------------------------------------

@app.get("/api/vaccinations")
def api_vaccinations(response: Response):
    _fresh(response)
    return vaccines.overview()


@app.post("/api/vaccinations", status_code=201)
def api_vaccination_create(payload: VaccinationIn):
    return vaccines.create_vaccination(payload.model_dump())


@app.put("/api/vaccinations/{vaccination_id}")
def api_vaccination_update(vaccination_id: int, payload: VaccinationIn):
    return vaccines.update_vaccination(vaccination_id, payload.model_dump())


@app.delete("/api/vaccinations/{vaccination_id}")
def api_vaccination_delete(vaccination_id: int):
    vaccines.delete_vaccination(vaccination_id)
    return {"deleted": vaccination_id}


# --------------------------------------------------------------------------
# Rappels
# --------------------------------------------------------------------------
# The public VAPID key is deliberately public — it is the browser's
# `applicationServerKey`, and a subscription cannot be created without it.

@app.get("/api/push")
def api_push(response: Response):
    _fresh(response)
    return {**push.status(), "reminder": reminders.state()}


@app.post("/api/push/subscribe")
def api_push_subscribe(payload: SubscriptionIn):
    return push.subscribe(payload.model_dump())


@app.post("/api/push/unsubscribe")
def api_push_unsubscribe(payload: EndpointIn):
    return push.unsubscribe(payload.endpoint)


@app.post("/api/push/test")
def api_push_test():
    """Prove the whole chain works without waiting three weeks for it to."""
    return push.send(
        "Test",
        "Si tu lis ça, les rappels de pesée arriveront bien ici.",
        tag="test",
    )


# --------------------------------------------------------------------------
# Photos
# --------------------------------------------------------------------------

@app.post("/api/images", status_code=201)
async def api_upload_image(request: Request):
    """Take a photo as a raw body and return the path to store on a croquette.

    Raw bytes rather than a multipart form: `UploadFile` would pull in
    python-multipart, and this endpoint carries exactly one file with no other
    fields. The browser posts the Blob directly.

    Not tied to a croquette id — the editor also runs on a food that has not
    been saved yet. An upload followed by a cancelled edit therefore leaves a
    file nobody points at; `cli sweep` collects those.
    """
    # Refuse on the declared length first, so a huge post isn't read into
    # memory before being rejected. The real check is on the bytes, since a
    # header is only a claim.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_IMAGE_BYTES:
        raise BadRequest(
            f"Cette image dépasse {MAX_IMAGE_BYTES // 1024 // 1024} Mo."
        )
    return {"path": images.save(await request.body())}


@app.get("/images/{name}", include_in_schema=False)
def api_image(name: str):
    path = images.path_for(name)
    return FileResponse(
        path,
        media_type=images.media_type_for(name),
        # The name is a hash of the contents, so this file can never change
        # under that URL and the phone never needs to ask about it again.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.get("/healthz")
def healthz():
    return {"ok": True}


# --------------------------------------------------------------------------
# Static PWA — mounted last so it never shadows /api
# --------------------------------------------------------------------------

@app.get("/sw.js", include_in_schema=False)
def service_worker():
    # Must be served from the root so its scope covers the whole app.
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
    )


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
