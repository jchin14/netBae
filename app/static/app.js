'use strict';

const CDN = {
  chart: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  adapter: 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js',
};
const PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16',
  '#f97316', '#14b8a6', '#a855f7', '#eab308', '#0ea5e9', '#f43f5e', '#64748b', '#22c55e'];
const RANGES = [
  ['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400],
  ['7d', 604800], ['30d', 2592000], ['custom', null],
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
  if (v == null) return '—';
  return v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v).toString();
}
const fmtPct = (v, d = 1) => (v == null ? '—' : `${v.toFixed(d)}%`);
const fmtMbps = (v) => (v == null ? '—' : v >= 100 ? Math.round(v).toString() : v.toFixed(1));
function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDuration(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
}
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
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src));
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
      chip.innerHTML = `<i style="background:${it.color}"></i>${esc(it.label)}`;
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
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--grid');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
}

function lineChart(canvas, { yTitle, y1Title, yMax } = {}) {
  const scales = {
    x: { type: 'time', ticks: { maxRotation: 0, autoSkipPadding: 18 }, grid: { color: css('--grid') } },
    y: { beginAtZero: true, max: yMax, title: { display: !!yTitle, text: yTitle }, grid: { color: css('--grid') } },
  };
  if (y1Title) scales.y1 = { position: 'right', beginAtZero: true, title: { display: true, text: y1Title }, grid: { drawOnChartArea: false } };
  return new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      elements: { point: { radius: 0, hoverRadius: 4, hitRadius: 6 }, line: { borderWidth: 1.75, tension: 0.15 } },
      scales,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const unit = ctx.dataset.unit || '';
              const y = ctx.parsed.y;
              return ` ${ctx.dataset.label}: ${y == null ? '—' : (unit === 'ms' ? fmtMs(y) : y.toFixed(unit === 'Mbps' ? 1 : 2))} ${unit}`;
            },
          },
        },
      },
    },
  });
}

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

// group: red if most members are bad, amber if any member has a problem
function groupStatus(members) {
  const st = members.map(tileStatus).filter(Boolean);
  if (!st.length) return '';
  if (st.filter((x) => x === 'bad').length > st.length / 2) return 'bad';
  return st.some((x) => x !== 'good') ? 'warn' : 'good';
}

const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
let lastPing = [];

function memberTile(p, color) {
  const how = p.method === 'region' ? 'TCP to the fastest Ookla server' : p.method.toUpperCase();
  return `
    <div class="tile member" title="${esc(p.host || 'looking up server…')} · ${how}">
      <div class="name"><span class="dot ${tileStatus(p)}"></span><span>${esc(p.name)}</span><i class="swatch" style="background:${color}"></i></div>
      <div class="value">${p.last == null ? (p.last_ts ? '<span style="color:var(--bad)">timeout</span>' : '—') : fmtMs(p.last) + '<small>ms</small>'}</div>
      <div class="host">avg ${fmtMs(p.avg5m)} · loss ${fmtPct(p.loss5m)}</div>
    </div>`;
}

// One card per group showing the group's average; click to expand into per-host tiles.
function renderTiles() {
  const open = new Set(store.get('tiles:open', []));
  const groups = [...new Set(lastPing.map((p) => p.group))];
  $('#ping-tiles').innerHTML = groups.map((g) => {
    const members = lastPing.filter((p) => p.group === g);
    const status = groupStatus(members);
    const last = mean(members.map((p) => p.last));
    const down = members.filter((p) => p.last == null && p.last_ts != null).length;
    const isOpen = open.has(g);
    return `
      <div class="card tile group${isOpen ? ' open' : ''}" data-group="${esc(g)}">
        <button class="group-head" aria-expanded="${isOpen}">
          <span class="dot ${status}"></span><span class="gname">${esc(g)}</span>
          <span class="count">${members.length}</span><span class="chev">▾</span>
        </button>
        <div class="value">${last == null ? '—' : fmtMs(last) + '<small>ms avg</small>'}</div>
        <div class="host">5m avg ${fmtMs(mean(members.map((p) => p.avg5m)))} · loss ${fmtPct(mean(members.map((p) => p.loss5m)))}${down ? ` · <span style="color:var(--bad)">${down} down</span>` : ''}</div>
        ${isOpen ? `<div class="members">${members.map((p) => memberTile(p, PING_COLORS[p.id])).join('')}</div>` : ''}
      </div>`;
  }).join('');
}

