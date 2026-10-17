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
  ['7d', 604800], ['30d', 2592000], ['90d', 7776000], ['1y', 31536000], ['custom', null],
];
const REFRESH_MS = 15000;

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
const fmtMbps = (v) => (v == null ? '-' : v >= 100 ? Math.round(v).toString() : v.toFixed(1));
function fmtBytes(b) {
  if (b == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
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
  const saved = store.get(`range:${key}`, { r: defaultRange });
  el.innerHTML = `
    <select aria-label="Time range">${RANGES.map(([k]) => `<option value="${k}">${k === 'custom' ? 'Custom…' : 'Last ' + k}</option>`).join('')}</select>
    <span class="custom" hidden>
      <input type="datetime-local" class="from" aria-label="From">
      <input type="datetime-local" class="to" aria-label="To">
      <button class="btn ghost apply">Apply</button>
    </span>`;
  const sel = $('select', el), custom = $('.custom', el), from = $('.from', el), to = $('.to', el);
  sel.value = saved.r;
  const now = Date.now() / 1000;
  from.value = toLocalInput(saved.from || now - 86400);
  to.value = toLocalInput(saved.to || now);
  custom.hidden = sel.value !== 'custom';

  const persist = () => store.set(`range:${key}`, {
    r: sel.value, from: new Date(from.value).getTime() / 1000, to: new Date(to.value).getTime() / 1000,
  });
  sel.addEventListener('change', () => {
    custom.hidden = sel.value !== 'custom';
    persist();
    if (sel.value !== 'custom') onChange();
  });
  $('.apply', el).addEventListener('click', () => { persist(); onChange(); });

  return {
    get() {
      if (sel.value === 'custom') {
        const f = new Date(from.value).getTime() / 1000, t = new Date(to.value).getTime() / 1000;
        if (!(f < t)) return null;
        return { from: f, to: t, live: false };
      }
      const span = RANGES.find(([k]) => k === sel.value)[1];
      const t = Date.now() / 1000;
      return { from: t - span, to: t, live: true };
    },
  };
}

// Toggle chips, grouped by item.group with a clickable group label that toggles the whole group.
function chipFilter(el, key, items, onChange, defaultOff = []) {
  const off = new Set(store.get(`off:${key}`, null) ?? defaultOff);
  const sync = () => {
    el.querySelectorAll('.chip').forEach((c) => c.classList.toggle('off', off.has(c.dataset.id)));
    el.querySelectorAll('.group-label').forEach((b) => b.classList.toggle('off',
      items.filter((x) => x.group === b.dataset.group).every((x) => off.has(x.id))));
  };
  const changed = () => { sync(); store.set(`off:${key}`, [...off]); onChange(); };
  el.innerHTML = '';
  const groups = [...new Set(items.map((it) => it.group ?? ''))];
  for (const g of groups) {
    const wrap = document.createElement('span');
    wrap.className = 'chip-group';
    const members = items.filter((it) => (it.group ?? '') === g);
    if (g && groups.length > 1) {
      const label = document.createElement('button');
      label.className = 'group-label';
      label.dataset.group = g;
      label.textContent = g;
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
    el.appendChild(wrap);
  }
  sync();
  return { selected: () => items.filter((i) => !off.has(i.id)).map((i) => i.id) };
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

function lineChart(canvas, { yTitle, y1Title, yMax } = {}) {
  const scales = {
    x: { type: 'time', ticks: { maxRotation: 0, autoSkipPadding: 18 }, grid: { color: css('--grid') } },
    y: { beginAtZero: true, max: yMax, title: { display: !!yTitle, text: yTitle }, grid: { color: css('--grid') } },
  };
  if (y1Title) scales.y1 = { position: 'right', beginAtZero: true, title: { display: true, text: y1Title }, grid: { drawOnChartArea: false } };
  scales.yIsp = { display: false, min: 0, max: 1 }; // ISP markers ride along the top of the chart
  return new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
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

// The x-axis spans the chosen range, but when the data only fills a small part of it (a new install,
// a target added recently) it zooms to the data, padded a little, so the points aren't squashed at one edge.
function setXRange(chart, r) {
  let min = r.from * 1000, max = r.to * 1000;
  let lo = Infinity, hi = -Infinity;
  for (const ds of chart.data.datasets) {
    if (ds.role === 'isp') continue;
    for (const p of ds.data) if (p.y != null) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }
  }
  if (lo <= hi && hi - lo < (max - min) / 2) {
    const pad = Math.max((hi - lo) * 0.05, 5 * 60e3);  // at least 5 minutes either side
    min = Math.max(min, lo - pad);
    max = Math.min(max, hi + pad);
  }
  chart.options.scales.x.min = min;
  chart.options.scales.x.max = max;
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

// group: red if most members are bad, amber if any member has a problem
function groupStatus(members) {
  const st = members.map(tileStatus).filter(Boolean);
  if (!st.length) return '';
  if (st.filter((x) => x === 'bad').length > st.length / 2) return 'bad';
  return st.some((x) => x !== 'good') ? 'warn' : 'good';
}

const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
let lastPing = [];
let ROUTES = {};

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
function routeHtml(id) {
  const r = ROUTES[id];
  if (!r) return '<span class="muted">route not traced yet</span>';
  const names = r.path.map((p) => p.name);
  const mid = r.path.slice(1, -1).filter((p) => !p.ixp).map((p) => p.name);
  const ixs = r.path.filter((p) => p.ixp).map((p) => p.name);
  const dest = names[names.length - 1];
  const kind = ROUTE_CLASS[r.kind] || r.kind;
  const text = kind === 'transit' ? `via ${mid.join(', ')}${ixs.length ? ` (${ixs[0]})` : ''}`
    : kind === 'on-net' ? `inside ${names[0] || 'your ISP'}`
      : kind === 'ix' ? `via ${ixs[0] || 'an exchange'}${mid.length ? `, then ${mid.join(', ')},` : ''} to ${dest}`
        : kind === 'direct' ? `direct to ${dest}` : names.join(' → ');
  const rel = kind === 'on-net' ? null : firstRel(r.path);
  const cls = kind;
  return `<button class="route-link" data-route="${esc(id)}" title="${esc(names.join(' → '))}${rel ? ` · ${rel}` : ''} · traced ${fmtAgo(r.ts)} · click for hops">`
    + `<span class="route-badge route-${cls}">${ROUTE_BADGE[r.kind] || r.kind}</span> ${esc(text)}${rel ? ` <span class="muted">· ${rel}</span>` : ''}</button>`;
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

async function showRoute(id, title) {
  const d = await api('traceroute', { target: id });
  const r = d.latest;
  const dlg = $('#route-dialog');
  const hops = (r?.hops || []).map((h) => `<tr><td>${h.hop}</td><td style="text-align:left">${h.ip
      ? `${h.host ? `<div class="hop-host">${esc(h.host)}</div>` : ''}<div class="muted">${esc(h.ip)}</div>` : '<span class="muted">* no reply</span>'}</td>
    <td>${h.rtt == null ? '-' : fmtMs(h.rtt)}</td><td style="text-align:left">${h.ix ? `<span class="route-badge route-ix">IX</span> ${esc(h.ix)}` : h.asn ? `${esc(h.name)} <span class="muted">AS${h.asn}</span>` : '<span class="muted">private / unknown</span>'}</td></tr>`).join('');
  const hist = d.history.slice(0, 10).map((x) => `<li>${fmtTime(x.ts)}: ${x.error ? `<span class="error-text">${esc(x.error)}</span>`
    : `<b>${esc(ROUTE_BADGE[x.kind] || x.kind)}</b> ${esc(x.path.map((p) => p.name).join(' → '))}`}</li>`).join('');
  dlg.innerHTML = `<div class="dlg-head"><h2>Route to ${esc(title)}</h2><button class="link" data-close>Close</button></div>
    ${r ? `<p><span class="route-badge route-${ROUTE_CLASS[r.kind] || r.kind}">${esc(ROUTE_BADGE[r.kind] || r.kind || '?')}</span>
      ${pathHtml(r.path)}</p>
      <p class="muted small">Destination ${esc(r.dest_host && r.dest_host !== r.dest ? `${r.dest_host} (${r.dest})` : (r.dest || ''))} · traced ${fmtAgo(r.ts)} · networks from Team Cymru's IP-to-ASN data, hostnames from reverse DNS${d.rel_source ? `, who pays whom from CAIDA's AS relationships (${esc(d.rel_source)})` : ''}</p>
      <div class="table-wrap"><table class="stats"><thead><tr><th>#</th><th style="text-align:left">Hop (hostname / IP)</th><th>ms</th><th style="text-align:left">Network</th></tr></thead><tbody>${hops}</tbody></table></div>
      <h3 class="small">Recent routes</h3><ul class="route-hist">${hist}</ul>` : '<p class="muted">Not traced yet. Routes are traced every 12 hours, and right after netBae starts for any target without one.</p>'}`;
  dlg.showModal();
}

function memberTile(p, color) {
  const how = p.method === 'region' ? 'TCP to the fastest Ookla server' : p.method.toUpperCase();
  return `
    <div class="tile member" title="${esc(p.host || 'looking up server…')} · ${how}">
      <div class="name"><span class="dot ${tileStatus(p)}"></span><span>${flag(p.flag)}${esc(p.name)}</span><i class="swatch" style="background:${color}"></i></div>
      ${p.where ? `<div class="where">${esc(p.where)}</div>` : ''}
      <div class="value">${p.last == null ? (p.last_ts ? '<span style="color:var(--bad)">timeout</span>' : '-') : fmtMs(p.last) + '<small>ms</small>'}</div>
      <div class="host">avg ${fmtMs(p.avg5m)} · loss ${fmtPct(p.loss5m)}</div>
      <div class="route">${routeHtml(p.id)}</div>
    </div>`;
}

// One card per group showing the group's average; click to expand into per-host tiles.
function renderTiles() {
  const open = new Set(store.get('tiles:open', []));
  const groups = [...new Set(lastPing.map((p) => p.group))];
  $('#ping-tiles').innerHTML = groups.map((g) => {
    const members = lastPing.filter((p) => p.group === g);
    const status = groupStatus(members);
    const avg = mean(members.map((p) => p.avg5m)); // members' 5-minute averages (spikes trimmed)
    const now = mean(members.map((p) => p.last));
    const down = members.filter((p) => p.last == null && p.last_ts != null).length;
    const isOpen = open.has(g);
    return `
      <div class="card tile group${isOpen ? ' open' : ''}" data-group="${esc(g)}">
        <button class="group-head" aria-expanded="${isOpen}">
          <span class="dot ${status}"></span><span class="gname">${esc(g)}</span>
          <span class="count">${members.length}</span><span class="chev">▾</span>
        </button>
        <div class="value">${avg == null ? '-' : fmtMs(avg) + '<small>ms avg</small>'}</div>
        <div class="host">now ${fmtMs(now)} · loss ${fmtPct(mean(members.map((p) => p.loss5m)))}${down ? ` · <span style="color:var(--bad)">${down} down</span>` : ''}</div>
        ${isOpen ? `<div class="members">${members.map((p) => memberTile(p, PING_COLORS[p.id])).join('')}</div>` : ''}
      </div>`;
  }).join('');
}

async function refreshSummary() {
  const s = await api('summary');
  lastPing = s.ping;
  ROUTES = s.routes || {};
  $('#isp-now').innerHTML = (s.isp || []).map((c) => {
    const x = c.last_ok;
    const failing = c.latest && c.latest.error;
    return x ? `<span title="${esc(x.asn || '')} · checked ${fmtAgo(x.ts)}${failing ? ' · latest check failed' : ''}">${esc(c.connection)}: <b>${esc(x.isp || '?')}</b> ${esc(x.ip || '')}</span>`
      : failing ? `<span>${esc(c.connection)}: <span class="error-text">no internet</span></span>` : '';
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
  if (CONFIG.speedtest.enabled && CONFIG.speedtest.next_run) meta += `<div>Next scheduled run: ${hm(CONFIG.speedtest.next_run)}${CONFIG.speedtest.next_regions_run ? ` · regions: ${hm(CONFIG.speedtest.next_regions_run)}` : ''}</div>`;
  if (!CONFIG.speedtest.enabled) meta += '<div>Speedtests are disabled in the config.</div>';
  $('#speed-meta').innerHTML = meta;

  const regions = st.regions || [];
  const conns = st.connections || [];
  $('#region-table').hidden = !regions.length && !conns.length;
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
        <tr><th>Test</th><th style="text-align:left">ISP</th><th>Down</th><th>Up</th><th>Ping</th><th>Jitter</th><th>Loss</th>
            <th>Avg down</th><th>Avg up</th><th>Avg ping</th><th>Data</th><th>Tested</th><th style="text-align:left">Route</th><th></th></tr>
      </thead>
      <tbody>
        ${row('<b>Closest server</b>', ok, st.averages?.['7d'], 'strong', '', 'speedtest:Auto')}
        ${conns.map((x) => row(`<b>${esc(x.name)}</b>`, x.ts != null && x.error && x.last_ok ? x.last_ok : x, x.avg7d, 'strong',
          CONFIG.speedtest.enabled && !CONFIG.public ? `<button class="link run-conn" data-conn="${esc(x.name)}">Run</button>` : '')).join('')}
        ${regions.map((x) => row(`${flag(x.flag)}${esc(x.name)}`, x, x.avg7d, '', '', `region:${x.name}`)).join('')}
        ${regions.length ? `<tr class="strong total"><td><b>All regions</b></td><td colspan="6" class="muted" style="text-align:left">${st.regions_avg?.['7d']?.tests ?? 0} tests in 7 days</td>${avgCells(st.regions_avg?.['7d'])}<td></td><td></td><td></td></tr>` : ''}
      </tbody>`;
  }

  const running = st.status.running;
  const btn = $('#run-speedtest');
  btn.hidden = !!CONFIG.public;  // the public dashboard is read-only
  btn.disabled = !CONFIG.speedtest.enabled || running;
  btn.textContent = running ? `Running ${st.status.label && st.status.label !== 'Auto' ? st.status.label : ''}…`.replace(' …', '…') : 'Run now';
  const rbtn = $('#run-regions');
  rbtn.hidden = !CONFIG.speedtest.enabled || !CONFIG.speedtest.regions.length || !!CONFIG.public;
  rbtn.disabled = running;
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
  const visitors = `<span title="${d.visitors_24h} in the last 24 hours">${d.visitors_1h} visitor${d.visitors_1h === 1 ? '' : 's'} in the last hour</span>`;
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
    ['Load', s.load ? s.load.map((l) => l.toFixed(2)).join('  ') : '-', '1 · 5 · 15 min'],
    ['CPU', fmtPct(s.cpu), bar(s.cpu)],
    ['Memory', s.mem ? fmtPct(s.mem.percent) : '-', s.mem ? `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}${bar(s.mem.percent)}` : ''],
    ['Storage', s.disk ? fmtPct(s.disk.percent) : '-', s.disk ? `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)} (${esc(s.disk.path)})${bar(s.disk.percent)}` : ''],
  ];
  if (s.temp != null) items.push(['Temperature', `${s.temp.toFixed(1)} °C`, bar(s.temp)]);
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
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v);
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
    // values: the numbers the axis should fit (average lines); floor: minimum axis max
    fit(values, floor = 1) {
      const v = values.filter((x) => x != null).sort((a, b) => a - b);
      auto = v.length ? niceCeil(Math.max(floor, v[Math.floor((v.length - 1) * 0.98)] * 1.35)) : undefined;
      apply();
    },
  };
}

