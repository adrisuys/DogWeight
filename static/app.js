/* ==========================================================================
   Poids du chien : tableau de bord → pesées → croquettes → profil.

   Four screens behind a hash route, so the phone's back gesture and the
   browser's back button both do the obvious thing:

     #/            le tableau de bord : les chiffres, les deux courbes, les conseils
     #/pesees      toutes les pesées, en tableau — et le formulaire d'ajout
     #/croquettes  les types de croquettes, avec photos du sac
     #/profil      la fiche du chien et le poids de forme

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

  function icon(path, size = 14) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('aria-hidden', 'true');
    const d = document.createElementNS(ns, 'path');
    d.setAttribute('d', path);
    d.setAttribute('fill', 'currentColor');
    svg.appendChild(d);
    return svg;
  }

  const WARN_ICON = 'M8 1.2 15 14H1L8 1.2Zm0 4.3a.8.8 0 0 0-.8.85l.25 3.4a.55.55 0 0 0 1.1 0l.25-3.4A.8.8 0 0 0 8 5.5Zm0 5.4a.85.85 0 1 0 0 1.7.85.85 0 0 0 0-1.7Z';

  /* --- formatting -------------------------------------------------------- */

  const nf = (digits) => new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  const num = (value, digits = 0) => nf(digits).format(value);
  const signed = (value, digits = 1) => (value > 0 ? '+' : '') + num(value, digits);

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
      nav.appendChild(el('button', {
        type: 'button',
        text: view.label,
        'aria-pressed': 'false',
        dataset: { view: view.id },
        onclick: () => { location.hash = view.route; },
      }));
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
      el('span', { class: 'tile-value', text: latest ? `${num(latest.weight, 1)} kg` : '—' }),
      el('span', {
        class: 'tile-note',
        text: latest
          ? (change === null || change === 0
            ? `pesé ${daysAgo(latest.date)}`
            : `${signed(change)} kg depuis la pesée précédente`)
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
        text: profile.target_weight != null ? `${num(profile.target_weight, 1)} kg` : '—',
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
              : delta > 0 ? `${num(delta, 1)} kg à perdre` : `${num(-delta, 1)} kg à prendre`,
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
            onclick: () => { location.hash = '#/pesees'; },
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
        ? `objectif ${num(profile.target_weight, 1)} kg`
        : `${entries.length} pesées`,
      (holder) => Charts.weight(holder, {
        points: entries.map((e) => ({
          date: e.date, weight: e.weight, grams: e.grams, kibble: e.kibble_label,
        })),
        target: profile.target_weight,
        targetLabel: `poids de forme ${num(profile.target_weight || 0, 1)} kg`,
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

  function weightEditor() {
    const editing = weightForm.editing;
    const entry = editing || {};
    const error = el('p', { class: 'form-error' });

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
      el('div', { class: 'field field-wide form-actions' },
        el('button', { class: 'btn btn-primary', type: 'submit',
          text: editing ? 'Enregistrer' : 'Ajouter la pesée' }),
        editing && el('button', {
          class: 'btn', type: 'button', text: 'Annuler',
          onclick: () => { weightForm.editing = null; renderWeights(); },
        }),
        el('span', { class: 'card-sub',
          text: 'Une seule pesée par jour : repeser le même jour corrige la ligne.' }),
      ),
      error,
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
        weightForm.editing = null;
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

    view.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', { text: weightForm.editing ? 'Corriger une pesée' : 'Nouvelle pesée' }),
      ),
      weightEditor(),
    ));

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
        el('td', { class: 'num', text: `${num(entry.weight, 1)} kg` }),
        el('td', { class: 'num', text: delta == null ? '—' : `${signed(delta)} kg` }),
        el('td', { text: entry.kibble_label || '—' }),
        el('td', { class: 'num', text: entry.grams == null ? '—' : `${num(entry.grams)} g` }),
        el('td', { text: entry.notes || '' }),
        el('td', {}, el('div', { class: 'row-tools' },
          el('button', {
            class: 'btn btn-sm', type: 'button', text: 'Modifier',
            onclick: () => {
              weightForm.editing = entry;
              renderWeights();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            },
          }),
          el('button', {
            class: 'btn btn-sm btn-danger', type: 'button', text: 'Supprimer',
            onclick: async () => {
              if (!confirm(`Supprimer la pesée du ${longDate(entry.date)} ?`)) return;
              try {
                await api(`/api/weights/${entry.id}`, { method: 'DELETE' });
                if (weightForm.editing && weightForm.editing.id === entry.id) {
                  weightForm.editing = null;
                }
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
    $('brand').textContent = dog.name || 'Poids';
    $('brand-sub').textContent = dog.name ? dog.breed || '' : 'du chien';
    document.title = dog.name ? `Poids de ${dog.name}` : 'Poids du chien';

    const count = dashboard.entries.length;
    $('foot-note').textContent = count
      ? `${count} pesée${count > 1 ? 's' : ''} depuis le ${longDate(dashboard.stats.first_date)}`
      : '';

    // Hints already in flight when the page loaded must still be waited for.
    if (dashboard.advice && dashboard.advice.status === 'pending') pollAdvice();

    route();
  }

  window.addEventListener('hashchange', route);
  $('new-btn').addEventListener('click', () => {
    weightForm.editing = null;
    const wasOnWeights = currentView() === 'weights';
    location.hash = '#/pesees';
    // Already on the screen: the hash doesn't change, so nothing re-renders.
    if (wasOnWeights) renderWeights();
    requestAnimationFrame(() => {
      const field = $('w-weight');
      if (field) field.focus();
    });
  });

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
