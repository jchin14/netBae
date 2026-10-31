'use strict';

// Fallback when the copies installed with netBae are missing. The browser refuses a file that doesn't match its hash.
const CDN = {
  chart: ['https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', 'sha384-9nhczxUqK87bcKHh20fSQcTGD4qq5GhayNYSYWqwBkINBhOfQLg/P5HG5lF1urn4'],
  adapter: ['https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js', 'sha384-cVMg8E3QFwTvGCDuK+ET4PD341jF3W8nO1auiXfuZNQkzbUUiBGLsIQUE+b1mxws'],
};
const PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16',
  '#f97316', '#14b8a6', '#a855f7', '#eab308', '#0ea5e9', '#f43f5e', '#64748b', '#22c55e'];
const RANGES = [
  ['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400],
  ['7d', 604800], ['30d', 2592000], ['90d', 7776000], ['1y', 31536000], ['day', null], ['custom', null],
];
const REFRESH_MS = 15000;
// AdGuard's servers are far away from many places, so its line would squash the others: hidden until you show it
const HIDDEN_BY_DEFAULT = (it) => /^adguard/i.test(it.cat || it.label || '');

const $ = (sel, el = document) => el.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const store = {
  get(k, d) { try { const v = localStorage.getItem('netbae:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('netbae:' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ formatting
function fmtMs(v) {
  if (v == null) return '-';
  return v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v).toString();
}
const fmtPct = (v, d = 1) => (v == null ? '-' : `${v.toFixed(d)}%`);
// packet loss / failures: orange above 0%, red above 1%
const fmtLoss = (v, d = 1) => (v == null ? '-' : `<span class="${v > 1 ? 'loss-bad' : v > 0 ? 'loss-warn' : ''}">${fmtPct(v, d)}</span>`);
const fmtMbps = (v) => (v == null ? '-' : v >= 100 ? Math.round(v).toString() : v.toFixed(1));
function fmtBytes(b) {
  if (b == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
// 5 -> "5 s", 90 -> "90 s", 3600 -> "hour", 86400 -> "day", 5400 -> "90 min", 172800 -> "2 days"
function fmtEvery(s) {
  if (s % 86400 === 0) return s === 86400 ? 'day' : `${s / 86400} days`;
  if (s % 3600 === 0) return s === 3600 ? 'hour' : `${s / 3600} h`;
  if (s % 60 === 0 && s >= 120) return `${s / 60} min`;
  return `${s} s`;
}
// How often pings and speedtests run, from the config, for the footer.
function scheduleText() {
  const p = CONFIG.ping, sp = CONFIG.speedtest;
  const parts = [`pings every ${fmtEvery(p.interval_seconds)}`
    + (p.targets.some((t) => t.method === 'region') ? ` (regions every ${fmtEvery(p.region_interval_seconds)})` : '')];
  if (!sp.enabled) parts.push('speedtests off');
  else {
    let t = `speedtest every ${fmtEvery(sp.interval_minutes * 60)}`;
    if (sp.offset_minutes) t += ` at +${sp.offset_minutes} min`;
    if (sp.global_every) t += ` (plus one to a random city ${sp.global_every === 1 ? 'after each' : `every ${sp.global_every} tests`})`;
    if (sp.regions.length) t += `, regions every ${fmtEvery(sp.regions_interval_minutes * 60)}`;
    const conns = CONFIG.connections.filter((c) => c.speedtest && c.speedtest_interval_minutes > 0);
    for (const c of conns) {
      t += `, secondary connection${conns.length > 1 ? ` ${c.name}` : ''} every ${fmtEvery(c.speedtest_interval_minutes * 60)}`;
    }
    parts.push(t);
  }
  return esc(parts.join(' · '));
}
function fmtDuration(s) {
  if (s == null) return '-';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
}
// "AU" -> 🇦🇺 (regional-indicator emoji; Windows shows the letters instead)
const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc)
  ? `<span class="flag">${String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)))}</span>` : '');
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
// "in 2 h 14 min", "in 35 min", "in 3 d 4 h"
function fmtIn(ts) {
  const m = Math.max(0, Math.round((ts - Date.now() / 1000) / 60));
  if (m < 1) return 'any moment';
  if (m < 60) return `in ${m} min`;
  if (m < 1440) return `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `in ${Math.floor(m / 1440)} d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)} h` : ''}`;
}

function fmtAgo(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const toLocalInput = (ts) => {
  const d = new Date(ts * 1000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

// ------------------------------------------------------------------ net
async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  const r = await fetch(`api/${path}${qs ? '?' + qs : ''}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
function loadScript([src, integrity]) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.integrity = integrity; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function ensureLibs() {
  if (!window.Chart) await loadScript(CDN.chart);
  let hasAdapter = false;
  try { hasAdapter = !!new window.Chart._adapters._date().formats().hour; } catch { /* no adapter */ }
  if (!hasAdapter) await loadScript(CDN.adapter);
}

// ------------------------------------------------------------------ controls
function rangeControl(el, key, defaultRange, onChange) {
  // a new install doesn't have the default range's worth of data yet: start on the smallest range that holds it all
  const age = CONFIG.data_since ? Date.now() / 1000 - CONFIG.data_since : Infinity;
  const fits = RANGES.find(([k, span]) => span && span >= age)?.[0];
  if (fits && RANGES.findIndex(([k]) => k === fits) < RANGES.findIndex(([k]) => k === defaultRange)) defaultRange = fits;
  const saved = store.get(`range:${key}`, { r: defaultRange });
  el.innerHTML = `
    <span class="live-badge"></span>
    <select class="range-select" aria-label="Time range">${RANGES.map(([k]) => `<option value="${k}">${k === 'custom' ? 'Custom…' : k === 'day' ? 'A day…' : 'Last ' + k}</option>`).join('')}</select>
    <span class="seg" role="group" aria-label="Time range">${RANGES.map(([k]) => `<button type="button" data-r="${k}"
      title="${k === 'custom' ? 'Pick a start and end' : k === 'day' ? 'One whole day' : 'The last ' + k}">${k === 'custom' ? 'Custom' : k === 'day' ? 'Day' : k}</button>`).join('')}</span>
    <span class="day" hidden>
      <button class="btn ghost prev" title="Previous day" aria-label="Previous day">◀</button>
      <input type="date" class="date" aria-label="Day">
      <button class="btn ghost next" title="Next day" aria-label="Next day">▶</button>
    </span>
    <span class="custom" hidden>
      <input type="datetime-local" class="from" aria-label="From">
      <input type="datetime-local" class="to" aria-label="To">
      <button class="btn ghost apply">Apply</button>
    </span>`;
  const sel = $('select', el), custom = $('.custom', el), from = $('.from', el), to = $('.to', el);
  const dayBox = $('.day', el), date = $('.date', el);
  $('.seg', el).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.r === sel.value) return;
    sel.value = b.dataset.r;
    sel.dispatchEvent(new Event('change'));
  });
  sel.value = saved.r;
  if (!sel.value) sel.value = defaultRange;
  const now = Date.now() / 1000;
  from.value = toLocalInput(saved.from || now - 86400);
  to.value = toLocalInput(saved.to || now);
  // a whole local day, midnight to midnight; defaults to yesterday
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  date.value = saved.day || ymd(new Date(Date.now() - 86400000));
  date.max = ymd(new Date());
  // "Live" while the chart follows the clock, otherwise which past period it shows
  const badge = $('.live-badge', el);
  el.closest('.panel-head')?.querySelector('h2')?.append(badge);  // next to the chart's title
  const show = () => {
    custom.hidden = sel.value !== 'custom'; dayBox.hidden = sel.value !== 'day';
    el.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.r === sel.value));
    const r = ctl.get();
    badge.className = `live-badge ${r?.live ? 'live' : 'past'}`;
    badge.textContent = r?.live ? '● Live' : sel.value === 'day' && date.value
      ? `Past: ${new Date(...date.value.split('-').map((x, i) => (i === 1 ? x - 1 : +x))).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`
      : 'Past data';
    badge.title = r?.live ? 'Showing live data, updated automatically' : 'Showing past data: it won\'t update until you pick a "Last ..." range';
    document.dispatchEvent(new Event('rangechange'));
  };

  const persist = () => store.set(`range:${key}`, {
    r: sel.value, from: new Date(from.value).getTime() / 1000, to: new Date(to.value).getTime() / 1000, day: date.value,
  });
  sel.addEventListener('change', () => {
    show();
    persist();
    if (sel.value !== 'custom') onChange();
  });
  $('.apply', el).addEventListener('click', () => { persist(); show(); onChange(); });
  const step = (n) => {
    const [y, mo, d] = date.value.split('-').map(Number);
    const next = ymd(new Date(y, mo - 1, d + n));
    if (next > date.max) return;
    date.value = next;
    persist(); show(); onChange();
  };
  $('.prev', el).addEventListener('click', () => step(-1));
  $('.next', el).addEventListener('click', () => step(1));
  date.addEventListener('change', () => { if (date.value) { persist(); show(); onChange(); } });

  const ctl = {
    reset() { sel.value = defaultRange; persist(); show(); onChange(); },
    get() {
      if (sel.value === 'custom') {
        const f = new Date(from.value).getTime() / 1000, t = new Date(to.value).getTime() / 1000;
        if (!(f < t)) return null;
        return { from: f, to: t, live: false };
      }
      if (sel.value === 'day') {
        if (!date.value) return null;
        const [y, mo, d] = date.value.split('-').map(Number);
        const f = new Date(y, mo - 1, d).getTime() / 1000, t = new Date(y, mo - 1, d + 1).getTime() / 1000;
        return { from: f, to: Math.min(t, Date.now() / 1000), live: t > Date.now() / 1000 };  // today keeps updating
      }
      const span = RANGES.find(([k]) => k === sel.value)[1];
      const t = Date.now() / 1000;
      return { from: t - span, to: t, live: true };
    },
  };
  show();
  return ctl;
}

// Toggle chips, grouped by item.group with a clickable group label that toggles the whole group.
// Which lines a chart shows. Stored per browser; "v2" started over when charts began showing only a few lines
// by default (drawing every host on page load was heavy on the CPU).
// rows: { isOpen(group), toggle(group) } puts each group on its own row, with its hosts hidden until the ▸ opens it
// hover(spec, pin): with a mouse, hovering a chip ("id:<item>") or a category row ("cat:<group>") picks out its
// lines in the chart; tapping or clicking the empty part of a row pins that (pin = true), for phones with no hover.
// It returns what's pinned now.
function chipFilter(el, key, items, onChange, defaultOff = [], rows = null, hover = null) {
  const off = new Set(store.get(`off3:${key}`, null) ?? defaultOff);
  let allBtn = null;
  const sync = () => {
    if (rows) {
      el.querySelectorAll('.chip-row').forEach((r) => {
        const open = rows.isOpen(r.dataset.group);
        r.classList.toggle('open', open);  // the caret's chevron turns with it (CSS)
        $('.caret', r).setAttribute('aria-expanded', String(open));
      });
    }
    el.querySelectorAll('.chip').forEach((c) => c.classList.toggle('off', off.has(c.dataset.id)));
    el.querySelectorAll('.group-label').forEach((b) => b.classList.toggle('off',
      items.filter((x) => x.group === b.dataset.group).every((x) => off.has(x.id))));
    if (allBtn) allBtn.textContent = items.every((x) => off.has(x.id)) ? 'Show all' : 'Hide all';
  };
  const changed = () => { sync(); store.set(`off3:${key}`, [...off]); onChange(); };
  el.innerHTML = '';
  el.classList.toggle('chip-rows', !!rows);
  const groups = [...new Set(items.map((it) => it.group ?? ''))];
  for (const g of groups) {
    const wrap = document.createElement(rows ? 'div' : 'span');
    wrap.className = rows ? 'chip-row' : 'chip-group';
    wrap.dataset.group = g;
    const members = items.filter((it) => (it.group ?? '') === g);
    if (rows) {
      const caret = document.createElement('button');
      caret.className = 'caret';
      caret.setAttribute('aria-label', `Show ${g}'s hosts`);
      caret.title = `Show or hide each of ${g}'s ${members.length} hosts (also opens it in the table)`;
      caret.addEventListener('click', () => rows.toggle(g));
      wrap.appendChild(caret);
    }
    if (g && (groups.length > 1 || rows)) {
      const label = document.createElement('button');
      label.className = 'group-label';
      label.dataset.group = g;
      // in rows, the category's swatch is its middle host's colour, the same one its combined line is drawn in
      const sq = rows ? `<i class="host-sq" style="background:${members[Math.floor((members.length - 1) / 2)].color}"></i> ` : '';
      label.innerHTML = `${sq}${esc(g)}${rows ? ` <span class="count">${members.length}</span>` : ''}`;
      label.title = `Show or hide all of ${g}`;
      label.addEventListener('click', () => {
        const allOff = members.every((x) => off.has(x.id));
        members.forEach((x) => (allOff ? off.delete(x.id) : off.add(x.id)));
        changed();
      });
      wrap.appendChild(label);
    }
    for (const it of members) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.id = it.id;
      chip.innerHTML = `<i style="background:${it.color}"></i>${flag(it.flag)}${esc(it.label)}`;
      chip.title = it.title || it.label;
      chip.addEventListener('click', (e) => {
        if (e.altKey || e.metaKey || e.ctrlKey || e.detail === 2) {
          // double-click / modifier: solo this item
          items.forEach((x) => (x.id === it.id ? off.delete(x.id) : off.add(x.id)));
        } else if (off.has(it.id)) off.delete(it.id);
        else off.add(it.id);
        changed();
      });
      wrap.appendChild(chip);
    }
    if (rows && hover) {  // the rest of the row, to the right of the name and hosts
      const fill = document.createElement('span');
      fill.className = 'row-fill';
      fill.title = `Pick out ${g} on the chart (click again to stop)`;
      wrap.appendChild(fill);
    }
    el.appendChild(wrap);
  }
  if (hover) {
    const specAt = (t) => {
      const chip = t.closest('.chip');
      if (chip) return `id:${chip.dataset.id}`;
      const row = t.closest('.chip-row');
      return row ? `cat:${row.dataset.group}` : null;
    };
    // mouse only: a tap on a phone also sends pointerover, which would leave the other lines faded
    el.addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse') hover(specAt(e.target)); });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hover(null); });
    el.addEventListener('click', (e) => {
      const row = e.target.closest('.chip-row');
      if (!row || e.target.closest('button, .chip')) return;
      const pinned = hover(`cat:${row.dataset.group}`, true);
      el.querySelectorAll('.chip-row').forEach((r) => r.classList.toggle('pinned', pinned === `cat:${r.dataset.group}`));
    });
  }
  sync();
  return {
    selected: () => items.filter((i) => !off.has(i.id)).map((i) => i.id),
    showAll() { off.clear(); sync(); store.set(`off3:${key}`, []); },  // the caller refreshes
    // a panel button that hides every line, or shows them all again once they're all hidden
    addToggleAll(root) {
      allBtn = panelButton(root, '', 'Show or hide every line on the chart', () => {
        const allOff = items.every((x) => off.has(x.id));
        items.forEach((x) => (allOff ? off.delete(x.id) : off.add(x.id)));
        changed();
      });
      sync();
    },
    sync,
  };
}

// Colours: each group gets a hue, members get lighter/darker shades of it.
const GROUP_HUES = [217, 152, 28, 275, 345, 188, 48, 105, 0, 245, 305, 70];
function hslHex(h, sat, l) {
  sat /= 100; l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function groupColors(targets) {
  const groups = [...new Set(targets.map((t) => t.group))];
  const colors = {};
  groups.forEach((g, gi) => {
    const members = targets.filter((t) => t.group === g);
    const n = members.length;
    members.forEach((t, j) => {
      // spread members across lightness and a small hue range so they stay distinguishable
      const pos = n === 1 ? 0 : j / (n - 1) - 0.5;          // -0.5 .. 0.5
      const spread = Math.min(1, (n - 1) / 3);
      const hue = (GROUP_HUES[gi % GROUP_HUES.length] + pos * 46 * spread + 360) % 360;
      colors[t.id] = hslHex(hue, 78, 57 - pos * 26 * spread);
    });
  });
  return colors;
}

// ------------------------------------------------------------------ charts
function themeChartDefaults() {
  Chart.Interaction.modes.nearLines = nearLines;
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--grid');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.scale.ticks.font = { family: css('--mono'), size: 10.5 };
}

// Tooltip mode: only the line(s) right under the pointer, nearest first, instead of every series.
function nearLines(chart, e) {
  const found = [];
  chart.data.datasets.forEach((ds, di) => {
    const meta = chart.getDatasetMeta(di);
    if (ds.role === 'band' || meta.hidden || !meta.data.length) return;
    const pts = meta.data;
    let lo = 0, hi = pts.length - 1;  // points are in time order: binary search for the nearest x
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].x < e.x) lo = mid; else hi = mid; }
    const el = Math.abs(pts[lo].x - e.x) <= Math.abs(pts[hi].x - e.x) ? pts[lo] : pts[hi];
    const idx = el === pts[lo] ? lo : hi;
    if (el.skip || el.y == null || isNaN(el.y)) return;
    const dx = Math.abs(el.x - e.x), dy = Math.abs(el.y - e.y);
    if (dx < 40 && dy < 28) found.push({ element: el, datasetIndex: di, index: idx, d: dy + dx / 4 });
  });
  found.sort((a, b) => a.d - b.d);
  // the nearest line, plus any others practically on top of it
  return found.filter((f) => f.d <= found[0].d + 12).slice(0, 5).map(({ d, ...it }) => it);
}

// A dashed vertical line wherever the main connection moved to another ISP, labelled on the chart
const ispChangeLines = {
  id: 'ispChanges',
  afterDatasetsDraw(chart) {
    const changes = CONFIG.isp_changes || [];
    const { ctx, chartArea: a, scales: { x } } = chart;
    if (!changes.length || !x) return;
    const color = css('--warn');
    ctx.save();
    ctx.font = `11px ${Chart.defaults.font.family}`;
    ctx.textBaseline = 'bottom';
    const placed = [];  // labels already drawn, so close changes stack instead of hiding each other
    for (const c of [...changes].sort((p, q) => p.ts - q.ts)) {
      const px = x.getPixelForValue(c.ts * 1000);
      if (!(px >= a.left && px <= a.right)) continue;
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      const label = `${c.from} → ${c.isp}`;
      const w = ctx.measureText(label).width;
      const lx = px + 6 + w > a.right ? px - 6 - w : px + 6;  // flip to the left near the right edge
      let row = 0;
      while (placed.some((r) => r.row === row && lx < r.x2 + 4 && lx + w > r.x1 - 4)) row++;
      placed.push({ row, x1: lx, x2: lx + w });
      const by = a.bottom - 4 - row * 17;
      ctx.fillStyle = css('--card'); ctx.fillRect(lx - 3, by - 14, w + 6, 15);
      ctx.fillStyle = color; ctx.fillText(label, lx, by);
    }
    ctx.restore();
  },
};

function lineChart(canvas, { yTitle, y1Title, yMax, plugins = [] } = {}) {
  const scales = {
    x: { type: 'time', ticks: { maxRotation: 0, autoSkipPadding: 18 }, grid: { display: false }, border: { color: css('--border') } },
    y: { beginAtZero: true, max: yMax, title: { display: !!yTitle, text: yTitle }, grid: { color: css('--grid') }, border: { display: false } },
  };
  if (y1Title) scales.y1 = { position: 'right', beginAtZero: true, title: { display: true, text: y1Title }, grid: { drawOnChartArea: false } };
  scales.yIsp = { display: false, min: 0, max: 1 }; // ISP markers ride along the top of the chart
  return new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
    plugins,
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
      interaction: { mode: 'nearLines', intersect: false },
      elements: { point: { radius: 0, hoverRadius: 4, hitRadius: 6 }, line: { borderWidth: 1.75, tension: 0.15 } },
      scales,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.role === 'isp') return ispLabel(ctx);
              const unit = ctx.dataset.unit || '';
              const y = ctx.parsed.y;
              return ` ${ctx.dataset.label}: ${y == null ? '-' : (unit === 'ms' ? fmtMs(y) : y.toFixed(unit === 'Mbps' ? 1 : 2))} ${unit}`;
            },
          },
        },
      },
    },
  });
}

