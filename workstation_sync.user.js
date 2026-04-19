// ==UserScript==
// @name         SPX Workstation Productivity → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.0
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
  // Endpoint para lista de operadores por workstation
  const OP_API   = '/api/wfm/admin/workstation/productivity/productivity_operator_list';

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

  // Busca operadores para todas as WS com manpower > 0
  async function fetchOperators(wsList, start_time, end_time) {
    const wsWithOps = wsList.filter(w => w.manpower > 0);
    const results   = [];

    // Faz chamadas em paralelo com limite (batches de 5)
    const BATCH = 5;
    for (let i = 0; i < wsWithOps.length; i += BATCH) {
      const batch = wsWithOps.slice(i, i + BATCH);
      const promises = batch.map(ws =>
        fetch(`${OP_API}?workstation_id=${encodeURIComponent(ws.workstation)}&start_time=${start_time}&end_time=${end_time}`, {
          credentials: 'include',
        })
        .then(r => r.json())
        .then(json => {
          if (json.retcode !== 0) return [];
          return (json.data?.list || []).map(op => ({
            ...op,
            workstation: ws.workstation,
          }));
        })
        .catch(() => [])
      );
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

  // ── Indicador visual ────────────────────────────────────────────────────
  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:fixed', 'bottom:120px', 'right:16px',
    'background:#888', 'color:#fff',
    'padding:6px 14px', 'border-radius:20px',
    'font-size:12px', 'font-family:sans-serif',
    'z-index:2147483647', 'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    'user-select:none',
  ].join(';');
  dot.textContent = '📡 WS Prod';
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);
  document.body.appendChild(dot);

  sync();
  setInterval(sync, INTERVAL);
})();
