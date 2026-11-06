"""Hints, written by Claude, after every weighing.

Not a button. Saving a weighing schedules a generation, the save returns
immediately, and the hints land on the row a few seconds later — because a
suggestion you have to go and ask for is a suggestion you stop asking for,
and the moment it is worth reading is the moment you have just put the dog
on the scale.

**Why the CLI and not the API.** This shells out to the `claude` binary rather
than importing the Anthropic SDK. There is no key to keep on this machine, no
second bill beyond the subscription that is already paying for it, and the
binary is already signed in. The cost is latency — a few seconds per call —
which is exactly the cost this module is built to hide.

Everything the model sees is assembled in `build_context`, hashed, and stored
beside the answer. That hash is the cache key *and* the invalidation rule:
reloading the dashboard reuses the answer, editing the weighing throws it away.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import datetime

from . import db, kibbles, profile as profile_mod, weights
from .config import (
    ADVICE_HISTORY,
    ADVICE_TIMEOUT_S,
    CLAUDE_BIN,
    CLAUDE_MODEL,
    MAX_SAFE_LOSS_RATIO_PER_WEEK,
    ROOT,
)
from .errors import NotFound

MAX_HINTS = 3

SYSTEM_PROMPT = """\
Tu aides un particulier à suivre le poids de son chien. On te donne la fiche du
chien, son poids de forme, l'historique de ses pesées et les croquettes qu'il
mange (marque, type, kcal/100 g, ration journalière en grammes).

Produis 2 ou 3 conseils concrets pour se rapprocher du poids de forme, ou pour
s'y maintenir s'il y est déjà.

Règles :
- Appuie-toi sur les chiffres fournis et cite-les. Pas de conseil générique :
  « faites de l'exercice » ne vaut rien, « passez de 320 à 290 g » vaut quelque
  chose.
- Le levier principal est la ration journalière. Quand tu proposes de la
  changer, donne la quantité précise en grammes et le raisonnement derrière.
- Une perte de poids saine chez le chien est de 1 à 2 % du poids par semaine.
  N'en propose jamais davantage, et signale-le si le rythme observé la dépasse.
- Si une donnée manque et bloque le raisonnement (kcal/100 g non renseignées,
  poids de forme absent, friandises non comptées), dis-le et demande-la : c'est
  un conseil utile à part entière.
- Tu n'es pas vétérinaire. Pour tout ce qui relève de la santé — perte de poids
  inexpliquée, refus de manger, boiterie — renvoie vers le vétérinaire au lieu
  de supposer une cause.
- Écris en français, en tutoyant le maître. Deux phrases par conseil au maximum.

Réponds UNIQUEMENT par un objet JSON, sans texte autour et sans bloc de code :
{"summary": "une phrase sur la situation actuelle",
 "hints": [{"title": "titre court", "detail": "deux phrases au maximum"}],
 "caution": "un point de vigilance, ou null"}