// The x-axis always spans exactly the chosen range, even when the data only fills part of it.
function setXRange(chart, r) {
  chart.options.scales.x.min = r.from * 1000;
  chart.options.scales.x.max = r.to * 1000;
}

// ------------------------------------------------------------------ app state
let CONFIG;
let PING_COLORS = {};
const panels = [];
let lastOk = 0;

function setStatus(ok, msg) {
  const dot = $('#live-dot');
  dot.className = 'dot ' + (ok ? 'good' : 'bad');
  $('#updated').textContent = msg;
}

// ------------------------------------------------------------------ summary tiles
function tileStatus(p) {
  const loss = p.loss5m ?? 0;
  if (p.last == null && p.last_ts == null) return '';
  if (loss >= 10 || (p.last == null && loss >= 5)) return 'bad';
  // a single lost ping is a warning; far-away regions are slow by nature, so only sites get the latency check
  if (p.last == null || loss > 0 || (p.method !== 'region' && p.last > 150)) return 'warn';
  return 'good';
}

// Why a dot is the colour it is (shown when hovering it)
function tileWhy(p) {
  const loss = p.loss5m ?? 0;
  if (p.last == null && p.last_ts == null) return 'No measurements yet';
  const reasons = [];
  if (p.last == null) reasons.push('the latest ping timed out');
  if (loss > 0) reasons.push(`${fmtPct(loss)} packet loss in the last 5 minutes`);
  if (p.method !== 'region' && p.last > 150) reasons.push(`latency ${fmtMs(p.last)} ms (over 150 ms)`);
  const st = tileStatus(p);
  if (st === 'good') return `OK: every ping answered in the last 5 minutes, latency ${fmtMs(p.last)} ms`;
  return `${st === 'bad' ? 'Problem' : 'Warning'}: ${reasons.join(', ')}`
    + (st === 'bad' ? '' : '. Red at 10% loss, or 5% loss with the latest ping lost');
}

// group: red if most members are bad, amber if any member has a problem
function groupWhy(members) {
  const st = members.map((p) => [p, tileStatus(p)]).filter(([, x]) => x === 'bad' || x === 'warn');
  if (!st.length) return 'OK: every host in this group is fine';
  return `${st.length} of ${members.length} hosts need attention: `
    + st.map(([p, x]) => `${p.name} (${x === 'bad' ? 'problem' : 'warning'})`).join(', ');
}

function groupStatus(members) {
  const st = members.map(tileStatus).filter(Boolean);
  if (!st.length) return '';
  if (st.filter((x) => x === 'bad').length > st.length / 2) return 'bad';
  return st.some((x) => x !== 'good') ? 'warn' : 'good';
}

const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
let lastPing = [];
let ROUTES = {};
let CDN_ROUTES = {};  // routes to the CDN addresses the DNS servers hand out (from /api/cdn)
let ISP_NOW = [];  // each connection's current ISP (from /api/summary)

// How traffic reaches a target, from the latest traceroute: on-net / peering / transit via X.
// on-net = inside your ISP; direct = your ISP connects straight to the destination's network;
// IX = handed over across an internet exchange; transit = another carrier in between.
const ROUTE_BADGE = { 'on-net': 'on-net', direct: 'direct', ix: 'IX', transit: 'transit', unknown: 'route ?',
  peering: 'direct', 'peering (IXP)': 'IX' };  // (older names)
const ROUTE_CLASS = { peering: 'direct', 'peering (IXP)': 'ix' };
// Business relationship of each network to the one before it (CAIDA): who pays whom at each hand-over.
const REL_TEXT = { peer: 'peering', provider: 'paid transit', customer: 'to customer' };
function relTitle(rel, a, b) {
  return rel === 'peer' ? `${a} and ${b} peer: they swap traffic between their own networks and customers`
    : rel === 'provider' ? `${a} pays ${b} for transit (a route to the rest of the internet)`
      : rel === 'customer' ? `${b} is a customer of ${a} (it pays ${a} for transit)` : '';
}
// the first hand-over out of your ISP, e.g. "peering" or "paid transit"
function firstRel(path) {
  const next = path.slice(1).find((p) => !p.ixp && p.asn);
  return next?.rel ? REL_TEXT[next.rel] : null;
}
// Shorter names for the route text on tiles and in tables (the route details keep the full names)
const SHORT_NET = { 'Global Secure Layer': 'GSL' };
const shortNet = (n) => SHORT_NET[n] || n;

// True when the destination network is the target itself (Netflix for www.netflix.com, Amazon for aws.amazon.com),
// so the route text doesn't repeat what the tile already says.
function isTargetNet(net, id) {
  const t = CONFIG.ping.targets.find((x) => x.id === id);
  const word = (net || '').toLowerCase().match(/[a-z0-9]+/)?.[0];
  return !!(t && word && word.length > 2 && `${t.name} ${t.host}`.toLowerCase().includes(word));
}

function routeHtml(id) {
  const r = ROUTES[id];
  if (!r) return '<span class="muted">route not traced yet</span>';
  const { names, rel, html } = routeParts(r, id);
  return `<button class="route-link" data-route="${esc(id)}" title="${esc(names.join(' → '))}${rel ? ` · ${rel}` : ''}${r.cities?.length ? ` · through ${esc(r.cities.join(' → '))}` : ''} · traced ${fmtAgo(r.ts)} · click for hops">${html}</button>`;
}

// a route's badge and words ("transit via Telstra Global to Akamai"), for a route object
function routeParts(r, id) {
  const names = r.path.map((p) => shortNet(p.name));
  const mid = r.path.slice(1, -1).filter((p) => !p.ixp).map((p) => shortNet(p.name));
  const ixs = r.path.filter((p) => p.ixp).map((p) => p.name);
  const dest = names[names.length - 1];
  const kind = ROUTE_CLASS[r.kind] || r.kind;
  // the last city on the route is where the destination answered from: "direct to Cloudflare Melbourne"
  const city = r.cities?.length > 1 || (r.cities?.length && kind !== 'on-net') ? r.cities[r.cities.length - 1].replace(/, [A-Z]{2}$/, '') : '';
  const toDest = isTargetNet(dest, id) && !city ? '' : ` to ${dest}${city ? ` ${city}` : ''}`;
  const text = kind === 'transit' ? `via ${mid.join(', ')}${ixs.length ? ` (${ixs[0]})` : ''}${toDest}`
    : kind === 'on-net' ? `inside ${names[0] || 'your ISP'}${city ? `, to ${city}` : ''}`
      : kind === 'ix' ? `via ${ixs[0] || 'an exchange'}${mid.length ? `, then ${mid.join(', ')}${toDest ? ',' : ''}` : ''}${toDest}`
        : kind === 'direct' ? toDest.trim() : names.join(' → ');
  const rel = kind === 'on-net' ? null : firstRel(r.path);
  return { names, rel, html: `<span class="route-badge route-${kind}">${ROUTE_BADGE[r.kind] || r.kind}</span> ${esc(text)}${rel ? ` <span class="muted">· ${rel}</span>` : ''}` };
}

// "ISP (AS1) → paid transit → Cogent (AS174) → peering → Netflix (AS2906)", exchanges in between
function pathHtml(path) {
  let prev = null;
  return path.map((p, i) => {
    const name = esc(p.asn ? `${p.name} (AS${p.asn})` : `${p.name} [internet exchange]`);
    let arrow = i ? ' → ' : '';
    if (!p.ixp && p.asn) {
      if (p.rel && prev) arrow = ` <span class="rel" title="${esc(relTitle(p.rel, prev.name, p.name))}">→ ${REL_TEXT[p.rel]} →</span> `;
      prev = p;
    }
    return arrow + name;
  }).join('');
}

// an address inside a home, ISP or carrier network (RFC 1918, CGNAT, link-local, ULA), not on the internet
const isPrivateIp = (ip) => /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|f[cd]|fe[89ab])/i.test(ip);
// a public hop with no announced network (common for ISP backbone addresses): name it from its hostname
const hopNetwork = (h) => {
  if (!h.ip || isPrivateIp(h.ip)) return '<span class="muted">private</span>';
  const dom = (h.host || '').toLowerCase().match(/([a-z0-9-]+\.(?:(?:com|net|org|edu|gov|asn)\.[a-z]{2}|[a-z]{2,}))$/);
  return dom ? `${esc(dom[1])} <span class="muted">no ASN</span>` : '<span class="muted">unknown network</span>';
};

async function showRoute(id, title) {
  const d = await api('traceroute', { target: id });
  const r = d.latest;
  const dlg = $('#route-dialog');
  const hops = (r?.hops || []).map((h) => `<tr><td>${h.hop}</td><td style="text-align:left">${h.ip
      ? `${h.host ? `<div class="hop-host">${esc(h.host)}</div>` : ''}<div class="muted">${esc(h.ip)}</div>` : '<span class="muted">* no reply</span>'}</td>
    <td>${h.rtt == null ? '-' : fmtMs(h.rtt)}</td><td style="text-align:left">${h.ix ? `<span class="route-badge route-ix">IX</span> ${esc(h.ix)}` : h.asn ? `${esc(h.name)} <span class="muted">AS${h.asn}</span>` : hopNetwork(h)}</td>
    <td style="text-align:left">${h.city ? (h.city_src === 'geo' ? `<span title="approximate, from IP geolocation">~${esc(h.city)}</span>` : esc(h.city)) : ''}</td></tr>`).join('');
  const cities = [];
  for (const h of r?.hops || []) if (h.city && cities[cities.length - 1] !== h.city) cities.push(h.city);
  // one entry per route change: since when, and when it was last seen if that's a different time
  const seen = (x) => (x.first_ts && x.ts - x.first_ts > 60 ? `${fmtTime(x.first_ts)} to ${fmtTime(x.ts)}` : fmtTime(x.ts));
  const hist = d.history.slice(0, 10).map((x) => `<li>${seen(x)}: ${x.error ? `<span class="error-text">${esc(x.error)}</span>`
    : `<b>${esc(ROUTE_BADGE[x.kind] || x.kind)}</b> ${esc(x.path.map((p) => p.name).join(' → '))}`}</li>`).join('');
  dlg.innerHTML = `<div class="dlg-head"><h2>Route to ${esc(title)}</h2><button class="link" data-close>Close</button></div>
    ${r ? `<p><span class="route-badge route-${ROUTE_CLASS[r.kind] || r.kind}">${esc(ROUTE_BADGE[r.kind] || r.kind || '?')}</span>
      ${pathHtml(r.path)}</p>
      ${cities.length ? `<p class="small">Through ${esc(cities.join(' → '))}</p>` : ''}
      <p class="muted small">Destination ${esc(r.dest_host && r.dest_host !== r.dest ? `${r.dest_host} (${r.dest})` : (r.dest || ''))} · traced ${fmtAgo(r.ts)} · networks from Team Cymru's IP-to-ASN data, hostnames from reverse DNS, locations from router names (~ = IP geolocation, approximate)${d.rel_source ? `, who pays whom from CAIDA's AS relationships (${esc(d.rel_source)})` : ''}</p>
      <div class="table-wrap"><table class="stats"><thead><tr><th>#</th><th style="text-align:left">Hop (hostname / IP)</th><th>ms</th><th style="text-align:left">Network</th><th style="text-align:left">Location</th></tr></thead><tbody>${hops}</tbody></table></div>
      <h3 class="small">Route changes</h3><ul class="route-hist">${hist}</ul>
      <p class="muted small">Locations are a best estimate, from router names or approximate IP geolocation. Spotted an issue?
        <a href="${esc(CONFIG.repo || 'https://github.com/jchin14/netBae')}/issues/new" target="_blank" rel="noopener">Open a GitHub issue.</a></p>` : '<p class="muted">Not traced yet. Routes are traced every 12 hours, and right after netBae starts for any target without one.</p>'}`;
  dlg.showModal();
}

// One line for a target's IPv6 twin: its own latency, loss and route.
function v6Line(v) {
  const now = v.last == null && v.last_ts ? ' · <span style="color:var(--bad)">timeout</span>' : '';
  return `<div class="v6" title="IPv6: ${esc(v.host)} · now ${fmtMs(v.last)} ms"><span class="dot ${tileStatus(v)}" title="${esc(tileWhy(v))}"></span><b>IPv6</b> avg ${fmtMs(v.avg5m)} · loss ${fmtLoss(v.loss5m)}${now}</div>
    ${ROUTES[v.id] ? `<div class="route">${routeHtml(v.id)}</div>` : ''}`;
}

function memberTile(p, color, v6) {
  const how = p.method === 'region' ? 'TCP to the fastest Ookla server' : p.method.toUpperCase();
  return `
    <div class="tile member" data-tile-route="${esc(p.id)}" title="${esc(p.host || 'looking up server…')} · ${how} · click for the route">
      <div class="name"><span class="dot ${tileStatus(p)}" title="${esc(tileWhy(p))}"></span><span>${flag(p.flag)}${esc(p.name)}</span><i class="swatch" style="background:${color}"></i></div>
      ${p.where ? `<div class="where">${esc(p.where)}</div>` : ''}
      <div class="value">${p.last == null ? (p.last_ts ? '<span style="color:var(--bad)">timeout</span>' : '-') : fmtMs(p.last) + '<small>ms</small>'}</div>
      <div class="host">${v6 ? '<b>IPv4</b> ' : ''}avg ${fmtMs(p.avg5m)} · loss ${fmtLoss(p.loss5m)}</div>
      <div class="route">${routeHtml(p.id)}</div>
      ${v6 ? v6Line(v6) : ''}
    </div>`;
}

// One card per group showing the group's average; click to expand into per-host tiles.
function renderTiles() {
  const open = new Set(store.get('tiles:open', []));
  const groups = [...new Set(lastPing.map((p) => p.group))];
  // IPv6 twins are shown inside their IPv4 tile; group numbers stay IPv4 so they compare over time
  const v6 = Object.fromEntries(lastPing.filter((p) => p.family === 6).map((p) => [p.twin, p]));
  $('#ping-tiles').innerHTML = groups.map((g) => {
    const members = lastPing.filter((p) => p.group === g && p.family !== 6);
    const status = groupStatus(members);
    const avg = mean(members.map((p) => p.avg5m)); // members' 5-minute averages (spikes trimmed)
    const now = mean(members.map((p) => p.last));
    const down = members.filter((p) => p.last == null && p.last_ts != null).length;
    const isOpen = open.has(g);
    return `
      <div class="card tile group${isOpen ? ' open' : ''}" data-group="${esc(g)}">
        <button class="group-head" aria-expanded="${isOpen}">
          <span class="dot ${status}" title="${esc(groupWhy(members))}"></span><span class="gname">${esc(g)}</span>
          <span class="count">${members.length}</span><span class="chev">▾</span>
        </button>
        <div class="value">${avg == null ? '-' : fmtMs(avg) + '<small>ms avg</small>'}</div>
        <div class="host">now ${fmtMs(now)} · loss ${fmtLoss(mean(members.map((p) => p.loss5m)))}${down ? ` · <span style="color:var(--bad)">${down} down</span>` : ''}</div>
        ${isOpen ? `<div class="members">${members.map((p) => memberTile(p, PING_COLORS[p.id], v6[p.id])).join('')}</div>` : ''}
      </div>`;
  }).join('');
  const t = $('#tiles-toggle');
  if (t) t.textContent = groups.every((g) => open.has(g)) ? 'Collapse all' : 'Expand all';
}

// The bar at the top: hosts up and the main connection's averages, from the same 5-minute numbers as the tiles.
// Regions (far away by design), IPv6 twins and secondary connections are left out so it compares over time.
function renderSummaryBar(s) {
  const sites = lastPing.filter((p) => p.method !== 'region' && p.family !== 6 && !p.connection && p.last_ts != null);
  const mine = sites.filter((p) => p.custom);
  const up = (xs) => xs.filter((p) => p.last != null).length;
  const upCls = (xs) => (up(xs) === xs.length ? 'good' : up(xs) < xs.length * 0.9 ? 'bad' : 'warn');
  const isp = (s.isp || [])[0];
  const dns = mean(Object.values(s.dns || {}).map((d) => d.avg5m));
  const st = s.speedtest && s.speedtest.last_ok;
  const stat = (label, value, title, cls = '') => `<div class="stat" title="${esc(title)}"><div class="label">${label}</div><div class="v ${cls}">${value}</div></div>`;
  const sys = s.system || {};
  const pctCls = (v) => (v >= 90 ? 'bad' : v >= 75 ? 'warn' : '');
  const logo = isp && isp.logo && isp.last_ok
    ? `<div class="stat isp-stat" title="${esc(isp.connection)}: ${esc(isp.last_ok.isp)}"><img src="api/isp/logo?isp=${encodeURIComponent(isp.last_ok.isp)}" alt="${esc(isp.last_ok.isp)}" onerror="this.parentNode.remove()"></div>` : '';
  // your connection's own latency: the Nearest region (the closest Ookla servers), else the closest region city
  const regions = lastPing.filter((p) => p.method === 'region' && p.family !== 6 && !p.connection && p.avg5m != null);
  const nearest = regions.find((p) => p.name === 'Nearest');
  const near = nearest || regions.sort((x, y) => x.avg5m - y.avg5m)[0];
  const items = [
    logo,
    stat('Hosts up', `${up(sites)}<small>/ ${sites.length}</small>`, 'Sites whose latest ping answered (not counting regions or IPv6)', upCls(sites)),
    mine.length ? stat('Your hosts up', `${up(mine)}<small>/ ${mine.length}</small>`, 'Your own extra_targets whose latest ping answered', upCls(mine)) : '',
    isp && isp.uptime24h != null ? stat('ISP uptime', `${fmtPct(isp.uptime24h, isp.uptime24h < 100 ? 2 : 0)}<small>24h</small>`, `Share of ${isp.connection}'s ISP checks in the last 24 hours that reached the internet`, isp.uptime24h >= 99.9 ? 'good' : isp.uptime24h >= 99 ? 'warn' : 'bad') : '',
    nearest ? stat('Internet latency', `${fmtMs(nearest.avg5m)}<small>ms</small>`, '5-minute average to the Ookla speedtest server closest to you: the base latency of your connection')
      : near ? stat('Nearest city', `${fmtMs(near.avg5m)}<small>ms ${esc(near.name)}</small>`, `5-minute average to ${near.name}, the closest of the region cities (the fastest Ookla server there)`) : '',
    stat('Avg latency', `${fmtMs(mean(sites.map((p) => p.avg5m)))}<small>ms</small>`, 'Average of every site\'s 5-minute average, not counting regions'),
    stat('Jitter', `${fmtMs(mean(sites.map((p) => p.jitter5m)))}<small>ms</small>`, 'Average change between consecutive pings to each site, last 5 minutes'),
    stat('Packet loss', fmtLoss(mean(sites.map((p) => p.loss5m)), 2), 'Average packet loss across sites in the last 5 minutes'),
    dns != null ? stat('DNS', `${fmtMs(dns)}<small>ms</small>`, 'Average DNS lookup time in the last 5 minutes') : '',
    st ? stat('Speed', `${fmtMbps(st.download_mbps)}<small style="color:${PALETTE[0]}">↓</small> ${fmtMbps(st.upload_mbps)}<small><span style="color:${PALETTE[2]}">↑</span> Mbps</small>`, `Latest speedtest, ${fmtAgo(st.ts)}`) : '',
    // this machine's own stats, set apart from the connection ones
    sys.cpu != null || sys.mem != null ? '<div class="stat-sep" aria-hidden="true"></div>' : '',
    sys.cpu != null ? stat('CPU', `${Math.round(sys.cpu)}<small>% 24h</small>`, 'Average CPU use on this machine over the last 24 hours (the System tile below shows it live)', pctCls(sys.cpu)) : '',
    sys.mem != null ? stat('Memory', `${Math.round(sys.mem)}<small>% 24h</small>`, 'Average memory use on this machine over the last 24 hours (the System tile below shows it live)', pctCls(sys.mem)) : '',
  ].filter(Boolean);
  const bar = $('#summary-bar');
  bar.innerHTML = statusHtml(s, sites, up(sites), bar) + items.join('') + '<button id="tiles-toggle" class="btn ghost" type="button" title="Open or close every ping group below"></button>';
  bar.hidden = !sites.length;
}

