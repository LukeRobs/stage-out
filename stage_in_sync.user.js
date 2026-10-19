// ==UserScript==
// @name         SPX Inbound Staging Area → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.3
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/stage_in_sync.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/stage_in_sync.user.js
// @description  Sincroniza dados do Inbound Staging Area com o dashboard
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      stage-out.onrender.com
// @connect      gestao-colaboradores-backend.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  // ── COPEOPLE (envio duplo durante a migração) ───────────────────────────
  // Os mesmos dados também vão para o COPEOPLE. O token NÃO fica neste arquivo (o repositório é público):
  // é digitado uma única vez em cada máquina e fica guardado no Tampermonkey (e no localStorage do SPX, para
  // os outros scripts desta máquina não pedirem de novo). Sem token o envio ao COPEOPLE é simplesmente
  // pulado e o servidor antigo continua como sempre.
  const COPEOPLE_HOST   = 'gestao-colaboradores-backend.onrender.com';
  const COPEOPLE_INGEST = `https://${COPEOPLE_HOST}/api/spx-ingest`;
  const TOKEN_KEY       = 'copeopleIngestToken';

  function getCopeopleToken() {
    let t = GM_getValue(TOKEN_KEY, '') || localStorage.getItem(TOKEN_KEY) || '';
    if (t) {
      GM_setValue(TOKEN_KEY, t);
      localStorage.setItem(TOKEN_KEY, t);
      return t;
    }
    // Pergunta no máximo 1x a cada 12h por máquina (deixar em branco = pular).
    if (Date.now() - Number(GM_getValue('copeopleTokenAsk', 0)) > 12 * 3600 * 1000) {
      GM_setValue('copeopleTokenAsk', Date.now());
      t = (window.prompt('COPEOPLE: cole o token de sincronização (peça ao responsável). Deixe em branco para pular.') || '').trim();
      if (t) { GM_setValue(TOKEN_KEY, t); localStorage.setItem(TOKEN_KEY, t); }
    }
    return t;
  }

  function copeopleRecusouToken() {
    GM_setValue(TOKEN_KEY, '');
    localStorage.removeItem(TOKEN_KEY);
    GM_setValue('copeopleTokenAsk', 0); // volta a pedir um token válido
  }

  // POST pro COPEOPLE: resolve 'pulado' (sem token), 'ok', ou rejeita. Nunca atrapalha o envio ao servidor antigo.
  function postCopeople(path, payload) {
    return new Promise((resolve, reject) => {
      const token = getCopeopleToken();
      if (!token) return resolve('pulado');
      GM_xmlhttpRequest({
        method:  'POST',
        url:     `${COPEOPLE_INGEST}${path}`,
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
        data:    JSON.stringify(payload),
        timeout: 30000,
        ontimeout: () => reject(new Error('COPEOPLE: timeout (30s)')),
        onload:  r => {
          if (r.status === 200) return resolve('ok');
          if (r.status === 401) copeopleRecusouToken();
          reject(new Error(`COPEOPLE status ${r.status}`));
        },
        onerror: () => reject(new Error('COPEOPLE: falha de rede')),
      });
    });
  }

  const SERVER_BASE = 'https://stage-out.onrender.com';
  const API_URL     = '/api/in-station/inbound_staging_area/list';
  const INTERVAL    = 60 * 1000; // 60s
  // ID da estação deste computador — MUDE aqui ao instalar numa estação diferente
  const STATION_ID  = '10963'; // SoC_PE_Jaboatão dos Guararapes

  async function fetchAll() {
    const res = await fetch(API_URL, {
      method      : 'POST',
      credentials : 'include',
      headers     : { 'Content-Type': 'application/json' },
      body        : JSON.stringify({ pageno: 1, count: 300 }),
    });
    const json = await res.json();
    if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
    return { list: json.data.list, total: json.data.total, fetchedAt: Date.now(), station_id: STATION_ID };
  }

  function sendToServer(data) {
    GM_xmlhttpRequest({
      method  : 'POST',
      url     : SERVER_BASE + '/api/stage-in-data',
      headers : { 'Content-Type': 'application/json' },
      data    : JSON.stringify(data),
      onload  : () => {
        dot.textContent      = '✅ Stage In ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        dot.style.background = '#2db55d';
        console.log(`[Stage In] ${data.list.length} / ${data.total} ruas`);
      },
      onerror : () => {
        dot.textContent      = '❌ Server offline';
        dot.style.background = '#cc0000';
        console.error('[Stage In] Falha ao enviar para o servidor');
      },
    });
  }

  async function sync() {
    dot.textContent      = '🔄 Stage In...';
    dot.style.background = '#888';
    try {
      const data = await fetchAll();
      // Também vai para o COPEOPLE (envio duplo durante a migração); uma falha aqui não atrapalha o servidor antigo.
      if (data.station_id) postCopeople('/stage-in', data).catch(e => console.warn('[Stage In]', e.message));
      sendToServer(data);
    } catch (e) {
      dot.textContent      = '⚠️ Erro Stage In';
      dot.style.background = '#cc7700';
      console.error('[Stage In]', e);
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
  const dot = registerSyncDot('📡 Stage In', '#888');
  dot.title = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);

  // ── Run ─────────────────────────────────────────────────────────────
  sync();
  setInterval(sync, INTERVAL);
})();
