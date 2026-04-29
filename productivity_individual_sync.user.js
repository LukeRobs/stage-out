// ==UserScript==
// @name         SPX Productivity Individual → Dashboard Sync
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Sincroniza produtividade individual por hora com o dashboard
// @match        https://spx.shopee.com.br/*
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_BASE   = 'https://stage-out.onrender.com';
  const INTERVAL      = 60 * 1000;
  const API_URL       = '/api/wfm/admin/workstation/productivity/productivity_individual_list';
  const ACTIVITY_TYPE = 12;
  const PAGE_SIZE     = 50;
  const STORAGE_KEY   = 'prodInd_cache_v2';
  const REFETCH_MS    = 10 * 60 * 1000; // re-busca hora completa a cada 10 min

  // ── localStorage helpers ─────────────────────────────────────────────────

  function shiftStartTs() {
    const d = new Date();
    if (d.getHours() < 6) d.setDate(d.getDate() - 1);
    d.setHours(6, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
  }

  function saveCache(cache) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); } catch {}
  }

  function pruneCache(cache) {
    const cutoff = shiftStartTs() * 1000;
    for (const k of Object.keys(cache)) {
      if ((cache[k].savedAt || 0) < cutoff) delete cache[k];
    }
  }

  // Ao iniciar: re-envia ao servidor tudo que está no localStorage do turno atual
  function restoreFromCache() {
    const cache = loadCache();
    pruneCache(cache);
    saveCache(cache);
    const entries = Object.entries(cache);
    if (!entries.length) return;
    console.log(`[ProdInd] Restaurando ${entries.length} horas do localStorage…`);
    for (const [hora, payload] of entries) {
      sendToServer(payload, `[restore] ${hora}`);
    }
  }

  // ── Utilitários ──────────────────────────────────────────────────────────

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtHora(d) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
  }

  // Deriva janelas a partir do time_list.
  // Horas completas: re-busca apenas se não estiver no cache local ou cache expirou (10 min).
  function windowsFromTimelist(time_list) {
    const cache        = loadCache();
    const nowTs        = Math.floor(Date.now() / 1000);
    const curHourStart = Math.floor(nowTs / 3600) * 3600;

    return time_list
      .filter(t => t.total > 0)
      .map(t => {
        const isCurrentHour = t.timestamp === curHourStart;
        return {
          hora:        fmtHora(new Date(t.timestamp * 1000)),
          start_time:  t.timestamp,
          end_time:    isCurrentHour ? nowTs : t.timestamp + 3600,
          isCompleted: !isCurrentHour,
        };
      })
      .filter(w => {
        if (!w.isCompleted) return true; // hora atual: sempre re-busca
        const cached = cache[w.hora];
        if (!cached) return true;        // sem cache: busca
        return Date.now() - cached.savedAt > REFETCH_MS; // cache expirado: busca
      });
  }

  // ── API calls ────────────────────────────────────────────────────────────

  async function fetchTimelist() {
    const res = await fetch('/api/wfm/admin/dashboard/list', {
      method      : 'POST',
      credentials : 'include',
      headers     : { 'Content-Type': 'application/json' },
      body        : JSON.stringify({
        unit_type: 1, process_type: 2, period_type: 1,
        operator_email: '', pageno: 1, count: 1,
        event_id_list: [], order_by_total: 100, productivity: 1,
      }),
    });
    const json = await res.json();
    if (json.retcode !== 0) throw new Error(`dashboard/list retcode ${json.retcode}`);
    return json.data.time_list || [];
  }

  function sendTimelist(time_list) {
    GM_xmlhttpRequest({
      method  : 'POST',
      url     : SERVER_BASE + '/api/productivity-timelist',
      headers : { 'Content-Type': 'application/json' },
      data    : JSON.stringify({ time_list, fetchedAt: Date.now() }),
      onload  : r => console.log(`[ProdInd] timelist: ${time_list.length} horas → ${r.status}`),
      onerror : () => console.warn('[ProdInd] timelist: server offline'),
    });
  }

  async function fetchAllRecords(start_time, end_time) {
    let pageno = 1, all = [], total = null;
    while (true) {
      const url = `${API_URL}?pageno=${pageno}&count=${PAGE_SIZE}&activity_type=${ACTIVITY_TYPE}&start_time=${start_time}&end_time=${end_time}`;
      const res  = await fetch(url, { credentials: 'include' });
      const json = await res.json();
      if (json.retcode !== 0) throw new Error(`API retcode ${json.retcode}: ${json.message}`);
      const data = json.data;
      all = all.concat(data.list || []);
      if (total === null) total = data.total;
      if (all.length >= total || !(data.list && data.list.length)) break;
      pageno++;
    }
    return { records: all, total: all.length };
  }

  // sendToServer retorna Promise<boolean> — true se servidor confirmou (HTTP 200)
  function sendToServer(payload, label) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method  : 'POST',
        url     : SERVER_BASE + '/api/productivity-individual-data',
        headers : { 'Content-Type': 'application/json' },
        data    : JSON.stringify(payload),
        onload  : r => {
          console.log(`[ProdInd] ${label}: ${payload.records.length} reg → ${r.status}`);
          resolve(r.status === 200);
        },
        onerror : () => {
          console.warn(`[ProdInd] ${label}: server offline`);
          resolve(false);
        },
      });
    });
  }

  // ── Sync principal ───────────────────────────────────────────────────────

  async function sync() {
    dot.textContent      = '🔄 Prod...';
    dot.style.background = '#888';
    try {
      const time_list = await fetchTimelist();
      sendTimelist(time_list);

      const windows = windowsFromTimelist(time_list);
      const cache   = loadCache();

      for (const w of windows) {
        const { records } = await fetchAllRecords(w.start_time, w.end_time);
        const payload = {
          hora:       w.hora,
          start_time: w.start_time,
          end_time:   w.end_time,
          records,
          total:      records.length,
          fetchedAt:  Date.now(),
        };
        const ok = await sendToServer(payload, w.hora);

        // Só persiste no localStorage se o servidor confirmou (evita falso-cache em cold start)
        if (w.isCompleted && ok) {
          cache[w.hora] = { ...payload, savedAt: Date.now() };
        }
      }

      pruneCache(cache);
      saveCache(cache);

      const at = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
      dot.textContent      = `✅ ${windows.length}h · ${at}`;
      dot.style.background = '#2db55d';
    } catch (e) {
      dot.textContent      = '⚠️ Erro Prod';
      dot.style.background = '#cc7700';
      console.error('[ProdInd]', e);
    }
  }

  // ── Indicador visual ────────────────────────────────────────────────────
  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:fixed', 'bottom:80px', 'right:16px',
    'background:#888', 'color:#fff',
    'padding:6px 14px', 'border-radius:20px',
    'font-size:12px', 'font-family:sans-serif',
    'z-index:2147483647', 'cursor:pointer',
    'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
    'user-select:none',
  ].join(';');
  dot.textContent = '👷 Prod Ind';
  dot.title       = 'Clique para sincronizar agora';
  dot.addEventListener('click', sync);
  document.body.appendChild(dot);

  // Restaura dados históricos do turno antes do primeiro sync
  restoreFromCache();
  sync();
  setInterval(sync, INTERVAL);
})();