async function refreshSummary() {
  const s = await api('summary');
  lastPing = s.ping;
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
  }
  const tests = st.averages?.['7d']?.tests;
  let meta = ok ? `Latest: ${esc(ok.isp || '')} → ${esc(ok.server_name || '')}${ok.server_location ? ', ' + esc(ok.server_location) : ''} · ${fmtAgo(ok.ts)}${tests ? ` · ${tests} tests in 7d` : ''}` : '';
  if (st.latest && st.latest.error) meta += `<div class="error-text">Last run failed (${fmtAgo(st.latest.ts)}): ${esc(st.latest.error)}</div>`;
  const hm = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (CONFIG.speedtest.enabled && CONFIG.speedtest.next_run) meta += `<div>Next scheduled run: ${hm(CONFIG.speedtest.next_run)}${CONFIG.speedtest.next_regions_run ? ` · regions: ${hm(CONFIG.speedtest.next_regions_run)}` : ''}</div>`;
  if (!CONFIG.speedtest.enabled) meta += '<div>Speedtests are disabled in the config.</div>';
  $('#speed-meta').innerHTML = meta;

  const regions = st.regions || [];
  $('#region-table').hidden = !regions.length;
  if (regions.length) {
    const avgCells = (a) => `<td>${fmtMbps(a?.download_mbps)}</td><td>${fmtMbps(a?.upload_mbps)}</td><td>${fmtMs(a?.ping_ms)}</td>`;
    const row = (name, x, avg, cls = '') => `<tr class="${cls}"><td>${name}</td>${
      !x || x.ts == null ? '<td colspan="3" class="muted" style="text-align:left">not tested yet</td>'
      : x.error ? `<td colspan="3" class="error-text" style="text-align:left" title="${esc(x.error)}">failed</td>`
      : `<td>${fmtMbps(x.download_mbps)}</td><td>${fmtMbps(x.upload_mbps)}</td><td>${fmtMs(x.ping_ms)}</td>`}
      ${avgCells(avg)}<td>${x?.ts ? fmtAgo(x.ts) : ''}</td></tr>`;
    $('#region-table').innerHTML = `
      <thead>
        <tr><th></th><th colspan="3" class="span">Latest</th><th colspan="3" class="span">7-day average</th><th></th></tr>
        <tr><th>Server</th><th>Down</th><th>Up</th><th>Ping</th><th>Down</th><th>Up</th><th>Ping</th><th>Tested</th></tr>
      </thead>
      <tbody>
        ${row('<b>Closest server</b>', ok, st.averages?.['7d'], 'strong')}
        ${regions.map((x) => row(esc(x.name), x, x.avg7d)).join('')}
        <tr class="strong total"><td><b>All regions</b></td><td colspan="3" class="muted" style="text-align:left">${st.regions_avg?.['7d']?.tests ?? 0} tests in 7 days</td>${avgCells(st.regions_avg?.['7d'])}<td></td></tr>
      </tbody>`;
  }

  const running = st.status.running;
  const btn = $('#run-speedtest');
  btn.disabled = !CONFIG.speedtest.enabled || running;
  btn.textContent = running ? `Running ${st.status.label && st.status.label !== 'Auto' ? st.status.label : ''}…`.replace(' …', '…') : 'Run now';
  const rbtn = $('#run-regions');
  rbtn.hidden = !CONFIG.speedtest.enabled || !CONFIG.speedtest.regions.length;
  rbtn.disabled = running;
}

// ------------------------------------------------------------------ system card
function bar(pct) {
  const cls = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
  return `<div class="bar"><div class="${cls}" style="width:${Math.min(100, pct || 0)}%"></div></div>`;
}

