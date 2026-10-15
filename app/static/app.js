'use strict';

const CDN = {
  chart: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  adapter: 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js',
};
const PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b'];
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

function chipFilter(el, key, items, onChange) {
  const off = new Set(store.get(`off:${key}`, []));
  el.innerHTML = '';
  for (const it of items) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (off.has(it.id) ? ' off' : '');
    chip.innerHTML = `<i style="background:${it.color}"></i>${esc(it.label)}`;
    chip.title = it.title || it.label;
    chip.addEventListener('click', (e) => {
      if (e.altKey || e.metaKey || e.ctrlKey || e.detail === 2) {
        // double-click / modifier: solo this item
        items.forEach((x) => (x.id === it.id ? off.delete(x.id) : off.add(x.id)));
      } else if (off.has(it.id)) off.delete(it.id);
      else off.add(it.id);
      [...el.children].forEach((c, i) => c.classList.toggle('off', off.has(items[i].id)));
      store.set(`off:${key}`, [...off]);
      onChange();
    });
    el.appendChild(chip);
  }
  return { selected: () => items.filter((i) => !off.has(i.id)).map((i) => i.id) };
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
const panels = [];
let lastOk = 0;

function setStatus(ok, msg) {
  const dot = $('#live-dot');
  dot.className = 'dot ' + (ok ? 'good' : 'bad');
  $('#updated').textContent = msg;
}

// ------------------------------------------------------------------ summary tiles
function tileStatus(p) {
  if (p.last == null && p.last_ts == null) return '';
  if (p.last == null || (p.loss5m ?? 0) >= 10) return 'bad';
  if ((p.loss5m ?? 0) > 0 || p.last > 150) return 'warn';
  return 'good';
}

