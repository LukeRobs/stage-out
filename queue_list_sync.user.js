// ==UserScript==
// @name         SPX Queue List → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.2
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/queue_list_sync.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/queue_list_sync.user.js
// @description  Sincroniza fila de veículos (Queue List) com o dashboard local
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL  = 'https://stage-out.onrender.com/api/queue-data';
  const API_URL     = '/api/in-station/dock_management/queue/list';
  const DETAIL_URL  = '/api/admin/transportation/trip/detail';
  const DETAIL_BATCH = 10;   // chamadas paralelas ao endpoint de detalhe
  const INTERVAL    = 60 * 1000; // 60s

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  // queue_status: 1=pending 2=assigned 3=occupied 5=on_hold 4=ended
  // Envia apenas ativos (status 1,2,3,5); status 4 (ended) é excluído da lista
  const ACTIVE_STATUSES = new Set([1, 2, 3, 5]);

  // ── Detalhe individual de viagem (trip_station, ETA/ATA, etc.) ────────
  async function fetchTripDetail(tripId) {
    const res = await fetch(`${DETAIL_URL}?trip_id=${tripId}`, {
      credentials: 'include',
      headers: { 'x-csrftoken': getCsrf() },
    });
    const json = await res.json();
    if (json.retcode !== 0) return null;
    return json.data;
  }

  async function enrichWithDetails(list) {
    const eligible = list.filter(q => q.route_info?.lh_trip_id);
    let enriched = 0;
    for (let i = 0; i < eligible.length; i += DETAIL_BATCH) {
      const batch = eligible.slice(i, i + DETAIL_BATCH);
      await Promise.all(batch.map(async q => {
        try {
          const d = await fetchTripDetail(q.route_info.lh_trip_id);
          if (d) {
            q._trip_detail = {
              trip_station:      d.trip_station      || [],
              trip_status:       d.trip_status,
              vehicle_type_name: d.vehicle_type_name || '',
              pre_station_name:  d.trip_station?.[0]?.station_name || '',
            };
            enriched++;
          }
        } catch (e) {
          console.warn('[Queue] detail err', q.route_info.lh_trip_id, e);
        }
      }));
    }
    console.log(`[Queue] enriched ${enriched}/${eligible.length} LTs com trip_station`);
  }

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
    let json;
    try { json = JSON.parse(raw); }
    catch (e) { throw new Error(`Resposta não é JSON (status ${res.status}): ${raw.substring(0, 100)}`); }
    if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);

    const allList    = json.data.list || [];
    const activeList = allList.filter(v => ACTIVE_STATUSES.has(v.queue_status));
    console.log(`[Queue] ativos: ${activeList.length} / total API: ${json.data.total}`);

    // Enriquece cada item com trip_station (ETA/ATA) via endpoint de detalhe
    dot.textContent      = '🔍 Detalhes LTs...';
    dot.style.background = '#6366f1';
    await enrichWithDetails(activeList);

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
  const dot = registerSyncDot('🚛 Queue List', '#2563eb');
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);

  sync();
  setInterval(sync, INTERVAL);
})();
