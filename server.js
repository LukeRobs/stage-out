  const http   = require('http');
  const fs     = require('fs');
  const path   = require('path');
  const crypto = require('crypto');
  const { spawn } = require('child_process');

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
  const SEATALK_GROUP_ID = process.env.SEATALK_GROUP_ID || 'MDQ1OTMwOTc5MzYz';
  const SEATALK_QUEUE_APP_ID     = process.env.SEATALK_QUEUE_APP_ID     || 'MDEwMTk0MDU4NDk1';
  const SEATALK_QUEUE_APP_SECRET = process.env.SEATALK_QUEUE_APP_SECRET || 'X5zPzZyeBkL3MoK9Ks-n_BASneztngPp';
  const SEATALK_QUEUE_GROUP_ID   = process.env.SEATALK_QUEUE_GROUP_ID   || 'MzU3MzMwNjU4MjU1';
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

  async function seaTalkSendText(token, text) {
    const res = await fetchWithTimeout('https://openapi.seatalk.io/messaging/v2/group_chat', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        group_id: SEATALK_GROUP_ID,
        message:  { tag: 'text', text: { content: text } },
      }),
    }, 10000);
    const raw = await res.text();
    console.log('[seatalk] sendText raw:', res.status, raw.substring(0, 300));
    return raw;
  }

  async function seaTalkSendImage(token, tab) {
    const buf = screenshotStore[tab];
    if (!buf) { console.warn('[seatalk] sem buffer de imagem para', tab); return; }

    // API do SeaTalk aceita Base64 direto no campo image.content (PNG/JPG/GIF, max 5MB)
    const b64 = buf.toString('base64');
    const res = await fetchWithTimeout('https://openapi.seatalk.io/messaging/v2/group_chat', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        group_id: SEATALK_GROUP_ID,
        message:  { tag: 'image', image: { content: b64 } },
      }),
    }, 20000);
    const raw = await res.text();
    console.log('[seatalk] sendImg raw:', res.status, raw.substring(0, 300));
  }

  async function getVolumosoStats() {
    const data = await getReportData();
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

  async function sendSeaTalkReport(tab, imgBuffer, overrideText) {
    try {
      const token = await getSeaTalkToken();

      // Texto: usa override do Tampermonkey se presente; senão calcula no servidor
      let text = overrideText;
      if (!text) {
        if (tab === 'volumoso') {
          try {
            const s = await getVolumosoStats();
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
      if (imgBuffer) await seaTalkSendImage(token, tab);
      await new Promise(r => setTimeout(r, 500));

      // 2. Texto
      await seaTalkSendText(token, text);

      console.log(`[seatalk] ✅ Report "${tab}" enviado — ${new Date().toLocaleTimeString('pt-BR')}`);
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

  async function seaTalkQueueSendText(token, text) {
    const res = await fetchWithTimeout('https://openapi.seatalk.io/messaging/v2/group_chat', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        group_id: SEATALK_QUEUE_GROUP_ID,
        message:  { tag: 'text', text: { content: text } },
      }),
    }, 10000);
    const raw = await res.text();
    console.log('[seatalk-queue] sendText raw:', res.status, raw.substring(0, 300));
  }

  async function seaTalkQueueSendImage(token, buf) {
    if (!buf) { console.warn('[seatalk-queue] sem buffer de imagem'); return; }
    const b64 = buf.toString('base64');
    const res = await fetchWithTimeout('https://openapi.seatalk.io/messaging/v2/group_chat', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        group_id: SEATALK_QUEUE_GROUP_ID,
        message:  { tag: 'image', image: { content: b64 } },
      }),
    }, 20000);
    const raw = await res.text();
    console.log('[seatalk-queue] sendImg raw:', res.status, raw.substring(0, 300));
  }

  async function sendSeaTalkQueueReport(imgBuffer, text) {
    try {
      const token = await getSeaTalkQueueToken();
      if (imgBuffer) await seaTalkQueueSendImage(token, imgBuffer);
      await new Promise(r => setTimeout(r, 500));
      await seaTalkQueueSendText(token, text);
      console.log(`[seatalk-queue] ✅ Report enviado — ${new Date().toLocaleTimeString('pt-BR')}`);
    } catch (e) {
      console.error('[seatalk-queue] ❌ Erro:', e.message);
    }
  }

  // ── Stage-out cache (fed by Tampermonkey) ─────────────────────────────
  let stageCache        = null; // { list, total, fetchedAt }
  let toPackingCache    = null; // { list, total, fetchedAt }
  let toPackedCache     = null; // { list, total, fetchedAt }
  let stageInCache      = null; // { list, total, fetchedAt }
  let queueCache        = null; // { list, total, pending_total, occupied_total, ..., fetchedAt }
  let tripCache         = null; // { list, fetchedAt } — trip list v2
  let tripHistoryCache  = { list: [], fetchedAt: null }; // { list, fetchedAt } — trip history (last 7 days)
  let workstationCache  = null; // { workstations, operators, startTime, endTime, fetchedAt }
  let prodIndividualCache = {}; // hora_key → { hora, records, total, start_time, end_time, fetchedAt }

  function buildHourlyRows() {
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
  let   reportCache           = null;
  let   reportFetchedAt       = 0;

  async function getReportData() {
    if (reportCache && Date.now() - reportFetchedAt < REPORT_TTL) return reportCache;
    if (!SERVICE_ACCOUNT) throw new Error('Service Account não configurado');

    const token = await getServiceAccountToken();
    const url   = `https://sheets.googleapis.com/v4/spreadsheets/${REPORT_SPREADSHEET_ID}/values/${encodeURIComponent(REPORT_RANGE)}`;
    const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Sheets API ${resp.status}: ${await resp.text()}`);

    const raw  = await resp.json();
    const rows = (raw.values || []).slice(1); // pula cabeçalho

    // Colunas: A=TO, B=ZONA, C=STATION, D=QTD PACOTES, E=RUA, F=AGING_HOURS, G=Hora now, H=Hora endereçamento, I=Turno
    const byZone = {}; // { "ZONA VOLUMOSO": { tos, pacotes } }
    const byArea = {}; // { "IN-05":          { tos, pacotes } }

    const byTurno   = {}; // { "T1": { tos, pacotes } }
    const byAreaTOs = {}; // { "IN-05": [ { to, pacotes, aging_h, hora_end, turno }, ... ] }

    rows.forEach(r => {
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

    const result = { byZone, byArea, byTurno, byAreaTOs, rowCount: rows.length, fetchedAt: Date.now() };
    console.log(`[report] ${rows.length} linhas lidas — ${Object.keys(byZone).length} zonas, ${Object.keys(byArea).length} ruas`);

    // Só cacheia se tiver dados reais — evita envenar o cache com resultado
    // vazio quando a planilha ainda está calculando após reinício do servidor
    if (rows.length > 0) {
      reportCache     = result;
      reportFetchedAt = Date.now();
    } else {
      console.warn('[report] rowCount=0 — resultado não cacheado, próxima req tentará novamente');
    }
    return result;
  }
  async function forceSaveToSheets() {
  try {
    if (!workstationCache) {
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
  if (!workstationCache) {
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
          stageCache = JSON.parse(body);
          console.log(`[stage-out] Received ${stageCache.list?.length}/${stageCache.total} positions`);
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

    // POST /api/tos-packing-data — receives packing TOs from Tampermonkey
    if (urlPath === '/api/tos-packing-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          toPackingCache = JSON.parse(body);
          console.log(`[tos-packing] Received ${toPackingCache.list?.length}/${toPackingCache.total} TOs`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/tos-packed-data — receives packed TOs from Tampermonkey
    if (urlPath === '/api/tos-packed-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          toPackedCache = JSON.parse(body);
          console.log(`[tos-packed] Received ${toPackedCache.list?.length}/${toPackedCache.total} TOs`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/tos-packing — serves packing data to dashboard
    if (urlPath === '/api/tos-packing') {
      if (!toPackingCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No packing data yet — open SPX with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(toPackingCache));
      return;
    }

    // GET /api/tos-packed — serves packed data to dashboard
    if (urlPath === '/api/tos-packed') {
      if (!toPackedCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No packed data yet — open SPX with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(toPackedCache));
      return;
    }

    // POST /api/stage-in-data — receives inbound staging area data from Tampermonkey
    if (urlPath === '/api/stage-in-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          stageInCache = JSON.parse(body);
          console.log(`[stage-in] Received ${stageInCache.list?.length}/${stageInCache.total} ruas`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/stage-in — serves inbound staging data to dashboard
    if (urlPath === '/api/stage-in') {
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
          queueCache = JSON.parse(body);
          console.log(`[queue] Received ${queueCache.list?.length}/${queueCache.total} vehicles`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/trip-data — receives trip list from Tampermonkey
    if (urlPath === '/api/trip-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          tripCache = JSON.parse(body);
          console.log(`[trips] Received ${tripCache.list?.length} trips`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/trips — serves trip list to dashboard
    if (urlPath === '/api/trips') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(tripCache || { list: [], fetchedAt: null }));
      return;
    }

    // POST /api/trip-history-data — receives trip history from Tampermonkey
    if (urlPath === '/api/trip-history-data' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          const inList   = incoming.list || [];
          // Merge by trip_number — incoming data overwrites existing (more up-to-date)
          const map = new Map(tripHistoryCache.list.map(t => [t.trip_number, t]));
          inList.forEach(t => { if (t.trip_number) map.set(t.trip_number, t); });
          tripHistoryCache = {
            list:      Array.from(map.values()),
            fetchedAt: incoming.fetchedAt || Date.now(),
          };
          console.log(`[trip-history] Merged → ${tripHistoryCache.list.length} trips (received ${inList.length})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, total: tripHistoryCache.list.length }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/trip-history — serves trip history to dashboard
    if (urlPath === '/api/trip-history') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(tripHistoryCache));
      return;
    }

    // GET /api/queue — serves vehicle queue to dashboard
    if (urlPath === '/api/queue') {
      if (!queueCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No data yet — open SPX page with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(queueCache));
      return;
    }

    // GET /api/report-data — serves package data from Report sheet
    if (urlPath === '/api/report-data') {
      if (!SERVICE_ACCOUNT) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Account não configurado — configure GOOGLE_SERVICE_ACCOUNT no Render' }));
        return;
      }
      getReportData()
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

    // POST /api/seatalk-report — recebe screenshot do Tampermonkey e envia ao SeaTalk
    if (urlPath === '/api/seatalk-report' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        try {
          const { tab, image, text } = JSON.parse(body);
          if (!tab || !image) throw new Error('tab e image são obrigatórios');
          // Salva o screenshot em memória (servido como PNG na URL abaixo)
          const b64 = image.replace(/^data:image\/[a-z]+;base64,/, '');
          const imgBuffer = Buffer.from(b64, 'base64');
          screenshotStore[tab] = imgBuffer; // guardado também para servir via GET
          // Cooldown: ignora se já foi enviado nos últimos 2 minutos (evita duplicatas)
          const now = Date.now();
          if (lastReportSent[tab] && now - lastReportSent[tab] < REPORT_COOLDOWN) {
            console.log(`[seatalk] Report "${tab}" ignorado — cooldown ativo (${Math.round((REPORT_COOLDOWN - (now - lastReportSent[tab])) / 1000)}s restantes)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, skipped: true }));
            return;
          }
          lastReportSent[tab] = now;
          // Dispara o envio ao SeaTalk (não bloqueia a resposta)
          sendSeaTalkReport(tab, imgBuffer, text).catch(e => console.error('[seatalk]', e.message));
          const url = `https://stage-out.onrender.com/api/screenshot/${tab}.png`;
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

    // POST /api/seatalk-queue-report — recebe screenshot + texto do Tampermonkey e envia ao SeaTalk (Queue bot)
    if (urlPath === '/api/seatalk-queue-report' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        try {
          const { image, text } = JSON.parse(body);
          if (!image) throw new Error('image é obrigatório');
          const b64 = image.replace(/^data:image\/[a-z]+;base64,/, '');
          const imgBuffer = Buffer.from(b64, 'base64');
          screenshotStore['queue'] = imgBuffer;
          const now = Date.now();
          if (lastReportSent['queue'] && now - lastReportSent['queue'] < REPORT_COOLDOWN) {
            console.log(`[seatalk-queue] cooldown ativo`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, cooldown: true }));
            return;
          }
          lastReportSent['queue'] = now;
          sendSeaTalkQueueReport(imgBuffer, text || '🚛 Queue List · Inbound').catch(e => console.error('[seatalk-queue]', e.message));
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
          workstationCache = JSON.parse(body);
          const ws = workstationCache.workstations?.length || 0;
          const op = workstationCache.operators?.length    || 0;
          console.log(`[workstation] Received ${ws} workstations · ${op} operators`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/workstation — serves workstation data to dashboard
    if (urlPath === '/api/workstation') {
      if (!workstationCache) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No data yet — open SPX page with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(workstationCache));
      return;
    }

    // GET /api/stage-out — serves stage-out data to dashboard
    if (urlPath === '/api/stage-out') {
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

    // GET /api/packing — normalized alias for tos-packing
    if (urlPath === '/api/packing') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(moduleWrap('packing', toPackingCache)));
      return;
    }

    // GET /api/packed — normalized alias for tos-packed
    if (urlPath === '/api/packed') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(moduleWrap('packed', toPackedCache)));
      return;
    }

    // GET /api/inbound — normalized alias for queue
    if (urlPath === '/api/inbound') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(moduleWrap('inbound', queueCache)));
      return;
    }

    // GET /api/transbordo — normalized alias combining trip-history + live trips + queue
    if (urlPath === '/api/transbordo') {
      const combined = {
        list:      tripHistoryCache.list || [],
        liveTrips: tripCache?.list        || [],
        queue:     queueCache?.list       || [],
        fetchedAt: tripHistoryCache.fetchedAt,
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(moduleWrap('transbordo', combined)));
      return;
    }

    // GET /api/dashboard — single consolidated snapshot of all modules
    if (urlPath === '/api/dashboard') {
      const transbData = {
        list:      tripHistoryCache.list || [],
        liveTrips: tripCache?.list        || [],
        queue:     queueCache?.list       || [],
        fetchedAt: tripHistoryCache.fetchedAt,
      };
      const dashboard = {
        module:    'dashboard',
        updatedAt: new Date().toISOString(),
        data: {
          stageOut:   moduleWrap('stage_out',   stageCache),
          packing:    moduleWrap('packing',      toPackingCache),
          packed:     moduleWrap('packed',       toPackedCache),
          stageIn:    moduleWrap('stage_in',     stageInCache),
          inbound:    moduleWrap('inbound',      queueCache),
          transbordo: moduleWrap('transbordo',   transbData),
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(dashboard));
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
          prodIndividualCache[key] = payload;
          // Keep only last 24 hours
          const keys = Object.keys(prodIndividualCache).sort();
          if (keys.length > 24) keys.slice(0, keys.length - 24).forEach(k => delete prodIndividualCache[k]);
          console.log(`[prod-individual] ${key}: ${payload.records?.length} registros`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/productivity-individual — serves per-hour operator productivity to dashboard
    if (urlPath === '/api/productivity-individual') {
      const keys = Object.keys(prodIndividualCache);
      if (!keys.length) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No data yet — open SPX page with Tampermonkey active' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ hours: prodIndividualCache }));
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
  server.listen(PORT, () => console.log(`Dashboard → http://localhost:${PORT}`));
