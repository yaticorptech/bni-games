import { api, withRetry, connectSocket, getToken, setToken, clearToken, toast, sfx, esc, fmt, countUp, sleep, confetti, abortError, vibrate, photoUrl, initials } from './common.js';
import rush from './games/rush.js';
import reflex from './games/reflex.js';
import memory from './games/memory.js';
import colors from './games/colors.js';
import quiz from './games/quiz.js';
import pictionary from './games/pictionary.js';
import simon from './games/simon.js';
import odd from './games/odd.js';

const MODULES = { rush, reflex, memory, colors, quiz, pictionary, simon, odd };
const VIEWS = ['boot', 'join', 'hub', 'game', 'result', 'tap', 'quiz'];
const $ = (sel, root = document) => root.querySelector(sel);

const S = {
  settings: null,
  games: [],
  me: null, // { player, games: {id: {best, used, left}}, total, rank, ranked, hidden, top, team }
  view: 'boot',
  round: null, // Team Tap Battle round state from the server
  roundAt: 0, // performance.now() when `round` arrived — timers run from there
  live: null, // Live Quiz question on the big screen
  liveAt: 0,
};
let socket = null;

// ------------------------------------------------------------------ helpers

function show(view) {
  S.view = view;
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('hidden', v !== view);
  window.scrollTo(0, 0);
}

const gameById = (id) => S.games.find((g) => g.id === id);

function accentFg(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 160 ? '#1d1503' : '#fff';
}

function applyTitle() {
  document.title = `${S.settings.eventTitle} · Games`;
}

async function refreshMe() {
  S.me = await api('/api/me');
  return S.me;
}

function signedOut(msg) {
  clearToken();
  S.me = null;
  connect();
  renderJoin();
  show('join');
  if (msg) toast(msg);
}

function modal({ title, html, ok = 'OK', cancel = 'Cancel' }) {
  const el = $('#modal');
  el.innerHTML = `
    <div class="modal-box">
      <h3>${title}</h3>
      ${html}
      <div class="modal-actions">
        <button class="btn btn-ghost" data-act="no">${esc(cancel)}</button>
        <button class="btn btn-primary" data-act="yes">${esc(ok)}</button>
      </div>
    </div>`;
  el.classList.remove('hidden');
  return new Promise((resolve) => {
    const close = (v) => {
      el.classList.add('hidden');
      el.innerHTML = '';
      el.onclick = null;
      resolve(v);
    };
    el.onclick = (e) => {
      if (e.target === el) return close(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) close(act === 'yes');
    };
  });
}

// ------------------------------------------------------------------ join

