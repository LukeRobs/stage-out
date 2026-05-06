// ==UserScript==
// @name         SPX Trips → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Sincroniza trips (viagens com ETA ±24h) com o dashboard de trips
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_BASE = 'https://stage-out.onrender.com';
  const SERVER_URL  = SERVER_BASE + '/api/trip-data';
  const API_URL     = '/api/admin/transportation/trip/list_v2';
  const INTERVAL    = 2 * 60 * 1000; // 2 min

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  function fetchPage(pageno, start, end) {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        station_type: '2,3,7,12,14,16,18',
        pageno:       String(pageno),
        count:        '50',
        query_type:   '1',
        tab_type:     '2',
        sta:          `${start},${end}`,
      });

      fetch(`${API_URL}?${params}`, {
        method:      'GET',
        credentials: 'include',
        headers:     { 'x-csrftoken': getCsrf() },
      })
        .then(res => res.text())
        .then(raw => {
          let json;
          try { json = JSON.parse(raw); }
          catch (e) { return reject(new Error(`Resposta não é JSON (status desconhecido): ${raw.substring(0, 120)}`)); }
          if (json.retcode !== 0) return reject(new Error(`API retcode ${json.retcode}: ${json.message || ''}`));
          resolve(json.data);
        })
        .catch(reject);
    });
  }

  async function fetchAllTrips() {
    const now   = Math.floor(Date.now() / 1000);
    const start = now - 24 * 3600;
    const end   = now + 24 * 3600;

    // First page to get total
    const first = await fetchPage(1, start, end);
    const total = first.total || 0;
    const allTrips = [...(first.list || [])];

    console.log(`[Trips Sync] Página 1: ${allTrips.length}/${total}`);

    let page = 2;
    while (allTrips.length < total) {
      const data = await fetchPage(page, start, end);
      const chunk = data.list || [];
      if (chunk.length === 0) break;
      allTrips.push(...chunk);
      console.log(`[Trips Sync] Página ${page}: ${allTrips.length}/${total}`);
      page++;
    }

    return allTrips;
  }

  function sendToServer(payload) {
    GM_xmlhttpRequest({
      method:  'POST',
      url:     SERVER_URL,
      headers: { 'Content-Type': 'application/json' },
      data:    JSON.stringify(payload),
      onload: (res) => {
        const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        setBadge(`📦 Trips · ${time}`, '#059669');
        console.log(`[Trips Sync] ${payload.list.length} trips enviadas às ${time}`);
      },
      onerror: () => {
        setBadge('📦 Trips · erro servidor', '#cc5500');
        console.error('[Trips Sync] Falha ao enviar para o servidor');
      },
    });
  }

  async function sync() {
    setBadge('📦 Trips · sincronizando…', '#888');
    try {
      const list = await fetchAllTrips();
      sendToServer({ list, total: list.length, fetchedAt: Date.now() });
    } catch (e) {
      setBadge('📦 Trips · erro API', '#cc5500');
      console.error('[Trips Sync]', e);
    }
  }

  // ── Badge visual ────────────────────────────────────────────────────────────
  const badge = document.createElement('div');
  badge.style.cssText = [
    'position:fixed', 'bottom:16px', 'right:16px',
    'background:#059669', 'color:#fff',
    'padding:6px 14px', 'border-radius:20px',
    'font-size:12px', 'font-family:sans-serif',
    'z-index:2147483647', 'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    'user-select:none', 'transition:background .3s',
  ].join(';');
  badge.textContent = '📦 Trips';
  badge.title = 'Clique para sincronizar agora';
  badge.addEventListener('click', sync);
  document.body.appendChild(badge);

  function setBadge(text, color) {
    badge.textContent    = text;
    badge.style.background = color;
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  sync();
  setInterval(sync, INTERVAL);
})();
