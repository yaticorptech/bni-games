#!/usr/bin/env node
/**
 * Rehearsal: fake guests join and play every game through the real API, at real speed,
 * so you can watch the big screen and test the reveal before the event.
 *
 *   npm run simulate                      # 20 players against http://localhost:8110
 *   npm run simulate -- --players 40 --url http://192.168.1.5:8110
 *   npm run simulate -- --admin <password>   # event has a guest list: the bots log in as listed guests
 *
 * Afterwards clear the fake scores from /admin → "Reset scores" (guests stay logged in).
 */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = String(arg('url', process.env.URL || `http://localhost:${process.env.PORT || 8110}`)).replace(/\/$/, '');
const PLAYERS = Number(arg('players', 20));
const ADMIN = arg('admin', process.env.ADMIN_PASSWORD || '');

const FIRST = ['Priya', 'Rahul', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Kavya', 'Rohan', 'Meera', 'Aditya', 'Divya', 'Karan', 'Pooja', 'Suresh', 'Neha', 'Manish', 'Lakshmi', 'Imran', 'Farah', 'Deepak', 'Anil', 'Shreya', 'Gaurav', 'Nisha'];
const LAST = ['Sharma', 'Rao', 'Iyer', 'Reddy', 'Patel', 'Nair', 'Gupta', 'Menon', 'Shetty', 'Khan', 'Joshi', 'Kulkarni', 'Hegde', 'Bhat'];
const BIZ = ['Interior Designer', 'Chartered Accountant', 'Real Estate', 'Digital Marketing', 'Insurance Advisor', 'Event Planner', 'Architect', 'Photographer', 'IT Services', 'Caterer', 'Lawyer', 'Printing', 'Travel Agent', 'Dentist', 'Fitness Coach'];
const CHAPTERS = ['BNI Titans', 'BNI Achievers', 'BNI Visionaries'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const int = (lo, hi) => Math.round(rand(lo, hi));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', body, token, admin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = ADMIN;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`);
  return data;
}

/** Roughly what the server will score `result` — only for the running-score stream. */
function estimate(gameId, r) {
  const clamp = (n) => Math.max(0, Math.min(1000, Math.round(n)));
  switch (gameId) {
    case 'rush': return clamp(r.good * 20 + r.golden * 50 - r.ghost * 15);
    case 'reflex': return clamp(r.times.reduce((s, t) => s + Math.max(0, Math.min(200, (650 - t) / 2.5)), 0) - r.falseStarts * 25);
    case 'memory': return clamp(1000 - Math.max(0, r.moves - 8) * 20 - Math.max(0, r.timeMs / 1000 - 20) * 5);
    case 'colors': return clamp(r.correct * 30 - r.wrong * 15);
    case 'simon': return clamp(r.level <= 5 ? r.level * 80 : 400 + (r.level - 5) * 120);
    case 'odd': return clamp(r.correct * 35 - r.wrong * 15);
    default: return 0;
  }
}

/** Plausible stats for a player with skill 0..1, plus how long the "game" takes. */
function fake(gameId, skill) {
  switch (gameId) {
    case 'rush':
      return { wait: 33500, result: { good: int(14 + 20 * skill, 20 + 22 * skill), golden: int(0, 1 + 3 * skill), ghost: int(0, 6 * (1.1 - skill)) } };
    case 'reflex':
      return { wait: int(11000, 16000), result: { times: Array.from({ length: 5 }, () => int(440 - 190 * skill, 520 - 180 * skill)), falseStarts: Math.random() < 0.2 ? 1 : 0 } };
    case 'memory': {
      const timeMs = int(70000 - 42000 * skill, 85000 - 40000 * skill);
      return { wait: timeMs + 3500, result: { pairs: 8, moves: int(26 - 13 * skill, 32 - 14 * skill), timeMs } };
    }
    case 'colors':
      return { wait: 33500, result: { correct: int(12 + 18 * skill, 16 + 20 * skill), wrong: int(0, 5 * (1.2 - skill)) } };
    case 'simon': {
      const level = int(3 + 5 * skill, 5 + 7 * skill);
      return { wait: level * (level + 1) * 300 + 2500, result: { level } };
    }
    case 'odd':
      return { wait: 33500, result: { correct: int(10 + 14 * skill, 16 + 14 * skill), wrong: int(0, 4 * (1.1 - skill)) } };
    default:
      throw new Error(`no fake for ${gameId}`);
  }
}

async function play(p, gameId) {
  const start = await call(`/api/games/${gameId}/start`, { method: 'POST', token: p.token });
  const finish = (result) => call(`/api/attempts/${start.attemptId}/finish`, { method: 'POST', token: p.token, body: { result } });
  if (steppedGames.has(gameId)) {
    // Quiz-style games are played question by question against the server.
    await sleep(3000);
    for (;;) {
      const q = await call(`/api/attempts/${start.attemptId}/quiz/next`, { method: 'POST', token: p.token });
      if (q.done) break;
      await sleep(rand(1200, 6000));
      // The sim cannot see the answers (they never leave the server), so it guesses.
      const a = await call(`/api/attempts/${start.attemptId}/quiz/answer`, { method: 'POST', token: p.token, body: { index: q.index, choice: int(0, q.options.length - 1) } });
      await sleep(1400);
      if (a.done) break;
    }
    return finish({});
  }
  const { wait, result } = fake(gameId, p.skill);
  // Stream a rising running score meanwhile, like a phone does, so the big screen moves during the game.
  const target = estimate(gameId, result);
  const t0 = Date.now();
  while (Date.now() - t0 < wait) {
    await sleep(Math.min(1500, wait - (Date.now() - t0)));
    const frac = Math.min(1, (Date.now() - t0) / wait);
    await call(`/api/attempts/${start.attemptId}/progress`, { method: 'POST', token: p.token, body: { score: Math.round(target * frac) } }).catch(() => {});
  }
  return finish(result);
}

let settings = {}; // from /api/state
let roster = null; // the guest list, when the event uses phone login
const steppedGames = new Set(); // games played question by question (quiz, pictionary)

// Hosted moments: one poller watches for a running Team Tap Battle round and an open Live
// Quiz question; every bot then taps at a human pace, or answers (a guess) after a pause.
let roundRunning = false;
let openQuestion = null;
async function watchHosted() {
  for (;;) {
    try {
      roundRunning = (await call('/api/round')).status === 'running';
      const q = await call('/api/livequiz');
      openQuestion = q.status === 'open' ? q : null;
    } catch {
      roundRunning = false;
      openQuestion = null;
    }
    await sleep(400);
  }
}
async function tapLoop(p) {
  let answeredNo = 0;
  for (;;) {
    if (openQuestion && openQuestion.no !== answeredNo) {
      const q = openQuestion;
      answeredNo = q.no;
      setTimeout(() => call('/api/livequiz/answer', { method: 'POST', token: p.token, body: { choice: int(0, q.options.length - 1) } }).catch(() => {}), int(800, Math.min(q.limitMs, 9000)));
    }
    if (roundRunning) {
      await call('/api/tap', { method: 'POST', token: p.token, body: { n: int(1, 3) } }).catch(() => {});
      await sleep(int(200, 320));
    } else await sleep(400);
  }
}

async function guest(i) {
  await sleep(i * rand(1200, 3000)); // people trickle in
  const chapter = settings.chapters?.length ? pick(settings.chapters) : pick(CHAPTERS);
  const body = roster
    ? { phone: roster[i % roster.length].phones[0], chapter }
    : { name: `${pick(FIRST)} ${pick(LAST)}`, business: pick(BIZ), chapter };
  const { token, player } = await call('/api/join', { method: 'POST', body });
  const name = player.name;
  const p = { name, token, skill: Math.random() };
  console.log(`+ ${name} ${roster ? 'logged in' : 'joined'} (skill ${p.skill.toFixed(2)})`);
  tapLoop(p);
  const { games } = await call('/api/state');
  games.filter((g) => g.stepped).forEach((g) => steppedGames.add(g.id));
  const order = games.filter((g) => !g.hosted).map((g) => g.id).sort(() => Math.random() - 0.5); // the Live Quiz is the host's call
  if (Math.random() < 0.5) order.push(pick(order)); // some retry a game
  for (const gameId of order) {
    try {
      const r = await play(p, gameId);
      console.log(`  ${name.padEnd(18)} ${gameId.padEnd(7)} ${String(r.score).padStart(4)}  → total ${r.total}${r.rank ? `  #${r.rank}` : ''}`);
    } catch (err) {
      console.log(`  ${name}: ${err.message}`);
    }
    await sleep(rand(1000, 5000));
  }
}

(async () => {
  try {
    ({ settings } = await call('/api/state'));
  } catch {
    console.error(`Can't reach ${BASE} — is the server running (npm start)?`);
    process.exit(1);
  }
  let players = PLAYERS;
  if (settings.loginMode === 'phone') {
    if (!ADMIN) {
      console.error('This event has a guest list, so players log in by phone. Add --admin <admin password> and the bots will log in as the listed guests.');
      process.exit(1);
    }
    try {
      roster = (await call('/api/admin/overview', { admin: true })).settings.roster;
    } catch (err) {
      console.error(`Could not read the guest list: ${err.message}`);
      process.exit(1);
    }
    players = Math.min(PLAYERS, roster.length);
    console.log(`Guest list has ${roster.length} guests — the bots will play as the first ${players}.`);
  }
  console.log(`Simulating ${players} guests against ${BASE} — watch ${BASE}/screen\n`);
  watchHosted();
  await Promise.all(Array.from({ length: players }, (_, i) => guest(i)));
  console.log('\nDone playing. The bots keep tapping in any Team Tap Battle round and guessing in any Live Quiz question you start — press Ctrl+C to stop them.');
  console.log('Remember to press Reset scores in /admin before guests arrive.');
})();
