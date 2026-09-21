// ==UserScript==
// @name         Stage Report - SeaTalk Hourly Report · Recife 04
// @namespace    spx-express
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/stage_report_seatalk_recife04.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/stage_report_seatalk_recife04.user.js
// @description  Captura screenshot do Stage Out · Report e envia ao SeaTalk a cada hora cheia
// @author       SPX Express
// @match        https://stage-out.onrender.com/stage_report_recife04.html
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER = 'https://stage-out.onrender.com';
  const sleep  = ms => new Promise(r => setTimeout(r, ms));
  // ID da estação deste computador — MUDE aqui ao instalar numa estação diferente
  const STATION_ID = '15000'; // SoC_PE_Recife_04

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
  badge.textContent = '🚦 Report Auto';
  document.body.appendChild(badge);

  function setBadge(text, color) {
    badge.textContent = text;
    badge.style.color = color || '#aaa';
  }

  /* ── Lê os KPIs já renderizados na tela (a página se auto-atualiza a cada 30s — ver
     stage_report.html REFRESH_MS) ────────────────────────────────────────────────── */
  function readKpis() {
    const g = id => (document.getElementById(id) || {}).textContent || '—';
    return {
      gaiolas:  g('kGaiolas'),
      scuttles: g('kScuttles'),
      sacas:    g('kSacas'),
      ruasOcup: g('kRuasOcup'),
      ocup:     g('kOcup'),
    };
  }

  function buildReportText(k) {
    const now  = new Date();
    const data = now.toLocaleDateString('pt-BR');
    const hora = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return [
      `Report - Stage Out · Recife 04 (${data})`,
      `Hora: ${hora}`,
      ``,
      `Total Gaiolas: ${k.gaiolas}`,
      `Scuttles: ${k.scuttles}`,
      `Total Sacas: ${k.sacas}`,
      `Ruas Ocupadas: ${k.ruasOcup}`,
      `Ocupação Média: ${k.ocup}`,
      ``,
      `Link para acompanhamento: https://stage-out.onrender.com/stage_report_recife04.html`,
    ].join('\n');
  }

  /* ── Captura de tela ─────────────────────────────────────────────── */
  async function captureScreen() {
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

  /* ── Envio ao servidor ────────────────────────────────────────────── */
  function postReport(image, text) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'POST',
        url:     `${SERVER}/api/seatalk-report`,
        headers: { 'Content-Type': 'application/json' },
        data:    JSON.stringify({ tab: 'stage_report', image, text, station_id: STATION_ID }),
        timeout: 60000,
        onload: r => {
          console.log('[Stage Report] seatalk-report:', r.status, r.responseText);
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
    try {
      setBadge('📸 Capturando...', '#f59e0b');
      const kpis  = readKpis();
      const image = await captureScreen();

      setBadge('📤 Enviando...', '#3b82f6');
      const text = buildReportText(kpis);
      await postReport(image, text);

      const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      setBadge(`✅ ${agora} enviado`, '#22c55e');
      console.log('[Stage Report] ✅ Report enviado com sucesso!');

      await sleep(10000);
      const h = new Date().getHours().toString().padStart(2, '0');
      setBadge(`🚦 Último: ${h}:00`, '#aaa');
    } catch (e) {
      setBadge('❌ Erro no report', '#ef4444');
      console.error('[Stage Report] Erro:', e.message);
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

  console.log('[Stage Report] ✅ v1.0 Recife04 — Bot API direto, a cada hora cheia (:00)');
})();
