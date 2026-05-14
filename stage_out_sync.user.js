// ==UserScript==
// @name         SPX Stage Out → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Sincroniza posições do staging outbound com o dashboard local
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL = 'https://stage-out.onrender.com/api/stage-data';
  const SEARCH_URL = '/api/in-station/outbound/outbound_staging_area/config/search';
  const PAGE_SIZE  = 100;
  const INTERVAL   = 60 * 1000; // 60s

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  async function fetchPage(pageno) {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrftoken': getCsrf(),
      },
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

  function sendToServer(data) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: SERVER_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data),
      onload: (r) => {
        dot.textContent = '✅ Sync ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        dot.style.background = '#2db55d';
        console.log('[SPX Sync] Enviado:', data.list.length, '/', data.total, 'posições');
      },
      onerror: (e) => {
        dot.textContent = '❌ Server offline';
        dot.style.background = '#cc0000';
        console.error('[SPX Sync] Erro ao enviar para server local:', e);
      },
    });
  }

  async function sync() {
    dot.textContent = '🔄 Sincronizando...';
    dot.style.background = '#ee4d2d';
    try {
      const data = await fetchAll();
      sendToServer(data);
    } catch (e) {
      dot.textContent = '⚠️ Erro API SPX';
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

  // ── Visual indicator ────────────────────────────────────────────────
  const dot = registerSyncDot('📡 Dashboard Sync', '#ee4d2d');
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);

  // ── Run ─────────────────────────────────────────────────────────────
  sync();
  setInterval(sync, INTERVAL);
})();