function renderJoin() {
  const s = S.settings;
  // With a guest list, the organiser already knows everyone: guests log in with the mobile
  // number they registered, and their name comes from the list.
  const byPhone = s.loginMode === 'phone';
  const chapterSelect =`<select name="chapter"><option value="">Select your chapter</option>${s.chapters.map((c) => `<option>${esc(c)}</option>`).join('')}</select>`;
  const chapterField = s.chapters.length ? chapterSelect : `<input name="chapter" maxlength="40" placeholder="e.g. BNI Titans">`;
  const fields = byPhone
    ? `<label class="field"><span>Your mobile number *</span>
        <input name="phone" type="tel" inputmode="numeric" autocomplete="tel" required maxlength="16" placeholder="10-digit number"></label>
      ${s.chapters.length ? `<label class="field"><span>Chapter</span>${chapterSelect}</label>` : ''}`
    : `<label class="field"><span>Your name *</span>
        <input name="name" required minlength="2" maxlength="40" placeholder="e.g. Priya Sharma" autocomplete="name"></label>
      <label class="field"><span>Business / category</span>
        <input name="business" maxlength="60" placeholder="e.g. Interior Designer" autocomplete="organization"></label>
      <label class="field"><span>Chapter</span>${chapterField}</label>`;
  $('#view-join').innerHTML = `
    <div class="hero">
      <div class="hero-badge">🏆</div>
      <h1>${esc(s.eventTitle)}</h1>
      <p class="hero-sub">${esc(s.tagline)}</p>
      <div class="hero-games">${S.games.map((g) => `<span title="${esc(g.name)}">${g.emoji}</span>`).join('')}</div>
    </div>
    <form id="join-form" class="card form" autocomplete="on" novalidate>
      ${fields}
      <button class="btn btn-primary btn-lg" type="submit">${byPhone ? 'Log in →' : 'Let’s play →'}</button>
      <p class="fine center">${byPhone ? 'Use the number you registered with · ' : ''}${S.games.length} quick games · your best score in each counts · watch the big screen!</p>
    </form>
    <div class="powered"><span>Powered by</span><img src="/img/brand/yaticorp-white.png" alt="Yaticorp"></div>`;

  const form = $('#join-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    if (byPhone && String(body.phone || '').replace(/\D/g, '').length < 10) return toast('Please enter your 10-digit mobile number');
    if (!byPhone && String(body.name || '').trim().length < 2) return toast('Please enter your name');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    sfx.unlock();
    try {
      const res = await api('/api/join', { method: 'POST', body });
      setToken(res.token);
      connect();
      await refreshMe();
      renderHub();
      show('hub');
      if (byPhone) toast(`Welcome, ${res.player.name}! 👋`);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ hub

function rankHtml() {
  const me = S.me;
  if (me.hidden) return `<div class="label">Rank</div><div class="rank-num">🤫</div><div class="rank-of">hidden for the reveal</div>`;
  if (!me.rank) return `<div class="label">Rank</div><div class="rank-num">—</div><div class="rank-of">play to get ranked</div>`;
  return `<div class="label">Rank</div><div class="rank-num">#${me.rank}</div><div class="rank-of">of ${fmt(me.ranked)} players</div>`;
}

function miniBoardHtml() {
  const me = S.me;
  if (me.hidden) {
    return `<h3>🤫 Leaderboard hidden</h3><p class="fine">The organisers are saving the results for the grand reveal — eyes on the big screen! 👀</p>`;
  }
  if (!me.top?.length) return `<h3><span class="live-dot"></span> Live top 5</h3><p class="fine">No scores yet — be the first on the board!</p>`;
  const rows = me.top
    .map(
      (r) => `
      <div class="mini-row ${r.id === me.player.id ? 'me' : ''}">
        <div class="mini-rank">${['🥇', '🥈', '🥉'][r.rank - 1] || r.rank}</div>
        <div class="mini-av"><img src="${photoUrl(r.name)}" alt="" onerror="this.remove()"><span>${esc(initials(r.name))}</span></div>
        <div class="mini-name">${esc(r.name)}${r.business ? `<small>${esc(r.business)}</small>` : ''}</div>
        <div class="mini-total">${fmt(r.total)}</div>
      </div>`,
    )
    .join('');
  return `<h3><span class="live-dot"></span> Live top 5</h3>${rows}`;
}

function gameCardHtml(g) {
  const s = S.settings;
  const info = S.me.games[g.id];
  const open = s.playOpen && s.enabledGames.includes(g.id);
  const done = info.left === 0;
  const tries = info.left === null ? 'unlimited tries' : `${info.left} ${info.left === 1 ? 'try' : 'tries'} left`;
  const status = info.best != null ? `Best <b>${fmt(info.best)}</b>` : 'Not played yet';
  const cta = !open ? 'Closed' : done ? 'Done ✓' : info.best != null ? 'Again' : 'Play';
  const cls = !open ? 'is-off' : done ? 'is-done' : '';
  return `
    <button class="game-card ${cls}" data-game="${g.id}" ${!open || done ? 'disabled' : ''}
      style="--accent:${g.color};--accent-fg:${accentFg(g.color)}">
      <div class="gc-emoji">${g.emoji}</div>
      <div>
        <div class="gc-name">${esc(g.name)}</div>
        <div class="gc-tag">${esc(g.tagline)}</div>
        <div class="gc-meta"><span>${status}</span><span class="chip">${tries}</span><span class="chip">${esc(g.duration)}</span></div>
      </div>
      <div class="gc-cta">${cta}</div>
    </button>`;
}

function renderHub() {
  const { settings: s, me } = S;
  const first = me.player.name.split(' ')[0];
  $('#view-hub').innerHTML = `
    <header class="hub-head">
      <div class="hub-id">
        <div class="hub-photo"><img src="${photoUrl(me.player.name)}" alt="" onerror="this.parentElement.remove()"></div>
        <div><div class="eyebrow">${esc(s.eventTitle)}</div><h2>Hi, ${esc(first)} 👋</h2></div>
      </div>
      <button class="icon-btn" id="mute-btn" aria-label="Toggle sound">${sfx.muted ? '🔇' : '🔊'}</button>
    </header>
    <section class="score-card">
      <div><div class="label">Total score</div><div class="big" id="hub-total" data-value="${me.total}">${fmt(me.total)}</div></div>
      <div class="rank-box" id="hub-rank">${rankHtml()}</div>
    </section>
    ${teamCardHtml()}
    ${s.playOpen ? '' : '<div class="notice">⏸ Games are closed right now — stay tuned for the results!</div>'}
    <section class="games">${S.games.filter((g) => !g.hosted).map(gameCardHtml).join('')}</section>
    <section class="card mini-board" id="mini-board">${miniBoardHtml()}</section>
    <footer class="hub-foot">Playing as <b>${esc(me.player.name)}</b>${me.player.business ? ` · ${esc(me.player.business)}` : ''}<br>
      <button class="link" id="switch-btn">Not you? Switch player</button></footer>
    <div class="powered"><span>Powered by</span><img src="/img/brand/yaticorp-white.png" alt="Yaticorp"></div>`;

  $('#view-hub').querySelectorAll('.game-card').forEach((el) => el.addEventListener('click', () => openGame(el.dataset.game)));
  $('#mute-btn').onclick = (e) => {
    sfx.muted = !sfx.muted;
    e.currentTarget.textContent = sfx.muted ? '🔇' : '🔊';
  };
  $('#switch-btn').onclick = async () => {
    const ok = await modal({
      title: 'Switch player?',
      html: '<p class="fine">Your scores stay saved under your current name. Only switch if this phone belongs to someone else.</p>',
      ok: 'Switch',
    });
    if (ok) signedOut();
  };
}

/** Live update from the socket without re-rendering the whole hub. */
function patchHubLive() {
  const total = $('#hub-total');
  if (total) countUp(total, S.me.total);
  const rank = $('#hub-rank');
  if (rank) rank.innerHTML = rankHtml();
  const board = $('#mini-board');
  if (board) board.innerHTML = miniBoardHtml();
  const card = $('#team-card');
  const html = teamCardHtml();
  if (card) card.outerHTML = html;
  else if (html) $('#view-hub .score-card')?.insertAdjacentHTML('afterend', html); // teams were just dealt
}

// ------------------------------------------------------------------ team tap battle

const ordinal = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
const roundActive = () => Boolean(S.round && (S.round.status === 'countdown' || S.round.status === 'running'));

/** Countdown / time left right now: the server's figures minus the time since they arrived. */
function roundClock() {
  const r = S.round;
  const dt = performance.now() - S.roundAt;
  return { countdown: Math.max(0, (r?.countdownMs || 0) - dt), remaining: Math.max(0, (r?.remainingMs || 0) - dt) };
}

function teamCardHtml() {
  const { settings: s, me, round: r } = S;
  if (!s.teams?.length) return '';
  const team = me.team;
  const status = roundActive()
    ? 'A round is on right now!'
    : r?.status === 'ended' ? `Round ${r.no} is over — waiting for the next one` : 'Waiting for the organiser to start a round';
  return `
    <section class="card team-card" id="team-card" style="--accent:${team?.color || '#64748b'}">
      <div>
        <div class="eyebrow">👥 Team Tap Battle</div>
        <h3>${team ? `${team.emoji} Team ${esc(team.name)}` : 'Your team is coming…'}</h3>
        <p class="fine">${status}</p>
      </div>
      ${team && roundActive() ? '<button class="btn btn-gold" id="team-join">Join in →</button>' : ''}
    </section>`;
}

let tapUi = null; // per-round state of the tap view

function onRound(r) {
  S.round = r;
  S.roundAt = performance.now();
  if (S.view === 'tap') return updateTap();
  if (!S.me) return;
  if (roundActive() && (S.view === 'hub' || S.view === 'result')) {
    if (S.me.team) enterTap(); // no team yet → the next live update brings it and jumps in
  } else if (S.view === 'hub') {
    patchHubLive();
  } else if (S.view === 'game' && r.status === 'countdown') {
    toast('👥 Team Tap Battle is starting — finish up and join in!');
  }
}

function enterTap() {
  show('tap');
  renderTap();
}

function renderTap() {
  const r = S.round;
  const team = S.me?.team;
  if (!r || r.status === 'idle' || !team) return backToHub();
  if (!tapUi || tapUi.no !== r.no) {
    tapUi = { no: r.no, mine: 0, pending: 0, flushTimer: null, done: false };
    $('#view-tap').innerHTML = `
      <div class="hud" style="--accent:${team.color}">
        <button class="icon-btn" id="tap-quit" aria-label="Back to games">✕</button>
        <div class="hud-name">${team.emoji} Team ${esc(team.name)} · Round ${r.no}</div>
        <div class="hud-stats">
          <div class="hud-stat"><span>Time</span><b id="tap-time">–</b></div>
          <div class="hud-stat"><span>My taps</span><b id="tap-mine">0</b></div>
        </div>
      </div>
      <div class="stage tap-stage">
        <div class="tap-standing" id="tap-standing"></div>
        <button class="tap-btn" id="tap-btn" style="--accent:${team.color}">
          <span class="tap-big" id="tap-big"></span><span class="tap-sub" id="tap-sub"></span>
        </button>
        <div class="tap-teams" id="tap-teams"></div>
        <div id="tap-actions"></div>
      </div>`;
    const btn = $('#tap-btn');
    btn.addEventListener('pointerdown', onTapPress);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    $('#tap-quit').onclick = () => {
      flushTaps();
      backToHub();
    };
    requestAnimationFrame(tapClockLoop);
  }
  updateTap();
}

function onTapPress(e) {
  e.preventDefault();
  if (!S.round || S.round.status !== 'running' || roundClock().remaining <= 0) return;
  tapUi.mine++;
  tapUi.pending++;
  $('#tap-mine').textContent = fmt(tapUi.mine);
  const btn = $('#tap-btn');
  btn.classList.remove('hit');
  void btn.offsetWidth;
  btn.classList.add('hit');
  vibrate(8);
  if (!tapUi.flushTimer) tapUi.flushTimer = setTimeout(flushTaps, 200);
}

/** Taps go out in small batches (5/s) over the live connection, or the API if that's down. */
function flushTaps() {
  if (!tapUi) return;
  clearTimeout(tapUi.flushTimer);
  tapUi.flushTimer = null;
  const n = tapUi.pending;
  if (!n) return;
  tapUi.pending = 0;
  if (socket?.connected) socket.emit('tap', n);
  else api('/api/tap', { method: 'POST', body: { n } }).catch(() => {});
}

/** Smooth countdown and timer between server updates. */
function tapClockLoop() {
  if (S.view !== 'tap' || !tapUi) return;
  const r = S.round;
  const { countdown, remaining } = roundClock();
  if (r.status === 'countdown') $('#tap-big').textContent = countdown > 400 ? Math.ceil(countdown / 1000) : 'GO!';
  else if (r.status === 'running') $('#tap-time').textContent = `${Math.ceil(remaining / 1000)}s`;
  requestAnimationFrame(tapClockLoop);
}

function updateTap() {
  const r = S.round;
  const team = S.me?.team;
  if (!r || !team || !tapUi) return;
  if (tapUi.no !== r.no) return renderTap(); // a new round began while we were here
  const teams = S.settings.teams;
  const taps = (t) => (r.taps?.[t.id] || 0) + (t.id === team.id ? tapUi.pending : 0);
  const order = [...teams].sort((a, b) => taps(b) - taps(a));
  const max = Math.max(1, ...order.map(taps));
  const pos = order.findIndex((t) => t.id === team.id) + 1;
  const second = order[1];
  const big = $('#tap-big');
  const sub = $('#tap-sub');
  const standing = $('#tap-standing');
  const btn = $('#tap-btn');

  if (r.status === 'countdown') {
    big.textContent = Math.ceil(roundClock().countdown / 1000) || 'GO!';
    sub.textContent = 'Get ready to tap…';
    $('#tap-time').textContent = '–';
    standing.textContent = `You’re on Team ${team.name} — tap like crazy when it says GO!`;
    btn.classList.remove('live', 'over');
  } else if (r.status === 'running') {
    big.textContent = 'TAP!';
    sub.textContent = 'as fast as you can';
    standing.textContent = pos === 1
      ? (second && taps(second) === taps(team) ? '🤝 Tied for the lead!' : `🥇 Your team is leading${second ? ` by ${fmt(taps(team) - taps(second))}` : ''}!`)
      : `${pos === 2 ? '🥈' : pos === 3 ? '🥉' : `#${pos}`} Your team is ${ordinal(pos)} — ${fmt(taps(order[0]) - taps(team))} behind`;
    btn.classList.add('live');
    btn.classList.remove('over');
  } else if (r.status === 'ended') {
    const ranking = r.ranking || order.map((t) => t.id);
    const winner = teams.find((t) => t.id === ranking[0]);
    const myPos = ranking.indexOf(team.id) + 1;
    big.textContent = r.tie ? 'IT’S A TIE!' : myPos === 1 ? 'YOU WON! 🎉' : `${ordinal(myPos).toUpperCase()} PLACE`;
    sub.textContent = r.tie ? 'Dead heat at the top' : `Team ${winner?.name || '?'} wins round ${r.no}`;
    $('#tap-time').textContent = '0s';
    standing.textContent = `You tapped ${fmt(tapUi.mine)} times for Team ${team.name}`;
    btn.classList.remove('live');
    btn.classList.add('over');
    if (!tapUi.done) {
      tapUi.done = true;
      flushTaps();
      if (myPos === 1 && !r.tie) {
        sfx.win();
        confetti();
      } else sfx.good();
      $('#tap-actions').innerHTML = '<button class="btn btn-primary btn-lg" id="tap-back">Back to games →</button>';
      $('#tap-back').onclick = backToHub;
    }
  }
  $('#tap-teams').innerHTML = order
    .map((t) => `<div class="tap-team ${t.id === team.id ? 'me' : ''}"><span>${t.emoji} ${esc(t.name)}</span><i><b style="width:${(taps(t) / max) * 100}%;background:${t.color}"></b></i><em>${fmt(taps(t))}</em></div>`)
    .join('');
}

// ------------------------------------------------------------------ live quiz (hosted on the big screen)

let quizUi = null; // per-question state of the quiz view
const liveOpen = () => S.live?.status === 'open';

function onLiveQuestion(q) {
  S.live = q;
  S.liveAt = performance.now();
  if (S.view === 'quiz') return updateQuiz();
  if (!S.me) return;
  if (q.status === 'open' && ['hub', 'result', 'tap'].includes(S.view)) enterQuiz();
  else if (q.status === 'open' && S.view === 'game') toast('📺 A Live Quiz question is up — finish and join in!');
}

function enterQuiz() {
  show('quiz');
  renderQuiz();
}

function renderQuiz() {
  const q = S.live;
  if (!q || q.status === 'idle') return backToHub();
  if (!quizUi || quizUi.no !== q.no) {
    quizUi = { no: q.no, choice: null, ms: null, locked: false, done: false };
    const vote = q.kind === 'vote';
    $('#view-quiz').innerHTML = `
      <div class="hud" style="--accent:${vote ? '#a855f7' : '#f97316'}">
        <button class="icon-btn" id="lq-quit" aria-label="Back to games">✕</button>
        <div class="hud-name">${vote ? '📊 Live Vote' : '📺 Live Quiz'} · Question ${q.no}</div>
        <div class="hud-stats"><div class="hud-stat"><span>Time</span><b id="lq-time">–</b></div></div>
      </div>
      <div class="stage quiz">
        <div class="quiz-timer"><i id="lq-bar"></i></div>
        <h3 class="quiz-q">${esc(q.q)}</h3>
        <div class="quiz-opts" id="lq-opts">${q.options
          .map((o, i) => `<button class="quiz-opt" type="button" data-i="${i}"><span class="quiz-letter">${'ABCDEF'[i]}</span><span>${esc(o)}</span></button>`)
          .join('')}</div>
        <div class="quiz-feedback" id="lq-fb">${vote ? 'Tap to cast your vote!' : 'Tap your answer — faster is worth more!'}</div>
        <div id="lq-actions"></div>
      </div>`;
    $('#lq-quit').onclick = backToHub;
    $('#lq-opts').addEventListener('click', (e) => {
      const b = e.target.closest('.quiz-opt');
      if (b) answerLive(Number(b.dataset.i));
    });
    requestAnimationFrame(quizClockLoop);
  }
  updateQuiz();
}

async function answerLive(i) {
  if (!quizUi || quizUi.locked || !liveOpen()) return;
  quizUi.locked = true;
  quizUi.choice = i;
  const btns = [...document.querySelectorAll('#lq-opts .quiz-opt')];
  btns.forEach((b) => (b.disabled = true));
  btns[i].classList.add('picked');
  sfx.tick();
  vibrate(15);
  $('#lq-fb').textContent = 'Sending…';
  try {
    const r = await withRetry(() => api('/api/livequiz/answer', { method: 'POST', body: { choice: i } }));
    quizUi.ms = r.ms ?? null;
    $('#lq-fb').textContent = r.locked ? 'Already answered on another device' : S.live?.kind === 'vote' ? '🗳️ Vote in — watch the big screen!' : '✅ Answer in — eyes on the big screen!';
  } catch (err) {
    quizUi.locked = false;
    btns.forEach((b) => (b.disabled = false));
    btns[i].classList.remove('picked');
    $('#lq-fb').textContent = err.code === 'TOO_LATE' ? '⏰ Too late!' : err.message;
  }
}

function quizClockLoop() {
  if (S.view !== 'quiz' || !quizUi) return;
  const q = S.live;
  if (q?.status === 'open') {
    const left = Math.max(0, q.remainingMs - (performance.now() - S.liveAt));
    const t = $('#lq-time');
    t.textContent = `${Math.ceil(left / 1000)}s`;
    t.parentElement.classList.toggle('urgent', left < 5500);
    $('#lq-bar').style.width = `${(left / q.limitMs) * 100}%`;
  }
  requestAnimationFrame(quizClockLoop);
}

function updateQuiz() {
  const q = S.live;
  if (!q || !quizUi) return;
  if (q.status === 'idle') return backToHub();
  if (quizUi.no !== q.no) return renderQuiz();
  if (q.status !== 'closed' || quizUi.done) return;
  quizUi.done = true;
  const btns = [...document.querySelectorAll('#lq-opts .quiz-opt')];
  btns.forEach((b) => (b.disabled = true));
  if (q.kind === 'vote') {
    // A poll: show how the room voted, no points.
    const counts = q.result?.counts || [];
    const total = Math.max(1, counts.reduce((a, b) => a + b, 0));
    const top = Math.max(0, ...counts);
    const winners = q.options.filter((_, i) => counts[i] === top && top > 0);
    btns.forEach((b, i) => { if (counts[i] === top && top > 0) b.classList.add('right'); });
    $('#lq-fb').textContent = winners.length ? `📊 The room says: ${winners.join(' & ')} (${Math.round((top / total) * 100)}%)` : '📊 No votes came in';
    $('#lq-time').textContent = '0s';
    $('#lq-time').parentElement.classList.remove('urgent');
    $('#lq-bar').style.width = '0%';
    sfx.good();
    $('#lq-actions').innerHTML = '<button class="btn btn-primary btn-lg" id="lq-back">Back to games →</button>';
    $('#lq-back').onclick = backToHub;
    return;
  }
  btns[q.answer]?.classList.add('right');
  const mine = quizUi.choice;
  const correct = mine === q.answer && quizUi.ms != null;
  if (mine != null && mine !== q.answer) btns[mine].classList.add('wrong');
  const pts = correct ? 50 + Math.round(50 * Math.max(0, 1 - Math.min(quizUi.ms, q.limitMs) / q.limitMs)) : 0;
  const myPos = correct ? (q.result?.fastest || []).findIndex((f) => f.ms === quizUi.ms && f.name === S.me.player.name) + 1 : 0;
  $('#lq-fb').textContent = correct
    ? `✅ Correct! +${pts} points${myPos ? ` · ⚡ ${ordinal(myPos)} fastest in the room!` : ''}`
    : mine == null ? `⏰ No answer — it was ${'ABCDEF'[q.answer]}` : `❌ Not this time — it was ${'ABCDEF'[q.answer]}`;
  $('#lq-time').textContent = '0s';
  $('#lq-time').parentElement.classList.remove('urgent');
  $('#lq-bar').style.width = '0%';
  if (correct) {
    sfx.win();
    if (myPos && myPos <= 3) confetti({ duration: 2500, count: 140 });
  } else sfx.bad();
  $('#lq-actions').innerHTML = '<button class="btn btn-primary btn-lg" id="lq-back">Back to games →</button>';
  $('#lq-back').onclick = backToHub;
}

// ------------------------------------------------------------------ lucky draw & nudges

/** The big screen spins for ~7 s — phones celebrate when the wheel stops, not before. */
function onLuckyDraw(d) {
  if (!S.me) return;
  setTimeout(() => {
    if (d.winner.id === S.me.player.id) {
      sfx.win();
      confetti({ duration: 8000, count: 300 });
      vibrate([120, 60, 120, 60, 400]);
      modal({
        title: '🎉 YOU WON THE LUCKY DRAW!',
        html: `<div class="win-photo"><img src="${photoUrl(S.me.player.name)}" alt="" onerror="this.parentElement.remove()"></div><p class="fine">Look at the big screen, ${esc(S.me.player.name.split(' ')[0])} — and go collect your prize!</p>`,
        ok: 'Woohoo! 🙌',
        cancel: 'Close',
      });
    } else {
      toast(`🎡 Lucky draw: ${d.winner.name} wins a prize!`, 8000);
    }
  }, 7200);
}

/** Rank moved since the last live update: a little rivalry goes a long way — in small doses. */
let lastNudgeAt = 0;
function nudge(before) {
  const me = S.me;
  if (S.view === 'game' || me.hidden || !before.rank || !me.rank || me.rank === before.rank) return;
  // Don't nag (busy boards reshuffle every few seconds), and never talk over another message.
  if (performance.now() - lastNudgeAt < 20000 || $('#toast')?.classList.contains('show')) return;
  lastNudgeAt = performance.now();
  if (me.rank > before.rank && me.above) {
    toast(`📉 ${me.above.name} just overtook you — you’re #${me.rank} now. Play again to climb back!`, 6000);
  } else if (me.rank < before.rank && me.rank <= 3) {
    toast(me.rank === 1 ? '👑 You’re leading the night!' : `🚀 You climbed to #${me.rank} — top 3!`, 5000);
    sfx.bonus();
  }
}

// ------------------------------------------------------------------ playing

async function openGame(gameId) {
  const g = gameById(gameId);
  const info = S.me.games[gameId];
  const triesLine =
    info.left === null
      ? 'Unlimited tries — your best score counts.'
      : `This uses 1 of your ${info.left} remaining ${info.left === 1 ? 'try' : 'tries'}. Your best score counts.`;
  const ok = await modal({
    title: `${g.emoji} ${esc(g.name)}`,
    html: `<ul class="howto">${g.howTo.map((h) => `<li>${esc(h)}</li>`).join('')}</ul><p class="fine">${triesLine}</p>`,
    ok: 'Start ▶',
    cancel: 'Back',
  });
  if (!ok) return;
  sfx.unlock();
  let start;
  try {
    start = await api(`/api/games/${gameId}/start`, { method: 'POST' });
  } catch (err) {
    if (err.status === 401) return signedOut('Please join again');
    toast(err.message);
    refreshMe().then(renderHub).catch(() => {});
    return;
  }
  await runGame(g, start);
}

async function countdown(stage, signal) {
  stage.innerHTML = `<div class="countdown"><div class="cd-num" id="cd"></div><p>Get ready…</p></div>`;
  const el = $('#cd', stage);
  for (const n of ['3', '2', '1', 'GO!']) {
    if (signal.aborted) throw abortError();
    el.textContent = n;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    n === 'GO!' ? sfx.go() : sfx.tick();
    await sleep(n === 'GO!' ? 450 : 750, signal);
  }
}

async function backToHub() {
  try {
    await refreshMe();
  } catch (err) {
    if (err.status === 401) return signedOut('Please join again');
  }
  renderHub();
  show('hub');
}

async function runGame(g, start) {
  const view = $('#view-game');
  view.innerHTML = `
    <div class="hud" style="--accent:${g.color}">
      <button class="icon-btn" id="quit-btn" aria-label="Quit game">✕</button>
      <div class="hud-name">${g.emoji} ${esc(g.name)}</div>
      <div class="hud-stats">
        <div class="hud-stat"><span id="hud-time-label">Time</span><b id="hud-time">–</b></div>
        <div class="hud-stat"><span id="hud-score-label">Score</span><b id="hud-score">0</b></div>
      </div>
    </div>
    <div class="stage" id="stage"></div>`;
  show('game');

  const ac = new AbortController();
  $('#quit-btn').onclick = async () => {
    const quit = await modal({ title: 'Quit this game?', html: '<p class="fine">This try will still count as used.</p>', ok: 'Quit', cancel: 'Keep playing' });
    if (quit) ac.abort();
  };
  const hud = {
    time: (v) => {
      const el = $('#hud-time');
      el.textContent = v;
      el.parentElement.classList.toggle('urgent', typeof v === 'number' && v > 0 && v <= 5); // final seconds glow red
    },
    score: (v) => ($('#hud-score').textContent = typeof v === 'number' ? fmt(v) : v),
    timeLabel: (t) => ($('#hud-time-label').textContent = t),
    scoreLabel: (t) => ($('#hud-score-label').textContent = t),
  };
  const stage = $('#stage');

  let result;
  try {
    await countdown(stage, ac.signal);
    result = await MODULES[g.id].play(stage, { attempt: start, hud, sfx, signal: ac.signal });
  } catch (err) {
    $('#modal').classList.add('hidden');
    if (err.name !== 'AbortError') {
      if (err.status === 401) return signedOut('Please join again');
      toast(err.message || 'Something went wrong');
    }
    return backToHub();
  }
  $('#modal').classList.add('hidden');
  $('#quit-btn').disabled = true;
  stage.innerHTML = `<div class="saving"><div class="spinner"></div><p>Saving your score…</p></div>`;

  let res;
  for (let i = 0; ; i++) {
    try {
      res = await api(`/api/attempts/${start.attemptId}/finish`, { method: 'POST', body: { result } });
      break;
    } catch (err) {
      if (err.status === 401) return signedOut('Please join again');
      if (!err.network || i >= 4) {
        toast(err.message);
        return backToHub();
      }
      await sleep(1000 * (i + 1));
    }
  }
  showResult(g, res);
}

function metaLine(gameId, m) {
  if (!m) return '';
  switch (gameId) {
    case 'rush': return `🤝 ${m.good} referrals · ⭐ ${m.golden} golden · 👻 ${m.ghost} ghosts`;
    case 'reflex': return `Average ${m.avgMs} ms · Best ${m.bestMs} ms${m.falseStarts ? ` · ${m.falseStarts} early tap${m.falseStarts > 1 ? 's' : ''}` : ''}`;
    case 'memory': return m.completed ? `${m.moves} moves in ${Math.round(m.timeMs / 1000)} seconds` : `${m.pairs}/8 pairs — time ran out!`;
    case 'colors': return `${m.correct} right · ${m.wrong} wrong`;
    case 'quiz': return `${m.correct} of ${m.total} correct`;
    case 'pictionary': return `${m.correct} of ${m.total} professions guessed`;
    case 'simon': return m.level ? `Sequence of ${m.level} completed` : 'Slipped on the first pad — next time!';
    case 'odd': return `${m.correct} spotted · ${m.wrong} wrong`;
    default: return '';
  }
}

function showResult(g, r) {
  const s = S.settings;
  const canReplay = r.attemptsLeft !== 0 && s.playOpen && s.enabledGames.includes(g.id);
  const leftText = r.attemptsLeft === null ? '' : ` (${r.attemptsLeft} left)`;
  $('#view-result').innerHTML = `
    <div class="card result">
      <div class="result-emoji">${g.emoji}</div>
      <div class="eyebrow">${esc(g.name)}</div>
      <div class="result-score" id="res-score" data-value="0">0</div>
      <div class="result-sub">points</div>
      ${r.isBest ? '<div class="badge-best">🎉 New personal best!</div>' : `<p class="fine">Your best: <b>${fmt(r.best)}</b></p>`}
      <p class="result-meta">${esc(metaLine(g.id, r.meta))}</p>
      <div class="result-stats">
        <div><span>Total score</span><b>${fmt(r.total)}</b></div>
        <div><span>Rank</span><b>${r.rank ? `#${r.rank}` : '🤫'}</b></div>
      </div>
      <div class="result-actions">
        <button class="btn btn-primary btn-lg" id="hub-btn">Back to games</button>
        ${canReplay ? `<button class="btn btn-ghost" id="again-btn">↻ Play again${leftText}</button>` : ''}
      </div>
    </div>`;
  show('result');
  countUp($('#res-score'), r.score, 1100, 0);
  if (r.isBest && r.score > 0) {
    setTimeout(() => {
      sfx.win();
      confetti({ duration: 1800, count: 120 });
    }, 900);
  }
  const refreshed = refreshMe().catch(() => {});
  $('#hub-btn').onclick = async () => {
    await refreshed;
    if (!S.me) return;
    renderHub();
    show('hub');
  };
  const again = $('#again-btn');
  if (again) {
    again.onclick = async () => {
      await refreshed;
      renderHub();
      show('hub');
      openGame(g.id);
    };
  }
}

// ------------------------------------------------------------------ realtime

function connect() {
  if (socket) socket.disconnect();
  socket = connectSocket({ token: getToken() });

  socket.on('settings', (settings) => {
    if (JSON.stringify(settings) === JSON.stringify(S.settings)) return;
    const closedNow = S.settings && S.settings.playOpen && !settings.playOpen;
    const loginChanged = S.settings && S.settings.loginMode !== settings.loginMode;
    S.settings = settings;
    applyTitle();
    if (S.view === 'join' && loginChanged) renderJoin(); // admin switched phone login on/off
    if (S.view === 'hub' && S.me) {
      // Settings like hidden-mode change rank visibility too.
      refreshMe().then(renderHub).catch(() => renderHub());
    }
    if (closedNow && S.view !== 'game') toast('⏸ Games are now closed');
  });

  socket.on('me', (live) => {
    if (!S.me) return;
    const before = { rank: S.me.rank };
    Object.assign(S.me, live);
    nudge(before);
    if (S.view === 'hub') patchHubLive();
    else if (S.view === 'tap') updateTap();
    // Our team arrived while a round is on (teams were dealt after we joined) → straight in.
    if (S.me.team && roundActive() && (S.view === 'hub' || S.view === 'result')) enterTap();
  });

  socket.on('round', onRound);
  socket.on('livequiz', onLiveQuestion);
  socket.on('luckydraw', onLuckyDraw);

  socket.on('reset', () => {
    if (getToken()) signedOut('The event was reset — please join again');
  });

  socket.on('scoresReset', () => {
    if (!S.me) return;
    toast('↺ Scores were reset — fresh start for everyone!', 5000);
    if (S.view !== 'game') backToHub(); // a game in progress just finishes and lands on the hub
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    const st = await api('/api/state');
    S.settings = st.settings;
    S.games = st.games;
  } catch {
    $('#boot-msg').innerHTML = 'Can’t reach the game server.<br><br><button class="btn btn-primary" onclick="location.reload()">Try again</button>';
    $('#view-boot .spinner').remove();
    return;
  }
  applyTitle();
  if (getToken()) {
    try {
      await refreshMe();
      renderHub();
      show('hub');
    } catch (err) {
      if (err.status === 401) {
        clearToken();
        renderJoin();
        show('join');
      } else {
        $('#boot-msg').textContent = err.message;
        return;
      }
    }
  } else {
    renderJoin();
    show('join');
  }
  connect();
}

// The hub's team card is re-rendered live, so its button is handled here rather than wired each time.
$('#view-hub').addEventListener('click', (e) => {
  if (e.target.closest('#team-join')) enterTap();
});

boot();
