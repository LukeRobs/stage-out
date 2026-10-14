// ==UserScript==
// @name         SPX Status Diagnostic (temporário)
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  DIAGNÓSTICO: testa se outbound/search aceita status além de 1 (Packing) e 2
//               (Packed), e se o campo complete_time continua preenchido em TOs que já
//               saíram de Packed. Objetivo: descobrir se dá pra buscar o HISTÓRICO completo
//               de TOs (independente do status atual), em vez de só pegar quem ainda está
//               "no flagra" em Packed — o que resolveria os buracos de captura que já
//               encontramos (TOs que saem de Packed rápido demais entre um sync e outro).
// @match        https://spx.shopee.com.br/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const SEARCH_URL = '/api/in-station/general_to/outbound/search';
  const PAGE_SIZE  = 20; // só precisamos de uma amostra pequena por status testado

  // Janela de UM dia (ontem — dia fechado, TOs já tiveram tempo de sair de Packed de
  // verdade). Múltiplos dias no mesmo ctime é pouco confiável, conforme já observado
  // no tos_sync.user.js.
  function yesterdayBounds() {
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return {
      start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0),
      end:   new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59),
    };
  }

  async function testStatus(statusVal, ctimeStr) {
    const params = new URLSearchParams({ pageno: '1', count: String(PAGE_SIZE), ctime: ctimeStr });
    if (statusVal !== null) params.set('status', String(statusVal));
    const url = `${SEARCH_URL}?${params}`;
    try {
      const res = await fetch(url, { credentials: 'include' });
      const raw = await res.text();
      let json;
      try { json = JSON.parse(raw); }
      catch (e) { return { statusVal, ok: false, error: `resposta não é JSON (HTTP ${res.status}): ${raw.slice(0, 150)}` }; }

      if (json.retcode !== 0) {
        return { statusVal, ok: false, error: `retcode ${json.retcode}: ${json.message || '(sem mensagem)'}` };
      }
      const list  = json.data?.list || [];
      const total = json.data?.total ?? 0;
      const distinctStatuses  = [...new Set(list.map(x => x.status))];
      const withCompleteTime  = list.filter(x => x.complete_time).length;
      // sender = provável estação de origem (onde foi empacotada de verdade);
      // current_station_name = onde a TO está FISICAMENTE agora — podem divergir
      // assim que a TO sai da estação de origem (Transporting/Transported/Received/...).
      const senderEqCurrent = list.filter(x => x.sender && x.current_station_name && x.sender === x.current_station_name).length;
      return {
        statusVal, ok: true, total, sampleSize: list.length,
        distinctStatuses, withCompleteTime, senderEqCurrent,
        sample: list.slice(0, 3).map(x => ({
          to_number: x.to_number, status: x.status, complete_time: x.complete_time, ctime: x.ctime,
          sender: x.sender, current_station_id: x.current_station_id, current_station_name: x.current_station_name,
          receiver: x.receiver, dest_station_name: x.dest_station_name, staging_area_id: x.staging_area_id,
        })),
      };
    } catch (e) {
      return { statusVal, ok: false, error: e.message };
    }
  }

  async function runDiagnostic(logFn) {
    const { start, end } = yesterdayBounds();
    const ctimeStr = `${Math.floor(start.getTime() / 1000)},${Math.floor(end.getTime() / 1000)}`;
    logFn(`Janela testada: ${start.toLocaleString('pt-BR')} até ${end.toLocaleString('pt-BR')} (ctime=${ctimeStr})`);

    // 0-15 individualmente (pra achar "LHPacked", mencionado mas ainda não localizado),
    // sem parâmetro (omitido), e uma tentativa de lista combinada.
    const statusesToTry = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, null, '1,2,3,4,5,6,7,8,9,10,11,12'];
    const results = [];
    for (const s of statusesToTry) {
      const r = await testStatus(s, ctimeStr);
      results.push(r);
      logFn(`status=${s === null ? '(omitido)' : s} → ${JSON.stringify(r)}`);
      await new Promise(res => setTimeout(res, 250)); // pequena pausa entre chamadas
    }
    return results;
  }

  function renderPanel(results) {
    const rows = results.map(r => {
      const label = r.statusVal === null ? '(omitido)' : String(r.statusVal);
      if (!r.ok) {
        return `<tr><td>${label}</td><td colspan="4" style="color:#f87171">${r.error}</td></tr>`;
      }
      const sampleJson = r.sample.length
        ? `<pre style="margin:0;white-space:pre-wrap;font-size:10px;color:#9ca3af">${JSON.stringify(r.sample, null, 1)}</pre>`
        : '—';
      return `<tr>
        <td>${label}</td>
        <td>${r.total}</td>
        <td>${r.sampleSize}</td>
        <td>${r.distinctStatuses.join(', ') || '—'}</td>
        <td style="color:${r.sampleSize && r.withCompleteTime === r.sampleSize ? '#4ade80' : r.withCompleteTime ? '#fbbf24' : '#9ca3af'}">${r.withCompleteTime}/${r.sampleSize}</td>
        <td style="color:${r.sampleSize && r.senderEqCurrent === r.sampleSize ? '#4ade80' : '#fbbf24'}">${r.senderEqCurrent}/${r.sampleSize}</td>
        <td>${sampleJson}</td>
      </tr>`;
    }).join('');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'top:20px', 'left:20px', 'right:20px', 'max-height:85vh',
      'overflow:auto', 'background:#0d0d0d', 'color:#e5e5e5', 'border:1px solid #333',
      'border-radius:10px', 'padding:18px', 'z-index:2147483647',
      'font-family:monospace', 'font-size:11.5px', 'box-shadow:0 20px 60px rgba(0,0,0,.7)',
    ].join(';');
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <b style="font-size:14px">🔬 Diagnóstico de Status — outbound/search</b>
        <button id="diag-close" style="background:#262626;color:#eee;border:1px solid #444;border-radius:6px;padding:5px 12px;cursor:pointer">Fechar</button>
      </div>
      <p style="color:#9ca3af;margin-bottom:12px">
        Testando status 0-15, sem parâmetro, e lista combinada — janela de ontem inteiro.
        Log completo também no console (F12 → Console).<br>
        <b>O que procurar:</b> (1) algum status novo (ex. "LHPacked") que ainda não vimos;
        (2) se "com complete_time" vem preenchido; (3) a coluna <b>sender = current_station</b> —
        quando estiver baixa (amarela), significa que a TO já não está mais fisicamente na
        estação de origem, então <code>current_station_id</code> não serve mais pra atribuir
        a produção — precisa usar <code>sender</code>.
      </p>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;border-bottom:1px solid #333">
          <th style="padding:6px">status testado</th><th style="padding:6px">total (API)</th>
          <th style="padding:6px">amostra</th><th style="padding:6px">status distintos</th>
          <th style="padding:6px">com complete_time</th><th style="padding:6px">sender = current_station</th>
          <th style="padding:6px">amostra (3 registros)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    document.body.appendChild(panel);
    document.getElementById('diag-close').onclick = () => panel.remove();
  }

  const btn = document.createElement('button');
  btn.textContent = '🔬 Rodar diagnóstico de status';
  btn.style.cssText = [
    'position:fixed', 'bottom:16px', 'left:16px', 'z-index:2147483647',
    'background:#7c3aed', 'color:#fff', 'border:none', 'padding:9px 18px',
    'border-radius:20px', 'font-size:12px', 'cursor:pointer', 'box-shadow:0 2px 12px rgba(0,0,0,.5)',
  ].join(';');
  btn.addEventListener('click', async () => {
    btn.textContent = '⏳ Rodando (leva ~5s)...';
    btn.disabled = true;
    console.log('[Diagnóstico] Iniciando...');
    const results = await runDiagnostic((msg) => console.log('[Diagnóstico]', msg));
    console.log('[Diagnóstico] Resultado completo:', results);
    renderPanel(results);
    btn.textContent = '🔬 Rodar diagnóstico de status';
    btn.disabled = false;
  });
  document.body.appendChild(btn);
})();