"""


# --------------------------------------------------------------------------
# The prompt
# --------------------------------------------------------------------------

def _fr(value, unit: str = "", digits: int = 1) -> str:
    """A number the way the prompt should read it: comma, or 'non renseigné'.

    Trailing zeros are dropped only from the fractional part — stripping them
    off a whole number turns a 290 g ration into 29 g, which the model has no
    way of knowing is wrong.
    """
    if value is None:
        return "non renseigné"
    text = f"{value:.{digits}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return f"{text.replace('.', ',')} {unit}".strip()


def build_context(entry: dict) -> str:
    """Everything the model is told, as plain text.

    Plain text rather than JSON because this is prose for a reader, and
    because the hash of it is the cache key — a stable rendering means a
    reload is free and a real change is not.
    """
    dog = profile_mod.get()
    history = weights.list_entries()
    recent = history[-ADVICE_HISTORY:]
    summary = weights.stats(history, dog["target_weight"])
    periods = weights.kibble_periods(recent)

    lines: list[str] = ["## Le chien"]
    lines.append(f"- Nom : {dog['name'] or 'non renseigné'}")
    lines.append(f"- Race : {dog['breed'] or 'non renseignée'}")
    if dog["age"]:
        lines.append(f"- Âge : {dog['age']['years']} ans et {dog['age']['months']} mois")
    else:
        lines.append("- Âge : non renseigné")
    sexe = dog["sex_label"] or "non renseigné"
    lines.append(f"- Sexe : {sexe}" + (" (stérilisé·e)" if dog["neutered"] else ""))
    lines.append(f"- Niveau d'activité : {dog['activity'] or 'non renseigné'}")
    lines.append(f"- Exercice quotidien : {dog['exercise'] or 'non renseigné'}")
    if dog["notes"]:
        lines.append(f"- Notes du maître : {dog['notes']}")

    lines.append("")
    lines.append("## Objectif")
    lines.append(f"- Poids de forme visé : {_fr(dog['target_weight'], 'kg', 2)}")
    lines.append(f"- Poids à la dernière pesée ({entry['date']}) : {_fr(entry['weight'], 'kg', 2)}")
    if summary["delta_to_target"] is not None:
        delta = summary["delta_to_target"]
        sense = "au-dessus" if delta > 0 else "en dessous"
        lines.append(f"- Écart : {_fr(abs(delta), 'kg', 2)} {sense} du poids de forme")
    if summary["change_since_previous"] is not None:
        lines.append(f"- Variation depuis la pesée précédente : "
                     f"{summary['change_since_previous']:+.2f} kg".replace(".", ","))
    if summary["trend_kg_per_week"] is not None:
        slope = summary["trend_kg_per_week"]
        lines.append(
            f"- Tendance sur {summary['trend_window_days']} jours "
            f"({summary['trend_points']} pesées) : {slope:+.3f} kg/semaine".replace(".", ",")
        )
        ceiling = entry["weight"] * MAX_SAFE_LOSS_RATIO_PER_WEEK
        lines.append(f"- Perte hebdomadaire maximale considérée comme sûre : "
                     f"{_fr(ceiling, 'kg', 2)} (2 % du poids)")
    if summary["eta_date"]:
        lines.append(f"- Au rythme actuel, poids de forme atteint vers le {summary['eta_date']}")

    lines.append("")
    lines.append("## Ration actuelle")
    lines.append(f"- Croquettes : {entry['kibble_label'] or 'non renseignées'}")
    lines.append(f"- Quantité journalière : {_fr(entry['grams'], 'g', 0)}")
    if entry["kibble_id"]:
        food = kibbles.get_kibble(entry["kibble_id"])
        lines.append(f"- Densité : {_fr(food['kcal_per_100g'], 'kcal/100 g', 0)}")
        if food["notes"]:
            lines.append(f"- Notes sur ces croquettes : {food['notes']}")
    lines.append(f"- Apport journalier estimé : "
                 f"{str(entry['kcal']) + ' kcal' if entry['kcal'] else 'inconnu'}")

    lines.append("")
    lines.append(f"## Historique ({len(recent)} dernières pesées)")
    lines.append("date | poids (kg) | croquettes | ration (g)")
    for item in recent:
        lines.append(
            f"{item['date']} | {_fr(item['weight'], '', 2)} | "
            f"{item['kibble_label'] or '—'} | {_fr(item['grams'], '', 0)}"
        )

    if len(periods) > 1:
        lines.append("")
        lines.append("## Changements de croquettes")
        for period in periods:
            lines.append(
                f"- {period['label'] or 'non renseignées'} : du {period['from']} au "
                f"{period['to']} ({period['count']} pesées, "
                f"{period['change']:+.2f} kg)".replace(".", ",")
            )

    return "\n".join(lines)


def context_hash(context: str) -> str:
    # The model name is in the digest so switching models regenerates rather
    # than silently serving the old model's answer under the new one's label.
    return hashlib.sha256(f"{CLAUDE_MODEL}\n{context}".encode()).hexdigest()[:32]


# --------------------------------------------------------------------------
# Calling the model
# --------------------------------------------------------------------------

def _strip_fence(text: str) -> str:
    """Unwrap a ```json fence if the model added one despite being asked not to."""
    text = text.strip()
    if not text.startswith("```"):
        return text
    body = text.split("\n", 1)[1] if "\n" in text else ""
    return body.rsplit("```", 1)[0].strip()


def _parse(result: str) -> dict:
    data = json.loads(_strip_fence(result))
    if not isinstance(data, dict):
        raise ValueError("la réponse n'est pas un objet JSON")

    hints = []
    for raw in (data.get("hints") or [])[:MAX_HINTS]:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()
        detail = str(raw.get("detail") or "").strip()
        if title or detail:
            hints.append({"title": title, "detail": detail})
    if not hints:
        raise ValueError("aucun conseil dans la réponse")

    caution = data.get("caution")
    return {
        "summary": str(data.get("summary") or "").strip(),
        "hints": hints,
        "caution": str(caution).strip() if caution else None,
    }