async function refreshSystem() {
  const s = await api('system');
  const info = s.info;
  $('#hostname').textContent = info.hostname ? `· ${info.hostname}` : '';
  $('#subtitle').textContent = [s.ip, info.os].filter(Boolean).join(' · ');
  $('#sys-model').textContent = info.model || info.cpu_model || '';
  const items = [
    ['Uptime', fmtDuration(s.uptime), `${info.arch} · ${info.cpu_count} cores`],
    ['Load', s.load ? s.load.map((l) => l.toFixed(2)).join('  ') : '—', '1 · 5 · 15 min'],
    ['CPU', fmtPct(s.cpu), bar(s.cpu)],
    ['Memory', s.mem ? fmtPct(s.mem.percent) : '—', s.mem ? `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}${bar(s.mem.percent)}` : ''],
    ['Storage', s.disk ? fmtPct(s.disk.percent) : '—', s.disk ? `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)} (${esc(s.disk.path)})${bar(s.disk.percent)}` : ''],
  ];
  if (s.temp != null) items.push(['Temperature', `${s.temp.toFixed(1)} °C`, bar(s.temp)]);
  if (s.mem && s.mem.swap_total) items.push(['Swap', fmtBytes(s.mem.swap_used), `of ${fmtBytes(s.mem.swap_total)}`]);
  items.push(['Database', fmtBytes(s.db_size), `${CONFIG.retention_days}-day retention`]);
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

// Y-axis that fits the average lines (spikes and band edges get clipped) plus zoom buttons.
function yZoom(root, key, chart) {
  let scale = store.get(`yscale:${key}`, 1); // 0 = show everything
  let auto;
  const bar = document.createElement('div');
  bar.className = 'zoom';
  bar.innerHTML = `<button data-z="in" title="Zoom in">+</button><button data-z="out" title="Zoom out">−</button>
    <button data-z="fit" title="Fit to the averages">Fit</button><button data-z="all" title="Show everything">All</button>`;
  $('.chart-wrap', root).appendChild(bar);
  chart.options.layout = { padding: { top: 30 } }; // room for the buttons
  const apply = () => {
    chart.options.scales.y.max = scale && auto ? +(auto * scale).toPrecision(3) : undefined;
    bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on',
      (b.dataset.z === 'fit' && scale === 1) || (b.dataset.z === 'all' && scale === 0)));
  };
  bar.addEventListener('click', (e) => {
    const z = e.target.dataset.z;
    if (!z) return;
    if (z === 'in') scale = (scale || 4) / 2;
    if (z === 'out') scale = scale ? Math.min(64, scale * 2) : 0;
    if (z === 'fit') scale = 1;
    if (z === 'all') scale = 0;
    store.set(`yscale:${key}`, scale);
    apply();
    chart.update();
  });
  return {
    // values: the numbers the axis should fit (average lines); floor: minimum axis max
    fit(values, floor = 1) {
      const v = values.filter((x) => x != null).sort((a, b) => a - b);
      auto = v.length ? niceCeil(Math.max(floor, v[Math.floor((v.length - 1) * 0.98)] * 1.35)) : undefined;
      apply();
    },
  };
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
  chart.options.plugins.tooltip.itemSort = (a, b) => (b.parsed.y ?? -1) - (a.parsed.y ?? -1); // slowest first
  chart.options.plugins.tooltip.callbacks.label = (ctx) => {
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
    chart.data.datasets = datasets;
    zoom.fit(datasets.filter((ds) => ds.role !== 'band').flatMap((ds) => ds.data.map((p) => p.y)), metric === 'loss' ? 5 : 1);
    setXRange(chart, r);
    chart.update();

    const rows = items.filter((it) => sel.includes(it.id)).map((it) => {
      const s = d.stats[it.id] || {};
      return `<tr><td><span class="dot" style="background:${it.color}"></span> ${esc(it.label)}</td>
        <td><b>${fmtMs(s.avg)}</b></td><td>${fmtMs(s.min)}</td><td>${fmtMs(s.p5)}</td><td>${fmtMs(s.p95)}</td><td>${fmtMs(s.max)}</td>
        <td>${fmtPct(s.loss, 2)}</td><td>${(s.samples ?? 0).toLocaleString()}</td></tr>`;
    }).join('');
    $('.stats', root).innerHTML = `<thead><tr><th>Host</th><th>Avg ms</th><th>Min</th><th>P5</th><th>P95</th><th>Max</th><th>${lossLabel}</th><th>Samples</th></tr></thead><tbody>${rows}</tbody>`;
    return r.live;
  };
  const chips = chipFilter($('.chips', root), id, items, refresh, defaultOff);
  const range = rangeControl($('.range', root), id, defaultRange, refresh);
  metricSel.addEventListener('change', () => { store.set(`metric:${id}`, metricSel.value); refresh(); });
  bandSel.addEventListener('change', () => { store.set(`band:${id}`, bandSel.value); refresh(); });
  return { root, refresh, isLive: () => range.get()?.live, chart };
}

