  const http   = require('http');
  const fs     = require('fs');
  const path   = require('path');
  const crypto = require('crypto');
  const { spawn } = require('child_process');

  // Blindagem: uma excecao nao tratada (ex: dentro de um setInterval, fora do request
  // handler) derrubava o processo inteiro, e o restart no Render zera TODOS os caches em
  // memoria (queue, trips, packing, packed etc.) — exatamente o "sumiu tudo do nada" que
  // ja apareceu varias vezes. Loga o erro mas mantem o processo de pe.
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException] processo continua rodando:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection] processo continua rodando:', err);
  });

  // Load .env if present (local dev)
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    envFile.split('\n').forEach(line => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
    });
  } catch (_) {}

  const SPREADSHEET_ID = '1Sk16vRNBUsQitL3cRUSIH86SyfQpxV9t08UW2YrSdmQ';
  const RANGE          = 'Daily!A1:Q3000';
  const CACHE_TTL      = 60 * 1000; // 60 seconds

  // ── Auth mode detection ───────────────────────────────────────────────
  // Priority: 1) Service Account file  2) Service Account base64  3) API Key  4) gws CLI
  function loadServiceAccount() {
    try {
      if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE)
        return JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
      if (process.env.GOOGLE_SERVICE_ACCOUNT)
        return JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
    } catch (e) { console.error('[auth] Failed to load service account:', e.message); }
    return null;
  }
  const SERVICE_ACCOUNT = loadServiceAccount();
  const USE_API_KEY     = !SERVICE_ACCOUNT && !!process.env.SHEETS_API_KEY;
  const USE_GWS         = !SERVICE_ACCOUNT && !USE_API_KEY;
  console.log(`[auth] Mode: ${SERVICE_ACCOUNT ? 'Service Account' : USE_API_KEY ? 'API Key' : 'gws CLI'}`);

  // ── Service Account JWT auth ──────────────────────────────────────────
  let saToken = null, saTokenExp = 0;

  function b64url(buf) {
    return buf.toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  }

  async function getServiceAccountToken() {
    if (saToken && Date.now() < saTokenExp) return saToken; // cached
    const { client_email, private_key } = SERVICE_ACCOUNT;
    const now = Math.floor(Date.now() / 1000);
    const hdr = b64url(Buffer.from(JSON.stringify({ alg:'RS256', typ:'JWT' })));
    const pay = b64url(Buffer.from(JSON.stringify({
      iss: client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600, iat: now,
    })));
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${hdr}.${pay}`);
    const jwt = `${hdr}.${pay}.${b64url(sign.sign(private_key))}`;
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    if (!resp.ok) throw new Error(`Token error: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    saToken    = data.access_token;
    saTokenExp = Date.now() + (data.expires_in - 60) * 1000; // refresh 60s before expiry
    return saToken;
  }

  let dataCache      = null;
  let cacheFetchedAt = 0;
  let fetchInProgress = false;
  let fetchCallbacks  = [];
  let lastSavedHour = null;

  // ── Data-processing helpers (mirrors gen_daily.js logic) ──────────────

  function normalizeStr(s) {
    if (!s || s.trim() === '' || s === '.0') return null;
    const str = s.trim();
    if (str.includes('/')) {
      const [datePart, timePart = '00:00:00'] = str.split(' ');
      const [m, d, y] = datePart.split('/');
      const [hh, mm, ss = '00'] = timePart.split(':');
      return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${hh.padStart(2,'0')}:${mm}:${ss}`;
    }
    const [datePart, timePart = '00:00:00'] = str.split(' ');
    const [hh, mm, ss = '00'] = timePart.split(':');
    return `${datePart}T${hh.padStart(2,'0')}:${mm}:${ss}`;
  }

  function extractTime(s) {
    const n = normalizeStr(s);
    return n ? n.substring(11, 16) : '';
  }

  function perdeuCPT(row) {
    const robo = normalizeStr(row[9]);
    const plan = normalizeStr(row[4]);
    if (!robo || !plan) return false;
    return robo > plan;
  }

  function parseShipments(s) {
    if (!s || s === '.0' || s === '0.0' || s === '0') return 0;
    return Math.round(parseFloat(s.trim().replace(/\./g, '').replace(',', '.')) || 0);
  }

  // Pacotes_Real (col P, index 15): use if filled; fallback to Shipments (col M, index 12)
  function getShipments(r) {
    const real = r[15];
    if (real && real !== '.0' && real !== '0' && real !== '0.0') return parseShipments(real);
    return parseShipments(r[12]);
  }

  const CARREGADAS = new Set(['Carregado', 'Carregado/Liberado', 'Finalizado']);

  function processRawData(raw) {
    const rows   = Array.isArray(raw.values) ? raw.values.slice(1) : [];
    const byDate = {};
    const allRows = [];

    rows.forEach((r, i) => {
      // Date_SoC (col H, index 7) = operational date; fallback to date_cpt (col A)
      const dateSoc = (r[7] || r[0] || '').substring(0, 10);
      if (!dateSoc || dateSoc.length < 10) return;

      const turno   = r[13] || '';
      if (!turno) return;

      const destino = r[11] || '';
      const doca    = r[14] || '';
      const statusR = r[10] || '';
      const pct     = perdeuCPT(r);
      const ship    = getShipments(r);  // Pacotes_Real (col P) se preenchido, senão Shipments (col M)
      const isCarr  = CARREGADAS.has(statusR);

      allRows.push({
        d:      dateSoc,
        lt:     r[1]  || '',
        vt:     r[2]  || '',
        ep:     extractTime(r[3]),
        cp:     extractTime(r[4]),
        cr:     extractTime(r[9]),
        sr:     statusR,
        dest:   destino,
        doca:   doca,
        tr:     turno,
        ship:   ship,
        pct:    pct ? 1 : 0,
        just:   r[16] || '',   // Col Q — justificativa da perda de CPT
        rowNum: i + 2,         // Número da linha na planilha (header=1, dados a partir de 2)
      });

      if (!byDate[dateSoc]) byDate[dateSoc] = {};
      if (!byDate[dateSoc][turno]) byDate[dateSoc][turno] = {
        total:0, statusReal:{}, destinos:{}, docas:{}, perdeuCPT:0,
        totalShip:0, carregadas:0, shipCarregadas:0
      };
      const tg = byDate[dateSoc][turno];
      tg.total++;
      tg.totalShip += ship;
      tg.statusReal[statusR] = (tg.statusReal[statusR]||0) + 1;
      if (destino) tg.destinos[destino] = (tg.destinos[destino]||0) + 1;
      if (doca)    tg.docas[doca]       = (tg.docas[doca]||0) + 1;
      if (pct)     tg.perdeuCPT++;
      if (isCarr)  { tg.carregadas++; tg.shipCarregadas += ship; }
    });

    const dates = Object.keys(byDate).sort();
    return { DATES: dates, BY_DATE: byDate, ALL_ROWS: allRows,
            generatedAt: Date.now(), rowCount: allRows.length };
  }

  // ── Cache / fetch logic ────────────────────────────────────────────────

  async function getData(cb) {
  try {
    // cache
    if (dataCache && Date.now() - cacheFetchedAt < CACHE_TTL) {
      return cb(null, dataCache);
    }

    fetchCallbacks.push(cb);
    if (fetchInProgress) return;
    fetchInProgress = true;

    let raw;

    // ── 1. Service Account (PRIORIDADE) ─────────────────────────
    if (SERVICE_ACCOUNT) {
      const token = await getServiceAccountToken();

      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(RANGE)}`;

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!resp.ok) {
        throw new Error(`Sheets API ${resp.status} - ${await resp.text()}`);
      }

      raw = await resp.json();
      console.log('[api/data] via Service Account');
    }

    // ── 2. API KEY (fallback) ─────────────────────────
    else if (USE_API_KEY) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(RANGE)}?key=${process.env.SHEETS_API_KEY}`;

      const resp = await fetch(url);

      if (!resp.ok) {
        throw new Error(`Sheets API ${resp.status} - ${await resp.text()}`);
      }

      raw = await resp.json();
      console.log('[api/data] via API Key');
    }

    // ── 3. ERRO SE NADA CONFIGURADO ─────────────────────────
    else {
      throw new Error('Nenhum método de autenticação configurado');
    }

    // ── Processamento + cache ─────────────────────────
    dataCache = processRawData(raw);
    cacheFetchedAt = Date.now();

    console.log(`[api/data] ✅ ${dataCache.rowCount} rows`);

    const cbs = fetchCallbacks.splice(0);
    fetchInProgress = false;

    cbs.forEach(fn => fn(null, dataCache));

  } catch (err) {
    console.error('[api/data] ❌', err.message);

    const cbs = fetchCallbacks.splice(0);
    fetchInProgress = false;

    // fallback: usa cache antigo se existir
    if (dataCache) {
      console.warn('[api/data] ⚠️ usando cache antigo');
      return cbs.forEach(fn => fn(null, dataCache));
    }

    cbs.forEach(fn => fn(err));
  }
}

  // Pre-warm cache on startup
  getData((err, data) => {
    if (err) console.error('[startup] Initial data fetch failed:', err.message);
    else     console.log(`[startup] Data ready — ${data.rowCount} rows across ${data.DATES.length} dates`);
  });

  // ── SeaTalk report ────────────────────────────────────────────────────
  // Os dois bots (app_id/secret) continuam únicos — só o grupo de destino muda por
  // estação. O bot "seatalk" (Stage IN + os novos reports de Report) usa
  // SEATALK_GROUP_ID_BY_STATION; o bot "seatalk-queue" (Queue List) usa
  // SEATALK_QUEUE_GROUP_ID_BY_STATION. Produtividade Packing continua só no Jaboatão
  // (não pedido pro Recife04), então seu grupo fica hardcoded como antes.
  const SEATALK_GROUP_ID_BY_STATION = {
    '10963': process.env.SEATALK_GROUP_ID || 'MDQ1OTMwOTc5MzYz',
    '15000': 'ODU3MzEyNTkxODc4', // SoC_PE_Recife_04
  };
  const SEATALK_QUEUE_APP_ID     = process.env.SEATALK_QUEUE_APP_ID     || 'MDEwMTk0MDU4NDk1';
  const SEATALK_QUEUE_APP_SECRET = process.env.SEATALK_QUEUE_APP_SECRET || 'X5zPzZyeBkL3MoK9Ks-n_BASneztngPp';
  const SEATALK_QUEUE_GROUP_ID   = process.env.SEATALK_QUEUE_GROUP_ID   || 'MzU3MzMwNjU4MjU1';
  const SEATALK_QUEUE_GROUP_ID_BY_STATION = {
    '10963': SEATALK_QUEUE_GROUP_ID,
    '15000': 'ODU3MzEyNTkxODc4', // SoC_PE_Recife_04
  };
  const SEATALK_PHRASES  = {
    todas:    'Time segue Report Geral Stage_IN',
    volumoso: 'Time segue Report SPP Volumoso',
  };
  const screenshotStore  = {}; // { todas: Buffer, volumoso: Buffer }
  const lastReportSent   = {}; // { todas: timestamp, volumoso: timestamp }
  const REPORT_COOLDOWN  = 2 * 60 * 1000; // 2 minutos — evita duplicatas

  function fetchWithTimeout(url, opts, ms = 10000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(tid));
  }

  async function getSeaTalkToken() {
    const appId     = process.env.SEATALK_APP_ID;
    const appSecret = process.env.SEATALK_APP_SECRET;
    if (!appId || !appSecret) throw new Error('SEATALK_APP_ID/SECRET não configurados');
    const res  = await fetchWithTimeout('https://openapi.seatalk.io/auth/app_access_token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }, 10000);
    const text = await res.text();
    console.log('[seatalk] token raw:', res.status, text.substring(0, 300));
    const data = JSON.parse(text);
    if (!data.app_access_token) throw new Error(`Token falhou: ${text.substring(0, 200)}`);
    return data.app_access_token;
  }

  // Chave usada em screenshotStore/lastReportSent — igual ao "tab" original quando é a
  // estação padrão (mantém 100% compatível com o que já existia), sufixada por estação
  // nos outros casos, pra não colidir cooldown/screenshot entre estações.
  function reportKey(tab, station) {
    const st = String(station ?? DEFAULT_STATION);
    return st === DEFAULT_STATION ? tab : `${tab}_${st}`;
  }

  async function seaTalkSendText(token, text, groupId) {
    const res = await fetchWithTimeout('https://openapi.seatalk.io/messaging/v2/group_chat', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        group_id: groupId,
        message:  { tag: 'text', text: { content: text } },
      }),
    }, 10000);
    const raw = await res.text();
    console.log('[seatalk] sendText raw:', res.status, raw.substring(0, 300));
    return raw;
  }

  async function seaTalkSendImage(token, key, groupId) {
    const buf = screenshotStore[key];
    if (!buf) { console.warn('[seatalk] sem buffer de imagem para', key); return; }

    // API do SeaTalk aceita Base64 direto no campo image.content (PNG/JPG/GIF, max 5MB)
    const b64 = buf.toString('base64');
    const res = await fetchWithTimeout('https://openapi.seatalk.io/messaging/v2/group_chat', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        group_id: groupId,
        message:  { tag: 'image', image: { content: b64 } },
      }),
    }, 20000);
    const raw = await res.text();
    console.log('[seatalk] sendImg raw:', res.status, raw.substring(0, 300));
  }

  async function getVolumosoStats(station) {
    const data = await getReportData(station);
    // Ruas pertencentes à ZONA VOLUMOSO
    const volRuas = Object.entries(data.byArea)
      .filter(([, d]) => d.zona === 'ZONA VOLUMOSO')
      .map(([rua]) => rua);

    let totalTOs = 0, tosGt30 = 0, totalAging = 0;
    for (const rua of volRuas) {
      for (const to of (data.byAreaTOs[rua] || [])) {
        totalTOs++;
        if (to.pacotes > 30) tosGt30++;
        totalAging += to.aging_h;
      }
    }
    const agingMedio = totalTOs > 0 ? (totalAging / totalTOs).toFixed(1) : '0.0';
    return { totalTOs, tosGt30, agingMedio };
  }

  async function sendSeaTalkReport(tab, imgBuffer, overrideText, station) {
    try {
      const st      = String(station ?? DEFAULT_STATION);
      const groupId = SEATALK_GROUP_ID_BY_STATION[st];
      if (!groupId) throw new Error(`Sem grupo SeaTalk configurado pra estação ${st}`);
      const token = await getSeaTalkToken();

      // Texto: usa override do Tampermonkey se presente; senão calcula no servidor
      let text = overrideText;
      if (!text) {
        if (tab === 'volumoso') {
          try {
            const s = await getVolumosoStats(st);
            text = `Report SPP Volumoso:\nTotal TO's: ${s.totalTOs}\nTO's > 30: ${s.tosGt30}\nAging Médio: ${s.agingMedio}h`;
          } catch (e) {
            console.error('[seatalk] Erro ao buscar stats volumoso:', e.message);
            text = SEATALK_PHRASES[tab] || tab;
          }
        } else {
          text = SEATALK_PHRASES[tab] || tab;
        }
      }

      // 1. Imagem primeiro (contexto visual antes do texto)
      if (imgBuffer) await seaTalkSendImage(token, reportKey(tab, st), groupId);
      await new Promise(r => setTimeout(r, 500));

      // 2. Texto
      await seaTalkSendText(token, text, groupId);

      console.log(`[seatalk] ✅ Report "${tab}" (estação ${st}) enviado — ${new Date().toLocaleTimeString('pt-BR')}`);
    } catch (e) {
      console.error(`[seatalk] ❌ Erro no report "${tab}":`, e.message);
    }
  }

  // ── SeaTalk Queue bot ─────────────────────────────────────────────────

  async function getSeaTalkQueueToken() {
    const res  = await fetchWithTimeout('https://openapi.seatalk.io/auth/app_access_token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ app_id: SEATALK_QUEUE_APP_ID, app_secret: SEATALK_QUEUE_APP_SECRET }),
    }, 10000);
    const text = await res.text();
    console.log('[seatalk-queue] token raw:', res.status, text.substring(0, 300));
    const data = JSON.parse(text);
    if (!data.app_access_token) throw new Error(`Token falhou: ${text.substring(0, 200)}`);
    return data.app_access_token;
  }

  async function seaTalkQueueSendText(token, text, groupId) {
    const res = await fetchWithTimeout('https://openapi.seatalk.io/messaging/v2/group_chat', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        group_id: groupId,
        message:  { tag: 'text', text: { content: text } },
      }),
    }, 10000);
    const raw = await res.text();
    console.log('[seatalk-queue] sendText raw:', res.status, raw.substring(0, 300));
  }

  async function seaTalkQueueSendImage(token, buf, groupId) {
    if (!buf) { console.warn('[seatalk-queue] sem buffer de imagem'); return; }
    const b64 = buf.toString('base64');
    const res = await fetchWithTimeout('https://openapi.seatalk.io/messaging/v2/group_chat', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        group_id: groupId,
        message:  { tag: 'image', image: { content: b64 } },
      }),
    }, 20000);
    const raw = await res.text();
    console.log('[seatalk-queue] sendImg raw:', res.status, raw.substring(0, 300));
  }

  async function sendSeaTalkQueueReport(imgBuffer, text, groupId) {
    try {
      const token = await getSeaTalkQueueToken();
      if (imgBuffer) await seaTalkQueueSendImage(token, imgBuffer, groupId);
      await new Promise(r => setTimeout(r, 500));
      await seaTalkQueueSendText(token, text, groupId);
      console.log(`[seatalk-queue] ✅ Report enviado (grupo ${groupId}) — ${new Date().toLocaleTimeString('pt-BR')}`);
    } catch (e) {
      console.error('[seatalk-queue] ❌ Erro:', e.message);
    }
  }

  // ── Suporte a múltiplas estações ───────────────────────────────────────
  // Cada computador/estação roda seu próprio conjunto de scripts Tampermonkey
  // apontando pro mesmo servidor. Sem particionar por estação, o segundo
  // computador simplesmente sobrescreveria os dados do primeiro (mesmo bug
  // de "overwrite" que já corrigimos pras TOs, agora pros outros módulos).
  const DEFAULT_STATION = '10963'; // SoC_PE_Jaboatão dos Guararapes — estação original, mantém compatibilidade se um payload nao informar station_id

  // Deriva a estação de um payload a partir do primeiro item da lista, quando o
  // proprio registro ja carrega um campo de estacao (TOs, queue, stage-out) —
  // nesses casos nao precisa mexer no script, o servidor so precisa saber olhar.
  function inferStation(list, field) {
    const v = list?.[0]?.[field];
    return v != null ? String(v) : DEFAULT_STATION;
  }

  // Le ?station=X da query string de uma requisicao GET (usado pelos dashboards)
  function stationParam(req) {
    return new URL(req.url, 'http://internal').searchParams.get('station') || DEFAULT_STATION;
  }

  // Filtra um cache global (TOs) por um campo que ja vem em cada registro (ex:
  // current_station_id) — usado quando o merge continua global (nao vale a pena
  // duplicar a logica de merge/evict/revalidacao por estacao), so a LEITURA e
  // que precisa ser recortada por estacao.
  function filterByStationField(cache, field, station) {
    if (!cache) return null;
    const list = (cache.list || []).filter(t => String(t?.[field]) === station);
    return { ...cache, list, total: list.length };
  }

  // Cache simples particionado por estacao (usado pelos modulos que fazem
  // "overwrite" — cada estacao te sua propria fatia, sem merge entre elas)
  function makeStationCache() {
    const byStation = new Map(); // station_id -> data
    return {
      set(stationId, data) { byStation.set(String(stationId ?? DEFAULT_STATION), data); },
      get(stationId)       { return byStation.get(String(stationId ?? DEFAULT_STATION)) ?? null; },
    };
  }

  // ── Stage-out cache (fed by Tampermonkey) ─────────────────────────────
  const stageCacheByStation = makeStationCache(); // station_id -> { list, total, fetchedAt }
  let toPackingCache    = null; // { list, total, fetchedAt } — snapshot derivado do merge abaixo
  let toPackedCache     = null; // { list, total, fetchedAt } — snapshot derivado do merge abaixo

  // Merge acumulado por to_number. Estações/abas diferentes do Tampermonkey enxergam
  // escopos diferentes (cada uma via seu próprio "in-station search"); antes, cada POST
  // substituía o cache inteiro, então o dashboard "piscava" entre o recorte de uma
  // estação e o de outra. Agora acumulamos por to_number e só podamos por idade —
  // assim o cache sempre reflete a união de tudo que já foi visto recentemente.
  const toPackingMap       = new Map(); // to_number -> record
  const toPackedMap        = new Map(); // to_number -> record
  const TO_MERGE_MAX_AGE_MS = 72 * 60 * 60 * 1000; // 72h — poda de segurança (evita crescer para sempre)

  // Quando o dashboard confirma via /api/to-evict que uma TO ja mudou de status (lookup ao
  // vivo), ela precisa ficar EXCLUIDA de verdade — sem isso, a proxima sincronizacao em
  // massa do Tampermonkey (que usa a busca "outbound/search", mais sujeita a atraso do que
  // o lookup individual) reinseria a mesma TO no merge minutos depois, desfazendo a remocao.
  const toEvictedSets = { packing: new Map(), packed: new Map() }; // to_number -> evictedAt (ms)
  const TO_EVICT_TTL_MS = 36 * 60 * 60 * 1000; // 36h — mesmo prazo do corte de idade do dashboard, por consistência

  function pruneEvicted(evictedMap) {
    const now = Date.now();
    for (const [key, t] of evictedMap) if (now - t > TO_EVICT_TTL_MS) evictedMap.delete(key);
  }

  // Remove uma TO do merge de verdade (usado tanto pelo evict manual — clique no modal —
  // quanto pela revalidacao automatica em segundo plano abaixo).
  function evictTo(to_number, kind) {
    const map = kind === 'packing' ? toPackingMap : toPackedMap;
    const removed = map.delete(to_number);
    toEvictedSets[kind].set(to_number, Date.now());
    if (removed) {
      if (kind === 'packing') toPackingCache = snapshotToCache(toPackingMap, toPackingCache?.fetchedAt ?? Date.now());
      else                    toPackedCache  = snapshotToCache(toPackedMap,  toPackedCache?.fetchedAt  ?? Date.now());
    }
    return removed;
  }

  function mergeToRecords(map, list, evictedMap) {
    const nowMs = Date.now();
    if (evictedMap) pruneEvicted(evictedMap);
    (list || []).forEach(to => {
      if (to && to.to_number && !(evictedMap && evictedMap.has(to.to_number))) map.set(to.to_number, to);
    });
    for (const [key, to] of map) {
      const refSec = to.complete_time || to.ctime || 0;
      if (refSec && (nowMs - refSec * 1000) > TO_MERGE_MAX_AGE_MS) map.delete(key);
    }
  }

  function snapshotToCache(map, fetchedAt) {
    return { list: [...map.values()], total: map.size, fetchedAt };
  }

  // ── SACAS productivity log — histórico durável de TOs que já foram Packed ─────
  // Diferente do toPackedMap acima (que só guarda o que está "Packed AGORA" — podado por
  // idade e evictado assim que a TO muda de status/é endereçada), esse log só ACRESCENTA:
  // grava pra sempre (até SACAS_LOG_MAX_AGE_DAYS) o snapshot da TO no momento em que ela
  // aparece pela 1ª vez com um complete_time válido. Sem isso, o dashboard de %SACA por dia
  // operacional não teria como calcular a produção de dias anteriores — a TO já teria sumido
  // do toPackedMap assim que fosse endereçada/despachada. Persistido em disco (best-effort)
  // porque um restart no Render zeraria o histórico de produtividade, que é o dado principal
  // desse dashboard (diferente dos outros módulos, que só mostram estado "ao vivo").
  const sacasLogByStation  = new Map(); // station_id -> Map(to_number -> record)
  const SACAS_LOG_MAX_AGE_DAYS = 60;
  const SACAS_LOG_FILE = path.join(__dirname, 'sacas_log.json');

  function getSacasLog(station) {
    const key = String(station ?? DEFAULT_STATION);
    if (!sacasLogByStation.has(key)) sacasLogByStation.set(key, new Map());
    return sacasLogByStation.get(key);
  }

  function pruneSacasLog() {
    const cutoffSec = Date.now() / 1000 - SACAS_LOG_MAX_AGE_DAYS * 86400;
    for (const log of sacasLogByStation.values()) {
      for (const [key, rec] of log) if (rec.complete_time < cutoffSec) log.delete(key);
    }
  }

  let sacasLogSaveTimer = null;
  function saveSacasLog() {
    try {
      const out = {};
      for (const [station, log] of sacasLogByStation) out[station] = [...log.values()];
      fs.writeFileSync(SACAS_LOG_FILE, JSON.stringify(out));
    } catch (e) { console.error('[sacas-log] falha ao salvar:', e.message); }
  }
  function scheduleSacasLogSave() {
    if (sacasLogSaveTimer) return;
    sacasLogSaveTimer = setTimeout(() => { sacasLogSaveTimer = null; saveSacasLog(); }, 5000);
  }

  function loadSacasLog() {
    try {
      const raw = JSON.parse(fs.readFileSync(SACAS_LOG_FILE, 'utf8'));
      for (const station of Object.keys(raw)) {
        const log = getSacasLog(station);
        (raw[station] || []).forEach(rec => { if (rec && rec.to_number) log.set(rec.to_number, rec); });
      }
      pruneSacasLog();
      const total = [...sacasLogByStation.values()].reduce((s, l) => s + l.size, 0);
      console.log(`[sacas-log] carregado do disco — ${total} TOs`);
    } catch (e) { /* sem arquivo ainda (1ª execução) — segue com log vazio */ }
  }
  loadSacasLog();

  // Alimentado a partir do MESMO payload que chega em /api/tos-packed-data (ver abaixo) —
  // só grava TOs com complete_time (ou seja, já efetivamente Packed) e nunca sobrescreve um
  // registro existente (a 1ª captura já tem o complete_time correto; sobrescrever abriria
  // brecha pra um snapshot atrasado/inconsistente mudar retroativamente um dia já fechado).
  function recordSacasLog(list) {
    let added = 0;
    (list || []).forEach(to => {
      if (!to || !to.to_number || !to.complete_time) return;
      const log = getSacasLog(to.current_station_id);
      if (log.has(to.to_number)) return;
      log.set(to.to_number, {
        to_number:         to.to_number,
        complete_time:     to.complete_time,
        pack_name:         to.pack_name || '',
        quantity:          to.quantity || 0,
        weight:            to.weight || 0,
        dest_station_name: to.dest_station_name || to.receiver || '',
        operator:          to.operator || '',
        status:            to.status || 'Packed',
      });
      added++;
      getSacasPendingRows(to.current_station_id).push(buildSacasSheetRow(to));
    });
    if (added) { pruneSacasLog(); scheduleSacasLogSave(); }
  }

  // ── SACAS → Google Sheets (arquivo + recuperação pós-restart) ────────────────
  // Aba "db" da planilha compartilhada pelo usuário. O dashboard continua sendo servido só
  // por sacasLogByStation em memória — a planilha não é consultada a cada request. Mas como
  // o Render pode reiniciar o processo a qualquer momento (plano free "dorme", redeploys,
  // crash) e isso zera a memória (perdendo o que ainda não tinha sido escrito em disco), a
  // planilha funciona como a cópia durável: gravamos em lote a cada SACAS_SHEET_FLUSH_MS
  // (nunca linha a linha, pra não estourar cota da API) e, no boot do processo,
  // loadSacasLogFromSheet() lê ela de volta e recompõe a memória — ver mais abaixo.
  // Cada estação tem sua PRÓPRIA planilha (não uma coluna STATION numa planilha
  // compartilhada, como fizemos no Report) — mesma estrutura de abas em cada uma.
  const SACAS_SHEET_ID_BY_STATION = {
    '10963': '1rOT258Ndy3Olv4XHoL8kZhNTvzhbooTiAIYCFQJ-sWc', // SoC_PE_Jaboatão dos Guararapes
    '15000': '17ciFbeELoDA_ugYcz2QzPBuHRDU7kI2tlg2527rl_Yo', // SoC_PE_Recife_04
  };
  const SACAS_SHEET_RANGE    = 'db!A:J';
  const SACAS_SHEET_FLUSH_MS = 60 * 1000; // 60s — bem abaixo da cota do Sheets (60 writes/min/usuário), reduz a janela de perda em caso de restart
  const sacasPendingRowsByStation = new Map(); // station_id -> linhas já formatadas, aguardando o próximo flush

  function getSacasPendingRows(station) {
    const key = String(station ?? DEFAULT_STATION);
    if (!sacasPendingRowsByStation.has(key)) sacasPendingRowsByStation.set(key, []);
    return sacasPendingRowsByStation.get(key);
  }

  // O servidor roda em UTC (Render); o horário de Brasília é fixo em UTC-3 (sem horário de
  // verão desde 2019), então aplicamos o offset na mão em vez de depender do timezone do
  // processo — replica exatamente a mesma regra de turno/dia operacional que o dashboard já
  // aplica no navegador (lá, via timezone local do próprio navegador do usuário).
  const BRT_OFFSET_SEC = 3 * 3600;
  function brtParts(ts, extraShiftHours) {
    const d = new Date((ts - BRT_OFFSET_SEC - (extraShiftHours || 0) * 3600) * 1000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDtComplete(ts) {
    const p = brtParts(ts, 0);
    return `${p.y}-${pad2(p.mo)}-${pad2(p.day)} ${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
  }
  // Inverso de fmtDtComplete — usado só na recuperação pós-restart (ver loadSacasLogFromSheet).
  // Confirmado empiricamente que values.get devolve essa coluna como string "YYYY-MM-DD H:MM:SS"
  // (FORMATTED_VALUE, o padrão da API) mesmo a célula tendo virado um datetime de verdade —
  // o Sheets só derruba o zero à esquerda da hora, por isso a hora aceita 1 ou 2 dígitos.
  function parseDtComplete(str) {
    const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    return Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000) + BRT_OFFSET_SEC;
  }
  function turnoAjustadoOf(ts) {
    const h = brtParts(ts, 0).h;
    if (h >= 6 && h < 14) return 'T1';
    if (h >= 14 && h < 22) return 'T2';
    return 'T3';
  }
  function dataAjustadaOf(ts) {
    // Mesma regra de dia operacional (06:00–05:59:59) usada no dashboard: desloca -6h antes
    // de tomar a data.
    const p = brtParts(ts, 6);
    return `${pad2(p.day)}/${pad2(p.mo)}/${p.y}`;
  }
  // Canal: só 3 baldes hoje (confirmado com o usuário).
  function canalOf(destName) {
    const n = destName || '';
    if (/hub/i.test(n)) return 'Hub';
    if (/^xpt/i.test(n)) return 'XPT';
    if (/^soc/i.test(n)) return 'SOC';
    return '';
  }

  // Tabela de referência destino → sort code, passada manualmente pelo usuário (não é
  // derivável do nome do destino por nenhuma transformação — confirmado). Normalizamos os
  // dois lados (acento/maiúscula/espaço/underscore/hífen) na hora de comparar porque os nomes
  // reais de dest_station_name (LM Hub_/XPT_) batem quase exatamente com essa lista, mas com
  // pequenas variações de formatação; a seção FANOUT_SOC já veio com nomes de convenção
  // bem diferente da que o SPX usa hoje (sem acento, sem sufixo numérico) — pode não casar.
  const SORT_CODE_TABLE = [
    ['LM Hub_AL_Arapiraca', 'HUB-LAL-03'],
    ['LM Hub_AL_Maceió_04', 'HUB-LAL-04'],
    ['LM Hub_AL_Maceió_02', 'HUB-LAL-02'],
    ['LM Hub_CE_Caucaia', 'HUB-LCE-02'],
    ['LM Hub_CE_Fortaleza_Cajazeiras', 'HUB-LCE-01'],
    ['LM Hub_CE_Fortaleza-02', 'HUB-LCE-05'],
    ['LM Hub_CE_Juazeiro do Norte', 'HUB-LCE-04'],
    ['LM Hub_PB_Campina Grande', 'HUB-LPB-02'],
    ['LM Hub_PB_João Pessoa_Gramame', 'HUB-LPB-03'],
    ['LM Hub_PE_Carpina', 'HUB-LPE-08'],
    ['LM Hub_PE_Caruaru_Cidade_Alta', 'HUB-LPE-04'],
    ['LM Hub_PE_Garanhuns', 'HUB-LPE-06'],
    ['LM Hub_PE_Recife_Cabo de Santo A', 'HUB-LPE-02'],
    ['LM Hub_PE_Recife_Guabiraba', 'HUB-LPE-03'],
    ['LM Hub_PE_Recife_Muribeca', 'HUB-LPE-11'],
    ['LM Hub_PE_Recife_Jaboatão', 'HUB-LPE-07'],
    ['LM Hub_PE_Recife_Paulista', 'HUB-LPE-12'],
    ['LM Hub_PI_Teresina_02', 'HUB-LPI-02'],
    ['LM Hub_RN_FX_Natal_03', 'HUB-LRN-03-X'],
    ['LM Hub_RN_Natal_01', 'HUB-LRN-01'],
    ['LM Hub_RN_Natal_03', 'HUB-LRN-03'],
    ['LM Hub_SE_Aracaju_01', 'HUB-LSE-01'],
    ['LM Hub_SE_Aracaju_02', 'HUB-LSE-03'],
    ['XPT_AL_Maragogi', 'XPT-LAL-90'],
    ['XPT_AL_União dos Palmares', 'XPT-LAL-91'],
    ['XPT_PB_Guarabira', 'XPT-LPB-91'],
    ['XPT_PB_Itabaiana', 'XPT-LPB-92'],
    ['XPT_PB_Cajazeiras', 'XPT-LPB-93'],
    ['XPT_PB_Taperoá', 'XPT-LPB-94'],
    ['XPT_PB_Patos', 'XPT-LPB-90'],
    ['XPT_PE_Afogados da Ingazeira', 'XPT-LPE-96'],
    ['XPT_PE_Arcoverde', 'XPT-LPE-93'],
    ['XPT_PE_Goiana - Timbaúba', 'XPT-LPE-90'],
    ['XPT_PE_Palmares_02', 'XPT-LPE-92'],
    ['XPT_PE_Serra Talhada', 'XPT-LPE-94'],
    ['XPT_PE_Vitória de Santo Antão', 'XPT-LPE-91'],
    ['XPT_RN_São Gonçalo do Amarante', 'XPT-LRN-90'],
    ['XPT_RN_Açu', 'XPT-LRN-92'],
    ['XPT_RN_Goianinha', 'XPT-LRN-93'],
    ['XPT_RN_Caicó', 'XPT-LRN-94'],
    ['CorreiosLM', 'CorreiosLM'],
    ['FBS_PE_Jaboatão dos Guararapes', 'FBS-PE3'],
    ['J&TNewLM', 'J&TNewLM'],
    ['SOC SP_Cravinhos', 'SOC-SP5'],
    ['SOC SP_Louveira', 'SOC-SP7'],
    ['SOC BA_Simões Filho', 'SOC-BA2'],
    ['SOC BA_Salvador Retiro', 'SOC-BA19'],
    ['LM HUB BA_Simões Filho', 'SOC-BA17'],
    ['SOC MG_ Betim', 'SOC-MG2'],
    ['SOC PR_Curitiba', 'SOC-PR1'],
    ['SOC RS_Gravatai', 'SOC-RS2'],
    ['SOC RJ_ Duque de Caxias', 'SOC-RJ2'],
    ['SOC GO_Goiania', 'SOC-GO2/PA-03=SP8'], // dado 2x pelo usuário com códigos diferentes — mantido o último
    ['SOC- SP8 SÃO BERNADO', 'SOC-SP8 / SP5'],
    ['SOC- CS1 IATAJAÍ', 'SOC-CS1'],
    ['SOC- CE_itaitinga', 'SOC-CE3'],
    // Complementos — nomes reais (SPX) que não batiam com a lista original acima.
    ['LM Hub_PB_JoãoPessoa_Industrial', 'HUB-LPB-04'],
    ['SoC_SP_São Bernardo do Campo', 'SOC-SP8'],
    ['XPT_PE_Goiana', 'XPT-LPE-90'],
    ['SoC_RS_Gravataí_02', 'SOC-RS2'],
    ['LM Hub_BA_Salvador_Retiro', 'SOC-BA19'],
    ['LM Hub_AL_Maceió_01', 'HUB-LAL-01'],
    ['SoC_GO_Goiânia_02', 'SOC-GO2'],
    ['SoC_ES_Viana', 'SOC-ES1'],
    ['SoC_SC_Itajaí', 'SOC-CS1'],
  ];
  const DIACRITICS_RE = new RegExp('[̀-ͯ]', 'g');
  function normalizeDestKey(s) {
    return (s || '')
      .normalize('NFD').replace(DIACRITICS_RE, '') // remove acentos
      .toLowerCase()
      .replace(/[\s_-]+/g, ' ')
      .trim();
  }
  const SORT_CODE_MAP = new Map(SORT_CODE_TABLE.map(([name, code]) => [normalizeDestKey(name), code]));
  const sortCodeMisses = new Set(); // evita logar o mesmo destino sem match toda hora
  function sortCodeOf(destName) {
    const code = SORT_CODE_MAP.get(normalizeDestKey(destName));
    if (code) return code;
    if (destName && !sortCodeMisses.has(destName)) {
      sortCodeMisses.add(destName);
      console.warn(`[sacas-sheet] sem Sort Code cadastrado para destino: "${destName}"`);
    }
    return '';
  }

  // Mapa inverso (código -> nome), usado pelo destino-lookup do Inbound Staging: o campo
  // third_party_sorting_code de cada PACOTE (não da TO) vem como "SOC-PE4--HUB-LRN-03" —
  // a parte depois do "--" é o mesmo código dessa tabela, só que na direção oposta.
  const NAME_BY_SORT_CODE = new Map(SORT_CODE_TABLE.map(([name, code]) => [String(code).toUpperCase().trim(), name]));
  const sortCodeNameMisses = new Set();
  function nameFromSortCode(rawCode) {
    if (!rawCode) return '';
    // "SOC-PE4--HUB-LRN-03" -> "HUB-LRN-03" (pega depois do último "--")
    const parts = String(rawCode).split('--');
    const code = parts[parts.length - 1].toUpperCase().trim();
    const name = NAME_BY_SORT_CODE.get(code);
    if (name) return name;
    if (!sortCodeNameMisses.has(code)) {
      sortCodeNameMisses.add(code);
      console.warn(`[destino-lookup] sort code sem nome cadastrado: "${code}" (bruto: "${rawCode}")`);
    }
    return code; // sem tradução conhecida — mostra o código cru mesmo, melhor que nada
  }

  function buildSacasSheetRow(to) {
    const destino = to.dest_station_name || to.receiver || '';
    return [
      fmtDtComplete(to.complete_time),
      to.to_number,
      destino,
      to.quantity || 0,
      to.pack_name || '',
      turnoAjustadoOf(to.complete_time),
      dataAjustadaOf(to.complete_time),
      canalOf(destino),
      sortCodeOf(destino),
      String(to.current_station_id ?? DEFAULT_STATION),
    ];
  }

  async function appendSacasRowsToSheet(spreadsheetId, rows) {
    if (!rows.length) return;
    if (!SERVICE_ACCOUNT) { console.warn('[sacas-sheet] Service Account não configurado, pulando flush'); return; }
    const token = await getServiceAccountToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(SACAS_SHEET_RANGE)}:append?valueInputOption=USER_ENTERED`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    });
    if (!resp.ok) throw new Error(`Sheets append ${resp.status}: ${await resp.text()}`);
  }

  const SACAS_SHEET_HEADER = ['dt_complete', 'to_number', 'dest_station_name', 'orders', 'unitizador', 'Turno ajustado', 'Data ajustada', 'Canal', 'Sort Code', 'Estação'];
  async function ensureSacasSheetHeader(spreadsheetId) {
    if (!SERVICE_ACCOUNT) return;
    try {
      const token = await getServiceAccountToken();
      const headerRange = 'db!A1:J1';
      const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(headerRange)}`;
      const getResp = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!getResp.ok) throw new Error(`Sheets get ${getResp.status}: ${await getResp.text()}`);
      const data = await getResp.json();
      if (data.values && data.values.length) return; // já tem cabeçalho, não sobrescreve
      const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(headerRange)}?valueInputOption=USER_ENTERED`;
      const putResp = await fetch(putUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [SACAS_SHEET_HEADER] }),
      });
      if (!putResp.ok) throw new Error(`Sheets put ${putResp.status}: ${await putResp.text()}`);
      console.log(`[sacas-sheet] cabeçalho gravado na aba "db" (${spreadsheetId})`);
    } catch (e) { console.error('[sacas-sheet] falha ao verificar/gravar cabeçalho:', e.message); }
  }

  // Recuperação pós-restart: lê a planilha da estação inteira e recompõe sacasLogByStation
  // com o que estiver faltando (nunca sobrescreve o que já está em memória/disco — só
  // preenche buracos). É isso que garante que um turno inteiro não "suma" do dashboard só
  // porque o processo reiniciou entre um flush e outro: mesmo que a memória volte vazia, a
  // planilha (gravada a cada SACAS_SHEET_FLUSH_MS) tem quase tudo, e é recarregada aqui no
  // boot. weight/operator/status não são colunas da planilha — ficam com valor neutro ao
  // recarregar (o dashboard de SACAS não usa esses campos, só quantity/pack_name/complete_time
  // /dest_station_name). Cada planilha pertence a UMA estação só, então usamos a própria
  // estação do loop em vez de reler a coluna "Estação" linha a linha — EXCETO que a
  // planilha do Jaboatão (10963) é a antiga planilha compartilhada, que ainda tem linhas
  // históricas das DUAS estações misturadas (gravadas antes do Recife04 ganhar planilha
  // própria) — por isso ainda filtramos pela coluna J nela, pra não importar TOs do
  // Recife04 pro histórico do Jaboatão.
  async function loadSacasLogFromSheet(station, spreadsheetId) {
    if (!SERVICE_ACCOUNT) return;
    try {
      const token = await getServiceAccountToken();
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent('db!A2:J1000000')}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error(`Sheets get ${resp.status}: ${await resp.text()}`);
      const rows = (await resp.json()).values || [];
      const log  = getSacasLog(station);
      let restored = 0;
      rows.forEach(r => {
        const complete_time = parseDtComplete(r[0]);
        const to_number     = r[1];
        if (!complete_time || !to_number) return;
        if (String(r[9] || DEFAULT_STATION) !== String(station)) return; // linha de outra estação (planilha antiga era compartilhada)
        if (log.has(to_number)) return; // já tem em memória (mais recente/completo) — não sobrescreve
        log.set(to_number, {
          to_number,
          complete_time,
          dest_station_name: r[2] || '',
          quantity: parseInt(r[3], 10) || 0,
          pack_name: r[4] || '',
          weight: 0,
          operator: '',
          status: 'Packed',
        });
        restored++;
      });
      pruneSacasLog();
      if (restored) console.log(`[sacas-sheet] ${restored} registros recuperados da planilha da estação ${station} (recomposição pós-restart)`);
    } catch (e) { console.error(`[sacas-sheet] falha ao recarregar planilha da estação ${station}:`, e.message); }
  }

  for (const [station, spreadsheetId] of Object.entries(SACAS_SHEET_ID_BY_STATION)) {
    ensureSacasSheetHeader(spreadsheetId);
    loadSacasLogFromSheet(station, spreadsheetId);
  }

  // ── Planejamento (aba "Planejamento" na MESMA planilha de SACAS) ────────────
  // Capacidade planejada por esteira/hora, preenchida manualmente. Colunas reais:
  // A=Data (dd/mm/aaaa), B=Hora (0-23), C=Tipo processo (nome da esteira/rolete),
  // D=capacidade, E=Turno (não usado aqui). O "Planejado" que o dashboard mostra é a
  // SOMA de "capacidade" de todas as esteiras (linha C) numa mesma Data+Hora — já
  // agregado aqui no servidor pra não precisar mandar todas as linhas cruas pro cliente.
  // O lado "Realizado Saca" NÃO vem dessa planilha — vem do sacasLogByStation (dado real
  // já capturado); o dashboard só cruza os dois pra calcular Realizado Saca / Planejado.
  //
  // Atenção: os números dessa aba usam VÍRGULA como separador de MILHAR (ex.: "8,500" =
  // 8500), ao contrário do padrão pt-BR (vírgula decimal) usado por parsePtNumber() em
  // outras planilhas do projeto — confirmado batendo a soma real (18.818) com o usuário.
  const PLANEJAMENTO_RANGE = 'Planejamento!A:D';
  const PLANEJAMENTO_TTL   = 5 * 60 * 1000; // 5 min
  const planejamentoCacheByStation = new Map(); // station_id -> { list, fetchedAt }

  function parseCapacidade(s) {
    return parseFloat(String(s || '0').replace(/,/g, '')) || 0;
  }

  // station: station_id numérico ('10963'/'15000'); sem planilha configurada pra essa
  // estação → devolve lista vazia (planejado 0) em vez de herdar a meta de outra estação.
  async function getPlanejamentoData(station) {
    const st           = String(station ?? DEFAULT_STATION);
    const spreadsheetId = SACAS_SHEET_ID_BY_STATION[st];
    if (!spreadsheetId) return { list: [], fetchedAt: Date.now() };

    const cached = planejamentoCacheByStation.get(st);
    if (cached && Date.now() - cached.fetchedAt < PLANEJAMENTO_TTL) return cached;
    if (!SERVICE_ACCOUNT) throw new Error('Service Account não configurado');

    const token = await getServiceAccountToken();
    const url   = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(PLANEJAMENTO_RANGE)}`;
    const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Sheets API ${resp.status}: ${await resp.text()}`);

    const rows = ((await resp.json()).values || []).slice(1); // pula cabeçalho
    const byKey = new Map(); // "dd/mm/aaaa|hora" -> soma de capacidade de todas as esteiras
    rows.forEach(r => {
      const data = (r[0] || '').trim();
      const hora = parseInt(r[1], 10);
      if (!data || !Number.isInteger(hora)) return;
      const key = `${data}|${hora}`;
      byKey.set(key, (byKey.get(key) || 0) + parseCapacidade(r[3]));
    });
    const list = [...byKey.entries()].map(([key, planejadoGeral]) => {
      const [data, horaStr] = key.split('|');
      return { data, hora: Number(horaStr), planejadoGeral };
    });

    const result = { list, fetchedAt: Date.now() };
    planejamentoCacheByStation.set(st, result);
    return result;
  }

  async function flushSacasSheet() {
    for (const [station, spreadsheetId] of Object.entries(SACAS_SHEET_ID_BY_STATION)) {
      const batch = getSacasPendingRows(station);
      if (!batch.length) continue;
      sacasPendingRowsByStation.set(station, []);
      try {
        await appendSacasRowsToSheet(spreadsheetId, batch);
        console.log(`[sacas-sheet] ${batch.length} linhas gravadas na planilha da estação ${station}`);
      } catch (e) {
        console.error(`[sacas-sheet] falha ao gravar (estação ${station}), devolvendo para a fila:`, e.message);
        getSacasPendingRows(station).unshift(...batch); // tenta de novo no próximo ciclo
      }
    }
  }

  // ── TO detail on-demand (relay) ─────────────────────────────────────
  // O dashboard nao tem sessao no SPX, entao nao consegue chamar a API de
  // detalhe de pacotes de uma TO diretamente. Em vez disso: o dashboard
  // registra um "pedido" aqui; o script to_detail_sync (rodando numa aba
  // aberta do SPX) fica de olho nos pedidos pendentes, busca o detalhe e
  // devolve o resultado; o dashboard fica consultando ate a resposta chegar.
  const toDetailRequests = new Map(); // to_number -> { requestedAt, resolvedAt, result, error }
  const TO_DETAIL_TTL_MS = 3 * 60 * 1000; // 3 min — pedidos mais velhos que isso expiram

  function pruneToDetailRequests() {
    const now = Date.now();
    for (const [key, r] of toDetailRequests) {
      if (now - r.requestedAt > TO_DETAIL_TTL_MS) toDetailRequests.delete(key);
    }
  }

  // ── Destino Lookup (share de fanouts do Inbound Staging) ────────────────────
  // A API de inbound_staging_area só devolve contagens agregadas por rua — sem to_number
  // nem destino (confirmado por diagnóstico, inclusive testando o endpoint de "detail" da
  // rua, que também não devolve lista de TOs). A planilha "Report" já traz o to_number de
  // cada TO em cada rua (ver getReportData/byAreaTOs) — usamos isso pra pedir o detalhe de
  // cada TO pelo MESMO relay do modal (to_detail_sync.user.js → general_to/detail/search).
  // IMPORTANTE: dest_station_name/receiver no nível TO é sempre a NOSSA estação (destino da
  // perna que trouxe a TO até aqui) — o próximo destino de verdade vem no nível PACOTE, no
  // campo third_party_sorting_code (ex: "SOC-PE4--HUB-LRN-03", onde a parte depois de "--" é
  // o Sort Code da tabela SORT_CODE_TABLE). O cliente agrega os pacotes por código bruto e o
  // servidor traduz pro nome via nameFromSortCode(). Fila própria, separada da manual e da
  // auto-revalidação, pra não competir com elas. Cacheado por to_number pra sempre (com TTL
  // de segurança) — o destino de uma TO não muda depois de criada.
  const toDestinoCache      = new Map(); // to_number -> { destinoBreakdown: {nome: qtdPacotes}, fetchedAt }
  const destinoLookupPending = new Map(); // to_number -> requestedAt
  const DESTINO_CACHE_MAX_AGE_MS   = 15 * 24 * 60 * 60 * 1000; // 15 dias
  const DESTINO_PENDING_TTL_MS     = 5 * 60 * 1000; // 5min — libera pra re-pedir se não resolveu

  function pruneDestinoCache() {
    const now = Date.now();
    for (const [key, r] of toDestinoCache) if (now - r.fetchedAt > DESTINO_CACHE_MAX_AGE_MS) toDestinoCache.delete(key);
    for (const [key, t] of destinoLookupPending) if (now - t > DESTINO_PENDING_TTL_MS) destinoLookupPending.delete(key);
  }

  // ── Revalidação automática em segundo plano ──────────────────────────
  // A busca em massa do SPX (outbound/search) fica desatualizada numa escala bem maior
  // do que "sender != current_station_name" sozinho detecta — conferido manualmente pelo
  // usuário, a maioria das TOs antigas já não estava mais em "Packed"/"Packing" de verdade.
  // Em vez de depender de alguém clicar em cada TO no modal, o servidor mesmo enfileira
  // periodicamente as TOs mais antigas (mais provável de já estarem resolvidas) pra
  // reverificação via o mesmo relay de detalhe — e evicta sozinho quando o status não bate.
  const toDetailExpectations = new Map(); // to_number -> { kind, expectedStatus }
  const lastRevalidatedAt    = new Map(); // to_number -> ms (evita reverificar a mesma TO toda hora)
  // Mesmo com fila propria (separada da manual), a revalidacao automatica ainda compete
  // por conexoes/recursos na MESMA aba/origem do SPX com os syncs normais (TOs/Trips/Queue),
  // que ficaram mais lentos depois que essa feature entrou. Reduzido bem mais — praticamente
  // nao deve mais competir, ao custo de uma varredura de backlog bem mais lenta.
  const REVALIDATE_BATCH_SIZE    = 5;
  const REVALIDATE_INTERVAL_MS   = 10 * 60 * 1000;  // a cada 10min (30/h)
  const REVALIDATE_COOLDOWN_MS   = 30 * 60 * 1000; // nao reverifica a mesma TO em menos de 30min

  function scheduleRevalidation() {
    const now = Date.now();
    const candidates = [];
    for (const [to_number, rec] of toPackingMap) {
      if (now - (lastRevalidatedAt.get(to_number) || 0) > REVALIDATE_COOLDOWN_MS) {
        candidates.push({ to_number, kind: 'packing', expectedStatus: 'Packing', refTime: rec.ctime || 0 });
      }
    }
    for (const [to_number, rec] of toPackedMap) {
      if (now - (lastRevalidatedAt.get(to_number) || 0) > REVALIDATE_COOLDOWN_MS) {
        candidates.push({ to_number, kind: 'packed', expectedStatus: 'Packed', refTime: rec.complete_time || rec.ctime || 0 });
      }
    }
    // Prioriza as mais antigas primeiro — sao as mais provaveis de ja estarem resolvidas
    candidates.sort((a, b) => (a.refTime || 0) - (b.refTime || 0));
    const batch = candidates.slice(0, REVALIDATE_BATCH_SIZE);
    batch.forEach(c => {
      lastRevalidatedAt.set(c.to_number, now);
      toDetailExpectations.set(c.to_number, { kind: c.kind, expectedStatus: c.expectedStatus });
      const existing = toDetailRequests.get(c.to_number);
      if (!existing || existing.result || existing.error) {
        toDetailRequests.set(c.to_number, { requestedAt: now, resolvedAt: null, result: null, error: null, source: 'auto' });
      }
    });
    // Poda leve pra nao crescer pra sempre
    if (lastRevalidatedAt.size > 20000) {
      const cutoff = now - REVALIDATE_COOLDOWN_MS;
      for (const [k, t] of lastRevalidatedAt) if (t < cutoff) lastRevalidatedAt.delete(k);
    }
    if (batch.length) console.log(`[revalidate] +${batch.length} TOs enfileiradas para reverificação`);
  }

  // ── Rua (staging area) detail on-demand (relay) ──────────────────────
  // Mesmo mecanismo do TO detail acima, mas pra ver quais TOs/gaiolas estao
  // alocadas numa rua especifica (staging_area_id) — atendido pelo mesmo
  // to_detail_sync.user.js.
  const ruaDetailRequests = new Map(); // staging_area_id -> { requestedAt, resolvedAt, result, error }
  const RUA_DETAIL_TTL_MS = 3 * 60 * 1000;

  function pruneRuaDetailRequests() {
    const now = Date.now();
    for (const [key, r] of ruaDetailRequests) {
      if (now - r.requestedAt > RUA_DETAIL_TTL_MS) ruaDetailRequests.delete(key);
    }
  }

  const stageInCacheByStation = makeStationCache(); // station_id -> { list, total, fetchedAt }
  const queueCacheByStation = makeStationCache(); // station_id -> { list, total, pending_total, occupied_total, ..., fetchedAt }
  const tripCacheByStation        = makeStationCache(); // station_id -> { list, fetchedAt } — trip list v2
  const tripHistoryCacheByStation = makeStationCache(); // station_id -> { list, fetchedAt } — trip history (last 7 days)
  const workstationCacheByStation = makeStationCache(); // station_id -> { workstations, operators, startTime, endTime, fetchedAt }
  const prodIndividualByStation = new Map(); // station_id -> { hora_key → { hora, records, total, start_time, end_time, fetchedAt } }
  function getProdIndividualSlot(station) {
    if (!prodIndividualByStation.has(station)) prodIndividualByStation.set(station, {});
    return prodIndividualByStation.get(station);
  }
  const prodTimelistCacheByStation = makeStationCache(); // station_id -> { time_list: [{timestamp, total}], fetchedAt }

  // O relatorio horario pro Sheets/SeaTalk continua ligado a estacao original (DEFAULT_STATION)
  // por enquanto — nao duplicado por estacao ainda.
  function buildHourlyRows() {
    const workstationCache = workstationCacheByStation.get(DEFAULT_STATION);
    if (!workstationCache) return [];

    const now = new Date();

    const horaFechada = new Date(now);
    horaFechada.setMinutes(0, 0, 0);

    const data = horaFechada.toISOString().slice(0, 10);
    const hora = horaFechada.getHours();

    const rows = [];

    workstationCache.workstations.forEach(ws => {
      const operators = workstationCache.operators.filter(
        op => op.workstation === ws.workstation
      );

      const producao = operators.reduce((sum, op) => {
        return sum + (op.scan_count || 0);
      }, 0);

      const manpower = ws.manpower || 0;

      const produtividade = manpower > 0
        ? (producao / manpower).toFixed(2)
        : 0;

      rows.push([
        data,
        hora,
        ws.workstation,
        manpower,
        producao,
        produtividade,
        operators.length
      ]);
    });

    return rows;
  }
  // ── Report sheet (pacotes por TO) ─────────────────────────────────────
  const REPORT_SPREADSHEET_ID = '1aIbT7ewZpgZQo_OJT_ChX3SYjNIXy7SMFrI2sXCeP0E';
  const REPORT_RANGE          = 'Report!A:I';
  const REPORT_TTL            = 5 * 60 * 1000; // 5 min
  // Coluna C (STATION) da planilha usa esses códigos, não o station_id numérico
  const STATION_SHEET_CODE    = { '10963': 'SOC-PE2', '15000': 'SOC-PE4' };
  let   reportRowsCache       = null; // linhas cruas da planilha (todas as estações)
  let   reportRowsFetchedAt   = 0;

  async function fetchReportRows() {
    if (reportRowsCache && Date.now() - reportRowsFetchedAt < REPORT_TTL) return reportRowsCache;
    if (!SERVICE_ACCOUNT) throw new Error('Service Account não configurado');

    const token = await getServiceAccountToken();
    const url   = `https://sheets.googleapis.com/v4/spreadsheets/${REPORT_SPREADSHEET_ID}/values/${encodeURIComponent(REPORT_RANGE)}`;
    const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Sheets API ${resp.status}: ${await resp.text()}`);

    const raw  = await resp.json();
    const rows = (raw.values || []).slice(1); // pula cabeçalho

    // Só cacheia se tiver dados reais — evita envenar o cache com resultado
    // vazio quando a planilha ainda está calculando após reinício do servidor
    if (rows.length > 0) {
      reportRowsCache     = rows;
      reportRowsFetchedAt = Date.now();
    } else {
      console.warn('[report] rowCount=0 — resultado não cacheado, próxima req tentará novamente');
    }
    return rows;
  }

  function buildReportResult(rows, stationCode) {
    // Colunas: A=TO, B=ZONA, C=STATION, D=QTD PACOTES, E=RUA, F=AGING_HOURS, G=Hora now, H=Hora endereçamento, I=Turno
    const matched = rows.filter(r => (r[2] || '').trim().toUpperCase() === stationCode);

    const byZone = {}; // { "ZONA VOLUMOSO": { tos, pacotes } }
    const byArea = {}; // { "IN-05":          { tos, pacotes } }

    const byTurno   = {}; // { "T1": { tos, pacotes } }
    const byAreaTOs = {}; // { "IN-05": [ { to, pacotes, aging_h, hora_end, turno }, ... ] }

    matched.forEach(r => {
      const zona    = (r[1] || '').trim();
      const rua     = (r[4] || '').trim();
      const pacotes = parseInt(r[3]) || 0;
      const turno   = (r[8] || '').trim();
      if (zona) {
        if (!byZone[zona]) byZone[zona] = { tos: 0, pacotes: 0 };
        byZone[zona].tos++;
        byZone[zona].pacotes += pacotes;
      }
      if (rua) {
        if (!byArea[rua]) byArea[rua] = { tos: 0, pacotes: 0, zona };
        byArea[rua].tos++;
        byArea[rua].pacotes += pacotes;
        if (!byAreaTOs[rua]) byAreaTOs[rua] = [];
        byAreaTOs[rua].push({
          to:      r[0] || '',
          pacotes,
          aging_h: parseFloat(r[5]) || 0,
          hora_end: r[7] || '',
          turno,
        });
      }
      if (turno) {
        if (!byTurno[turno]) byTurno[turno] = { tos: 0, pacotes: 0 };
        byTurno[turno].tos++;
        byTurno[turno].pacotes += pacotes;
      }
    });

    console.log(`[report] station ${stationCode || '?'}: ${matched.length}/${rows.length} linhas — ${Object.keys(byZone).length} zonas, ${Object.keys(byArea).length} ruas`);
    return { byZone, byArea, byTurno, byAreaTOs, rowCount: matched.length, fetchedAt: Date.now() };
  }

  // station: station_id numérico ('10963'/'15000'); sem código mapeado → resultado vazio
  async function getReportData(station) {
    const stationCode = STATION_SHEET_CODE[String(station ?? DEFAULT_STATION)];
    const rows         = await fetchReportRows();
    return buildReportResult(rows, stationCode);
  }
  // ── Profile sheet (perfil de pacote por TO, aba "db") ──────────────────
  const PROFILE_SPREADSHEET_ID = '16do3FeFUI32Zp4asu5u_iMd1fp0Wt2XADBwBhgRr8Ik';
  const PROFILE_RANGE          = 'db!A:R';
  const PROFILE_TTL            = 5 * 60 * 1000; // 5 min
  let   profileCache           = null;
  let   profileFetchedAt       = 0;

  async function getProfileData() {
    if (profileCache && Date.now() - profileFetchedAt < PROFILE_TTL) return profileCache;
    if (!SERVICE_ACCOUNT) throw new Error('Service Account não configurado');

    const token = await getServiceAccountToken();
    const url   = `https://sheets.googleapis.com/v4/spreadsheets/${PROFILE_SPREADSHEET_ID}/values/${encodeURIComponent(PROFILE_RANGE)}`;
    const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Sheets API ${resp.status}: ${await resp.text()}`);

    const raw  = await resp.json();
    const rows = (raw.values || []).slice(1); // pula cabeçalho

    // Colunas: A=mapping_item_number, B=staging_area_id, C=staging_area_name,
    // D=group_name, E=staging_group_id, F=station_code, G=aging_hours,
    // H=aging_cluster, I=aging_cluster_looker, J=num_packs_in_staging,
    // K=last_update, L=num_packs_sem_perfil, M=num_packs_pp, N=num_packs_p,
    // O=num_packs_m, P=num_packs_g, Q=num_packs_bulky, R=num_packs_ultra_bulky
    const byTO = {};
    rows.forEach(r => {
      const to = (r[0] || '').trim();
      if (!to) return;
      byTO[to] = {
        staging_area_id:      r[1]  || '',
        staging_area_name:    (r[2] || '').trim(),
        group_name:           (r[3] || '').trim(),
        staging_group_id:     r[4]  || '',
        station_code:         r[5]  || '',
        aging_hours:          parseFloat(r[6]) || 0,
        aging_cluster:        r[7]  || '',
        aging_cluster_looker: r[8]  || '',
        num_packs_in_staging: parseInt(r[9], 10)  || 0,
        last_update:          r[10] || '',
        sem_perfil:           parseInt(r[11], 10) || 0,
        pp:                   parseInt(r[12], 10) || 0,
        p:                    parseInt(r[13], 10) || 0,
        m:                    parseInt(r[14], 10) || 0,
        g:                    parseInt(r[15], 10) || 0,
        bulky:                parseInt(r[16], 10) || 0,
        ultra_bulky:          parseInt(r[17], 10) || 0,
      };
    });

    const result = { byTO, rowCount: rows.length, fetchedAt: Date.now() };
    console.log(`[profile] ${rows.length} linhas lidas — ${Object.keys(byTO).length} TOs com perfil`);

    // Só cacheia se tiver dados reais — mesmo motivo do getReportData()
    if (rows.length > 0) {
      profileCache     = result;
      profileFetchedAt = Date.now();
    } else {
      console.warn('[profile] rowCount=0 — resultado não cacheado, próxima req tentará novamente');
    }
    return result;
  }

  // ── Meta sheet (Meta Padrão / Meta Ajustada por hora, aba Visual) ──────
  const META_SPREADSHEET_ID = '1aewkoRSoFqzTDPq1mxl7r0chDnsirihHrdBtLkowHLo';
  const META_RANGE          = 'Visual!I1:L40';
  const META_TTL            = 5 * 60 * 1000; // 5 min
  let   metaCache            = null;
  let   metaFetchedAt        = 0;

  function parsePtNumber(s) {
    if (s === undefined || s === null || s === '') return 0;
    return parseFloat(String(s).trim().replace(/\./g, '').replace(',', '.')) || 0;
  }

  async function getMetaData() {
    if (metaCache && Date.now() - metaFetchedAt < META_TTL) return metaCache;
    if (!SERVICE_ACCOUNT) throw new Error('Service Account não configurado');

    const token = await getServiceAccountToken();
    const url   = `https://sheets.googleapis.com/v4/spreadsheets/${META_SPREADSHEET_ID}/values/${encodeURIComponent(META_RANGE)}`;
    const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Sheets API ${resp.status}: ${await resp.text()}`);

    const raw  = await resp.json();
    const rows = raw.values || [];

    // Coluna I = Hora, J = Meta Padrão, K = Meta Ajustada Lin, L = Processamento Hora
    const headerIdx = rows.findIndex(r => (r[0] || '').trim().toLowerCase() === 'hora');
    const dataRows  = headerIdx >= 0 ? rows.slice(headerIdx + 1) : [];

    const byHour = {};
    dataRows.forEach(r => {
      const h = parseInt(r[0], 10);
      if (Number.isNaN(h)) return;
      byHour[h] = {
        hora:         h,
        metaPadrao:   parsePtNumber(r[1]),
        metaAjustada: parsePtNumber(r[2]),
      };
    });

    const result = { byHour, fetchedAt: Date.now() };
    if (Object.keys(byHour).length > 0) {
      metaCache     = result;
      metaFetchedAt = Date.now();
    }
    return result;
  }

  // ── Cage map + sacas (calculados pelo Tampermonkey via SPX cage API) ───
  let cageMapCache = null; // { cageMap: { CG001: OUT-185 }, byArea: { OUT-185: { sacas, cages } }, fetchedAt }
  async function forceSaveToSheets() {
  try {
    if (!workstationCacheByStation.get(DEFAULT_STATION)) {
      console.log('[force-save] ❌ Sem dados de workstation');
      return { ok: false, error: 'Sem dados' };
    }

    const rows = buildHourlyRows();

    if (!rows || rows.length === 0) {
      console.log('[force-save] ❌ Nenhuma linha gerada');
      return { ok: false, error: 'Sem linhas' };
    }

    await appendToSheet(rows);

    console.log(`[force-save] ✅ ${rows.length} linhas salvas manualmente`);

    return { ok: true, rows: rows.length };

  } catch (err) {
    console.error('[force-save] ❌ Erro:', err.message);
    return { ok: false, error: err.message };
  }
}
  async function writeToSheets() {
  if (!workstationCacheByStation.get(DEFAULT_STATION)) {
    console.log('[flush] ❌ Sem dados de workstation');
    return;
  }

  const rows = buildHourlyRows();

  if (!rows || rows.length === 0) {
    console.log('[flush] ❌ Nenhuma linha gerada');
    return;
  }

  try {
    await appendToSheet(rows);
    console.log(`[flush] ✅ ${rows.length} linhas enviadas para o Sheets`);
  } catch (err) {
    console.error('[flush] ❌ Erro ao enviar para o Sheets:', err.message);
    throw err;
  }
}
      async function appendToSheet(values) {
  if (!SERVICE_ACCOUNT) throw new Error('Service Account não configurado');

  const token = await getServiceAccountToken();

  const range = 'WS_HOURLY!A:A'; // 👈 use coluna inteira (melhor prática)

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values })
  });

  if (!resp.ok) {
    throw new Error(`Erro ao escrever no Sheets: ${resp.status} ${await resp.text()}`);
  }
}
  // ── HTTP server ────────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    const urlPath = req.url.split('?')[0];

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (urlPath === '/api/force-save' && req.method === 'POST') {
      (async () => {
        const result = await forceSaveToSheets();

        res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })();
      return;
    }
    // POST /api/stage-data — receives data from Tampermonkey userscript
    if (urlPath === '/api/stage-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const parsed  = JSON.parse(body);
          const station = inferStation(parsed.list, 'current_station_id');
          stageCacheByStation.set(station, parsed);
          console.log(`[stage-out] Received ${parsed.list?.length}/${parsed.total} positions (station ${station})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }
    if (urlPath === '/api/flush' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        try {
          await writeToSheets();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          console.error(err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Erro ao escrever na planilha' }));
        }
      });
      return;
    }
    // POST /api/justify — salva justificativa de perda de CPT na col Q da planilha
    if (urlPath === '/api/justify' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        try {
          const { rowNum, text } = JSON.parse(body);
          if (!rowNum || rowNum < 2) throw new Error('rowNum inválido');

          if (!SERVICE_ACCOUNT) {
            res.writeHead(501, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Escrita requer Service Account configurado' }));
            return;
          }

          const token = await getServiceAccountToken();
          const range  = `Daily!Q${rowNum}`;
          const url    = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

          const resp = await fetch(url, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [[text]] }),
          });

          if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Sheets write ${resp.status}: ${errText}`);
          }

          // Invalida cache para próxima leitura pegar a coluna Q atualizada
          cacheFetchedAt = 0;

          console.log(`[justify] Linha ${rowNum} atualizada: "${text}"`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('[justify] Erro:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /api/tos-packing-data — receives packing TOs from Tampermonkey (merge acumulado)
    if (urlPath === '/api/tos-packing-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          mergeToRecords(toPackingMap, incoming.list, toEvictedSets.packing);
          toPackingCache = snapshotToCache(toPackingMap, incoming.fetchedAt || Date.now());
          console.log(`[tos-packing] +${incoming.list?.length || 0} recebidos, ${toPackingMap.size} acumulados`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/tos-packed-data — receives packed TOs from Tampermonkey (merge acumulado)
    if (urlPath === '/api/tos-packed-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          mergeToRecords(toPackedMap, incoming.list, toEvictedSets.packed);
          toPackedCache = snapshotToCache(toPackedMap, incoming.fetchedAt || Date.now());
          recordSacasLog(incoming.list);
          console.log(`[tos-packed] +${incoming.list?.length || 0} recebidos, ${toPackedMap.size} acumulados`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/sacas-backfill-data — TOs que já saíram de Packed (Transporting/Transported/
    // Received/Partially Received/LHPacking/LHPacked) mas cujo complete_time original ainda
    // está gravado no registro. Alimenta SÓ o recordSacasLog (histórico de SACAS) — nunca
    // toPackedMap/toPackingMap, que continuam servindo exclusivamente tos_packed.html/
    // tos_packing.html, sem nenhum risco de interferência entre os dois fluxos.
    // current_station_id já vem sobrescrito pelo tos_sync.user.js com a estação confirmada
    // via Packing/Packed (esses status pós-Packed podem trazer o current_station_id do
    // destino, não de quem empacotou de verdade).
    if (urlPath === '/api/sacas-backfill-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          recordSacasLog(incoming.list);
          console.log(`[sacas-backfill] +${incoming.list?.length || 0} recebidos (status pós-Packed)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/tos-packing?station=X — serves packing data to dashboard (recortado por estacao;
    // o merge em si continua global — ver toPackingMap acima)
    if (urlPath === '/api/tos-packing') {
      if (!toPackingCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No packing data yet — open SPX with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(filterByStationField(toPackingCache, 'current_station_id', stationParam(req))));
      return;
    }

    // GET /api/tos-packed?station=X — serves packed data to dashboard (recortado por estacao;
    // o merge em si continua global — ver toPackedMap acima)
    if (urlPath === '/api/tos-packed') {
      if (!toPackedCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No packed data yet — open SPX with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(filterByStationField(toPackedCache, 'current_station_id', stationParam(req))));
      return;
    }

    // GET /api/sacas-history?station=X — histórico acumulado (não podado por eviction) de TOs
    // Packed, usado pelo dashboard de produtividade de SACAS pra calcular %SACA por dia
    // operacional/turno. Ver recordSacasLog() acima — populado a partir do mesmo payload de
    // /api/tos-packed-data, então não precisa de nenhum script Tampermonkey novo.
    if (urlPath === '/api/sacas-history') {
      const log = getSacasLog(stationParam(req));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ list: [...log.values()], total: log.size, fetchedAt: Date.now() }));
      return;
    }

    // GET /api/sacas-planejamento?station=X — meta/planejado por hora (aba "Planejamento"),
    // usado pela visão hora-a-hora do dashboard de SACAS pra comparar Planejado x Real.
    if (urlPath === '/api/sacas-planejamento') {
      if (!SERVICE_ACCOUNT) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Account não configurado' }));
        return;
      }
      getPlanejamentoData(stationParam(req))
        .then(data => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify(data));
        })
        .catch(err => {
          console.error('[sacas-planejamento] Erro:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }

    // POST /api/to-detail-request — dashboard pede o detalhe de pacotes de uma TO
    if (urlPath === '/api/to-detail-request' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { to_number } = JSON.parse(body);
          if (!to_number) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'to_number obrigatório' }));
            return;
          }
          pruneToDetailRequests();
          const existing = toDetailRequests.get(to_number);
          // Se ja tem um pedido recente sem resposta ainda, nao reseta (evita duplicar fila) —
          // mas promove pra "manual" pra furar a fila da revalidacao automatica em segundo plano.
          if (!existing || existing.result || existing.error) {
            toDetailRequests.set(to_number, { requestedAt: Date.now(), resolvedAt: null, result: null, error: null, source: 'manual' });
          } else {
            existing.source = 'manual';
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/to-detail-pending — to_detail_sync busca quais TOs estao aguardando resposta.
    // Só retorna pedidos "manual" (clique no modal) — os "auto" (revalidação em segundo
    // plano) têm fila própria em /api/to-detail-pending-auto. Antes eram a mesma fila e um
    // clique manual ficava preso atrás de uma leva de 60 automáticos já em processamento
    // (o to_detail_sync busca a lista uma vez e processa tudo em sequência antes de checar
    // de novo) — separando de vez, o loop manual nunca espera o automático.
    if (urlPath === '/api/to-detail-pending') {
      pruneToDetailRequests();
      const pending = [...toDetailRequests.entries()]
        .filter(([, r]) => !r.result && !r.error && r.source !== 'auto')
        .map(([to_number]) => to_number);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      res.end(JSON.stringify({ pending }));
      return;
    }

    // GET /api/to-detail-pending-auto — fila separada, só pra revalidação em segundo plano
    if (urlPath === '/api/to-detail-pending-auto') {
      pruneToDetailRequests();
      const pending = [...toDetailRequests.entries()]
        .filter(([, r]) => !r.result && !r.error && r.source === 'auto')
        .map(([to_number]) => to_number);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      res.end(JSON.stringify({ pending }));
      return;
    }

    // POST /api/to-detail-result — to_detail_sync devolve o detalhe buscado no SPX
    if (urlPath === '/api/to-detail-result' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { to_number, data, error } = JSON.parse(body);
          if (!to_number) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'to_number obrigatório' }));
            return;
          }
          const entry = toDetailRequests.get(to_number) || { requestedAt: Date.now() };
          entry.result     = data  || null;
          entry.error      = error || null;
          entry.resolvedAt = Date.now();
          toDetailRequests.set(to_number, entry);

          // Se essa TO tinha uma expectativa de status (revalidacao automatica em segundo
          // plano, ou o proprio dashboard verificando ao abrir o modal), confere e evicta
          // sozinho quando o status real ja nao bate mais.
          const expectation = toDetailExpectations.get(to_number);
          if (expectation && data && data.status && data.status !== expectation.expectedStatus) {
            evictTo(to_number, expectation.kind);
            console.log(`[auto-evict] ${to_number} (${expectation.kind}) — status real agora é "${data.status}"`);
          }
          toDetailExpectations.delete(to_number);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/to-detail-result?to_number=X — dashboard consulta se a resposta chegou
    if (urlPath === '/api/to-detail-result' && req.method === 'GET') {
      const to_number = new URL(req.url, 'http://internal').searchParams.get('to_number');
      const entry = to_number ? toDetailRequests.get(to_number) : null;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      if (!entry) { res.end(JSON.stringify({ status: 'unknown' })); return; }
      if (entry.result) { res.end(JSON.stringify({ status: 'done', data: entry.result })); return; }
      if (entry.error)  { res.end(JSON.stringify({ status: 'error', error: entry.error })); return; }
      res.end(JSON.stringify({ status: 'pending' }));
      return;
    }

    // POST /api/destino-lookup-request — stage_in.html pede o destino de uma leva de TOs
    // (as que aparecem nas ruas de inbound staging, via to_number da planilha Report).
    // Só enfileira quem ainda não está em cache nem já pendente.
    if (urlPath === '/api/destino-lookup-request' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { to_numbers } = JSON.parse(body);
          if (!Array.isArray(to_numbers)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'to_numbers deve ser um array' }));
            return;
          }
          pruneDestinoCache();
          const now = Date.now();
          let enqueued = 0;
          to_numbers.forEach(to => {
            if (!to || toDestinoCache.has(to) || destinoLookupPending.has(to)) return;
            destinoLookupPending.set(to, now);
            enqueued++;
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, enqueued }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/destino-lookup-pending — to_detail_sync busca quais TOs aguardam lookup de destino
    if (urlPath === '/api/destino-lookup-pending') {
      pruneDestinoCache();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      res.end(JSON.stringify({ pending: [...destinoLookupPending.keys()] }));
      return;
    }

    // POST /api/destino-lookup-result — to_detail_sync devolve o detalhe buscado no SPX
    if (urlPath === '/api/destino-lookup-result' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { to_number, sortCodeCounts, error } = JSON.parse(body);
          if (!to_number) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'to_number obrigatório' }));
            return;
          }
          destinoLookupPending.delete(to_number);
          if (sortCodeCounts && typeof sortCodeCounts === 'object') {
            const destinoBreakdown = {};
            for (const [rawCode, count] of Object.entries(sortCodeCounts)) {
              const name = nameFromSortCode(rawCode) || rawCode;
              destinoBreakdown[name] = (destinoBreakdown[name] || 0) + count;
            }
            toDestinoCache.set(to_number, { destinoBreakdown, fetchedAt: Date.now() });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/destino-lookup-cache — dashboard busca tudo que já foi descoberto até agora
    if (urlPath === '/api/destino-lookup-cache') {
      const items = {};
      for (const [to, r] of toDestinoCache) items[to] = { destinoBreakdown: r.destinoBreakdown || {} };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ items, total: toDestinoCache.size, fetchedAt: Date.now() }));
      return;
    }

    // POST /api/rua-detail-request — dashboard pede o detalhe de TOs/gaiolas de uma rua
    if (urlPath === '/api/rua-detail-request' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { staging_area_id } = JSON.parse(body);
          if (!staging_area_id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'staging_area_id obrigatório' }));
            return;
          }
          pruneRuaDetailRequests();
          const existing = ruaDetailRequests.get(staging_area_id);
          if (!existing || existing.result || existing.error) {
            ruaDetailRequests.set(staging_area_id, { requestedAt: Date.now(), resolvedAt: null, result: null, error: null });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/rua-detail-pending — to_detail_sync busca quais ruas estao aguardando resposta
    if (urlPath === '/api/rua-detail-pending') {
      pruneRuaDetailRequests();
      const pending = [...ruaDetailRequests.entries()]
        .filter(([, r]) => !r.result && !r.error)
        .map(([staging_area_id]) => staging_area_id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      res.end(JSON.stringify({ pending }));
      return;
    }

    // POST /api/rua-detail-result — to_detail_sync devolve o detalhe buscado no SPX
    if (urlPath === '/api/rua-detail-result' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { staging_area_id, data, error } = JSON.parse(body);
          if (!staging_area_id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'staging_area_id obrigatório' }));
            return;
          }
          const entry = ruaDetailRequests.get(staging_area_id) || { requestedAt: Date.now() };
          entry.result     = data  || null;
          entry.error      = error || null;
          entry.resolvedAt = Date.now();
          ruaDetailRequests.set(staging_area_id, entry);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/rua-detail-result?staging_area_id=X — dashboard consulta se a resposta chegou
    if (urlPath === '/api/rua-detail-result' && req.method === 'GET') {
      const staging_area_id = new URL(req.url, 'http://internal').searchParams.get('staging_area_id');
      const entry = staging_area_id ? ruaDetailRequests.get(staging_area_id) : null;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      if (!entry) { res.end(JSON.stringify({ status: 'unknown' })); return; }
      if (entry.result) { res.end(JSON.stringify({ status: 'done', data: entry.result })); return; }
      if (entry.error)  { res.end(JSON.stringify({ status: 'error', error: entry.error })); return; }
      res.end(JSON.stringify({ status: 'pending' }));
      return;
    }

    // POST /api/to-evict — remove uma TO especifica do merge acumulado de packing/packed.
    // O merge por to_number so remove itens por idade (ver TO_MERGE_MAX_AGE_MS); quando o
    // dashboard confirma via lookup ao vivo (modal de detalhe) que uma TO ja mudou de status
    // e nao devia mais aparecer, ele chama isso pra corrigir na hora em vez de esperar a poda.
    if (urlPath === '/api/to-evict' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { to_number, kind } = JSON.parse(body);
          if (!to_number || (kind !== 'packing' && kind !== 'packed')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'to_number e kind ("packing"|"packed") obrigatórios' }));
            return;
          }
          const removed = evictTo(to_number, kind);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, removed }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/stage-in-data — receives inbound staging area data from Tampermonkey
    if (urlPath === '/api/stage-in-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const parsed  = JSON.parse(body);
          const station = String(parsed.station_id ?? DEFAULT_STATION);
          stageInCacheByStation.set(station, parsed);
          console.log(`[stage-in] Received ${parsed.list?.length}/${parsed.total} ruas (station ${station})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/stage-in?station=X — serves inbound staging data to dashboard
    if (urlPath === '/api/stage-in') {
      const stageInCache = stageInCacheByStation.get(stationParam(req));
      if (!stageInCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No data yet — open SPX page with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(stageInCache));
      return;
    }

    // POST /api/queue-data — receives vehicle queue from Tampermonkey
    if (urlPath === '/api/queue-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const parsed  = JSON.parse(body);
          const station = inferStation(parsed.list, 'station_id');
          queueCacheByStation.set(station, parsed);
          console.log(`[queue] Received ${parsed.list?.length}/${parsed.total} vehicles (station ${station})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/trip-data — receives trip list from Tampermonkey (payload traz station_id,
    // pois um trip pode envolver varias estacoes — nao da pra inferir de um campo so)
    if (urlPath === '/api/trip-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const parsed  = JSON.parse(body);
          const station = String(parsed.station_id ?? DEFAULT_STATION);
          tripCacheByStation.set(station, parsed);
          console.log(`[trips] Received ${parsed.list?.length} trips (station ${station})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/trips?station=X — serves trip list to dashboard
    if (urlPath === '/api/trips') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(tripCacheByStation.get(stationParam(req)) || { list: [], fetchedAt: null }));
      return;
    }

    // POST /api/trip-history-data — receives trip history from Tampermonkey (merge por
    // trip_number, particionado por estacao — cada estacao mantem seu proprio historico)
    if (urlPath === '/api/trip-history-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          const inList   = incoming.list || [];
          const station  = String(incoming.station_id ?? DEFAULT_STATION);
          const slot     = tripHistoryCacheByStation.get(station) || { list: [], fetchedAt: null };
          // Merge by trip_number — incoming data overwrites existing (more up-to-date)
          const map = new Map(slot.list.map(t => [t.trip_number, t]));
          inList.forEach(t => { if (t.trip_number) map.set(t.trip_number, t); });
          const updated = { list: Array.from(map.values()), fetchedAt: incoming.fetchedAt || Date.now() };
          tripHistoryCacheByStation.set(station, updated);
          console.log(`[trip-history] Merged → ${updated.list.length} trips (received ${inList.length}, station ${station})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, total: updated.list.length }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/trip-history?station=X — serves trip history to dashboard
    if (urlPath === '/api/trip-history') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(tripHistoryCacheByStation.get(stationParam(req)) || { list: [], fetchedAt: null }));
      return;
    }

    // GET /api/queue?station=X — serves vehicle queue to dashboard
    if (urlPath === '/api/queue') {
      const queueCache = queueCacheByStation.get(stationParam(req));
      if (!queueCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No data yet — open SPX page with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(queueCache));
      return;
    }

    // GET /api/report-data?station=X — serves package data from Report sheet
    if (urlPath === '/api/report-data') {
      if (!SERVICE_ACCOUNT) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Account não configurado — configure GOOGLE_SERVICE_ACCOUNT no Render' }));
        return;
      }
      getReportData(stationParam(req))
        .then(data => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify(data));
        })
        .catch(err => {
          console.error('[report] Erro:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }

    // GET /api/profile-data — serves package profile breakdown per TO (aba "db")
    if (urlPath === '/api/profile-data') {
      if (!SERVICE_ACCOUNT) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Account não configurado — configure GOOGLE_SERVICE_ACCOUNT no Render' }));
        return;
      }
      getProfileData()
        .then(data => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify(data));
        })
        .catch(err => {
          console.error('[profile] Erro:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }

    // POST /api/seatalk-report — recebe screenshot do Tampermonkey e envia ao SeaTalk.
    // station_id opcional no body (self-report, igual aos outros scripts que rodam por
    // estação) — sem ele, assume DEFAULT_STATION (mantém compatível com os scripts antigos).
    if (urlPath === '/api/seatalk-report' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        try {
          const { tab, image, text, station_id } = JSON.parse(body);
          if (!tab || !image) throw new Error('tab e image são obrigatórios');
          const station = String(station_id ?? DEFAULT_STATION);
          const key     = reportKey(tab, station);
          // Salva o screenshot em memória (servido como PNG na URL abaixo)
          const b64 = image.replace(/^data:image\/[a-z]+;base64,/, '');
          const imgBuffer = Buffer.from(b64, 'base64');
          screenshotStore[key] = imgBuffer; // guardado também para servir via GET
          // Cooldown: ignora se já foi enviado nos últimos 2 minutos (evita duplicatas)
          const now = Date.now();
          if (lastReportSent[key] && now - lastReportSent[key] < REPORT_COOLDOWN) {
            console.log(`[seatalk] Report "${key}" ignorado — cooldown ativo (${Math.round((REPORT_COOLDOWN - (now - lastReportSent[key])) / 1000)}s restantes)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, skipped: true }));
            return;
          }
          lastReportSent[key] = now;
          // Dispara o envio ao SeaTalk (não bloqueia a resposta)
          sendSeaTalkReport(tab, imgBuffer, text, station).catch(e => console.error('[seatalk]', e.message));
          const url = `https://stage-out.onrender.com/api/screenshot/${key}.png`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url }));
        } catch (e) {
          console.error('[seatalk-report]', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /api/seatalk-queue-report — recebe screenshot + texto do Tampermonkey e envia ao
    // SeaTalk (Queue bot). station_id opcional no body — sem ele, assume DEFAULT_STATION.
    if (urlPath === '/api/seatalk-queue-report' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        try {
          const { image, text, station_id } = JSON.parse(body);
          if (!image) throw new Error('image é obrigatório');
          const station = String(station_id ?? DEFAULT_STATION);
          const key     = reportKey('queue', station);
          const b64 = image.replace(/^data:image\/[a-z]+;base64,/, '');
          const imgBuffer = Buffer.from(b64, 'base64');
          screenshotStore[key] = imgBuffer;
          const now = Date.now();
          if (lastReportSent[key] && now - lastReportSent[key] < REPORT_COOLDOWN) {
            console.log(`[seatalk-queue] cooldown ativo (${key})`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, cooldown: true }));
            return;
          }
          lastReportSent[key] = now;
          const groupId = SEATALK_QUEUE_GROUP_ID_BY_STATION[station];
          if (!groupId) throw new Error(`Sem grupo SeaTalk (queue) configurado pra estação ${station}`);
          sendSeaTalkQueueReport(imgBuffer, text || '🚛 Queue List · Inbound', groupId).catch(e => console.error('[seatalk-queue]', e.message));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('[seatalk-queue-report]', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /api/seatalk-packing-report — Produtividade Packing → mesmo bot da Queue.
    // Só existe pro Jaboatão (não pedido pro Recife04) — grupo fica fixo como antes.
    if (urlPath === '/api/seatalk-packing-report' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        try {
          const { image, text } = JSON.parse(body);
          if (!image) throw new Error('image é obrigatório');
          const b64 = image.replace(/^data:image\/[a-z]+;base64,/, '');
          const imgBuffer = Buffer.from(b64, 'base64');
          screenshotStore['packing'] = imgBuffer;
          const now = Date.now();
          if (lastReportSent['packing'] && now - lastReportSent['packing'] < REPORT_COOLDOWN) {
            console.log('[seatalk-packing] cooldown ativo');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, cooldown: true }));
            return;
          }
          lastReportSent['packing'] = now;
          sendSeaTalkQueueReport(imgBuffer, text || '📦 Produtividade Packing', SEATALK_QUEUE_GROUP_ID).catch(e => console.error('[seatalk-packing]', e.message));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('[seatalk-packing-report]', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // GET /api/screenshot/:tab.png — serve o último screenshot em memória
    if (urlPath.startsWith('/api/screenshot/') && req.method === 'GET') {
      const tab = urlPath.replace('/api/screenshot/', '').replace('.png', '');
      const buf = screenshotStore[tab];
      if (!buf) {
        res.writeHead(404); res.end('Screenshot not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      res.end(buf);
      return;
    }

    // POST /api/workstation-data — receives workstation productivity from Tampermonkey
    if (urlPath === '/api/workstation-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const parsed  = JSON.parse(body);
          const station = String(parsed.station_id ?? DEFAULT_STATION);
          workstationCacheByStation.set(station, parsed);
          const ws = parsed.workstations?.length || 0;
          const op = parsed.operators?.length    || 0;
          console.log(`[workstation] Received ${ws} workstations · ${op} operators (station ${station})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/workstation?station=X — serves workstation data to dashboard
    if (urlPath === '/api/workstation') {
      const workstationCache = workstationCacheByStation.get(stationParam(req));
      if (!workstationCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No data yet — open SPX page with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(workstationCache));
      return;
    }

    // GET /api/debug/stage-sample — inspeciona estrutura de um item do stageCache
    if (urlPath === '/api/debug/stage-sample') {
      const sample = stageCacheByStation.get(stationParam(req))?.list?.[0] ?? null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: sample ? Object.keys(sample) : [], sample }, null, 2));
      return;
    }

    // POST /api/cage-map-data — recebe mapeamento gaiola→rua + sacas do Tampermonkey
    if (urlPath === '/api/cage-map-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          cageMapCache = JSON.parse(body);
          const cages = Object.keys(cageMapCache.cageMap  || {}).length;
          const areas = Object.keys(cageMapCache.byArea   || {}).length;
          const sacas = Object.values(cageMapCache.byArea || {}).reduce((s, a) => s + (a.sacas || 0), 0);
          console.log(`[cage-map] ${cages} gaiolas · ${areas} ruas · ${sacas} sacas`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, cages, areas, sacas }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/cage-data — sacas por rua (calculado pelo Tampermonkey via SPX cage API)
    if (urlPath === '/api/cage-data') {
      if (!cageMapCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Aguardando sync do Tampermonkey — abra o SPX e aguarde' }));
        return;
      }
      const byArea = cageMapCache.byArea || {};
      const byCage = cageMapCache.byCage || {};
      const total  = Object.values(byArea).reduce((s, a) => s + (a.sacas || 0), 0);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ byArea, byCage, total, fetchedAt: cageMapCache.fetchedAt }));
      return;
    }

    // GET /api/stage-out?station=X — serves stage-out data to dashboard
    if (urlPath === '/api/stage-out') {
      const stageCache = stageCacheByStation.get(stationParam(req));
      if (!stageCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No data yet — open SPX page with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(stageCache));
      return;
    }

    if (urlPath === '/api/data') {
      getData((err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(data));
      });
      return;
    }

    // ── Normalized module helpers ─────────────────────────────────────────
    function moduleWrap(name, cache) {
      if (!cache) return { module: name, updatedAt: null, data: null };
      return { module: name, updatedAt: cache.fetchedAt || new Date().toISOString(), data: cache };
    }

    // GET /api/packing?station=X — normalized alias for tos-packing
    if (urlPath === '/api/packing') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(moduleWrap('packing', filterByStationField(toPackingCache, 'current_station_id', stationParam(req)))));
      return;
    }

    // GET /api/packed?station=X — normalized alias for tos-packed
    if (urlPath === '/api/packed') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(moduleWrap('packed', filterByStationField(toPackedCache, 'current_station_id', stationParam(req)))));
      return;
    }

    // GET /api/inbound?station=X — normalized alias for queue
    if (urlPath === '/api/inbound') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(moduleWrap('inbound', queueCacheByStation.get(stationParam(req)))));
      return;
    }

    // GET /api/transbordo?station=X — normalized alias combining trip-history + live trips + queue
    if (urlPath === '/api/transbordo') {
      const station = stationParam(req);
      const tripHistoryCache = tripHistoryCacheByStation.get(station) || { list: [], fetchedAt: null };
      const combined = {
        list:      tripHistoryCache.list || [],
        liveTrips: tripCacheByStation.get(station)?.list  || [],
        queue:     queueCacheByStation.get(station)?.list || [],
        fetchedAt: tripHistoryCache.fetchedAt,
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(moduleWrap('transbordo', combined)));
      return;
    }

    // GET /api/dashboard?station=X — single consolidated snapshot of all modules
    if (urlPath === '/api/dashboard') {
      const station = stationParam(req);
      const tripHistoryCache = tripHistoryCacheByStation.get(station) || { list: [], fetchedAt: null };
      const transbData = {
        list:      tripHistoryCache.list || [],
        liveTrips: tripCacheByStation.get(station)?.list  || [],
        queue:     queueCacheByStation.get(station)?.list || [],
        fetchedAt: tripHistoryCache.fetchedAt,
      };
      const dashboard = {
        module:    'dashboard',
        updatedAt: new Date().toISOString(),
        data: {
          stageOut:   moduleWrap('stage_out',   stageCacheByStation.get(station)),
          packing:    moduleWrap('packing',      filterByStationField(toPackingCache, 'current_station_id', station)),
          packed:     moduleWrap('packed',       filterByStationField(toPackedCache, 'current_station_id', station)),
          stageIn:    moduleWrap('stage_in',     stageInCacheByStation.get(station)),
          inbound:    moduleWrap('inbound',      queueCacheByStation.get(station)),
          transbordo: moduleWrap('transbordo',   transbData),
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(dashboard));
      return;
    }

    // POST /api/productivity-timelist — receives time_list from Tampermonkey (authoritative hourly totals)
    if (urlPath === '/api/productivity-timelist' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const parsed  = JSON.parse(body);
          const station = String(parsed.station_id ?? DEFAULT_STATION);
          prodTimelistCacheByStation.set(station, parsed);
          console.log(`[prod-timelist] ${parsed.time_list?.length} horas (station ${station})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/productivity-timelist?station=X
    if (urlPath === '/api/productivity-timelist') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(prodTimelistCacheByStation.get(stationParam(req)) || { time_list: [] }));
      return;
    }

    // POST /api/productivity-individual-data — receives hourly operator data from Tampermonkey
    if (urlPath === '/api/productivity-individual-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const key = payload.hora;
          if (!key) throw new Error('Missing hora field');
          const station = String(payload.station_id ?? DEFAULT_STATION);
          const slot = getProdIndividualSlot(station);
          slot[key] = payload;
          // Keep only last 24 hours
          const keys = Object.keys(slot).sort();
          if (keys.length > 24) keys.slice(0, keys.length - 24).forEach(k => delete slot[k]);
          console.log(`[prod-individual] ${key}: ${payload.records?.length} registros (station ${station})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/productivity-meta — metas por hora (aba Visual)
    if (urlPath === '/api/productivity-meta') {
      if (!SERVICE_ACCOUNT) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Account não configurado — configure GOOGLE_SERVICE_ACCOUNT no Render' }));
        return;
      }
      getMetaData()
        .then(data => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify(data));
        })
        .catch(err => {
          console.error('[productivity-meta] Erro:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }

    // GET /api/productivity-individual?station=X — serves per-hour operator productivity to dashboard
    if (urlPath === '/api/productivity-individual') {
      const slot = getProdIndividualSlot(stationParam(req));
      const keys = Object.keys(slot);
      if (!keys.length) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No data yet — open SPX page with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ hours: slot }));
      return;
    }

    let filePath = path.join(__dirname, urlPath === '/' ? 'dashboard.html' : urlPath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext  = path.extname(filePath);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });

  const PORT = process.env.PORT || 4200;
  setInterval(async () => {
    try {
      const now = new Date();
      const currentHour = now.getHours();

      if (lastSavedHour === currentHour) return;
      if (now.getMinutes() !== 0 && now.getMinutes() !== 1) return;

      console.log('[WS HOURLY] ⏱️ Fechando hora', currentHour);

      const rows = buildHourlyRows();

      if (rows.length === 0) {
        console.log('[WS HOURLY] Nenhum dado');
        return;
      }

      await appendToSheet(rows);

      lastSavedHour = currentHour;

      console.log(`[WS HOURLY] ✅ ${rows.length} linhas salvas`);
    } catch (e) {
      console.error('[WS HOURLY] ❌ Erro:', e.message);
    }
  }, 60 * 1000); // roda a cada 1 min

  function safeScheduleRevalidation() {
    try { scheduleRevalidation(); }
    catch (e) { console.error('[revalidate] erro (ignorado):', e.message); }
  }
  setInterval(safeScheduleRevalidation, REVALIDATE_INTERVAL_MS);
  setTimeout(safeScheduleRevalidation, 15 * 1000); // primeira leva logo apos o boot, sem esperar 5min

  function safeFlushSacasSheet() {
    flushSacasSheet().catch(e => console.error('[sacas-sheet] erro inesperado (ignorado):', e.message));
  }
  setInterval(safeFlushSacasSheet, SACAS_SHEET_FLUSH_MS);

  server.listen(PORT, () => console.log(`Dashboard → http://localhost:${PORT}`));
