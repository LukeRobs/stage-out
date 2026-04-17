// ==UserScript==
// @name         SPX Queue List → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Sincroniza fila de veículos (Queue List) com o dashboard local
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL = 'https://stage-out.onrender.com/api/queue-data';
  const API_URL    = '/api/in-station/dock_management/queue/list';
  const INTERVAL   = 60 * 1000; // 60s

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  // queue_status: 1=pending 2=assigned 3=occupied 4=on_hold 5=ended
  // Envia apenas ativos (status 1–4); status 5 (ended) é excluído da lista
  const ACTIVE_STATUSES = new Set([1, 2, 3, 4]);

  async function fetchQueue() {
    const res = await fetch(API_URL, {
      method:      'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrftoken':  getCsrf(),
      },
      body: JSON.stringify({ pageno: 1, count: 500, queue_type: 1, queue_status: '1,2,3,5,4' }),
    });
    const raw = await res.text();
    console.log('[Queue] raw response (200 chars):', raw.substring(0, 200));
    let json;
    try { json = JSON.parse(raw); }
    catch (e) { throw new Error(`Resposta não é JSON (status ${res.status}): ${raw.substring(0, 100)}`); }
    if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);

    const allList    = json.data.list || [];
    const activeList = allList.filter(v => ACTIVE_STATUSES.has(v.queue_status));
    console.log(`[Queue] ativos: ${activeList.length} / total API: ${json.data.total}`);

    return {
      list:           activeList,
      total:          json.data.total          || 0,
      pending_total:  json.data.pending_total  || 0,
      assigned_total: json.data.assigned_total || 0,
      on_hold_total:  json.data.on_hold_total  || 0,
      occupied_total: json.data.occupied_total || 0,
      ended_total:    json.data.ended_total    || 0,
      fetchedAt:      Date.now(),
    };
  }

  function sendToServer(data) {
    GM_xmlhttpRequest({
      method:  'POST',
      url:     SERVER_URL,
      headers: { 'Content-Type': 'application/json' },
      data:    JSON.stringify(data),
      onload: () => {
        dot.textContent      = '✅ Queue ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        dot.style.background = '#2563eb';
        console.log(`[Queue] ${data.list.length}/${data.total} veículos enviados`);
      },
      onerror: () => {
        dot.textContent      = '❌ Server offline';
        dot.style.background = '#cc0000';
        console.error('[Queue] Falha ao enviar para o servidor');
      },
    });
  }

  async function sync() {
    dot.textContent      = '🔄 Queue...';
    dot.style.background = '#888';
    try {
      const data = await fetchQueue();
      sendToServer(data);
    } catch (e) {
      dot.textContent      = '⚠️ Erro Queue';
      dot.style.background = '#cc7700';
      console.error('[Queue]', e);
    }
  }

  // ── Indicador visual ────────────────────────────────────────────────
  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:fixed', 'bottom:48px', 'right:16px',
    'background:#2563eb', 'color:#fff',
    'padding:6px 14px', 'border-radius:20px',
    'font-size:12px', 'font-family:sans-serif',
    'z-index:2147483647', 'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    'user-select:none',
  ].join(';');
  dot.textContent = '🚛 Queue List';
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);
  document.body.appendChild(dot);

  sync();
  setInterval(sync, INTERVAL);
})();