// The bar's first item: how the connection is doing in a few words, the worst of the main connection's internet
// check, hosts not answering and packet loss. The bar's left edge takes its colour.
function statusHtml(s, sites, upCount, bar) {
  const main = (s.isp || [])[0];
  const offline = main && main.latest && main.latest.error && !/HTTP \d{3}/.test(main.latest.error);
  const down = sites.length - upCount;
  const loss = mean(sites.map((p) => p.loss5m)) || 0;
  const [cls, state] = offline || upCount === 0 ? ['bad', 'No internet']
    : down > sites.length * 0.1 || loss >= 5 ? ['bad', down ? `${down} hosts down` : 'Heavy packet loss']
      : down || loss >= 1 ? ['warn', down ? `${down} host${down > 1 ? 's' : ''} down` : 'Some packet loss']
        : ['good', 'Healthy'];
  bar.classList.remove('good', 'warn', 'bad');
  bar.classList.add(cls);
  return `<div class="stat status-stat" title="From the last 5 minutes of pings${main ? ` and ${esc(main.connection)}'s ISP check` : ''}">
    <div class="label">Status</div><div class="state"><span class="dot"></span>${esc(state)}</div></div>`;
}

async function refreshSummary() {
  const s = await api('summary');
  ISP_NOW = s.isp || [];
  lastPing = s.ping;
  if (s.isp_changes) CONFIG.isp_changes = s.isp_changes;  // a failover gets its chart line without a reload
  ROUTES = { ...(s.routes || {}), ...CDN_ROUTES };
  renderSummaryBar(s);
  $('#isp-now').innerHTML = (s.isp || []).map((c) => {
    const x = c.last_ok;
    const failing = c.latest && c.latest.error;
    const logo = c.logo ? `<img class="isp-logo" src="api/isp/logo?isp=${encodeURIComponent(x.isp)}" alt="" onerror="this.remove()">` : '';
    return x ? `<span title="${esc(x.asn || '')} · checked ${fmtAgo(x.ts)}${failing ? ' · latest check failed' : ''}">${esc(c.connection)}: ${logo}<b>${esc(x.isp || '?')}</b> ${esc(x.ip || '')}</span>`
      // "no internet" only when the check couldn't connect; a lookup service refusing (e.g. HTTP 429) isn't an outage
      : failing ? `<span title="${esc(c.latest.error)}">${esc(c.connection)}: <span class="error-text">${/HTTP \d{3}/.test(c.latest.error) ? 'ISP lookup failed' : 'no internet'}</span></span>` : '';
  }).filter(Boolean).join(' · ');
  renderTiles();

  const st = s.speedtest;
  const ok = st.last_ok;
  if (ok) {
    const avg = st.averages || {};
    const col = (label, key, unit, fmt) => `
      <div>
        <div class="label">${label}</div>
        <div class="big">${fmt(ok[key])}<small>${unit}</small></div>
        <div class="avgs">${['24h', '7d'].map((p) => `<div><span>${p} avg</span> <b>${fmt(avg[p]?.[key])}</b></div>`).join('')}</div>
      </div>`;
    $('#speed-summary').innerHTML = col('Download', 'download_mbps', 'Mbps', fmtMbps)
      + col('Upload', 'upload_mbps', 'Mbps', fmtMbps) + col('Ping', 'ping_ms', 'ms', fmtMs);
    const a7 = avg['7d'] || {};
    $('#speed-details').innerHTML = [
      ['ISP', esc(ok.isp || '-')],
      ['Jitter', `${fmtMs(ok.jitter_ms)} ms`, `7d avg ${fmtMs(a7.jitter_ms)}`],
      ['Packet loss', ok.packet_loss == null ? '-' : fmtPct(ok.packet_loss), `7d avg ${a7.packet_loss == null ? '-' : fmtPct(a7.packet_loss)}`],
      ['Data used', fmtBytes(ok.data_bytes), `24h ${fmtBytes(avg['24h']?.data_bytes)} · 7d ${fmtBytes(a7.data_bytes)}`],
    ].map(([l, v, sub]) => `<div><div class="label">${l}</div><div class="val">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`).join('');
  }
  const tests = st.averages?.['7d']?.tests;
  let meta = ok ? `Latest: ${esc(ok.server_name || '')}${ok.server_location ? ', ' + esc(ok.server_location) : ''} · ${fmtAgo(ok.ts)}${tests ? ` · ${tests} tests in 7d` : ''}` : '';
  if (st.latest && st.latest.error) meta += `<div class="error-text">Last run failed (${fmtAgo(st.latest.ts)}): ${esc(st.latest.error)}</div>`;
  const hm = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  // the config's next run is from when the page loaded: step it forward past runs that have happened since
  const upcoming = (ts, minutes) => { const now = Date.now() / 1000; while (ts && minutes > 0 && ts <= now) ts += minutes * 60; return ts; };
  const when = (ts) => `${hm(ts)} (${fmtIn(ts)})`;
  const next = upcoming(CONFIG.speedtest.next_run, CONFIG.speedtest.interval_minutes);
  const nextRegions = upcoming(CONFIG.speedtest.next_regions_run, CONFIG.speedtest.regions_interval_minutes);
  if (CONFIG.speedtest.enabled && next) meta += `<div>Next scheduled run: ${when(next)}${nextRegions ? ` · regions: ${when(nextRegions)}` : ''}</div>`;
  if (!CONFIG.speedtest.enabled) meta += `<div>Scheduled speedtests are off in the config${CONFIG.speedtest.manual ? '; Run now still works' : ''}.</div>`;
  $('#speed-meta').innerHTML = meta;

  renderRegions(st);
  renderGlobal(st.global);

  const running = st.status.running;
  const btn = $('#run-speedtest');
  btn.hidden = !!CONFIG.public || !CONFIG.speedtest.manual;  // the public dashboard is read-only
  btn.disabled = running;
  btn.textContent = running ? `Running ${st.status.label && st.status.label !== 'Auto' ? st.status.label : ''}…`.replace(' …', '…') : 'Run now';
  btn.title = st.status.waiting
    ? `A scheduled test is waiting: the network is busy (${fmtMbps(st.status.busy_mbps)} Mbps on ${st.status.busy_source}). Run now starts one straight away.`
    : '';
  if (st.status.waiting && !running) btn.textContent = 'Run now (waiting: network busy)';
  const rbtn = $('#run-regions');
  rbtn.hidden = !CONFIG.speedtest.manual || !CONFIG.speedtest.regions.length || !!CONFIG.public;
  rbtn.disabled = running;
  const gbtn = $('#run-global');
  gbtn.hidden = !CONFIG.speedtest.manual || !!CONFIG.public;
  gbtn.disabled = running;
}

// Click-to-sort column headings for the speedtest tables: the first click puts the best first (fastest for Mbps,
// lowest for ms, A-Z for text), the second reverses it, the third goes back to the table's own order.
const firstDir = (key) => (/mbps|ts$/.test(key) ? -1 : 1);
const nextSort = (sort, key) => (sort?.key !== key ? { key, dir: firstDir(key) } : sort.dir === firstDir(key) ? { key, dir: -sort.dir } : null);
const sortTh = (sort, key, label, left = false) => {
  const on = sort?.key === key;
  return `<th class="sortable${on ? ' sorted' : ''}" data-sort="${key}" title="Sort by ${esc(label)}"${left ? ' style="text-align:left"' : ''}>`
    + `${esc(label)}${on ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
};
const sortRows = (rows, sort, val = (x, k) => x[k]) => (!sort ? rows : [...rows].sort((a, b) => {
  const x = val(a, sort.key), y = val(b, sort.key);
  if (x == null || x === '' || y == null || y === '') return (x == null || x === '') - (y == null || y === '');  // no data: always last
  return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir;
}));

// Sortable columns of the speedtest result lists: [key, heading, left-aligned]
const RESULT_COLS = {
  global: [['ts', 'Time'], ['label', 'City', true], ['server', 'Server', true], ['download_mbps', 'Down Mbps'], ['upload_mbps', 'Up Mbps'],
    ['ping_ms', 'Ping ms'], ['jitter_ms', 'Jitter ms'], ['packet_loss', 'Loss'], ['data_bytes', 'Data']],
  history: [['ts', 'Time'], ['label', 'Test'], ['download_mbps', 'Down Mbps'], ['upload_mbps', 'Up Mbps'], ['ping_ms', 'Ping ms'],
    ['jitter_ms', 'Jitter ms'], ['packet_loss', 'Loss'], ['data_bytes', 'Data'], ['isp', 'ISP'], ['server', 'Server']],
};
// a test result's value for a sort key (failed tests have no numbers, so they sort last)
const resultVal = (x, k) => (k === 'ts' || k === 'label' ? x[k] : x.error ? null
  : k === 'server' ? `${x.server_name || ''}${x.server_location ? ', ' + x.server_location : ''}` : x[k]);

// Closest server, secondary connections and region speedtests, latest and 7-day averages. Sorting moves the
// regions only: the closest server and connections stay on top and All regions at the bottom.
let lastSpeedStatus = null;
let regionSort = store.get('sort:regions', null);
function renderRegions(st) {
  lastSpeedStatus = st;
  const ok = st.last_ok;
  const regions = st.regions || [];
  const conns = st.connections || [];
  $('#region-table').hidden = $('#panel-regions').hidden = !regions.length && !conns.length;
  if (regions.length || conns.length) {
    const latestCells = (x) => (!x || x.ts == null ? '<td colspan="6" class="muted" style="text-align:left">not tested yet</td>'
      : x.error ? `<td colspan="6" class="error-text" style="text-align:left" title="${esc(x.error)}">failed: ${esc(x.error.slice(0, 60))}</td>`
      : `<td style="text-align:left">${esc(x.isp || '')}</td><td>${fmtMbps(x.download_mbps)}</td><td>${fmtMbps(x.upload_mbps)}</td>
         <td>${fmtMs(x.ping_ms)}</td><td>${fmtMs(x.jitter_ms)}</td><td>${x.packet_loss == null ? '-' : fmtPct(x.packet_loss)}</td>`);
    const avgCells = (a) => `<td>${fmtMbps(a?.download_mbps)}</td><td>${fmtMbps(a?.upload_mbps)}</td><td>${fmtMs(a?.ping_ms)}</td><td>${fmtBytes(a?.data_bytes)}</td>`;
    const row = (name, x, a, cls = '', action = '', route = '') => `<tr class="${cls}"><td>${name}</td>${latestCells(x)}${avgCells(a)}
      <td>${x?.ts ? fmtAgo(x.ts) : ''}</td><td style="text-align:left">${route ? routeHtml(route) : ''}</td><td>${action}</td></tr>`;
    $('#region-table').innerHTML = `
      <thead>
        <tr><th></th><th colspan="6" class="span">Latest</th><th colspan="4" class="span">Last 7 days</th><th></th><th></th><th></th></tr>
        <tr>${[['name', 'Test'], ['isp', 'ISP', true], ['download_mbps', 'Down'], ['upload_mbps', 'Up'], ['ping_ms', 'Ping'],
            ['jitter_ms', 'Jitter'], ['packet_loss', 'Loss'], ['a7_download_mbps', 'Avg down'], ['a7_upload_mbps', 'Avg up'],
            ['a7_ping_ms', 'Avg ping'], ['a7_data_bytes', 'Data'], ['ts', 'Tested']].map(([k, l, left]) => sortTh(regionSort, k, l, left)).join('')}
            <th style="text-align:left">Route</th><th></th></tr>
      </thead>
      <tbody>
        ${row('<b>Closest server</b>', ok, st.averages?.['7d'], 'strong', '', 'speedtest:Auto')}
        ${conns.map((x) => row(`<b>${esc(x.name)}</b>`, x.ts != null && x.error && x.last_ok ? x.last_ok : x, x.avg7d, 'strong',
          CONFIG.speedtest.manual && !CONFIG.public ? `<button class="link run-conn" data-conn="${esc(x.name)}">Run</button>` : '')).join('')}
        ${sortRows(regions, regionSort, regionVal).map((x) => row(`${flag(x.flag)}${esc(x.name)}`, x, x.avg7d, '', '', `region:${x.name}`)).join('')}
        ${regions.length ? `<tr class="strong total"><td><b>All regions</b></td><td colspan="6" class="muted" style="text-align:left">${st.regions_avg?.['7d']?.tests ?? 0} tests in 7 days</td>${avgCells(st.regions_avg?.['7d'])}<td></td><td></td><td></td></tr>` : ''}
      </tbody>`;
  }

}
// a region row's value for a sort key: latest result, or a7_ for its 7-day average
const regionVal = (x, k) => (k === 'name' ? x.name : k.startsWith('a7_') ? x.avg7d?.[k.slice(3)] : x.error && k !== 'ts' ? null : x[k]);

// Global speedtests: every Nth main test is followed by one to a random server somewhere in the world.
// They show how your connection does over long distances and aren't part of your own averages.
let lastGlobal = null;
let globalSort = store.get('sort:global', null);
function renderGlobal(g) {
  lastGlobal = g;
  const panel = $('#panel-global');
  panel.hidden = !g || (!g.every && !g.recent.length);
  if (panel.hidden) return;
  $('#global-note').textContent = !g.every ? '· turned off ([speedtest] global_every = 0)'
    : `· a random server somewhere in the world after every ${g.every === 1 ? '' : g.every + ' '}speedtest${g.every === 1 ? '' : 's'}`
      + (g.due_in != null ? ` · next one ${g.due_in === 0 ? 'with the next speedtest' : `after ${g.due_in} more`}` : '')
      + ' · not counted in your averages';
  const a = g.avg30d;
  $('#global-table').innerHTML = g.recent.length ? `
    <thead><tr>${RESULT_COLS.global.map(([k, l, left]) => sortTh(globalSort, k, l, left)).join('')}<th></th></tr></thead>
    <tbody>
      <tr class="avg-row"><td><b>Average (30 days)</b></td><td style="text-align:left" class="muted">${a.tests} test${a.tests === 1 ? '' : 's'}</td><td></td>
        <td>${fmtMbps(a.download_mbps)}</td><td>${fmtMbps(a.upload_mbps)}</td><td>${fmtMs(a.ping_ms)}</td><td>${fmtMs(a.jitter_ms)}</td>
        <td>${a.packet_loss == null ? '-' : fmtPct(a.packet_loss)}</td><td>${fmtBytes(a.data_bytes)}</td><td></td></tr>
      ${sortRows(g.recent, globalSort, resultVal).map((x) => x.error
        ? `<tr><td>${fmtTime(x.ts)}</td><td style="text-align:left">${flag(x.flag)}${esc(x.label)}</td><td colspan="8" class="error-text" style="text-align:left">${esc(x.error)}</td></tr>`
        : `<tr><td>${fmtTime(x.ts)}</td><td style="text-align:left">${flag(x.flag)}${esc(x.label)}</td>
           <td style="text-align:left">${esc(x.server_name || '')}${x.server_location ? ', ' + esc(x.server_location) : ''}</td>
           <td>${fmtMbps(x.download_mbps)}</td><td>${fmtMbps(x.upload_mbps)}</td><td>${fmtMs(x.ping_ms)}</td><td>${fmtMs(x.jitter_ms)}</td>
           <td>${x.packet_loss == null ? '-' : fmtPct(x.packet_loss)}</td><td>${fmtBytes(x.data_bytes)}</td>
           <td>${x.result_url ? `<a href="${esc(x.result_url)}" target="_blank" rel="noopener">result ↗</a>` : ''}</td></tr>`).join('')}
    </tbody>` : '<tbody><tr><td class="muted">No global speedtests yet.</td></tr></tbody>';
}

// ------------------------------------------------------------------ DNS and CDN
// Which CDN server each DNS resolver sends you to, ranked by the latency to the addresses it handed out.
let CDN_DATA = null;
let cdnSort = store.get('sort:cdn', null);  // {key, dir} or null = ranked by average latency
async function refreshCdn() {
  const d = await api('cdn');
  const panel = $('#panel-cdn');
  panel.hidden = !d.enabled && !d.servers.length;
  if (panel.hidden) return;
  CDN_DATA = d;
  CDN_ROUTES = d.routes || {};
  Object.assign(ROUTES, CDN_ROUTES);
  $('#run-cdn').hidden = !!CONFIG.public;
  $('#cdn-note').textContent = d.ts ? `· tested ${fmtAgo(d.ts)}, every ${d.interval_minutes} min` : '· first test running…';
  renderCdn();
}

// average latency to the addresses one DNS server handed out for one hostname
// Columns of the CDN table, one per CDN: hostnames with the same CDN name (Akamai's a2.w10 and a10.w2) share one
const cdnCols = (hostnames) => {
  const cols = [];
  for (const h of hostnames) {
    const name = CDN_DATA?.names?.[h];  // from targets.toml (or extra_hostnames)
    const label = name ? `${name} CDN` : h.replace(/^www\./, '');
    const c = cols.find((x) => x.label === label);
    if (c) c.hosts.push(h); else cols.push({ label, hosts: [h] });
  }
  return cols;
};
const cdnResults = (x, hosts) => hosts.flatMap((h) => x.results[h] || []);
const cdnAvg = (al) => mean((al || []).filter((x) => x.ip).map((x) => x.rtt));
const cdnLoss = (al) => mean((al || []).filter((x) => x.ip).map((x) => x.loss));

function renderCdn() {
  const d = CDN_DATA;
  if (!d?.servers.length) { $('#cdn-table').innerHTML = ''; return; }
  const value = (x, key) => (key === 'total' ? x.total : key === 'score' ? x.score : key === 'avg7d' ? x.avg7d : key === 'dns' ? x.resolve_ms
    : cdnAvg(cdnResults(x, key.slice(2).split(' '))));
  // a resolver that left a name unanswered stays at the bottom, whichever column the table is sorted by
  const rows = cdnSort ? [...d.servers].sort((a, b) => {
    if (!a.failed !== !b.failed) return a.failed ? 1 : -1;
    const p = value(a, cdnSort.key), q = value(b, cdnSort.key);
    if (p == null || q == null) return (p == null) - (q == null);
    return (p - q) * cdnSort.dir;
  }) : d.servers;
  const cols = cdnCols(d.hostnames);
  const th = (key, label, left, tip) => {
    const on = cdnSort?.key === key;
    return `<th class="sortable${on ? ' sorted' : ''}${key === 'total' ? ' avg' : ''}" data-sort="${esc(key)}"${left ? ' style="text-align:left"' : ''} title="${esc(tip || 'Ping to the servers this DNS server gave for ' + label)}. Click to sort">`
      + `${esc(label)}${on ? (cdnSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  };
  const cell = (x, c) => {
    const h = c.hosts.join(' ');
    const al = cdnResults(x, c.hosts);
    if (!al?.length) return '<td class="muted" style="text-align:left">-</td>';
    const a = al[0];
    if (!a.ip) return `<td style="text-align:left"><span class="error-text">${esc(a.error || 'no answer')}</span></td>`;
    const ok = al.filter((y) => y.ip);
    const avg = cdnAvg(al), loss = cdnLoss(al);
    return `<td class="cdn-cell" data-server="${esc(x.id)}" data-host="${esc(h)}" style="text-align:left" title="Click for the route${ok.length > 1 ? 's to all ' + ok.length + ' addresses' : ''}">
      <div><b>${avg == null ? '<span class="error-text">no reply</span>' : fmtMs(avg) + ' ms'}</b>${loss ? ` ${fmtLoss(loss)}` : ''}
      <div class="muted small">${esc(a.ip)}${ok.length > 1 ? ` +${ok.length - 1}` : ''}</div></div>
      <div class="route">${routeHtml(`cdn:${a.ip}`)}</div></td>`;
  };
  // the resolver and its numbers stay put on the left; the CDN columns scroll past them
  $('#cdn-table').innerHTML = `
    <thead><tr><th>#</th><th style="text-align:left">DNS server</th>
      ${th('total', 'Score', false, 'CDN ping plus lookup time: lower is better (the ranking)')}
      ${th('score', 'CDN ping', false, 'Average ping to the CDN servers this DNS server sent you to')}
      ${th('avg7d', 'CDN ping 7d', false, 'The average CDN ping over the last 7 days')}
      ${th('dns', 'Lookup', false, 'How long this DNS server took to answer the lookups')}
      ${cols.map((c) => th('h:' + c.hosts.join(' '), c.label, true, `Ping to the servers this DNS server gave for ${c.hosts.join(' and ')}`)).join('')}</tr></thead>
    <tbody>${rows.map((x) => `<tr><td>${x.total == null ? '' : d.servers.indexOf(x) + 1}</td>
      <td style="text-align:left"><b>${esc(x.name)}</b>${x.family === 6 ? ' <span class="muted">v6</span>' : ''}<div class="muted small">${esc(x.host)}</div></td>
      <td class="avg">${fmtMs(x.total)}</td><td>${fmtMs(x.score)}</td><td>${fmtMs(x.avg7d)}</td><td>${fmtMs(x.resolve_ms)}</td>
      ${cols.map((c) => cell(x, c)).join('')}</tr>`).join('')}</tbody>`;
  stickCdn();
}
// Pin the first 6 columns (when there's room for them) and show the ‹ › buttons when the CDN columns overflow
const CDN_FIXED = 6;
function stickCdn() {
  const t = $('#cdn-table'), wrap = t.parentElement;
  const head = t.rows[0];
  if (!head) return;
  const lefts = [0];
  for (let i = 1; i < CDN_FIXED; i++) lefts.push(lefts[i - 1] + head.cells[i - 1].offsetWidth);
  const fixedW = lefts[CDN_FIXED - 1] + head.cells[CDN_FIXED - 1].offsetWidth;
  const stick = fixedW < wrap.clientWidth * 0.6;  // phones: everything scrolls
  for (const r of t.rows) {
    for (let i = 0; i < CDN_FIXED; i++) {
      const c = r.cells[i];
      c.classList.toggle('stick', stick);
      c.classList.toggle('stick-end', stick && i === CDN_FIXED - 1);
      c.style.left = stick ? `${lefts[i]}px` : '';
    }
  }
  $('#cdn-scroll').hidden = wrap.scrollWidth <= wrap.clientWidth + 1;
  syncCdnScroll();
  fitCdnIntro();
}
// The intro text ends where the ‹ › buttons do (or just before Test now), unless that would make it too narrow
function fitCdnIntro() {
  const intro = $('#panel-cdn .cdn-intro');
  intro.style.maxWidth = '';
  const arrows = $('#cdn-scroll'), run = $('#run-cdn');
  const right = !arrows.hidden ? arrows.getBoundingClientRect().right : !run.hidden ? run.getBoundingClientRect().left - 12 : null;
  const w = right == null ? 0 : right - intro.getBoundingClientRect().left;
  if (w > 320) intro.style.maxWidth = `${w}px`;
}
function syncCdnScroll() {
  const wrap = $('#cdn-table').parentElement;
  const [prev, next] = $('#cdn-scroll').querySelectorAll('button');
  prev.disabled = wrap.scrollLeft <= 0;
  next.disabled = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 1;
}

// Every address a DNS server handed out for a hostname, each with its ping and route (click one for its hops)
function showCdnRoutes(serverId, host) {
  const x = CDN_DATA?.servers.find((s) => s.id === serverId);
  const ok = cdnResults(x || { results: {} }, host.split(' ')).filter((a) => a.ip);
  host = cdnCols(host.split(' '))[0].label;
  if (ok.length === 1) return showRoute(`cdn:${ok[0].ip}`, `${host} (${ok[0].ip})`);
  const dlg = $('#route-dialog');
  dlg.innerHTML = `<div class="dlg-head"><h2>${esc(host)} via ${esc(x.name)}${x.family === 6 ? ' v6' : ''}</h2><button class="link" data-close>Close</button></div>
    <p class="muted small">${x.name} handed out ${ok.length} addresses. Average ${fmtMs(cdnAvg(ok))} ms. Click a route for its hops.</p>
    <div class="table-wrap"><table class="stats"><thead><tr><th style="text-align:left">Address</th><th>Ping ms</th><th>Loss</th><th style="text-align:left">Route</th></tr></thead>
    <tbody>${ok.map((a) => `<tr><td style="text-align:left">${esc(a.ip)}</td><td>${a.rtt == null ? '<span class="error-text">no reply</span>' : fmtMs(a.rtt)}</td>
      <td>${fmtLoss(a.loss)}</td><td style="text-align:left">${routeHtml(`cdn:${a.ip}`)}</td></tr>`).join('')}</tbody></table></div>`;
  dlg.showModal();
}

// ------------------------------------------------------------------ system card
function bar(pct) {
  const cls = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
  return `<div class="bar"><div class="${cls}" style="width:${Math.min(100, pct || 0)}%"></div></div>`;
}

// ------------------------------------------------------------------ public dashboard sharing (private view only)
async function refreshSharing() {
  if (CONFIG.public) return;
  const d = await api('sharing');
  const el = $('#share-now');
  el.hidden = !d.enabled;
  if (!d.enabled) return;
  const host = (u) => u.replace(/^https:\/\//, '');
  const parts = (d.tunnels || []).map((t) => {
    const cls = t.reachable ? 'good' : t.connected ? 'warn' : 'bad';
    const state = t.reachable ? 'online' : t.connected ? (d.checking ? 'checking…' : 'connected, not reachable yet') : 'not connected';
    const where = t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(host(t.url))}</a>` : 'no hostname yet';
    return `<span title="${esc(t.kind)}${d.checked ? ` · checked ${fmtAgo(d.checked)}` : ''}"><span class="dot ${cls}"></span> ${where} <span class="muted">(${esc(t.kind)}, ${state})</span></span>`;
  });
  if (!parts.length) {
    parts.push(d.checked || !d.checking
      ? `<span title="The public dashboard is on, but no Cloudflare Tunnel or Tailscale Funnel points at it"><span class="dot"></span> on port ${esc(d.port)}, not shared yet (run <code>netbae tunnel</code>)</span>`
      : '<span>checking tunnels…</span>');
  }
  const visitors = `<span title="${d.visitors_1h} in the last hour">${d.visitors_24h} visitor${d.visitors_24h === 1 ? '' : 's'} in the last 24 hours</span>`;
  const direct = d.direct_ts && Date.now() / 1000 - d.direct_ts < 86400
    ? ` · <span class="error-text" title="A visitor reached the public port straight from the internet, so it's port-forwarded and they can see your full IP. Remove the port forward and use netbae tunnel.">reached without a tunnel ${fmtAgo(d.direct_ts)}</span>` : '';
  el.innerHTML = `Public dashboard: ${parts.join(' · ')} · ${visitors}${direct}`;
}

