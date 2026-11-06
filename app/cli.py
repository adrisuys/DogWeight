"""Command line: serve, status, add, seed, vaccines, advice, backup, sweep."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import zipfile
from datetime import date, datetime
from pathlib import Path

from . import (advice, db, images, kibbles, profile as profile_mod, push,
               reminders, vaccines, weights)
from .config import DATA_DIR, DB_PATH, IMAGES_DIR, WEB_PORT
from .errors import BadRequest, NotFound


def cmd_status(args) -> int:
    db.init_db()
    dog = profile_mod.get()
    entries = weights.list_entries()
    summary = weights.stats(entries, dog["target_weight"])

    print(f"Base : {DB_PATH}")
    name = dog["name"] or "(chien sans nom)"
    age = f", {dog['age']['years']} ans" if dog["age"] else ""
    print(f"\n{name} — {dog['breed'] or 'race non renseignée'}{age}")
    print(f"  poids de forme : {dog['target_weight'] or '—'} kg")

    if not entries:
        print("\nAucune pesée. Ajoutez-en une :")
        print("  ./venv/bin/python -m app.cli add 2026-11-06 18.4 --grams 300")
        return 0

    latest = summary["latest"]
    print(f"\n{summary['count']} pesées, du {summary['first_date']} au {latest['date']}")
    print(f"  dernier poids : {latest['weight']} kg"
          f"  (min {summary['min']} / max {summary['max']})")
    if summary["delta_to_target"] is not None:
        print(f"  écart au poids de forme : {summary['delta_to_target']:+.2f} kg")
    if summary["trend_kg_per_week"] is not None:
        print(f"  tendance ({summary['trend_window_days']} j) : "
              f"{summary['trend_kg_per_week']:+.3f} kg/semaine")
    if summary["eta_date"]:
        print(f"  objectif atteint vers le {summary['eta_date']}")
    if summary["losing_too_fast"]:
        print("  ⚠ perte supérieure à 2 % du poids par semaine")

    foods = kibbles.list_kibbles()
    if foods:
        print(f"\n{len(foods)} croquette(s) :")
        width = max(len(f["label"]) for f in foods)
        for food in foods:
            flag = " (archivée)" if food["archived"] else ""
            print(f"  {food['label']:<{width}}  {food['uses']:>3} pesées{flag}")

    shots = vaccines.status(vaccines.list_vaccinations())
    if shots:
        print("\nVaccins :")
        width = max(len(line["label"]) for line in shots)
        for line in shots:
            until = line["valid_until"] or "date non notée"
            flag = {"expired": "  ⚠ expiré", "soon": "  ⚠ bientôt",
                    "pending": "  (pas encore valable)"}.get(line["state"], "")
            print(f"  {line['label']:<{width}}  jusqu'au {until}{flag}")

    hints = advice.latest()
    if hints:
        print(f"\nConseils (dernière pesée) : {hints['status']}")
        for hint in hints["hints"]:
            print(f"  • {hint['title']}")
    return 0


def cmd_add(args) -> int:
    """Record a weighing from the terminal, hints included.

    Generates synchronously — unlike the web app there is no screen to come
    back to, so waiting the few seconds is the whole point.
    """
    db.init_db()
    entry = weights.add_entry({
        "date": args.date,
        "weight": args.weight,
        "grams": args.grams,
        "kibble_id": args.kibble,
        "notes": args.notes or "",
    })
    print(f"Pesée enregistrée : {entry['date']} — {entry['weight']} kg"
          + (f", {entry['grams']:g} g de {entry['kibble_label']}" if entry["grams"] else ""))

    if args.no_advice:
        return 0
    print("\nConseils…")
    result = advice.generate(entry["id"], force=True)
    return _print_advice(result)


def cmd_advice(args) -> int:
    """Re-run the hints for one weighing, or for the most recent one."""
    db.init_db()
    if args.id:
        entry = weights.get_entry(args.id)
    else:
        entries = weights.list_entries(limit=1)
        if not entries:
            print("Aucune pesée.", file=sys.stderr)
            return 1
        entry = entries[0]
    print(f"Pesée du {entry['date']} ({entry['weight']} kg)\n")
    if args.show_prompt:
        print(advice.build_context(entry))
        return 0
    return _print_advice(advice.generate(entry["id"], force=args.force))


def _print_advice(result: dict | None) -> int:
    if not result or result.get("status") == "gone":
        print("Rien à afficher.", file=sys.stderr)
        return 1
    if result["status"] == "error":
        print(f"Échec : {result['error']}", file=sys.stderr)
        return 1
    if result["summary"]:
        print(result["summary"])
        print()
    for hint in result["hints"]:
        print(f"• {hint['title']}")
        print(f"  {hint['detail']}")
    if result.get("caution"):
        print(f"\n⚠ {result['caution']}")
    return 0


def cmd_seed(args) -> int:
    """Write a starting profile from a JSON file.

    For getting a new install off the ground without typing into a form on a
    phone. Refuses to overwrite a profile that already has a name, unless
    asked twice.
    """
    db.init_db()
    path = Path(args.file).expanduser().resolve()
    if not path.exists():
        print(f"Fichier introuvable : {path}", file=sys.stderr)
        return 1
    current = profile_mod.get()
    if current["name"] and not args.replace:
        print(f"Le profil de {current['name']} existe déjà. "
              f"Relancez avec --replace pour l'écraser.", file=sys.stderr)
        return 1
    profile_mod.update(json.loads(path.read_text()))
    dog = profile_mod.get()
    print(f"Profil enregistré : {dog['name']} — {dog['breed']}")
    if dog["target_weight"] is None:
        print("Le poids de forme n'est pas encore défini.")
    return 0


def cmd_vaccines(args) -> int:
    """List the booklet, or import a transcription of it from JSON.

    The file is a list of rows shaped like the API's (date, vaccine, diseases,
    batch, valid_from, valid_until, vet, notes). Rows already in the base are
    skipped, so the same file can be extended and re-imported.
    """
    db.init_db()
    if args.import_file:
        path = Path(args.import_file).expanduser().resolve()
        if not path.exists():
            print(f"Fichier introuvable : {path}", file=sys.stderr)
            return 1
        rows = json.loads(path.read_text())
        if isinstance(rows, dict):
            rows = rows.get("vaccinations", [])
        added, skipped = vaccines.import_rows(rows)
        print(f"{added} vaccin(s) ajouté(s), {skipped} déjà présent(s).\n")

    shots = vaccines.list_vaccinations()
    if not shots:
        print("Aucun vaccin enregistré.")
        return 0
    for shot in shots:
        until = f" → {shot['valid_until']}" if shot["valid_until"] else ""
        codes = "/".join(shot["diseases"]) or "?"
        print(f"  {shot['date']}  {shot['vaccine']:<24} {codes:<12} "
              f"lot {shot['batch'] or '—':<10}{until}")
    return 0


def cmd_remind(args) -> int:
    """Send the weigh-in and vaccine reminders if they are due. This is the
    launchd job.

    Prints what it decided either way: a cron job that only speaks when it
    acts is a cron job nobody can debug three weeks later.
    """
    db.init_db()
    weigh = _remind_weighing(args)
    print()
    shots = _remind_vaccines(args)
    return weigh or shots


def _remind_weighing(args) -> int:
    print("— Pesée")
    if args.dry_run:
        result = reminders.state()
        result["action"] = "dry-run"
    else:
        result = reminders.run(force=args.force)

    if result["last_weighing"]:
        print(f"Dernière pesée : {result['last_weighing']} "
              f"({result['days_since']} jours)")
        print(f"Prochain rappel à partir du {result['due_date']} "
              f"(tous les {result['every_days']} jours)")
    else:
        print("Aucune pesée enregistrée.")
    print(f"Appareils abonnés : {result['subscriptions']}")

    action = result["action"]
    if action == "dry-run":
        print("→ " + ("Dû — serait envoyé." if result["due"] else "Pas encore l'heure.")
              + " (rien envoyé : --dry-run)")
    elif action == "not-due":
        print("→ Pas encore l'heure.")
    elif action == "too-soon":
        print(f"→ Déjà rappelé le {result['last_reminder']}, on attend.")
    elif action == "no-subscribers":
        print("→ Dû, mais aucun appareil abonné. Activez les rappels dans l'app.")
        return 1
    else:
        print(f"→ Envoyé à {result['sent']} appareil(s)"
              + (f", {result['removed']} abonnement(s) périmé(s) retiré(s)" if result["removed"] else ""))
        for failure in result["failed"]:
            print(f"   échec : {failure['error']}", file=sys.stderr)
        if not result["sent"]:
            return 1
    return 0


def _remind_vaccines(args) -> int:
    print("— Vaccins")
    if args.dry_run:
        due = reminders.vaccine_state()
        if not due:
            print("→ Rien à signaler.")
            return 0
        title, body = reminders._vaccine_message(due, profile_mod.get()["name"])
        print(f"→ Serait envoyé (rien envoyé : --dry-run) :\n  {title}")
        for line in body.splitlines():
            print(f"  {line}")
        return 0

    result = reminders.run_vaccines(force=args.force)
    action = result["action"]
    if action == "not-due":
        print("→ Rien à signaler.")
    elif action == "no-subscribers":
        print("→ Un rappel est dû, mais aucun appareil abonné.")
        return 1
    else:
        print(f"→ Envoyé à {result['sent']} appareil(s) :\n  {result['title']}")
        for line in result["body"].splitlines():
            print(f"  {line}")
        for failure in result["failed"]:
            print(f"   échec : {failure['error']}", file=sys.stderr)
        if not result["sent"]:
            return 1
    return 0


def cmd_push(args) -> int:
    """Inspect the subscriptions, or send a test notification."""
    db.init_db()
    if args.test:
        result = push.send("Test", "Si tu lis ça, les rappels arriveront bien ici.",
                           tag="test")
        print(f"Envoyé à {result['sent']} appareil(s).")
        for failure in result["failed"]:
            print(f"  échec : {failure['error']}", file=sys.stderr)
        return 0 if result["sent"] else 1

    state = push.status()
    print(f"Clé publique VAPID : {state['public_key']}")
    print(f"{state['count']} appareil(s) abonné(s)")
    for device in state["devices"]:
        host = device["endpoint"].split("/")[2]
        print(f"  {host}  abonné le {device['created_at']}"
              + (f", dernier envoi {device['last_sent']}" if device["last_sent"] else "")
              + (f"  ⚠ {device['last_error']}" if device["last_error"] else ""))
    return 0


def cmd_backup(args) -> int:
    if not DB_PATH.exists():
        print("Rien à sauvegarder pour l'instant.", file=sys.stderr)
        return 1
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    print(f"Base copiée vers {_backup_db(stamp).name}")

    # The photos live on disk, outside the database, so a backup that only
    # took the .db would quietly stop being a whole backup the day the first
    # one is uploaded.
    archive = _backup_images(stamp)
    if archive is None:
        print("Aucune photo à inclure.")
    else:
        print(f"Photos vers {archive.name} ({archive.stat().st_size / 1024 / 1024:.1f} Mo)")
    return 0


def _backup_db(stamp: str | None = None) -> Path:
    """Copy the database aside, using SQLite's own backup API so a copy taken
    while the web app is running is still consistent."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    stamp = stamp or datetime.now().strftime("%Y%m%d-%H%M%S")
    target = DATA_DIR / f"{DB_PATH.stem}-{stamp}.bak.db"
    source = db.connect()
    try:
        destination = sqlite3.connect(target)
        try:
            source.backup(destination)
        finally:
            destination.close()
    finally:
        source.close()
    return target