// ------------------------------------------------------------------ speedtest panel
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
    viewSel.innerHTML = labels.map((l) => `<option value="${esc(l)}">${l === 'Auto' ? 'Closest server' : esc(l)}</option>`).join('')
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
    const recent = rows.slice(-15).reverse();
    $('.stats', root).innerHTML = `
      <thead><tr><th>Time</th><th>Test</th><th>Down Mbps</th><th>Up Mbps</th><th>Ping ms</th><th>Jitter ms</th><th>Loss</th><th>Server</th><th></th></tr></thead>
      <tbody>
        <tr><td><b>Average (${ok.length} tests)</b></td><td></td><td><b>${fmtMbps(avg('download_mbps'))}</b></td><td><b>${fmtMbps(avg('upload_mbps'))}</b></td>
          <td><b>${fmtMs(avg('ping_ms'))}</b></td><td><b>${fmtMs(avg('jitter_ms'))}</b></td><td></td><td></td><td></td></tr>
        ${recent.map((x) => x.error
          ? `<tr><td>${fmtTime(x.ts)}</td><td>${esc(x.label)}</td><td colspan="7" class="error-text" style="text-align:left">${esc(x.error)}</td></tr>`
          : `<tr><td>${fmtTime(x.ts)}</td><td>${esc(x.label)}</td><td>${fmtMbps(x.download_mbps)}</td><td>${fmtMbps(x.upload_mbps)}</td><td>${fmtMs(x.ping_ms)}</td>
             <td>${fmtMs(x.jitter_ms)}</td><td>${x.packet_loss == null ? '—' : fmtPct(x.packet_loss)}</td>
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
  const jobs = [refreshSummary(), refreshSystem(), ...panels.filter((p) => force || p.isLive()).map((p) => p.refresh())];
  const res = await Promise.allSettled(jobs);
  const failed = res.find((r) => r.status === 'rejected');
  if (failed) {
    console.error(failed.reason);
    setStatus(false, Date.now() - lastOk > 60000 ? 'offline — retrying' : 'update failed');
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
    if (!card || !e.target.closest('.group-head')) return;
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
    const dnsItems = CONFIG.dns.servers.map((s, i) => ({ id: s.id, label: s.name, color: PALETTE[i % PALETTE.length], title: s.host }));
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
  $('#run-regions').addEventListener('click', () => {
    const n = CONFIG.speedtest.regions.length;
    if (confirm(`Run speedtests to ${n} region${n > 1 ? 's' : ''} now? Each test uses a few hundred MB.`)) startTest('regions');
  });

  const sp = CONFIG.speedtest;
  $('#footer').textContent = `netBae ${CONFIG.version} · ping every ${CONFIG.ping.interval_seconds}s · ` +
    (sp.enabled ? `speedtest every ${sp.interval_minutes} min${sp.offset_minutes ? ` (+${sp.offset_minutes} min offset)` : ''} · ` : '') +
    'tip: double-click a chip to show only that series';

  await refreshAll(true);
  setInterval(refreshAll, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
}

main();
