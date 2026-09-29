// ==UserScript==
// @name         SPX Stage Out Aging → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/stage_out_aging_sync.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/stage_out_aging_sync.user.js
// @description  Varre as ruas ocupadas do Stage Out e envia as TOs endereçadas há mais de 24h (farol de aging do Report)
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL  = 'https://stage-out.onrender.com/api/aging-data';
  const CONFIG_URL  = '/api/in-station/outbound/outbound_staging_area/config/search';
  const RUA_URL     = '/api/in-station/outbound/outbound_staging_area/details';
  const TO_URL      = '/api/in-station/general_to/detail/search';
  const PAGE_SIZE   = 100;
  const INTERVAL    = 5 * 60 * 1000;   // 5min — aging é medido em horas, não precisa de tempo real
  const PAUSE_MS    = 400;             // pausa entre ruas, para não fazer rajada contra o SPX
  const MAX_AGE_SEC = 24 * 3600;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'include', headers: { 'x-csrftoken': getCsrf() } });
    const json = JSON.parse(await res.text());
    if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
    return json.data || {};
  }

  async function fetchRuas() {
    let all = [], pageno = 1, total = 0;
    do {
      const res = await fetch(CONFIG_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrftoken': getCsrf() },
        body: JSON.stringify({ pageno, count: PAGE_SIZE }),
      });
      const json = await res.json();
      if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
      total = json.data.total;
      all = all.concat(json.data.list || []);
      pageno++;
    } while (all.length < total && pageno < 20);
    return all;
  }

  // Todos os itens (TOs e gaiolas) de uma rua
  async function fetchRuaItems(staging_area_id) {
    let all = [], pageno = 1, total = 0;
    do {
      const d = await getJson(`${RUA_URL}?staging_area_id=${encodeURIComponent(staging_area_id)}&pageno=${pageno}&count=200`);
      const item = d.staging_area_item || {};
      total = item.total || 0;
      all = all.concat(item.list || []);
      if (!item.list?.length) break;
      pageno++;
    } while (all.length < total && pageno <= 10);
    return all;
  }

  // Pacotes de uma TO = total do detalhe (count=1 basta, a API devolve o total)
  const parcelsCache = new Map(); // to_number -> nº de pacotes (não muda enquanto a TO existe)
  async function fetchParcels(to_number) {
    if (parcelsCache.has(to_number)) return parcelsCache.get(to_number);
    try {
      const d = await getJson(`${TO_URL}?to_number=${encodeURIComponent(to_number)}&pageno=1&count=1`);
      if (d.total != null) { parcelsCache.set(to_number, d.total); return d.total; }
    } catch (e) { console.warn('[Aging] pacotes de', to_number, e.message); }
    return null; // o servidor completa com o merge de Packed/Packing, se souber
  }

  function parseDest(s) {
    const m = (s || '').match(/^\[(\d+)\](.*)/);
    return m ? { id: m[1], name: m[2].trim() } : { id: '?', name: s || '—' };
  }

  // Última leitura BEM-SUCEDIDA de cada rua — uma falha transitória numa rua não some com as
  // TOs dela do farol (mesma ideia do dayResultCache do tos_sync).
  const ruaCache = new Map(); // staging_area_id -> [TOs > 24h]

  let running = false;
  async function sync() {
    if (running) return; // varredura anterior ainda em andamento (clique manual ou rodada lenta)
    running = true;
    try { await runSync(); } finally { running = false; }
  }

  async function runSync() {
    dot.textContent = '🔄 Aging...';
    dot.style.background = '#ee4d2d';
    try {
      const ruas = (await fetchRuas()).filter(r =>
        (r.staging_area_status === 1 || r.staging_area_status === 3) && (r.transport_order_quantity || 0) > 0);
      const station = ruas[0]?.current_station_id;
      const nowSec = Math.floor(Date.now() / 1000);
      const seen = new Set(ruas.map(r => String(r.staging_area_id)));
      for (const k of ruaCache.keys()) if (!seen.has(k)) ruaCache.delete(k);

      let failed = 0;
      for (const r of ruas) {
        const key = String(r.staging_area_id);
        try {
          const items = await fetchRuaItems(r.staging_area_id);
          const dest = parseDest(r.to_destination);
          const aged = items.filter(it => it.target_item_type === 2 && it.scan_time && nowSec - it.scan_time > MAX_AGE_SEC);
          const list = [];
          for (const it of aged) {
            list.push({
              to_number: it.target_item_number,
              staging_area_id: r.staging_area_id,
              staging_area_name: r.staging_area_name,
              dest_id: dest.id,
              dest_name: dest.name,
              scan_time: it.scan_time,
              parcels: await fetchParcels(it.target_item_number),
            });
          }
          ruaCache.set(key, list);
        } catch (e) {
          failed++;
          console.warn('[Aging] rua', r.staging_area_name, e.message);
        }
        await sleep(PAUSE_MS);
      }

      const list = [...ruaCache.values()].flat();
      GM_xmlhttpRequest({
        method: 'POST',
        url: SERVER_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ station, list, ruasScanned: ruas.length, fetchedAt: Date.now() }),
        onload: () => {
          dot.textContent = `✅ Aging ${list.length} TOs ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}${failed ? ` (${failed} rua(s) com erro)` : ''}`;
          dot.style.background = failed ? '#cc7700' : '#2db55d';
        },
        onerror: () => { dot.textContent = '❌ Server offline'; dot.style.background = '#cc0000'; },
      });
    } catch (e) {
      dot.textContent = '⚠️ Erro Aging';
      dot.style.background = '#cc7700';
      console.error('[Aging]', e);
    }
  }

  // ── Hub compartilhado ────────────────────────────────────────────────
  function registerSyncDot(label, bgColor) {
    let hub = document.getElementById('spx-sync-hub');
    if (!hub) {
      hub = document.createElement('div');
      hub.id = 'spx-sync-hub';
      hub.style.cssText = [
        'position:fixed', 'bottom:16px', 'right:16px',
        'z-index:2147483647', 'font-family:sans-serif',
        'display:flex', 'flex-direction:column', 'align-items:flex-end',
      ].join(';');
      const panel = document.createElement('div');
      panel.id = 'spx-hub-panel';
      panel.style.cssText = [
        'display:none', 'flex-direction:column', 'gap:5px',
        'margin-bottom:8px', 'align-items:flex-end',
      ].join(';');
      const toggle = document.createElement('button');
      toggle.id = 'spx-hub-toggle';
      toggle.style.cssText = [
        'background:#1a1a2e', 'color:#ccc', 'border:1px solid #334',
        'padding:5px 14px', 'border-radius:20px', 'font-size:12px',
        'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
        'user-select:none', 'white-space:nowrap',
      ].join(';');
      toggle.textContent = '⚡ SPX Sync ▲';
      toggle.addEventListener('click', () => {
        const open = panel.style.display === 'flex';
        panel.style.display = open ? 'none' : 'flex';
        toggle.textContent  = `⚡ SPX Sync (${panel.children.length}) ${open ? '▲' : '▼'}`;
      });
      hub.appendChild(panel);
      hub.appendChild(toggle);
      document.body.appendChild(hub);
    }
    const panel  = document.getElementById('spx-hub-panel');
    const toggle = document.getElementById('spx-hub-toggle');
    const dot    = document.createElement('div');
    dot.style.cssText = [
      `background:${bgColor}`, 'color:#fff',
      'padding:5px 12px', 'border-radius:16px', 'font-size:11px',
      'cursor:pointer', 'box-shadow:0 1px 6px rgba(0,0,0,.3)',
      'user-select:none', 'white-space:nowrap',
    ].join(';');
    dot.textContent = label;
    panel.appendChild(dot);
    const open = panel.style.display === 'flex';
    toggle.textContent = `⚡ SPX Sync (${panel.children.length}) ${open ? '▼' : '▲'}`;
    return dot;
  }

  const dot = registerSyncDot('🕒 Aging', '#ee4d2d');
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);

  // ── Run ─────────────────────────────────────────────────────────────
  setTimeout(sync, 8000); // deixa os syncs principais rodarem primeiro
  setInterval(sync, INTERVAL);
})();
