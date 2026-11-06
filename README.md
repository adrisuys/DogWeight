# Dog Management

Un petit PWA auto-hébergé pour tenir le carnet de Kali : une pesée, le type de
croquettes, la ration du jour — et, après chaque pesée, deux ou trois conseils
écrits par Claude à partir des chiffres réels.

Remplace un tableur à quatre colonnes (date, poids, croquettes, grammes).
Tourne sur un Mac à la maison. Pas de service payant, pas de cloud, pas
d'étape de build, pas de npm.

```
Pesée ──▶ SQLite ──▶ FastAPI ──▶ PWA (installable sur le téléphone)
            │                     exposé en HTTPS par Tailscale
            └──▶ claude -p ──▶ conseils, en tâche de fond
```

## Ce que le tableur ne pouvait pas faire

* **Un poids de forme.** L'objectif appartient au chien, pas à une ligne. Tout
  le tableau de bord se mesure par rapport à lui : écart, tendance en
  kg/semaine, date d'arrivée estimée.
* **Des croquettes corrigeables.** Une croquette est une ligne de sa propre
  table, pas une chaîne recopiée dans une colonne. Corriger l'orthographe
  d'une marque une fois répare deux ans d'historique — photos du sac et
  kcal/100 g comprises.
* **Des conseils.** Après chaque enregistrement, Claude relit le profil,
  l'objectif, l'historique et la ration, et renvoie 2–3 conseils chiffrés.
  Ce n'est pas un bouton : une pesée les déclenche.

---

## 1. Installation (une fois)

```bash
cd ~/apps/dog-management
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv venv
./venv/bin/pip install -r requirements.txt
./venv/bin/python scripts/make_icons.py
```

### La fiche du chien

```bash
./venv/bin/python -m app.cli seed data/kali.json
```

Tout ce qui s'y trouve part dans le contexte des conseils, donc chaque champ
compte : la race, l'âge, la stérilisation et l'exercice quotidien changent les
besoins énergétiques beaucoup plus que le poids lui-même. **Le poids de forme
n'est pas rempli** — à demander au vétérinaire, puis à saisir dans l'écran
Profil.

### Lancer

```bash
./venv/bin/python -m app.cli serve        # http://127.0.0.1:8760
```

---

## 2. Les conseils

L'app appelle le binaire `claude` déjà installé sur la machine plutôt que
l'API Anthropic : rien à stocker comme clé, rien à payer en plus de
l'abonnement, et l'authentification est déjà faite.

Le prix à payer est la latence — 30 secondes environ. C'est précisément ce que
le découpage cache : enregistrer une pesée marque la ligne `pending` et rend la
main tout de suite, la génération tourne derrière, et le tableau de bord
l'affiche quand elle arrive.

Pour voir exactement ce que le modèle reçoit, sans l'appeler :

```bash
./venv/bin/python -m app.cli advice --show-prompt
```

Les conseils sont mis en cache contre une empreinte du contexte : recharger la
page est gratuit, corriger une pesée régénère.

| Variable | Défaut | |
|---|---|---|
| `DOG_CLAUDE_BIN` | `which claude` | chemin du binaire |
| `DOG_CLAUDE_MODEL` | `opus` | modèle passé à `--model` |
| `DOG_ADVICE_TIMEOUT` | `180` | secondes avant d'abandonner |
| `DOG_PORT` | `8760` | port du serveur |
| `DOG_DB` | `data/dog.db` | base SQLite |

---

## 3. En ligne de commande

```bash
./venv/bin/python -m app.cli status                    # où on en est
./venv/bin/python -m app.cli add 2026-11-06 20.6 \
    --grams 265 --kibble 2                             # pesée + conseils
./venv/bin/python -m app.cli advice --force            # regénérer
./venv/bin/python -m app.cli backup                    # base + photos
./venv/bin/python -m app.cli sweep                     # photos orphelines
```

`add` génère les conseils de façon synchrone : au terminal il n'y a pas
d'écran sur lequel revenir, donc attendre est tout l'intérêt.

---

## 4. Le garder en vie

```bash
./deploy/install.sh
```

Installe un job launchd qui démarre le serveur à l'ouverture de session et le
relance s'il meurt. `./deploy/install.sh remove` le retire ;
`dry-run` montre le plist sans toucher à launchd.

Le job passe le chemin absolu de `claude` : launchd donne un `PATH` minimal qui
n'inclut pas Homebrew, et sans ça la première pesée après un redémarrage
échouerait.

Pour l'atteindre depuis le téléphone, en HTTPS, sans rien ouvrir sur
Internet :

