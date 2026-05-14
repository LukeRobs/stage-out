// ==UserScript==
// @name         Stage IN - SeaTalk Hourly Report
// @namespace    spx-express
// @version      1.8
// @description  Captura screenshot do dashboard Stage IN e envia ao SeaTalk a cada hora cheia
// @author       SPX Express
// @match        https://stage-out.onrender.com/stage_in.html
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER = 'https://stage-out.onrender.com';
  const sleep  = ms => new Promise(r => setTimeout(r, ms));

  /* ── Badge de status ─────────────────────────────────────────────── */
  const badge = document.createElement('div');
  badge.style.cssText = [
    'position:fixed', 'top:6px', 'right:220px',
    'background:#1a1a2e', 'border:1px solid #334', 'color:#aaa',
    'padding:3px 10px', 'border-radius:20px', 'font-size:11px',
    'font-family:monospace', 'z-index:9999', 'cursor:pointer',
    'user-select:none', 'transition:all .2s', 'line-height:20px',
  ].join(';');
  badge.title = 'Clique para enviar report agora';
  badge.textContent = '📊 Report Auto';
  document.body.appendChild(badge);

  function setBadge(text, color) {
    badge.textContent = text;
    badge.style.color = color || '#aaa';
  }

  /* ── Captura de tela ─────────────────────────────────────────────── */
  async function captureTab(dataZone) {
    const btn = document.querySelector(`.zone-tab[data-zone="${dataZone}"]`);
    if (!btn) { console.warn(`[Report] Aba "${dataZone}" não encontrada`); return null; }
    btn.click();
    await sleep(3500);

    const canvas = await html2canvas(document.body, {
      scale:        1,
      useCORS:      true,
      allowTaint:   true,
      scrollY:      0,
      scrollX:      0,
      windowWidth:  window.innerWidth,
      windowHeight: window.innerHeight,
      logging:      false,
    });
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  /* ── Busca dados da API (compartilhado) ─────────────────────────── */
  let _rdCache = null;
  async function fetchReportData() {
    if (_rdCache) return _rdCache;
    const resp = await fetch(`${SERVER}/api/report-data`);
    if (!resp.ok) throw new Error(`report-data HTTP ${resp.status}`);
    _rdCache = await resp.json();
    return _rdCache;
  }

  /* ── Helper: agrega métricas por conjunto de ruas ───────────────── */
  function calcStats(ruas, rd) {
    let totalTOs = 0, agingEntries = 0, totalAging = 0, totalPacotes = 0, tosGt30 = 0;
    const sppPerRua = [];
    for (const rua of ruas) {
      const areaData   = rd.byArea?.[rua];
      const ruaTOs     = areaData?.to_quantity || 0; // nº real de TOs (campo correto)
      if (ruaTOs === 0) continue;
      const tos        = rd.byAreaTOs?.[rua] || [];
      const ruaPacotes = tos.reduce((s, t) => s + t.pacotes, 0);
      totalTOs     += ruaTOs;
      totalPacotes += ruaPacotes;
      for (const to of tos) {
        if (to.pacotes > 30) tosGt30++;
        totalAging += to.aging_h;
        agingEntries++;
      }
      if (ruaPacotes > 0) sppPerRua.push(ruaPacotes / ruaTOs);
    }
    const avgH = agingEntries > 0 ? totalAging / agingEntries : 0;
    const hh   = Math.floor(avgH);
    const mm   = Math.round((avgH - hh) * 60);
    return {
      totalTOs, totalPacotes, tosGt30, sppPerRua,
      agingStr:  hh > 0 ? `${hh}h ${mm}min` : `${mm}min`,
      spp:       totalTOs > 0 ? Math.round(totalPacotes / totalTOs) : '—',
      maxSpp:    sppPerRua.length ? Math.round(Math.max(...sppPerRua)) : '—',
      minSpp:    sppPerRua.length ? Math.round(Math.min(...sppPerRua)) : '—',
    };
  }

  /* ── Stats Volumoso (formato simples) ───────────────────────────── */
  async function fetchVolumosoText() {
    const now  = new Date();
    const data = now.toLocaleDateString('pt-BR');
    const hora = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const rd   = await fetchReportData();
    const ruas = Object.entries(rd.byArea || {})
      .filter(([, d]) => d.zona === 'ZONA VOLUMOSO').map(([r]) => r);
    const { totalTOs, tosGt30, agingStr, spp, maxSpp, minSpp } = calcStats(ruas, rd);

    return [
      `Report - SPP Volumoso (${data}):`,
      `Hora: ${hora}`,
      ``,
      `Total TO's: ${totalTOs}`,
      `TO's > 30: ${tosGt30}`,
      `Aging Médio: ${agingStr}`,
      `SPP: ${spp}`,
      `MAX SPP: ${maxSpp}`,
      `MIN SPP: ${minSpp}`,
      ``,
      `Link para acompanhamento: https://stage-out.onrender.com/stage_in.html`,
    ].join('\n');
  }

  /* ── Helper: formata aging em horas → "2h07m" / "1d16h" ─────────── */
  function fmtAging(h) {
    if (h <= 0) return '—';
    if (h >= 24) {
      const d  = Math.floor(h / 24);
      const hh = Math.floor(h % 24);
      return hh > 0 ? `${d}d${hh}h` : `${d}d`;
    }
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60).toString().padStart(2, '0');
    return hh > 0 ? `${hh}h${mm}m` : `${mm}min`;
  }

  /* ── Stats Geral · TODAS as zonas com breakdown por zona ────────── */
  async function fetchTodasText() {
    const now  = new Date();
    const data = now.toLocaleDateString('pt-BR');
    const hora = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const rd   = await fetchReportData();
    const ruas = Object.keys(rd.byArea || {});
    const { totalTOs, agingStr, spp, maxSpp, minSpp, sppPerRua } = calcStats(ruas, rd);

    // Breakdown por zona
    const zoneMap = {};
    for (const [rua, areaData] of Object.entries(rd.byArea || {})) {
      const ruaTOs = areaData?.to_quantity || 0;
      if (ruaTOs === 0) continue;
      const zona = (areaData.zona || 'OUTRAS').replace('ZONA ', '');
      if (!zoneMap[zona]) zoneMap[zona] = { tos: 0, pac: 0, agingSum: 0, agingMax: 0, agingEntries: 0, sppVals: [] };
      const tos        = rd.byAreaTOs?.[rua] || [];
      const ruaPacotes = tos.reduce((s, t) => s + t.pacotes, 0);
      zoneMap[zona].tos += ruaTOs;
      zoneMap[zona].pac += ruaPacotes;
      for (const to of tos) {
        zoneMap[zona].agingSum += to.aging_h;
        zoneMap[zona].agingEntries++;
        if (to.aging_h > zoneMap[zona].agingMax) zoneMap[zona].agingMax = to.aging_h;
      }
      if (ruaPacotes > 0) zoneMap[zona].sppVals.push(ruaPacotes / ruaTOs);
    }

    const zoneLines = Object.entries(zoneMap)
      .filter(([, v]) => v.pac > 0)
      .sort((a, b) => b[1].pac - a[1].pac)
      .map(([zona, v]) => {
        const sppZ = v.tos > 0 ? Math.round(v.pac / v.tos) : '—';
        const maxZ = v.sppVals.length ? Math.round(Math.max(...v.sppVals)) : '—';
        const minZ = v.sppVals.length ? Math.round(Math.min(...v.sppVals)) : '—';
        const avg  = v.agingEntries > 0 ? fmtAging(v.agingSum / v.agingEntries) : '—';
        const pico = fmtAging(v.agingMax);
        const pac  = v.pac.toLocaleString('pt-BR');
        return `${zona}: ${v.tos} TO's | ${pac} Pacotes | SPP: ${sppZ} | Max: ${maxZ} | Min: ${minZ} | avg: ${avg} | Pico: ${pico}`;
      });

    // Distribuição SPP por rua (todas as zonas)
    const totalRuas = sppPerRua.length;
    const b1 = sppPerRua.filter(v => v <= 30).length;
    const b2 = sppPerRua.filter(v => v > 30 && v <= 70).length;
    const b3 = sppPerRua.filter(v => v > 70 && v <= 150).length;
    const b4 = sppPerRua.filter(v => v > 150).length;

    return [
      `Report - SPP Geral Stage IN (${data}):`,
      `Hora: ${hora}`,
      ``,
      `Total TO's: ${totalTOs}`,
      `Total Ruas: ${totalRuas}`,
      `Aging Médio: ${agingStr}`,
      `SPP Médio: ${spp}  |  MAX: ${maxSpp}  |  MIN: ${minSpp}`,
      ...zoneLines,
      ``,
      `Distribuição SPP por Rua:`,
      `  ≤ 30       → ${b1} ruas`,
      `  >30 e ≤70  → ${b2} ruas`,
      `  >70 e ≤150 → ${b3} ruas`,
      `  >150       → ${b4} ruas`,
      ``,
      `Link: https://stage-out.onrender.com/stage_in.html`,
    ].join('\n');
  }

  /* ── Envio ao servidor (que repassa ao SeaTalk via Bot API) ─────── */
  function postReport(tab, image, text) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'POST',
        url:     `${SERVER}/api/seatalk-report`,
        headers: { 'Content-Type': 'application/json' },
        data:    JSON.stringify({ tab, image, text }),
        timeout: 60000,
        onload: r => {
          console.log(`[Server] seatalk-report (${tab}):`, r.status, r.responseText);
          if (r.status === 200) resolve(JSON.parse(r.responseText));
          else reject(new Error(`HTTP ${r.status}`));
        },
        onerror:   () => reject(new Error('Erro de rede')),
        ontimeout: () => reject(new Error('Timeout 60s')),
      });
    });
  }

  /* ── Fluxo principal ─────────────────────────────────────────────── */
  async function sendReport() {
    const originalZone = document.querySelector('.zone-tab.active')?.dataset.zone || 'all';
    _rdCache = null; // limpa cache a cada envio

    try {
      // ══ 1. TODAS ══════════════════════════════════════════════════
      setBadge('📸 Capturando Todas...', '#f59e0b');
      const imgTodas = await captureTab('all');
      if (imgTodas) {
        setBadge('📊 Buscando stats gerais...', '#a855f7');
        let todasText;
        try   { todasText = await fetchTodasText(); }
        catch (e) { console.warn('[Report] stats todas fallback:', e.message); todasText = 'Report Geral Stage IN'; }
        setBadge('📤 Enviando Todas...', '#3b82f6');
        await postReport('todas', imgTodas, todasText);
        setBadge('✅ Todas enviado!', '#22c55e');
      }

      await sleep(2000);

      // ══ 2. VOLUMOSO ═══════════════════════════════════════════════
      setBadge('📸 Capturando Volumoso...', '#f59e0b');
      const imgVol = await captureTab('ZONA VOLUMOSO');
      if (imgVol) {
        setBadge('📊 Buscando stats volumoso...', '#a855f7');
        let volText;
        try   { volText = await fetchVolumosoText(); }
        catch (e) { console.warn('[Report] stats fallback:', e.message); volText = 'Time segue Report SPP Volumoso'; }
        setBadge('📤 Enviando Volumoso...', '#3b82f6');
        await postReport('volumoso', imgVol, volText);
        setBadge('✅ Volumoso enviado!', '#22c55e');
      }

      const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      setBadge(`✅ ${agora} enviado`, '#22c55e');
      console.log('[Stage IN Report] ✅ Reports enviados com sucesso!');

    } catch (e) {
      setBadge('❌ Erro no report', '#ef4444');
      console.error('[Stage IN Report] Erro:', e.message);
    } finally {
      await sleep(3000);
      const origBtn = document.querySelector(`.zone-tab[data-zone="${originalZone}"]`);
      if (origBtn) origBtn.click();
      await sleep(10000);
      const h = new Date().getHours().toString().padStart(2, '0');
      setBadge(`📊 Último: ${h}:00`, '#aaa');
    }
  }

  /* ── Agendamento ─────────────────────────────────────────────────── */
  let lastReportHour = -1;
  setInterval(() => {
    const now = new Date();
    if (now.getMinutes() === 0 && now.getHours() !== lastReportHour) {
      lastReportHour = now.getHours();
      sendReport();
    }
  }, 30 * 1000);

  /* ── Clique manual ───────────────────────────────────────────────── */
  badge.addEventListener('click', () => {
    if (badge.textContent.includes('Capturando') || badge.textContent.includes('Enviando')) return;
    sendReport();
  });

  console.log('[Stage IN Report] ✅ v1.8 — Bot API direto, a cada hora cheia (:00)');
})();