async function refreshSystem() {
  const s = await api('system');
  const info = s.info;
  $('#hostname').textContent = info.hostname ? `· ${info.hostname}` : '';
  $('#subtitle').textContent = [s.ip, info.os].filter(Boolean).join(' · ');
  $('#sys-model').textContent = info.model || info.cpu_model || '';
  const items = [
    ['Uptime', fmtDuration(s.uptime), `${info.arch} · ${info.cpu_count} cores`],
    ['CPU load', s.load ? s.load.map((l) => l.toFixed(2)).join('  ') : '-', '1 · 5 · 15 min avg'],
    ['CPU', fmtPct(s.cpu), bar(s.cpu)],
    ['Memory', s.mem ? fmtPct(s.mem.percent) : '-', s.mem ? `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}${bar(s.mem.percent)}` : ''],
    // the drive in [system] disk_path ("/" = the boot drive), then every local drive added up when there's more than one
    [/^(\/|[A-Za-z]:\\?)$/.test(s.disk?.path || '/') ? 'Boot drive' : 'Storage', s.disk ? fmtPct(s.disk.percent) : '-',
      s.disk ? `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)} (${esc(s.disk.path)})${bar(s.disk.percent)}` : ''],
  ];
  if (s.drives && s.drives.count > 1) {
    items.push(['All drives', fmtPct(s.drives.percent),
      `${fmtBytes(s.drives.used)} / ${fmtBytes(s.drives.total)} (${s.drives.count} drives)${bar(s.drives.percent)}`]);
  }
  if (s.temp != null) items.push(['CPU temperature', `${s.temp.toFixed(1)} °C`, bar(s.temp)]);
  if (s.fan != null) items.push(['Fan speed', `${Math.round(s.fan)} RPM`, s.fan ? 'fastest fan' : 'stopped']);
  else if (s.fan_pct != null) items.push(['Fan', fmtPct(s.fan_pct), (s.fan_pct ? 'of full power' : 'off') + bar(s.fan_pct)]);
  if (s.mem && s.mem.swap_total) items.push(['Swap', fmtBytes(s.mem.swap_used), `of ${fmtBytes(s.mem.swap_total)}`]);
  const keep = +CONFIG.retention_days ? `kept ${CONFIG.retention_days} days` : 'history kept forever';
  items.push(['Database', fmtBytes(s.db_size), keep]);
  $('#sys-body').innerHTML = items.map(([l, v, sub]) =>
    `<div class="sys-item"><div class="label">${l}</div><div class="val">${v}</div><div class="sub">${sub}</div></div>`).join('');
}

// ------------------------------------------------------------------ latency panels (ping + dns)
// Round up to a "nice" axis maximum: 1, 2, 2.5, 5 x 10^n
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((x) => x >= v);
}

// A small button at the end of a chart panel's controls
// A panel's table (and its pager) folds away behind a button, so the page is mostly charts. Remembered per
// browser; folded by default. preview: a table without a chart keeps its first rows (its best) when folded.
function tableToggle(root, label, preview = false) {
  const key = `table:${root.id}`;
  const b = panelButton(root, '', '', () => { store.set(key, !store.get(key, false)); show(); });
  const show = () => {
    const open = store.get(key, false);
    root.classList.toggle(preview ? 'table-preview' : 'table-folded', !open);
    b.textContent = preview ? (open ? 'Show fewer' : `Show all ${label}`) : open ? `Hide ${label}` : `Show ${label}`;
    b.title = open ? `Fold the ${label} away` : `Show the whole ${label}`;
    b.setAttribute('aria-expanded', String(open));
  };
  show();
}

function panelButton(root, text, title, onClick) {
  const b = document.createElement('button');
  b.className = 'btn ghost panel-btn';
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  $('.controls', root).appendChild(b);
  return b;
}

// Y-axis that fits the average lines (spikes and band edges get clipped), with zoom buttons and
// vertical panning (drag the chart with the mouse, or use the arrow buttons).
function yZoom(root, key, chart) {
  let scale = store.get(`yscale:${key}`, 1); // 0 = show everything
  let offset = 0;                             // axis minimum when panned
  let auto;
  const bar = document.createElement('div');
  bar.className = 'zoom';
  bar.innerHTML = `<button data-z="up" title="Pan up">▲</button><button data-z="down" title="Pan down">▼</button>
    <button data-z="in" title="Zoom in">+</button><button data-z="out" title="Zoom out">−</button>
    <button data-z="fit" title="Fit to the averages">Fit</button><button data-z="all" title="Show everything">All</button>`;
  const wrap = $('.chart-wrap', root);
  wrap.appendChild(bar);
  chart.options.layout = { padding: { top: 30 } }; // room for the buttons
  const span = () => (auto || 0) * scale;
  const apply = () => {
    const zoomed = scale && auto;
    chart.options.scales.y.min = zoomed ? +offset.toPrecision(4) : undefined;
    chart.options.scales.y.max = zoomed ? +(offset + span()).toPrecision(4) : undefined;
    bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on',
      (b.dataset.z === 'fit' && scale === 1 && !offset) || (b.dataset.z === 'all' && scale === 0)));
    bar.querySelectorAll('[data-z="up"],[data-z="down"]').forEach((b) => { b.disabled = !zoomed; });
    wrap.classList.toggle('pannable', !!zoomed);
  };
  const zoomTo = (newScale) => { // anchored at 0 until panned, then keep the middle of the view in place
    const mid = offset + span() / 2;
    scale = newScale;
    offset = offset ? Math.max(0, mid - span() / 2) : 0;
  };
  bar.addEventListener('click', (e) => {
    const z = e.target.closest('button')?.dataset.z;
    if (!z) return;
    if (z === 'up') offset += span() * 0.25;
    if (z === 'down') offset = Math.max(0, offset - span() * 0.25);
    if (z === 'in') { if (scale) zoomTo(scale / 2); else { scale = 0.5; offset = 0; } }
    if (z === 'out') { if (scale && scale < 64) zoomTo(scale * 2); }
    if (z === 'fit') { scale = 1; offset = 0; }
    if (z === 'all') { scale = 0; offset = 0; }
    store.set(`yscale:${key}`, scale);
    apply();
    chart.update();
  });
  // mouse drag pans vertically (touch keeps normal page scrolling; use the arrow buttons there)
  let drag = null;
  chart.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !scale || !auto) return;
    drag = { y: e.clientY, offset };
    chart.canvas.setPointerCapture(e.pointerId);
  });
  chart.canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const h = chart.chartArea.bottom - chart.chartArea.top;
    offset = Math.max(0, drag.offset + ((e.clientY - drag.y) / h) * span());
    apply();
    chart.update('none');
  });
  const end = () => { drag = null; };
  chart.canvas.addEventListener('pointerup', end);
  chart.canvas.addEventListener('pointercancel', end);
  return {
    reset() { scale = 1; offset = 0; store.set(`yscale:${key}`, scale); apply(); },
    // values: the numbers the axis should fit (average lines); floor: minimum axis max
    fit(values, floor = 1) {
      const v = values.filter((x) => x != null).sort((a, b) => a - b);
      // the highest average just under the top, so the lines use most of the chart's height
      auto = v.length ? niceCeil(Math.max(floor, v[v.length - 1] * 1.05)) : undefined;
      apply();
    },
  };
}

