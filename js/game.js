/* Cliente do jogo multiplayer: mercado, elenco, escalação, clubes e visualização das partidas. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STEP = 1 / 60;

  const S = { google: null, credential: null, gsiMode: 'login', token: null, me: null, meta: null, catalog: null, clubs: [], matches: [], tab: 'market', kind: 'player', shown: 60, lineup: null, formation: null };
  let stream = null;

  /* ---------- utilidades ---------- */
  const money = e => e >= 1e6 ? '€ ' + (e / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' M' : '€ ' + Math.round(e / 1e3) + ' mil';
  const norm = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const avatar = p => '<span class="avatar clickable" data-player="' + esc(p.id) + '" title="Ver características">' + (p.photo ? '<img src="' + esc(p.photo) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + '<i>' + esc((p.name || '?').trim().charAt(0).toUpperCase()) + '</i></span>';
  /** Seta de alta/baixa da forma (só aparece depois de alguns jogos). */
  const formTag = p => (p.form > 0.05 ? ' <sup class="up" title="Em alta: +' + p.form.toFixed(1) + ' pts">▲</sup>' : p.form < -0.05 ? ' <sup class="down" title="Em baixa: ' + p.form.toFixed(1) + ' pts">▼</sup>' : '');
  const price = p => Math.round(p.value * S.meta.buyPremium);
  /** Condição física (0-100) de um jogador do meu elenco, se está em descanso e quantos treinos ainda faz hoje. */
  const fitOf = id => (S.me && S.me.fitness && S.me.fitness[id]) || { cond: 100, rest: false, left: S.meta.training.sessionsPerDay, physio: true };
  const fitClass = c => (c >= 80 ? 'f-good' : c >= 55 ? 'f-mid' : 'f-low');
  const fitBar = c => '<span class="fitbar ' + fitClass(c) + '" title="Condição física ' + c + '%"><i style="width:' + c + '%"></i></span><b class="fitnum ' + fitClass(c) + '">' + c + '%</b>';
  const num1 = v => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const injTime = h => (h < 24 ? h + ' h' : Math.round(h / 24) + (Math.round(h / 24) > 1 ? ' dias' : ' dia'));
  /** Pode entrar em campo (não está lesionado nem suspenso)? */
  const canPlay = id => { const f = fitOf(id); return !f.inj && !f.susp; };
  /** Etiqueta de lesão ou suspensão (vazia se o jogador pode jogar). */
  const outTag = f => (f.inj ? ' <span class="tag inj" title="' + esc(f.injKind || 'Lesionado') + '">🚑 ' + injTime(f.inj) + '</span>'
    : f.susp ? ' <span class="tag inj" title="Cumpre suspensão no próximo jogo oficial">🟥 suspenso</span>' : '');
  const outText = f => (f.inj ? ' · 🚑 lesionado' : f.susp ? ' · 🟥 suspenso' : '');
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) { /* ignora */ } };

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method, headers: { 'Content-Type': 'application/json', 'x-token': S.token || '' },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (_) {
      const err = new Error(location.protocol === 'file:'
        ? 'Abra pelo servidor: http://localhost:3210 (não abra o arquivo game.html direto).'
        : 'Não consegui falar com o servidor. Ele está rodando? Inicie com iniciar.bat ou "node server/server.js".');
      err.network = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Erro ' + res.status);
      err.status = res.status;
      // sessão invalidada pelo servidor com o jogo aberto: volta para a tela de entrada (o clube continua salvo)
      if (res.status === 401 && S.me && path !== '/api/login') { S.me = null; logout(); }
      throw err;
    }
    return data;
  }

  function toast(html, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'toast' + (opts.err ? ' err' : '');
    el.innerHTML = html;
    $('toasts').appendChild(el);
    if (!opts.sticky) setTimeout(() => el.remove(), 4500);
    return el;
  }
  const fail = e => toast(esc(e.message), { err: true });

  const crest = (el, name, color) => {
    el.textContent = (name || '').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase();
    el.style.background = color;
    el.style.color = textColor(color);
  };
  function textColor(hex) {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.6 ? '#111' : '#fff';
  }

  /* ---------- entrada ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function startSession(r) {
    S.token = r.token;
    lsSet('fm-token', r.token); // reserva; o cookie de sessão do servidor é o principal
  }

  $('regForm').onsubmit = async e => {
    e.preventDefault();
    $('regError').textContent = '';
    try {
      const r = await api('POST', '/api/register', {
        manager: $('regManager').value, club: $('regClub').value, color: $('regColor').value,
        password: $('regPass').value, credential: S.credential || undefined
      });
      S.credential = null;
      startSession(r);
      await enter();
    } catch (err) { $('regError').textContent = err.message; }
  };

  $('loginForm').onsubmit = async e => {
    e.preventDefault();
    $('loginError').textContent = '';
    try {
      startSession(await api('POST', '/api/login', { club: $('loginClub').value, password: $('loginPass').value }));
      await enter();
    } catch (err) { $('loginError').textContent = err.message; }
  };

  /** Sai da conta neste navegador. O clube continua salvo no servidor. */
  function logout() {
    try { fetch('/api/logout', { method: 'POST', headers: { 'x-token': S.token || '' } }); } catch (_) { /* ignora */ }
    lsSet('fm-token', null);
    S.token = null; S.me = null;
    if (stream) { stream.close(); stream = null; }
    $('game').hidden = true;
    S.credential = null;
    showLogin();
  }
  $('btnLogout').onclick = () => {
    const safe = S.me && (S.me.google || S.me.hasPassword);
    const msg = safe
      ? 'Sair? Seu clube continua salvo: entre de novo com o nome do clube e a senha' + (S.me.google ? ' (ou com o Google)' : '') + '.'
      : 'Sair? Este clube AINDA NÃO TEM SENHA e você perderia o acesso. Defina uma senha antes de sair.';
    if (confirm(msg)) {
      if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
      logout();
    }
  };

  /* senha */
  $('btnPw').onclick = () => {
    const has = S.me && S.me.hasPassword;
    $('pwTitle').textContent = has ? 'Alterar senha' : 'Definir senha';
    $('pwCurLbl').hidden = !has;
    $('pwCur').required = !!has;
    $('pwCur').value = ''; $('pwNew').value = ''; $('pwError').textContent = '';
    $('pwDialog').showModal();
  };
  $('pwCancel').onclick = () => $('pwDialog').close();
  $('pwForm').onsubmit = async e => {
    e.preventDefault();
    try {
      S.me = (await api('POST', '/api/password', { current: $('pwCur').value, password: $('pwNew').value })).club;
      renderTop();
      $('pwDialog').close();
      toast('Senha salva. Use o nome do clube e a senha para entrar de qualquer navegador.');
    } catch (err) { $('pwError').textContent = err.message; }
  };

  /* ---------- login com Google ---------- */
  function loadGsi() {
    return new Promise(res => {
      if (window.google && google.accounts) return res(true);
      const el = document.createElement('script');
      el.src = 'https://accounts.google.com/gsi/client';
      el.async = true;
      el.onload = () => res(true);
      el.onerror = () => res(false);
      document.head.appendChild(el);
    });
  }
  async function setupGoogle() {
    const cfg = await api('GET', '/api/config'); // se falhar, o chamador tenta de novo
    S.cfgLoaded = true;
    if (!cfg.googleClientId) return;
    S.google = cfg.googleClientId;
    if (!(await loadGsi())) { S.gsiFailed = true; return; }
    google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onGoogle, auto_select: false });
  }
  async function onGoogle(resp) {
    if (S.gsiMode === 'link') {
      try {
        S.me = (await api('POST', '/api/auth/link', { credential: resp.credential })).club;
        renderTop();
        toast('Conta Google vinculada. Agora você pode entrar de qualquer navegador.');
      } catch (e) { fail(e); }
      return;
    }
    $('googleError').textContent = '';
    try {
      const r = await api('POST', '/api/auth/google', { credential: resp.credential });
      if (r.token) { startSession(r); await enter(); return; }
      S.credential = resp.credential; // primeiro acesso: falta criar o clube
      showReg(r.profile);
    } catch (e) { $('googleError').textContent = e.message; }
  }

  function showOnly(ids) {
    $('auth').hidden = false;
    for (const id of ['retryBox', 'googleBox', 'loginForm', 'regForm']) $(id).hidden = !ids.includes(id);
  }
  function showLogin() {
    S.gsiMode = 'login';
    const googleOk = S.google && !S.gsiFailed && window.google && google.accounts;
    showOnly(googleOk ? ['googleBox', 'loginForm'] : ['loginForm']);
    if (googleOk) {
      $('googleBtn').innerHTML = '';
      google.accounts.id.renderButton($('googleBtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'pt-BR', width: Math.max(200, Math.min(300, document.documentElement.clientWidth - 84)) });
    }
  }
  function showReg(profile) {
    showOnly(['regForm']);
    $('regTitle').textContent = S.credential ? 'Crie seu clube' : '⚽ Criar clube';
    $('regPassLbl').hidden = !!S.credential;
    $('regPass').required = !S.credential;
    if (profile && profile.name && !$('regManager').value) $('regManager').value = profile.name;
    $('regError').textContent = '';
  }
  function showRetry(msg) {
    showOnly(['retryBox']);
    $('retryMsg').textContent = msg;
  }
  $('toReg').onclick = e => { e.preventDefault(); S.credential = null; showReg(null); };
  $('backLink').onclick = e => { e.preventDefault(); S.credential = null; showLogin(); };
  let retryWake = null;
  $('retryNow').onclick = () => { if (retryWake) retryWake(); };

  function renderAccount() {
    const linked = S.me && S.me.google;
    $('tbAccount').textContent = linked ? (S.me.google.email || 'Google') : S.me.hasPassword ? 'Clube com senha' : 'SEM SENHA — defina uma!';
    $('btnPw').textContent = S.me.hasPassword ? 'Alterar senha' : 'Definir senha';
    const box = $('linkGoogle');
    box.innerHTML = '';
    if (!linked && S.google && !S.gsiFailed && window.google && google.accounts) {
      S.gsiMode = 'link';
      google.accounts.id.renderButton(box, { theme: 'outline', size: 'small', text: 'continue_with', locale: 'pt-BR' });
    }
  }

  async function enter() {
    S.meta = await api('GET', '/api/meta');
    fillPresets();
    await loadCatalog(); // antes do clube: renderTop precisa do catálogo (nome do técnico)
    await loadMe();
    $('auth').hidden = true;
    $('game').hidden = false;
    connect();
    showTab(S.tab);
  }

  async function loadMe() {
    S.me = (await api('GET', '/api/me')).club;
    S.lineup = S.me.lineup.slice();
    S.formation = S.me.formation;
    renderTop();
  }
  async function loadCatalog() { S.catalog = await api('GET', '/api/catalog'); }
  const player = id => S.catalog.players.find(p => p.id === id);
  const coach = id => S.catalog.coaches.find(c => c.id === id);

  function renderTop() {
    const m = S.me;
    crest($('tbCrest'), m.name, m.color);
    crest($('heroCrest'), m.name, m.color);
    $('heroName').textContent = m.name;
    if (S.catalog) $('heroValue').textContent = money(m.squad.map(player).filter(Boolean).reduce((t, p) => t + p.value, 0));
    $('tbClub').textContent = m.name;
    $('tbManager').textContent = 'Técnico: ' + m.manager;
    $('mbClub').textContent = m.name; // barra compacta do celular
    $('mbManager').textContent = 'Técnico: ' + m.manager;
    $('tbBudget').textContent = money(m.budget);
    $('tbSquad').textContent = m.squad.length + '/' + S.meta.squadMax;
    const c = m.coach && S.catalog && coach(m.coach);
    $('tbCoach').textContent = c ? c.short : m.coach ? '…' : '—';
    $('tbSource').textContent = S.meta.source === 'sofascore' ? 'Sofascore' : 'Catálogo local';
    renderAccount();
  }

  /* ---------- tempo real ---------- */
  function connect() {
    if (stream) stream.close();
    stream = new EventSource(S.token ? '/api/events?token=' + encodeURIComponent(S.token) : '/api/events');
    stream.addEventListener('clubs', () => { if (S.tab === 'clubs') loadClubs(); });
    stream.addEventListener('market', async () => {
      await loadCatalog();
      try { S.me = (await api('GET', '/api/me')).club; renderTop(); } catch (_) { /* segue */ } // sem mexer numa escalação em edição
      if (S.tab === 'squad') renderSquad();
      if (S.tab === 'train') renderTrain();
      if (S.tab === 'exch') renderExchange();
      if (S.tab === 'market') renderMarket();
    });
    stream.addEventListener('auction', ev => applyExchange(JSON.parse(ev.data)));
    stream.addEventListener('trade', () => { if (S.tab === 'exch') loadExchange(); });
    stream.addEventListener('challenge', ev => {
      const d = JSON.parse(ev.data);
      const t = toast('<b>' + esc(d.from.name) + '</b> (' + esc(d.from.manager) + ') desafiou você para uma partida!' + (d.context ? '<br><small>' + esc(d.context) + '</small>' : '') +
        '<div class="acts"><button class="btn primary sm" data-a="1" type="button">Aceitar</button><button class="btn sm" data-a="0" type="button">Recusar</button></div>', { sticky: true });
      t.onclick = async e => {
        const b = e.target.closest('button');
        if (!b) return;
        t.remove();
        try { await api('POST', '/api/challenge/respond', { id: d.id, accept: b.dataset.a === '1' }); } catch (err) { fail(err); }
      };
      setTimeout(() => t.remove(), 120000);
    });
    stream.addEventListener('declined', ev => {
      const d = JSON.parse(ev.data);
      toast(esc(d.by) + ' recusou o desafio' + (d.reason ? ' (' + esc(d.reason) + ')' : '') + '.', { err: true });
    });
    stream.addEventListener('chat', ev => {
      const d = JSON.parse(ev.data);
      if (!rec || d.matchId !== rec.id || $('viewer').hidden) return;
      if (d.msg.kind === 'react') floatEmoji(d.msg);
      addChat($('vChat'), d.msg);
    });
    stream.addEventListener('leaguechat', ev => {
      const d = JSON.parse(ev.data);
      const open = lgData && lgData.league.id === d.id && S.tab === 'leagues' && !$('lgDetail').hidden;
      if (open) {
        if (!lgData.chat.some(x => x.id === d.msg.id)) { lgData.chat.push(d.msg); addChat($('lgChat'), d.msg); }
      } else if (S.me && d.msg.clubId !== S.me.id) {
        toast('💬 <b>' + esc(d.msg.from) + '</b> em <b>' + esc(d.league) + '</b>: ' + esc(d.msg.text));
      }
    });
    stream.addEventListener('league', ev => {
      const d = JSON.parse(ev.data);
      if (S.tab !== 'leagues') return;
      if (lgOpen && lgOpen === d.id) openLeague(lgOpen, true); else if (!lgOpen) loadLeagues();
    });
    stream.addEventListener('note', ev => {
      const d = JSON.parse(ev.data);
      const t = toast(esc(d.text) + (d.matchId ? '<div class="acts"><button class="btn sm" type="button">Assistir</button></div>' : ''), { sticky: !!d.matchId });
      if (d.matchId) t.onclick = e => { if (e.target.closest('button')) { t.remove(); openMatch(d.matchId); } };
      else if (S.tab === 'leagues') { if (lgOpen) openLeague(lgOpen, true); else loadLeagues(); }
      if (d.matchId) setTimeout(() => t.remove(), 60000);
    });
    stream.addEventListener('playback', ev => {
      const d = JSON.parse(ev.data);
      if (!rec || rec.id !== d.id || $('viewer').hidden) return;
      applyPlayback(d.playback);
      if (d.by && S.me && d.by !== S.me.name) toast('<b>' + esc(d.by) + '</b> ' + esc(d.label) + '.');
    });
    stream.addEventListener('match', async ev => {
      const d = JSON.parse(ev.data);
      await loadMe(); await loadCatalog();
      openMatch(d.id);
    });
  }

  /* Celular: com a tela apagada ou em outro app, a conexão em tempo real cai (no iOS, sem reconectar sozinha). Ao voltar, reabre e atualiza. */
  let hiddenAt = 0;
  async function resync() {
    if (!S.me) return;
    if (!stream || stream.readyState === 2) connect();
    if (Date.now() - hiddenAt < 20000 || !$('viewer').hidden) return; // ausência curta: os eventos em tempo real bastam
    try {
      await loadCatalog();
      S.me = (await api('GET', '/api/me')).club; renderTop();
      showTab(S.tab);
    } catch (_) { /* o próximo evento ou toque atualiza */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else { resync(); if (!$('viewer').hidden) keepAwake(true); } });
  window.addEventListener('pageshow', e => { if (e.persisted) resync(); });
  window.addEventListener('online', () => resync());

  /* ---------- abas ---------- */
  $('tabs').onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };
  // menu da conta (celular): abre por cima do conteúdo e fecha ao tocar fora, numa aba ou numa opção
  const setMenu = open => { $('fmNav').classList.toggle('menu-open', open); $('btnMenu').setAttribute('aria-expanded', open ? 'true' : 'false'); };
  $('btnMenu').onclick = () => setMenu(!$('fmNav').classList.contains('menu-open'));
  $('btnLogout2').onclick = () => { setMenu(false); $('btnLogout').click(); };
  $('btnPw').addEventListener('click', () => setMenu(false));
  document.addEventListener('click', e => { if (!e.target.closest('#fmNav')) setMenu(false); });
  function centerTab() { // no celular as abas rolam de lado: mantém a aba ativa à vista
    const tabs = $('tabs'), on = tabs.querySelector('.on');
    if (!on || tabs.scrollWidth <= tabs.clientWidth) return;
    const r = on.getBoundingClientRect(), t = tabs.getBoundingClientRect();
    tabs.scrollBy({ left: r.left - t.left - (t.width - r.width) / 2, behavior: 'smooth' });
  }
  function showTab(t) {
    S.tab = t;
    for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === t);
    setMenu(false); centerTab();
    for (const id of ['market', 'squad', 'lineup', 'train', 'clubs', 'leagues', 'stats', 'exch', 'matches']) $('tab-' + id).hidden = id !== t;
    if (t === 'market') renderMarket();
    if (t === 'squad') renderSquad();
    if (t === 'lineup') renderLineup();
    if (t === 'train') openTrain();
    if (t === 'clubs') loadClubs();
    if (t === 'leagues') loadLeagues();
    if (t === 'stats') loadStatsTab();
    if (t === 'exch') loadClubs().then(loadExchange);
    if (t === 'matches') loadMatches();
  }

  /* ---------- mercado ---------- */
  for (const id of ['mkSearch', 'mkPos', 'mkSort', 'mkFree', 'mkAfford']) $(id).addEventListener('input', () => { S.shown = 60; renderMarket(); });
  let searchTimer = null, searchSeq = 0;
  $('mkSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = $('mkSearch').value.trim();
    if (S.kind !== 'player' || q.length < 3) { $('mkStatus').hidden = true; return; }
    searchTimer = setTimeout(() => remoteSearch(q), 600);
  });

  /** Busca o nome em bases abertas de jogadores (via servidor) e junta os encontrados ao catálogo. */
  async function remoteSearch(q) {
    const seq = ++searchSeq;
    const st = $('mkStatus');
    st.hidden = false;
    st.textContent = 'Buscando "' + q + '" entre milhares de jogadores…';
    try {
      const r = await api('GET', '/api/search?q=' + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      for (const p of r.players) {
        const i = S.catalog.players.findIndex(x => x.id === p.id);
        if (i >= 0) S.catalog.players[i] = p; else S.catalog.players.push(p);
      }
      const n = r.players.filter(p => p.source && p.source !== 'seed').length;
      st.textContent = r.remote.ok
        ? n + ' jogador(es) encontrados na base ' + (r.remote.source || 'online') + ' para "' + q + '".'
        : 'Busca online indisponível (' + r.remote.error + '). Mostrando só o catálogo local.';
      renderMarket();
    } catch (e) {
      if (seq === searchSeq) st.textContent = e.message;
    }
  }
  $('mkKind').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    S.kind = b.dataset.k; S.shown = 60;
    for (const x of $('mkKind').children) x.classList.toggle('on', x === b);
    $('mkPos').hidden = S.kind === 'coach';
    renderMarket();
  };
  $('mkMore').onclick = () => { S.shown += 60; renderMarket(); };

  function renderMarket() {
    if (!S.catalog) return;
    const q = norm($('mkSearch').value.trim());
    const pos = $('mkPos').value, free = $('mkFree').checked, aff = $('mkAfford').checked;
    let list = (S.kind === 'coach' ? S.catalog.coaches : S.catalog.players).filter(p =>
      (!q || norm(p.name + ' ' + p.club).includes(q)) &&
      (S.kind === 'coach' || pos === 'ALL' || p.role === pos) &&
      (!free || !p.owner || p.owner.id === S.me.id) &&
      (!aff || price(p) <= S.me.budget));
    const [key, dir] = $('mkSort').value.split('-');
    list.sort((a, b) => key === 'name' ? a.name.localeCompare(b.name) : (dir === 'asc' ? a[key] - b[key] : b[key] - a[key]));
    const total = list.length;
    list = list.slice(0, S.shown);

    const head = S.kind === 'coach'
      ? '<tr class="rh"><th>Técnico</th><th>Clube</th><th class="num">Nota</th><th class="num">Preço</th><th></th></tr>'
      : '<tr class="rh"><th>Pos</th><th>Jogador</th><th>Clube</th><th class="num">Nota</th><th class="num">Valor</th><th class="num">Preço</th><th></th></tr>';
    $('mkTable').innerHTML = head + list.map(p => {
      const mine = S.me.squad.includes(p.id) || S.me.coach === p.id;
      let act;
      if (mine) act = '<span class="tag">No seu clube</span>';
      else if (p.owner) act = '<span class="tag">' + esc(p.owner.name) + '</span>';
      else act = '<button class="btn primary sm" data-buy="' + esc(p.id) + '"' + (price(p) > S.me.budget ? ' disabled' : '') + ' type="button">Contratar</button>';
      return S.kind === 'coach'
        ? '<tr class="rc coach"><td class="c-name"><a href="#" class="plink" data-player="' + esc(p.id) + '">' + esc(p.name) + '</a></td><td class="c-club">' + esc(p.club) + '</td><td class="num ovr c-ovr">' + p.ovr + formTag(p) + '</td><td class="num c-price">' + money(price(p)) + '</td><td class="c-act">' + act + '</td></tr>'
        : '<tr class="rc"><td class="c-pos"><span class="pos ' + p.role + '">' + p.pos + '</span></td><td class="c-name">' + avatar(p) + '<a href="#" class="plink" data-player="' + esc(p.id) + '">' + esc(p.name) + '</a>' + (p.source === 'sofascore' ? ' <span class="tag">SS</span>' : p.source === 'wikidata' ? ' <span class="tag">WD</span>' : '') + '</td><td class="c-club">' + esc(p.club) + '</td><td class="num ovr c-ovr">' + p.ovr + '</td><td class="num c-val">' + (p.valueEstimated ? '~' : '') + money(p.value) + '</td><td class="num c-price"><b>' + money(price(p)) + '</b></td><td class="c-act">' + act + '</td></tr>' +
          (S.open === p.id ? '<tr class="detail"><td colspan="7">' + details(p) + '</td></tr>' : '');
    }).join('') || '<tr><td>Nada encontrado.</td></tr>';
    $('mkMore').hidden = total <= S.shown;
  }
  function details(p) {
    const bits = [p.country, p.age ? p.age + ' anos' : null, p.height ? p.height + ' cm' : null, p.foot ? 'pé ' + ({ Right: 'direito', Left: 'esquerdo', Both: 'ambos' }[p.foot] || p.foot) : null].filter(Boolean);
    const labels = { attacking: 'Ataque', technical: 'Técnica', tactical: 'Tática', defending: 'Defesa', creativity: 'Criatividade' };
    const attrs = p.attrs
      ? Object.keys(labels).map(k => '<div class="attr"><span>' + labels[k] + '</span><div class="abar"><i style="width:' + Math.min(100, p.attrs[k] || 0) + '%"></i></div><b>' + (p.attrs[k] != null ? p.attrs[k] : '—') + '</b></div>').join('')
      : '<span class="muted">Sem atributos detalhados: a nota geral ' + p.ovr + ' define as habilidades em campo.</span>';
    return '<div class="muted">' + esc(bits.join(' · ') || 'Sem dados pessoais') + (p.valueEstimated ? ' · nota e valor estimados pela fama do jogador' : '') + (p.retired ? ' · sem clube / aposentado' : '') + '</div><div class="attrs">' + attrs + '</div>';
  }
  $('mkTable').onclick = async e => {
    const info = e.target.closest('[data-info]');
    if (info) { e.preventDefault(); S.open = S.open === info.dataset.info ? null : info.dataset.info; renderMarket(); return; }
    const b = e.target.closest('[data-buy]');
    if (!b) return;
    b.disabled = true;
    const item = (S.kind === 'coach' ? coach : player)(b.dataset.buy);
    try {
      S.me = (await api('POST', '/api/buy', { id: item.id, kind: S.kind })).club;
      toast('Contratado: <b>' + esc(item.name) + '</b> por ' + money(price(item)));
      await loadCatalog();
      renderTop(); renderMarket();
    } catch (err) { fail(err); renderMarket(); }
  };

  /* ---------- elenco ---------- */
  function renderSquad() {
    const sq = S.me.squad.map(player).filter(Boolean).sort((a, b) => ['GK', 'DEF', 'MID', 'FWD'].indexOf(a.role) - ['GK', 'DEF', 'MID', 'FWD'].indexOf(b.role) || b.ovr - a.ovr);
    $('sqInfo').textContent = sq.length + ' jogadores · valor do elenco ' + money(sq.reduce((s, p) => s + p.value, 0)) + ' · compra com ágio de ' + Math.round((S.meta.buyPremium - 1) * 100) + '%, venda por ' + Math.round(S.meta.sellRatio * 100) + '% do valor de mercado.';
    $('sqTable').innerHTML = '<tr class="rh"><th>Pos</th><th>Jogador</th><th>Clube de origem</th><th class="num">Nota</th><th>Condição</th><th class="num">Valor</th><th class="num">Venda</th><th></th></tr>' +
      (sq.map(p => '<tr class="rc"><td class="c-pos"><span class="pos ' + p.role + '">' + p.pos + '</span></td><td class="c-name">' + avatar(p) + '<a href="#" class="plink" data-player="' + esc(p.id) + '">' + esc(p.name) + '</a></td><td class="c-club">' + esc(p.club) + '</td><td class="num ovr c-ovr">' + p.ovr + formTag(p) + '</td><td class="c-fit">' + fitBar(fitOf(p.id).cond) + (fitOf(p.id).rest ? ' <span class="tag rest">😴</span>' : '') + outTag(fitOf(p.id)) + '</td><td class="num c-val">' + money(p.value) + '</td><td class="num c-price">' + money(p.value * S.meta.sellRatio) + '</td><td class="c-act"><button class="btn danger sm" data-sell="' + esc(p.id) + '" type="button">Vender</button> <button class="btn sm" data-auc="' + esc(p.id) + '" type="button">Leiloar</button></td></tr>').join('') ||
        '<tr><td colspan="8">Seu elenco está vazio. Vá ao Mercado e contrate jogadores.</td></tr>');
    const c = S.me.coach && coach(S.me.coach);
    $('sqCoach').innerHTML = c
      ? '<a href="#" class="plink" data-player="' + esc(c.id) + '"><b>' + esc(c.name) + '</b></a> · nota ' + c.ovr + formTag(c) + ' · <button class="btn danger sm" data-sellc="' + esc(c.id) + '" type="button">Demitir (recebe ' + money(c.value * S.meta.sellRatio) + ')</button> <button class="btn sm" data-auc="' + esc(c.id) + '" type="button">Leiloar</button>'
      : '<span class="muted">Sem técnico. Contrate um na aba Mercado > Técnicos: a nota dele melhora todo o time.</span>';
  }
  $('tab-squad').onclick = async e => {
    const au = e.target.closest('[data-auc]');
    if (au) return auctionItem(au.dataset.auc);
    const b = e.target.closest('[data-sell],[data-sellc]');
    if (!b) return;
    const id = b.dataset.sell || b.dataset.sellc;
    const item = b.dataset.sell ? player(id) : coach(id);
    if (!confirm('Vender ' + item.name + ' por ' + money(item.value * S.meta.sellRatio) + '?')) return;
    try {
      S.me = (await api('POST', '/api/sell', { id, kind: b.dataset.sell ? 'player' : 'coach' })).club;
      S.lineup = S.me.lineup.slice();
      await loadCatalog();
      renderTop(); renderSquad();
    } catch (err) { fail(err); }
  };

  /* ---------- ficha do jogador / técnico ---------- */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-player]');
    if (el) { e.preventDefault(); openPlayer(el.dataset.player); return; }
    const cl = e.target.closest('[data-club]');
    if (cl) { e.preventDefault(); openClub(cl.dataset.club); return; }
    if (e.target.id === 'pModal' || e.target.closest('#pClose')) $('pModal').hidden = true;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('pModal').hidden = true; });

  async function openPlayer(id) {
    $('pModal').hidden = false;
    $('pModal').querySelector('.pbox').classList.remove('wide');
    $('pBody').innerHTML = '<p class="muted">Carregando…</p>';
    try { $('pBody').innerHTML = playerCard(await api('GET', '/api/player?id=' + encodeURIComponent(id))); }
    catch (err) { $('pBody').innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; }
  }
  function playerCard(r) {
    const p = r.player, f = r.form, up = f.delta > 0.05, down = f.delta < -0.05;
    const pct = Math.round((Math.pow(1.06, f.delta) - 1) * 100);
    const foot = { Right: 'direito', Left: 'esquerdo', Both: 'ambos' }[p.foot] || p.foot;
    const facts = [['País', p.country], ['Idade', p.age ? p.age + ' anos' : null], ['Altura', p.height ? p.height + ' cm' : null], ['Pé', foot], ['Camisa', p.number]]
      .filter(x => x[1]).map(x => '<div><span>' + x[0] + '</span><b>' + esc(String(x[1])) + '</b></div>').join('');
    const bar = ((f.delta + f.max) / (2 * f.max)) * 100;
    const T = S.meta.training;
    const attr = s => '<div class="attr"><span>' + esc(s.label) + '</span><div class="abar"><i style="width:' + s.base + '%"></i>' + (s.gain ? '<i class="tr" style="width:' + Math.max(0, s.value - s.base) + '%"></i>' : '') + '</div><b>' + s.value + (s.gain ? '<small class="up" title="Ganho no treino"> +' + num1(s.gain) + '</small>' : '') + '</b></div>';
    const stats = r.coach
      ? '<div class="pstats"><p class="muted">O técnico melhora ou piora as habilidades de todo o time: <b>' + (r.teamBonus >= 0 ? '+' : '') + r.teamBonus + '%</b> com a nota atual. Ele também muda o quanto os jogadores evoluem no treino.</p></div>'
      : '<div class="pstats">' + r.profile.stats.map(attr).join('') +
        '<p class="muted small">' + (r.profile.estimated ? 'Características estimadas a partir da nota geral e da posição. ' : '') + (r.training.ovr ? 'Em verde, o que o jogador ganhou no treino (já soma <b>+' + num1(r.training.ovr) + '</b> na nota).' : 'Treino no Centro de Treinamento soma até +' + r.training.max + ' em cada característica.') + '</p></div>';
    const fz = r.fitness;
    const fitHtml = !fz ? '' : '<div class="pfit"><div class="row-between"><b>Condição física</b><b class="fitnum ' + fitClass(fz.cond) + '">' + fz.cond + '%' + (fz.rest ? ' · 😴 em descanso' : '') + '</b></div>' +
      '<span class="fitbar big ' + fitClass(fz.cond) + '"><i style="width:' + fz.cond + '%"></i></span>' +
      '<p class="muted small">Entra em campo com essa energia e cansa ao longo do jogo (cansado, corre menos e erra mais). Recupera ' + T.recovery + '% por hora, ou ' + T.restRecovery + '% em descanso.</p>' +
      (fz.inj ? '<p class="alert">🚑 Lesionado: ' + esc(fz.injKind || 'lesão') + '. Volta em ' + injTime(fz.inj) + ' (a fisioterapia tira um dia).</p>' : '') +
      (fz.susp ? '<p class="alert">🟥 Suspenso: fica fora do próximo jogo oficial do clube.</p>' : '') +
      (fz.yellows ? '<p class="muted small">🟨 ' + fz.yellows + ' amarelo(s) acumulado(s): com ' + T.yellowLimit + ' fica fora de um jogo.</p>' : '') + '</div>';
    const avatarBig = r.coach ? '<span class="avatar big"><i>' + esc(p.name.charAt(0)) + '</i></span>' : avatar(p).replace('avatar clickable', 'avatar big');
    const st = r.stats, tot = st && st.total;
    const chip = (label, v) => '<div><span>' + label + '</span><b>' + v + '</b></div>';
    const statsHtml = !st ? '' : '<div class="pstat"><b>Estatísticas nas partidas entre jogadores</b>' + (tot.apps
      ? '<div class="pfacts">' + chip('Jogos', tot.apps) + chip('Gols', tot.goals) + chip('Assistências', tot.assists) + chip('Chutes no gol', tot.onTarget) +
        (p.role === 'GK' || p.role === 'DEF' ? chip('Sem sofrer gol', tot.cleanSheets) : '') + (p.role === 'GK' ? chip('Defesas', tot.saves) : '') + chip('Amarelos', tot.yellows) + '</div>' +
        (st.byClub.length > 1 ? '<table class="tbl small"><tr><th>Clube</th><th class="num">J</th><th class="num">G</th><th class="num">A</th></tr>' + st.byClub.map(c => '<tr><td><a href="#" class="plink" data-club="' + esc(c.club.id) + '">' + esc(c.club.name) + '</a></td><td class="num">' + c.apps + '</td><td class="num">' + c.goals + '</td><td class="num">' + c.assists + '</td></tr>').join('') + '</table>' : '')
      : '<p class="muted small">Ainda não disputou partidas entre jogadores.</p>') + '</div>';
    return '<div class="phead">' + avatarBig +
      '<div><h3>' + esc(p.name) + '</h3><div class="muted">' + (r.coach ? 'Técnico' : '<span class="pos ' + p.role + '">' + p.pos + '</span>') + ' · ' + esc(p.club) +
      (r.owner ? ' · <span class="tag">' + esc(r.owner.name) + '</span>' : ' · <span class="tag">Livre no mercado</span>') + '</div></div>' +
      '<div class="pscore"><span>Nota</span><b class="ovr">' + p.ovr + '</b></div></div>' +
      '<div class="pfacts">' + facts + '<div><span>Valor de mercado</span><b>' + money(p.value) + '</b></div><div><span>Contratar por</span><b>' + money(r.price.buy) + '</b></div><div><span>Vender por</span><b>' + money(r.price.sell) + '</b></div></div>' +
      fitHtml + stats + statsHtml +
      '<div class="pform"><div class="row-between"><b>Forma</b><span class="' + (up ? 'up' : down ? 'down' : 'muted') + '">' + (up || down ? (up ? '▲ +' : '▼ ') + f.delta.toFixed(1) + ' pts · valor ' + (pct > 0 ? '+' : '') + pct + '%' : 'estável') + '</span></div>' +
      '<div class="fbar"><i style="left:' + bar + '%"></i></div>' +
      '<p class="muted small">Nota base ' + f.baseOvr + ' · valor base ' + money(f.baseValue) + '. Vitórias e boas atuações (defesas, desarmes, chutes no gol, passes de risco, gols) sobem a nota; derrotas, faltas, cartões e gols sofridos derrubam. Máximo de ±' + f.max + ' pts.</p></div>';
  }

  /* ---------- Centro de Treinamento e área de descanso ---------- */
  const trSel = new Set(); // jogadores marcados
  let trIntensity = lsGet('fm-train-int') || 'normal', trHelpSet = false;
  const ABBR = { shot: 'FIN', pass: 'PAS', dribble: 'DRI', def: 'DEF', speed: 'VEL', stamina: 'RES' };
  const ROLE_ORDER = ['GK', 'DEF', 'MID', 'FWD'];
  const trSquad = () => S.me.squad.map(player).filter(Boolean).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.ovr - a.ovr);
  const physioCost = p => { const T = S.meta.training; return Math.max(T.physioMin, Math.round(p.value * T.physioRatio / 1e5) * 1e5); };
  const patchPlayers = list => { for (const p of list || []) { const i = S.catalog.players.findIndex(x => x.id === p.id); if (i >= 0) S.catalog.players[i] = p; } };

  async function openTrain() {
    renderTrain();
    try { S.me = (await api('GET', '/api/me')).club; renderTop(); if (S.tab === 'train') renderTrain(); } catch (_) { /* segue com o que já tem */ }
  }

  function renderTrain() {
    const T = S.meta.training, sq = trSquad();
    for (const id of [...trSel]) if (!S.me.squad.includes(id)) trSel.delete(id);
    if (!T.intensity[trIntensity]) trIntensity = 'normal';
    for (const b of $('trInt').children) b.classList.toggle('on', b.dataset.i === trIntensity);
    if (!$('trFocus').options.length) {
      $('trFocus').innerHTML = '<option value="auto">Automático (o que mais ajuda na posição)</option>' + Object.keys(T.focus).map(k => '<option value="' + k + '">' + T.focus[k] + '</option>').join('');
      $('trFocus').value = T.focus[lsGet('fm-train-focus')] ? lsGet('fm-train-focus') : 'auto';
    }
    if (!trHelpSet) { trHelpSet = true; $('trHelpBox').open = !matchMedia('(max-width: 720px)').matches; } // no celular a explicação começa fechada
    const it = T.intensity[trIntensity], c = S.me.coach && coach(S.me.coach);
    const cf = c ? Math.max(0.8, Math.min(1.25, 1 + (c.ovr - 75) / 100)) : 0.85;
    $('trHelp').textContent = 'Cada jogador treina até ' + T.sessionsPerDay + ' vezes por dia (renova à meia-noite de Brasília) e o que ele ganha fica com ele, inclusive a nota e o valor de mercado. ' +
      'O treino gasta condição física, que volta ' + T.recovery + '% por hora (' + T.restRecovery + '% em descanso). Uma partida inteira gasta cerca de 25% a 30%, e quem entra em campo cansado corre menos e erra mais. ' +
      'A fisioterapia devolve ' + T.physio + '% na hora (1 vez por dia; custa ' + Math.round(T.physioRatio * 100) + '% do valor do jogador) e tira um dia de lesão. ' +
      'Lesionado não treina nem joga; vermelho ou ' + T.yellowLimit + ' amarelos acumulados deixam o jogador fora do próximo jogo oficial.';
    $('trIntHelp').textContent = it.label + ': cerca de +' + num1(it.gain * cf) + ' por sessão (rende menos perto do máximo de +' + T.trainMax + '), gasta ' + it.cost + '% de condição e pede pelo menos ' + it.min + '%. ' +
      (c ? 'Seu técnico (' + c.short + ', nota ' + c.ovr + ') ' + (cf >= 1 ? 'aumenta' : 'reduz') + ' o ganho em ' + Math.round(Math.abs(cf - 1) * 100) + '%.' : 'Sem técnico, o treino rende 15% menos.') +
      ' Até 21 anos o jogador evolui 30% mais rápido; depois dos 30, mais devagar.' +
      (trIntensity === 'hard' ? ' Cuidado: treino forte pode machucar (2% de chance; 8% se o jogador terminar abaixo de 35%).' : '');
    const xi = S.me.lineup.filter(id => id && S.me.squad.includes(id));
    const avg = xi.length ? Math.round(xi.reduce((t, id) => t + fitOf(id).cond, 0) / xi.length) : null;
    const resting = sq.filter(p => fitOf(p.id).rest).length, left = sq.reduce((t, p) => t + fitOf(p.id).left, 0);
    $('trSummary').textContent = (avg != null ? 'Titulares: ' + avg + '% de condição · ' : '') + resting + ' em descanso · ' + left + ' treinos disponíveis hoje';
    $('trTable').innerHTML = '<tr class="rh"><th class="c-chk"></th><th>Jogador</th><th>Condição</th><th class="num">Treinos hoje</th><th>Evolução no treino</th><th class="num">Nota</th></tr>' +
      (sq.map(p => {
        const f = fitOf(p.id), tr = p.train || {}, on = trSel.has(p.id);
        const gains = Object.keys(ABBR).filter(k => tr[k]).map(k => '<span class="gchip" title="' + T.focus[k] + '">' + ABBR[k] + ' +' + num1(tr[k]) + '</span>').join('') || '<span class="muted small">ainda não treinou</span>';
        const tags = (S.me.lineup.includes(p.id) ? ' <span class="tag">Titular</span>' : '') + (f.rest ? ' <span class="tag rest">😴 Descansando</span>' : '') + outTag(f);
        return '<tr class="rc' + (on ? ' sel' : '') + '" data-row="' + esc(p.id) + '"><td class="c-chk"><input type="checkbox" data-pick="' + esc(p.id) + '"' + (on ? ' checked' : '') + ' aria-label="Selecionar ' + esc(p.name) + '"></td>' +
          '<td class="c-name"><span class="pos ' + p.role + '">' + p.pos + '</span> ' + avatar(p) + '<a href="#" class="plink" data-player="' + esc(p.id) + '">' + esc(p.name) + '</a>' + tags + '</td>' +
          '<td class="c-fit">' + fitBar(f.cond) + '</td>' +
          '<td class="num c-left">' + (f.left ? f.left + ' de ' + T.sessionsPerDay : '<span class="muted">só amanhã</span>') + '</td>' +
          '<td class="c-gain">' + gains + '</td>' +
          '<td class="num ovr c-ovr">' + p.ovr + formTag(p) + '</td></tr>';
      }).join('') || '<tr><td colspan="6">Seu elenco está vazio. Contrate jogadores no Mercado para treiná-los.</td></tr>');
    renderTrainActs();
  }

  /** Botões de ação com a quantidade de marcados (e o preço da fisioterapia). */
  function renderTrainActs() {
    const ids = [...trSel], n = ids.length;
    const cost = ids.map(player).filter(p => p && fitOf(p.id).physio && (fitOf(p.id).cond < 100 || fitOf(p.id).inj)).reduce((t, p) => t + physioCost(p), 0);
    const allResting = n && ids.every(id => fitOf(id).rest);
    $('trGo').textContent = 'Treinar' + (n ? ' (' + n + ')' : '');
    $('trRest').textContent = (allResting ? 'Tirar do descanso' : 'Descansar') + (n ? ' (' + n + ')' : '');
    $('trPhysio').textContent = 'Fisioterapia' + (cost ? ' (' + money(cost) + ')' : '');
    for (const id of ['trGo', 'trRest', 'trPhysio']) $(id).disabled = !n;
    $('trActs').classList.toggle('on', n > 0);
  }

  $('trTable').addEventListener('change', e => {
    const id = e.target.dataset.pick;
    if (!id) return;
    if (e.target.checked) trSel.add(id); else trSel.delete(id);
    e.target.closest('tr').classList.toggle('sel', e.target.checked);
    renderTrainActs();
  });
  $('trTable').addEventListener('click', e => { // tocar no cartão também marca (o nome e a foto abrem a ficha)
    if (e.target.closest('[data-player], input')) return;
    const row = e.target.closest('[data-row]');
    if (!row) return;
    const box = row.querySelector('input');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  $('trSel').onclick = e => {
    const b = e.target.closest('[data-sel]');
    if (!b) return;
    const it = S.meta.training.intensity[trIntensity], k = b.dataset.sel;
    trSel.clear();
    for (const p of trSquad()) {
      const f = fitOf(p.id), xi = S.me.lineup.includes(p.id);
      if (k === 'all' || (k === 'xi' && xi) || (k === 'bench' && !xi) || (k === 'ready' && f.left > 0 && f.cond >= it.min && !f.inj) || (k === 'tired' && (f.cond < 60 || f.inj))) trSel.add(p.id);
    }
    renderTrain();
  };
  $('trInt').onclick = e => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    trIntensity = b.dataset.i; lsSet('fm-train-int', trIntensity);
    renderTrain();
  };
  $('trFocus').onchange = () => lsSet('fm-train-focus', $('trFocus').value);

  async function trainAct(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (err) { fail(err); }
    renderTop(); renderTrain();
  }
  $('trGo').onclick = () => trainAct($('trGo'), async () => {
    const r = await api('POST', '/api/train', { ids: [...trSel], focus: $('trFocus').value, intensity: trIntensity });
    S.me = r.club; patchPlayers(r.players);
    const F = S.meta.training.focus;
    const list = r.done.slice(0, 6).map(d => '<b>' + esc(d.name) + '</b> ' + F[d.focus] + ' +' + num1(d.gain)).join(' · ') + (r.done.length > 6 ? ' e mais ' + (r.done.length - 6) : '');
    const hurt = r.done.filter(d => d.injury);
    toast('🏋️ Treino feito: ' + list + (hurt.length ? '<br>🚑 Machucou no treino: ' + hurt.map(d => '<b>' + esc(d.name) + '</b> (' + esc(d.injKind) + ', ' + d.injury + (d.injury > 1 ? ' dias' : ' dia') + ')').join(', ') : '') +
      (r.skipped.length ? '<br><small>Não treinaram: ' + r.skipped.slice(0, 3).map(esc).join(' ') + (r.skipped.length > 3 ? ' (e mais ' + (r.skipped.length - 3) + ')' : '') + '</small>' : ''), hurt.length ? { sticky: true } : undefined);
  });
  $('trRest').onclick = () => trainAct($('trRest'), async () => {
    const ids = [...trSel], on = !ids.every(id => fitOf(id).rest);
    S.me = (await api('POST', '/api/rest', { ids, on })).club;
    toast(on ? '😴 ' + ids.length + ' jogador(es) em descanso: recuperam ' + S.meta.training.restRecovery + '% por hora até treinarem ou jogarem de novo.' : 'Descanso encerrado para ' + ids.length + ' jogador(es).');
  });
  $('trPhysio').onclick = () => {
    const T = S.meta.training;
    const list = [...trSel].map(player).filter(p => p && fitOf(p.id).physio && (fitOf(p.id).cond < 100 || fitOf(p.id).inj));
    if (!list.length) return toast('Nenhum dos marcados precisa (ou ainda pode) fazer fisioterapia hoje.', { err: true });
    const cost = list.reduce((t, p) => t + physioCost(p), 0);
    if (!confirm('Fisioterapia para ' + list.length + ' jogador(es) por ' + money(cost) + '? Cada um recupera ' + T.physio + '% de condição na hora.')) return;
    trainAct($('trPhysio'), async () => {
      const r = await api('POST', '/api/physio', { ids: list.map(p => p.id) });
      S.me = r.club;
      toast('💆 Fisioterapia (' + money(r.cost) + '): ' + r.done.map(d => '<b>' + esc(d.name) + '</b> ' + d.cond + '%' + (d.inj ? ' (lesão: mais ' + injTime(d.inj) + ')' : '')).join(' · '));
    });
  };

  /* ---------- estatísticas e ficha do clube ---------- */
  const clubLink = c => '<a href="#" class="plink" data-club="' + esc(c.id) + '"><i class="cdot" style="background:' + esc(c.color || '#888') + '"></i>' + esc(c.name) + '</a>';
  const playerLink = p => avatar(p) + '<a href="#" class="plink" data-player="' + esc(p.id) + '">' + esc(p.name) + '</a>';
  function board(title, rows, cols) {
    const head = '<tr><th>#</th><th>Jogador</th><th>Clube</th>' + cols.map(c => '<th class="num" title="' + c[2] + '">' + c[1] + '</th>').join('') + '</tr>';
    const body = rows.map((x, i) => '<tr><td>' + (i + 1) + '</td><td class="nowrap">' + playerLink(x.player) + '<span class="pos ' + x.player.role + ' sm">' + x.player.pos + '</span></td><td class="nowrap">' + clubLink(x.club) + '</td>' +
      cols.map((c, k) => '<td class="num">' + (k === 0 ? '<b>' + x[c[0]] + '</b>' : x[c[0]]) + '</td>').join('') + '</tr>').join('');
    return '<div class="stat-card"><h3>' + title + '</h3>' + (rows.length ? '<div class="table-wrap"><table class="tbl">' + head + body + '</table></div>' : '<p class="muted">Ainda sem dados: jogue partidas entre jogadores.</p>') + '</div>';
  }
  async function loadStatsTab() {
    let d;
    try { d = await api('GET', '/api/stats'); } catch (err) { $('stBoards').innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; return; }
    $('stBoards').innerHTML =
      board('⚽ Artilharia', d.scorers, [['goals', 'Gols', 'Gols'], ['assists', 'Ass.', 'Assistências'], ['apps', 'J', 'Jogos']]) +
      board('🎯 Assistências', d.assists, [['assists', 'Ass.', 'Assistências'], ['goals', 'Gols', 'Gols'], ['apps', 'J', 'Jogos']]) +
      board('🔥 Gols + assistências', d.contributions, [['ga', 'G+A', 'Gols mais assistências'], ['goals', 'Gols', 'Gols'], ['assists', 'Ass.', 'Assistências'], ['apps', 'J', 'Jogos']]) +
      board('🧤 Goleiros', d.goalkeepers, [['cleanSheets', 'SSG', 'Jogos sem sofrer gol'], ['saves', 'Def.', 'Defesas'], ['apps', 'J', 'Jogos']]);
  }

  /** Ficha pública de um clube: campanha, técnico e elenco com as estatísticas de cada jogador. */
  async function openClub(id) {
    $('pModal').hidden = false;
    $('pModal').querySelector('.pbox').classList.add('wide');
    $('pBody').innerHTML = '<p class="muted">Carregando…</p>';
    let d;
    try { d = await api('GET', '/api/club?id=' + encodeURIComponent(id)); } catch (err) { $('pBody').innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; return; }
    const c = d.club, t = d.totals;
    const chip = (label, v) => '<div><span>' + label + '</span><b>' + v + '</b></div>';
    $('pBody').innerHTML = '<div class="phead"><span class="avatar big" style="background:' + esc(c.color) + '"><i style="color:' + textColor(c.color) + '">' + esc(c.name.slice(0, 3).toUpperCase()) + '</i></span>' +
      '<div><h3>' + esc(c.name) + '</h3><div class="muted">Técnico ' + esc(c.manager) + (c.online ? ' · <span class="up">online</span>' : '') + (d.coach ? ' · comandante ' + esc(d.coach.name) : '') + '</div></div></div>' +
      '<div class="pfacts">' + chip('Pontos', c.points) + chip('Jogos', c.played) + chip('V / E / D', c.w + ' / ' + c.d + ' / ' + c.l) + chip('Gols pró / contra', c.gf + ' / ' + c.ga) + chip('Elenco', c.squadSize) + chip('Valor do elenco', money(c.squadValue)) + '</div>' +
      '<div class="pstat"><b>Elenco e estatísticas pelo clube</b>' +
      (d.squad.length ? '<div class="pgtable"><table class="tbl"><tr><th>Jogador</th><th>Pos</th><th class="num">Nota</th><th class="num" title="Jogos">J</th><th class="num" title="Gols">G</th><th class="num" title="Assistências">A</th><th class="num" title="Gols + assistências">G+A</th><th class="num" title="Jogos sem sofrer gol (goleiro e defensores)">SSG</th><th class="num" title="Cartões amarelos">CA</th><th class="num" title="Cartões vermelhos">CV</th></tr>' +
        d.squad.map(x => '<tr' + (x.inLineup ? ' class="me"' : '') + '><td class="nowrap">' + playerLink(x.player) + '</td><td><span class="pos ' + x.player.role + '">' + x.player.pos + '</span></td><td class="num ovr">' + x.player.ovr + '</td><td class="num">' + x.stats.apps + '</td><td class="num">' + x.stats.goals + '</td><td class="num">' + x.stats.assists + '</td><td class="num"><b>' + x.stats.ga + '</b></td><td class="num">' + x.stats.cleanSheets + '</td><td class="num">' + x.stats.yellows + '</td><td class="num">' + x.stats.reds + '</td></tr>').join('') +
        '<tr><td colspan="3"><b>Total do clube</b></td><td class="num">—</td><td class="num"><b>' + t.goals + '</b></td><td class="num"><b>' + t.assists + '</b></td><td class="num"><b>' + t.ga + '</b></td><td class="num">—</td><td class="num">' + t.yellows + '</td><td class="num">' + t.reds + '</td></tr></table></div><p class="muted small">Linhas destacadas: titulares da escalação atual. As estatísticas contam só o que o jogador fez por este clube.</p>'
        : '<p class="muted small">Este clube ainda não tem jogadores.</p>') + '</div>';
  }

  /* ---------- escalação ---------- */
  function renderLineup() {
    const fm = S.meta.formations;
    $('luFormation').innerHTML = Object.keys(fm).map(k => '<option' + (k === S.formation ? ' selected' : '') + '>' + k + '</option>').join('');
    const slots = fm[S.formation];
    const squad = S.me.squad.map(player).filter(Boolean);

    $('luSlots').innerHTML = slots.map((s, i) => {
      const opts = squad.filter(p => (s.pos === 'GK') === (p.pos === 'GK')).sort((a, b) => (b.role === s.role) - (a.role === s.role) || b.ovr - a.ovr);
      const cur = S.lineup[i] && player(S.lineup[i]);
      return '<div class="slot"><span class="pos ' + s.role + '">' + s.pos + '</span>' + (cur ? avatar(cur) : '<span class="avatar"></span>') + '<select data-slot="' + i + '"><option value="">— vazio —</option>' +
        opts.map(p => '<option value="' + esc(p.id) + '"' + (S.lineup[i] === p.id ? ' selected' : '') + '>' + esc(p.name) + ' · ' + fitOf(p.id).cond + '%' + outText(fitOf(p.id)) + ' (' + p.pos + ' · ' + p.ovr + (p.role !== s.role && s.pos !== 'GK' ? ' · fora de posição' : '') + ')</option>').join('') + '</select></div>';
    }).join('');

    const col = S.me.color, tc = textColor(col);
    $('luPitch').innerHTML = slots.map((s, i) => {
      const p = S.lineup[i] && player(S.lineup[i]);
      const photo = p && p.photo ? '<img src="' + esc(p.photo) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '';
      return '<div class="pt' + (p ? ' clickable' : '') + '"' + (p ? ' data-player="' + esc(p.id) + '"' : '') + ' style="left:' + (s.fy * 100) + '%;top:' + (100 - s.fx * 100) + '%"><i class="' + (photo ? 'ph' : '') + '" style="background:' + col + ';color:' + tc + '">' + photo + '<b>' + (i + 1) + '</b></i><span>' + esc(p ? p.short : s.pos) + '</span>' + (p ? '<em class="' + fitClass(fitOf(p.id).cond) + '" style="--c:' + fitOf(p.id).cond + '%" title="Condição física ' + fitOf(p.id).cond + '%"></em>' + (canPlay(p.id) ? '' : '<small class="flag" title="Não joga: entra o melhor reserva">' + (fitOf(p.id).inj ? '🚑' : '🟥') + '</small>') : '') + '</div>';
    }).join('');

    const chosen = S.lineup.map(id => id && player(id)).filter(Boolean);
    const avg = chosen.length ? Math.round(chosen.reduce((s, p) => s + p.ovr, 0) / chosen.length) : 0;
    const cond = chosen.length ? Math.round(chosen.reduce((s, p) => s + fitOf(p.id).cond, 0) / chosen.length) : 0;
    const out = chosen.filter(p => !canPlay(p.id)).length;
    $('luOvr').textContent = chosen.length + '/11 escalados · nota média ' + avg + (chosen.length ? ' · condição média ' + cond + '%' : '') +
      (out ? ' · ⚠ ' + out + ' lesionado(s)/suspenso(s): na hora do jogo entra o melhor reserva da posição' : '');
    renderTactics();
  }

  /* ---------- tática e substituições ---------- */
  const TAC_HELP = {
    balanced: 'Sem risco extra: o time se ajusta à bola.',
    attack: 'Linha alta e mais finalizações; sobra espaço nas costas da defesa.',
    defend: 'Linha baixa e time compacto: cede menos chances, mas ataca pouco.',
    counter: 'Recua e sai rápido para os atacantes com passes mais verticais.',
    press: 'Marcação alta: mais jogadores sobre quem está com a bola.'
  };
  function renderTactics() {
    const tacs = S.meta.tactics, me = S.me;
    const opts = sel => Object.keys(tacs).map(k => '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + tacs[k] + '</option>').join('');
    $('tcStyle').innerHTML = opts(me.tactic || 'balanced');
    $('tcTacStyle').innerHTML = opts('attack');
    $('tcHelp').textContent = TAC_HELP[me.tactic || 'balanced'] || '';
    const slots = S.meta.formations[S.formation];
    $('tcOut').innerHTML = S.lineup.map((id, i) => i > 0 && id ? '<option value="' + i + '">' + esc((player(id) || {}).short || '?') + ' (' + slots[i].pos + ' · ' + fitOf(id).cond + '%' + outText(fitOf(id)) + ')</option>' : '').join('');
    const bench = S.me.squad.map(player).filter(p => p && p.pos !== 'GK' && !S.lineup.includes(p.id)).sort((a, b) => b.ovr - a.ovr);
    $('tcIn').innerHTML = bench.map(p => '<option value="' + esc(p.id) + '">' + esc(p.short) + ' (' + p.pos + ' · ' + p.ovr + ' · ' + fitOf(p.id).cond + '%' + outText(fitOf(p.id)) + ')</option>').join('') || '<option value="">Sem reservas no elenco</option>';
    const plan = me.plan || [];
    $('tcPlan').innerHTML = plan.map((e, i) => {
      let txt;
      if (e.type === 'tactic') txt = 'Mudar para <b>' + esc(tacs[e.style]) + '</b>';
      else {
        const out = S.lineup[e.out] && player(S.lineup[e.out]), inn = player(e.in);
        const ok = out && inn && !S.lineup.includes(e.in);
        txt = 'Sai <b>' + esc(out ? out.short : '?') + '</b>, entra <b>' + esc(inn ? inn.short : '?') + '</b>' + (ok ? '' : ' <span class="tag">inválida: será ignorada</span>');
      }
      return '<div class="plan-row"><span class="tag">' + e.min + "'</span> " + txt + ' <button class="btn sm" data-pdel="' + i + '" type="button">Remover</button></div>';
    }).join('') || '<p class="muted">Nenhuma troca planejada.</p>';
  }
  async function saveTactics(tactic, plan) {
    try {
      S.me = (await api('POST', '/api/tactics', { tactic, plan })).club;
    } catch (err) { fail(err); }
    renderTactics();
  }
  $('tcStyle').onchange = e => saveTactics(e.target.value, S.me.plan || []);
  $('tcSubForm').onsubmit = e => {
    e.preventDefault();
    const inId = $('tcIn').value;
    if (!inId || !$('tcOut').value) return toast('Escale o time e tenha reservas no elenco para planejar trocas.', { err: true });
    saveTactics(S.me.tactic || 'balanced', (S.me.plan || []).concat([{ type: 'sub', min: +$('tcSubMin').value, out: +$('tcOut').value, in: inId }]));
  };
  $('tcTacForm').onsubmit = e => {
    e.preventDefault();
    saveTactics(S.me.tactic || 'balanced', (S.me.plan || []).concat([{ type: 'tactic', min: +$('tcTacMin').value, style: $('tcTacStyle').value }]));
  };
  $('tcPlan').onclick = e => {
    const b = e.target.closest('[data-pdel]');
    if (!b) return;
    saveTactics(S.me.tactic || 'balanced', (S.me.plan || []).filter((_, i) => i !== +b.dataset.pdel));
  };
  async function saveLineup() {
    try { S.me = (await api('POST', '/api/lineup', { formation: S.formation, lineup: S.lineup })).club; } catch (err) { fail(err); }
  }
  $('luFormation').onchange = e => {
    S.formation = e.target.value;
    S.lineup = Array(11).fill(null);
    autoLineup();
  };
  $('luSlots').onchange = e => {
    const i = +e.target.dataset.slot, id = e.target.value || null;
    if (id) S.lineup = S.lineup.map(x => (x === id ? null : x));
    S.lineup[i] = id;
    renderLineup(); saveLineup();
  };
  $('luAuto').onclick = autoLineup;
  function autoLineup() {
    const slots = S.meta.formations[S.formation];
    const pool = S.me.squad.map(player).filter(Boolean);
    const used = new Set();
    S.lineup = slots.map(s => {
      let best = null, bs = -1;
      for (const p of pool) {
        if (used.has(p.id) || (s.pos === 'GK') !== (p.pos === 'GK')) continue;
        // cansado rende menos em campo: a escalação automática prefere quem está descansado
        const sc = (s.pos === 'GK' ? p.ovr : p.ovr * (p.pos === s.pos ? 1.05 : p.role === s.role ? 1 : 0.85)) * (0.7 + 0.3 * fitOf(p.id).cond / 100) * (canPlay(p.id) ? 1 : 0.01);
        if (sc > bs) { bs = sc; best = p; }
      }
      if (best) used.add(best.id);
      return best ? best.id : null;
    });
    renderLineup(); saveLineup();
  }

  /* ---------- clubes ---------- */
  async function loadClubs() {
    try { S.clubs = (await api('GET', '/api/clubs')).clubs; } catch (e) { return fail(e); }
    fillPracticeOpponents();
    $('clTable').innerHTML = '<tr><th>#</th><th>Clube</th><th>Técnico</th><th class="num">P</th><th class="num">J</th><th class="num">V</th><th class="num">E</th><th class="num">D</th><th class="num">SG</th><th class="num">Saldo</th><th class="num">Valor do elenco</th><th></th></tr>' +
      S.clubs.map((c, i) => {
        const me = c.id === S.me.id;
        return '<tr class="' + (me ? 'me' : '') + '"><td>' + (i + 1) + '</td><td><span class="dot' + (c.online ? ' on' : '') + '"></span><a href="#" class="plink" data-club="' + esc(c.id) + '">' + esc(c.name) + '</a></td><td>' + esc(c.manager) + '</td><td class="num"><b>' + c.points + '</b></td><td class="num">' + c.played + '</td><td class="num">' + c.w + '</td><td class="num">' + c.d + '</td><td class="num">' + c.l + '</td><td class="num">' + (c.gf - c.ga) + '</td><td class="num">' + money(c.budget) + '</td><td class="num">' + money(c.squadValue) + '</td><td>' +
          (me ? '' : '<button class="btn primary sm" data-ch="' + esc(c.id) + '"' + (c.online ? '' : ' disabled') + ' type="button">Desafiar</button>') + '</td></tr>';
      }).join('');
  }
  $('clTable').onclick = async e => {
    const b = e.target.closest('[data-ch]');
    if (!b) return;
    try { await api('POST', '/api/challenge', { to: b.dataset.ch }); toast('Desafio enviado. Aguardando resposta…'); } catch (err) { fail(err); }
  };
  $('btnCpu').onclick = async () => {
    $('btnCpu').disabled = true;
    try { await api('POST', '/api/challenge', { to: 'cpu' }); } catch (err) { fail(err); }
    $('btnCpu').disabled = false;
  };

  /* ---------- ligas e copas ---------- */
  let lgOpen = null, lgSub = null, lgData = null;
  const fmtName = l => l.format === 'cup' ? 'Copa (mata-mata)' : l.rounds === 2 ? 'Liga (ida e volta)' : 'Liga (turno único)';
  const statusName = l => ({ lobby: 'Aguardando clubes', running: 'Em andamento', finished: 'Encerrada' }[l.status]);
  const dot = c => '<span class="dot' + (c.online ? ' on' : '') + '"></span>';

  async function loadLeagues() {
    if (lgOpen) return openLeague(lgOpen, true);
    $('lgHome').hidden = false; $('lgDetail').hidden = true; $('lgChatBox').hidden = true;
    try {
      const r = await api('GET', '/api/leagues');
      $('lgList').innerHTML = r.leagues.map(l =>
        '<div class="lg-card" data-open="' + esc(l.id) + '"><b>' + esc(l.name) + '</b><span class="tag">' + fmtName(l) + ' · ' + statusName(l) + '</span>' +
        '<span class="tag">' + l.members + ' clube(s) · código <b>' + esc(l.code) + '</b></span>' + (l.champion ? '<span>🏆 ' + esc(l.champion) + '</span>' : '') + '</div>').join('') ||
        '<p class="muted">Você ainda não participa de nenhuma competição. Crie uma ou entre com o código de um amigo.</p>';
    } catch (e) { fail(e); }
  }
  $('lgList').onclick = e => { const c = e.target.closest('[data-open]'); if (c) { lgOpen = c.dataset.open; lgSub = null; openLeague(lgOpen); } };

  $('lgNew').onclick = () => { $('lgFormError').textContent = ''; $('lgName').value = ''; $('lgDialog').showModal(); };
  $('lgCancel').onclick = () => $('lgDialog').close();
  $('lgFormat').onchange = () => { $('lgRoundsLbl').hidden = $('lgFormat').value === 'cup'; };
  $('lgForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/leagues', { name: $('lgName').value, format: $('lgFormat').value, rounds: +$('lgRounds').value });
      $('lgDialog').close();
      lgOpen = r.league.id; lgSub = null;
      toast('Sala criada! Passe o código <b>' + esc(r.league.code) + '</b> para os amigos.');
      openLeague(lgOpen);
    } catch (err) { $('lgFormError').textContent = err.message; }
  };
  $('lgJoinForm').onsubmit = async e => {
    e.preventDefault();
    $('lgError').textContent = '';
    try {
      const r = await api('POST', '/api/leagues/join', { code: $('lgCode').value });
      $('lgCode').value = '';
      lgOpen = r.league.id; lgSub = null;
      openLeague(lgOpen);
    } catch (err) { $('lgError').textContent = err.message; }
  };

  async function openLeague(id, quiet) {
    try { lgData = await api('GET', '/api/leagues/detail?id=' + encodeURIComponent(id)); } catch (e) { lgOpen = null; if (!quiet) fail(e); return loadLeagues(); }
    lgOpen = id;
    $('lgHome').hidden = true; $('lgDetail').hidden = false;
    renderLeague();
    renderLgChat();
  }

  function renderLgChat() {
    $('lgChatBox').hidden = false;
    const box = $('lgChat');
    box.innerHTML = '';
    for (const m of lgData.chat || []) addChat(box, m);
  }
  $('lgChatForm').onsubmit = async e => {
    e.preventDefault();
    const v = $('lgChatInput').value.trim();
    if (!v || !lgData) return;
    $('lgChatInput').value = '';
    try { await api('POST', '/api/leagues/chat', { id: lgData.league.id, kind: 'text', text: v }); } catch (err) { fail(err); }
  };

  const fxTeam = (c, win) => '<span class="t' + (win ? ' win' : '') + '">' + dot(c) + esc(c.name) + '</span>';
  function fxRow(f, L) {
    const played = !!f.score;
    const meIn = f.home.id === S.me.id || f.away.id === S.me.id;
    const acts = [];
    if (played && f.matchId) acts.push('<button class="btn sm" data-watch="' + esc(f.matchId) + '" type="button">Assistir</button>');
    if (!played && L.status === 'running') {
      if (meIn) acts.push('<button class="btn primary sm" data-play="' + esc(f.id) + '" type="button">Chamar para jogar</button>');
      if (L.owner === S.me.id) acts.push('<button class="btn sm" data-sim="' + esc(f.id) + '" type="button">Simular</button>');
    }
    const sc = played ? f.score[0] + ' x ' + f.score[1] + (f.pens ? '<small>pên. ' + f.pens[0] + '-' + f.pens[1] + '</small>' : '') : 'x';
    return '<div class="fx"><div class="t">' + dot(f.home) + '<span class="' + (f.winner === f.home.id ? 'win' : '') + '">' + esc(f.home.name) + '</span></div><div class="sc">' + sc +
      '</div><div class="t r"><span class="' + (f.winner === f.away.id ? 'win' : '') + '">' + esc(f.away.name) + '</span>' + dot(f.away) + '</div><div class="acts">' + acts.join('') + '</div></div>';
  }

  function renderLeague() {
    const d = lgData, L = d.league, isOwner = L.owner === S.me.id;
    let h = '<div class="lg-head"><button class="btn sm" id="lgBack" type="button">← Voltar</button><h2>' + esc(L.name) + '</h2><span class="tag">' + fmtName(L) + ' · ' + statusName(L) + '</span></div>';
    h += '<div class="lg-code">Código de convite: <span class="code">' + esc(L.code) + '</span><button class="btn sm" id="lgCopy" type="button">Copiar</button></div>';
    if (L.status === 'finished') {
      h += '<div class="champ">🏆 Campeão: ' + esc(L.champion || '—') + (L.runnerUp ? ' · Vice: ' + esc(L.runnerUp) : '') + '</div>';
    }
    if (L.status === 'lobby') {
      h += '<p class="muted">' + L.members.length + ' clube(s) na sala (mín. ' + L.limits.min + ', máx. ' + L.limits.max + '). Os amigos entram pela aba Ligas usando o código acima.</p>';
      h += '<div class="members">' + L.members.map(m => '<span class="member">' + dot(m) + esc(m.name) + ' <span class="tag">' + esc(m.manager) + (m.id === L.owner ? ' · dono' : '') + '</span></span>').join('') + '</div>';
      h += isOwner
        ? '<button class="btn primary" id="lgStart" type="button"' + (L.members.length < L.limits.min ? ' disabled' : '') + '>Iniciar competição</button> '
        : '<span class="muted">Aguardando o dono iniciar.</span> ';
      h += '<button class="btn danger" id="lgLeave" type="button">Sair da sala</button>';
      $('lgDetail').innerHTML = h;
      return;
    }
    const subs = L.format === 'league' ? [['table', 'Tabela'], ['games', 'Jogos'], ['scorers', 'Artilheiros'], ['assists', 'Assistências']] : [['games', 'Chaves e jogos'], ['scorers', 'Artilheiros'], ['assists', 'Assistências']];
    if (!lgSub || !subs.some(s => s[0] === lgSub)) lgSub = subs[0][0];
    h += '<div class="subtabs">' + subs.map(s => '<button data-sub="' + s[0] + '" class="' + (s[0] === lgSub ? 'on' : '') + '" type="button">' + s[1] + '</button>').join('') + '</div>';
    if (lgSub === 'table') {
      h += '<div class="table-wrap"><table class="tbl t-stand"><tr><th>#</th><th>Clube</th><th class="num">P</th><th class="num">J</th><th class="num">V</th><th class="num">E</th><th class="num">D</th><th class="num">GP</th><th class="num">GC</th><th class="num">SG</th></tr>' +
        d.standings.map((r, i) => '<tr class="' + (r.club.id === S.me.id ? 'me' : '') + '"><td>' + (i + 1) + '</td><td>' + dot(r.club) + esc(r.club.name) + '</td><td class="num"><b>' + r.pts + '</b></td><td class="num">' + r.j + '</td><td class="num">' + r.v + '</td><td class="num">' + r.e + '</td><td class="num">' + r.d + '</td><td class="num">' + r.gp + '</td><td class="num">' + r.gc + '</td><td class="num">' + r.sg + '</td></tr>').join('') + '</table></div>';
    } else if (lgSub === 'games') {
      const groups = [];
      for (const f of d.fixtures) { let g = groups.find(x => x.round === f.round); if (!g) groups.push(g = { round: f.round, stage: f.stage, list: [] }); g.list.push(f); }
      h += groups.map(g => '<div class="round-title">' + esc(g.stage) + '</div>' + g.list.map(f => fxRow(f, L)).join('')).join('');
      if (L.format === 'cup' && L.status === 'running') h += '<p class="muted">Empate no tempo normal? Vai para a prorrogação e, se continuar, pênaltis.</p>';
    } else if (lgSub === 'assists') {
      h += '<div class="table-wrap"><table class="tbl"><tr><th>#</th><th>Jogador</th><th>Clube</th><th class="num">Assist.</th></tr>' +
        ((d.assisters || []).map((x, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(x.player) + '</td><td>' + esc(x.club) + '</td><td class="num"><b>' + x.assists + '</b></td></tr>').join('') || '<tr><td colspan="4">Ainda não há assistências.</td></tr>') + '</table></div>';
    } else {
      h += '<div class="table-wrap"><table class="tbl"><tr><th>#</th><th>Jogador</th><th>Clube</th><th class="num">Gols</th></tr>' +
        (d.scorers.map((x, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(x.player) + '</td><td>' + esc(x.club) + '</td><td class="num"><b>' + x.goals + '</b></td></tr>').join('') || '<tr><td colspan="4">Ainda não há gols.</td></tr>') + '</table></div>';
    }
    $('lgDetail').innerHTML = h;
  }

  $('lgDetail').onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const L = lgData.league;
    try {
      if (b.id === 'lgBack') { lgOpen = null; lgData = null; return loadLeagues(); }
      if (b.id === 'lgCopy') { try { await navigator.clipboard.writeText(L.code); toast('Código copiado.'); } catch (_) { toast('Código: <b>' + esc(L.code) + '</b>'); } return; }
      if (b.id === 'lgStart') { lgData = await api('POST', '/api/leagues/start', { id: L.id }); lgSub = null; return renderLeague(); }
      if (b.id === 'lgLeave') { if (!confirm('Sair desta sala?')) return; await api('POST', '/api/leagues/leave', { id: L.id }); lgOpen = null; return loadLeagues(); }
      if (b.dataset.sub) { lgSub = b.dataset.sub; return renderLeague(); }
      if (b.dataset.watch) return openMatch(b.dataset.watch);
      if (b.dataset.play) {
        await api('POST', '/api/challenge', { fixture: { leagueId: L.id, fixtureId: b.dataset.play } });
        return toast('Desafio enviado ao adversário. Aguardando ele aceitar…');
      }
      if (b.dataset.sim) {
        if (!confirm('Simular este jogo agora? O resultado vale para a competição.')) return;
        const r = await api('POST', '/api/leagues/simulate', { id: L.id, fixtureId: b.dataset.sim });
        toast('Jogo simulado: ' + r.score[0] + ' x ' + r.score[1] + (r.pens ? ' (pên. ' + r.pens[0] + '-' + r.pens[1] + ')' : ''));
        return openLeague(L.id, true);
      }
    } catch (err) { fail(err); }
  };

  /* ---------- partidas ---------- */
  async function loadMatches() {
    try { S.matches = (await api('GET', '/api/matches')).matches; } catch (e) { return fail(e); }
    $('mtTable').innerHTML = '<tr class="rh"><th>Quando</th><th>Casa</th><th class="num">Placar</th><th>Visitante</th><th>Gols</th><th></th></tr>' +
      (S.matches.map(m => '<tr class="rc"><td class="c-when">' + new Date(m.at).toLocaleString('pt-BR') + '</td><td class="c-home">' + esc(m.home.name) + '</td><td class="num c-score"><b>' + m.score[0] + ' - ' + m.score[1] + '</b>' + (m.pens ? ' <span class="tag">(pên. ' + m.pens[0] + '-' + m.pens[1] + ')</span>' : '') + '</td><td class="c-away">' + esc(m.away.name) + (m.cpu ? ' <span class="tag">(CPU)</span>' : '') + (m.league ? ' <span class="tag">· ' + esc(m.league.name) + ' — ' + esc(m.league.stage || '') + '</span>' : '') + '</td><td class="tag c-goals">' +
        esc(m.goals.map(g => g.player + ' ' + g.min + "'").join(', ')) + '</td><td class="c-act"><button class="btn sm" data-w="' + m.id + '" type="button">Assistir</button></td></tr>').join('') || '<tr><td colspan="6">Nenhuma partida ainda.</td></tr>');
  }
  $('mtTable').onclick = e => { const b = e.target.closest('[data-w]'); if (b) openMatch(b.dataset.w); };

  /* ---------- visualizador ---------- */
  // pb != null => partida entre dois jogadores: pausa/velocidade/pular valem para os dois ao mesmo tempo.
  let rec = null, match = null, renderer = null, paused = false, speed = 1, acc = 0, last = 0, raf = 0, bannerUntil = 0;
  let steps = 0, pb = null, clockOffset = 0, countdownOn = false, oldEngine = false;

  const serverNow = () => Date.now() + clockOffset;
  function pbTick() {
    if (pb.ended) return Infinity;
    if (pb.paused) return pb.baseTick;
    return pb.baseTick + Math.max(0, serverNow() - pb.baseTime) / 1000 * pb.speed * 60;
  }
  function paintControls() {
    const p = pb ? pb.paused : paused, sp = pb ? pb.speed : speed;
    $('vPlay').textContent = p ? 'Continuar' : 'Pausar';
    sfx.setPaused(p);
    for (const x of $('vSpeed').children) x.classList.toggle('on', +x.dataset.v === sp);
  }
  function applyPlayback(p) {
    pb = p;
    clockOffset = p.serverNow - Date.now();
    paintControls();
  }

  /* ---------- narração, som, chat e reações ---------- */
  const sfx = new Sfx();
  let narr = null, quiet = false;
  const flag = (k, def) => { const v = lsGet(k); return v == null ? def : v === '1'; };
  $('vSound').checked = flag('fm-sound', true);
  $('vVoice').checked = flag('fm-voice', true);
  sfx.enabled = $('vSound').checked;
  $('vSound').onchange = e => { sfx.setEnabled(e.target.checked); lsSet('fm-sound', e.target.checked ? '1' : '0'); };
  $('vVoice').onchange = e => { lsSet('fm-voice', e.target.checked ? '1' : '0'); if (!e.target.checked) voiceReset(); };
  // navegadores só liberam áudio depois de um clique
  document.addEventListener('click', () => { if (!$('viewer').hidden && sfx.enabled) sfx.startCrowd(); }, { passive: true });
  // Celular: som e voz só ligam dentro de um toque. No iOS o AudioContext nasce "suspenso" e a voz só fala depois de uma fala
  // iniciada por toque; o primeiro toque na página destrava os dois.
  let voiceUnlocked = false;
  function unlockMedia() {
    if (sfx.enabled) sfx.unlock();
    if (!voiceUnlocked && $('vVoice').checked && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined') {
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; u.lang = 'pt-BR'; window.speechSynthesis.speak(u); voiceUnlocked = true; } catch (_) { /* sem voz */ }
    }
  }
  for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(ev, unlockMedia, { passive: true });
  // iOS: com a chave lateral em "silencioso" o Web Audio fica mudo; durante a partida pede a categoria de reprodução
  const audioSession = type => { try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (_) { /* sem suporte */ } };
  // tela acesa durante a partida (celular)
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
    } catch (_) { /* sem suporte, bateria fraca ou negado: segue sem */ }
  }

  // Voz sempre atrás do lance: nada de fila. Gol/apito (prio 3) e chute/defesa (2) interrompem a fala atual;
  // passes e desarmes (1) só falam se a voz estiver livre. Assim a narração acompanha a bola.
  let voiceBusyUntil = 0, speakRef = null;
  const voiceOk = () => 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  function voiceReset() {
    voiceBusyUntil = 0;
    if (voiceOk()) window.speechSynthesis.cancel();
  }
  function speakNow(text) {
    try {
      const ss = window.speechSynthesis;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pt-BR'; u.rate = 1.35;
      const vs = ss.getVoices();
      const v = vs.find(x => /^pt[-_]BR/i.test(x.lang)) || vs.find(x => /^pt/i.test(x.lang));
      if (v) u.voice = v;
      const mine = voiceBusyUntil = Date.now() + 300 + text.length * 48; // estimativa; o fim real da fala libera antes
      const free = () => { if (voiceBusyUntil === mine) voiceBusyUntil = 0; };
      u.onend = free; u.onerror = free;
      speakRef = u; // o iOS pode descartar (e nunca terminar) uma fala que ninguém referencia
      ss.speak(u);
    } catch (_) { /* sem voz: segue só com texto */ }
  }
  function speak(text, prio) {
    if (!voiceOk()) return;
    if (prio >= 2) { voiceReset(); speakNow(text); return; }
    if (Date.now() >= voiceBusyUntil) speakNow(text);
  }

  function addFeed(line) {
    if (line.feed === false) return;
    const feed = $('vFeed');
    const el = document.createElement('div');
    el.className = 'fl' + (line.big ? ' big' : '');
    el.innerHTML = '<span class="m">' + esc(line.min) + "'</span>" + esc(line.text);
    feed.insertBefore(el, feed.firstChild);
    while (feed.children.length > 400) feed.lastChild.remove();
  }

  function startNarration() {
    narr = new Narrator(match, line => {
      addFeed(line);
      if (quiet) return;
      if (line.type === 'goal') sfx.goal();
      else if (line.type === 'save') sfx.swell(0.12, 1500);
      else if (line.type === 'shot') sfx.swell(0.06, 900);
      else if (line.type === 'kickoff' || line.type === 'halftime' || line.type === 'fulltime') sfx.whistle(line.type !== 'kickoff');
      const spd = pb ? pb.speed : speed, pr = line.prio || (line.big ? 3 : 0);
      if ($('vVoice').checked && line.voice && (pr >= 3 || (pr >= 2 && spd <= 4) || (pr >= 1 && spd <= 2))) speak(line.vtext || line.text, pr);
    });
    sfx.startCrowd();
  }

  function addChat(box, m) {
    const el = document.createElement('div');
    el.className = 'msg' + (S.me && m.clubId === S.me.id ? ' mine' : '') + (m.kind === 'react' ? ' react' : '');
    el.innerHTML = '<i class="cdot" style="background:' + esc(/^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#888') + '"></i><b>' + esc(m.from) + '</b> ' + (m.kind === 'react' ? 'reagiu ' : '') + esc(m.text);
    box.appendChild(el);
    while (box.children.length > 100) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  }

  function floatEmoji(m) {
    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.style.left = (8 + Math.random() * 78) + '%';
    el.innerHTML = '<span>' + esc(m.text) + '</span><small>' + esc(m.from) + '</small>';
    el.addEventListener('animationend', () => el.remove());
    $('vFloat').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function fillPresets() {
    const c = S.meta && S.meta.chat;
    if (!c) return;
    $('vReact').innerHTML = c.emojis.map(e => '<button type="button" data-e="' + esc(e) + '">' + esc(e) + '</button>').join('');
    $('vTaunts').innerHTML = c.taunts.map((t, i) => '<button type="button" data-i="' + i + '">' + esc(t) + '</button>').join('');
  }
  async function sendChat(payload) {
    try { await api('POST', '/api/match/chat', Object.assign({ id: rec.id }, payload)); } catch (e) { fail(e); }
  }
  $('vReact').onclick = e => { const b = e.target.closest('button'); if (b) sendChat({ kind: 'react', text: b.dataset.e }); };
  $('vTaunts').onclick = e => { const b = e.target.closest('button'); if (b) sendChat({ kind: 'taunt', index: +b.dataset.i }); };
  $('vChatForm').onsubmit = e => {
    e.preventDefault();
    const v = $('vChatInput').value.trim();
    if (!v) return;
    $('vChatInput').value = '';
    sendChat({ kind: 'text', text: v });
  };

  async function openMatch(id) {
    let r;
    try { r = await api('GET', '/api/match?id=' + encodeURIComponent(id)); } catch (e) { return fail(e); }
    const m = r.match;
    // a aba está com um motor diferente do servidor (atualização com a página aberta): recarrega para ver o mesmo jogo que o adversário
    if (r.engine && r.engine !== FootballEngine.VERSION) {
      toast('O jogo foi atualizado. Recarregando a página…');
      setTimeout(() => location.reload(), 1200);
      return;
    }
    play = null; $('vHelp').hidden = true; $('vPad').hidden = true; $('vSkip').hidden = false;
    rec = m;
    oldEngine = (m.engine || 0) !== FootballEngine.VERSION;
    match = new FootballEngine.Match(m.homeDef, m.awayDef, { seed: m.seed, knockout: !!m.knockout });
    match.on(ev => {
      if (ev.type !== 'goal') return;
      $('banner').innerHTML = 'GOL!<small>' + esc(ev.player ? ev.player.name : '') + '</small>';
      $('banner').hidden = false;
      countdownOn = false;
      bannerUntil = performance.now() + 2500;
    });
    paused = false; speed = 1; acc = 0; steps = 0; countdownOn = false; pb = null;
    $('vFeed').innerHTML = ''; $('vChat').innerHTML = ''; $('vFloat').innerHTML = '';
    startNarration();
    if (r.playback) {
      applyPlayback(r.playback);
      const opp = S.me && m.home.id === S.me.id ? m.away.name : m.home.name;
      $('vSync').textContent = '🔗 Controles sincronizados com ' + opp;
      $('vSync').hidden = false;
      $('vChatBox').hidden = false;
      for (const m of r.chat || []) addChat($('vChat'), m);
    } else {
      $('vSync').hidden = true;
      $('vChatBox').hidden = true;
      paintControls();
    }
    crest($('vCrestH'), m.homeDef.name, m.homeDef.colors.shirt);
    crest($('vCrestA'), m.awayDef.name, m.awayDef.colors.shirt);
    $('vNameH').textContent = m.homeDef.name;
    $('vNameA').textContent = m.awayDef.name;
    $('vResult').textContent = '';
    $('banner').hidden = true;
    $('viewer').hidden = false;
    document.body.style.overflow = 'hidden';
    keepAwake(true); audioSession('playback');
    if (!renderer) renderer = new PitchRenderer($('pitch'), match, { showNames: true, showNumbers: true });
    else renderer.setMatch(match);
    renderer.resize();
    last = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function penLine() {
    const pn = match.pens;
    const mark = t => pn.kicks.filter(k => k.team === t).map(k => (k.scored ? '⚽' : '❌')).join(' ');
    return 'Pênaltis ' + pn.score[0] + ' – ' + pn.score[1] + '<small>' + esc(match.home.short) + ' ' + mark('home') + '<br>' + esc(match.away.short) + ' ' + mark('away') + '</small>';
  }
  function hud() {
    $('vScoreH').textContent = match.home.score;
    $('vScoreA').textContent = match.away.score;
    const extra = match.half >= 3 ? ' · Prorrogação' : '';
    $('vClock').textContent = match.state === 'fulltime' ? 'FT' : match.state === 'halftime' ? 'Intervalo' : match.state === 'pens' ? 'Pênaltis' : match.minute() + "'" + extra;
    if (match.pens) { $('vPens').hidden = false; $('vPens').innerHTML = penLine(); } else $('vPens').hidden = true;
    if (match.finished && !$('vResult').textContent && rec.practice) {
      $('vResult').textContent = 'Fim do jogo de treino: ' + match.home.name + ' ' + match.home.score + ' x ' + match.away.score + ' ' + match.away.name + ' (sem prêmio nem pontos).';
    } else if (match.finished && !$('vResult').textContent) {
      const [h, a] = rec.score;
      const penTxt = rec.pens ? ' (pênaltis ' + rec.pens[0] + '-' + rec.pens[1] + ')' : '';
      const same = match.home.score === h && match.away.score === a && (!rec.pens || (match.pens && match.pens.score[0] === rec.pens[0] && match.pens.score[1] === rec.pens[1]));
      $('vResult').textContent = 'Resultado oficial: ' + rec.homeDef.name + ' ' + h + ' x ' + a + ' ' + rec.awayDef.name + penTxt +
        (rec.league ? ' · ' + rec.league.name + (rec.league.stage ? ' (' + rec.league.stage + ')' : '') : '') +
        (same ? '' : oldEngine ? ' (partida anterior a uma atualização do jogo: a reprodução é ilustrativa, vale o resultado oficial)' : ' (a reprodução visual divergiu do resultado oficial do servidor)');
    }
  }

  function tick(now) {
    if ($('viewer').hidden) return;
    const real = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (pb) {
      // sincronizado: avança até o instante calculado a partir do relógio do servidor
      const target = pbTick();
      const limit = pb.ended ? 100000 : 3000;
      let n = 0;
      quiet = target - steps > 400; // alcançando a partida (ou pulando): sem voz nem som
      while (!match.finished && steps < target && n < limit) { match.update(STEP); steps++; n++; }
      quiet = false;
      const wait = pb.baseTime - serverNow();
      if (!pb.paused && !pb.ended && steps === 0 && wait > 0) {
        $('banner').innerHTML = 'Começa em ' + Math.ceil(wait / 1000) + '…<small>aguardando os dois jogadores</small>';
        $('banner').hidden = false; countdownOn = true;
      } else if (countdownOn) { $('banner').hidden = true; countdownOn = false; }
    } else if (!paused) {
      acc += real * speed;
      let n = 0;
      while (acc >= STEP && n < 40) { match.update(STEP); acc -= STEP; n++; }
      if (n === 40) acc = 0;
    }
    if (bannerUntil && now > bannerUntil) { $('banner').hidden = true; bannerUntil = 0; }
    renderer.draw();
    hud();
    raf = requestAnimationFrame(tick);
  }

  async function control(action, value) {
    try { applyPlayback((await api('POST', '/api/match/control', { id: rec.id, action, value })).playback); } catch (e) { fail(e); }
  }
  $('vPlay').onclick = () => {
    if (pb) return control(pb.paused ? 'play' : 'pause');
    paused = !paused; paintControls();
  };
  $('vSpeed').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (pb) return control('speed', +b.dataset.v);
    speed = +b.dataset.v; paintControls();
  };
  $('vSkip').onclick = () => {
    if (pb) return control('skip');
    let n = 0;
    quiet = true;
    while (!match.finished && n < 100000) { match.update(STEP); n++; }
    quiet = false;
    $('banner').hidden = true;
    hud();
  };
  $('vClose').onclick = () => {
    $('viewer').hidden = true;
    sfx.stop();
    voiceReset();
    keepAwake(false); audioSession('auto');
    play = null; held.clear(); $('vHelp').hidden = true; $('vPad').hidden = true;
    document.body.style.overflow = '';
    cancelAnimationFrame(raf);
    if (S.tab === 'clubs') loadClubs();
    if (S.tab === 'matches') loadMatches();
  };
  $('pitch').onclick = e => {
    const r = e.currentTarget.getBoundingClientRect();
    renderer.selected = renderer.pickPlayer(e.clientX - r.left, e.clientY - r.top);
  };

  /* ---------- leilão ao vivo e trocas ---------- */
  let xc = { live: [], done: [], trades: [], off: 0 };
  const xNow = () => Date.now() + xc.off;
  const itemOf = id => player(id) || coach(id);
  const meId = () => S.me && S.me.id;

  async function loadExchange() {
    try { applyExchange(await api('GET', '/api/exchange')); } catch (e) { fail(e); }
  }
  function applyExchange(d) {
    xc.live = d.live; xc.done = d.done; xc.off = d.now - Date.now();
    if (d.trades) xc.trades = d.trades;
    if (S.tab === 'exch') renderExchange();
  }
  const posTag = a => a.kind === 'coach' ? '<span class="tag">Técnico</span>' : '<span class="pos ' + ((itemOf(a.itemId) || {}).role || '') + '">' + esc(a.pos || '') + '</span>';

  function renderExchange() {
    if (!S.catalog) return;
    // leilões
    $('xLive').innerHTML = xc.live.map(a => {
      const mine = a.seller === meId(), lead = a.bid && a.bid.clubId === meId();
      const bidBtn = mine ? '<span class="muted">Seu leilão</span>'
        : lead ? '<span class="tag ok">Você está vencendo</span>'
        : '<button class="btn primary sm" data-bid="' + a.id + '" data-min="' + a.minBid + '" type="button">Dar lance ' + money(a.minBid) + '</button> <button class="btn sm" data-bidx="' + a.id + '" data-min="' + a.minBid + '" type="button">Outro valor…</button>';
      return '<div class="auc" data-id="' + a.id + '"><div class="auc-main">' + posTag(a) + ' <b>' + esc(a.name) + '</b>' + (a.ovr ? ' <span class="ovr">' + a.ovr + '</span>' : '') +
        '<div class="muted">' + esc(a.team || '') + ' · vendedor: ' + esc(a.sellerName) + ' · valor de mercado ' + money(a.value) + '</div></div>' +
        '<div class="auc-bid"><div class="auc-price">' + money(a.bid ? a.bid.amount : a.startPrice) + '</div><div class="muted">' + (a.bid ? 'lance de ' + esc(a.bid.name) : 'preço inicial') + '</div></div>' +
        '<div class="auc-time" data-end="' + a.endsAt + '">--</div><div class="auc-act">' + bidBtn + '</div></div>';
    }).join('') || '<p class="muted">Nenhum leilão aberto agora. Abra um pelo botão "Leiloar" na aba Elenco (só vale para jogadores e técnico do seu clube).</p>';
    $('xDone').innerHTML = xc.done.map(a => '<div class="fl">' + (a.result && a.result.sold ? '🔨 ' : '⏹ ') + esc(a.result ? a.result.text : '') + '</div>').join('') || '<span class="muted">Ainda sem leilões encerrados.</span>';
    // trocas
    const line = t => {
      const items = l => l.map(i => esc(i.name)).join(', ') || 'nada';
      const cash = t.cash ? ' ' + (t.cash > 0 ? '+ ' + money(t.cash) + ' de ' + esc(t.fromName) : '+ ' + money(-t.cash) + ' de ' + esc(t.toName)) : '';
      return '<b>' + esc(t.fromName) + '</b> dá <b>' + items(t.give) + '</b> e recebe <b>' + items(t.get) + '</b>' + cash;
    };
    const st = { pending: 'Pendente', accepted: 'Aceita', rejected: 'Recusada', canceled: 'Cancelada', void: 'Anulada' };
    $('xTrades').innerHTML = xc.trades.map(t => {
      let act = '<span class="tag">' + st[t.status] + '</span>' + (t.why ? ' <small class="muted">' + esc(t.why) + '</small>' : '');
      if (t.status === 'pending') act = t.to === meId()
        ? '<button class="btn primary sm" data-tr="accept" data-id="' + t.id + '" type="button">Aceitar</button> <button class="btn sm" data-tr="reject" data-id="' + t.id + '" type="button">Recusar</button>'
        : '<span class="tag">Aguardando ' + esc(t.toName) + '</span> <button class="btn sm" data-tr="cancel" data-id="' + t.id + '" type="button">Cancelar</button>';
      return '<div class="trade">' + line(t) + '<div class="acts">' + act + '</div></div>';
    }).join('') || '<p class="muted">Nenhuma proposta ainda.</p>';
    // formulário: outros clubes
    const sel = $('xTo').value;
    $('xTo').innerHTML = '<option value="">Escolha o clube…</option>' + (S.clubs || []).filter(c => c.id !== meId()).map(c => '<option value="' + c.id + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
    renderTradeLists();
    tickAuctions();
  }
  function renderTradeLists() {
    const list = (ids, name) => ids.map(id => itemOf(id)).filter(Boolean).map(i => '<label class="chk"><input type="checkbox" name="' + name + '" value="' + esc(i.id) + '"> ' + esc(i.short || i.name) + ' <small class="muted">' + (i.pos || 'TEC') + ' · ' + i.ovr + ' · ' + money(i.value) + '</small></label>').join('') || '<span class="muted">—</span>';
    const mine = [...S.me.squad, ...(S.me.coach ? [S.me.coach] : [])];
    const to = $('xTo').value;
    const theirs = to && S.catalog ? [...S.catalog.players, ...S.catalog.coaches].filter(p => p.owner && p.owner.id === to).map(p => p.id) : [];
    const keepG = [...document.querySelectorAll('#xGive input:checked')].map(x => x.value), keepR = [...document.querySelectorAll('#xGet input:checked')].map(x => x.value);
    $('xGive').innerHTML = list(mine, 'give'); $('xGet').innerHTML = to ? list(theirs, 'get') : '<span class="muted">Escolha o clube.</span>';
    for (const v of keepG) { const e = document.querySelector('#xGive input[value="' + CSS.escape(v) + '"]'); if (e) e.checked = true; }
    for (const v of keepR) { const e = document.querySelector('#xGet input[value="' + CSS.escape(v) + '"]'); if (e) e.checked = true; }
  }
  function tickAuctions() {
    for (const el of document.querySelectorAll('.auc-time')) {
      const left = Math.max(0, Math.ceil((+el.dataset.end - xNow()) / 1000));
      el.textContent = left + 's';
      el.classList.toggle('hot', left <= 10);
    }
  }
  setInterval(() => { if (S.tab === 'exch') tickAuctions(); }, 250);

  $('xTo').onchange = renderTradeLists;
  $('xLive').onclick = async e => {
    const b = e.target.closest('[data-bid],[data-bidx]');
    if (!b) return;
    let amount = +b.dataset.min;
    if (b.dataset.bidx) {
      const v = prompt('Seu lance em milhões de euros (mínimo ' + (amount / 1e6).toLocaleString('pt-BR') + '):', String(amount / 1e6));
      if (v == null) return;
      amount = Math.round(parseFloat(String(v).replace(',', '.')) * 1e6);
    }
    try { await api('POST', '/api/auction/bid', { id: b.dataset.bid || b.dataset.bidx, amount }); } catch (err) { fail(err); loadExchange(); }
  };
  $('xTradeForm').onsubmit = async e => {
    e.preventDefault();
    const pick = n => [...document.querySelectorAll('input[name="' + n + '"]:checked')].map(x => x.value);
    const cash = Math.round(parseFloat(String($('xCash').value || '0').replace(',', '.')) * 1e6) || 0;
    try {
      await api('POST', '/api/trade', { to: $('xTo').value, give: pick('give'), get: pick('get'), cash });
      toast('Proposta enviada!');
      $('xCash').value = ''; for (const x of document.querySelectorAll('#xTradeForm input:checked')) x.checked = false;
      loadExchange();
    } catch (err) { fail(err); }
  };
  $('xTrades').onclick = async e => {
    const b = e.target.closest('[data-tr]');
    if (!b) return;
    try {
      await api('POST', '/api/trade/respond', { id: b.dataset.id, action: b.dataset.tr });
      await loadMe(); await loadCatalog(); renderTop();
    } catch (err) { fail(err); }
    loadExchange();
  };
  /**
   * Tela de venda (botão "Leiloar" do Elenco, só para quem já é do seu clube): mostra jogadores parecidos com o valor de cada um e a faixa de preço
   * permitida, para o dono escolher o preço inicial sem ficar muito abaixo nem muito acima do mercado.
   */
  async function auctionItem(id) {
    $('pModal').hidden = false;
    $('pModal').querySelector('.pbox').classList.add('wide');
    $('pBody').innerHTML = '<p class="muted">Calculando a média de mercado…</p>';
    let gd;
    try { gd = await api('GET', '/api/price-guide?id=' + encodeURIComponent(id)); }
    catch (err) { $('pBody').innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; return; }
    const STAT = [['shot', 'Fin'], ['pass', 'Pas'], ['dribble', 'Dri'], ['def', 'Def'], ['speed', 'Vel']];
    const row = (p, me) => '<tr' + (me ? ' class="me"' : '') + '><td>' + (me ? '<b>' + esc(p.name) + '</b> <span class="tag">seu</span>' : esc(p.name)) + '<div class="muted small">' + esc(p.club || '') + '</div></td><td>' + esc(p.pos) + '</td><td class="num ovr">' + p.ovr + '</td>' +
      (gd.coach ? '' : STAT.map(s => '<td class="num">' + (p.stats && p.stats[s[0]] != null ? p.stats[s[0]] : '—') + '</td>').join('')) + '<td class="num"><b>' + money(p.value) + '</b></td></tr>';
    const head = '<tr><th>' + (gd.coach ? 'Técnico' : 'Jogador') + '</th><th>Pos</th><th class="num">Nota</th>' + (gd.coach ? '' : STAT.map(s => '<th class="num" title="' + { shot: 'Finalização', pass: 'Passe', dribble: 'Drible', def: 'Defesa', speed: 'Velocidade' }[s[0]] + '">' + s[1] + '</th>').join('')) + '<th class="num">Valor</th></tr>';
    const min = gd.band.min, max = gd.band.max, ref = gd.reference;
    $('pBody').innerHTML = '<h3>Vender ' + esc(gd.self.name) + '</h3>' +
      '<p class="muted">Você define o preço inicial do leilão. Para o mercado ficar justo, ele precisa ficar perto da média de ' + (gd.coach ? 'técnicos' : 'jogadores com características parecidas') + '. Você não pode dar lance no seu próprio leilão.</p>' +
      '<div class="pgtable"><table>' + head + row(gd.self, true) + gd.neighbors.map(n => row(n, false)).join('') + '</table></div>' +
      '<div class="pgsum"><div><span>Média dos parecidos</span><b>' + money(gd.similarAverage) + '</b></div><div><span>Preço de referência</span><b>' + money(ref) + '</b></div>' +
      '<div><span>Faixa permitida</span><b>' + money(min) + ' a ' + money(max) + '</b></div></div>' +
      '<div class="pgform"><label>Preço inicial (milhões de €)<input id="pgPrice" type="number" step="0.1" min="' + (min / 1e6) + '" max="' + (max / 1e6) + '" value="' + Math.round(ref / 1e5) / 10 + '"></label>' +
      '<div class="pgquick"><button class="btn sm" data-pg="' + min + '" type="button">Mínimo</button><button class="btn sm" data-pg="' + ref + '" type="button">Média</button><button class="btn sm" data-pg="' + max + '" type="button">Máximo</button></div>' +
      '<p id="pgHint" class="muted small"></p><button id="pgGo" class="btn primary" type="button">Iniciar leilão</button></div>';
    const input = $('pgPrice'), hint = $('pgHint'), go = $('pgGo');
    const check = () => {
      const v = Math.round(parseFloat(String(input.value).replace(',', '.')) * 1e6);
      const ok = Number.isFinite(v) && v >= min && v <= max;
      go.disabled = !ok;
      hint.className = 'small ' + (ok ? 'muted' : 'down');
      hint.textContent = !Number.isFinite(v) ? 'Digite um valor.' : v < min ? 'Muito abaixo da média: o mínimo é ' + money(min) + '.' : v > max ? 'Muito acima da média: o máximo é ' + money(max) + '.' : Math.round((v / ref) * 100) + '% da referência de mercado.';
      return v;
    };
    input.oninput = check;
    $('pBody').querySelectorAll('[data-pg]').forEach(bt => { bt.onclick = () => { input.value = Math.round(+bt.dataset.pg / 1e5) / 10; check(); }; });
    go.onclick = async () => {
      const v = check();
      if (go.disabled) return;
      go.disabled = true;
      try {
        await api('POST', '/api/auction/start', { id, startPrice: v });
        $('pModal').hidden = true;
        showTab('exch');
      } catch (err) { fail(err); check(); }
    };
    check();
  }

  /* ---------- jogo de treino: você controla ---------- */
  let play = null; // { two: bool } quando a partida aberta é jogável
  const KEYS = {
    p1: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', pass: 'KeyQ', shoot: 'KeyE', sprint: 'ShiftLeft' },
    p2: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pass: 'KeyK', shoot: 'KeyL', sprint: 'ShiftRight' }
  };
  const held = new Set();
  const padHeld = { up: 0, down: 0, left: 0, right: 0, sprint: 0 };
  function dirOf(k, pad) {
    const h = c => held.has(c) || (pad && padHeld[c]);
    return { dx: (h(k.right) ? 1 : 0) - (h(k.left) ? 1 : 0), dy: (h(k.down) ? 1 : 0) - (h(k.up) ? 1 : 0), sprint: held.has(k.sprint) || (pad && padHeld.sprint) };
  }
  function applyInputs() {
    if (!play || !match) return;
    const a = dirOf(KEYS.p1, true), b = dirOf(KEYS.p2, false);
    if (play.two) { match.setInput('home', a.dx, a.dy, a.sprint); match.setInput('away', b.dx, b.dy, b.sprint); }
    else match.setInput('home', a.dx || b.dx, a.dy || b.dy, a.sprint || b.sprint);
  }
  document.addEventListener('keydown', e => {
    if (!play || $('viewer').hidden || /INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || '')) return;
    const all = Object.values(KEYS.p1).concat(Object.values(KEYS.p2));
    if (all.includes(e.code) || e.code === 'Space') e.preventDefault();
    if (e.repeat) return;
    held.add(e.code);
    if (e.code === KEYS.p1.pass || e.code === 'Space') match.press('home', 'pass');
    if (e.code === KEYS.p1.shoot) match.press('home', 'shoot');
    if (e.code === KEYS.p2.pass) match.press(play.two ? 'away' : 'home', 'pass');
    if (e.code === KEYS.p2.shoot) match.press(play.two ? 'away' : 'home', 'shoot');
    applyInputs();
  });
  document.addEventListener('keyup', e => { held.delete(e.code); applyInputs(); });
  window.addEventListener('blur', () => { held.clear(); for (const k in padHeld) padHeld[k] = 0; applyInputs(); });
  // botões na tela (celular/tablet)
  for (const ev of ['pointerdown', 'pointerup', 'pointercancel', 'pointerleave']) {
    $('vPad').addEventListener(ev, e => {
      const b = e.target.closest('button');
      if (!b || !play) return;
      e.preventDefault();
      const down = ev === 'pointerdown';
      if (b.dataset.d) padHeld[b.dataset.d] = down ? 1 : 0;
      else if (b.dataset.a === 'sprint') padHeld.sprint = down ? 1 : 0;
      else if (down) match.press('home', b.dataset.a);
      b.classList.toggle('on', down);
      applyInputs();
    });
  }

  function openPractice(d, two) {
    if (d.engine !== FootballEngine.VERSION) { toast('O jogo foi atualizado. Recarregando a página…'); setTimeout(() => location.reload(), 1200); return; }
    rec = { id: null, practice: true, homeDef: d.homeDef, awayDef: d.awayDef, seed: d.seed, score: [0, 0], home: { id: S.me.id, name: d.homeDef.name }, away: { id: null, name: d.awayDef.name } };
    match = new FootballEngine.Match(d.homeDef, d.awayDef, { seed: d.seed, knockout: false });
    match.setHuman('home', true);
    if (two) match.setHuman('away', true);
    play = { two };
    held.clear();
    match.on(ev => {
      if (ev.type !== 'goal') return;
      $('banner').innerHTML = 'GOL!<small>' + esc(ev.player ? ev.player.name : '') + '</small>';
      $('banner').hidden = false; countdownOn = false; bannerUntil = performance.now() + 2500;
    });
    paused = false; speed = 1; acc = 0; steps = 0; countdownOn = false; pb = null;
    $('vFeed').innerHTML = ''; $('vChat').innerHTML = ''; $('vFloat').innerHTML = '';
    startNarration();
    $('vSync').hidden = true; $('vChatBox').hidden = true;
    $('vHelp').hidden = false; $('vSkip').hidden = true;
    const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
    $('vHelp').innerHTML = touch && !two
      ? '<b>Você</b>: setas para mover · <b>PASSE</b> para quem está na direção que você aponta · <b>CHUTE</b> · <b>CORRER</b> (segure)'
      : two
      ? '<b>P1</b> (' + esc(d.homeDef.name) + '): W A S D mover · Q passe · E chute · Shift correr &nbsp;|&nbsp; <b>P2</b> (' + esc(d.awayDef.name) + '): setas mover · K passe · L chute · Shift direito correr'
      : '<b>Você</b>: W A S D ou setas para mover · Q ou Espaço passe (na direção que você aponta) · E chute · Shift correr';
    $('vPad').hidden = two || !matchMedia('(pointer: coarse)').matches;
    paintControls();
    crest($('vCrestH'), d.homeDef.name, d.homeDef.colors.shirt);
    crest($('vCrestA'), d.awayDef.name, d.awayDef.colors.shirt);
    $('vNameH').textContent = d.homeDef.name; $('vNameA').textContent = d.awayDef.name;
    $('vResult').textContent = '';
    $('banner').hidden = true;
    $('viewer').hidden = false;
    document.body.style.overflow = 'hidden';
    keepAwake(true); audioSession('playback');
    if (!renderer) renderer = new PitchRenderer($('pitch'), match, { showNames: true, showNumbers: true });
    else renderer.setMatch(match);
    renderer.resize();
    last = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }
  async function startPractice(two) {
    const opp = $('plOpp').value;
    if (!opp) return toast('Escolha o adversário.', { err: true });
    if (two && opp === 'cpu') return toast('Para jogar em dupla, escolha o clube do seu amigo como adversário.', { err: true });
    try { openPractice(await api('POST', '/api/practice', { opponent: opp }), two); } catch (e) { fail(e); }
  }
  $('plSolo').onclick = () => startPractice(false);
  $('plDuo').onclick = () => startPractice(true);
  function fillPracticeOpponents() {
    const sel = $('plOpp').value;
    $('plOpp').innerHTML = '<option value="cpu">CPU FC</option>' + S.clubs.filter(c => c.id !== S.me.id).map(c => '<option value="' + c.id + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
  }

  /* ---------- início ---------- */
  (async function init() {
    S.token = lsGet('fm-token');
    for (;;) {
      try {
        if (!S.cfgLoaded) await setupGoogle().catch(e => { if (e.network) throw e; });
        await enter(); // usa o cookie de sessão (ou o token guardado)
        return;
      } catch (e) {
        if (e.status === 401) { // sem sessão válida: só aqui o acesso guardado é descartado
          S.token = null; lsSet('fm-token', null);
          return showLogin();
        }
        // servidor fora do ar / erro passageiro: NÃO apaga nada; tenta de novo
        showRetry(e.message);
        await Promise.race([sleep(3000), new Promise(r => { retryWake = r; })]);
        retryWake = null;
      }
    }
  })();

  window.fm = { S, api, openMatch, get match() { return match; }, get play() { return play; }, get steps() { return steps; }, get pb() { return pb; } };
})();
