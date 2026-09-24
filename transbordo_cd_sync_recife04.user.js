// ==UserScript==
// @name         SPX Transbordo CD → Dashboard Sync · Recife 04
// @namespace    http://tampermonkey.net/
// @version      1.1
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/transbordo_cd_sync_recife04.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/transbordo_cd_sync_recife04.user.js
// @description  Sincroniza TOs de transbordo (cd_flag) — busca viagem por viagem via trip/history/loading/list e manda só as marcadas CD pro dashboard Transbordo
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_BASE     = 'https://stage-out.onrender.com';
  const SERVER_URL      = `${SERVER_BASE}/api/transbordo-cd-data`;
  // ID da estação deste computador — MUDE aqui ao instalar numa estação diferente
  const STATION_ID  = '15000'; // SoC_PE_Recife_04
  const STATION_NUM = 15000;
  const TRIPS_URL        = `${SERVER_BASE}/api/trips?station=${STATION_ID}`;
  const TRIP_HISTORY_URL = `${SERVER_BASE}/api/trip-history?station=${STATION_ID}`;
  const LOADING_URL      = '/api/admin/transportation/trip/history/loading/list';
  const INTERVAL         = 5 * 60 * 1000; // 5 minutos — mesmo ritmo do trip_history_sync

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  const PAGE_SIZE = 100;

  function gmGetJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload:  r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  // ── Viagens já totalmente descarregadas nesta estação não mudam mais — evita
  // rebater na API de novo a cada ciclo (cada viagem custa 1+ chamadas extras).
  const DONE_KEY = 'tbCdDoneTrips';
  function loadDone() {
    try { return new Set(JSON.parse(GM_getValue(DONE_KEY, '[]'))); }
    catch (e) { return new Set(); }
  }
  function saveDone(set) {
    GM_setValue(DONE_KEY, JSON.stringify([...set].slice(-3000))); // corta pra nao crescer pra sempre
  }
  const doneTrips = loadDone();

  // Acha a "perna" da viagem que chega NESTA estação (pode não ser a última —
  // um LH pode continuar depois daqui).
  function findDestEntry(trip) {
    return trip.trip_station?.find(s => s.station === STATION_NUM) || null;
  }

  // Reaproveita os dados que o trip_list_sync (viagens ao vivo) e o trip_history_sync
  // (últimos 7 dias) já mantêm sincronizados no nosso servidor — em vez de refazer a
  // paginação da SPX aqui (que descobrimos ficar aquém do volume real da estação e
  // deixava viagens de fora, mesmo com cd_flag=true de verdade).
  async function fetchCandidateTrips() {
    const [liveData, histData] = await Promise.all([
      gmGetJson(TRIPS_URL).catch(e => { console.warn('[TransbordoCD] Falha ao ler /api/trips:', e.message); return { list: [] }; }),
      gmGetJson(TRIP_HISTORY_URL).catch(e => { console.warn('[TransbordoCD] Falha ao ler /api/trip-history:', e.message); return { list: [] }; }),
    ]);
    const map = new Map();
    [...(liveData.list || []), ...(histData.list || [])].forEach(t => { if (t.id) map.set(t.id, t); });
    // Só interessam viagens que já chegaram (ata>0) nesta estação especificamente
    return [...map.values()]
      .map(trip => ({ trip, dest: findDestEntry(trip) }))
      .filter(x => x.dest && x.dest.ata > 0);
  }

  async function fetchLoadingPage(tripId, seq, pageno) {
    const params = new URLSearchParams({
      trip_id: String(tripId),
      pageno:  String(pageno),
      count:   String(PAGE_SIZE),
      actual_unloaded_sequence_number: String(seq),
      type:    'inbound',
    });
    const res = await fetch(`${LOADING_URL}?${params}`, {
      credentials: 'include',
      headers: { 'x-csrftoken': getCsrf() },
    });
    const raw = await res.text();
    let json;
    try { json = JSON.parse(raw); }
    catch (e) { throw new Error(`Resposta não é JSON (status ${res.status})`); }
    if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
    return json.data;
  }

  // Busca todos os TOs (paginado) de uma viagem nesta estação e devolve só os cd_flag=true
  async function fetchCdTosForTrip(trip, dest) {
    const seq   = dest.actual_unloaded_sequence_number || dest.unloaded_sequence_number || 1;
    const first = await fetchLoadingPage(trip.id, seq, 1);
    const total = first.total || 0;
    let list    = first.list || [];
    const pages = Math.min(Math.ceil(total / PAGE_SIZE), 10);
    for (let p = 2; p <= pages; p++) {
      const d = await fetchLoadingPage(trip.id, seq, p);
      list = list.concat(d.list || []);
    }

    const cdList = list.filter(to => to.cd_flag === true).map(to => ({
      to_number:             to.to_number,
      to_weight:             to.to_weight,
      to_parcel_quantity:    to.to_parcel_quantity,
      to_quantity:           to.to_quantity,
      pack_type_name:        to.pack_type_name,
      loaded_station_name:   to.loaded_station_name,
      unloaded_station_name: to.unloaded_station_name,
      unloaded_time:         to.unloaded_time,
      dock_number:           to.dock_number,
      operator:              to.operator,
      abnormal_labels:       to.abnormal_labels || null,
      trip_id:               trip.id,
      trip_number:           trip.trip_number,
      vehicle_number:        trip.vehicle_number,
      driver_name:           trip.driver_name,
    }));

    const finished = dest.unloaded_time > 0 || dest.trip_station_status === 100;
    return { cdList, finished };
  }

  function sendToServer(list) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'POST',
        url:     SERVER_URL,
        headers: { 'Content-Type': 'application/json' },
        data:    JSON.stringify({ list, fetchedAt: Date.now(), station_id: STATION_ID }),
        onload:  r => (r.status === 200 ? resolve() : reject(new Error(`status ${r.status}`))),
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  async function sync() {
    dot.textContent      = '🔄 CD...';
    dot.style.background = '#888';
    try {
      const candidates = await fetchCandidateTrips();
      const toProcess  = candidates.filter(x => !doneTrips.has(x.trip.id));

      let allCd = [];
      let newlyDone = 0;
      for (const { trip, dest } of toProcess) {
        try {
          const { cdList, finished } = await fetchCdTosForTrip(trip, dest);
          allCd = allCd.concat(cdList);
          if (finished) { doneTrips.add(trip.id); newlyDone++; }
        } catch (e) {
          console.warn(`[TransbordoCD] Erro na viagem ${trip.id}:`, e.message);
        }
      }
      if (newlyDone) saveDone(doneTrips);
      // Manda mesmo com lista vazia — isso atualiza o fetchedAt no servidor, provando
      // pro dashboard que o sync rodou com sucesso (só não achou nenhuma TO com CD ainda).
      // Sem isso, o dashboard não tem como distinguir "nunca sincronizou" de "sincronizou e achou zero".
      await sendToServer(allCd);

      dot.textContent      = `✅ CD ${allCd.length}/${toProcess.length}v ` + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      dot.style.background = '#059669';
      console.log(`[TransbordoCD] ${allCd.length} TOs CD em ${toProcess.length} viagens processadas (${candidates.length} candidatas, ${doneTrips.size} já concluídas)`);
    } catch (e) {
      dot.textContent      = '⚠️ Erro CD';
      dot.style.background = '#cc7700';
      console.error('[TransbordoCD]', e.message);
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

  // ── Badge visual ─────────────────────────────────────────────────────
  const dot = registerSyncDot('🔀 Transbordo CD', '#ee4d2d');
  dot.title = 'Clique para sincronizar TOs de transbordo (CD) agora';
  dot.addEventListener('click', () => {
    if (dot.textContent.includes('🔄')) return;
    sync();
  });

  sync();
  setInterval(sync, INTERVAL);

  console.log('[TransbordoCD] ✅ v1.0 — TOs de transbordo (cd_flag), a cada 5min');
})();