// ------------------------------------------------------------------ ISP markers
// Each connection's ISP checks are drawn as a row of markers along the top of the System history chart:
// one colour per connection, one shape per ISP, so a failover stands out.
// ISP checks: a tick for each check (a cross when it failed) in that ISP's colour, one row per connection
const ISP_COLORS = ['#fbbf24', '#22d3ee', '#f472b6', '#a3e635', '#c084fc', '#fb923c'];
const ispColorIndex = {};
const ispColor = (isp) => {
  if (!(isp in ispColorIndex)) ispColorIndex[isp] = Object.keys(ispColorIndex).length;
  return ISP_COLORS[ispColorIndex[isp] % ISP_COLORS.length];
};
const ispGlyphs = {};
function ispGlyph(color, failed, size) {  // a small canvas Chart.js draws as the point
  const k = `${color}${failed}${size}`;
  if (ispGlyphs[k]) return ispGlyphs[k];
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(size * dpr);
  c.style.width = c.style.height = `${size}px`;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.strokeStyle = color;
  g.lineWidth = Math.max(2, size / 5);
  g.lineCap = g.lineJoin = 'round';
  const m = g.lineWidth;  // keep the stroke inside the canvas
  g.beginPath();
  if (failed) {
    g.moveTo(m, m); g.lineTo(size - m, size - m);
    g.moveTo(size - m, m); g.lineTo(m, size - m);
  } else {
    g.moveTo(m, size * 0.55); g.lineTo(size * 0.4, size - m); g.lineTo(size - m, m);
  }
  g.stroke();
  return (ispGlyphs[k] = c);
}
const ispLabel = (ctx) => (ctx.raw.failed
  ? ` ${ctx.raw.conn} ISP check failed${ctx.raw.isp ? ` (on ${ctx.raw.isp})` : ''}`
  : ` ${ctx.raw.conn} ISP: ${ctx.raw.isp}${ctx.raw.ip ? ` · ${ctx.raw.ip}` : ''}${ctx.raw.changed ? '  (changed)' : ''}`);

// ISP check marks start hidden (the header already names each connection's ISP). Once shown, every ISP's marks
// are drawn, including one that turns up later in a failover, except those hidden one by one.
const ispShown = () => ({ show: store.get('isp:show', false), off: new Set(store.get('isp:off', [])) });

async function ispOverlay(root, r, onToggle) {
  if (!CONFIG.isp?.enabled) return [];
  let legend = $('.isp-legend', root);
  if (!legend) {
    legend = document.createElement('div');
    legend.className = 'isp-legend';
    $('.chips', root).after(legend);
    legend.addEventListener('click', (e) => {
      let { show, off } = ispShown();
      const keys = [...legend.querySelectorAll('button[data-key]')].map((x) => x.dataset.key);
      if (e.target.closest('.isp-title')) {  // the label toggles every ISP marker at once
        const anyOn = show && keys.some((k) => !off.has(k));
        show = !anyOn; off = new Set();
      } else {
        const b = e.target.closest('button[data-key]');
        if (!b) return;
        const k = b.dataset.key;
        if (!show) { show = true; off = new Set(keys.filter((x) => x !== k)); }  // just this one
        else if (off.has(k)) off.delete(k);
        else off.add(k);
        if (keys.every((x) => off.has(x))) { show = false; off = new Set(); }
      }
      store.set('isp:show', show);
      store.set('isp:off', [...off]);
      onToggle();
    });
  }
  // routine checks ~14px apart; ISP/IP changes are always included and drawn larger
  const d = await api('isp', { from: r.from.toFixed(0), to: r.to.toFixed(0), points: Math.max(30, Math.round(root.clientWidth / 14)) });
  const { show, off } = ispShown();
  const on = { has: (k) => show && !off.has(k) };
  const datasets = [];
  const buttons = [];
  const keys = [];
  CONFIG.isp.connections.forEach((conn, ci) => {
    // a failed check is drawn in the colour of the ISP the connection was on (the one before it, or else after it)
    const raw = d.series[conn] || [];
    let cur = raw.find((p) => p[1] && p[1] !== 'check failed')?.[1] ?? null;
    const pts = raw.map((p) => {
      const failed = p[1] === 'check failed';
      if (p[1] && !failed) cur = p[1];
      return { x: p[0], y: 0.965 - ci * 0.06, isp: failed ? cur : p[1], ip: p[2], conn, changed: p[4], failed };
    }).filter((p) => p.isp || p.failed);
    for (const isp of [...new Set(pts.map((p) => p.isp))]) {
      const color = isp ? ispColor(isp) : css('--muted');
      const key = `${conn}|${isp}`;
      keys.push(key);
      const fails = pts.filter((p) => p.isp === isp && p.failed).length;
      buttons.push(`<button data-key="${esc(key)}" class="${on.has(key) ? '' : 'off'}" title="Show or hide ${esc(conn)} ISP checks${fails ? ` (✕ = ${fails} failed)` : ''}">
        <span style="color:${color}">✓</span>${esc(conn)}: ${esc(isp || 'unknown')}</button>`);
      if (!on.has(key)) continue;
      datasets.push({
        role: 'isp', label: `${conn} ISP`, yAxisID: 'yIsp', showLine: false,
        pointStyle: (c) => ispGlyph(color, !!c.raw?.failed, c.raw?.changed ? 15 : 10),
        pointRadius: (c) => (c.raw?.changed ? 7.5 : 5), pointHoverRadius: 8, pointHitRadius: 8,
        borderColor: color, backgroundColor: color, borderWidth: 0,
        data: pts.filter((p) => p.isp === isp),
      });
    }
  });
  const allOff = keys.length && keys.every((k) => !on.has(k));
  legend.innerHTML = buttons.length ? `<button class="isp-title${allOff ? ' off' : ''}" title="Each mark along the top of the chart is an ISP check, in that ISP's colour: a tick when it worked, a cross when it failed, one row per connection. A bigger mark means the ISP or IP changed. Click to show or hide them all.">ISP checks</button>${buttons.join('')}` : '';
  return datasets;
}

