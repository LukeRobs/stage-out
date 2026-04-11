// ==UserScript==
// @name         SPX Inbound Staging Area → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Sincroniza dados do Inbound Staging Area com o dashboard
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_BASE = 'https://stage-out.onrender.com';
  const API_URL     = '/api/in-station/inbound_staging_area/list';
  const INTERVAL    = 60 * 1000; // 60s

  async function fetchAll() {
    const res = await fetch(API_URL, {
      method      : 'POST',
      credentials : 'include',
      headers     : { 'Content-Type': 'application/json' },
      body        : JSON.stringify({ pageno: 1, count: 300 }),
    });
    const json = await res.json();
    if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
    return { list: json.data.list, total: json.data.total, fetchedAt: Date.now() };
  }

  function sendToServer(data) {
    GM_xmlhttpRequest({
      method  : 'POST',
      url     : SERVER_BASE + '/api/stage-in-data',
      headers : { 'Content-Type': 'application/json' },
      data    : JSON.stringify(data),
      onload  : () => {
        dot.textContent      = '✅ Stage In ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        dot.style.background = '#2db55d';
        console.log(`[Stage In] ${data.list.length} / ${data.total} ruas`);
      },
      onerror : () => {
        dot.textContent      = '❌ Server offline';
        dot.style.background = '#cc0000';
        console.error('[Stage In] Falha ao enviar para o servidor');
      },
    });
  }

  async function sync() {
    dot.textContent      = '🔄 Stage In...';
    dot.style.background = '#888';
    try {
      const data = await fetchAll();
      sendToServer(data);
    } catch (e) {
      dot.textContent      = '⚠️ Erro Stage In';
      dot.style.background = '#cc7700';
      console.error('[Stage In]', e);
    }
  }

  // ── Indicador visual ────────────────────────────────────────────────
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
  dot.textContent = '📡 Stage In';
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);
  document.body.appendChild(dot);

  // ── Run ─────────────────────────────────────────────────────────────
  sync();
  setInterval(sync, INTERVAL);
})();
