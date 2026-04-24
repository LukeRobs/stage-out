// ==UserScript==
// @name         Queue List - SeaTalk Hourly Report
// @namespace    spx-express
// @version      1.0
// @description  Captura screenshot do dashboard Queue List e envia ao SeaTalk a cada hora cheia
// @author       SPX Express
// @match        https://stage-out.onrender.com/queue_list.html
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER = 'https://stage-out.onrender.com';

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
  badge.textContent = '🚛 Report Auto';
  document.body.appendChild(badge);

  function setBadge(text, color) {
    badge.textContent = text;
    badge.style.color = color || '#aaa';
  }

  /* ── Lê os KPIs do DOM ───────────────────────────────────────────── */
  function readKpis() {
    const g = id => (document.getElementById(id) || {}).textContent || '—';
    return {
      total:      g('kTotal'),
      pending:    g('kPending'),
      assigned:   g('kAssigned'),
      occupied:   g('kOccupied'),
      hold:       g('kHold'),
      maxWait:    g('kMaxWait'),
      maxWaitSub: g('kMaxWaitSub'),
    };
  }

  /* ── Monta o texto do report ─────────────────────────────────────── */
  function buildReportText(kpis) {
    const now = new Date();
    const hhmm = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return [
      `🚛 Queue List · Inbound — ${hhmm}`,
      '━━━━━━━━━━━━━━━━━━━━━',
      `Total ativos: ${kpis.total}`,
      `Pendente: ${kpis.pending} | Atribuído: ${kpis.assigned} | Ocupado: ${kpis.occupied} | Em Espera: ${kpis.hold}`,
      `Maior espera: ${kpis.maxWait} (${kpis.maxWaitSub})`,
      ``,
      `Link para acompanhamento: https://stage-out.onrender.com/queue_list.html`,
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

  /* ── Envio ao servidor ───────────────────────────────────────────── */
  function postReport(image, text) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'POST',
        url:     `${SERVER}/api/seatalk-queue-report`,
        headers: { 'Content-Type': 'application/json' },
        data:    JSON.stringify({ image, text }),
        timeout: 60000,
        onload: r => {
          console.log('[Queue Report] seatalk-queue-report:', r.status, r.responseText);
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
      console.log('[Queue Report] ✅ Report enviado com sucesso!');

      await new Promise(r => setTimeout(r, 10000));
      const h = new Date().getHours().toString().padStart(2, '0');
      setBadge(`🚛 Último: ${h}:00`, '#aaa');

    } catch (e) {
      setBadge('❌ Erro no report', '#ef4444');
      console.error('[Queue Report] Erro:', e.message);
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

  console.log('[Queue Report] ✅ v1.0 — Bot API direto, a cada hora cheia (:00)');
})();