// collapse: hosts are drawn as one line per category (catOf) until that category's table row is clicked to
// expand it, which keeps chart rendering light even with a hundred hosts.
function latencyPanel({ id, endpoint, keyParam, items, defaultRange, extraParams, lossLabel, defaultHide = HIDDEN_BY_DEFAULT,
  collapse = false, catOf = (it) => it.group, memberNoun = 'hosts', chipRows = false, routeKey = null, catRoute = false }) {
  const defaultOff = items.filter((it) => defaultHide(it)).map((it) => it.id);
  // lines hidden by default start hidden once in browsers that saved their own choice before (then it's theirs)
  const saved = store.get(`off3:${id}`, null);
  if (saved && defaultOff.length && !store.get(`hid1:${id}`, false)) store.set(`off3:${id}`, [...new Set([...saved, ...defaultOff])]);
  store.set(`hid1:${id}`, true);
  const expanded = new Set(store.get(`expand:${id}`, []));
  const off = new Set(store.get(`lineoff:${id}`, []));  // lines hidden by clicking their row in the table
  const root = $(`#${id}`);
  const metricSel = $('.metric', root);
  const bandSel = $('.band', root);
  // IPv4 / IPv6 / both, for items with an IPv6 twin (item.v6 = the twin's id)
  const familySel = $('.family', root);
  if (familySel) {
    familySel.hidden = !items.some((it) => it.v6);
    familySel.value = store.get(`family:${id}`, '4');
    if (!familySel.value) familySel.value = '4';
  }
  metricSel.value = store.get(`metric:${id}`, 'latency');
  if (!metricSel.value) metricSel.value = 'latency';
  // default from [web] chart_band (a browser's own choice wins)
  const bandDefault = { 'p5-p95': 'pct', 'min-max': 'minmax', none: 'none' }[CONFIG.chart_band] || 'none';
  bandSel.value = store.get(`band:${id}`, bandDefault);
  if (!bandSel.value) bandSel.value = bandDefault;
  // ISP filter: only the times the main connection was on the chosen ISP (shown once more than one has been seen)
  const ispSel = document.createElement('select');
  ispSel.className = 'isp-filter';
  ispSel.setAttribute('aria-label', 'ISP');
  ispSel.title = 'Only the times your main connection was on this ISP (from the ISP checks)';
  const isps = CONFIG.isp_history || [];
  const day = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
  ispSel.innerHTML = '<option value="">All ISPs</option>' + isps.map((x) => `<option value="${esc(x.isp)}">${esc(x.isp)} (${day(x.first)} - ${day(x.last)})</option>`).join('');
  ispSel.value = store.get(`isp:${id}`, '');
  if (ispSel.value === undefined || ![...ispSel.options].some((o) => o.value === ispSel.value)) ispSel.value = '';
  ispSel.hidden = isps.length < 2;
  ispSel.addEventListener('change', () => { store.set(`isp:${id}`, ispSel.value); refresh(); });
  const bandNote = document.createElement('span');
  bandNote.className = 'muted small band-note';
  bandNote.hidden = true;
  bandSel.after(bandNote);
  bandNote.after(ispSel);
  const chart = lineChart($('canvas', root), { yTitle: 'ms', plugins: [ispChangeLines] });
  const zoom = yZoom(root, id, chart);
  // Only the average line gets a tooltip entry; it carries the band values with it.
  chart.options.plugins.tooltip.filter = (item) => item.dataset.role !== 'band';

  chart.options.plugins.tooltip.callbacks.label = (ctx) => {
    if (ctx.dataset.role === 'isp') return ispLabel(ctx);
    const p = ctx.raw;
    if (ctx.dataset.unit === '%') return ` ${ctx.dataset.label}: ${fmtPct(p.y, 2)}`;
    const band = p.lo != null ? `  (${p.bandName} ${fmtMs(p.lo)} – ${fmtMs(p.hi)})` : '';
    return ` ${ctx.dataset.label}: ${fmtMs(p.y)} ms${band}`;
  };

  let syncExpand = () => {};
  let seq = 0;  // only the newest request draws: quick dropdown changes don't pile up or land out of order
  const refresh = async () => {
    const r = range.get();
    if (!r) return;
    const mine = ++seq;
    syncExpand();
    chips.sync();
    const sel = chips.selected();
    const metric = metricSel.value;
    const band = bandSel.value;
    bandSel.hidden = metric === 'loss';
    // ~1 point per 6px so each bucket holds several samples and the spread band means something
    const points = Math.max(60, Math.min(300, Math.round(root.clientWidth / 6)));
    // Blocks for the table, one per category (or per host when not collapsing), and the lines to draw.
    // Per IP version: IPv6 lines are dashed when both are shown. A collapsed category is one combined series
    // ("id1+id2+..."); expanded, its hosts get their own lines and the category row keeps its totals.
    const fam = familySel && !familySel.hidden ? familySel.value : '4';
    const variants = fam === 'both' ? ['4', '6'] : [fam];
    const chosen = items.filter((x) => sel.includes(x.id));
    const blocks = [];
    for (const cat of collapse ? [...new Set(chosen.map(catOf))] : [null]) {
      const mem = collapse ? chosen.filter((it) => catOf(it) === cat) : chosen;
      for (const v of variants) {
        const sfx = v === '6' ? ' (IPv6)' : '';
        const dash = v === '6' && fam === 'both' ? [5, 4] : [];
        const members = mem.filter((it) => v === '4' || it.v6)
          .map((it) => ({ ...it, key: v === '6' ? it.v6 : it.id, label: it.label + sfx, dash }));
        if (!members.length) continue;
        if (!collapse || members.length === 1) { blocks.push({ summary: null, members, open: true }); continue; }
        const mid = members[Math.floor((members.length - 1) / 2)];
        blocks.push({
          summary: { key: members.map((x) => x.key).join('+') + '+', label: cat + sfx, color: mid.color, dash, cat, count: members.length, ids: members.map((x) => x.id) },
          members, open: expanded.has(cat),
        });
      }
    }
    const series = blocks.flatMap((b) => (b.summary && !b.open ? [b.summary] : b.members));  // drawn
    const wanted = [...new Set(blocks.flatMap((b) => (b.summary ? [b.summary.key] : []).concat(b.open ? b.members.map((x) => x.key) : [])))];
    const params = { from: r.from.toFixed(0), to: r.to.toFixed(0), points, ...(extraParams ? extraParams() : {}) };
    if (ispSel.value) params.isp = ispSel.value;
    params[keyParam] = wanted.join(',') || '__none__';
    const d = await api(endpoint, params);
    if (mine !== seq) return r.live;  // a newer refresh has started
    // point layout: [t, avg, min, max, loss%, p5, p95]
    const [loI, hiI, bandName] = band === 'minmax' ? [2, 3, 'min–max'] : [5, 6, 'p5–p95'];
    chart.options.scales.y.title.text = metric === 'loss' ? '%' : 'ms';

    // a band per line turns into a smear beyond a dozen lines, so it's only drawn up to that
    const MAX_BANDS = 12;
    const drawBand = band !== 'none' && metric !== 'loss' && series.length <= MAX_BANDS;
    bandNote.hidden = band === 'none' || metric === 'loss' || drawBand;
    bandNote.textContent = `band shows with ${MAX_BANDS} or fewer lines`;
    const datasets = [];
    for (const it of series) {
      const pts = d.series[it.key] || [];
      const tag = { cat: it.ids ? it.cat : catOf(it), ids: it.ids || [it.id] };  // what hovering a chip or category matches
      if (metric === 'loss') {
        datasets.push({
          ...tag, key: it.key, label: it.label, unit: '%', borderColor: it.color, backgroundColor: it.color, borderDash: it.dash || [],
          stepped: 'middle', spanGaps: false, data: pts.map((p) => ({ x: p[0], y: p[4] })),
        });
        continue;
      }
      if (drawBand) {
        const edge = { ...tag, role: 'band', key: it.key, label: it.label, borderColor: it.color + '73', borderWidth: 1, borderDash: [4, 3], spanGaps: false, pointHoverRadius: 0, pointHitRadius: 0 };
        // upper edge fills down to the lower edge (the next dataset)
        datasets.push({ ...edge, fill: '+1', backgroundColor: it.color + '1f', data: pts.map((p) => ({ x: p[0], y: p[hiI] })) });
        datasets.push({ ...edge, fill: false, data: pts.map((p) => ({ x: p[0], y: p[loI] })) });
      }
      datasets.push({
        ...tag, role: 'avg', key: it.key, label: it.label, unit: 'ms', borderColor: it.color, backgroundColor: it.color, borderWidth: 2, spanGaps: false,
        borderDash: it.dash || [],
        data: pts.map((p) => ({ x: p[0], y: p[1], lo: band === 'none' ? null : p[loI], hi: p[hiI], bandName })),
      });
    }
    zoom.fit(datasets.filter((ds) => ds.role !== 'band').flatMap((ds) => ds.data.map((p) => p.y)), metric === 'loss' ? 5 : 1);
    for (const ds of datasets) ds.hidden = off.has(ds.key);
    chart.data.datasets = datasets;
    setXRange(chart, r);
    chart.update();

    lastTable = { blocks, stats: d.stats };
    renderTable();
    const k = hoverSpec; hoverSpec = null; highlight(k);  // keep the highlight across live refreshes
    return r.live;
  };

  // The stats table. Click a column heading to sort by it: ascending, then descending, then back to the list order.
  let lastTable = null;
  let sort = store.get(`sort:${id}`, null);  // {key, dir: 1 | -1} or null
  const COLS = [['avg', 'Avg ms'], ['min', 'Min'], ['p5', 'P5'], ['p95', 'P95'], ['max', 'Max'], ['loss', lossLabel], ['samples', 'Samples']];
  function renderTable() {
    if (!lastTable) return;
    const { blocks, stats } = lastTable;
    const val = (it) => (stats[it.key] || {})[sort.key];
    const cmp = (a, b) => {
      const x = val(a), y = val(b);
      if (x == null || y == null) return (x == null) - (y == null);  // no data: always last
      return (x - y) * sort.dir;
    };
    const lead = (b) => b.summary || b.members[0];
    const ordered = sort ? [...blocks].sort((a, b) => cmp(lead(a), lead(b))) : blocks;
    const th = ([key, label]) => {
      const on = sort?.key === key;
      return `<th class="sortable${key === 'avg' ? ' avg' : ''}${on ? ' sorted' : ''}" data-sort="${key}" title="Sort by ${esc(label)}">`
        + `${esc(label)}${on ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    };
    const row = (it, kind) => {
      const s = stats[it.key] || {};
      const name = kind === 'cat'
        ? `<span class="caret">${it.open ? '▾' : '▸'}</span> <i class="host-sq" style="background:${it.color}"></i> <b>${esc(it.label)}</b> <span class="muted">${it.count} ${memberNoun}</span>`
        : `<i class="host-sq" style="background:${it.color}"></i> ${esc(it.label)}`;
      const cls = [kind === 'cat' ? 'cat-row' : kind === 'member' ? 'member-row' : 'host-row', off.has(it.key) ? 'line-off' : ''].join(' ');
      const tip = kind === 'cat' ? `${it.open ? 'Collapse' : 'Show each host in'} ${it.cat}` : `Click to ${off.has(it.key) ? 'show' : 'hide'} this line on the chart`;
      return `<tr data-key="${esc(it.key)}" class="${cls}"${kind === 'cat' ? ` data-cat="${esc(it.cat)}"` : ''} title="${esc(tip)}">
        <td>${name}</td>
        <td class="avg">${fmtMs(s.avg)}</td><td>${fmtMs(s.min)}</td><td>${fmtMs(s.p5)}</td><td>${fmtMs(s.p95)}</td><td>${fmtMs(s.max)}</td>
        <td>${fmtLoss(s.loss, 2)}</td><td>${(s.samples ?? 0).toLocaleString()}</td>${routeKey ? `<td style="text-align:left">${routeCell(it, kind)}</td>` : ''}</tr>`;
    };
    // a host's route; a category row shows its first host's route when they all go to one place (a DNS server's v4 and v6)
    const routeCell = (it, kind) => {
      const k = kind !== 'cat' ? routeKey(it) : catRoute ? routeKey(blocks.find((b) => b.summary?.key === it.key)?.members[0]) : null;
      return k ? routeHtml(k) : '';
    };
    const body = ordered.map((b) => {
      if (!b.summary) return (sort ? [...b.members].sort(cmp) : b.members).map((it) => row(it, '')).join('');
      return row({ ...b.summary, open: b.open }, 'cat')
        + (b.open ? (sort ? [...b.members].sort(cmp) : b.members).map((it) => row(it, 'member')).join('') : '');
    }).join('');
    $('.stats', root).innerHTML = `<thead><tr><th>Host</th>${COLS.map(th).join('')}${routeKey ? '<th style="text-align:left">Route</th>' : ''}</tr></thead><tbody>${body}</tbody>`;
  }
  $('.stats', root).addEventListener('click', (e) => {
    const catRow = e.target.closest('tr.cat-row');
    if (catRow) return toggleCat(catRow.dataset.cat);  // expand or collapse a category
    const hostRow = e.target.closest('tr[data-key]');
    if (hostRow && !e.target.closest('a, button')) return toggleLine(hostRow.dataset.key);  // a host: its line on or off
    const key = e.target.closest('th[data-sort]')?.dataset.sort;
    if (!key) return;
    sort = sort?.key !== key ? { key, dir: 1 } : sort.dir > 0 ? { key, dir: -1 } : null;
    store.set(`sort:${id}`, sort);
    renderTable();
  });
  // Clicking a host's row hides its line on the chart (the row stays, dimmed) or shows it again.
  function toggleLine(key) {
    if (off.has(key)) off.delete(key); else off.add(key);
    store.set(`lineoff:${id}`, [...off]);
    for (const ds of chart.data.datasets) if (ds.key === key) ds.hidden = off.has(key);
    chart.update('none');
    renderTable();
  }
  // Hovering a table row, chip or category picks out its lines in the chart: thicker, with the others faded.
  // spec: "key:<series>" (a table row), "id:<item>" (a chip) or "cat:<category>"
  let hoverSpec = null;
  let pinned = null;  // a category tapped above the chart stays picked out until it's tapped again
  const matches = (ds, spec) => {
    const i = spec.indexOf(':'), kind = spec.slice(0, i), v = spec.slice(i + 1);
    return kind === 'key' ? ds.key === v : kind === 'cat' ? ds.cat === v : !!ds.ids?.includes(v);
  };
  function highlight(spec) {
    if (spec === hoverSpec) return;
    hoverSpec = spec;
    const on = spec && chart.data.datasets.some((ds) => ds.key && !ds.hidden && matches(ds, spec));
    for (const ds of chart.data.datasets) {
      if (!ds.key) continue;
      ds.baseColor ??= ds.borderColor;
      ds.baseWidth ??= ds.borderWidth ?? 1.75;
      const me = on && matches(ds, spec);
      ds.borderColor = on && !me ? ds.baseColor.slice(0, 7) + '33' : ds.baseColor;
      ds.borderWidth = on && me && ds.role !== 'band' ? ds.baseWidth + 1.5 : ds.baseWidth;
      ds.order = on && me ? -1 : 0;
    }
    chart.update('none');
  }
  $('.stats', root).addEventListener('mouseover', (e) => {
    const k = e.target.closest('tr[data-key]')?.dataset.key;
    highlight(k ? `key:${k}` : pinned);
  });
  $('.stats', root).addEventListener('mouseleave', () => highlight(pinned));
  const chipHover = (spec, pin) => {
    if (pin) pinned = pinned === spec ? null : spec;
    highlight(pin ? pinned : spec ?? pinned);
    return pinned;
  };
  // with chipRows, a category opened above the chart is opened in the table too, and the other way round
  const toggleCat = (c) => {
    if (expanded.has(c)) expanded.delete(c); else expanded.add(c);
    store.set(`expand:${id}`, [...expanded]);
    refresh();
  };
  const chips = chipFilter($('.chips', root), id, items, refresh, defaultOff,
    chipRows ? { isOpen: (g) => expanded.has(g), toggle: toggleCat } : null, chipHover);
  chips.addToggleAll(root);
  const range = rangeControl($('.range', root), id, defaultRange, refresh);
  // every category's hosts in the table and chart at once, or back to one line per category
  const cats = [...new Set(items.map(catOf))];
  const allOpen = () => cats.every((c) => expanded.has(c));
  const expandBtn = collapse && cats.length > 1 ? panelButton(root, 'Expand all', `Show each of the ${memberNoun} in every category, or one line per category`, () => {
    if (allOpen()) expanded.clear(); else cats.forEach((c) => expanded.add(c));
    store.set(`expand:${id}`, [...expanded]);
    refresh();
  }) : null;
  syncExpand = () => { if (expandBtn) expandBtn.textContent = allOpen() ? 'Collapse all' : 'Expand all'; };
  syncExpand();
  panelButton(root, 'Reset view', 'Back to the default time range and zoom, with every line on and every category collapsed', () => {
    chips.showAll();
    zoom.reset();
    expanded.clear();
    store.set(`expand:${id}`, []);
    off.clear();
    store.set(`lineoff:${id}`, []);
    range.reset();
  });
  metricSel.addEventListener('change', () => { store.set(`metric:${id}`, metricSel.value); refresh(); });
  bandSel.addEventListener('change', () => { store.set(`band:${id}`, bandSel.value); refresh(); });
  // with both IP versions on, a key saying which line style is which
  const famKey = document.createElement('span');
  famKey.className = 'muted small fam-key';
  famKey.innerHTML = '<i class="solid"></i>IPv4 <i class="dashed"></i>IPv6 (dashed)';
  familySel?.after(famKey);
  const showFamKey = () => { famKey.hidden = !familySel || familySel.hidden || familySel.value !== 'both'; };
  showFamKey();
  familySel?.addEventListener('change', () => { store.set(`family:${id}`, familySel.value); showFamKey(); refresh(); });
  return { root, refresh, isLive: () => range.get()?.live, chart };
}

// ------------------------------------------------------------------ speedtest panel
const flagChar = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) + ' ' : '');
const testName = (label) => (label === 'Auto' ? 'Closest server' : flag(CONFIG.speedtest.flags?.[label]) + esc(label));

// A scheduled test that ran anyway after waiting for a busy network: its numbers may be low.
const busyTag = (x) => (x.busy_mbps == null ? ''
  : ` <span class="busy-tag" title="The network was busy (${fmtMbps(x.busy_mbps)} Mbps of other traffic) when this test ran, so it may read low">busy</span>`);

function speedPanel() {
  const root = $('#panel-speed');
  const viewSel = $('.server', root);
  const chart = lineChart($('canvas', root), { yTitle: 'Mbps', y1Title: 'ms' });
  const series = [
    { id: 'download', label: 'Download', color: PALETTE[0], unit: 'Mbps', axis: 'y', key: 'download_mbps' },
    { id: 'upload', label: 'Upload', color: PALETTE[2], unit: 'Mbps', axis: 'y', key: 'upload_mbps' },
    { id: 'ping', label: 'Ping', color: PALETTE[1], unit: 'ms', axis: 'y1', key: 'ping_ms' },
    { id: 'jitter', label: 'Jitter', color: PALETTE[4], unit: 'ms', axis: 'y1', key: 'jitter_ms' },
  ];
  const COMPARE = '__compare__';
  const refresh = async () => {
    const r = range.get();
    if (!r) return;
    const d = await api('speedtest', { from: r.from.toFixed(0), to: r.to.toFixed(0) });
    d.results = d.results.filter((x) => x.kind !== 'global');  // random servers worldwide have their own section
    // views: the main test, each region (configured or seen in range), or all regions side by side
    const labels = [...new Set(['Auto', ...CONFIG.speedtest.regions, ...d.results.map((x) => x.label)])]
      .filter((l) => l === 'Auto' || d.results.some((x) => x.label === l) || CONFIG.speedtest.regions.includes(l));
    const cur = viewSel.value || store.get('speed:view', 'Auto');
    viewSel.innerHTML = labels.map((l) => `<option value="${esc(l)}">${l === 'Auto' ? 'Closest server' : (flagChar(CONFIG.speedtest.flags?.[l]) + esc(l))}</option>`).join('')
      + (labels.length > 1 ? `<option value="${COMPARE}">Compare all</option>` : '');
    viewSel.hidden = labels.length < 2;
    viewSel.value = [...labels, COMPARE].includes(cur) ? cur : 'Auto';
    const view = viewSel.value;
    const sel = chips.selected();

    const rows = view === COMPARE ? d.results : d.results.filter((x) => x.label === view);
    const ok = rows.filter((x) => !x.error);
    if (view === COMPARE) {
      // one line per test location, for the first selected metric
      const metric = series.find((s) => sel.includes(s.id)) || series[0];
      chart.data.datasets = labels.map((l, i) => ({
        label: `${l === 'Auto' ? 'Closest' : l} ${metric.label.toLowerCase()}`, unit: metric.unit, yAxisID: 'y',
        borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length], spanGaps: true, pointRadius: 2.5,
        data: ok.filter((x) => x.label === l).map((x) => ({ x: x.ts * 1000, y: x[metric.key] })),
      }));
      chart.options.scales.y.title.text = metric.unit;
      chart.options.scales.y1.display = false;
    } else {
      chart.data.datasets = series.filter((s) => sel.includes(s.id)).map((s) => ({
        label: s.label, unit: s.unit, yAxisID: s.axis, borderColor: s.color, backgroundColor: s.color,
        borderDash: s.axis === 'y1' ? [4, 3] : [], spanGaps: true,
        pointRadius: ok.length > 200 ? 0 : 2.5,
        data: ok.map((x) => ({ x: x.ts * 1000, y: x[s.key] })),
      }));
      chart.options.scales.y.title.text = 'Mbps';
      chart.options.scales.y1.display = sel.includes('ping') || sel.includes('jitter');
    }
    setXRange(chart, r);
    chart.update();

    const avg = (k) => (ok.length ? ok.reduce((a, x) => a + (x[k] || 0), 0) / ok.length : null);
    // a page at a time
    const all = sortRows(rows.slice().reverse(), sort, resultVal);  // newest first unless a column is sorted
    const pages = Math.max(1, Math.ceil(all.length / pageSize));
    page = Math.min(page, pages - 1);
    const recent = all.slice(page * pageSize, (page + 1) * pageSize);
    $('.stats', root).innerHTML = `
      <thead><tr>${RESULT_COLS.history.map(([k, l]) => sortTh(sort, k, l)).join('')}<th></th></tr></thead>
      <tbody>
        <tr class="avg-row"><td><b>Average (${ok.length} tests)</b></td><td></td><td><b>${fmtMbps(avg('download_mbps'))}</b></td><td><b>${fmtMbps(avg('upload_mbps'))}</b></td>
          <td><b>${fmtMs(avg('ping_ms'))}</b></td><td><b>${fmtMs(avg('jitter_ms'))}</b></td><td></td><td><b>${fmtBytes(ok.reduce((a, x) => a + (x.data_bytes || 0), 0))}</b></td><td></td><td></td><td></td></tr>
        ${recent.map((x) => x.error
          ? `<tr><td>${fmtTime(x.ts)}</td><td>${testName(x.label)}</td><td colspan="9" class="error-text" style="text-align:left">${esc(x.error)}</td></tr>`
          : `<tr><td>${fmtTime(x.ts)}</td><td>${testName(x.label)}${busyTag(x)}</td><td>${fmtMbps(x.download_mbps)}</td><td>${fmtMbps(x.upload_mbps)}</td><td>${fmtMs(x.ping_ms)}</td>
             <td>${fmtMs(x.jitter_ms)}</td><td>${x.packet_loss == null ? '-' : fmtPct(x.packet_loss)}</td><td>${fmtBytes(x.data_bytes)}</td>
             <td style="text-align:left">${esc(x.isp || '')}</td>
             <td style="text-align:left">${esc(x.server_name)}${x.server_location ? ', ' + esc(x.server_location) : ''}</td>
             <td>${x.result_url ? `<a href="${esc(x.result_url)}" target="_blank" rel="noopener">result ↗</a>` : ''}</td></tr>`).join('')}
      </tbody>`;
    const pager = $('.pager', root);
    pager.hidden = all.length <= 10;
    $('.page-info', pager).textContent = all.length
      ? `${page * pageSize + 1}-${Math.min(all.length, (page + 1) * pageSize)} of ${all.length}` : '';
    $('.prev-page', pager).disabled = page === 0;
    $('.next-page', pager).disabled = page >= pages - 1;
  };
  // the results table: 10 tests a page by default, ‹ › to page through, and a page size picker
  let page = 0;
  let pageSize = store.get('speed:pagesize', 10);
  const pager = document.createElement('div');
  pager.className = 'pager small';
  pager.innerHTML = `<select class="page-size" aria-label="Tests per page">${[10, 25, 50, 100].map((n) => `<option value="${n}">${n} per page</option>`).join('')}</select>
    <button class="btn ghost prev-page" title="Newer tests" aria-label="Newer tests">‹</button>
    <span class="page-info muted"></span>
    <button class="btn ghost next-page" title="Older tests" aria-label="Older tests">›</button>`;
  $('.table-wrap', root).after(pager);
  let sort = store.get('sort:speed', null);
  $('.stats', root).addEventListener('click', (e) => {
    const key = e.target.closest('th[data-sort]')?.dataset.sort;
    if (!key) return;
    sort = nextSort(sort, key);
    store.set('sort:speed', sort);
    page = 0;
    refresh();
  });
  const sizeSel = $('.page-size', pager);
  sizeSel.value = String(pageSize);
  if (!sizeSel.value) { sizeSel.value = '10'; pageSize = 10; }
  sizeSel.addEventListener('change', () => { pageSize = +sizeSel.value; store.set('speed:pagesize', pageSize); page = 0; refresh(); });
  $('.prev-page', pager).addEventListener('click', () => { page = Math.max(0, page - 1); refresh(); });
  $('.next-page', pager).addEventListener('click', () => { page += 1; refresh(); });
  const chips = chipFilter($('.chips', root), 'speed', series, refresh);
  chips.addToggleAll(root);
  const range = rangeControl($('.range', root), 'speed', '7d', refresh);
  panelButton(root, 'Reset view', 'Back to the default time range, with every line on', () => { chips.showAll(); range.reset(); });
  viewSel.addEventListener('change', () => { store.set('speed:view', viewSel.value); page = 0; refresh(); });
  return { root, refresh, isLive: () => range.get()?.live, chart };
}

// ------------------------------------------------------------------ system history panel
function systemPanel() {
  const root = $('#panel-system');
  const chart = lineChart($('canvas', root), { yTitle: '%', y1Title: 'CPU temp °C  ·  CPU load' });
  const series = [
    { id: 'cpu', label: 'CPU %', color: PALETTE[0], unit: '%', axis: 'y' },
    { id: 'mem', label: 'Memory %', color: PALETTE[2], unit: '%', axis: 'y' },
    { id: 'disk', label: 'Storage %', color: PALETTE[4], unit: '%', axis: 'y' },
    { id: 'temp', label: 'CPU temp (°C)', color: PALETTE[3], unit: '°C', axis: 'y1' },
    { id: 'load1', label: 'CPU load (1 min avg)', color: PALETTE[1], unit: '', axis: 'y1' },
    { id: 'rx', label: 'Network down', color: PALETTE[5], unit: 'Mbps', axis: 'y2' },
    { id: 'tx', label: 'Network up', color: PALETTE[6], unit: 'Mbps', axis: 'y2' },
    { id: 'fan', label: 'Fan speed (RPM)', color: PALETTE[8], unit: 'RPM', axis: 'y3' },
    { id: 'fan_pct', label: 'Fan power %', color: PALETTE[8], unit: '%', axis: 'y' },
  ];
  // network traffic gets its own Mbps axis, on the right next to temp and load
  chart.options.scales.y2 = { position: 'right', beginAtZero: true, title: { display: true, text: 'Mbps' }, grid: { drawOnChartArea: false } };
  // fan speed (Linux only, when the machine reports one) is in the thousands, so it gets an RPM axis of its own;
  // fans with no speed sensor report how hard they're driven instead, on the % axis
  chart.options.scales.y3 = { position: 'right', beginAtZero: true, title: { display: true, text: 'RPM' }, grid: { drawOnChartArea: false } };
  const refresh = async () => {
    const r = range.get();
    if (!r) return;
    const d = await api('system/history', { from: r.from.toFixed(0), to: r.to.toFixed(0), points: Math.max(100, Math.min(1000, root.clientWidth)) });
    const sel = chips.selected();
    const shown = series.filter((s) => sel.includes(s.id) && (d.series[s.id] || []).some((p) => p[1] != null));
    chart.options.scales.y2.display = shown.some((s) => s.axis === 'y2');
    chart.options.scales.y3.display = shown.some((s) => s.axis === 'y3');
    chart.data.datasets = shown.map((s) => ({
      label: s.label, unit: s.unit, yAxisID: s.axis, borderColor: s.color, backgroundColor: s.color,
      borderDash: s.axis === 'y1' ? [4, 3] : s.axis === 'y2' ? [1, 2] : s.axis === 'y3' ? [8, 3] : [], spanGaps: false,
      data: d.series[s.id].map((p) => ({ x: p[0], y: p[1] })),
    })).concat(await ispOverlay(root, r, refresh));
    chart.options.scales.y.max = 100;
    setXRange(chart, r);
    chart.update();
  };
  const chips = chipFilter($('.chips', root), 'system', series, refresh);
  chips.addToggleAll(root);
  const range = rangeControl($('.range', root), 'system', '24h', refresh);
  panelButton(root, 'Reset view', 'Back to the default time range, with every line on', () => { chips.showAll(); range.reset(); });
  return { root, refresh, isLive: () => range.get()?.live, chart };
}

// ------------------------------------------------------------------ boot
// Update button (private dashboard only): shown when GitHub has a newer release. Pressing it asks the system's
// update job to run `netbae update`; the page reloads itself once the new version is serving.
// Clicking the version checks GitHub for an update and shows the result on the pill. Clicking it again (within
// 5 minutes) offers to install the update if there is one, otherwise it opens this version's release notes.
function updateHowTo(u) {
  return u.method === 'docker' ? 'Update with: docker compose pull && docker compose up -d'
    : u.method === 'nix' ? 'Update with Nix: nix flake update netbae, then nixos-rebuild switch' : 'Update with: netbae update';
}
function showVersion() {  // the version pill's label and link; dev: a build newer than the latest release
  const v = $('#version');
  v.textContent = `${CONFIG.dev ? 'dev' : 'v'}${CONFIG.version}`;
  v.href = !CONFIG.repo ? '#' : CONFIG.dev ? `${CONFIG.repo}/releases` : `${CONFIG.repo}/releases/tag/v${CONFIG.version}`;
}
function renderUpdate(u) {  // the version pill and the Update button, from an update summary
  const b = $('#update-btn'), v = $('#version');
  if (!u.available) {  // up to date: a tick on the version pill, and when it was last checked
    b.hidden = true;
    if (CONFIG.dev) {
      showVersion();
      v.title = `Dev build: newer than the latest release (${u.latest}, checked ${fmtAgo(u.checked)}). Click to check again, then again for the releases.`;
    } else if (u.latest) {
      showVersion();
      v.textContent += ' ✓';
      v.title = `Up to date: ${u.latest} is the latest release (checked ${fmtAgo(u.checked)}). Click to check again, then again to see what's new.`;
    } else {
      showVersion();
    }
    return;
  }
  showVersion();
  v.title = `netBae ${u.latest} is out. Click to check again, then again to update.`;
  b.hidden = false;
  if (b.disabled) return;  // updating
  if (u.method !== 'button') {
    b.textContent = `v${u.latest} available`;
    b.title = updateHowTo(u);
    return;
  }
  b.textContent = `Update to v${u.latest}`;
  b.title = `Install netBae ${u.latest} now (your config and history are kept).`
    + (u.auto === 'immediately' ? ' It also installs new releases by itself as soon as they\'re found.'
      : u.auto !== 'off' ? ` It also updates itself automatically (${u.auto}, at ${u.auto_time}).` : '');
}
function waitForUpdate() {
  const b = $('#update-btn');
  b.hidden = false; b.disabled = true; b.textContent = 'Updating…';
  const until = Date.now() + 10 * 60000;
  const poll = setInterval(async () => {
    try {
      const c = await fetch('api/config', { cache: 'no-store' }).then((r) => r.json());
      if (c.version !== CONFIG.version) { clearInterval(poll); location.reload(); return; }
    } catch { /* restarting */ }
    if (Date.now() > until) {
      clearInterval(poll);
      const s = await api('update').catch(() => ({ log: [] }));
      b.disabled = false; b.textContent = "Update didn't finish";
      b.title = (s.log || []).join('\n') || 'See update.log in the netBae data folder';
    }
  }, 5000);
}
async function startUpdate() {
  const u = CONFIG.update;
  if (u.method !== 'button') { window.open(u.url, '_blank', 'noopener'); return; }
  const r = await fetch('api/update/run', { method: 'POST' }).then((x) => x.json()).catch(() => ({}));
  if (r.started) waitForUpdate();
  else { const b = $('#update-btn'); b.hidden = false; b.textContent = 'Update failed'; b.title = r.reason || ''; }
}
function setupUpdateButton() {
  const u = CONFIG.update, v = $('#version');
  if (!u || CONFIG.public) return;  // visitors: the version just links to its release
  renderUpdate(u);
  $('#update-btn').addEventListener('click', startUpdate);
  let checkedAt = 0;  // when a click last checked: the next click within 5 minutes acts on that result
  v.addEventListener('click', async (e) => {
    e.preventDefault();
    if ($('#update-btn').disabled || v.dataset.busy) return;  // already updating or checking
    if (Date.now() - checkedAt > 5 * 60000) {  // first click: just check, and show what it found
      const label = v.textContent;
      v.dataset.busy = 1; v.textContent = 'checking…';
      const r = await fetch('api/update/check', { method: 'POST' }).then((x) => x.json()).catch(() => null);
      delete v.dataset.busy; v.textContent = label;
      if (!r || (r.error && !r.latest)) { alert(`Couldn't check for updates${r && r.error ? `: ${r.error}` : ''}`); return; }
      CONFIG.update = Object.assign(u, r); CONFIG.dev = r.dev; renderUpdate(u);
      checkedAt = Date.now();
      const after = v.textContent;
      v.textContent = r.available ? `v${u.latest} available` : r.dev ? 'dev build ✓' : 'up to date ✓';
      setTimeout(() => { if (v.textContent !== 'checking…') v.textContent = after; }, 3000);
      return;
    }
    if (u.available) {
      const how = u.method === 'button' ? 'Your config and history are kept, and the page reloads when it\'s done.'
        : `This install updates outside the dashboard. ${updateHowTo(u)}\n\nOpen the release notes?`;
      if (confirm(`netBae ${u.latest} is available (you have ${CONFIG.version}).\n\n`
        + (u.method === 'button' ? `Update now? ${how}` : how))) startUpdate();
      return;
    }
    // up to date: this version's release notes (the releases page for a dev build), as the link always did
    const w = window.open(v.href, '_blank');  // (with 'noopener' it would always return null)
    if (w) w.opener = null; else location.href = v.href;  // a popup blocker: open it here instead
  });
  if (u.requested) waitForUpdate();  // already running (e.g. the page was reloaded during an update)
}

