// ==UserScript==
// @name         SPX TO Management → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.6
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/tos_sync.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/tos_sync.user.js
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

  // Range de um único dia (meia-noite até fim do dia, horário local).
  // A API só é confiável para uma janela de 1 dia por vez — um range multi-dia
  // num único parâmetro ctime pode voltar total=0 ou falhar no meio da paginação.
  // Por isso, para não perder TOs que ficam pendentes de um dia para o outro,
  // buscamos vários dias SEPARADAMENTE (ver DAYS_BACK) e mesclamos os resultados.
  const DAYS_BACK = 3; // hoje + 2 dias anteriores

  function getDayBounds(daysAgo) {
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    return {
      key:   `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`,
      start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0),
      end:   new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59),
    };
  }

  async function fetchPage(status, pageno, ctime) {
    const url = `${SEARCH_URL}?pageno=${pageno}&count=${PAGE_SIZE}&status=${status}&ctime=${ctime}`;
    const res = await fetch(url, { credentials: 'include' });
    return res.json();
  }

  async function fetchDay(status, start, end) {
    const ctime = `${Math.floor(start.getTime() / 1000)},${Math.floor(end.getTime() / 1000)}`;
    const first = await fetchPage(status, 1, ctime);
    if (first.retcode !== 0) throw new Error(`API retcode ${first.retcode}: ${first.message}`);
    const { total, list } = first.data;
    const pages = Math.ceil(total / PAGE_SIZE);
    let all = [...list];
    for (let p = 2; p <= pages; p++) {
      const r = await fetchPage(status, p, ctime);
      if (r.retcode === 0) all = all.concat(r.data.list);
    }
    return all;
  }

  // Cache do último resultado BEM-SUCEDIDO de cada dia (por status e data real).
  // Uma falha transitória (timeout, rate limit) num dia anterior não deve apagar
  // dados que já tínhamos coletado com sucesso — em vez de mandar [] pro servidor
  // e sobrescrever o cache bom, reaproveitamos o último resultado válido daquele dia.
  const dayResultCache = {}; // status -> Map(dateKey -> list) — criado sob demanda por status

  async function fetchAll(status) {
    if (!dayResultCache[status]) dayResultCache[status] = new Map();
    const cache = dayResultCache[status];
    const days  = Array.from({ length: DAYS_BACK }, (_, daysAgo) => getDayBounds(daysAgo));
    const validKeys = new Set(days.map(d => d.key));

    // Remove do cache datas que já saíram da janela de lookback
    for (const key of cache.keys()) if (!validKeys.has(key)) cache.delete(key);

    await Promise.all(days.map(async ({ key, start, end }) => {
      try {
        cache.set(key, await fetchDay(status, start, end));
      } catch (e) {
        console.warn(`[TO Sync] falha ao buscar ${key} (status ${status}), mantendo último resultado conhecido:`, e.message);
        // mantém o que já estava em cache para essa data (se houver)
      }
    }));

    // Mescla e deduplica por to_number. Processamos do dia mais antigo para o mais
    // recente para que, em caso de conflito, o snapshot mais atual sempre vença —
    // sem isso, uma TO já endereçada/despachada podia continuar aparecendo como
    // "Packed sem staging" por causa de um registro desatualizado de dia anterior.
    const merged = new Map();
    for (const { key } of [...days].reverse()) {
      for (const to of cache.get(key) || []) merged.set(to.to_number, to);
    }
    const all = [...merged.values()];
    return { list: all, total: all.length, fetchedAt: Date.now() };
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

  // Estação inferida a partir do resultado (confiável) de Packing/Packed — usada pelo
  // backfill de SACAS abaixo pra sobrescrever o current_station_id de status pós-Packed,
  // que pode já apontar pro destino em vez de quem empacotou de verdade (confirmado: TOs
  // em "Partially Received" mostram current_station_id do destino, mas sender continua
  // sendo a estação de origem).
  let myStationId = null;

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
      myStationId = packing.list[0]?.current_station_id ?? packed.list[0]?.current_station_id ?? myStationId;
    } catch (e) {
      dot.textContent    = '⚠️ Erro API TOs';
      dot.style.background = '#cc7700';
      console.error('[TO Sync]', e);
    }
  }

  // ── Backfill de SACAS ──────────────────────────────────────────────────
  // status=2 (Packed) sozinho perde TOs que saem desse status rápido demais entre um
  // ciclo de 60s e outro (confirmado: buracos de 7-18% na produção real). Esses status
  // pós-Packed mantêm o complete_time (horário real de conclusão) gravado pra sempre —
  // buscando eles também, fechamos os buracos retroativamente (dentro da janela de
  // DAYS_BACK dias), sem depender de "flagrar" a TO ainda em Packed.
  //   4  = Transporting        9  = Partially Received
  //   5  = Transported         10 = LHPacking
  //   6  = Received            11 = LHPacked
  // Roda num intervalo bem mais espaçado que o sync principal — não precisa ser em tempo
  // real (é um "preenchimento de buraco" por natureza) e evita multiplicar por 4x a carga
  // de requisições contra o SPX a cada 60s.
  const BACKFILL_STATUSES     = [4, 5, 6, 9, 10, 11];
  const BACKFILL_INTERVAL_MS  = 5 * 60 * 1000; // 5min

  async function syncBackfill() {
    if (myStationId == null) return; // ainda não sabemos a estação — espera o próximo sync() normal
    try {
      const lists  = await Promise.all(BACKFILL_STATUSES.map(s => fetchAll(s)));
      const merged = [];
      lists.forEach(r => merged.push(...r.list));
      // Sobrescreve current_station_id com o valor confiável (ver myStationId acima) —
      // nunca confia no current_station_id que vem nesses status específicos.
      const tagged = merged.map(to => ({ ...to, current_station_id: myStationId }));
      sendToServer('/api/sacas-backfill-data', { list: tagged, total: tagged.length, fetchedAt: Date.now() }, 'SACAS Backfill');
    } catch (e) {
      console.error('[TO Sync] Backfill de SACAS falhou:', e.message);
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
  const dot = registerSyncDot('📡 TO Sync', '#ee4d2d');
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);

  // ── Run ─────────────────────────────────────────────────────────────
  sync();
  setInterval(sync, INTERVAL);
  setTimeout(syncBackfill, 5000); // primeira leva logo após o 1º sync (já ter myStationId)
  setInterval(syncBackfill, BACKFILL_INTERVAL_MS);
})();
