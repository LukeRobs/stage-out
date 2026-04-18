// ==UserScript==
// @name         SPX Trip History → Transbordo Dashboard
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Sincroniza histórico de Linehaul trips com o dashboard Transbordo
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL = 'https://stage-out.onrender.com/api/trip-history-data';
  const API_URL    = '/api/admin/transportation/trip/history/list';
  const INTERVAL   = 5 * 60 * 1000; // 5 minutos
  const DAYS_BACK  = 7;              // últimos 7 dias

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  async function fetchPage(pageno) {
    const now   = Math.floor(Date.now() / 1000);
    const start = now - DAYS_BACK * 86400;
    const params = new URLSearchParams({
      mtime:  `${start},${now}`,
      pageno: `${pageno}`,
      count:  '500',
    });
    const res = await fetch(`${API_URL}?${params}`, {
      credentials: 'include',
      headers: { 'x-csrftoken': getCsrf() },
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch (e) { throw new Error(`Resposta não é JSON (status ${res.status})`); }
    if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
    return json.data;
  }

  function sendToServer(list, total) {
    GM_xmlhttpRequest({
      method:  'POST',
      url:     SERVER_URL,
      headers: { 'Content-Type': 'application/json' },
      data:    JSON.stringify({ list, total, fetchedAt: Date.now() }),
      onload: r => {
        if (r.status === 200) {
          dot.textContent      = '✅ Histórico ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
          dot.style.background = '#059669';
          console.log(`[TripHistory] ${list.length} trips enviados ao servidor`);
        } else {
          dot.textContent      = '❌ Erro servidor';
          dot.style.background = '#cc0000';
          console.error('[TripHistory] Resposta:', r.status, r.responseText);
        }
      },
      onerror: () => {
        dot.textContent      = '❌ Servidor offline';
        dot.style.background = '#cc0000';
        console.error('[TripHistory] Falha de rede ao enviar');
      },
    });
  }

  async function sync() {
    dot.textContent      = '🔄 Histórico...';
    dot.style.background = '#888';
    try {
      // Página 1 (até 500 trips)
      const page1 = await fetchPage(1);
      let list    = page1.list || [];
      const total = page1.total || 0;

      // Página 2 se houver mais (até 1000 trips = cobertura de ~7 dias)
      if (total > 500) {
        try {
          const page2 = await fetchPage(2);
          list = list.concat(page2.list || []);
          console.log(`[TripHistory] Pág 2: +${page2.list?.length || 0} trips`);
        } catch (e) {
          console.warn('[TripHistory] Erro na página 2:', e.message);
        }
      }

      sendToServer(list, total);
      console.log(`[TripHistory] Total: ${list.length} trips (${total} no servidor)`);
    } catch (e) {
      dot.textContent      = '⚠️ Erro Histórico';
      dot.style.background = '#cc7700';
      console.error('[TripHistory]', e.message);
    }
  }

  // ── Badge visual ─────────────────────────────────────────────────────
  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:fixed', 'bottom:120px', 'right:16px',
    'background:#7c3aed', 'color:#fff',
    'padding:6px 14px', 'border-radius:20px',
    'font-size:12px', 'font-family:sans-serif',
    'z-index:2147483647', 'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    'user-select:none',
  ].join(';');
  dot.textContent = '📅 Trip History';
  dot.title = 'Clique para sincronizar histórico agora';
  dot.addEventListener('click', () => {
    if (dot.textContent.includes('🔄')) return;
    sync();
  });
  document.body.appendChild(dot);

  sync();
  setInterval(sync, INTERVAL);

  console.log('[TripHistory] ✅ v1.0 — Histórico Linehaul, a cada 5min');
})();