// header note when any chart is showing past data rather than live
function updatePastBadge() {
  const past = panels.filter((p) => p.isLive() === false).length;
  $('#past-badge').hidden = !past;
  $('#past-badge').textContent = past === 1 ? 'A chart shows past data' : `${past} charts show past data`;
}
document.addEventListener('rangechange', () => { if (typeof panels !== 'undefined') setTimeout(updatePastBadge); });

// ------------------------------------------------------------------ route mix
// How each connection reaches everything netBae traces, from each destination's latest route: on-net, direct
// peering, IX, transit (best to worst). Built from the routes the page already has, so the public dashboard
// gets the same masking. Only the latest routes for now; a history of the split may come later.
const ROUTE_KINDS = [['on-net', 'On-net', 'inside your ISP\'s own network'], ['direct', 'Direct', 'your ISP connects straight to the destination\'s network'],
  ['ix', 'IX', 'handed over at an internet exchange'], ['transit', 'Transit', 'through another carrier, which your ISP usually pays']];
const routeKindOf = (r) => { const k = ROUTE_CLASS[r?.kind] || r?.kind; return ROUTE_KINDS.some(([x]) => x === k) ? k : null; };
let routePick = null;  // {conn, kind}: the destinations listed under a connection's bar
const routeOpen = new Set(store.get('routes:open', []));  // categories expanded in the table

function routeDestinations() {
  const out = [];
  const seen = new Set();
  for (const p of lastPing) {
    const t = CONFIG.ping.targets.find((x) => x.id === p.id);
    if (!t || t.host === 'gateway' || p.id.endsWith('gateway')) continue;  // the router is one hop away
    out.push({ key: p.id, name: p.name + (p.family === 6 && !/IPv6/.test(p.name) ? ' (IPv6)' : ''), cat: p.group, conn: p.connection || null });
    seen.add(p.id);
  }
  if (ROUTES['speedtest:Auto']) out.push({ key: 'speedtest:Auto', name: 'Closest speedtest server', cat: 'Speedtest server', conn: null });
  for (const sv of CONFIG.dns?.enabled ? CONFIG.dns.servers : []) {
    if (sv.lan || sv.host === 'gateway') continue;  // resolvers on your own network aren't traced
    out.push({ key: `dns:${sv.id}`, name: sv.name + (sv.family === 6 ? ' (IPv6)' : ''), cat: 'DNS resolvers', conn: null });
  }
  if (CDN_DATA) {  // every CDN address the resolvers handed out, under its CDN's name
    const label = {};
    for (const c of cdnCols(CDN_DATA.hostnames || [])) for (const h of c.hosts) label[h] = c.label;
    const ips = new Map();
    for (const sv of CDN_DATA.servers || []) {
      for (const [h, al] of Object.entries(sv.results || {})) for (const a of al) if (a.ip && !ips.has(a.ip)) ips.set(a.ip, label[h] || 'CDN');
    }
    for (const [ip, cat] of ips) out.push({ key: `cdn:${ip}`, name: `${cat.replace(/ CDN$/, '')} ${ip}`, cat: `CDN: ${cat.replace(/ CDN$/, '')}`, conn: null });
  }
  return out.map((d) => ({ ...d, route: ROUTES[d.key], kind: routeKindOf(ROUTES[d.key]) }));
}

// the carrier a transit route goes through: the first network after your ISP that isn't the destination
function transitCarrier(r) {
  const mid = (r.path || []).slice(1, -1).filter((p) => !p.ixp);
  return mid.length ? shortNet(mid[0].name) : null;
}

function routeBar(ds, conn, interactive = true) {
  if (!interactive) {
    return routeBar(ds, conn).replace(/<button /g, '<span ').replace(/<\/button>/g, '</span>').replace(/ data-kind="[^"]*"/g, '')
      .replace(/ Click to list them/g, '');
  }
  const n = Object.fromEntries(ROUTE_KINDS.map(([k]) => [k, ds.filter((d) => d.kind === k).length]));
  const total = ROUTE_KINDS.reduce((a, [k]) => a + n[k], 0);
  if (!total) return '<span class="muted small">no routes traced yet</span>';
  const pct = (k) => { const v = (n[k] / total) * 100; return v > 0 && v < 1 ? '<1' : Math.round(v); };
  const tip = (k, label, what) => `${label}: ${n[k]} of ${total} (${pct(k)}%), ${what}. Click to list them`;
  return `<div class="route-bar" role="img" aria-label="${ROUTE_KINDS.map(([k, l]) => `${l} ${pct(k)}%`).join(', ')}">${ROUTE_KINDS.filter(([k]) => n[k]).map(([k, l, w]) =>
    `<button class="seg-${k}" style="flex-grow:${n[k]}" data-conn="${esc(conn)}" data-kind="${k}" title="${esc(tip(k, l, w))}"></button>`).join('')}</div>
    <div class="route-legend">${ROUTE_KINDS.map(([k, l, w]) => `<button data-conn="${esc(conn)}" data-kind="${k}" title="${esc(tip(k, l, w))}"
      class="${routePick?.conn === conn && routePick?.kind === k ? 'on' : ''}"${n[k] ? '' : ' disabled'}><i class="seg-${k}"></i>${l} <b>${n[k]}</b> <span class="muted">${pct(k)}%</span></button>`).join('')}</div>`;
}

// ---- tabs: Now (the split above), Changes (every route change), Compare ISPs (the same destinations on each ISP)
let routeTab = store.get('routes:tab', 'now');
const routeApi = {};  // {changes: {key, ts, data}, compare: {...}}: refetched at most every 5 minutes
async function routeData(name, params = {}) {
  const key = JSON.stringify(params);
  const c = routeApi[name];
  if (c && c.key === key && Date.now() - c.ts < 300000) return c.data;
  const data = await api(`routes/${name}`, params);
  routeApi[name] = { key, ts: Date.now(), data };
  return data;
}
// what a route id is: "Netflix", "Cloudflare (IPv6)", "1.1.1.1 via Secondary", with its category
function routeNames() {
  const m = {};
  for (const d of routeDestinations()) m[d.key] = { name: d.name, cat: d.cat };
  return (id) => {
    const [conn, base] = id.includes('|') ? id.split('|', 2) : [null, id];
    const d = m[id] || m[base] || { name: base.replace(/^(dns|cdn|region|speedtest):/, '').replace('Auto', 'Speedtest server'), cat: '' };
    return conn && !m[id] ? { name: d.name, cat: d.cat, conn } : { ...d, conn: m[id] ? null : conn };
  };
}