// ------------------------------------------------------------------ ISP markers
// Each connection's ISP checks are drawn as a row of markers along the top of the time charts:
// one colour per connection, one shape per ISP, so a failover shows up next to the latency it caused.
const ISP_SHAPES = [['circle', '●'], ['triangle', '▲'], ['rect', '■'], ['rectRot', '◆'], ['star', '★'], ['crossRot', '✕']];
const ISP_COLORS = ['#fbbf24', '#22d3ee', '#f472b6', '#a3e635', '#c084fc'];
const ispShapeIndex = {};
const ispShape = (isp) => {
  if (!(isp in ispShapeIndex)) ispShapeIndex[isp] = Object.keys(ispShapeIndex).length;
  return ISP_SHAPES[ispShapeIndex[isp] % ISP_SHAPES.length];
};
const ispLabel = (ctx) => ` ${ctx.raw.conn} ISP: ${ctx.raw.isp}${ctx.raw.ip ? ` · ${ctx.raw.ip}` : ''}${ctx.raw.changed ? '  (changed)' : ''}`;

async function ispOverlay(root, r, onToggle) {
  if (!CONFIG.isp?.enabled) return [];
  let legend = $('.isp-legend', root);
  if (!legend) {
    legend = document.createElement('div');
    legend.className = 'isp-legend';
    $('.chips', root).after(legend);
    legend.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-key]');
      if (!b) return;
      const off = new Set(store.get('isp:off', []));
      if (off.has(b.dataset.key)) off.delete(b.dataset.key); else off.add(b.dataset.key);
      store.set('isp:off', [...off]);
      onToggle();
    });
  }
  // routine checks ~14px apart; ISP/IP changes are always included and drawn larger
  const d = await api('isp', { from: r.from.toFixed(0), to: r.to.toFixed(0), points: Math.max(30, Math.round(root.clientWidth / 14)) });
  const off = new Set(store.get('isp:off', []));
  const datasets = [];
  const buttons = [];
  CONFIG.isp.connections.forEach((conn, ci) => {
    const pts = d.series[conn] || [];
    const color = ISP_COLORS[ci % ISP_COLORS.length];
    for (const isp of [...new Set(pts.map((p) => p[1]).filter(Boolean))]) {
      const [style, glyph] = ispShape(isp);
      const key = `${conn}|${isp}`;
      buttons.push(`<button data-key="${esc(key)}" class="${off.has(key) ? 'off' : ''}" title="Show or hide ${esc(conn)} ISP checks">
        <span style="color:${color}">${glyph}</span>${esc(conn)}: ${esc(isp)}</button>`);
      if (off.has(key)) continue;
      datasets.push({
        role: 'isp', label: `${conn} ISP`, yAxisID: 'yIsp', showLine: false,
        pointStyle: style, pointRadius: (c) => (c.raw?.changed ? 7 : 3.5), pointHoverRadius: 8, pointHitRadius: 8,
        borderColor: color, backgroundColor: color + 'cc', borderWidth: 1,
        data: pts.filter((p) => p[1] === isp).map((p) => ({ x: p[0], y: 0.965 - ci * 0.06, isp: p[1], ip: p[2], conn, changed: p[4] })),
      });
    }
  });
  legend.innerHTML = buttons.length ? `<span class="isp-title" title="Each marker along the top of the chart is an ISP check: colour = connection, shape = ISP. A bigger marker means the ISP or IP changed.">ISP checks</span>${buttons.join('')}` : '';
  return datasets;
}

