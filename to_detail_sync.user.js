// ==UserScript==
// @name         SPX TO Detail → Dashboard Relay
// @namespace    http://tampermonkey.net/
// @version      1.5
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

  // Cache-buster pras chamadas de "pending" (GET) — sem isso, o navegador ou o proprio
  // Tampermonkey pode servir uma resposta antiga em cache indefinidamente pra essa URL,
  // fazendo o loop achar que nunca tem nada pendente mesmo com pedidos reais no servidor.
  function bust(url) {
    return url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
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
    try { pendingData = await gmGetJson(bust(PENDING_URL)); }
    catch (e) { return; }
    const pending = pendingData?.pending || [];
    if (!pending.length) {
      setStatus('to', '—');
      return;
    }

    for (const to_number of pending) {
      setStatus('to', `⏳ ${to_number}`);
      try {
        const data = await fetchToDetail(to_number);
        await gmPostJson(RESULT_URL, { to_number, data });
        setStatus('to', `✅ ${to_number}`);
        console.log(`[TO Detail] ${to_number}: ${data.list.length} pacotes enviados`);
      } catch (e) {
        await gmPostJson(RESULT_URL, { to_number, error: e.message }).catch(() => {});
        setStatus('to', `⚠️ ${to_number}`);
        console.warn(`[TO Detail] erro em ${to_number}:`, e.message);
      }
    }
  }

  // Fila separada da revalidação automática em segundo plano — roda de forma totalmente
  // independente do processPending() acima, pra uma leva grande de itens automáticos nunca
  // segurar um pedido manual (clique no modal) atrás dela (o loop antigo buscava a lista uma
  // vez e processava tudo em sequência antes de checar de novo, então um clique manual podia
  // ficar preso minutos atrás de uma leva de 60 automáticos).
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function processAutoPending() {
    let pendingData;
    try { pendingData = await gmGetJson(bust(AUTO_PENDING_URL)); }
    catch (e) { return; }
    const pending = pendingData?.pending || [];
    if (!pending.length) {
      setStatus('auto', '—');
      return;
    }

    for (const to_number of pending) {
      setStatus('auto', `⏳ ${to_number}`);
      try {
        const data = await fetchToDetail(to_number);
        await gmPostJson(RESULT_URL, { to_number, data });
        setStatus('auto', `✅ ${to_number}`);
      } catch (e) {
        await gmPostJson(RESULT_URL, { to_number, error: e.message }).catch(() => {});
        setStatus('auto', `⚠️ ${to_number}`);
      }
      // Pequena pausa entre cada item — evita rajada de requisições contra o SPX,
      // que pode estar sendo throttled/limitado do lado deles (ou pela conexao do navegador),
      // atrasando ate os pedidos manuais que ficam presos na fila propria.
      await sleep(400);
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
    try { pendingData = await gmGetJson(bust(RUA_PENDING_URL)); }
    catch (e) { return; }
    const pending = pendingData?.pending || [];
    if (!pending.length) {
      setStatus('rua', '—');
      return;
    }

    for (const staging_area_id of pending) {
      setStatus('rua', `⏳ ${staging_area_id}`);
      try {
        const data = await fetchRuaDetail(staging_area_id);
        await gmPostJson(RUA_RESULT_URL, { staging_area_id, data });
        setStatus('rua', `✅ ${staging_area_id}`);
        console.log(`[Rua Detail] ${staging_area_id}: ${data.items.length} itens enviados`);
      } catch (e) {
        await gmPostJson(RUA_RESULT_URL, { staging_area_id, error: e.message }).catch(() => {});
        setStatus('rua', `⚠️ ${staging_area_id}`);
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

  // ── Indicador visual — um único badge combinado (evita empilhar 3 badges no hub) ──
  const relayDot = registerSyncDot('📦 Relay', '#475569');
  relayDot.title = 'TO Detail (clique manual) · Rua Detail (clique manual) · Revalidação (segundo plano)';

  const status = { to: '—', rua: '—', auto: '—' };
  function setStatus(key, text) {
    status[key] = text;
    relayDot.textContent = `📦${status.to} 🛣${status.rua} 🔄${status.auto}`;
    const anyBusy = Object.values(status).some(s => s.startsWith('⏳'));
    const anyErr  = Object.values(status).some(s => s.startsWith('⚠️'));
    relayDot.style.background = anyBusy ? '#0ea5e9' : anyErr ? '#cc7700' : '#475569';
  }

  // ── Run ─────────────────────────────────────────────────────────────
  processPending();
  processRuaPending();
  processAutoPending();
  setInterval(processPending, POLL_INTERVAL);
  setInterval(processRuaPending, POLL_INTERVAL);
  setInterval(processAutoPending, AUTO_POLL_INTERVAL);
})();
