// ==UserScript==
// @name         TOs Packing - SeaTalk Hourly Report · Recife 04
// @namespace    spx-express
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/LukeRobs/stage-out/main/tos_packing_report_recife04.user.js
// @downloadURL  https://raw.githubusercontent.com/LukeRobs/stage-out/main/tos_packing_report_recife04.user.js
// @description  Captura screenshot da aba Report de TOs Packing e envia ao SeaTalk a cada hora cheia
// @author       SPX Express
// @match        https://stage-out.onrender.com/tos_packing_recife04.html
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER = 'https://stage-out.onrender.com';
  const sleep  = ms => new Promise(r => setTimeout(r, ms));
  // ID da estação deste computador — MUDE aqui ao instalar numa estação diferente
  const STATION_ID   = '15000'; // SoC_PE_Recife_04
  const MAX_AGE_HOURS = 24; // mesmo corte usado pelo dashboard (ver tos_packing.html)

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
  badge.textContent = '📦 Report Auto';
  document.body.appendChild(badge);

  function setBadge(text, color) {
    badge.textContent = text;
    badge.style.color = color || '#aaa';
  }

  /* ── Stats (mesma regra de farol do reportTab — ver tos_packing.html renderReport) ── */
  async function fetchStats() {
    const res  = await fetch(`${SERVER}/api/tos-packing?station=${STATION_ID}`);
    if (!res.ok) throw new Error(`tos-packing HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const nowSec    = Math.floor(Date.now() / 1000);
    const maxAgeSec = MAX_AGE_HOURS * 3600;
    const list = (data.list || []).filter(to => !to.ctime || (nowSec - to.ctime) <= maxAgeSec);

    const farol = { crit: 0, urgente: 0, atencao: 0, ok: 0 };
    let totalPacotes = 0, totalScuttle = 0, totalSacas = 0;
    list.forEach(to => {
      totalPacotes += to.quantity || 0;
      const pn = (to.pack_name || '').toLowerCase();
      if (pn === 'scuttle') totalScuttle++;
      if (pn === 'saca')    totalSacas++;
      const dur = to.ctime ? nowSec - to.ctime : 0;
      if (dur > 21600) farol.crit++;
      else if (dur > 10800) farol.urgente++;
      else if (dur > 3600)  farol.atencao++;
      else farol.ok++;
    });

    return { totalTOs: list.length, totalPacotes, totalScuttle, totalSacas, farol };
  }

  function buildReportText(s) {
    const now  = new Date();
    const data = now.toLocaleDateString('pt-BR');
    const hora = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return [
      `Report - TOs Packing · Recife 04 (${data})`,
      `Hora: ${hora}`,
      ``,
      `Total de TOs: ${s.totalTOs}`,
      `Total de Pacotes: ${s.totalPacotes}`,
      `Scuttle: ${s.totalScuttle}  ·  Saca: ${s.totalSacas}`,
      ``,
      `Farol — OK: ${s.farol.ok}  ·  Atenção: ${s.farol.atencao}  ·  Urgente: ${s.farol.urgente}  ·  Crítico: ${s.farol.crit}`,
      ``,
      `Link para acompanhamento: https://stage-out.onrender.com/tos_packing_recife04.html`,
    ].join('\n');
  }

  /* ── Captura de tela (aba Report) ─────────────────────────────────── */
  async function captureReportTab() {
    const btn = document.getElementById('tabReport');
    if (!btn) { console.warn('[TOs Packing Report] aba Report não encontrada'); return null; }
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

  /* ── Envio ao servidor ────────────────────────────────────────────── */
  function postReport(image, text) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'POST',
        url:     `${SERVER}/api/seatalk-report`,
        headers: { 'Content-Type': 'application/json' },
        data:    JSON.stringify({ tab: 'tos_packing', image, text, station_id: STATION_ID }),
        timeout: 60000,
        onload: r => {
          console.log('[TOs Packing Report] seatalk-report:', r.status, r.responseText);
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
    const dashBtn = document.getElementById('tabDash');
    try {
      setBadge('📊 Buscando stats...', '#a855f7');
      const stats = await fetchStats();

      setBadge('📸 Capturando...', '#f59e0b');
      const image = await captureReportTab();
      if (!image) throw new Error('captura falhou');

      setBadge('📤 Enviando...', '#3b82f6');
      const text = buildReportText(stats);
      await postReport(image, text);

      const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      setBadge(`✅ ${agora} enviado`, '#22c55e');
      console.log('[TOs Packing Report] ✅ Report enviado com sucesso!');
    } catch (e) {
      setBadge('❌ Erro no report', '#ef4444');
      console.error('[TOs Packing Report] Erro:', e.message);
    } finally {
      if (dashBtn) dashBtn.click(); // volta pra aba Dashboard
      await sleep(10000);
      const h = new Date().getHours().toString().padStart(2, '0');
      setBadge(`📦 Último: ${h}:00`, '#aaa');
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
    if (badge.textContent.includes('Buscando') || badge.textContent.includes('Capturando') || badge.textContent.includes('Enviando')) return;
    sendReport();
  });

  console.log('[TOs Packing Report] ✅ v1.0 Recife04 — Bot API direto, a cada hora cheia (:00)');
})();