function latencyPanel({ id, endpoint, keyParam, items, defaultRange, extraParams, lossLabel, defaultOff = [] }) {
  const root = $(`#${id}`);
  const metricSel = $('.metric', root);
  const bandSel = $('.band', root);
  metricSel.value = store.get(`metric:${id}`, 'latency');
  if (!metricSel.value) metricSel.value = 'latency';
  bandSel.value = store.get(`band:${id}`, 'pct');
  const chart = lineChart($('canvas', root), { yTitle: 'ms' });
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

  const refresh = async () => {
    const r = range.get();
    if (!r) return;
    const sel = chips.selected();
    const metric = metricSel.value;
    const band = bandSel.value;
    bandSel.hidden = metric === 'loss';
    // ~1 point per 6px so each bucket holds several samples and the spread band means something
    const points = Math.max(60, Math.min(300, Math.round(root.clientWidth / 6)));
    const params = { from: r.from.toFixed(0), to: r.to.toFixed(0), points, ...(extraParams ? extraParams() : {}) };
    params[keyParam] = sel.join(',') || '__none__';
    const d = await api(endpoint, params);
    // point layout: [t, avg, min, max, loss%, p5, p95]
    const [loI, hiI, bandName] = band === 'minmax' ? [2, 3, 'min–max'] : [5, 6, 'p5–p95'];
    chart.options.scales.y.title.text = metric === 'loss' ? '%' : 'ms';

    const datasets = [];
    for (const it of items.filter((x) => sel.includes(x.id))) {
      const pts = d.series[it.id] || [];
      if (metric === 'loss') {
        datasets.push({
          label: it.label, unit: '%', borderColor: it.color, backgroundColor: it.color,
          stepped: 'middle', spanGaps: false, data: pts.map((p) => ({ x: p[0], y: p[4] })),
        });
        continue;
      }
      if (band !== 'none') {
        const edge = { role: 'band', label: it.label, borderColor: it.color + '73', borderWidth: 1, borderDash: [4, 3], spanGaps: false, pointHoverRadius: 0, pointHitRadius: 0 };
        // upper edge fills down to the lower edge (the next dataset)
        datasets.push({ ...edge, fill: '+1', backgroundColor: it.color + '1f', data: pts.map((p) => ({ x: p[0], y: p[hiI] })) });
        datasets.push({ ...edge, fill: false, data: pts.map((p) => ({ x: p[0], y: p[loI] })) });
      }
      datasets.push({
        role: 'avg', label: it.label, unit: 'ms', borderColor: it.color, backgroundColor: it.color, borderWidth: 2, spanGaps: false,
        data: pts.map((p) => ({ x: p[0], y: p[1], lo: band === 'none' ? null : p[loI], hi: p[hiI], bandName })),
      });
    }
    zoom.fit(datasets.filter((ds) => ds.role !== 'band').flatMap((ds) => ds.data.map((p) => p.y)), metric === 'loss' ? 5 : 1);
    chart.data.datasets = datasets.concat(await ispOverlay(root, r, refresh));
    setXRange(chart, r);
    chart.update();

    const rows = items.filter((it) => sel.includes(it.id)).map((it) => {
      const s = d.stats[it.id] || {};
      return `<tr><td><span class="dot" style="background:${it.color}"></span> ${esc(it.label)}</td>
        <td><b>${fmtMs(s.avg)}</b></td><td>${fmtMs(s.min)}</td><td>${fmtMs(s.p5)}</td><td>${fmtMs(s.p95)}</td><td>${fmtMs(s.max)}</td>
        <td>${fmtPct(s.loss, 2)}</td><td>${(s.samples ?? 0).toLocaleString()}</td>${endpoint === 'ping' ? `<td style="text-align:left">${routeHtml(it.id)}</td>` : ''}</tr>`;
    }).join('');
    $('.stats', root).innerHTML = `<thead><tr><th>Host</th><th>Avg ms</th><th>Min</th><th>P5</th><th>P95</th><th>Max</th><th>${lossLabel}</th><th>Samples</th>${endpoint === 'ping' ? '<th style="text-align:left">Route</th>' : ''}</tr></thead><tbody>${rows}</tbody>`;
    return r.live;
  };
  const chips = chipFilter($('.chips', root), id, items, refresh, defaultOff);
  const range = rangeControl($('.range', root), id, defaultRange, refresh);
  metricSel.addEventListener('change', () => { store.set(`metric:${id}`, metricSel.value); refresh(); });
  bandSel.addEventListener('change', () => { store.set(`band:${id}`, bandSel.value); refresh(); });
  return { root, refresh, isLive: () => range.get()?.live, chart };
}