```bash
tailscale serve --bg 8760
tailscale serve status
```

---

## 5. Les rappels (pesée et vaccins)

Un job launchd tourne chaque matin à 9 h et demande *depuis combien de temps
le chien n'a pas été pesé*, pas *combien de temps s'est écoulé depuis le
dernier rappel*. C'est la différence entre un rappel et un minuteur : peser en
avance repousse le rappel suivant tout seul, et peser en retard ne décale rien.

```bash
./venv/bin/python -m app.cli remind            # ce que le job décide, et pourquoi
./venv/bin/python -m app.cli remind --dry-run  # idem, sans rien envoyer
./venv/bin/python -m app.cli remind --force    # envoyer quand même
./venv/bin/python -m app.cli push            # appareils abonnés
./venv/bin/python -m app.cli push --test     # notification de test
```

Le même job surveille le carnet de vaccination, maladie par maladie : une
notification 30 jours avant la fin de validité notée par le vétérinaire, une
autre 7 jours avant, une le jour où elle est dépassée, puis tous les 30 jours
tant que rien de plus récent n'est saisi. Chaque étape ne part qu'une fois ;
saisir le rappel dans l'app change la date de validité et remet tout à zéro.

Une fois le seuil de pesée franchi, il reste franchi tous les matins — d'où
`REMIND_REPEAT_DAYS` : un rappel tous les 3 jours, pas un réveil quotidien.

| Variable | Défaut | |
|---|---|---|
| `DOG_REMIND_DAYS` | `21` | délai avant rappel |
| `DOG_REMIND_REPEAT_DAYS` | `3` | délai minimum entre deux rappels |
| `DOG_REMIND_HOUR` | `9` | heure du job (à l'installation) |
| `DOG_VAPID_SUBJECT` | `mailto:…` | identifie l'émetteur au service de push |

### S'abonner depuis le téléphone

Web Push n'arrive sur iOS que pour une PWA **ajoutée à l'écran d'accueil**, et
seulement en HTTPS — d'où Tailscale. Ouvrez l'app, *Profil* → **Activer les
rappels**. iOS ne demande la permission qu'une fois : si elle est refusée, il
faut la rétablir dans les réglages de l'app, le bouton ne peut plus la
redemander.

> **`data/vapid.json` est une clé privée.** Elle est exclue du dépôt et doit
> être sauvegardée : la regénérer invalide silencieusement tous les
> abonnements déjà posés sur les téléphones — les envois cessent simplement
> d'arriver, sans erreur.

---

## 6. Après avoir modifié le front

Le service worker sert la coquille (HTML, CSS, JS) depuis le cache en premier,
donc **modifier un fichier de `static/` ne suffit pas** : il faut monter
`VERSION` dans `static/sw.js`, sinon les appareils déjà installés continuent
de servir l'ancienne version. L'API, elle, n'est jamais mise en cache — un
poids périmé est pire que pas de poids.

---

## 7. Notes de conception

**Une pesée par jour.** `weights.date` est `UNIQUE` : remonter sur la balance
le même après-midi est une correction, pas deux faits. L'écriture fait un
UPSERT sur la date.

**Une case vide n'est pas un zéro.** `grams` est nullable et le reste. Le
graphique des rations saute le jour au lieu de dessiner une barre à zéro, qui
se lirait « n'a rien mangé ».

**Deux graphiques, pas deux axes.** Les kilos et les grammes/jour sont des
quantités différentes à des échelles sans rapport. Les superposer sur deux axes
y laisserait croire à une relation qui ne serait qu'un artefact des échelles
choisies.

**L'axe des poids ne part pas de zéro ; celui des rations, si.** Le poids se lit
comme une variation dans le temps, et une base à zéro écraserait un régime de
deux kilos en une ligne plate. La longueur d'une barre, elle, *est* la valeur.

**Supprimer une croquette est refusé tant que des pesées l'utilisent.** C'est à
ça que sert l'archivage : un sac que vous ne rachetez plus explique encore ce
que le poids a fait au printemps dernier.

**Les photos sont nommées par leur contenu.** Le nom est une empreinte des
octets et l'extension vient de ce que les octets sont vraiment, jamais du nom
de fichier ni de l'en-tête — qui ne sont que des affirmations de l'envoyeur.
Le SVG est refusé : il peut porter du script, et ces fichiers sont servis
depuis notre propre origine.

**Claude n'est pas vétérinaire, et le prompt le lui dit.** Tout ce qui relève
de la santé est renvoyé vers le vétérinaire au lieu d'être supposé.
