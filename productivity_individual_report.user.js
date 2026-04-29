// ==UserScript==
// @name         Packing Productivity - SeaTalk Hourly Report
// @namespace    spx-express
// @version      1.0
// @description  Envia report HxH de produtividade packing ao SeaTalk a cada hora cheia
// @author       SPX Express
// @match        https://stage-out.onrender.com/productivity_individual.html
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @grant        GM_xmlhttpRequest
// @connect      stage-out.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const SERVER = 'https://stage-out.onrender.com';
  const sleep  = ms => new Promise(r => setTimeout(r, ms));

  /* ── Badge ───────────────────────────────────────────────────────────── */
  const badge = document.createElement('div');
  badge.style.cssText = [
    'position:fixed', 'top:6px', 'right:220px',
    'background:#1a1a2e', 'border:1px solid #334', 'color:#aaa',
    'padding:3px 10px', 'border-radius:20px', 'font-size:11px',
    'font-family:monospace', 'z-index:9999', 'cursor:pointer',
    'user-select:none', 'transition:all .2s', 'line-height:20px',
  ].join(';');
  badge.title       = 'Clique para enviar report agora';
  badge.textContent = '📦 Report Auto';
  document.body.appendChild(badge);

  function setBadge(text, color) {
    badge.textContent = text;
    badge.style.color = color || '#aaa';
  }

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(n) { return Number(n).toLocaleString('pt-BR'); }

  function fmtHora(ts) {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
  }

  function shiftStartTs() {
    const d = new Date();
    if (d.getHours() < 6) d.setDate(d.getDate() - 1);
    d.setHours(6, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  /* ── Fetch dados do servidor ─────────────────────────────────────────── */
  function fetchJSON(path) {
    return fetch(SERVER + path).then(r => r.json());
  }

  /* ── Processa registros de uma hora ─────────────────────────────────── */
  function processHour(records) {
    // Agrupa por operator_id
    const byOp = {};
    for (const r of records) {
      const m = r.ops.match(/^\[(\w+)\](.*)/);
      if (!m) continue;
      const id   = m[1];
      const name = m[2].trim();
      if (!byOp[id]) byOp[id] = { id, name, tp: 0, wh: 0 };
      if (r.working_hours === 0 || r.working_hours < 0.3) continue;
      byOp[id].tp += r.total_throughput || 0;
      byOp[id].wh += r.working_hours   || 0;
    }

    const ops = Object.values(byOp)
      .filter(o => o.wh > 0 && o.tp > 0)
      .map(o => {
        const prod = Math.round(o.tp / o.wh);
        const classe = prod >= 500 ? 'Bom' : prod >= 200 ? 'OK' : 'Ruim';
        return { ...o, prod, classe };
      });

    return ops;
  }

  /* ── Monta texto do report ───────────────────────────────────────────── */
  async function buildReportText() {
    const [indData, tlData] = await Promise.all([
      fetchJSON('/api/productivity-individual'),
      fetchJSON('/api/productivity-timelist'),
    ]);

    const hours    = indData.hours || {};
    const timelist = tlData.time_list || [];

    // Hora a reportar: hora anterior à hora cheia atual
    const nowTs        = Math.floor(Date.now() / 1000);
    const curHourStart = Math.floor(nowTs / 3600) * 3600;
    const prevHourTs   = curHourStart - 3600;
    const reportHoraKey = fmtHora(prevHourTs);

    // Fallback: se não tem dados da hora anterior, usa a mais recente disponível
    let horaKey = reportHoraKey;
    if (!hours[horaKey]) {
      const available = Object.keys(hours).sort();
      horaKey = available[available.length - 1] || null;
    }
    if (!horaKey) throw new Error('Sem dados de produtividade disponíveis');

    const records = hours[horaKey]?.records || [];
    const ops     = processHour(records);

    // Produção da hora: timelist tem o total real
    const horaTs     = new Date(`${horaKey.replace(' ', 'T')}:00`).getTime() / 1000;
    const tlEntry    = timelist.find(t => t.timestamp === Math.floor(horaTs));
    const prodHora   = tlEntry?.total || ops.reduce((s, o) => s + o.tp, 0);

    // Produção do dia: janela 06:00 → 05:00 do dia seguinte
    const shiftStart = shiftStartTs();
    const shiftEnd   = shiftStart + 23 * 3600;
    const prodDia    = timelist
      .filter(t => t.timestamp >= shiftStart && t.timestamp < shiftEnd)
      .reduce((s, t) => s + (t.total || 0), 0);

    const bom  = ops.filter(o => o.classe === 'Bom').length;
    const ok   = ops.filter(o => o.classe === 'OK').length;
    const ruim = ops.filter(o => o.classe === 'Ruim').length;
    const total = ops.length;

    const pct = (n) => total > 0 ? Math.round(n / total * 100) : 0;

    const melhor = ops.sort((a, b) => b.prod - a.prod)[0];
    const melhorStr = melhor
      ? `${melhor.name} — ${fmt(melhor.prod)} itens/h`
      : '—';

    const now      = new Date();
    const data     = now.toLocaleDateString('pt-BR');
    const horaReport = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const text = [
      `Report - Produtividade Packing (${data}):`,
      `Hora: ${horaReport}`,
      ``,
      `Produção da Hora: ${fmt(prodHora)}`,
      `Produção do Dia: ${fmt(prodDia)}`,
      `Operadores: ${total} (com produção > 0)`,
      `Melhor Operador: ${melhorStr}`,
      ``,
      `Operadores (quantidade e %):`,
      `🟢 BOM: ${bom} (${pct(bom)}%)`,
      `🟡 OK: ${ok} (${pct(ok)}%)`,
      `🔴 RUIM: ${ruim} (${pct(ruim)}%)`,
      ``,
      `Link: ${SERVER}/productivity_individual.html`,
    ].join('\n');

    return { text, horaKey };
  }

  /* ── Captura screenshot ──────────────────────────────────────────────── */
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

  /* ── Envia ao servidor ───────────────────────────────────────────────── */
  function postReport(image, text) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'POST',
        url:     `${SERVER}/api/seatalk-packing-report`,
        headers: { 'Content-Type': 'application/json' },
        data:    JSON.stringify({ image, text }),
        timeout: 60000,
        onload: r => {
          console.log('[Packing Report] seatalk-packing-report:', r.status, r.responseText);
          if (r.status === 200) resolve(JSON.parse(r.responseText));
          else reject(new Error(`HTTP ${r.status}`));
        },
        onerror:   () => reject(new Error('Erro de rede')),
        ontimeout: () => reject(new Error('Timeout 60s')),
      });
    });
  }

  /* ── Seleciona aba da hora no dashboard ─────────────────────────────── */
  async function selectHoraTab(horaKey) {
    const tab = document.querySelector(`.hour-tab[data-hora="${horaKey}"]`);
    if (!tab) return null;
    const prevActive = document.querySelector('.hour-tab.active')?.dataset.hora || null;
    tab.click();
    await sleep(1500); // aguarda dashboard re-renderizar
    return prevActive;
  }

  /* ── Chave da hora atual (hora do report = aba a selecionar) ─────────── */
  function currentHoraKey() {
    const d = new Date(Math.floor(Date.now() / 1000 / 3600) * 3600 * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
  }

  /* ── Fluxo principal ─────────────────────────────────────────────────── */
  async function sendReport() {
    let prevHoraTab = null;
    const snapHoraKey = currentHoraKey(); // aba a mostrar no screenshot (14:00)
    try {
      setBadge('📊 Buscando dados...', '#a855f7');
      const { text } = await buildReportText();

      // Muda para aba da hora do report (14:00) antes de capturar — igual ao stage_in
      setBadge('🔄 Selecionando hora...', '#f59e0b');
      prevHoraTab = await selectHoraTab(snapHoraKey);

      setBadge('📸 Capturando...', '#f59e0b');
      const image = await captureScreen();

      // Restaura aba anterior
      if (prevHoraTab && prevHoraTab !== snapHoraKey) {
        const orig = document.querySelector(`.hour-tab[data-hora="${prevHoraTab}"]`);
        if (orig) orig.click();
      }

      setBadge('📤 Enviando...', '#3b82f6');
      await postReport(image, text);

      const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      setBadge(`✅ ${agora} enviado`, '#22c55e');
      console.log('[Packing Report] ✅ Report enviado com sucesso!');

      await sleep(10000);
      const h = new Date().getHours().toString().padStart(2, '0');
      setBadge(`📦 Último: ${h}:00`, '#aaa');

    } catch (e) {
      setBadge('❌ Erro no report', '#ef4444');
      console.error('[Packing Report] Erro:', e.message);
    }
  }

  /* ── Agendamento — dispara na hora cheia ─────────────────────────────── */
  let lastReportHour = -1;
  setInterval(() => {
    const now = new Date();
    if (now.getMinutes() === 0 && now.getHours() !== lastReportHour) {
      lastReportHour = now.getHours();
      sendReport();
    }
  }, 30 * 1000);

  /* ── Clique manual ───────────────────────────────────────────────────── */
  badge.addEventListener('click', () => {
    if (badge.textContent.includes('Capturando') || badge.textContent.includes('Enviando') || badge.textContent.includes('Buscando')) return;
    sendReport();
  });

  console.log('[Packing Report] ✅ v1.0 — a cada hora cheia (:00)');
})();
