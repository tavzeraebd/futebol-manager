/* Controlador da interface: loop, HUD, estatísticas e eventos. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const STEP = 1 / 60;
  const ICON = { goal: '⚽', yellow: '🟨', corner: '🚩', save: '🧤', shot: '🎯', foul: '✋', halftime: '⏸', fulltime: '🏁', kickoff: '▶' };

  let match, renderer, paused = false, speed = 1, acc = 0, last = 0, bannerUntil = 0;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function setupStatic() {
    const t = TEAM_DATA;
    for (const [k, id] of [['home', 'H'], ['away', 'A']]) {
      const d = t[k];
      const crest = $('crest' + id);
      crest.textContent = d.short;
      crest.style.background = d.colors.shirt;
      crest.style.color = d.colors.number;
      $('name' + id).textContent = d.name;
      $('lu' + id).textContent = d.name + ' · ' + d.formation;
      $('line' + id).innerHTML = d.players.map((p, i) =>
        '<li data-k="' + k + '" data-i="' + i + '"><span class="n">' + p.num + '</span><span>' + esc(p.name) + '</span><span class="pos">' + p.pos + '</span></li>'
      ).join('');
    }
    document.documentElement.style.setProperty('--home', t.home.colors.shirt);
    document.documentElement.style.setProperty('--away', t.away.colors.shirt);
  }

  function newMatch() {
    match = new FootballEngine.Match(TEAM_DATA.home, TEAM_DATA.away);
    match.on(onEvent);
    if (renderer) renderer.setMatch(match);
    $('feed').innerHTML = '';
    $('scorersH').innerHTML = '';
    $('scorersA').innerHTML = '';
    $('banner').hidden = true;
    $('picked').textContent = 'Clique em um jogador para ver detalhes.';
    for (const ev of match.events) onEvent(ev);
    updateHud(true);
  }

  function onEvent(ev) {
    const noisy = ev.type === 'foul';
    if (!noisy) {
      const li = document.createElement('li');
      li.className = (ev.team || '') + ' ' + ev.type;
      li.innerHTML = '<span class="m">' + esc(ev.min) + "'</span><span>" + (ICON[ev.type] || '') + ' ' + esc(ev.text) + '</span>';
      $('feed').appendChild(li);
    }
    if (ev.type === 'goal') {
      const ul = $(ev.team === 'home' ? 'scorersH' : 'scorersA');
      const li = document.createElement('li');
      li.textContent = (ev.player ? ev.player.short : '') + (ev.og ? ' (c)' : '') + " " + ev.min + "'";
      ul.appendChild(li);
      $('banner').innerHTML = 'GOL!<small>' + esc(ev.player ? ev.player.name : '') + '</small>';
      $('banner').hidden = false;
      bannerUntil = performance.now() + 3200;
    }
  }

  let statCache = '';
  function updateHud(force) {
    const h = match.home, a = match.away;
    $('scoreH').textContent = h.score;
    $('scoreA').textContent = a.score;

    let clock, status;
    if (match.state === 'fulltime') { clock = 'FT'; status = 'Encerrado'; }
    else if (match.state === 'halftime') { clock = 'HT'; status = 'Intervalo'; }
    else { clock = match.minute() + "'"; status = match.half === 1 ? '1º tempo' : '2º tempo'; }
    $('clock').textContent = clock;
    $('status').textContent = status;
    $('liveDot').classList.toggle('off', match.finished || match.state === 'halftime' || paused);

    const key = [h.stats.shots, a.stats.shots, h.stats.onTarget, a.stats.onTarget, h.stats.passes, a.stats.passes,
      h.stats.corners, a.stats.corners, h.stats.fouls, a.stats.fouls, h.stats.yellow, a.stats.yellow, Math.round(h.stats.poss / 3)].join();
    if (!force && key === statCache) return;
    statCache = key;

    const tot = h.stats.poss + a.stats.poss || 1;
    const ph = Math.round(h.stats.poss / tot * 100);
    $('possH').textContent = ph + '%';
    $('possA').textContent = (100 - ph) + '%';
    $('possBar').style.width = ph + '%';

    const rows = [['Finalizações', 'shots'], ['No alvo', 'onTarget'], ['Passes', 'passes'], ['Escanteios', 'corners'], ['Faltas', 'fouls'], ['Cartões amarelos', 'yellow']];
    $('stats').innerHTML = rows.map(([label, k]) =>
      '<div class="stat-row"><b>' + h.stats[k] + '</b><span>' + label + '</span><b>' + a.stats[k] + '</b></div>').join('');
  }

  function showPlayer(p) {
    renderer.selected = p;
    if (!p) return;
    $('picked').innerHTML = '<b>#' + p.num + ' ' + esc(p.name) + '</b> · ' + esc(p.team.name) + ' · ' + p.pos;
  }

  function frame(now) {
    const real = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused) {
      acc += real * speed;
      let n = 0;
      while (acc >= STEP && n < 40) { match.update(STEP); acc -= STEP; n++; }
      if (n === 40) acc = 0;
    }
    if (bannerUntil && now > bannerUntil) { $('banner').hidden = true; bannerUntil = 0; }
    renderer.draw();
    updateHud(false);
    requestAnimationFrame(frame);
  }

  function bind() {
    $('btnPlay').onclick = () => {
      paused = !paused;
      $('btnPlay').textContent = paused ? 'Continuar' : 'Pausar';
    };
    $('speed').onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      speed = +b.dataset.v;
      for (const x of $('speed').children) x.classList.toggle('on', x === b);
    };
    $('optNames').onchange = e => { renderer.opts.showNames = e.target.checked; };
    $('optNums').onchange = e => { renderer.opts.showNumbers = e.target.checked; };
    $('btnRestart').onclick = () => { newMatch(); };
    $('pitch').onclick = e => {
      const r = e.currentTarget.getBoundingClientRect();
      showPlayer(renderer.pickPlayer(e.clientX - r.left, e.clientY - r.top));
    };
    for (const id of ['lineH', 'lineA']) {
      $(id).onclick = e => {
        const li = e.target.closest('li');
        if (!li) return;
        const team = match[li.dataset.k];
        showPlayer(team.players[+li.dataset.i]);
      };
    }
  }

  setupStatic();
  match = new FootballEngine.Match(TEAM_DATA.home, TEAM_DATA.away);
  match.on(onEvent);
  renderer = new PitchRenderer($('pitch'), match);
  bind();
  for (const ev of match.events) onEvent(ev);
  updateHud(true);
  requestAnimationFrame(t => { last = t; frame(t); });

  // Acesso pelo console / futuro jogo
  window.game = { get match() { return match; }, get renderer() { return renderer; } };
})();
