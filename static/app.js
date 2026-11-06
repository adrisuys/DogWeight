/* ==========================================================================
   Carnet de santé : tableau de bord → pesées → croquettes → profil.

   Four screens behind a hash route, so the phone's back gesture and the
   browser's back button both do the obvious thing:

     #/            le tableau de bord : les chiffres, les deux courbes, les conseils
     #/pesees      toutes les pesées, en tableau — et le formulaire d'ajout
     #/croquettes  les types de croquettes, avec photos du sac
     #/profil      la fiche du chien, le poids de forme et les vaccins

   Nothing is templated on the server and the DOM is built with `el()` rather
   than innerHTML: a brand name, a note and a hint from the model are all user
   or model text, and none of it may ever be parsed as HTML.
   ========================================================================== */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* --- fixed chrome heights --------------------------------------------- */

  // The top bar is position: fixed (iOS 27 only keeps a fixed bar clear of
  // the blur band it lays over an installed app), so it no longer reserves
  // its own space. Its live height goes into --topbar-h. On a phone the view
  // switcher is a tab bar pinned to the bottom and its height goes into
  // --tabbar-h, so the toast sits above it rather than under it.
  function trackHeight(node, property) {
    if (!node) return;
    const publish = () => document.documentElement.style
      .setProperty(property, node.offsetHeight + 'px');
    publish();
    // border-box, not content-box: on an installed iPhone the safe-area inset
    // lands in the bar's *padding* after first layout, which a content-box
    // observer never sees.
    if ('ResizeObserver' in window) {
      try { new ResizeObserver(publish).observe(node, { box: 'border-box' }); }
      catch (_) { new ResizeObserver(publish).observe(node); }
    }
    for (const type of ['resize', 'orientationchange', 'pageshow', 'load']) {
      window.addEventListener(type, publish);
    }
  }
  trackHeight(document.querySelector('.topbar'), '--topbar-h');
  trackHeight($('views'), '--tabbar-h');

  /* --- DOM helper -------------------------------------------------------- */

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') throw new Error('el(): use text, never html');
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key in node && key !== 'list' && key !== 'type' && key !== 'form') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** An inline icon built from one or more shapes, on a 16x16 grid.
   *  Always aria-hidden: the accessible name belongs on the control that
   *  holds it, not on the decoration inside it. */
  function glyph(parts, size = 14) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const [tag, attrs] of parts) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      svg.appendChild(node);
    }
    return svg;
  }

  const icon = (path, size = 14) =>
    glyph([['path', { d: path, fill: 'currentColor', stroke: 'none' }]], size);

  // One icon per screen. Filled where the shape is a silhouette (the paw,
  // the kibble), stroked where it is a diagram (the scale, the bowl) — a
  // 16px stroked paw is mush, and a filled scale is a blob.
  const FILL = { fill: 'currentColor', stroke: 'none' };

  const TAB_ICONS = {
    // Bars: the universal "figures" mark. Deliberately not a line chart —
    // at 16px a polyline reads as a scribble.
    dashboard: [
      ['rect', { x: 2, y: 8.6, width: 3.2, height: 5.4, rx: 1.2, ...FILL }],
      ['rect', { x: 6.4, y: 5.4, width: 3.2, height: 8.6, rx: 1.2, ...FILL }],
      ['rect', { x: 10.8, y: 2.4, width: 3.2, height: 11.6, rx: 1.2, ...FILL }],
    ],
    // A balance: beam, post, base, and two hanging pans.
    weights: [
      ['path', { d: 'M2.6 4.6 H13.4' }],
      ['path', { d: 'M8 4.6 V12.2' }],
      ['path', { d: 'M5.2 12.6 H10.8' }],
      ['circle', { cx: 8, cy: 3, r: 1.1, ...FILL }],
      ['path', { d: 'M1.3 7.6 a2.3 2.3 0 0 0 4.6 0 z' }],
      ['path', { d: 'M10.1 7.6 a2.3 2.3 0 0 0 4.6 0 z' }],
    ],
    // A drumstick. Two things make or break it at 19px. The meat is an
    // ellipse tilted along the bone's axis, not a circle — a circle on a stem
    // is a key or a lollipop. And the two lobes of the bone head sit a clear
    // gap apart, perpendicular to the shaft: placed any closer they merge
    // into one blob and the whole icon goes back to looking like a key.
    kibbles: [
      ['ellipse', { cx: 5.4, cy: 10.6, rx: 4.3, ry: 3.5,
                    transform: 'rotate(-45 5.4 10.6)', ...FILL }],
      ['path', { d: 'M8.2 7.8 L12.2 3.8', 'stroke-width': 2.3 }],
      ['circle', { cx: 10.9, cy: 2.5, r: 1.4, ...FILL }],
      ['circle', { cx: 13.5, cy: 5.1, r: 1.4, ...FILL }],
    ],

    // A paw. The app icon is a dog's head, not this — a head needs thin
    // triangular ears and those silt up at 19px, where a paw stays four
    // clear shapes.
    profile: [
      ['circle', { cx: 3.6, cy: 6.2, r: 1.45, ...FILL }],
      ['circle', { cx: 6.4, cy: 4.0, r: 1.6, ...FILL }],
      ['circle', { cx: 9.6, cy: 4.0, r: 1.6, ...FILL }],
      ['circle', { cx: 12.4, cy: 6.2, r: 1.45, ...FILL }],
      ['ellipse', { cx: 8, cy: 11.3, rx: 3.8, ry: 3.1, ...FILL }],
    ],
  };

  const WARN_ICON = 'M8 1.2 15 14H1L8 1.2Zm0 4.3a.8.8 0 0 0-.8.85l.25 3.4a.55.55 0 0 0 1.1 0l.25-3.4A.8.8 0 0 0 8 5.5Zm0 5.4a.85.85 0 1 0 0 1.7.85.85 0 0 0 0-1.7Z';

  /* --- formatting -------------------------------------------------------- */

  const nf = (digits) => new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  const num = (value, digits = 0) => nf(digits).format(value);
  const signed = (value, digits = 1) => (value > 0 ? '+' : '') + num(value, digits);

  // Weights are measurements, and the scale reads to 10 g — so they are shown
  // to the precision they were taken at, trailing zeros included. Rounding
  // 22,15 to 22,2 on screen invents a change that never happened, and over a
  // diet made of 50 g steps the invented changes are the same size as the
  // real ones. Differences get the same treatment: they are differences *of*
  // these numbers, so showing them coarser would not reconcile.
  const WEIGHT_DIGITS = 2;
  const kg = (value) => `${num(value, WEIGHT_DIGITS)} kg`;
  const signedKg = (value) => `${signed(value, WEIGHT_DIGITS)} kg`;

  const DATE_FMT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  const SHORT_FMT = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  // Noon, so a timezone offset can never move a calendar day to the one before.
  const asDate = (iso) => new Date(iso + 'T12:00:00');
  const longDate = (iso) => DATE_FMT.format(asDate(iso));
  const shortDate = (iso) => SHORT_FMT.format(asDate(iso));
  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);

  function daysAgo(iso) {
    const days = Math.round((Date.now() - asDate(iso).getTime()) / 864e5);
    if (days <= 0) return "aujourd'hui";
    if (days === 1) return 'hier';
    if (days < 31) return `il y a ${days} jours`;
    const months = Math.round(days / 30.4);
    return months < 12 ? `il y a ${months} mois` : `il y a ${Math.round(months / 12)} ans`;
  }

  /* --- api --------------------------------------------------------------- */

  async function api(path, options) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `${response.status} ${response.statusText}`);
    }
    return response.status === 204 ? null : response.json();
  }

  let toastTimer = null;
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
  }

  /* --- state ------------------------------------------------------------- */

  const state = {
    dashboard: null,     // { profile, entries, stats, periods, advice, activity_levels }
    kibbles: [],
    advicePoll: null,
  };

  const VIEWS = [
    { id: 'dashboard', route: '#/', label: 'Tableau de bord' },
    { id: 'weights', route: '#/pesees', label: 'Pesées' },
    { id: 'kibbles', route: '#/croquettes', label: 'Croquettes' },
    { id: 'profile', route: '#/profil', label: 'Profil' },
  ];

  function buildNav() {
    const nav = $('views');
    clear(nav);
    for (const view of VIEWS) {
      // Icon instead of a word, so four screens fit a phone's bottom bar
      // without truncating. The name does not disappear — it becomes the
      // accessible name and the desktop tooltip, so a screen reader still
      // announces "Croquettes" rather than "button".
      nav.appendChild(el('button', {
        type: 'button',
        class: 'tab',
        'aria-label': view.label,
        title: view.label,
        'aria-pressed': 'false',
        dataset: { view: view.id },
        onclick: () => { location.hash = view.route; },
      }, glyph(TAB_ICONS[view.id], 19)));
    }
  }

  function showView(id) {
    for (const view of VIEWS) {
      $(`view-${view.id}`).hidden = view.id !== id;
    }
    for (const button of $('views').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.view === id));
    }
  }

  /* --- theme ------------------------------------------------------------- */

  // Three states, cycled: follow the OS, force light, force dark. Stamped on
  // <html> so the CSS variables swap; the charts then have to be repainted,
  // because an SVG attribute holds the colour it was given as a literal and
  // never re-resolves it.
  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    if (window.Charts) Charts.repaint();
  }
  const storedTheme = () => localStorage.getItem('dog-theme') || '';
  applyTheme(storedTheme());
  $('theme-btn').addEventListener('click', () => {
    const next = { '': 'light', light: 'dark', dark: '' }[storedTheme()];
    if (next) localStorage.setItem('dog-theme', next);
    else localStorage.removeItem('dog-theme');
    applyTheme(next);
    toast({ light: 'Thème clair', dark: 'Thème sombre', '': 'Thème du système' }[next]);
  });

  /* ======================================================================
     Tableau de bord
     ====================================================================== */

  function statTiles(stats, profile) {
    const tiles = el('div', { class: 'tiles' });

    const latest = stats.latest;
    const change = stats.change_since_previous;
    tiles.appendChild(el('div', { class: 'tile tile-hero' },
      el('span', { class: 'tile-label', text: 'Poids actuel' }),
      el('span', { class: 'tile-value', text: latest ? kg(latest.weight) : '—' }),
      el('span', {
        class: 'tile-note',
        text: latest
          ? (change === null || change === 0
            ? `pesé ${daysAgo(latest.date)}`
            : `${signedKg(change)} depuis la pesée précédente`)
          : 'aucune pesée',
      }),
    ));

    // The target tile is the one number the whole app is organised around, so
    // it is editable where it is read rather than two screens away.
    const delta = stats.delta_to_target;
    tiles.appendChild(el('div', { class: 'tile' },
      el('span', { class: 'tile-label', text: 'Poids de forme' }),
      el('span', {
        class: 'tile-value',
        text: profile.target_weight != null ? kg(profile.target_weight) : '—',
      }),
      profile.target_weight == null
        ? el('button', {
          class: 'btn btn-sm', type: 'button', text: 'Le définir',
          onclick: () => { location.hash = '#/profil'; },
        })
        : el('span', {
          class: 'tile-note' + (stats.at_target ? ' is-good' : ''),
          text: delta == null ? ''
            : stats.at_target ? 'objectif atteint'
              : delta > 0 ? `${kg(delta)} à perdre` : `${kg(-delta)} à prendre`,
        }),
    ));

    const slope = stats.trend_kg_per_week;
    tiles.appendChild(el('div', { class: 'tile' },
      el('span', { class: 'tile-label', text: 'Tendance' }),
      el('span', {
        class: 'tile-value',
        text: slope == null ? '—' : `${signed(slope, 2)} kg`,
      }),
      el('span', {
        class: 'tile-note' + (stats.losing_too_fast ? ' is-bad' : ''),
        text: slope == null
          ? 'au moins deux pesées'
          : stats.losing_too_fast
            ? 'par semaine — perte trop rapide'
            : `par semaine, sur ${stats.trend_window_days} jours`,
      }),
    ));

    tiles.appendChild(el('div', { class: 'tile' },
      el('span', { class: 'tile-label', text: 'Objectif atteint' }),
      el('span', {
        class: 'tile-value',
        text: stats.at_target ? '✓' : stats.eta_date ? shortDate(stats.eta_date) : '—',
      }),
      el('span', {
        class: 'tile-note',
        text: stats.at_target ? 'maintenu'
          : stats.eta_date ? 'au rythme actuel'
            : profile.target_weight == null ? 'pas d’objectif'
              : 'la tendance ne va pas dans ce sens',
      }),
    ));

    return tiles;
  }

  function chartCard(title, sub, mount, extra) {
    const holder = el('div', { class: 'chart' });
    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', { text: title }),
        el('span', { class: 'card-sub', text: sub }),
      ),
      el('div', { class: 'chart-scroll' }, holder),
      extra,
    );
    // Mounted after the card is in the document, because the renderer sizes
    // itself from clientWidth and an unattached node has none.
    requestAnimationFrame(() => mount(holder));
    return card;
  }

  function adviceCard(advice, latestEntry) {
    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', { text: 'Conseils' }),
        el('span', {
          class: 'card-sub',
          text: latestEntry ? `d’après la pesée du ${longDate(latestEntry.date)}` : '',
        }),
      ),
    );

    if (!advice || advice.status === 'none') {
      card.appendChild(el('p', {
        class: 'empty-note',
        text: 'Les conseils arrivent tout seuls après chaque pesée.',
      }));
      return card;
    }

    if (advice.status === 'pending') {
      card.appendChild(el('div', { class: 'advice-state' },
        el('span', { class: 'spinner' }),
        el('span', { text: 'Claude relit l’historique…' }),
      ));
      return card;
    }

    if (advice.status === 'error') {
      card.appendChild(el('div', { class: 'advice-state' },
        el('span', { text: advice.error || 'La génération a échoué.' }),
      ));
      if (latestEntry) {
        card.appendChild(el('div', { class: 'form-actions' },
          el('button', {
            class: 'btn btn-sm', type: 'button', text: 'Réessayer',
            onclick: async () => {
              try {
                await api(`/api/weights/${latestEntry.id}/advice`, { method: 'POST' });
                pollAdvice();
                await refresh();
              } catch (error) { toast(error.message); }
            },
          }),
        ));
      }
      return card;
    }

    if (advice.summary) card.appendChild(el('p', { class: 'advice-summary', text: advice.summary }));

    const list = el('ul', { class: 'hints' });
    for (const hint of advice.hints) {
      list.appendChild(el('li', { class: 'hint' },
        hint.title && el('span', { class: 'hint-title', text: hint.title }),
        hint.detail && el('span', { class: 'hint-detail', text: hint.detail }),
      ));
    }
    card.appendChild(list);

    if (advice.caution) {
      card.appendChild(el('div', { class: 'caution' },
        icon(WARN_ICON, 15),
        el('span', { text: advice.caution }),
      ));
    }
    return card;
  }

  function renderDashboard() {
    const view = $('view-dashboard');
    clear(view);
    const data = state.dashboard;
    if (!data) return;

    const { profile, entries, stats, periods, advice } = data;

    if (!entries.length) {
      view.appendChild(el('div', { class: 'card' },
        el('h2', { text: `Bienvenue${profile.name ? ', ' + profile.name : ''}` }),
        el('p', {
          class: 'empty-note',
          text: 'Aucune pesée pour l’instant. Ajoutez-en une et les courbes, '
            + 'l’écart au poids de forme et les conseils apparaîtront ici.',
        }),
        el('div', { class: 'form-actions' },
          el('button', {
            class: 'btn btn-primary', type: 'button', text: 'Première pesée',
            onclick: () => openWeighDialog(null),
          }),
        ),
      ));
      return;
    }

    view.appendChild(statTiles(stats, profile));

    // The food changes the ration chart annotates: the first period isn't a
    // change, so it is dropped on the way in.
    const changes = periods.slice(1).map((period) => ({
      date: period.from,
      label: period.label || 'croquettes inconnues',
    }));

    view.appendChild(chartCard(
      'Poids',
      profile.target_weight != null
        ? `objectif ${kg(profile.target_weight)}`
        : `${entries.length} pesées`,
      (holder) => Charts.weight(holder, {
        points: entries.map((e) => ({
          date: e.date, weight: e.weight, grams: e.grams, kibble: e.kibble_label,
        })),
        target: profile.target_weight,
        targetLabel: `poids de forme ${kg(profile.target_weight || 0)}`,
        ariaLabel: `Poids de ${profile.name || 'le chien'} du ${longDate(entries[0].date)} `
          + `au ${longDate(entries[entries.length - 1].date)}`,
      }),
      el('p', { class: 'chart-note' },
        'L’axe ne part pas de zéro : ce qui compte ici est la variation. ',
        el('a', { href: '#/pesees', text: 'Voir le tableau' }),
      ),
    ));

    if (entries.some((e) => e.grams != null)) {
      view.appendChild(chartCard(
        'Ration journalière',
        'en grammes, telle qu’elle a été notée',
        (holder) => Charts.ration(holder, {
          points: entries.map((e) => ({
            date: e.date, grams: e.grams, kcal: e.kcal, kibble: e.kibble_label,
          })),
          changes,
          ariaLabel: 'Ration journalière en grammes, avec les changements de croquettes',
        }),
        changes.length
          ? el('p', { class: 'chart-note', text: 'Les traits pointillés marquent un changement de croquettes.' })
          : null,
      ));
    }

    view.appendChild(adviceCard(advice, entries[entries.length - 1]));
  }

  /* --- polling ----------------------------------------------------------- */

  // A generation takes tens of seconds, so the save returns first and the
  // dashboard catches up. Polling stops the moment it lands, and gives up
  // after four minutes rather than asking forever.
  function pollAdvice() {
    clearInterval(state.advicePoll);
    let tries = 0;
    state.advicePoll = setInterval(async () => {
      if (++tries > 80) { clearInterval(state.advicePoll); return; }
      try {
        const advice = await api('/api/advice/latest');
        if (advice.status === 'pending') return;
        clearInterval(state.advicePoll);
        if (state.dashboard) {
          state.dashboard.advice = advice;
          if (!$('view-dashboard').hidden) renderDashboard();
        }
      } catch (_) { /* a blip; the next tick tries again */ }
    }, 3000);
  }

  /* ======================================================================
     Pesées
     ====================================================================== */

  const weightForm = { editing: null };

  function kibbleOptions(selected) {
    const select = el('select', { class: 'input', id: 'w-kibble' });
    select.appendChild(el('option', { value: '', text: '— non renseigné —' }));
    for (const kibble of state.kibbles) {
      // An archived food stays selectable only on the entry already using it,
      // so correcting an old row never means un-archiving a bag you threw out.
      if (kibble.archived && kibble.id !== selected) continue;
      select.appendChild(el('option', {
        value: String(kibble.id),
        text: kibble.label,
        selected: kibble.id === selected,
      }));
    }
    return select;
  }

  /** The weighing form, as a modal. Lives in a dialog rather than on the
   *  Pesées screen because it is used once every three weeks and was taking
   *  half the screen for the other twenty-one days. `<dialog>` is used for
   *  the real thing it gives: Escape, focus trapping and inertness for free,
   *  none of which a div pretending to be a modal gets right. */
  let weighDialog = null;

  function openWeighDialog(entry) {
    weightForm.editing = entry || null;
    if (!weighDialog) {
      weighDialog = el('dialog', { class: 'sheet', 'aria-labelledby': 'weigh-title' });
      // Clicking the backdrop closes it. The check is on the target being the
      // dialog itself: the form inside is a child, and without this a click
      // that lands between two fields would dismiss a half-typed entry.
      weighDialog.addEventListener('click', (event) => {
        if (event.target === weighDialog) weighDialog.close();
      });
      weighDialog.addEventListener('close', () => { weightForm.editing = null; });
      document.body.appendChild(weighDialog);
    }
    clear(weighDialog);
    weighDialog.append(
      el('div', { class: 'sheet-head' },
        el('h2', { id: 'weigh-title', text: entry ? 'Corriger la pesée' : 'Nouvelle pesée' }),
        el('button', {
          class: 'btn btn-icon', type: 'button', 'aria-label': 'Fermer',
          onclick: () => weighDialog.close(),
        }, glyph([['path', { d: 'M4 4 L12 12 M12 4 L4 12' }]], 15)),
      ),
      weightEditor(),
    );
    weighDialog.showModal();
    // showModal focuses the first focusable thing, which is the date — and
    // the date is already right. The weight is what you came to type.
    const field = $('w-weight');
    if (field) { field.focus(); field.select(); }
  }

  function weightEditor() {
    const editing = weightForm.editing;
    const entry = editing || {};
    const error = el('p', { class: 'form-error field-wide' });

    const form = el('form', { class: 'form-grid', autocomplete: 'off' },
      el('div', { class: 'field' },
        el('label', { for: 'w-date', text: 'Date' }),
        el('input', { class: 'input', type: 'date', id: 'w-date', required: true,
          value: entry.date || today(), max: today() }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'w-weight', text: 'Poids (kg)' }),
        el('input', { class: 'input input-num', type: 'number', id: 'w-weight',
          step: '0.01', min: '0.5', max: '120', required: true,
          inputMode: 'decimal', value: entry.weight ?? '' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'w-kibble', text: 'Croquettes' }),
        kibbleOptions(entry.kibble_id ?? null),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'w-grams', text: 'Ration (g / jour)' }),
        el('input', { class: 'input input-num', type: 'number', id: 'w-grams',
          step: '1', min: '0', max: '3000', inputMode: 'numeric',
          value: entry.grams ?? '' }),
      ),
      el('div', { class: 'field field-wide' },
        el('label', { for: 'w-notes', text: 'Remarque' }),
        el('input', { class: 'input', type: 'text', id: 'w-notes',
          placeholder: 'friandises, sortie annulée, retour de vacances…',
          value: entry.notes || '' }),
      ),
      el('p', { class: 'field-wide card-sub',
        text: 'Une seule pesée par jour : repeser le même jour corrige la ligne.' }),
      error,
      // Cancel then confirm, left to right — the platform order everywhere
      // this app runs. Not `.form-actions`: that class sits on a `.field`,
      // which is a column, so the buttons would stack.
      el('div', { class: 'field-wide sheet-actions' },
        el('button', {
          class: 'btn', type: 'button', text: 'Annuler',
          onclick: () => weighDialog.close(),
        }),
        el('button', { class: 'btn btn-primary', type: 'submit',
          text: editing ? 'Enregistrer' : 'Ajouter la pesée' }),
      ),
    );

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      const payload = {
        date: $('w-date').value,
        weight: $('w-weight').value,
        kibble_id: $('w-kibble').value || null,
        grams: $('w-grams').value || null,
        notes: $('w-notes').value,
      };
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        if (editing) {
          await api(`/api/weights/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        } else {
          await api('/api/weights', { method: 'POST', body: JSON.stringify(payload) });
        }
        weighDialog.close();
        toast('Pesée enregistrée — les conseils arrivent.');
        pollAdvice();
        await refresh();
      } catch (exception) {
        error.textContent = exception.message;
      } finally {
        button.disabled = false;
      }
    });
    return form;
  }

  function renderWeights() {
    const view = $('view-weights');
    clear(view);
    const data = state.dashboard;
    if (!data) return;

    const entries = data.entries.slice().reverse();   // newest first, to read
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {},
      el('th', { text: 'Date' }),
      el('th', { class: 'num', text: 'Poids' }),
      el('th', { class: 'num', text: 'Écart' }),
      el('th', { text: 'Croquettes' }),
      el('th', { class: 'num', text: 'Ration' }),
      el('th', { text: 'Remarque' }),
      el('th', {}),
    )));

    const body = el('tbody');
    for (const entry of entries) {
      const delta = data.profile.target_weight == null
        ? null : entry.weight - data.profile.target_weight;
      body.appendChild(el('tr', {},
        el('td', { text: longDate(entry.date) }),
        el('td', { class: 'num', text: kg(entry.weight) }),
        el('td', { class: 'num', text: delta == null ? '—' : signedKg(delta) }),
        el('td', { text: entry.kibble_label || '—' }),
        el('td', { class: 'num', text: entry.grams == null ? '—' : `${num(entry.grams)} g` }),
        el('td', { text: entry.notes || '' }),
        el('td', {}, el('div', { class: 'row-tools' },
          el('button', {
            class: 'btn btn-sm', type: 'button', text: 'Modifier',
            onclick: () => openWeighDialog(entry),
          }),
          el('button', {
            class: 'btn btn-sm btn-danger', type: 'button', text: 'Supprimer',
            onclick: async () => {
              if (!confirm(`Supprimer la pesée du ${longDate(entry.date)} ?`)) return;
              try {
                await api(`/api/weights/${entry.id}`, { method: 'DELETE' });
                toast('Pesée supprimée.');
                await refresh();
              } catch (error) { toast(error.message); }
            },
          }),
        )),
      ));
    }
    table.appendChild(body);

    view.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', { text: 'Historique' }),
        el('span', { class: 'card-sub', text: `${data.entries.length} pesées` }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: 'Ajouter une pesée',
          onclick: () => openWeighDialog(null),
        }),
      ),
      entries.length
        ? el('div', { class: 'table-wrap' }, table)
        : el('p', { class: 'empty-note', text: 'Rien pour l’instant.' }),
    ));
  }

  /* ======================================================================
     Croquettes
     ====================================================================== */

  const kibbleForm = { editing: null, open: false, photos: [] };

  async function uploadPhoto(file) {
    // Downscaled in the browser before it is sent: a modern phone camera
    // produces 4–8 MB per shot, and none of that resolution survives being
    // shown at 76px.
    const blob = await downscale(file);
    const response = await fetch('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || 'Envoi impossible.');
    }
    return (await response.json()).path;
  }

  function downscale(file, max = 1280) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        // Already small enough: re-encoding would only lose quality.
        if (scale === 1 && file.size < 1.5e6) return resolve(file);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.85);
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
      image.src = url;
    });
  }

  function photoPicker() {
    const picker = el('div', { class: 'photo-picker' });
    const file = el('input', { type: 'file', accept: 'image/*', hidden: true });

    const redraw = () => {
      clear(picker);
      kibbleForm.photos.forEach((path, index) => {
        picker.appendChild(el('div', { class: 'photo-slot' },
          el('img', { src: path, alt: `Photo ${index + 1}`, loading: 'lazy' }),
          el('button', {
            class: 'photo-remove', type: 'button', text: '×',
            'aria-label': `Retirer la photo ${index + 1}`,
            onclick: () => { kibbleForm.photos.splice(index, 1); redraw(); },
          }),
        ));
      });
      if (kibbleForm.photos.length < 6) {
        picker.appendChild(el('button', {
          class: 'photo-add', type: 'button', text: '+',
          'aria-label': 'Ajouter une photo',
          onclick: () => file.click(),
        }));
      }
      picker.appendChild(file);
    };

    file.addEventListener('change', async () => {
      const chosen = file.files && file.files[0];
      file.value = '';
      if (!chosen) return;
      try {
        kibbleForm.photos.push(await uploadPhoto(chosen));
        redraw();
      } catch (error) { toast(error.message); }
    });

    redraw();
    return picker;
  }

  function kibbleEditor() {
    const editing = kibbleForm.editing;
    const kibble = editing || {};
    const error = el('p', { class: 'form-error' });

    const form = el('form', { class: 'form-grid', autocomplete: 'off' },
      el('div', { class: 'field' },
        el('label', { for: 'k-brand', text: 'Marque' }),
        el('input', { class: 'input', type: 'text', id: 'k-brand', required: true,
          placeholder: 'Royal Canin', value: kibble.brand || '' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'k-variety', text: 'Type' }),
        el('input', { class: 'input', type: 'text', id: 'k-variety',
          placeholder: 'Medium Adult', value: kibble.variety || '' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'k-kcal', text: 'kcal / 100 g' }),
        el('input', { class: 'input input-num', type: 'number', id: 'k-kcal',
          step: '1', min: '50', max: '900', inputMode: 'numeric',
          value: kibble.kcal_per_100g ?? '' }),
        el('span', { class: 'hint', text: 'Sur le sac. Sans ça, pas de calcul d’apport.' }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'label', text: 'Statut' }),
        el('label', { class: 'check' },
          el('input', { type: 'checkbox', id: 'k-archived', checked: !!kibble.archived }),
          el('span', { text: 'Archivée (plus proposée)' }),
        ),
      ),
      el('div', { class: 'field field-wide' },
        el('label', { for: 'k-notes', text: 'Notes' }),
        el('textarea', { class: 'input', id: 'k-notes', rows: 2,
          placeholder: 'Ration conseillée sur le sac, tolérance, prix…',
          value: kibble.notes || '' }),
      ),
      el('div', { class: 'field field-wide' },
        el('span', { class: 'label', text: 'Photos du sac' }),
        photoPicker(),
      ),
      el('div', { class: 'field field-wide form-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit',
          text: editing ? 'Enregistrer' : 'Ajouter' }),
        el('button', {
          class: 'btn', type: 'button', text: 'Annuler',
          onclick: () => { kibbleForm.open = false; kibbleForm.editing = null; renderKibbles(); },
        }),
      ),
      error,
    );

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      const payload = {
        brand: $('k-brand').value,
        variety: $('k-variety').value,
        kcal_per_100g: $('k-kcal').value || null,
        notes: $('k-notes').value,
        archived: $('k-archived').checked,
        photos: kibbleForm.photos,
      };
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        if (editing) {
          await api(`/api/kibbles/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        } else {
          await api('/api/kibbles', { method: 'POST', body: JSON.stringify(payload) });
        }
        kibbleForm.open = false;
        kibbleForm.editing = null;
        toast('Croquettes enregistrées.');
        await refresh();
      } catch (exception) {
        error.textContent = exception.message;
      } finally {
        button.disabled = false;
      }
    });
    return form;
  }

  function renderKibbles() {
    const view = $('view-kibbles');
    clear(view);

    if (kibbleForm.open) {
      view.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h2', { text: kibbleForm.editing ? 'Modifier les croquettes' : 'Nouvelles croquettes' }),
        ),
        kibbleEditor(),
      ));
    } else {
      view.appendChild(el('div', { class: 'card-head' },
        el('h2', { text: 'Croquettes' }),
        el('span', { class: 'card-sub', text: `${state.kibbles.length} référencée(s)` }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: 'Ajouter',
          onclick: () => {
            kibbleForm.open = true;
            kibbleForm.editing = null;
            kibbleForm.photos = [];
            renderKibbles();
          },
        }),
      ));
    }

    if (!state.kibbles.length) {
      view.appendChild(el('p', {
        class: 'empty-note',
        text: 'Aucune croquette. Ajoutez-en une pour pouvoir la relier à vos pesées.',
      }));
      return;
    }

    const grid = el('div', { class: 'kibble-grid' });
    for (const kibble of state.kibbles) {
      const meta = [
        kibble.kcal_per_100g != null ? `${num(kibble.kcal_per_100g)} kcal/100 g` : null,
        kibble.uses ? `${kibble.uses} pesée${kibble.uses > 1 ? 's' : ''}` : 'jamais utilisée',
        kibble.last_used ? `dernière fois ${daysAgo(kibble.last_used)}` : null,
      ].filter(Boolean).join(' · ');

      grid.appendChild(el('div', { class: 'card kibble-card' + (kibble.archived ? ' is-archived' : '') },
        el('div', { class: 'card-head' },
          el('span', { class: 'kibble-name', text: kibble.label }),
          kibble.archived && el('span', { class: 'badge', text: 'archivée' }),
        ),
        el('span', { class: 'kibble-meta', text: meta }),
        kibble.notes && el('span', { class: 'kibble-meta', text: kibble.notes }),
        kibble.photos.length ? el('div', { class: 'photo-strip' },
          kibble.photos.map((path, index) => el('a', { href: path, target: '_blank', rel: 'noopener' },
            el('img', { src: path, alt: `${kibble.label}, photo ${index + 1}`, loading: 'lazy' }),
          )),
        ) : null,
        el('div', { class: 'row-tools' },
          el('button', {
            class: 'btn btn-sm', type: 'button', text: 'Modifier',
            onclick: () => {
              kibbleForm.open = true;
              kibbleForm.editing = kibble;
              kibbleForm.photos = kibble.photos.slice();
              renderKibbles();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            },
          }),
          // Deleting is only offered where it is allowed. A food in use is
          // archived instead, and the server refuses the other case anyway.
          kibble.uses === 0 && el('button', {
            class: 'btn btn-sm btn-danger', type: 'button', text: 'Supprimer',
            onclick: async () => {
              if (!confirm(`Supprimer « ${kibble.label} » ?`)) return;
              try {
                await api(`/api/kibbles/${kibble.id}`, { method: 'DELETE' });
                toast('Croquettes supprimées.');
                await refresh();
              } catch (error) { toast(error.message); }
            },
          }),
        ),
      ));
    }
    view.appendChild(grid);
  }

  /* --- rappels ----------------------------------------------------------- */

  // The browser wants the application server key as a Uint8Array, and the
  // server sends it as unpadded base64url — which atob() does not take.
  function decodeKey(base64url) {
    const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (base64url.length % 4)) % 4);
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  const pushSupported = () => 'serviceWorker' in navigator
    && 'PushManager' in window && 'Notification' in window;

  async function currentSubscription() {
    if (!pushSupported()) return null;
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }

  async function enableReminders(publicKey) {
    // iOS only grants this from a user gesture, and only once: a denied
    // permission cannot be re-asked from script, which is why the UI says so
    // rather than offering the button again.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error(permission === 'denied'
        ? 'Notifications refusées. Autorisez-les dans les réglages de l’app, puis réessayez.'
        : 'Notifications non autorisées.');
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    });
    await api('/api/push/subscribe', {
      method: 'POST', body: JSON.stringify(subscription.toJSON()),
    });
  }

  async function disableReminders() {
    const subscription = await currentSubscription();
    if (!subscription) return;
    await api('/api/push/unsubscribe', {
      method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  }

  function reminderCard(reminder) {
    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', { text: 'Rappel de pesée' }),
        el('span', {
          class: 'card-sub',
          text: `tous les ${reminder.every_days} jours`,
        }),
      ),
    );

    card.appendChild(el('p', {
      class: 'card-sub',
      text: reminder.last_weighing
        ? `Dernière pesée ${daysAgo(reminder.last_weighing)}. `
          + (reminder.due
            ? 'C’est le moment.'
            : `Prochain rappel à partir du ${longDate(reminder.due_date)}.`)
        : 'Le rappel démarre à la première pesée.',
    }));

    if (!pushSupported()) {
      card.appendChild(el('p', {
        class: 'empty-note',
        text: 'Ce navigateur ne gère pas les notifications. Sur iPhone, il faut '
          + 'd’abord ajouter l’app à l’écran d’accueil.',
      }));
      return card;
    }

    const state = el('p', { class: 'card-sub' });
    const actions = el('div', { class: 'form-actions' });
    card.append(state, actions);

    // The server knows how many devices are subscribed; only the browser
    // knows whether *this* one is. Both are worth saying.
    const paint = async () => {
      clear(actions);
      const subscription = await currentSubscription();
      const others = Math.max(0, reminder.subscriptions - (subscription ? 1 : 0));
      state.textContent = subscription
        ? 'Les rappels sont actifs sur cet appareil.'
          + (others ? ` (${others} autre${others > 1 ? 's' : ''})` : '')
        : reminder.subscriptions
          ? `Pas sur cet appareil — ${reminder.subscriptions} autre(s) appareil(s) abonné(s).`
          : 'Aucun appareil abonné.';

      actions.appendChild(el('button', {
        class: subscription ? 'btn' : 'btn btn-primary',
        type: 'button',
        text: subscription ? 'Désactiver sur cet appareil' : 'Activer les rappels',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            if (subscription) {
              await disableReminders();
              toast('Rappels désactivés.');
            } else {
              await enableReminders(reminder.public_key);
              toast('Rappels activés.');
            }
            await refresh();
          } catch (error) {
            toast(error.message);
            button.disabled = false;
          }
        },
      }));

      if (subscription) {
        actions.appendChild(el('button', {
          class: 'btn btn-sm', type: 'button', text: 'Envoyer un test',
          onclick: async () => {
            try {
              const result = await api('/api/push/test', { method: 'POST' });
              toast(result.sent
                ? `Test envoyé à ${result.sent} appareil(s).`
                : 'Aucun appareil joignable.');
            } catch (error) { toast(error.message); }
          },
        }));
      }
    };
    paint();
    return card;
  }

  /* ======================================================================
     Vaccins
     ====================================================================== */

  // The booklet holds one line per sticker; what you want to read first is
  // per disease — "rage : jusqu'au 8 sept. 2028". So the card leads with that
  // status, and the injections themselves follow, grouped by visit.
  const VACC_STATE = {
    ok: { text: 'à jour', cls: 'is-good' },
    soon: { text: 'bientôt', cls: 'is-warn' },
    expired: { text: 'expiré', cls: 'is-bad' },
    pending: { text: 'pas encore valable', cls: 'is-warn' },
    unknown: { text: 'date non notée', cls: '' },
  };

  function vaccineStatusLine(line) {
    const meta = VACC_STATE[line.state];
    let note;
    if (!line.valid_until) note = `dernière injection le ${longDate(line.last_date)}`;
    else if (line.state === 'expired') note = `expiré depuis le ${longDate(line.valid_until)}`;
    else if (line.state === 'pending') note = `valable à partir du ${longDate(line.valid_from)}`;
    else note = `jusqu’au ${longDate(line.valid_until)}`
      + (line.state === 'soon' ? ` (dans ${line.days_left} j)` : '');
    return el('li', { class: 'vacc-status' },
      el('span', { class: 'vacc-disease', text: line.label }),
      el('span', { class: 'vacc-until', text: note }),
      el('span', { class: `badge ${meta.cls}`, text: meta.text }),
    );
  }

  function vaccinesCard(data) {
    const { vaccinations, status } = data;
    const card = el('div', { class: 'card', id: 'vaccines' },
      el('div', { class: 'card-head' },
        el('h2', { text: 'Vaccins' }),
        el('span', {
          class: 'card-sub',
          text: vaccinations.length
            ? `${vaccinations.length} injection${vaccinations.length > 1 ? 's' : ''}` : '',
        }),
        el('button', {
          class: 'btn btn-primary btn-sm', type: 'button', text: 'Ajouter',
          onclick: () => openVaccineDialog(null),
        }),
      ),
    );

    if (!vaccinations.length) {
      card.appendChild(el('p', {
        class: 'empty-note',
        text: 'Aucun vaccin. Recopiez le carnet ligne par ligne : une ligne par vignette.',
      }));
      return card;
    }

    card.appendChild(el('ul', { class: 'vacc-statuses' }, status.map(vaccineStatusLine)));
    card.appendChild(el('p', {
      class: 'card-sub',
      text: 'Dates de validité telles que notées par le vétérinaire dans le carnet. '
        + `Notification ${data.soon_days} jours puis 7 jours avant l’échéance, `
        + 'puis tous les 30 jours tant qu’un vaccin reste expiré.',
    }));

    // One block per visit: the date, who signed, then every sticker of the day.
    const visits = [];
    for (const shot of vaccinations) {
      const last = visits[visits.length - 1];
      if (last && last.date === shot.date) last.shots.push(shot);
      else visits.push({ date: shot.date, shots: [shot] });
    }

    const history = el('div', { class: 'vacc-visits' });
    for (const visit of visits) {
      const vets = [...new Set(visit.shots.map((s) => s.vet).filter(Boolean))].join(', ');
      history.appendChild(el('div', { class: 'vacc-visit' },
        el('div', { class: 'vacc-visit-head' },
          el('span', { class: 'vacc-date', text: longDate(visit.date) }),
          vets && el('span', { class: 'card-sub', text: vets }),
        ),
        el('ul', { class: 'vacc-shots' }, visit.shots.map((shot) => el('li', {},
          el('button', {
            class: 'vacc-shot', type: 'button',
            'aria-label': `Modifier ${shot.vaccine} du ${longDate(shot.date)}`,
            onclick: () => openVaccineDialog(shot),
          },
          el('span', { class: 'vacc-name', text: shot.vaccine }),
          el('span', { class: 'vacc-codes', text: shot.diseases.join(' · ') || '—' }),
          el('span', {
            class: 'vacc-meta',
            text: [
              shot.batch ? `lot ${shot.batch}` : null,
              shot.valid_until ? `valable jusqu’au ${shortDate(shot.valid_until)}` : null,
            ].filter(Boolean).join(' · '),
          }),
          shot.notes && el('span', { class: 'vacc-meta', text: shot.notes })),
        ))),
      ));
    }
    card.appendChild(el('details', { class: 'vacc-history' },
      el('summary', { text: `Historique (${visits.length} visite${visits.length > 1 ? 's' : ''})` }),
      history,
    ));
    return card;
  }

  let vaccineDialog = null;

  function openVaccineDialog(shot) {
    const info = state.dashboard.vaccines;
    if (!vaccineDialog) {
      vaccineDialog = el('dialog', { class: 'sheet', 'aria-labelledby': 'vacc-title' });
      vaccineDialog.addEventListener('click', (event) => {
        if (event.target === vaccineDialog) vaccineDialog.close();
      });
      document.body.appendChild(vaccineDialog);
    }
    const editing = !!shot;
    // A new line starts from the last visit's vet: it is nearly always the same.
    const entry = shot || { date: today(), diseases: [], vet: info.vaccinations[0]?.vet || '' };
    const error = el('p', { class: 'form-error field-wide' });

    const productList = el('datalist', { id: 'vacc-products' },
      Object.keys(info.known).map((name) => el('option', { value: name })));
    const vetList = el('datalist', { id: 'vacc-vets' },
      [...new Set(info.vaccinations.map((v) => v.vet).filter(Boolean))]
        .map((name) => el('option', { value: name })));

    const boxes = Object.entries(info.diseases).map(([code, label]) => el('label', { class: 'check' },
      el('input', { type: 'checkbox', value: code, checked: entry.diseases.includes(code) }),
      el('span', { text: `${label} (${code})` }),
    ));
    const checked = () => boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);

    const name = el('input', { class: 'input', type: 'text', id: 'v-vaccine', required: true,
      list: 'vacc-products', placeholder: 'Nobivac Rabies', value: entry.vaccine || '' });
    // Picking a known product ticks what it covers — still editable after.
    name.addEventListener('change', () => {
      const covers = info.known[name.value.trim()];
      if (!covers) return;
      for (const box of boxes) box.querySelector('input').checked = covers.includes(box.querySelector('input').value);
    });

    const form = el('form', { class: 'form-grid', autocomplete: 'off' },
      el('div', { class: 'field' },
        el('label', { for: 'v-date', text: 'Date de vaccination' }),
        el('input', { class: 'input', type: 'date', id: 'v-date', required: true,
          value: entry.date || '', max: today() }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'v-vaccine', text: 'Vaccin' }), name, productList,
      ),
      el('div', { class: 'field field-wide' },
        el('span', { class: 'label', text: 'Protège contre' }),
        el('div', { class: 'vacc-boxes' }, boxes),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'v-batch', text: 'Numéro de lot' }),
        el('input', { class: 'input input-num', type: 'text', id: 'v-batch',
          value: entry.batch || '' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'v-until', text: 'Valable jusqu’au' }),
        el('input', { class: 'input', type: 'date', id: 'v-until', value: entry.valid_until || '' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'v-from', text: 'Valable depuis' }),
        el('input', { class: 'input', type: 'date', id: 'v-from', value: entry.valid_from || '' }),
        el('span', { class: 'hint', text: 'Rage seulement, si le carnet l’indique.' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'v-vet', text: 'Vétérinaire' }),
        el('input', { class: 'input', type: 'text', id: 'v-vet', list: 'vacc-vets',
          value: entry.vet || '' }),
        vetList,
      ),
      el('div', { class: 'field field-wide' },
        el('label', { for: 'v-notes', text: 'Remarque' }),
        el('input', { class: 'input', type: 'text', id: 'v-notes',
          placeholder: 'poids chez le véto, réaction, rappel prévu…', value: entry.notes || '' }),
      ),
      error,
      el('div', { class: 'field-wide sheet-actions' },
        editing && el('button', {
          class: 'btn btn-danger', type: 'button', text: 'Supprimer',
          onclick: async () => {
            if (!confirm(`Supprimer ${shot.vaccine} du ${longDate(shot.date)} ?`)) return;
            try {
              await api(`/api/vaccinations/${shot.id}`, { method: 'DELETE' });
              vaccineDialog.close();
              toast('Vaccin supprimé.');
              await refresh();
            } catch (exception) { error.textContent = exception.message; }
          },
        }),
        el('button', { class: 'btn', type: 'button', text: 'Annuler',
          onclick: () => vaccineDialog.close() }),
        el('button', { class: 'btn btn-primary', type: 'submit',
          text: editing ? 'Enregistrer' : 'Ajouter' }),
      ),
    );

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      const payload = {
        date: $('v-date').value,
        vaccine: name.value,
        diseases: checked(),
        batch: $('v-batch').value,
        valid_from: $('v-from').value || null,
        valid_until: $('v-until').value || null,
        vet: $('v-vet').value,
        notes: $('v-notes').value,
      };
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        if (editing) {
          await api(`/api/vaccinations/${shot.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        } else {
          await api('/api/vaccinations', { method: 'POST', body: JSON.stringify(payload) });
        }
        vaccineDialog.close();
        toast('Vaccin enregistré.');
        await refresh();
      } catch (exception) {
        error.textContent = exception.message;
      } finally {
        button.disabled = false;
      }
    });

    clear(vaccineDialog);
    vaccineDialog.append(
      el('div', { class: 'sheet-head' },
        el('h2', { id: 'vacc-title', text: editing ? 'Modifier le vaccin' : 'Nouveau vaccin' }),
        el('button', {
          class: 'btn btn-icon', type: 'button', 'aria-label': 'Fermer',
          onclick: () => vaccineDialog.close(),
        }, glyph([['path', { d: 'M4 4 L12 12 M12 4 L4 12' }]], 15)),
      ),
      form,
    );
    vaccineDialog.showModal();
  }

  /* ======================================================================
     Profil
     ====================================================================== */

  function renderProfile() {
    const view = $('view-profile');
    clear(view);
    const data = state.dashboard;
    if (!data) return;
    const dog = data.profile;
    const error = el('p', { class: 'form-error' });

    const activity = el('select', { class: 'input', id: 'p-activity' });
    activity.appendChild(el('option', { value: '', text: '— non renseigné —' }));
    for (const level of data.activity_levels) {
      activity.appendChild(el('option', {
        value: level, text: level, selected: level === dog.activity,
      }));
    }

    const sex = el('select', { class: 'input', id: 'p-sex' });
    for (const [value, label] of [['', '— non renseigné —'], ['F', 'femelle'], ['M', 'mâle']]) {
      sex.appendChild(el('option', { value, text: label, selected: value === dog.sex }));
    }

    const form = el('form', { class: 'form-grid', autocomplete: 'off' },
      el('div', { class: 'field' },
        el('label', { for: 'p-name', text: 'Nom' }),
        el('input', { class: 'input', type: 'text', id: 'p-name', value: dog.name || '' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'p-breed', text: 'Race' }),
        el('input', { class: 'input', type: 'text', id: 'p-breed', value: dog.breed || '' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'p-birth', text: 'Date de naissance' }),
        el('input', { class: 'input', type: 'date', id: 'p-birth',
          value: dog.birth_date || '', max: today() }),
        dog.age && el('span', { class: 'hint',
          text: `${dog.age.years} ans et ${dog.age.months} mois` }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'p-sex', text: 'Sexe' }),
        sex,
      ),
      el('div', { class: 'field' },
        el('label', { for: 'p-microchip', text: 'Numéro de puce' }),
        el('input', { class: 'input input-num', type: 'text', id: 'p-microchip',
          inputMode: 'numeric', autocomplete: 'off', placeholder: '250268500123456',
          value: dog.microchip || '' }),
        el('span', { class: 'hint', text: 'Les espaces sont retirés à l’enregistrement.' }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'label', text: 'Stérilisation' }),
        el('label', { class: 'check' },
          el('input', { type: 'checkbox', id: 'p-neutered', checked: !!dog.neutered }),
          el('span', { text: 'Stérilisé·e' }),
        ),
        el('span', { class: 'hint', text: 'Change nettement les besoins énergétiques.' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'p-target', text: 'Poids de forme (kg)' }),
        el('input', { class: 'input input-num', type: 'number', id: 'p-target',
          step: '0.1', min: '0.5', max: '120', inputMode: 'decimal',
          value: dog.target_weight ?? '' }),
        el('span', { class: 'hint', text: 'À demander au vétérinaire si vous hésitez.' }),
      ),
      el('div', { class: 'field' },
        el('label', { for: 'p-activity', text: 'Niveau d’activité' }),
        activity,
      ),
      el('div', { class: 'field field-wide' },
        el('label', { for: 'p-exercise', text: 'Exercice quotidien' }),
        el('input', { class: 'input', type: 'text', id: 'p-exercise',
          placeholder: '3,2 km de marche par jour + 2 petites sorties',
          value: dog.exercise || '' }),
        el('span', { class: 'hint', text: 'Décrit en clair : c’est ce qui sert à estimer la dépense.' }),
      ),
      el('div', { class: 'field field-wide' },
        el('label', { for: 'p-notes', text: 'Notes' }),
        el('textarea', { class: 'input', id: 'p-notes', rows: 3,
          placeholder: 'Allergies, consignes du vétérinaire, friandises habituelles…',
          value: dog.notes || '' }),
      ),
      el('div', { class: 'field field-wide form-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Enregistrer' }),
        el('span', { class: 'card-sub',
          text: 'Tout ce qui est ici part dans le contexte des conseils.' }),
      ),
      error,
    );

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      const payload = {
        name: $('p-name').value,
        breed: $('p-breed').value,
        birth_date: $('p-birth').value,
        sex: $('p-sex').value,
        neutered: $('p-neutered').checked,
        activity: $('p-activity').value,
        exercise: $('p-exercise').value,
        microchip: $('p-microchip').value,
        target_weight: $('p-target').value || null,
        notes: $('p-notes').value,
      };
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api('/api/profile', { method: 'PUT', body: JSON.stringify(payload) });
        toast('Profil enregistré.');
        await refresh();
      } catch (exception) {
        error.textContent = exception.message;
      } finally {
        button.disabled = false;
      }
    });

    view.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: 'Fiche du chien' })),
      form,
    ));

    if (data.vaccines) view.appendChild(vaccinesCard(data.vaccines));
    if (data.reminder) view.appendChild(reminderCard(data.reminder));
  }

  /* ======================================================================
     Routing and loading
     ====================================================================== */

  const RENDERERS = {
    dashboard: renderDashboard,
    weights: renderWeights,
    kibbles: renderKibbles,
    profile: renderProfile,
  };

  function currentView() {
    const route = location.hash || '#/';
    const match = VIEWS.find((view) => view.route === route);
    return match ? match.id : 'dashboard';
  }

  function route() {
    const id = currentView();
    showView(id);
    RENDERERS[id]();
  }

  async function refresh() {
    const [dashboard, kibbles] = await Promise.all([
      api('/api/dashboard'),
      api('/api/kibbles'),
    ]);
    state.dashboard = dashboard;
    state.kibbles = kibbles.kibbles;

    const dog = dashboard.profile;
    $('brand').textContent = dog.name || 'Carnet';
    $('brand-sub').textContent = dog.name ? dog.breed || '' : 'du chien';
    document.title = dog.name ? `Carnet de ${dog.name}` : 'Carnet de santé';

    const count = dashboard.entries.length;
    $('foot-note').textContent = count
      ? `${count} pesée${count > 1 ? 's' : ''} depuis le ${longDate(dashboard.stats.first_date)}`
      : '';

    // Hints already in flight when the page loaded must still be waited for.
    if (dashboard.advice && dashboard.advice.status === 'pending') pollAdvice();

    route();
  }

  window.addEventListener('hashchange', route);
  // Weighing is the one thing you do from anywhere, so it no longer navigates
  // — it opens over whatever screen you were on and leaves you there.
  $('new-btn').addEventListener('click', () => openWeighDialog(null));

  buildNav();
  refresh().catch((error) => {
    $('view-dashboard').appendChild(el('p', { class: 'form-error', text: error.message }));
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* fine offline */ });
    });
  }
})();
