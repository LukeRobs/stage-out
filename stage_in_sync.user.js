// ==UserScript==
// @name         SPX Inbound Staging Area → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.1
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

  // ── Indicador visual ────────────────────────────────────────────────
  const dot = registerSyncDot('📡 Stage In', '#888');
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);

  // ── Run ─────────────────────────────────────────────────────────────
  sync();
  setInterval(sync, INTERVAL);
})();
