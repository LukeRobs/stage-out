// ==UserScript==
// @name         SPX Workstation Productivity → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.1
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/workstation_sync.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/workstation_sync.user.js
// @description  Sincroniza produtividade por workstation com o dashboard
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_BASE = 'https://stage-out.onrender.com';
  const INTERVAL    = 60 * 1000; // 60s

  // Endpoint para lista de workstations (paginado — busca todas as páginas)
  const WS_API   = '/api/wfm/admin/workstation/productivity/productivity_workstation_list';
  // Endpoint para lista de operadores individuais por workstation
  const OP_API   = '/api/wfm/admin/workstation/productivity/productivity_individual_list';

  // ── Utilitários ─────────────────────────────────────────────────────────
  function getTurnoWindow() {
    // Janela do turno atual: hora cheia do início até agora
    // Turno T1: 06:00–14:00  T2: 14:00–22:00  T3: 22:00–06:00
    const now = new Date();
    const h   = now.getHours();
    let start;
    if (h >= 6 && h < 14)       start = new Date(now); start = new Date(now);
    if (h >= 6 && h < 14)       { start.setHours(6, 0, 0, 0); }
    else if (h >= 14 && h < 22) { start.setHours(14, 0, 0, 0); }
    else {
      // T3: começa às 22h do dia anterior se h < 6
      start = new Date(now);
      if (h < 6) start.setDate(start.getDate() - 1);
      start.setHours(22, 0, 0, 0);
    }
    return {
      start_time: Math.floor(start.getTime() / 1000),
      end_time:   Math.floor(now.getTime() / 1000),
    };
  }

  async function fetchAllWS(start_time, end_time) {
    const PAGE_SIZE = 100;
    let pageno = 1, allList = [], total = null;

    while (true) {
      const url = `${WS_API}?pageno=${pageno}&count=${PAGE_SIZE}&start_time=${start_time}&end_time=${end_time}`;
      const res  = await fetch(url, { credentials: 'include' });
      const json = await res.json();
      if (json.retcode !== 0) throw new Error(`WS API retcode ${json.retcode}: ${json.message}`);
      const data = json.data;
      allList = allList.concat(data.list || []);
      if (total === null) total = data.total;
      if (allList.length >= total || !(data.list && data.list.length)) break;
      pageno++;
    }
    return { list: allList, total };
  }

  // Extrai o biz_workstation_id do campo workstation: "[WS10963000005]ST_OUT01" → "WS10963000005"
  function extractWsId(workstation) {
    const m = workstation.match(/^\[(\w+)\]/);
    return m ? m[1] : workstation;
  }

  // Busca operadores individuais para todas as WS com manpower > 0
  async function fetchOperators(wsList, start_time, end_time) {
    const wsWithOps = wsList.filter(w => w.manpower > 0);
    const results   = [];

    // Faz chamadas em paralelo com limite (batches de 5)
    const BATCH = 5;
    for (let i = 0; i < wsWithOps.length; i += BATCH) {
      const batch = wsWithOps.slice(i, i + BATCH);
      const promises = batch.map(ws => {
        const wsId = extractWsId(ws.workstation);
        const url  = `${OP_API}?start_time=${start_time}&end_time=${end_time}&workstation_group_id=0&biz_workstation_id=${wsId}&count=9999`;
        return fetch(url, { credentials: 'include' })
          .then(r => r.json())
          .then(json => {
            if (json.retcode !== 0) return [];
            // O campo workstation já vem preenchido no response, mas garantimos
            return json.data?.list || [];
          })
          .catch(() => []);
      });
      const batchResults = await Promise.all(promises);
      batchResults.forEach(ops => results.push(...ops));
    }
    return results;
  }

  function sendToServer(data) {
    GM_xmlhttpRequest({
      method  : 'POST',
      url     : SERVER_BASE + '/api/workstation-data',
      headers : { 'Content-Type': 'application/json' },
      data    : JSON.stringify(data),
      onload  : r => {
        const ok = r.status === 200;
        dot.textContent      = ok
          ? `✅ WS ${new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })}`
          : `⚠️ Server ${r.status}`;
        dot.style.background = ok ? '#2db55d' : '#cc7700';
        console.log(`[WS Sync] ${data.workstations.length} WS · ${data.operators.length} operadores → ${r.status}`);
      },
      onerror : () => {
        dot.textContent      = '❌ Server offline';
        dot.style.background = '#cc0000';
      },
    });
  }

  async function sync() {
    dot.textContent      = '🔄 WS...';
    dot.style.background = '#888';
    try {
      const { start_time, end_time } = getTurnoWindow();
      const { list: wsList }         = await fetchAllWS(start_time, end_time);
      const operators                = await fetchOperators(wsList, start_time, end_time);
      sendToServer({
        workstations: wsList,
        operators,
        startTime:  start_time,
        endTime:    end_time,
        fetchedAt:  Date.now(),
      });
    } catch (e) {
      dot.textContent      = '⚠️ Erro WS';
      dot.style.background = '#cc7700';
      console.error('[WS Sync]', e);
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

  // ── Indicador visual ────────────────────────────────────────────────────
  const dot = registerSyncDot('📡 WS Prod', '#888');
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);

  sync();
  setInterval(sync, INTERVAL);
})();