def _backup_images(stamp: str) -> Path | None:
    photos = images.stored()
    if not photos:
        return None
    target = DATA_DIR / f"images-{stamp}.bak.zip"
    # Stored, not deflated: these are already-compressed JPEGs and PNGs, so
    # deflate would spend time to save almost nothing.
    with zipfile.ZipFile(target, "w", zipfile.ZIP_STORED) as archive:
        for path in photos:
            archive.write(path, arcname=path.name)
    return target


def cmd_sweep(args) -> int:
    """Delete photos no croquette points at.

    Uploads are decoupled from saving, so cancelling an edit after choosing a
    photo leaves the file behind; so does replacing one.

    Reports by default and only deletes when asked: this is the one command
    here that can lose a file, and a dry run costs nothing.
    """
    db.init_db()
    if not IMAGES_DIR.is_dir():
        print("Aucune photo pour l'instant.")
        return 0

    kept = images.referenced()
    extra = images.orphans()
    print(f"{len(images.stored())} photo(s) sur le disque, {len(kept)} utilisée(s).")

    if not extra:
        print("Rien à nettoyer.")
        return 0

    freed = sum(path.stat().st_size for path in extra) / 1024 / 1024
    print(f"\n{len(extra)} inutilisée(s) ({freed:.1f} Mo) :")
    for path in extra[:20]:
        print(f"  {path.name}")
    if len(extra) > 20:
        print(f"  … et {len(extra) - 20} de plus")

    if not args.delete:
        print("\nRien supprimé. Ajoutez --delete pour les retirer.")
        return 0

    for path in extra:
        path.unlink()
    print(f"\n{len(extra)} fichier(s) supprimé(s), {freed:.1f} Mo libérés.")
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    uvicorn.run("app.main:app", host=args.host, port=args.port,
                reload=args.reload, log_level="info")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli", description="Carnet de santé du chien")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="ce que contient la base").set_defaults(func=cmd_status)

    p_add = sub.add_parser("add", help="enregistrer une pesée")
    p_add.add_argument("date", nargs="?", default=date.today().isoformat(),
                       help="AAAA-MM-JJ (aujourd'hui par défaut)")
    p_add.add_argument("weight", help="poids en kg")
    p_add.add_argument("--grams", help="ration journalière en grammes")
    p_add.add_argument("--kibble", type=int, help="id de la croquette")
    p_add.add_argument("--notes", help="remarque libre")
    p_add.add_argument("--no-advice", action="store_true",
                       help="ne pas générer de conseils")
    p_add.set_defaults(func=cmd_add)

    p_advice = sub.add_parser("advice", help="regénérer les conseils")
    p_advice.add_argument("--id", type=int, help="id de la pesée (la dernière par défaut)")
    p_advice.add_argument("--force", action="store_true",
                          help="regénérer même si les conseils sont à jour")
    p_advice.add_argument("--show-prompt", action="store_true",
                          help="afficher le contexte envoyé, sans appeler le modèle")
    p_advice.set_defaults(func=cmd_advice)

    p_seed = sub.add_parser("seed", help="charger un profil depuis un fichier JSON")
    p_seed.add_argument("file")
    p_seed.add_argument("--replace", action="store_true",
                        help="écraser un profil existant")
    p_seed.set_defaults(func=cmd_seed)

    p_vacc = sub.add_parser("vaccines", help="carnet de vaccination")
    p_vacc.add_argument("--import", dest="import_file", metavar="FICHIER",
                        help="ajouter les vaccins d'un fichier JSON")
    p_vacc.set_defaults(func=cmd_vaccines)

    p_remind = sub.add_parser("remind", help="envoyer les rappels (pesée, vaccins) s'ils sont dus")
    p_remind.add_argument("--force", action="store_true",
                          help="envoyer même si ce n'est pas dû")
    p_remind.add_argument("--dry-run", action="store_true",
                          help="dire ce qui serait envoyé, sans rien envoyer")
    p_remind.set_defaults(func=cmd_remind)

    p_push = sub.add_parser("push", help="appareils abonnés aux rappels")
    p_push.add_argument("--test", action="store_true", help="envoyer une notification de test")
    p_push.set_defaults(func=cmd_push)

    sub.add_parser("backup", help="copier la base et les photos").set_defaults(func=cmd_backup)

    p_sweep = sub.add_parser("sweep", help="trouver les photos inutilisées")
    p_sweep.add_argument("--delete", action="store_true", help="les supprimer vraiment")
    p_sweep.set_defaults(func=cmd_sweep)

    p_serve = sub.add_parser("serve", help="lancer l'application web")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=WEB_PORT)
    p_serve.add_argument("--reload", action="store_true")
    p_serve.set_defaults(func=cmd_serve)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (BadRequest, NotFound) as exc:
        print(f"\nErreur : {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