// ------------------------------------------------------------------ speedtest panel
const flagChar = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) + ' ' : '');
const testName = (label) => (label === 'Auto' ? 'Closest server' : flag(CONFIG.speedtest.flags?.[label]) + esc(label));

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
    chart.data.datasets = chart.data.datasets.concat(await ispOverlay(root, r, refresh));
    setXRange(chart, r);
    chart.update();

    const avg = (k) => (ok.length ? ok.reduce((a, x) => a + (x[k] || 0), 0) / ok.length : null);
    const recent = rows.slice(-15).reverse();
    $('.stats', root).innerHTML = `
      <thead><tr><th>Time</th><th>Test</th><th>Down Mbps</th><th>Up Mbps</th><th>Ping ms</th><th>Jitter ms</th><th>Loss</th><th>Data</th><th>ISP</th><th>Server</th><th></th></tr></thead>
      <tbody>
        <tr><td><b>Average (${ok.length} tests)</b></td><td></td><td><b>${fmtMbps(avg('download_mbps'))}</b></td><td><b>${fmtMbps(avg('upload_mbps'))}</b></td>
          <td><b>${fmtMs(avg('ping_ms'))}</b></td><td><b>${fmtMs(avg('jitter_ms'))}</b></td><td></td><td><b>${fmtBytes(ok.reduce((a, x) => a + (x.data_bytes || 0), 0))}</b></td><td></td><td></td><td></td></tr>
        ${recent.map((x) => x.error
          ? `<tr><td>${fmtTime(x.ts)}</td><td>${testName(x.label)}</td><td colspan="9" class="error-text" style="text-align:left">${esc(x.error)}</td></tr>`
          : `<tr><td>${fmtTime(x.ts)}</td><td>${testName(x.label)}</td><td>${fmtMbps(x.download_mbps)}</td><td>${fmtMbps(x.upload_mbps)}</td><td>${fmtMs(x.ping_ms)}</td>
             <td>${fmtMs(x.jitter_ms)}</td><td>${x.packet_loss == null ? '-' : fmtPct(x.packet_loss)}</td><td>${fmtBytes(x.data_bytes)}</td>
             <td style="text-align:left">${esc(x.isp || '')}</td>
             <td style="text-align:left">${esc(x.server_name)}${x.server_location ? ', ' + esc(x.server_location) : ''}</td>
             <td>${x.result_url ? `<a href="${esc(x.result_url)}" target="_blank" rel="noopener">result ↗</a>` : ''}</td></tr>`).join('')}
      </tbody>`;
  };
  const chips = chipFilter($('.chips', root), 'speed', series, refresh);
  const range = rangeControl($('.range', root), 'speed', '7d', refresh);
  viewSel.addEventListener('change', () => { store.set('speed:view', viewSel.value); refresh(); });
  return { root, refresh, isLive: () => range.get()?.live, chart };
}