async function refreshSummary() {
  const s = await api('summary');
  const tiles = $('#ping-tiles');
  tiles.innerHTML = s.ping.map((p, i) => `
    <div class="card tile" title="${esc(p.host)} · ${p.method.toUpperCase()}">
      <div class="name"><span class="dot ${tileStatus(p)}"></span><span>${esc(p.name)}</span></div>
      <div class="value">${p.last == null ? (p.last_ts ? '<span style="color:var(--bad)">timeout</span>' : '—') : fmtMs(p.last) + '<small>ms</small>'}</div>
      <div class="host">avg ${fmtMs(p.avg5m)} ms · loss ${fmtPct(p.loss5m)} <span class="muted">(5m)</span></div>
    </div>`).join('');

  const st = s.speedtest;
  const ok = st.last_ok;
  if (ok) {
    $('#speed-summary').innerHTML = `
      <div><div class="label">Download</div><div class="big">${fmtMbps(ok.download_mbps)}<small>Mbps</small></div></div>
      <div><div class="label">Upload</div><div class="big">${fmtMbps(ok.upload_mbps)}<small>Mbps</small></div></div>
      <div><div class="label">Ping</div><div class="big">${fmtMs(ok.ping_ms)}<small>ms</small></div></div>`;
  }
  let meta = ok ? `${esc(ok.isp || '')} → ${esc(ok.server_name || '')}${ok.server_location ? ', ' + esc(ok.server_location) : ''} · ${fmtAgo(ok.ts)}` : '';
  if (st.latest && st.latest.error) meta += `<div class="error-text">Last run failed (${fmtAgo(st.latest.ts)}): ${esc(st.latest.error)}</div>`;
  if (CONFIG.speedtest.enabled && CONFIG.speedtest.next_run) meta += `<div>Next scheduled run: ${new Date(CONFIG.speedtest.next_run * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
  if (!CONFIG.speedtest.enabled) meta += '<div>Speedtests are disabled in the config.</div>';
  $('#speed-meta').innerHTML = meta;

  const btn = $('#run-speedtest');
  btn.disabled = !CONFIG.speedtest.enabled || st.status.running;
  btn.textContent = st.status.running ? 'Running…' : 'Run now';
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
function latencyPanel({ id, endpoint, keyParam, items, defaultRange, extraParams, lossLabel }) {
  const root = $(`#${id}`);
  const metricSel = $('.metric', root);
  metricSel.value = store.get(`metric:${id}`, 'avg');
  const chart = lineChart($('canvas', root), { yTitle: 'ms' });
  const refresh = async () => {
    const r = range.get();
    if (!r) return;
    const sel = chips.selected();
    const metric = metricSel.value;
    const params = { from: r.from.toFixed(0), to: r.to.toFixed(0), points: Math.max(100, Math.min(1000, root.clientWidth)), ...(extraParams ? extraParams() : {}) };
    params[keyParam] = sel.join(',') || '__none__';
    const d = await api(endpoint, params);
    const idx = { avg: 1, max: 3, loss: 4 }[metric];
    chart.options.scales.y.title.text = metric === 'loss' ? '%' : 'ms';
    chart.options.scales.y.max = metric === 'loss' ? 100 : undefined;
    chart.data.datasets = items.filter((it) => sel.includes(it.id)).map((it) => ({
      label: it.label,
      unit: metric === 'loss' ? '%' : 'ms',
      borderColor: it.color,
      backgroundColor: it.color + '33',
      stepped: metric === 'loss' ? 'middle' : false,
      spanGaps: false,
      data: (d.series[it.id] || []).map((p) => ({ x: p[0], y: p[idx] })),
    }));
    setXRange(chart, r);
    chart.update();

    const rows = items.filter((it) => sel.includes(it.id)).map((it) => {
      const s = d.stats[it.id] || {};
      return `<tr><td><span class="dot" style="background:${it.color}"></span> ${esc(it.label)}</td>
        <td>${fmtMs(s.avg)}</td><td>${fmtMs(s.min)}</td><td>${fmtMs(s.max)}</td>
        <td>${fmtPct(s.loss, 2)}</td><td>${s.samples ?? 0}</td></tr>`;
    }).join('');
    $('.stats', root).innerHTML = `<thead><tr><th>Host</th><th>Avg ms</th><th>Min ms</th><th>Max ms</th><th>${lossLabel}</th><th>Samples</th></tr></thead><tbody>${rows}</tbody>`;
    return r.live;
  };
  const chips = chipFilter($('.chips', root), id, items, refresh);
  const range = rangeControl($('.range', root), id, defaultRange, refresh);
  metricSel.addEventListener('change', () => { store.set(`metric:${id}`, metricSel.value); refresh(); });
  return { root, refresh, isLive: () => range.get()?.live, chart };
}

