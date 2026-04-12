// ==UserScript==
// @name         Stage IN - SeaTalk Hourly Report
// @namespace    spx-express
// @version      1.2
// @description  Captura screenshot do dashboard Stage IN e envia ao SeaTalk a cada hora cheia
// @author       SPX Express
// @match        https://stage-out.onrender.com/stage_in.html
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// @connect      openapi.seatalk.io
// ==/UserScript==

(function () {
  'use strict';

  const SERVER          = 'https://stage-out.onrender.com';
  const SEATALK_WEBHOOK = 'https://openapi.seatalk.io/webhook/group/k5I70tzASiqWTp0_PuqNDg';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  /* ── Envia texto diretamente ao SeaTalk (sem passar pelo servidor) ── */
  function sendToSeatalk(text) {
    return new Promise((resolve, reject) => {
      console.log('[SeaTalk] Enviando mensagem:', text);
      GM_xmlhttpRequest({
        method:  'POST',
        url:     SEATALK_WEBHOOK,
        headers: { 'Content-Type': 'application/json' },
        data:    JSON.stringify({ tag: 'text', text: { content: text } }),
        timeout: 15000,
        onload: r => {
          console.log('[SeaTalk] Resposta:', r.status, r.responseText);
          if (r.status >= 200 && r.status < 300) resolve(r);
          else reject(new Error(`SeaTalk HTTP ${r.status}: ${r.responseText}`));
        },
        onerror:   () => reject(new Error('SeaTalk erro de rede')),
        ontimeout: () => reject(new Error('SeaTalk timeout (15s)')),
      });
    });
  }

  /* ── Envia imagem ao servidor (para Bot API + armazenamento) ─────── */
  function postReport(tab, image) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'POST',
        url:     `${SERVER}/api/seatalk-report`,
        headers: { 'Content-Type': 'application/json' },
        data:    JSON.stringify({ tab, image }),
        timeout: 45000,
        onload:  r => {
          console.log(`[Server] /api/seatalk-report (${tab}):`, r.status, r.responseText);
          if (r.status === 200) resolve(JSON.parse(r.responseText));
          else reject(new Error(`Servidor HTTP ${r.status}: ${r.responseText}`));
        },
        onerror:   () => reject(new Error('Servidor erro de rede')),
        ontimeout: () => reject(new Error('Servidor timeout (45s)')),
      });
    });
  }

  /* ── Captura de tela ─────────────────────────────────────────────── */
  async function captureTab(dataZone) {
    const btn = document.querySelector(`.zone-tab[data-zone="${dataZone}"]`);
    if (!btn) {
      console.warn(`[Report] Aba "${dataZone}" não encontrada`);
      return null;
    }
    btn.click();
    await sleep(3500); // aguarda renderização completa

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
    // JPEG 85% — tamanho menor (~200-400 KB)
    return canvas.toDataURL('image/jpeg', 0.85);
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

        // a) Frase direto ao SeaTalk (confiável, sem servidor)
        await sendToSeatalk('Time segue Report Geral Stage_IN').catch(e =>
          console.error('[SeaTalk] Falhou (todas-frase):', e.message));

        // b) Imagem ao servidor → Bot API (melhor esforço)
        await postReport('todas', imgTodas).catch(e =>
          console.error('[Server] Falhou (todas-img):', e.message));

        setBadge('✅ Todas enviado!', '#22c55e');
      }

      await sleep(2000);

      // ══ 2. VOLUMOSO ═══════════════════════════════════════════════
      setBadge('📸 Capturando Volumoso...', '#f59e0b');
      const imgVol = await captureTab('ZONA VOLUMOSO');

      if (imgVol) {
        setBadge('📤 Enviando Volumoso...', '#3b82f6');

        // a) Frase direto ao SeaTalk
        await sendToSeatalk('Time segue Report SPP Volumoso').catch(e =>
          console.error('[SeaTalk] Falhou (vol-frase):', e.message));

        // b) Imagem ao servidor → Bot API
        await postReport('volumoso', imgVol).catch(e =>
          console.error('[Server] Falhou (vol-img):', e.message));

        setBadge('✅ Volumoso enviado!', '#22c55e');
      }

      const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      setBadge(`✅ ${agora} enviado`, '#22c55e');
      console.log('[Stage IN Report] ✅ Reports enviados com sucesso!');

    } catch (e) {
      setBadge('❌ Erro no report', '#ef4444');
      console.error('[Stage IN Report] Erro crítico:', e.message);
    } finally {
      // Restaura a aba original
      await sleep(3000);
      const origBtn = document.querySelector(`.zone-tab[data-zone="${originalZone}"]`);
      if (origBtn) origBtn.click();
      // Restaura o badge padrão
      await sleep(10000);
      const h = new Date().getHours().toString().padStart(2, '0');
      setBadge(`📊 Último: ${h}:00`, '#aaa');
    }
  }

  /* ── Agendamento — verifica a cada 30s se é hora cheia ──────────── */
  let lastReportHour = -1;
  setInterval(() => {
    const now = new Date();
    if (now.getMinutes() === 0 && now.getHours() !== lastReportHour) {
      lastReportHour = now.getHours();
      sendReport();
    }
  }, 30 * 1000);

  /* ── Botão manual (clique no badge) ─────────────────────────────── */
  badge.addEventListener('click', () => {
    if (badge.textContent.includes('Capturando') || badge.textContent.includes('Enviando')) return;
    sendReport();
  });

  console.log('[Stage IN Report] ✅ v1.2 — report direto ao SeaTalk, a cada hora cheia (:00)');
})();