def ask(context: str) -> dict:
    """Run the model on one context and return the parsed hints.

    Raises RuntimeError with a message meant for the screen — this is the only
    part of the app that depends on something outside it, so every way it can
    fail has to come back as a sentence rather than a traceback.
    """
    command = [
        CLAUDE_BIN, "-p",
        "--output-format", "json",
        "--model", CLAUDE_MODEL,
        # One turn, no tools: this is a single question about text we already
        # hold, and nothing good comes of letting it read the filesystem.
        "--max-turns", "1",
        "--disallowed-tools", "Bash Read Write Edit Glob Grep WebSearch WebFetch Task",
        "--no-session-persistence",
        "--system-prompt", SYSTEM_PROMPT,
        context,
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=ADVICE_TIMEOUT_S,
        )
    except FileNotFoundError:
        raise RuntimeError(
            f"Claude Code est introuvable ({CLAUDE_BIN}). Installez-le, ou "
            f"indiquez son chemin dans DOG_CLAUDE_BIN."
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Claude n'a pas répondu en {ADVICE_TIMEOUT_S} s.")

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"Claude a échoué : {detail[:400] or 'sans message'}")

    try:
        envelope = json.loads(completed.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"Réponse illisible : {completed.stdout[:400]}")

    if envelope.get("is_error"):
        raise RuntimeError(f"Claude a renvoyé une erreur : {envelope.get('result')}")

    try:
        return _parse(envelope.get("result") or "")
    except (json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError(f"Conseils illisibles ({exc}).")


# --------------------------------------------------------------------------
# Storage
# --------------------------------------------------------------------------

def _row_to_advice(row) -> dict:
    out = {
        "weight_id": row["weight_id"],
        "status": row["status"],
        "model": row["model"],
        "error": row["error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "summary": "",
        "hints": [],
        "caution": None,
    }
    if row["payload"]:
        try:
            out.update(json.loads(row["payload"]))
        except json.JSONDecodeError:
            out["status"] = "error"
            out["error"] = "Conseils stockés illisibles."
    return out


def for_weight(weight_id: int) -> dict | None:
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT * FROM advice WHERE weight_id = ?", (weight_id,)
        ).fetchone()
    return _row_to_advice(row) if row else None


def latest() -> dict | None:
    """The hints attached to the most recent weighing, whatever their state."""
    with db.cursor() as conn:
        row = conn.execute("""
            SELECT a.* FROM advice a
              JOIN weights w ON w.id = a.weight_id
          ORDER BY w.date DESC, w.id DESC
             LIMIT 1
        """).fetchone()
    return _row_to_advice(row) if row else None


def _store(weight_id: int, status: str, *, hash_: str = "", payload: str = "",
           error: str = "") -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with db.cursor() as conn:
        conn.execute(
            "INSERT INTO advice (weight_id, status, context_hash, model, payload, "
            "error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(weight_id) DO UPDATE SET status = excluded.status, "
            "context_hash = excluded.context_hash, model = excluded.model, "
            "payload = excluded.payload, error = excluded.error, "
            "updated_at = excluded.updated_at",
            (weight_id, status, hash_, CLAUDE_MODEL, payload, error, now, now),
        )


def mark_pending(weight_id: int) -> None:
    """Put the row into 'pending' before returning from the save.

    Written synchronously, so the response the browser gets back already says
    hints are coming — otherwise a fast poll finds nothing and concludes none
    were asked for.
    """
    _store(weight_id, "pending")


def generate(weight_id: int, force: bool = False) -> dict:
    """Produce the hints for one weighing. Runs off the request thread.

    Returns early when a ready set already matches the current facts, which is
    what makes re-saving an unchanged weighing free.
    """
    try:
        entry = weights.get_entry(weight_id)
    except NotFound:
        # The weighing was deleted while the generation was queued. The
        # cascade already removed the row; there is nothing to write.
        return {"status": "gone"}

    context = build_context(entry)
    digest = context_hash(context)

    if not force:
        existing = None
        with db.cursor() as conn:
            existing = conn.execute(
                "SELECT status, context_hash FROM advice WHERE weight_id = ?",
                (weight_id,),
            ).fetchone()
        if existing and existing["status"] == "ready" and existing["context_hash"] == digest:
            return for_weight(weight_id)

    try:
        parsed = ask(context)
    except RuntimeError as exc:
        _store(weight_id, "error", hash_=digest, error=str(exc))
        return for_weight(weight_id)

    _store(weight_id, "ready", hash_=digest, payload=json.dumps(parsed, ensure_ascii=False))
    return for_weight(weight_id)
