// ==UserScript==
// @name         SPX Productivity Individual → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Sincroniza produtividade individual por hora com o dashboard
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_BASE    = 'https://stage-out.onrender.com';
  const INTERVAL       = 60 * 1000;
  const API_URL        = '/api/wfm/admin/workstation/productivity/productivity_individual_list';
  const ACTIVITY_TYPE  = 12;
  const PAGE_SIZE      = 50;

  function pad(n) { return String(n).padStart(2, '0'); }

  function getCurrentHourWindow() {
    const now   = new Date();
    const start = new Date(now);
    start.setMinutes(0, 0, 0);
    const hora = `${start.getFullYear()}-${pad(start.getMonth()+1)}-${pad(start.getDate())} ${pad(start.getHours())}:00`;
    return {
      hora,
      start_time: Math.floor(start.getTime() / 1000),
      end_time:   Math.floor(now.getTime() / 1000),
    };
  }

  async function fetchAllRecords(start_time, end_time) {
    let pageno = 1, all = [], total = null;
    while (true) {
      const url = `${API_URL}?pageno=${pageno}&count=${PAGE_SIZE}&activity_type=${ACTIVITY_TYPE}&start_time=${start_time}&end_time=${end_time}`;
      const res  = await fetch(url, { credentials: 'include' });
      const json = await res.json();
      if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
      const data = json.data;
      all = all.concat(data.list || []);
      if (total === null) total = data.total;
      if (all.length >= total || !(data.list && data.list.length)) break;
      pageno++;
    }
    return { records: all, total: all.length };
  }

  function sendToServer(payload) {
    GM_xmlhttpRequest({
      method  : 'POST',
      url     : SERVER_BASE + '/api/productivity-individual-data',
      headers : { 'Content-Type': 'application/json' },
      data    : JSON.stringify(payload),
      onload  : r => {
        const ok = r.status === 200;
        dot.textContent      = ok
          ? `✅ Prod ${new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })}`
          : `⚠️ Server ${r.status}`;
        dot.style.background = ok ? '#2db55d' : '#cc7700';
        console.log(`[ProdInd] ${payload.hora}: ${payload.records.length} registros → ${r.status}`);
      },
      onerror : () => {
        dot.textContent      = '❌ Server offline';
        dot.style.background = '#cc0000';
      },
    });
  }

  async function sync() {
    dot.textContent      = '🔄 Prod...';
    dot.style.background = '#888';
    try {
      const { hora, start_time, end_time } = getCurrentHourWindow();
      const { records, total }             = await fetchAllRecords(start_time, end_time);
      sendToServer({ hora, start_time, end_time, records, total, fetchedAt: Date.now() });
    } catch (e) {
      dot.textContent      = '⚠️ Erro Prod';
      dot.style.background = '#cc7700';
      console.error('[ProdInd]', e);
    }
  }

  // ── Indicador visual ────────────────────────────────────────────────────
  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:fixed', 'bottom:80px', 'right:16px',
    'background:#888', 'color:#fff',
    'padding:6px 14px', 'border-radius:20px',
    'font-size:12px', 'font-family:sans-serif',
    'z-index:2147483647', 'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    'user-select:none',
  ].join(';');
  dot.textContent = '👷 Prod Ind';
  dot.title       = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);
  document.body.appendChild(dot);

  sync();
  setInterval(sync, INTERVAL);
})();
