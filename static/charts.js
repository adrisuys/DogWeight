/* ==========================================================================
   Charts — hand-rolled SVG. No dependencies, nothing to keep up to date.

   Two forms, one series each:

     Charts.weight(el, spec)   weight over time, with the target as a rule
     Charts.ration(el, spec)   daily grams over time, with food changes marked

   They are two charts rather than one with two axes on purpose. Kilograms and
   grams-per-day are different quantities on wildly different scales, and
   drawing them against two y-axes would let the reader infer a relationship
   from where the lines happen to cross — which is an artefact of the scales
   chosen, not a fact about the dog.

   Shared rules baked in here: one validated series colour per chart (so no
   legend box is needed — the card's heading names what is plotted), the
   target rule in muted ink because a goal is a reference and not a second
   measurement, markers carrying a 2px surface ring, a 2px gap between
   touching bars, grid and axes as recessive hairlines, and text always in
   text tokens rather than the series colour.

   The ration chart's baseline is zero, because the length of a bar is the
   value. The weight chart's is not: weight is read as change over time, and
   a zero baseline would squash a two-kilo diet into a flat line.
   ========================================================================== */

(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const BAR_MAX = 24;
  const BAR_RADIUS = 4;
  const GAP = 2;
  const DOT_R = 4;          // 8px mark, 12px with its ring — comfortably hoverable

  function svg(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) {
      const value = attrs[key];
      if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    return node;
  }

  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  function tokens(ref) {
    const cs = getComputedStyle(ref);
    const read = (name) => cs.getPropertyValue(name).trim();
    return {
      surface: read('--surface-1'),
      grid: read('--grid'),
      axis: read('--axis'),
      muted: read('--text-muted'),
      secondary: read('--text-secondary'),
      primary: read('--text-primary'),
      series: read('--series-1'),
      rule: read('--target-rule'),
    };
  }

  /* --- formatting -------------------------------------------------------- */

  const nf = (digits) => new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });

  const num = (value, digits = 0) => nf(digits).format(value);

  // Noon, so a timezone an hour either side can never move a date to the day
  // before — these are calendar days, not instants.
  const at = (iso) => new Date(iso + 'T12:00:00').getTime();

  const DAY_MONTH = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  const MONTH_YEAR = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });
  const LONG = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  const longDate = (iso) => LONG.format(new Date(at(iso)));

  /* --- scales ------------------------------------------------------------ */

  function niceStep(span, target) {
    if (!(span > 0)) return 1;
    const rough = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const nice = [1, 2, 2.5, 5, 10];
    return (nice.find((n) => rough / mag <= n + 1e-9) || 10) * mag;
  }

  /** Gridline values covering [low, high], never fewer than two. */
  function ticksBetween(low, high, target) {
    const step = niceStep(high - low, target);
    const first = Math.floor(low / step) * step;
    const ticks = [];
    for (let v = first; v <= high + step * 1e-6; v += step) ticks.push(round(v));
    return ticks.length > 1 ? ticks : [round(low), round(high)];
  }

  function ticksFromZero(max, target) {
    if (!(max > 0)) return [0, 1];
    const step = niceStep(max, target);
    const ticks = [];
    for (let v = 0; v < max - 1e-9; v += step) ticks.push(round(v));
    ticks.push(round(ticks.length ? ticks[ticks.length - 1] + step : step));
    return ticks;
  }

  const round = (v) => Math.round(v * 1e6) / 1e6;

  /** Up to `count` evenly spaced labels across a time span. */
  function timeTicks(from, to, count) {
    const span = to - from;
    const fmt = span > 400 * 864e5 ? MONTH_YEAR : DAY_MONTH;
    if (span <= 0 || count < 2) return [{ t: from, label: fmt.format(new Date(from)) }];
    const out = [];
    for (let i = 0; i < count; i++) {
      const t = from + (span * i) / (count - 1);
      out.push({ t, label: fmt.format(new Date(t)) });
    }
    return out;
  }

  /* --- marks ------------------------------------------------------------- */

  // A column: rounded at the data-end, square where it meets the baseline.
  function columnPath(x, y, w, h, radius) {
    const r = Math.max(0, Math.min(radius, w / 2, h));
    if (r < 1) return `M${x},${y}h${w}v${h}h${-w}z`;
    return `M${x},${y + r}` +
      `a${r},${r} 0 0 1 ${r},${-r}` +
      `h${w - 2 * r}` +
      `a${r},${r} 0 0 1 ${r},${r}` +
      `v${h - r}h${-w}z`;
  }

  /* --- tooltip ----------------------------------------------------------- */

  // A mouse cursor is a 1px hotspot, so a tooltip below-right of it reads
  // fine. A fingertip is ~40px across and the hand covers everything below
  // and to the right of it — exactly where that placement puts the tooltip.
  // Touch therefore gets the opposite treatment: centred and lifted clear.
  const TOUCH_GAP = 28;
  let pointerKind = 'mouse';
  const trackPointer = (e) => { pointerKind = e.pointerType || 'mouse'; };
  document.addEventListener('pointerdown', trackPointer, { passive: true, capture: true });
  document.addEventListener('pointermove', trackPointer, { passive: true, capture: true });

  const tip = {
    node: null,
    el() {
      if (!this.node) this.node = document.getElementById('tooltip');
      return this.node;
    },
    // rows: [{label, value, color, muted}] — labels are data, so textContent only.
    show(head, rows, anchor) {
      const el = this.el();
      if (!el) return;
      clear(el);

      const header = document.createElement('div');
      header.className = 'tt-head';
      header.textContent = head;
      el.appendChild(header);

      for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'tt-row' + (row.muted ? ' tt-muted' : '');
        if (row.color) {
          const key = document.createElement('span');
          key.className = row.dot ? 'key-dot' : 'key-line';
          key.style.background = row.color;
          line.appendChild(key);
        }
        const name = document.createElement('span');
        name.className = 'tt-name';
        name.textContent = row.label;
        line.appendChild(name);
        if (row.value !== undefined) {
          const value = document.createElement('span');
          value.className = 'tt-value';
          value.textContent = row.value;
          line.appendChild(value);
        }
        el.appendChild(line);
      }

      el.hidden = false;
      this.place(anchor);
    },
    place(anchor) {
      const el = this.el();
      const box = el.getBoundingClientRect();
      const pad = 10;
      const clamp = (v, limit) => Math.min(Math.max(v, pad), Math.max(pad, limit - pad));

      if (pointerKind === 'touch' || pointerKind === 'pen') {
        const x = clamp(anchor.x - box.width / 2, window.innerWidth - box.width);
        let y = anchor.y - box.height - TOUCH_GAP;
        if (y < pad) y = anchor.y + TOUCH_GAP;   // no room above; drop below the finger
        el.style.left = x + 'px';
        el.style.top = clamp(y, window.innerHeight - box.height) + 'px';
        return;
      }
      let x = anchor.x + 14;
      if (x + box.width > window.innerWidth - pad) x = anchor.x - box.width - 14;
      let y = anchor.y + 14;
      if (y + box.height > window.innerHeight - pad) y = anchor.y - box.height - 14;
      el.style.left = clamp(x, window.innerWidth - box.width) + 'px';
      el.style.top = clamp(y, window.innerHeight - box.height) + 'px';
    },
    hide() {
      const el = this.el();
      if (el) el.hidden = true;
    },
  };

  /* --- the hover layer --------------------------------------------------- */

  /**
   * A transparent rect over the plot that turns a pointer position into the
   * nearest datum. Hit targets are the whole plot height, because asking
   * someone to land on a 12px dot on a phone is asking them not to bother.
   */
  function attachHover(root, plot, onMove, onLeave) {
    const overlay = svg('rect', {
      x: plot.x, y: plot.y, width: plot.width, height: plot.height,
      fill: 'transparent', 'pointer-events': 'all',
    });
    const locate = (event) => {
      const box = root.getBoundingClientRect();
      // The SVG is laid out at its viewBox size, so client pixels map 1:1.
      onMove(event.clientX - box.left, { x: event.clientX, y: event.clientY });
    };
    overlay.addEventListener('pointermove', locate);
    overlay.addEventListener('pointerdown', locate);
    overlay.addEventListener('pointerleave', () => { tip.hide(); onLeave(); });
    root.appendChild(overlay);
  }

  function text(x, y, value, opts) {
    const node = svg('text', {
      x, y,
      fill: opts.fill,
      'font-size': opts.size,
      'font-weight': opts.weight || 400,
      'text-anchor': opts.anchor || 'start',
      'font-family': 'inherit',
    });
    node.textContent = value;
    return node;
  }

  /** A label that stays readable where a rule or a line runs under it. */
  function haloed(node, surface) {
    node.setAttribute('stroke', surface);
    node.setAttribute('stroke-width', 3);
    node.setAttribute('paint-order', 'stroke');
    return node;
  }

  /* --- weight over time -------------------------------------------------- */

  /**
   * spec: {
   *   points: [{date, weight, grams, kibble}],   oldest first
   *   target: number | null,
   *   targetLabel: string,
   * }
   */
  function drawWeight(container, spec) {
    const points = spec.points || [];
    clear(container);
    if (points.length === 0) return;

    const t = tokens(container);
    const width = Math.max(260, container.clientWidth || 320);
    const height = 260;
    const plot = { x: 46, y: 14, width: width - 46 - 14, height: height - 14 - 26 };

    // A single weighing has no time span to plot against, so it is shown as
    // the number it is rather than as a one-pixel line.
    if (points.length === 1) {
      const only = points[0];
      const root = svg('svg', {
        viewBox: `0 0 ${width} 72`, role: 'img',
        'aria-label': `Une seule pesée : ${num(only.weight, 1)} kg le ${longDate(only.date)}`,
      });
      root.appendChild(text(width / 2, 34, `${num(only.weight, 1)} kg`,
        { fill: t.primary, size: 26, weight: 600, anchor: 'middle' }));
      root.appendChild(text(width / 2, 56,
        `le ${longDate(only.date)} — une courbe à partir de la deuxième pesée`,
        { fill: t.muted, size: 12, anchor: 'middle' }));
      container.appendChild(root);
      return;
    }

    const t0 = at(points[0].date);
    const t1 = at(points[points.length - 1].date);
    const span = Math.max(t1 - t0, 1);

    // The domain covers the data and the target — a goal you cannot see on
    // the chart is not doing its job — with a little air above and below so
    // the line never runs along the frame.
    const values = points.map((p) => p.weight);
    if (spec.target != null) values.push(spec.target);
    let low = Math.min(...values);
    let high = Math.max(...values);
    const pad = Math.max((high - low) * 0.12, 0.25);
    low -= pad; high += pad;

    const yTicks = ticksBetween(low, high, Math.max(3, Math.round(plot.height / 48)));
    low = Math.min(low, yTicks[0]);
    high = Math.max(high, yTicks[yTicks.length - 1]);

    const X = (ms) => plot.x + ((ms - t0) / span) * plot.width;
    const Y = (kg) => plot.y + plot.height - ((kg - low) / (high - low)) * plot.height;

    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': spec.ariaLabel || 'Poids au fil du temps',
    });

    // Gridlines and the value axis.
    for (const value of yTicks) {
      const y = Y(value);
      root.appendChild(svg('line', {
        x1: plot.x, x2: plot.x + plot.width, y1: y, y2: y,
        stroke: t.grid, 'stroke-width': 1,
      }));
      root.appendChild(text(plot.x - 8, y + 4, num(value, 1),
        { fill: t.muted, size: 11, anchor: 'end' }));
    }

    // Time axis.
    root.appendChild(svg('line', {
      x1: plot.x, x2: plot.x + plot.width, y1: plot.y + plot.height, y2: plot.y + plot.height,
      stroke: t.axis, 'stroke-width': 1,
    }));
    for (const tick of timeTicks(t0, t1, Math.max(2, Math.min(6, Math.floor(plot.width / 90))))) {
      root.appendChild(text(X(tick.t), height - 8, tick.label,
        { fill: t.muted, size: 11, anchor: 'middle' }));
    }

    // The target rule. Dashed muted ink with its own label, so it never reads
    // as a second series.
    if (spec.target != null) {
      const y = Y(spec.target);
      root.appendChild(svg('line', {
        x1: plot.x, x2: plot.x + plot.width, y1: y, y2: y,
        stroke: t.rule, 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
      }));
      const label = spec.targetLabel || `objectif ${num(spec.target, 1)} kg`;
      root.appendChild(haloed(
        text(plot.x + plot.width, y - 7, label,
          { fill: t.secondary, size: 11, anchor: 'end' }),
        t.surface,
      ));
    }

    // The series.
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(at(p.date))},${Y(p.weight)}`).join('');
    root.appendChild(svg('path', {
      d, fill: 'none', stroke: t.series, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    // Markers, each with a 2px surface ring so overlapping weighings in a
    // busy fortnight stay countable.
    for (const p of points) {
      root.appendChild(svg('circle', {
        cx: X(at(p.date)), cy: Y(p.weight), r: DOT_R,
        fill: t.series, stroke: t.surface, 'stroke-width': 2,
      }));
    }

    // One direct label, on the latest point — the number the page is about.
    // Labelling every point would be noise; labelling none would make the
    // reader do arithmetic against the axis.
    const last = points[points.length - 1];
    const lastX = X(at(last.date));
    const nearRight = lastX > plot.x + plot.width - 40;
    root.appendChild(haloed(
      text(Math.min(lastX, plot.x + plot.width - 2), Y(last.weight) - 12,
        `${num(last.weight, 1)} kg`,
        { fill: t.primary, size: 12, weight: 600, anchor: nearRight ? 'end' : 'middle' }),
      t.surface,
    ));

    // Crosshair + nearest-point tooltip.
    const crosshair = svg('line', {
      y1: plot.y, y2: plot.y + plot.height,
      stroke: t.axis, 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden',
    });
    const focus = svg('circle', {
      r: DOT_R + 2, fill: 'none', stroke: t.series, 'stroke-width': 2, visibility: 'hidden',
    });
    root.appendChild(crosshair);
    root.appendChild(focus);

    attachHover(root, plot, (px, anchor) => {
      let best = points[0];
      let bestDistance = Infinity;
      for (const p of points) {
        const distance = Math.abs(X(at(p.date)) - px);
        if (distance < bestDistance) { bestDistance = distance; best = p; }
      }
      const x = X(at(best.date));
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.setAttribute('visibility', 'visible');
      focus.setAttribute('cx', x);
      focus.setAttribute('cy', Y(best.weight));
      focus.setAttribute('visibility', 'visible');

      const rows = [{ label: 'Poids', value: `${num(best.weight, 1)} kg`, color: t.series, dot: true }];
      if (spec.target != null) {
        const delta = best.weight - spec.target;
        rows.push({
          label: 'Écart',
          value: `${delta > 0 ? '+' : ''}${num(delta, 1)} kg`,
          muted: true,
        });
      }
      if (best.grams != null) rows.push({ label: 'Ration', value: `${num(best.grams)} g`, muted: true });
      if (best.kibble) rows.push({ label: best.kibble, muted: true });
      tip.show(longDate(best.date), rows, anchor);
    }, () => {
      crosshair.setAttribute('visibility', 'hidden');
      focus.setAttribute('visibility', 'hidden');
    });

    container.appendChild(root);
  }

  /* --- daily ration ------------------------------------------------------ */

  /**
   * spec: { points: [{date, grams, kcal, kibble}], changes: [{date, label}] }
   *
   * A day with no ration written down is simply absent. Drawing it as a bar
   * of zero would assert the dog was fed nothing, which is a different claim
   * from "nobody wrote it down".
   */
  function drawRation(container, spec) {
    clear(container);
    const points = (spec.points || []).filter((p) => p.grams != null);
    if (!points.length) return;

    const t = tokens(container);
    const width = Math.max(260, container.clientWidth || 320);
    const height = 186;
    const plot = { x: 46, y: 22, width: width - 46 - 14, height: height - 22 - 26 };

    const t0 = at(points[0].date);
    const t1 = at(points[points.length - 1].date);
    const span = Math.max(t1 - t0, 1);

    const yTicks = ticksFromZero(Math.max(...points.map((p) => p.grams)),
      Math.max(2, Math.round(plot.height / 44)));
    const top = yTicks[yTicks.length - 1];
    const Y = (g) => plot.y + plot.height - (g / top) * plot.height;

    // Bar width comes from the tightest pair of weighings on screen, so bars
    // never overlap when the schedule is irregular — two weighings a day
    // apart in a six-month span would otherwise sit on top of each other.
    let tightest = plot.width;
    for (let i = 1; i < points.length; i++) {
      tightest = Math.min(tightest, ((at(points[i].date) - at(points[i - 1].date)) / span) * plot.width);
    }
    const barWidth = Math.max(3, Math.min(BAR_MAX, (points.length === 1 ? BAR_MAX : tightest) - GAP));

    // Centres are inset by half a bar, so the first and last bars sit wholly
    // inside the plot. Without it the first bar spills left over the value
    // axis and paints across its own "200" label.
    const inset = barWidth / 2;
    const X = (ms) => plot.x + inset + ((ms - t0) / span) * (plot.width - barWidth);

    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': spec.ariaLabel || 'Ration journalière au fil du temps',
    });

    for (const value of yTicks) {
      const y = Y(value);
      root.appendChild(svg('line', {
        x1: plot.x, x2: plot.x + plot.width, y1: y, y2: y,
        stroke: value === 0 ? t.axis : t.grid, 'stroke-width': 1,
      }));
      root.appendChild(text(plot.x - 8, y + 4, num(value),
        { fill: t.muted, size: 11, anchor: 'end' }));
    }

    for (const tick of timeTicks(t0, t1, Math.max(2, Math.min(6, Math.floor(plot.width / 90))))) {
      root.appendChild(text(X(tick.t), height - 8, tick.label,
        { fill: t.muted, size: 11, anchor: 'middle' }));
    }

    const bars = [];
    for (const p of points) {
      const x = X(at(p.date)) - barWidth / 2;
      const y = Y(p.grams);
      root.appendChild(svg('path', {
        d: columnPath(x, y, barWidth, plot.y + plot.height - y, BAR_RADIUS), fill: t.series,
      }));
      bars.push({ point: p, x: X(at(p.date)) });
    }

    // Where the food changed. A hairline and a short label, because "the
    // climb started when we switched bags" is the question this chart exists
    // to answer — and the labels are dropped rather than overlapped once
    // there are too many to read.
    const changes = (spec.changes || []).filter((c) => at(c.date) > t0);
    const showLabels = changes.length <= 4 && plot.width > 420;
    for (const change of changes) {
      const x = X(at(change.date));
      root.appendChild(svg('line', {
        x1: x, x2: x, y1: plot.y - 6, y2: plot.y + plot.height,
        stroke: t.axis, 'stroke-width': 1, 'stroke-dasharray': '2 3',
      }));
      if (showLabels) {
        root.appendChild(haloed(
          text(x, plot.y - 10, change.label, {
            fill: t.secondary, size: 10.5,
            anchor: x > plot.x + plot.width * 0.7 ? 'end' : 'start',
          }),
          t.surface,
        ));
      }
    }

    const focus = svg('rect', {
      y: plot.y, height: plot.height, width: barWidth + 4,
      fill: t.series, opacity: 0.12, rx: 3, visibility: 'hidden',
    });
    root.insertBefore(focus, root.firstChild);

    attachHover(root, plot, (px, anchor) => {
      let best = bars[0];
      let bestDistance = Infinity;
      for (const bar of bars) {
        const distance = Math.abs(bar.x - px);
        if (distance < bestDistance) { bestDistance = distance; best = bar; }
      }
      focus.setAttribute('x', best.x - (barWidth + 4) / 2);
      focus.setAttribute('visibility', 'visible');

      const p = best.point;
      const rows = [{ label: 'Ration', value: `${num(p.grams)} g`, color: t.series, dot: true }];
      if (p.kcal != null) rows.push({ label: 'Apport', value: `${num(p.kcal)} kcal`, muted: true });
      if (p.kibble) rows.push({ label: p.kibble, muted: true });
      tip.show(longDate(p.date), rows, anchor);
    }, () => focus.setAttribute('visibility', 'hidden'));

    container.appendChild(root);
  }

  /* --- public API -------------------------------------------------------- */

  const observed = new WeakMap();
  let observer = null;

  function ensureObserver() {
    if (observer || typeof ResizeObserver === 'undefined') return;
    let frame = null;
    observer = new ResizeObserver((entries) => {
      const dirty = entries.map((entry) => entry.target).filter((el) => {
        const state = observed.get(el);
        if (!state) return false;
        const w = el.clientWidth;
        // Redrawing on every sub-pixel reflow is how a resize turns into a
        // frame budget problem; 8px is below what anyone can see move.
        if (Math.abs(w - state.width) < 8) return false;
        state.width = w;
        return true;
      });
      if (!dirty.length) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => dirty.forEach(redraw));
    });
  }

  const RENDERERS = { weight: drawWeight, ration: drawRation };

  function redraw(container) {
    const state = observed.get(container);
    if (!state || !state.spec) return;
    RENDERERS[state.kind](container, state.spec);
  }

  // ResizeObserver is the primary path, but it is suspended while the tab is
  // hidden — a phone rotated in the background comes back stale otherwise.
  let resizeTimer = null;
  const onViewportChange = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll('.chart').forEach(redraw);
    }, 150);
  };
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) onViewportChange();
  });

  function mount(kind, container, spec) {
    ensureObserver();
    let state = observed.get(container);
    if (!state) {
      state = { width: container.clientWidth };
      observed.set(container, state);
      if (observer) observer.observe(container);
    }
    state.kind = kind;
    state.spec = spec;
    state.width = container.clientWidth;
    RENDERERS[kind](container, spec);
  }

  global.Charts = {
    weight: (el, spec) => mount('weight', el, spec),
    ration: (el, spec) => mount('ration', el, spec),
    // The theme toggle swaps the custom properties the marks read, and SVG
    // attributes do not re-resolve a var() they were given as a literal.
    repaint: () => document.querySelectorAll('.chart').forEach(redraw),
  };
})(window);
