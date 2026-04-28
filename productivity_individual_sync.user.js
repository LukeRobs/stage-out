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

  const HOURS_BACK = 3; // hora atual + 2 anteriores

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtHora(d) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
  }

  // Retorna array de janelas: [hora_atual, hora-1, hora-2, ...]
  function getHourWindows() {
    const now     = new Date();
    const windows = [];
    for (let i = 0; i < HOURS_BACK; i++) {
      const start = new Date(now);
      start.setMinutes(0, 0, 0);
      start.setHours(start.getHours() - i);
      // hora atual: end = agora; horas passadas: end = início da hora seguinte
      const end = i === 0 ? new Date(now) : new Date(start.getTime() + 3600_000);
      windows.push({
        hora:       fmtHora(start),
        start_time: Math.floor(start.getTime() / 1000),
        end_time:   Math.floor(end.getTime()   / 1000),
      });
    }
    return windows;
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

  function sendToServer(payload, label) {
    GM_xmlhttpRequest({
      method  : 'POST',
      url     : SERVER_BASE + '/api/productivity-individual-data',
      headers : { 'Content-Type': 'application/json' },
      data    : JSON.stringify(payload),
      onload  : r => {
        console.log(`[ProdInd] ${label}: ${payload.records.length} reg → ${r.status}`);
      },
      onerror : () => console.warn(`[ProdInd] ${label}: server offline`),
    });
  }

  async function sync() {
    dot.textContent      = '🔄 Prod...';
    dot.style.background = '#888';
    try {
      const windows = getHourWindows();
      let sent = 0;
      for (const w of windows) {
        const { records, total } = await fetchAllRecords(w.start_time, w.end_time);
        sendToServer({ ...w, records, total, fetchedAt: Date.now() }, w.hora);
        sent += records.length;
      }
      const at = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
      dot.textContent      = `✅ ${windows.length}h · ${at}`;
      dot.style.background = '#2db55d';
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
