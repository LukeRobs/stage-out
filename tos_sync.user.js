// ==UserScript==
// @name         SPX TO Management → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Sincroniza TOs Packing e Packed com o dashboard local
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_BASE  = 'https://stage-out.onrender.com';
  const SEARCH_URL   = '/api/in-station/general_to/outbound/search';
  const PAGE_SIZE    = 100;
  const INTERVAL     = 60 * 1000; // 60s

  // Range do dia atual (meia-noite até fim do dia, horário local)
  function getTodayCtime() {
    const now   = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return `${Math.floor(start.getTime() / 1000)},${Math.floor(end.getTime() / 1000)}`;
  }

  async function fetchPage(status, pageno) {
    const ctime = getTodayCtime();
    const url   = `${SEARCH_URL}?pageno=${pageno}&count=${PAGE_SIZE}&status=${status}&ctime=${ctime}`;
    const res   = await fetch(url, { credentials: 'include' });
    return res.json();
  }

  async function fetchAll(status) {
    const first = await fetchPage(status, 1);
    if (first.retcode !== 0) throw new Error(`API retcode ${first.retcode}: ${first.message}`);
    const { total, list } = first.data;
    const pages = Math.ceil(total / PAGE_SIZE);
    let all = [...list];
    for (let p = 2; p <= pages; p++) {
      const r = await fetchPage(status, p);
      if (r.retcode === 0) all = all.concat(r.data.list);
    }
    return { list: all, total, fetchedAt: Date.now() };
  }

  function sendToServer(endpoint, data, label) {
    GM_xmlhttpRequest({
      method  : 'POST',
      url     : SERVER_BASE + endpoint,
      headers : { 'Content-Type': 'application/json' },
      data    : JSON.stringify(data),
      onload  : () => {
        dot.textContent    = '✅ TOs Sync ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        dot.style.background = '#2db55d';
        console.log(`[TO Sync] ${label}: ${data.list.length} / ${data.total}`);
      },
      onerror : () => {
        dot.textContent    = '❌ Server offline';
        dot.style.background = '#cc0000';
        console.error('[TO Sync] Falha ao enviar para server local');
      },
    });
  }

  async function sync() {
    dot.textContent    = '🔄 Sincronizando TOs...';
    dot.style.background = '#ee4d2d';
    try {
      const [packing, packed] = await Promise.all([
        fetchAll(1), // status 1 = Packing
        fetchAll(2), // status 2 = Packed
      ]);
      sendToServer('/api/tos-packing-data', packing, 'Packing');
      sendToServer('/api/tos-packed-data',  packed,  'Packed');
    } catch (e) {
      dot.textContent    = '⚠️ Erro API TOs';
      dot.style.background = '#cc7700';
      console.error('[TO Sync]', e);
    }
  }

  // ── Indicador visual ────────────────────────────────────────────────
  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:fixed', 'bottom:48px', 'right:16px',
    'background:#ee4d2d', 'color:#fff',
    'padding:6px 14px', 'border-radius:20px',
    'font-size:12px', 'font-family:sans-serif',
    'z-index:2147483647', 'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    'user-select:none',
  ].join(';');
  dot.textContent = '📡 TO Sync';
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);
  document.body.appendChild(dot);

  // ── Run ─────────────────────────────────────────────────────────────
  sync();
  setInterval(sync, INTERVAL);
})();