// ------------------------------------------------------------------ system history panel
function systemPanel() {
  const root = $('#panel-system');
  const chart = lineChart($('canvas', root), { yTitle: '%', y1Title: '°C / load' });
  const series = [
    { id: 'cpu', label: 'CPU %', color: PALETTE[0], unit: '%', axis: 'y' },
    { id: 'mem', label: 'Memory %', color: PALETTE[2], unit: '%', axis: 'y' },
    { id: 'disk', label: 'Storage %', color: PALETTE[4], unit: '%', axis: 'y' },
    { id: 'temp', label: 'Temp °C', color: PALETTE[3], unit: '°C', axis: 'y1' },
    { id: 'load1', label: 'Load (1m)', color: PALETTE[1], unit: '', axis: 'y1' },
  ];
  const refresh = async () => {
    const r = range.get();
    if (!r) return;
    const d = await api('system/history', { from: r.from.toFixed(0), to: r.to.toFixed(0), points: Math.max(100, Math.min(1000, root.clientWidth)) });
    const sel = chips.selected();
    chart.data.datasets = series.filter((s) => sel.includes(s.id) && d.series[s.id].some((p) => p[1] != null)).map((s) => ({
      label: s.label, unit: s.unit, yAxisID: s.axis, borderColor: s.color, backgroundColor: s.color,
      borderDash: s.axis === 'y1' ? [4, 3] : [], spanGaps: false,
      data: d.series[s.id].map((p) => ({ x: p[0], y: p[1] })),
    }));
    chart.options.scales.y.max = 100;
    setXRange(chart, r);
    chart.update();
  };
  const chips = chipFilter($('.chips', root), 'system', series, refresh);
  const range = rangeControl($('.range', root), 'system', '24h', refresh);
  return { root, refresh, isLive: () => range.get()?.live, chart };
}

