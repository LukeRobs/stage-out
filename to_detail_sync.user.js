// ==UserScript==
// @name         SPX TO Detail → Dashboard Relay
// @namespace    http://tampermonkey.net/
// @version      1.2
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/to_detail_sync.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/to_detail_sync.user.js
// @description  Atende sob demanda pedidos de detalhe de TO (tos_packed/packing) e de rua (stage_out) vindos do dashboard
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_BASE   = 'https://stage-out.onrender.com';
  const PENDING_URL   = SERVER_BASE + '/api/to-detail-pending';
  const AUTO_PENDING_URL = SERVER_BASE + '/api/to-detail-pending-auto';
  const RESULT_URL    = SERVER_BASE + '/api/to-detail-result';
  const DETAIL_URL    = '/api/in-station/general_to/detail/search';
  const RUA_PENDING_URL = SERVER_BASE + '/api/rua-detail-pending';
  const RUA_RESULT_URL  = SERVER_BASE + '/api/rua-detail-result';
  const RUA_DETAIL_URL  = '/api/in-station/outbound/outbound_staging_area/details';
  const POLL_INTERVAL = 3000; // 3s — precisa ser responsivo, o usuário está esperando o modal abrir
  const AUTO_POLL_INTERVAL = 4000; // 4s — fila separada da revalidação em segundo plano
  const PAGE_SIZE     = 200;  // cobre TOs com bastante pacotes numa unica pagina

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  function gmGetJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  function gmPostJson(url, data) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(data),
        onload: resolve,
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  // Busca todas as paginas de pacotes de uma TO (raro precisar de mais de uma pagina)
  async function fetchToDetail(to_number) {
    let pageno = 1;
    let all    = [];
    let total  = 0;
    let toMeta = null;
    while (true) {
      const params = new URLSearchParams({ to_number, pageno: String(pageno), count: String(PAGE_SIZE) });
      const res  = await fetch(`${DETAIL_URL}?${params}`, {
        credentials: 'include',
        headers: { 'x-csrftoken': getCsrf() },
      });
      const raw  = await res.text();
      let json;
      try { json = JSON.parse(raw); }
      catch (e) { throw new Error(`Resposta não é JSON (status ${res.status})`); }
      if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
      const d = json.data || {};
      if (!toMeta) { toMeta = { ...d }; delete toMeta.list; }
      total = d.total || 0;
      all   = all.concat(d.list || []);
      if (all.length >= total || !d.list?.length || pageno > 10) break;
      pageno++;
    }
    return { ...toMeta, list: all, total };
  }

  async function processPending() {
    let pendingData;
    try { pendingData = await gmGetJson(PENDING_URL); }
    catch (e) { return; }
    const pending = pendingData?.pending || [];
    if (!pending.length) {
      dot.textContent = '📦 TO Detail · aguardando';
      dot.style.background = '#475569';
      return;
    }

    for (const to_number of pending) {
      dot.textContent = `📦 Buscando ${to_number}...`;
      dot.style.background = '#0ea5e9';
      try {
        const data = await fetchToDetail(to_number);
        await gmPostJson(RESULT_URL, { to_number, data });
        dot.textContent = `✅ ${to_number} (${data.list.length} pac.)`;
        dot.style.background = '#059669';
        console.log(`[TO Detail] ${to_number}: ${data.list.length} pacotes enviados`);
      } catch (e) {
        await gmPostJson(RESULT_URL, { to_number, error: e.message }).catch(() => {});
        dot.textContent = `⚠️ Erro em ${to_number}`;
        dot.style.background = '#cc7700';
        console.warn(`[TO Detail] erro em ${to_number}:`, e.message);
      }
    }
  }

  // Fila separada da revalidação automática em segundo plano — roda de forma totalmente
  // independente do processPending() acima, pra uma leva grande de itens automáticos nunca
  // segurar um pedido manual (clique no modal) atrás dela (o loop antigo buscava a lista uma
  // vez e processava tudo em sequência antes de checar de novo, então um clique manual podia
  // ficar preso minutos atrás de uma leva de 60 automáticos).
  async function processAutoPending() {
    let pendingData;
    try { pendingData = await gmGetJson(AUTO_PENDING_URL); }
    catch (e) { return; }
    const pending = pendingData?.pending || [];
    if (!pending.length) {
      autoDot.textContent = '🔄 Revalidação · aguardando';
      autoDot.style.background = '#475569';
      return;
    }

    for (const to_number of pending) {
      autoDot.textContent = `🔄 Revalidando ${to_number}...`;
      autoDot.style.background = '#0ea5e9';
      try {
        const data = await fetchToDetail(to_number);
        await gmPostJson(RESULT_URL, { to_number, data });
        autoDot.textContent = `✅ ${to_number} revalidada`;
        autoDot.style.background = '#059669';
      } catch (e) {
        await gmPostJson(RESULT_URL, { to_number, error: e.message }).catch(() => {});
        autoDot.textContent = `⚠️ Erro em ${to_number}`;
        autoDot.style.background = '#cc7700';
      }
    }
  }

  // Busca TOs/gaiolas alocadas numa rua (staging_area_id), com paginação
  async function fetchRuaDetail(staging_area_id) {
    let pageno  = 1;
    let all     = [];
    let total   = 0;
    let baseInfo = null;
    while (true) {
      const params = new URLSearchParams({ staging_area_id, pageno: String(pageno), count: String(PAGE_SIZE) });
      const res  = await fetch(`${RUA_DETAIL_URL}?${params}`, {
        credentials: 'include',
        headers: { 'x-csrftoken': getCsrf() },
      });
      const raw  = await res.text();
      let json;
      try { json = JSON.parse(raw); }
      catch (e) { throw new Error(`Resposta não é JSON (status ${res.status})`); }
      if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
      const d = json.data || {};
      if (!baseInfo) baseInfo = d.staging_area_base_info || {};
      const item = d.staging_area_item || {};
      total = item.total || 0;
      all   = all.concat(item.list || []);
      if (all.length >= total || !item.list?.length || pageno > 10) break;
      pageno++;
    }
    return { ...baseInfo, items: all, total };
  }

  async function processRuaPending() {
    let pendingData;
    try { pendingData = await gmGetJson(RUA_PENDING_URL); }
    catch (e) { return; }
    const pending = pendingData?.pending || [];
    if (!pending.length) {
      ruaDot.textContent = '🛣 Rua Detail · aguardando';
      ruaDot.style.background = '#475569';
      return;
    }

    for (const staging_area_id of pending) {
      ruaDot.textContent = `🛣 Buscando ${staging_area_id}...`;
      ruaDot.style.background = '#0ea5e9';
      try {
        const data = await fetchRuaDetail(staging_area_id);
        await gmPostJson(RUA_RESULT_URL, { staging_area_id, data });
        ruaDot.textContent = `✅ ${staging_area_id} (${data.items.length} itens)`;
        ruaDot.style.background = '#059669';
        console.log(`[Rua Detail] ${staging_area_id}: ${data.items.length} itens enviados`);
      } catch (e) {
        await gmPostJson(RUA_RESULT_URL, { staging_area_id, error: e.message }).catch(() => {});
        ruaDot.textContent = `⚠️ Erro em ${staging_area_id}`;
        ruaDot.style.background = '#cc7700';
        console.warn(`[Rua Detail] erro em ${staging_area_id}:`, e.message);
      }
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
  const dot = registerSyncDot('📦 TO Detail', '#475569');
  dot.title = 'Atende pedidos de detalhe de pacotes de TO vindos do dashboard (clique manual)';

  const ruaDot = registerSyncDot('🛣 Rua Detail', '#475569');
  ruaDot.title = 'Atende pedidos de detalhe de TOs/gaiolas de uma rua vindos do dashboard';

  const autoDot = registerSyncDot('🔄 Revalidação', '#475569');
  autoDot.title = 'Revalida em segundo plano TOs antigas do dashboard (fila separada, não atrasa cliques manuais)';

  // ── Run ─────────────────────────────────────────────────────────────
  processPending();
  processRuaPending();
  processAutoPending();
  setInterval(processPending, POLL_INTERVAL);
  setInterval(processRuaPending, POLL_INTERVAL);
  setInterval(processAutoPending, AUTO_POLL_INTERVAL);
})();
