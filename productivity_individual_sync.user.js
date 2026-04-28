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

  // Cache de horas completas já enviadas — não rebusca a cada sync
  const doneHours = new Set();

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtHora(d) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
  }

  // Deriva janelas a partir do time_list (todas as horas com produção > 0)
  function windowsFromTimelist(time_list) {
    const now           = new Date();
    const nowTs         = Math.floor(now.getTime() / 1000);
    const curHourStart  = Math.floor(nowTs / 3600) * 3600;

    return time_list
      .filter(t => t.total > 0) // ignora horas sem produção
      .map(t => {
        const isCurrentHour = t.timestamp === curHourStart;
        return {
          hora:        fmtHora(new Date(t.timestamp * 1000)),
          start_time:  t.timestamp,
          end_time:    isCurrentHour ? nowTs : t.timestamp + 3600,
          isCompleted: !isCurrentHour,
        };
      })
      // Pula horas completas já enviadas (economiza chamadas de API)
      .filter(w => !w.isCompleted || !doneHours.has(w.hora));
  }

  // Busca time_list do dashboard/list (totais reais por hora, todas atividades)
  async function fetchTimelist() {
    const res = await fetch('/api/wfm/admin/dashboard/list', {
      method      : 'POST',
      credentials : 'include',
      headers     : { 'Content-Type': 'application/json' },
      body        : JSON.stringify({
        unit_type: 1, process_type: 2, period_type: 1,
        operator_email: '', pageno: 1, count: 1,
        event_id_list: [], order_by_total: 100, productivity: 1,
      }),
    });
    const json = await res.json();
    if (json.retcode !== 0) throw new Error(`dashboard/list retcode ${json.retcode}`);
    return json.data.time_list || [];
  }

  function sendTimelist(time_list) {
    GM_xmlhttpRequest({
      method  : 'POST',
      url     : SERVER_BASE + '/api/productivity-timelist',
      headers : { 'Content-Type': 'application/json' },
      data    : JSON.stringify({ time_list, fetchedAt: Date.now() }),
      onload  : r => console.log(`[ProdInd] timelist: ${time_list.length} horas → ${r.status}`),
      onerror : () => console.warn('[ProdInd] timelist: server offline'),
    });
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
      const time_list = await fetchTimelist();
      sendTimelist(time_list);

      const windows = windowsFromTimelist(time_list);

      for (const w of windows) {
        const { records } = await fetchAllRecords(w.start_time, w.end_time);
        sendToServer({
          hora:       w.hora,
          start_time: w.start_time,
          end_time:   w.end_time,
          records,
          total:      records.length,
          fetchedAt:  Date.now(),
        }, w.hora);
        if (w.isCompleted) doneHours.add(w.hora);
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
