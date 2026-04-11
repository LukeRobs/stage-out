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

function getData(cb) {
  if (dataCache && Date.now() - cacheFetchedAt < CACHE_TTL) {
    return cb(null, dataCache);
  }

  fetchCallbacks.push(cb);
  if (fetchInProgress) return;
  fetchInProgress = true;

  if (SERVICE_ACCOUNT) {
    // ── Path A: Service Account JWT (private sheets) ──────────────────
    getServiceAccountToken()
      .then(token => {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(RANGE)}`;
        return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      })
      .then(r => { if (!r.ok) throw new Error(`Sheets API ${r.status}`); return r.json(); })
      .then(raw => {
        fetchInProgress = false;
        const cbs = fetchCallbacks.splice(0);
        dataCache      = processRawData(raw);
        cacheFetchedAt = Date.now();
        console.log(`[api/data] Refreshed via Service Account — ${dataCache.rowCount} rows`);
        cbs.forEach(fn => fn(null, dataCache));
      })
      .catch(err => {
        fetchInProgress = false;
        const cbs = fetchCallbacks.splice(0);
        console.error('[api/data] Service Account error:', err.message);
        if (dataCache) return cbs.forEach(fn => fn(null, dataCache));
        cbs.forEach(fn => fn(err));
      });
  } else if (USE_API_KEY) {
    // ── Path B: API Key (public sheets only) ─────────────────────────
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(RANGE)}?key=${process.env.SHEETS_API_KEY}`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`Sheets API ${r.status}`); return r.json(); })
      .then(raw => {
        fetchInProgress = false;
        const cbs = fetchCallbacks.splice(0);
        dataCache      = processRawData(raw);
        cacheFetchedAt = Date.now();
        console.log(`[api/data] Refreshed via API Key — ${dataCache.rowCount} rows`);
        cbs.forEach(fn => fn(null, dataCache));
      })
      .catch(err => {
        fetchInProgress = false;
        const cbs = fetchCallbacks.splice(0);
        console.error('[api/data] API Key error:', err.message);
        if (dataCache) return cbs.forEach(fn => fn(null, dataCache));
        cbs.forEach(fn => fn(err));
      });
  } else {
    // ── Path B: gws CLI (local Windows dev, uses OAuth keyring) ──────────
    const params = JSON.stringify({ spreadsheetId: SPREADSHEET_ID, range: RANGE });
    const child  = spawn('cmd.exe', ['/c', 'gws', 'sheets', 'spreadsheets', 'values', 'get', '--params', params],
                          { env: process.env, maxBuffer: 20 * 1024 * 1024 });

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', code => {
      fetchInProgress = false;
      const cbs = fetchCallbacks.splice(0);

      if (code !== 0) {
        const errMsg = stderr.replace(/Using keyring.*\n?/g, '').trim() || `gws exited ${code}`;
        console.error('[api/data] gws error:', errMsg.split('\n')[0]);
        if (dataCache) { console.warn('[api/data] Serving stale cache'); return cbs.forEach(fn => fn(null, dataCache)); }
        return cbs.forEach(fn => fn(new Error(errMsg)));
      }

      try {
        const raw = JSON.parse(stdout);
        dataCache      = processRawData(raw);
        cacheFetchedAt = Date.now();
        console.log(`[api/data] Refreshed via gws — ${dataCache.rowCount} rows, ${dataCache.DATES.length} dates`);
        cbs.forEach(fn => fn(null, dataCache));
      } catch (e) {
        console.error('[api/data] Parse error:', e.message);
        if (dataCache) return cbs.forEach(fn => fn(null, dataCache));
        cbs.forEach(fn => fn(e));
      }
    });

    child.on('error', err => {
      fetchInProgress = false;
      const cbs = fetchCallbacks.splice(0);
      console.error('[api/data] spawn error:', err.message);
      if (dataCache) return cbs.forEach(fn => fn(null, dataCache));
      cbs.forEach(fn => fn(err));
    });
  }
}

// Pre-warm cache on startup
getData((err, data) => {
  if (err) console.error('[startup] Initial data fetch failed:', err.message);
  else     console.log(`[startup] Data ready — ${data.rowCount} rows across ${data.DATES.length} dates`);
});

// ── Stage-out cache (fed by Tampermonkey) ─────────────────────────────
let stageCache      = null; // { list, total, fetchedAt }
let toPackingCache  = null; // { list, total, fetchedAt }
let toPackedCache   = null; // { list, total, fetchedAt }
let stageInCache    = null; // { list, total, fetchedAt }

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

  rows.forEach(r => {
    const zona    = (r[1] || '').trim();
    const rua     = (r[4] || '').trim();
    const pacotes = parseInt(r[3]) || 0;
    if (zona) {
      if (!byZone[zona]) byZone[zona] = { tos: 0, pacotes: 0 };
      byZone[zona].tos++;
      byZone[zona].pacotes += pacotes;
    }
    if (rua) {
      if (!byArea[rua]) byArea[rua] = { tos: 0, pacotes: 0 };
      byArea[rua].tos++;
      byArea[rua].pacotes += pacotes;
    }
  });

  reportCache      = { byZone, byArea, rowCount: rows.length, fetchedAt: Date.now() };
  reportFetchedAt  = Date.now();
  console.log(`[report] ${rows.length} linhas lidas — ${Object.keys(byZone).length} zonas, ${Object.keys(byArea).length} ruas`);
  return reportCache;
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
server.listen(PORT, () => console.log(`Dashboard → http://localhost:${PORT}`));