// ------------------------------------------------------------------ speedtest panel
function speedPanel() {
  const root = $('#panel-speed');
  const serverSel = $('.server', root);
  const chart = lineChart($('canvas', root), { yTitle: 'Mbps', y1Title: 'ms' });
  const series = [
    { id: 'download', label: 'Download', color: PALETTE[0], unit: 'Mbps', axis: 'y', key: 'download_mbps' },
    { id: 'upload', label: 'Upload', color: PALETTE[2], unit: 'Mbps', axis: 'y', key: 'upload_mbps' },
    { id: 'ping', label: 'Ping', color: PALETTE[1], unit: 'ms', axis: 'y1', key: 'ping_ms' },
    { id: 'jitter', label: 'Jitter', color: PALETTE[4], unit: 'ms', axis: 'y1', key: 'jitter_ms' },
  ];
  const refresh = async () => {
    const r = range.get();
    if (!r) return;
    const d = await api('speedtest', { from: r.from.toFixed(0), to: r.to.toFixed(0) });
    // populate server filter from servers seen in range
    const servers = [...new Map(d.results.filter((x) => x.server_id).map((x) => [String(x.server_id), `${x.server_name} (${x.server_location})`])).entries()];
    const cur = serverSel.value || store.get('speed:server', '');
    serverSel.innerHTML = '<option value="">All servers</option>' + servers.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('');
    serverSel.value = servers.some(([id]) => id === cur) ? cur : '';

    const rows = d.results.filter((x) => !serverSel.value || String(x.server_id) === serverSel.value);
    const ok = rows.filter((x) => !x.error);
    const sel = chips.selected();
    chart.data.datasets = series.filter((s) => sel.includes(s.id)).map((s) => ({
      label: s.label, unit: s.unit, yAxisID: s.axis, borderColor: s.color, backgroundColor: s.color,
      borderDash: s.axis === 'y1' ? [4, 3] : [], spanGaps: true,
      pointRadius: ok.length > 200 ? 0 : 2.5,
      data: ok.map((x) => ({ x: x.ts * 1000, y: x[s.key] })),
    }));
    chart.options.scales.y1.display = sel.includes('ping') || sel.includes('jitter');
    setXRange(chart, r);
    chart.update();

    const avg = (k) => (ok.length ? ok.reduce((a, x) => a + (x[k] || 0), 0) / ok.length : null);
    const recent = rows.slice(-15).reverse();
    $('.stats', root).innerHTML = `
      <thead><tr><th>Time</th><th>Down Mbps</th><th>Up Mbps</th><th>Ping ms</th><th>Jitter ms</th><th>Loss</th><th>Server</th><th></th></tr></thead>
      <tbody>
        <tr><td><b>Average (${ok.length} tests)</b></td><td><b>${fmtMbps(avg('download_mbps'))}</b></td><td><b>${fmtMbps(avg('upload_mbps'))}</b></td>
          <td><b>${fmtMs(avg('ping_ms'))}</b></td><td><b>${fmtMs(avg('jitter_ms'))}</b></td><td></td><td></td><td></td></tr>
        ${recent.map((x) => x.error
          ? `<tr><td>${fmtTime(x.ts)}</td><td colspan="7" class="error-text" style="text-align:left">${esc(x.error)}</td></tr>`
          : `<tr><td>${fmtTime(x.ts)}</td><td>${fmtMbps(x.download_mbps)}</td><td>${fmtMbps(x.upload_mbps)}</td><td>${fmtMs(x.ping_ms)}</td>
             <td>${fmtMs(x.jitter_ms)}</td><td>${x.packet_loss == null ? '—' : fmtPct(x.packet_loss)}</td>
             <td style="text-align:left">${esc(x.server_name)}${x.server_location ? ', ' + esc(x.server_location) : ''}</td>
             <td>${x.result_url ? `<a href="${esc(x.result_url)}" target="_blank" rel="noopener">result ↗</a>` : ''}</td></tr>`).join('')}
      </tbody>`;
  };
  const chips = chipFilter($('.chips', root), 'speed', series, refresh);
  const range = rangeControl($('.range', root), 'speed', '7d', refresh);
  serverSel.addEventListener('change', () => { store.set('speed:server', serverSel.value); refresh(); });
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

  const pingItems = CONFIG.ping.targets.map((t, i) => ({
    id: t.id, label: t.name, color: PALETTE[i % PALETTE.length],
    title: `${t.host}${t.method === 'tcp' ? ` (TCP ${t.port})` : ''}`,
  }));
  panels.push(latencyPanel({ id: 'panel-ping', endpoint: 'ping', keyParam: 'targets', items: pingItems, defaultRange: '1h', lossLabel: 'Loss' }));

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

  $('#run-speedtest').addEventListener('click', async () => {
    const btn = $('#run-speedtest');
    btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const r = await fetch('api/speedtest/run', { method: 'POST' }).then((x) => x.json());
      btn.textContent = r.started ? 'Running…' : (r.reason || 'Busy');
    } catch { btn.textContent = 'Failed'; }
    // poll a little faster while the test runs
    const poll = setInterval(async () => {
      await refreshSummary().catch(() => {});
      if (!$('#run-speedtest').disabled) { clearInterval(poll); panels.forEach((p) => p.refresh()); }
    }, 4000);
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
