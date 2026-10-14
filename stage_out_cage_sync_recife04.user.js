// ==UserScript==
// @name         SPX Stage Out → Dashboard Sync · Recife 04
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/stage_out_cage_sync_recife04.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/stage_out_cage_sync_recife04.user.js
// @description  Sincroniza staging areas + sacas por gaiola (SPX cage API) com o dashboard
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL      = 'https://stage-out.onrender.com/api/stage-data';
  const CAGE_MAP_URL    = 'https://stage-out.onrender.com/api/cage-map-data';
  const SEARCH_URL      = '/api/in-station/outbound/outbound_staging_area/config/search';
  const DETAIL_URL      = '/api/in-station/outbound/outbound_staging_area/details';
  const CAGE_DETAIL_URL = '/api/in-station/cage/detail/list';
  const PAGE_SIZE       = 100;
  const DETAIL_COUNT    = 100;
  const CAGE_BATCH      = 15;   // chamadas paralelas ao cage/detail/list
  const INTERVAL        = 60 * 1000;
  // ID da estação deste computador — enviado junto com as sacas (o servidor separa por estação)
  const STATION_ID      = '15000'; // SoC_PE_Recife_04

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  // ── Endpoint 1: lista de staging areas ───────────────────────────────
  async function fetchPage(pageno) {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrftoken': getCsrf() },
      body: JSON.stringify({ pageno, count: PAGE_SIZE }),
    });
    return res.json();
  }

  async function fetchAll() {
    const first = await fetchPage(1);
    if (first.retcode !== 0) throw new Error('API retcode: ' + first.retcode + ' — ' + first.message);
    const { total, list } = first.data;
    const pages = Math.ceil(total / PAGE_SIZE);
    let all = [...list];
    for (let p = 2; p <= pages; p++) {
      const r = await fetchPage(p);
      if (r.retcode === 0) all = all.concat(r.data.list);
    }
    return { list: all, total, fetchedAt: Date.now() };
  }

  // ── Endpoint 2: detalhes da rua → quais gaiolas estão lá ─────────────
  async function fetchDetails(stagingAreaId) {
    const url = `${DETAIL_URL}?pageno=1&count=${DETAIL_COUNT}&staging_area_id=${encodeURIComponent(stagingAreaId)}`;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'x-csrftoken': getCsrf() },
    });
    return res.json();
  }

  async function buildCageMap(list) {
    const withCages = list.filter(r => (r.cage_quantity || 0) > 0);

    const results = await Promise.all(
      withCages.map(async area => {
        try {
          const r = await fetchDetails(area.staging_area_id);
          if (r.retcode !== 0) return null;
          const items    = r.data?.staging_area_item?.list || [];
          const areaName = r.data?.staging_area_base_info?.staging_area_name
                        || area.staging_area_name
                        || area.staging_area_id;
          return { areaName, items };
        } catch (e) {
          console.warn('[SPX Sync] details error', area.staging_area_id, e);
          return null;
        }
      })
    );

    const cageMap = {}; // { 'CG1006': 'OUT-174' }
    results.forEach(result => {
      if (!result) return;
      result.items.forEach(item => {
        const cageId = (item.target_item_number || '').trim();
        if (cageId) cageMap[cageId] = result.areaName;
      });
    });

    return cageMap;
  }

  // ── Endpoint 3: detalhe da gaiola → total de TOs (sacas) ─────────────
  async function fetchCageDetail(cageId) {
    const res = await fetch(CAGE_DETAIL_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrftoken': getCsrf() },
      body: JSON.stringify({ cage_id: cageId, page_size: 1, pageno: 1 }),
    });
    return res.json();
  }

  async function buildByArea(cageMap) {
    const cageIds = Object.keys(cageMap);

    // Inicializa byArea com as gaiolas de cada rua
    const byArea = {};
    Object.entries(cageMap).forEach(([cageId, areaName]) => {
      if (!byArea[areaName]) byArea[areaName] = { sacas: 0, cages: [] };
      byArea[areaName].cages.push(cageId);
    });

    // Busca total de TOs por gaiola em lotes paralelos
    for (let i = 0; i < cageIds.length; i += CAGE_BATCH) {
      const batch = cageIds.slice(i, i + CAGE_BATCH);
      await Promise.all(batch.map(async cageId => {
        try {
          const r = await fetchCageDetail(cageId);
          if (r.retcode !== 0) return;
          const sacas    = r.data?.total || 0;
          const areaName = cageMap[cageId];
          if (areaName && byArea[areaName]) byArea[areaName].sacas += sacas;
        } catch (e) {
          console.warn('[SPX Sync] cage detail error', cageId, e);
        }
      }));
    }

    return byArea;
  }

  // ── Helpers de envio ──────────────────────────────────────────────────
  function post(url, payload) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method:  'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        data:    JSON.stringify(payload),
        onload:  resolve,
        onerror: resolve,
      });
    });
  }

  // ── Sync principal ────────────────────────────────────────────────────
  async function sync() {
    dot.textContent      = '🔄 Sincronizando...';
    dot.style.background = '#ee4d2d';
    try {
      // 1. Lista de staging areas → envia ao servidor imediatamente
      const data = await fetchAll();
      await post(SERVER_URL, data);

      // 2. Mapa gaiola → rua (endpoint 2)
      dot.textContent = '🗺️ Mapeando gaiolas...';
      const cageMap   = await buildCageMap(data.list);

      // 3. Sacas por gaiola → agrega por rua (endpoint 3)
      dot.textContent = '📦 Contando sacas...';
      const byArea    = await buildByArea(cageMap);

      // 4. Envia mapa + sacas ao servidor
      const totalSacas = Object.values(byArea).reduce((s, a) => s + a.sacas, 0);
      await post(CAGE_MAP_URL, { cageMap, byArea, fetchedAt: Date.now(), station_id: STATION_ID });

      const ts         = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      dot.textContent  = `✅ Sync ${ts} · ${totalSacas} sacas`;
      dot.style.background = '#2db55d';
      console.log('[SPX Sync]', data.list.length, 'ruas ·',
                  Object.keys(cageMap).length, 'gaiolas ·', totalSacas, 'sacas');
    } catch (e) {
      dot.textContent      = '⚠️ Erro API SPX';
      dot.style.background = '#cc7700';
      console.error('[SPX Sync]', e);
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

  // ── Indicador visual (dentro do painel compartilhado) ─────────────────
  const dot = registerSyncDot('📡 Dashboard Sync', '#ee4d2d');
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);

  sync();
  setInterval(sync, INTERVAL);
})();
