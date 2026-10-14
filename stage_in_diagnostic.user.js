// ==UserScript==
// @name         SPX Stage-In Diagnostic (temporário)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  DIAGNÓSTICO: dado um to_number real que está no Inbound Staging, mostra
//               TODOS os campos do detalhe da TO (nível TO) e de cada PACOTE dentro dela,
//               pra achar o campo de "próximo destino" (dest_station_name/receiver no nível
//               TO só mostra pra onde a TO foi enviada ATÉ chegar aqui — sempre a nossa
//               própria estação — precisa achar o destino seguinte, se existir em algum
//               campo no nível pacote).
// @match        https://spx.shopee.com.br/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const DETAIL_URL = '/api/in-station/general_to/detail/search';

  function getCsrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  async function fetchToDetail(to_number) {
    const params = new URLSearchParams({ to_number, pageno: '1', count: '5' });
    const res = await fetch(`${DETAIL_URL}?${params}`, {
      credentials: 'include',
      headers: { 'x-csrftoken': getCsrf() },
    });
    const json = await res.json();
    if (json.retcode !== 0) throw new Error(`retcode ${json.retcode}: ${json.message}`);
    return json.data || {};
  }

  function renderPanel(to_number, data) {
    const toMeta = { ...data };
    delete toMeta.list;
    const toKeys = Object.keys(toMeta);
    const pkgKeys = data.list && data.list[0] ? Object.keys(data.list[0]) : [];
    const destLike = pkgKeys.filter(k => /dest|destino|receiver|fanout|next|proxim|route|rota|sort/i.test(k));

    const panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'top:20px', 'left:20px', 'right:20px', 'max-height:85vh',
      'overflow:auto', 'background:#0d0d0d', 'color:#e5e5e5', 'border:1px solid #333',
      'border-radius:10px', 'padding:18px', 'z-index:2147483647',
      'font-family:monospace', 'font-size:11.5px', 'box-shadow:0 20px 60px rgba(0,0,0,.7)',
    ].join(';');
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <b style="font-size:14px">🔬 Diagnóstico TO Detail — ${to_number}</b>
        <button id="diag-close" style="background:#262626;color:#eee;border:1px solid #444;border-radius:6px;padding:5px 12px;cursor:pointer">Fechar</button>
      </div>
      <p style="color:#9ca3af;margin-bottom:8px"><b>Campos no nível TO (${toKeys.length}):</b> ${toKeys.join(', ')}</p>
      <pre style="white-space:pre-wrap;font-size:10.5px;color:#9ca3af;background:#161616;padding:10px;border-radius:8px;margin-bottom:12px">${JSON.stringify(toMeta, null, 2)}</pre>

      <p style="color:#9ca3af;margin-bottom:8px"><b>Campos no nível PACOTE (${pkgKeys.length}), ${data.list ? data.list.length : 0} pacotes nessa amostra:</b> ${pkgKeys.join(', ') || '(sem pacotes)'}</p>
      <p style="color:${destLike.length ? '#4ade80' : '#fbbf24'};margin-bottom:10px">
        <b>Campos de pacote que parecem ser de destino/rota:</b> ${destLike.join(', ') || 'nenhum encontrado com esse nome — olhe a lista completa acima manualmente'}
      </p>
      <pre style="white-space:pre-wrap;font-size:10.5px;color:#9ca3af;background:#161616;padding:10px;border-radius:8px">${JSON.stringify((data.list || []).slice(0, 3), null, 2)}</pre>
    `;
    document.body.appendChild(panel);
    document.getElementById('diag-close').onclick = () => panel.remove();
  }

  function makeUI() {
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'position:fixed', 'bottom:16px', 'left:16px', 'z-index:2147483647',
      'background:#0d0d0d', 'border:1px solid #444', 'border-radius:12px', 'padding:10px 14px',
      'box-shadow:0 2px 12px rgba(0,0,0,.5)', 'display:flex', 'gap:8px', 'align-items:center',
    ].join(';');
    wrap.innerHTML = `
      <input id="diag-to-input" placeholder="TO number (ex: TO20260916ABC12)" style="background:#1a1a1a;border:1px solid #444;color:#eee;padding:6px 10px;border-radius:6px;font-size:12px;width:220px">
      <button id="diag-run-btn" style="background:#0ea5e9;color:#fff;border:none;padding:7px 16px;border-radius:20px;font-size:12px;cursor:pointer">🔬 Consultar TO</button>
    `;
    document.body.appendChild(wrap);
    document.getElementById('diag-run-btn').addEventListener('click', async () => {
      const to_number = document.getElementById('diag-to-input').value.trim();
      if (!to_number) { alert('Digite um to_number (pega um da aba Destinos/Rua Detalhe do dashboard)'); return; }
      const btn = document.getElementById('diag-run-btn');
      btn.textContent = '⏳...';
      btn.disabled = true;
      try {
        const data = await fetchToDetail(to_number);
        console.log('[Stage-In Diagnóstico v2] resultado completo:', data);
        renderPanel(to_number, data);
      } catch (e) {
        alert('Erro: ' + e.message);
        console.error('[Stage-In Diagnóstico v2]', e);
      }
      btn.textContent = '🔬 Consultar TO';
      btn.disabled = false;
    });
  }

  makeUI();
})();
