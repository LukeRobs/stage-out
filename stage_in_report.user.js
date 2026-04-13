// ==UserScript==
// @name         Stage IN - SeaTalk Hourly Report
// @namespace    spx-express
// @version      1.3
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
    'position:fixed', 'bottom:144px', 'right:16px',
    'background:#1a1a2e', 'border:1px solid #334', 'color:#aaa',
    'padding:5px 11px', 'border-radius:20px', 'font-size:11px',
    'font-family:monospace', 'z-index:9999', 'cursor:pointer',
    'user-select:none', 'transition:all .2s',
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

  /* ── Stats Volumoso ─────────────────────────────────────────────── */
  async function fetchVolumosoText() {
    const resp = await fetch(`${SERVER}/api/report-data`);
    if (!resp.ok) throw new Error(`report-data HTTP ${resp.status}`);
    const data = await resp.json();

    const volRuas = Object.entries(data.byArea || {})
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
    return `Report SPP Volumoso:\nTotal TO's: ${totalTOs}\nTO's > 30: ${tosGt30}\nAging Médio: ${agingMedio}h`;
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

    try {
      // ══ 1. TODAS ══════════════════════════════════════════════════
      setBadge('📸 Capturando Todas...', '#f59e0b');
      const imgTodas = await captureTab('all');
      if (imgTodas) {
        setBadge('📤 Enviando Todas...', '#3b82f6');
        await postReport('todas', imgTodas);
        setBadge('✅ Todas enviado!', '#22c55e');
      }

      await sleep(2000);

      // ══ 2. VOLUMOSO ═══════════════════════════════════════════════
      setBadge('📸 Capturando Volumoso...', '#f59e0b');
      const imgVol = await captureTab('ZONA VOLUMOSO');
      if (imgVol) {
        setBadge('📊 Buscando stats...', '#a855f7');
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

  console.log('[Stage IN Report] ✅ v1.3 — Bot API direto, a cada hora cheia (:00)');
})();