function setRouteTab(t) {
  routeTab = t;
  store.set('routes:tab', t);
  const panel = $('#panel-routes');
  panel.querySelectorAll('.route-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  panel.querySelectorAll('[data-route-tab]').forEach((el) => { el.hidden = el.dataset.routeTab !== t; });
  const more = $('.panel-btn', panel);
  if (more) more.hidden = t !== 'now';
  if (t === 'changes') renderRouteChanges();
  if (t === 'compare') renderRouteCompare();
}

const CHANGE_RANGES = [['24h', 86400], ['7d', 604800], ['30d', 2592000], ['All', 0]];
const routeGroupsOpen = new Set();
async function renderRouteChanges() {
  const el = $('#routes-changes');
  const range = store.get('routes:changes:range', '7d');
  const show = store.get('routes:changes:show', 'all');
  const span = CHANGE_RANGES.find(([k]) => k === range)?.[1] ?? 604800;
  const d = await routeData('changes', { from: span ? Math.floor(Date.now() / 1000 - span) : 0 });
  const who = routeNames();
  const rank = { better: 0, worse: 1, path: 2 };
  let list = d.changes.filter((c) => c.target !== 'gateway' && (show === 'all' || c.change === show));
  const count = (xs, k) => xs.filter((c) => c.change === k).length;
  const controls = `<div class="route-tools"><span class="seg">${CHANGE_RANGES.map(([k]) => `<button type="button" data-crange="${k}" class="${k === range ? 'on' : ''}">${k}</button>`).join('')}</span>
    <select data-cshow aria-label="Which changes">${[['all', 'All changes'], ['better', 'Better'], ['worse', 'Worse'], ['path', 'Same kind, other networks']]
      .map(([v, l]) => `<option value="${v}"${v === show ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <span class="muted small">${d.total} change${d.total === 1 ? '' : 's'}${span ? ` in the last ${range}` : ''}: <span class="good">${count(d.changes, 'better')} better</span>,
      <span class="warn">${count(d.changes, 'worse')} worse</span>, ${count(d.changes, 'path')} through other networks</span></div>`;
  // a change of ISP changes most routes at once: one line per switch, which opens into its routes
  const groups = [];
  const single = [];
  for (const c of list) {
    if (!c.isp_change) { single.push(c); continue; }
    const conn = who(c.target).conn || CONFIG.isp?.main_name || 'Main';
    const to = c.after.path[0]?.name || '?';
    const g = groups.find((x) => x.conn === conn && x.to === to && Math.abs(x.ts - c.ts) < 6 * 3600);
    if (g) g.items.push(c); else groups.push({ conn, to, from: c.before.path[0]?.name || '?', ts: c.ts, items: [c] });
  }
  const row = (c) => {
    const n = who(c.target);
    const tag = c.change === 'better' ? '<span class="chg good">better</span>' : c.change === 'worse' ? '<span class="chg warn">worse</span>' : '<span class="chg">other networks</span>';
    return `<tr><td title="${esc(fmtTime(c.ts))}">${fmtAgo(c.ts)}</td>
      <td><button class="route-link" data-route="${esc(c.target)}">${esc(n.name)}</button>${n.conn ? ` <span class="muted small">via ${esc(n.conn)}</span>` : ''}
        <div class="muted small">${esc(n.cat || '')}</div></td>
      <td>${routeParts(c.before, c.target).html}</td><td class="muted">→</td><td>${routeParts(c.after, c.target).html}</td><td>${tag}</td></tr>`;
  };
  const items = [...groups.map((g) => ({ ts: g.ts, g })), ...single.map((c) => ({ ts: c.ts, c }))].sort((a, b) => b.ts - a.ts || rank[a.c?.change] - rank[b.c?.change]);
  const body = items.map(({ g, c }) => {
    if (c) return row(c);
    const key = `${g.conn}|${g.to}|${Math.round(g.ts)}`;
    const open = routeGroupsOpen.has(key);
    return `<tr class="cat-row" data-cgroup="${esc(key)}"><td title="${esc(fmtTime(g.ts))}">${fmtAgo(g.ts)}</td>
      <td colspan="5"><span class="caret">${open ? '▾' : '▸'}</span> <b>${esc(g.conn)} moved from ${esc(g.from)} to ${esc(g.to)}</b>:
        ${g.items.length} routes changed <span class="muted">(${count(g.items, 'better')} better, ${count(g.items, 'worse')} worse)</span></td></tr>`
      + (open ? g.items.map(row).join('') : '');
  }).join('');
  el.innerHTML = controls + (items.length ? `<div class="table-wrap"><table class="stats full route-changes"><thead><tr><th>When</th><th>Destination</th>
    <th>Before</th><th></th><th>After</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`
    : `<p class="muted">No route changes ${span ? `in the last ${range}` : 'yet'}. Routes are traced every ${CONFIG.traceroute?.interval_hours || 12} hours.</p>`);
}

async function renderRouteCompare() {
  const el = $('#routes-compare');
  const d = await routeData('compare');
  const only = store.get('routes:compare:diff', true);
  const who = routeNames();
  const isps = d.isps.filter((e) => Object.values(d.targets).some((t) => t[e.key]));
  if (isps.length < 2) {
    el.innerHTML = '<p class="muted">Nothing to compare yet: this shows up once you\'ve been on more than one ISP, or once a secondary connection has traced its routes.</p>';
    return;
  }
  const label = (e) => `${esc(e.isp)} <span class="muted small">${e.secondary ? esc(e.connection) : e.current ? 'now' : `until ${new Date(e.until * 1000).toLocaleDateString()}`}</span>`;
  const rows = Object.entries(d.targets).filter(([id, t]) => id !== 'gateway' && isps.filter((e) => t[e.key]).length > 1);
  const differs = (t) => new Set(isps.filter((e) => t[e.key]).map((e) => t[e.key].kind)).size > 1;
  const lowest = Object.fromEntries(isps.map((e) => [e.key, 0]));
  for (const [, t] of rows) {
    const p = isps.filter((e) => t[e.key]?.ping != null);
    if (p.length > 1) lowest[p.reduce((a, b) => (t[b.key].ping < t[a.key].ping ? b : a)).key]++;
  }
  const bars = isps.map((e) => {
    const ds = Object.values(d.targets).filter((t) => t[e.key]).map((t) => ({ kind: routeKindOf(t[e.key]) }));
    return `<div class="route-mix"><div class="route-mix-head"><b>${label(e)}</b> <span class="muted small">· ${ds.length} destinations
      · lowest ping on ${lowest[e.key]} of those measured on more than one</span></div>${routeBar(ds, e.key, false)}</div>`;
  }).join('');
  const shown = rows.filter(([, t]) => !only || differs(t)).sort((a, b) => who(a[0]).name.localeCompare(who(b[0]).name));
  const cellOf = (t, e, best) => {
    const r = t[e.key];
    if (!r) return '<td class="muted">-</td>';
    return `<td>${r.ping != null ? `<div class="cmp-ping ${r.ping === best ? 'good' : ''}">${fmtMs(r.ping)} ms${r.ping === best ? ' · lowest' : ''}</div>` : ''}${routeParts(r, '').html}</td>`;
  };
  const table = shown.map(([id, t]) => {
    const pings = isps.map((e) => t[e.key]?.ping).filter((x) => x != null);
    const best = pings.length > 1 ? Math.min(...pings) : null;
    const n = who(id);
    return `<tr><td><button class="route-link" data-route="${esc(id)}">${esc(n.name)}</button><div class="muted small">${esc(n.cat || '')}</div></td>${isps.map((e) => cellOf(t, e, best)).join('')}</tr>`;
  }).join('');
  el.innerHTML = `${bars}<div class="route-tools"><label class="small"><input type="checkbox" data-cdiff${only ? ' checked' : ''}> Only destinations reached differently</label>
    <span class="muted small">${shown.length} of ${rows.length} destinations measured on more than one ISP</span></div>
    <div class="table-wrap route-compare-wrap"><table class="stats full route-compare"><thead><tr><th>Destination</th>${isps.map((e) => `<th>${label(e)}</th>`).join('')}</tr></thead>
    <tbody>${table || `<tr><td colspan="${isps.length + 1}" class="muted">Every destination is reached the same way on each ISP.</td></tr>`}</tbody></table></div>`;
}

// a connection's destinations by category: how each group of them is reached; a row opens into its destinations
function routeCatTable(ds, conn) {
  const cats = [...new Set(ds.map((d) => d.cat))];
  const cell = (n, k) => `<td class="${n ? `rk-${k}` : 'muted'}">${n || '·'}</td>`;
  const rows = cats.map((c) => {
    const cd = ds.filter((d) => d.cat === c);
    const tr = cd.filter((d) => d.kind);
    const n = Object.fromEntries(ROUTE_KINDS.map(([k]) => [k, tr.filter((d) => d.kind === k).length]));
    const open = routeOpen.has(`${conn}|${c}`);
    const mini = tr.length ? `<div class="route-bar mini">${ROUTE_KINDS.filter(([k]) => n[k]).map(([k]) => `<span class="seg-${k}" style="flex-grow:${n[k]}"></span>`).join('')}</div>` : '';
    return `<tr class="cat-row" data-cat="${esc(`${conn}|${c}`)}"><td><span class="caret">${open ? '▾' : '▸'}</span> ${esc(c)} <span class="muted">${cd.length}</span></td>
      <td>${mini}</td>${ROUTE_KINDS.map(([k]) => cell(n[k], k)).join('')}<td class="muted">${cd.length - tr.length || ''}</td></tr>`
      + (open ? `<tr class="route-detail"><td colspan="7"><ul>${cd.sort((a, b) => a.name.localeCompare(b.name)).map((d) =>
        `<li><span class="route-dest">${esc(d.name)}</span> ${d.route ? routeHtml(d.key) : '<span class="muted">not traced yet</span>'}</li>`).join('')}</ul></td></tr>` : '');
  }).join('');
  return `<div class="table-wrap"><table class="stats"><thead><tr><th>Category</th><th></th>${ROUTE_KINDS.map(([, l, w]) => `<th title="${esc(w)}">${l}</th>`).join('')}
    <th title="No route traced yet">Not traced</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderRouteMix() {
  const panel = $('#panel-routes');
  if (!panel) return;
  const all = routeDestinations();
  const traced = all.filter((d) => d.kind);
  panel.hidden = !traced.length;
  if (panel.hidden) return;
  const conns = [null, ...new Set(all.map((d) => d.conn).filter(Boolean))];
  const ispOf = (conn) => {
    const c = conn ? ISP_NOW.find((x) => x.connection === conn) : ISP_NOW[0];
    return c?.last_ok?.isp || null;
  };
  // a DNS resolver that's also a ping target (1.1.1.1) shares its route: it counts once in a connection's total
  const pinged = new Set(all.filter((d) => d.route && !d.key.startsWith('dns:')).map((d) => JSON.stringify(d.route)));
  const unique = (ds) => ds.filter((d) => !(d.key.startsWith('dns:') && d.route && pinged.has(JSON.stringify(d.route))));
  const blocks = conns.map((conn) => {
    const ds = unique(all.filter((d) => d.conn === conn));
    const tr = ds.filter((d) => d.kind);
    const carriers = {};
    for (const d of tr) if (d.kind === 'transit') { const c = transitCarrier(d.route); if (c) carriers[c] = (carriers[c] || 0) + 1; }
    const top = Object.entries(carriers).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const name = conn || CONFIG.isp?.main_name || 'Main';
    const pick = routePick && (routePick.conn || null) === conn
      ? tr.filter((d) => d.kind === routePick.kind).sort((a, b) => a.name.localeCompare(b.name)) : null;
    return `<div class="route-mix">
      <div class="route-mix-head"><b>${esc(name)}</b>${ispOf(conn) ? ` <span class="muted">· ${esc(ispOf(conn))}</span>` : ''}
        <span class="muted small">· ${tr.length} destinations${ds.length > tr.length ? `, ${ds.length - tr.length} not traced yet` : ''}</span></div>
      ${routeBar(tr, conn || '')}
      ${top.length ? `<div class="muted small route-carriers">Transit through: ${top.map(([c, k]) => `${esc(c)} <b>${k}</b>`).join(' · ')}</div>` : ''}
      ${pick ? `<div class="route-pick"><div class="small"><b>${ROUTE_KINDS.find(([k]) => k === routePick.kind)[1]}</b> (${pick.length})
        <button class="link" data-close-pick>close</button></div>
        <ul>${pick.map((d) => `<li><span class="route-dest">${esc(d.name)}</span> <span class="muted small">${esc(d.cat)}</span> ${routeHtml(d.key)}</li>`).join('')}</ul></div>` : ''}
      ${routeCatTable(all.filter((d) => d.conn === conn), conn || '')}
    </div>`;
  });
  $('#routes-body').innerHTML = blocks.join('');
  const isp = ispOf(null);
  $('#routes-note').textContent = `how ${isp || 'your connection'} reaches each destination, from its latest route`;
}

async function refreshAll(force = false) {
  if (document.hidden && !force) return;
  updatePastBadge();
  const jobs = [refreshSummary(), refreshSystem(), refreshSharing(), refreshCdn(), ...panels.filter((p) => force || p.isLive()).map((p) => p.refresh())];
  const res = await Promise.allSettled(jobs);
  renderRouteMix();
  if (routeTab === 'changes') renderRouteChanges().catch(() => {});
  if (routeTab === 'compare') renderRouteCompare().catch(() => {});
  const failed = res.find((r) => r.status === 'rejected');
  if (failed) {
    console.error(failed.reason);
    setStatus(false, Date.now() - lastOk > 60000 ? 'offline - retrying' : 'update failed');
  } else {
    lastOk = Date.now();
    setStatus(true, 'updated ' + new Date().toLocaleTimeString());
  }
}

async function main() {
  try {
    await ensureLibs();
  } catch (e) {
    setStatus(false, 'could not load chart library');
    return;
  }
  themeChartDefaults();
  CONFIG = await api('config');
  // ?expand=Gaming,DNS opens those ping groups (handy for bookmarks and wall displays)
  const expand = new URLSearchParams(location.search).get('expand');
  if (expand) store.set('tiles:open', expand.split(','));

  const v4Targets = CONFIG.ping.targets.filter((t) => t.family !== 6);
  const twins = new Set(CONFIG.ping.targets.filter((t) => t.family === 6).map((t) => t.twin));
  PING_COLORS = groupColors(v4Targets);
  const pingItems = v4Targets.map((t) => ({
    id: t.id, label: t.name, color: PING_COLORS[t.id], group: t.group, v6: twins.has(t.id) ? `${t.id}#v6` : null,
    title: t.method === 'region' ? `${t.name}: fastest Ookla speedtest server (TCP)` : `${t.host}${t.method === 'tcp' ? ` (TCP ${t.port})` : ''}`,
  }));
  panels.push(latencyPanel({
    id: 'panel-ping', endpoint: 'ping', keyParam: 'targets', items: pingItems, defaultRange: '24h', lossLabel: 'Loss', routeKey: (it) => it.key,
    collapse: true, chipRows: true,
  }));
  $('#summary-bar').addEventListener('click', (e) => {
    if (!e.target.closest('#tiles-toggle')) return;
    const groups = [...new Set(lastPing.map((p) => p.group))];
    const open = new Set(store.get('tiles:open', []));
    store.set('tiles:open', groups.every((g) => open.has(g)) ? [] : groups);
    renderTiles();
  });
  $('#ping-tiles').addEventListener('click', (e) => {
    const card = e.target.closest('.group');
    if (!card || e.target.closest('.tile.member')) return;  // anywhere on the card except a host's own tile
    const open = new Set(store.get('tiles:open', []));
    const g = card.dataset.group;
    if (open.has(g)) open.delete(g); else open.add(g);
    store.set('tiles:open', [...open]);
    renderTiles();
  });

  if (CONFIG.dns.enabled) {
    const dnsRoot = $('#panel-dns');
    const domainSel = $('.domain', dnsRoot);
    domainSel.innerHTML += CONFIG.dns.domains.map((d) => `<option>${esc(d)}</option>`).join('');
    domainSel.value = store.get('dns:domain', '');
    const dnsColors = groupColors(CONFIG.dns.servers.map((s) => ({ id: s.id, group: s.name })));
    const dnsItems = CONFIG.dns.servers.map((s) => ({
      // "v4"/"v6" only on resolvers that have both
      id: s.id, label: CONFIG.dns.servers.filter((x) => x.name === s.name).length > 1 ? `${s.name} ${s.family === 6 ? 'v6' : 'v4'}` : s.name,
      color: dnsColors[s.id], title: s.host, group: s.group, cat: s.name,
      // the router and resolvers on your network aren't traced
      local: s.lan || s.host === 'gateway',
    }));
    if (!CONFIG.dns.ipv6_available && CONFIG.dns.servers.some((s) => s.family === 6)) {
      $('#dns-note').textContent = "This network doesn't have IPv6 internet, so the IPv6 resolvers aren't being tested.";
    }
    const p = latencyPanel({
      id: 'panel-dns', endpoint: 'dns', keyParam: 'servers', items: dnsItems, defaultRange: '24h',
      lossLabel: 'Failures', extraParams: () => ({ domain: domainSel.value }),
      collapse: true, catOf: (it) => it.cat, memberNoun: 'addresses',  // a resolver's IPv4 and IPv6 together
      routeKey: (it) => (it && !it.local ? `dns:${it.key}` : null), catRoute: true,
    });
    domainSel.addEventListener('change', () => { store.set('dns:domain', domainSel.value); p.refresh(); });
    panels.push(p);
  } else {
    $('#panel-dns').hidden = true;
  }

  panels.push(speedPanel());
  panels.push(systemPanel());
  for (const [id, label, preview] of [['panel-ping', 'table'], ['panel-dns', 'table'], ['panel-speed', 'table'],
    ['panel-regions', 'servers', true], ['panel-cdn', 'resolvers', true], ['panel-global', 'tests', true],
    ['panel-routes', 'categories', true]]) {
    const root = document.getElementById(id);
    if (root) tableToggle(root, label, preview);
  }
  setRouteTab(routeTab);

  const startTest = async (scope) => {
    const btn = $('#run-speedtest');
    btn.disabled = true; $('#run-regions').disabled = true; $('#run-global').disabled = true; btn.textContent = 'Starting…';
    try {
      const r = await fetch(`api/speedtest/run?scope=${scope}`, { method: 'POST' }).then((x) => x.json());
      btn.textContent = r.started ? 'Running…' : (r.reason || 'Busy');
    } catch { btn.textContent = 'Failed'; }
    // poll a little faster while the test runs
    const poll = setInterval(async () => {
      await refreshSummary().catch(() => {});
      if (!$('#run-speedtest').disabled) { clearInterval(poll); panels.forEach((p) => p.refresh()); }
    }, 4000);
  };
  $('#run-speedtest').addEventListener('click', () => startTest('main'));
  document.addEventListener('click', (e) => {
    // a route link, or anywhere else on a host's tile (its IPv4 route; the IPv6 line has its own link)
    const b = e.target.closest('.route-link');
    const tile = !b && e.target.closest('.tile.member');
    const id = b ? b.dataset.route : tile?.dataset.tileRoute;
    if (id) {
      e.stopPropagation();  // don't also collapse the group card
      const t = CONFIG.ping.targets.find((x) => x.id === id);
      showRoute(id, t ? t.name : id.startsWith('cdn:') ? `CDN server ${id.slice(4)}`
        : id.replace(/^(region|speedtest):/, '').replace('Auto', 'speedtest server'));
    }
    if (e.target.closest('[data-close]')) $('#route-dialog').close();
  }, true);
  $('#route-dialog').addEventListener('click', (e) => { if (e.target.id === 'route-dialog') e.target.close(); });
  $('#panel-routes').addEventListener('change', (e) => {
    if (e.target.matches('[data-cshow]')) { store.set('routes:changes:show', e.target.value); renderRouteChanges(); }
    if (e.target.matches('[data-cdiff]')) { store.set('routes:compare:diff', e.target.checked); renderRouteCompare(); }
  });
  $('#panel-routes').addEventListener('click', (e) => {
    const tab = e.target.closest('.route-tabs button');
    if (tab) return setRouteTab(tab.dataset.tab);
    const cr = e.target.closest('[data-crange]');
    if (cr) { store.set('routes:changes:range', cr.dataset.crange); return renderRouteChanges(); }
    const cg = e.target.closest('[data-cgroup]');
    if (cg) {
      const key = cg.dataset.cgroup;
      if (routeGroupsOpen.has(key)) routeGroupsOpen.delete(key); else routeGroupsOpen.add(key);
      return renderRouteChanges();
    }
    if (e.target.closest('#routes-changes, #routes-compare')) return;
    const k = e.target.closest('[data-kind]');
    if (k) {  // a bar segment or legend entry lists those destinations under the bar
      const pick = { conn: k.dataset.conn, kind: k.dataset.kind };
      routePick = routePick && routePick.conn === pick.conn && routePick.kind === pick.kind ? null : pick;
    } else if (e.target.closest('[data-close-pick]')) {
      routePick = null;
    } else {
      const row = e.target.closest('tr.cat-row');
      if (!row) return;
      const c = row.dataset.cat;
      if (routeOpen.has(c)) routeOpen.delete(c); else routeOpen.add(c);
      store.set('routes:open', [...routeOpen]);
    }
    renderRouteMix();
  });
  $('#region-table').addEventListener('click', (e) => {
    const b = e.target.closest('.run-conn');
    if (b) return startTest(`conn:${encodeURIComponent(b.dataset.conn)}`);
    const key = e.target.closest('th[data-sort]')?.dataset.sort;
    if (!key || !lastSpeedStatus) return;
    regionSort = nextSort(regionSort, key);
    store.set('sort:regions', regionSort);
    renderRegions(lastSpeedStatus);
  });
  // ‹ › scroll the CDN columns one at a time
  $('#cdn-scroll').addEventListener('click', (e) => {
    const dir = +(e.target.closest('button')?.dataset.dir || 0);
    const t = $('#cdn-table');
    if (!dir || !t.rows[0]) return;
    t.parentElement.scrollBy({ left: dir * t.rows[0].cells[CDN_FIXED].offsetWidth, behavior: 'smooth' });
  });
  $('#global-table').addEventListener('click', (e) => {
    const key = e.target.closest('th[data-sort]')?.dataset.sort;
    if (!key || !lastGlobal) return;
    globalSort = nextSort(globalSort, key);
    store.set('sort:global', globalSort);
    renderGlobal(lastGlobal);
  });
  $('#cdn-table').parentElement.addEventListener('scroll', syncCdnScroll);
  window.addEventListener('resize', () => { if (!$('#panel-cdn').hidden) stickCdn(); });
  $('#cdn-table').addEventListener('click', (e) => {
    const key = e.target.closest('th[data-sort]')?.dataset.sort;
    if (key) {
      cdnSort = cdnSort?.key !== key ? { key, dir: 1 } : cdnSort.dir > 0 ? { key, dir: -1 } : null;
      store.set('sort:cdn', cdnSort);
      return renderCdn();
    }
    const c = e.target.closest('.cdn-cell');
    if (c && !e.target.closest('.route-link')) showCdnRoutes(c.dataset.server, c.dataset.host);
  });
  $('#run-cdn').addEventListener('click', async () => {
    const b = $('#run-cdn');
    b.disabled = true; b.textContent = 'Testing…';
    const r = await fetch('api/cdn/run', { method: 'POST' }).then((x) => x.json()).catch(() => ({}));
    if (!r.started) { b.textContent = r.reason || 'Busy'; }
    setTimeout(async () => { await refreshCdn().catch(() => {}); b.disabled = false; b.textContent = 'Test now'; }, 20000);
  });
  $('#run-global').addEventListener('click', () => startTest('global'));
  $('#run-regions').addEventListener('click', () => startTest('regions'));

  const sp = CONFIG.speedtest;
  if (CONFIG.repo) $('#repo-link').href = CONFIG.repo;
  showVersion();
  setupUpdateButton();
  $('#docker-note').hidden = !CONFIG.docker_bridge || !!CONFIG.public;
  $('#public-badge').hidden = !CONFIG.public;
  const acc = $('#access-link');  // one hostname for both dashboards, with Cloudflare Access sign-in
  if (CONFIG.public && CONFIG.sign_in) Object.assign(acc, { hidden: false, href: 'login', textContent: 'Sign in', title: 'Sign in with Cloudflare Access to see the private dashboard' });
  else if (CONFIG.signed_in) Object.assign(acc, { hidden: false, href: 'logout', textContent: 'Sign out', title: `Signed in as ${CONFIG.signed_in} with Cloudflare Access` });
  $('#footer').innerHTML = `<a href="${esc(CONFIG.repo || '#')}" target="_blank" rel="noopener">netBae ${CONFIG.dev ? 'dev' : 'v'}${esc(CONFIG.version)}</a> by `
    + '<a href="https://github.com/jchin14" target="_blank" rel="noopener">jchin14</a> · '
    + '<a href="https://buymeacoffee.com/jchin14" target="_blank" rel="noopener">buy me a coffee</a> · '
    + `${scheduleText()} · `
    + 'tip: double-click a chip to show only that series'
    + '<div class="disclaimer">netBae isn\'t affiliated with or endorsed by any internet provider, carrier or service shown here. Names and logos belong to their owners.</div>';

  await refreshAll(true);
  setInterval(refreshAll, CONFIG.public ? REFRESH_MS * 2 : REFRESH_MS);  // public: go easy on the server
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (store.get('theme', 'auto') === 'auto') location.reload(); });
}

// ------------------------------------------------------------------ theme switch
// Auto (follow the device) -> Light -> Dark. index.html applies the saved choice before the page paints.
const THEMES = {
  auto: ['Auto', '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'],
  light: ['Light', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
  dark: ['Dark', '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'],
};
function themeToggle() {
  const btn = $('#theme-toggle');
  const cur = THEMES[store.get('theme', 'auto')] ? store.get('theme', 'auto') : 'auto';
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${THEMES[cur][1]}</svg><span>${THEMES[cur][0]}</span>`;
  btn.title = 'Theme: ' + THEMES[cur][0].toLowerCase() + ' (click to change)';
  btn.addEventListener('click', () => {
    const keys = Object.keys(THEMES);
    store.set('theme', keys[(keys.indexOf(cur) + 1) % keys.length]);
    location.reload();  // charts take their colours from the theme when they're created
  });
}
themeToggle();

main();
