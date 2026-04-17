// ==UserScript==
// @name         SPX Trip List → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Sincroniza trip list (viagens em trânsito) com o dashboard local
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL = 'https://stage-out.onrender.com/api/trip-data';
  const API_URL    = '/api/admin/transportation/trip/list_v2';
  const INTERVAL   = 60 * 1000; // 60s

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  async function fetchTrips() {
    const now   = Math.floor(Date.now() / 1000);
    const start = now - 24 * 3600;  // -24h
    const end   = now + 24 * 3600;  // +24h

    const params = new URLSearchParams({
      station_type:        '2,3,7,12,14,16,18',
      trip_station_status: '50,60',   // 50=em trânsito/chegando, 60=na doca/descarregando
      pageno:              '1',
      count:               '500',
      query_type:          '1',
      tab_type:            '2',
      sta:                 `${start},${end}`,
    });

    const res = await fetch(`${API_URL}?${params}`, {
      method:      'GET',
      credentials: 'include',
      headers: {
        'x-csrftoken': getCsrf(),
      },
    });

    const raw = await res.text();
    let json;
    try { json = JSON.parse(raw); }
    catch (e) { throw new Error(`Resposta não é JSON (status ${res.status}): ${raw.substring(0, 100)}`); }
    if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);

    const list = json.data.list || [];
    console.log(`[Trips] ${list.length}/${json.data.total} viagens recebidas`);
    return { list, total: json.data.total || 0, fetchedAt: Date.now() };
  }

  function sendToServer(data) {
    GM_xmlhttpRequest({
      method:  'POST',
      url:     SERVER_URL,
      headers: { 'Content-Type': 'application/json' },
      data:    JSON.stringify(data),
      onload: () => {
        dot.textContent      = '✅ Trips ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        dot.style.background = '#059669';
        console.log(`[Trips] ${data.list.length} viagens enviadas`);
      },
      onerror: () => {
        dot.textContent      = '❌ Server offline';
        dot.style.background = '#cc0000';
        console.error('[Trips] Falha ao enviar para o servidor');
      },
    });
  }

  async function sync() {
    dot.textContent      = '🔄 Trips...';
    dot.style.background = '#888';
    try {
      const data = await fetchTrips();
      sendToServer(data);
    } catch (e) {
      dot.textContent      = '⚠️ Erro Trips';
      dot.style.background = '#cc7700';
      console.error('[Trips]', e);
    }
  }

  // ── Indicador visual ────────────────────────────────────────────────
  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:fixed', 'bottom:84px', 'right:16px',
    'background:#059669', 'color:#fff',
    'padding:6px 14px', 'border-radius:20px',
    'font-size:12px', 'font-family:sans-serif',
    'z-index:2147483647', 'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    'user-select:none',
  ].join(';');
  dot.textContent = '🚚 Trip List';
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);
  document.body.appendChild(dot);

  sync();
  setInterval(sync, INTERVAL);
})();