// ------------------------------------------------------------------ boot
async function refreshAll(force = false) {
  if (document.hidden && !force) return;
  const jobs = [refreshSummary(), refreshSystem(), refreshSharing(), ...panels.filter((p) => force || p.isLive()).map((p) => p.refresh())];
  const res = await Promise.allSettled(jobs);
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

  PING_COLORS = groupColors(CONFIG.ping.targets);
  const pingItems = CONFIG.ping.targets.map((t) => ({
    id: t.id, label: t.name, color: PING_COLORS[t.id], group: t.group,
    title: t.method === 'region' ? `${t.name}: fastest Ookla speedtest server (TCP)` : `${t.host}${t.method === 'tcp' ? ` (TCP ${t.port})` : ''}`,
  }));
  panels.push(latencyPanel({
    id: 'panel-ping', endpoint: 'ping', keyParam: 'targets', items: pingItems, defaultRange: '1h', lossLabel: 'Loss',
    defaultOff: CONFIG.ping.targets.filter((t) => t.method === 'region').map((t) => t.id),
  }));
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
      id: s.id, label: s.family === 6 ? `${s.name} v6` : s.name, color: dnsColors[s.id], title: s.host, group: s.group,
    }));
    if (!CONFIG.dns.ipv6_available && CONFIG.dns.servers.some((s) => s.family === 6)) {
      $('#dns-note').textContent = "This network doesn't have IPv6 internet, so the IPv6 resolvers aren't being tested.";
    }
    const p = latencyPanel({
      id: 'panel-dns', endpoint: 'dns', keyParam: 'servers', items: dnsItems, defaultRange: '6h',
      lossLabel: 'Failures', extraParams: () => ({ domain: domainSel.value }),
    });
    domainSel.addEventListener('change', () => { store.set('dns:domain', domainSel.value); p.refresh(); });
    panels.push(p);
  } else {
    $('#panel-dns').hidden = true;
  }

  panels.push(speedPanel());
  panels.push(systemPanel());

  const startTest = async (scope) => {
    const btn = $('#run-speedtest');
    btn.disabled = true; $('#run-regions').disabled = true; btn.textContent = 'Starting…';
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
    const b = e.target.closest('.route-link');
    if (b) {
      e.stopPropagation();  // don't also collapse the group card
      const t = CONFIG.ping.targets.find((x) => x.id === b.dataset.route);
      showRoute(b.dataset.route, t ? t.name : b.dataset.route.replace(/^(region|speedtest):/, '').replace('Auto', 'speedtest server'));
    }
    if (e.target.closest('[data-close]')) $('#route-dialog').close();
  }, true);
  $('#route-dialog').addEventListener('click', (e) => { if (e.target.id === 'route-dialog') e.target.close(); });
  $('#region-table').addEventListener('click', (e) => {
    const b = e.target.closest('.run-conn');
    if (b && confirm(`Run a speedtest over ${b.dataset.conn} now? It uses a few hundred MB of that connection's data.`)) {
      startTest(`conn:${encodeURIComponent(b.dataset.conn)}`);
    }
  });
  $('#run-regions').addEventListener('click', () => {
    const n = CONFIG.speedtest.regions.length;
    if (confirm(`Run speedtests to ${n} region${n > 1 ? 's' : ''} now? Each test uses a few hundred MB.`)) startTest('regions');
  });

  const sp = CONFIG.speedtest;
  if (CONFIG.repo) $('#repo-link').href = CONFIG.repo;
  $('#docker-note').hidden = !CONFIG.docker_bridge || !!CONFIG.public;
  $('#public-badge').hidden = !CONFIG.public;
  $('#footer').innerHTML = `<a href="${esc(CONFIG.repo || '#')}" target="_blank" rel="noopener">netBae ${esc(CONFIG.version)}</a> by `
    + '<a href="https://github.com/jchin14" target="_blank" rel="noopener">jchin14</a> · '
    + `ping every ${CONFIG.ping.interval_seconds}s · `
    + (sp.enabled ? `speedtest every ${sp.interval_minutes} min${sp.offset_minutes ? ` (+${sp.offset_minutes} min offset)` : ''} · ` : '')
    + 'tip: double-click a chip to show only that series';

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
