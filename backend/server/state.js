/**
 * All event state lives in memory (fast, and plenty for a few hundred players) and is
 * persisted through the store. Emits:
 *   'change'   – scores/players changed → realtime layer re-broadcasts the leaderboard
 *   'settings' – public settings changed
 *   'activity' – a game was finished (for the big-screen feed)
 *   'reveal'   – admin started the grand reveal
 *   'reset'    – event wiped
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('./config');
const { GAMES, GAME_MAP, publicGames, quizRuntime, MAX } = require('./games');
const { HttpError, id, token, clean, csvCell, shuffle } = require('./util');

const ATTEMPT_TTL_MS = 15 * 60 * 1000;
const SCREEN_TOP = 10;
const LIVE_TOP = 5;
const REVEAL_SIZES = [3, 5, 10, 15];
const LIVE_STALE_MS = 60000; // a game in progress that has gone quiet this long (phones re-send every 15 s) drops off the board

// Team Tap Battle: everyone is dealt into teams, then rounds of frantic tapping.
const TEAM_PALETTE = [
  { name: 'Red', color: '#e3263a', emoji: '🔴' },
  { name: 'Blue', color: '#3b82f6', emoji: '🔵' },
  { name: 'Green', color: '#22c55e', emoji: '🟢' },
  { name: 'Yellow', color: '#f7c548', emoji: '🟡' },
  { name: 'Purple', color: '#a855f7', emoji: '🟣' },
  { name: 'Orange', color: '#f97316', emoji: '🟠' },
];
const TAP_COUNTDOWN_MS = 3500; // 3-2-1-GO on every phone before taps count
const TAP_DURATIONS = [15000, 30000, 45000, 60000];
const TAP_MAX_PER_SEC = 15; // two thumbs manage ~12/s; anything faster is an auto-clicker
const TAP_TICK_MS = 200; // live update rate while a round runs

// Live Quiz: the host asks a question on the big screen, everyone answers on their phone.
const LIVE_LIMITS = [10000, 15000, 20000, 30000];
const LIVE_GRACE_MS = 1500; // network allowance after the timer hits zero

// Avatars players can pick for the big screen.
const EMOJIS = ['🦁', '🐯', '🦊', '🐼', '🐨', '🦄', '🐸', '🐙', '🦋', '🌟', '🔥', '⚡', '🚀', '🎯', '🏆', '💎', '🍕', '☕', '🎸', '🎲', '🧠', '💼', '🤝', '😎'];
const validEmoji = (e) => (EMOJIS.includes(e) ? e : '');

const defaultSettings = () => ({
  eventTitle: config.defaultTitle,
  tagline: 'Play · Score · Win the night!',
  playOpen: true,
  screenMode: 'live', // live | hidden | reveal
  revealCount: 10,
  attemptsPerGame: 3, // 0 = unlimited; best score per game counts
  enabledGames: GAMES.map((g) => g.id),
  chapters: [], // optional fixed list → shown as a dropdown on the join form
  roster: [], // guest list [{ name, phones: ['9876543210', …] }]; while non-empty, players log in by phone
  teams: [], // Team Tap Battle teams [{ id, name, color, emoji }], dealt at random from Admin
  teamScores: {}, // teamId → taps across all rounds
  teamRounds: [], // finished rounds [{ no, at, durationMs, taps: {teamId: n}, ranking, tie, tappers }]
  knownGames: GAMES.map((g) => g.id), // so games added later can be switched on automatically
  liveQuiz: [], // host's questions [{ q, options, answer (null = vote), askedAt }]
  liveAsked: [], // indexes of questions asked so far, in order
  luckyDraws: [], // [{ no, playerId, name, emoji, at }]
  reveal: null, // { at, entries } snapshot taken when the reveal starts
});

const publicPlayer = ({ id, name, emoji, business, chapter, teamId }) => ({ id, name, emoji: emoji || '', business, chapter, teamId: teamId || null });
const publicRow = ({ rank, id, name, emoji, business, chapter, total, scores, live }) => ({ rank, id, name, emoji: emoji || '', business, chapter, total, scores, live: live || null });

/** A 10-digit Indian mobile number however it was typed (+91, spaces, dashes, a leading 0), else null. */
function normalizePhone(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

// A mobile number inside free text: optional +91 / 0, then 10 digits that may be split by
// single spaces or dashes, and not glued to other digits.
const PHONE_IN_TEXT = /(?<!\d)(?:\+?91[\s-]*|0)?([6-9](?:[\s-]?\d){9})(?!\d)/g;

/**
 * Parse a pasted guest list, one guest per line: "Priya Sharma, 9876543210", or a CSV
 * straight from a spreadsheet ("1,Priya Sharma,9876543210"). A guest may have more than
 * one number ("9876543210 / 9123456780"). Lines without a usable name and number (e.g. the
 * header row) are skipped and reported rather than failing the whole save.
 */
function parseRoster(text) {
  const entries = [];
  const skipped = [];
  const owner = new Map(); // phone → guest name, to catch duplicates
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const skip = (reason) => skipped.push({ line: i + 1, text: line.slice(0, 60), reason });
    const phones = [];
    const rest = line.replace(PHONE_IN_TEXT, (_m, num) => {
      const p = num.replace(/\D/g, '');
      if (!phones.includes(p)) phones.push(p);
      return ' ';
    });
    if (!phones.length) return skip('no mobile number');
    const name = rest.split(/[,;\t|/]+/).map((s) => clean(s.replace(/"/g, ''), 40)).find((s) => /\p{L}/u.test(s));
    if (!name) return skip('no name');
    const dupe = phones.find((p) => owner.has(p));
    if (dupe) return skip(`${dupe} is already listed for ${owner.get(dupe)}`);
    phones.forEach((p) => owner.set(p, name));
    entries.push({ name, phones });
  });
  return { entries, skipped };
}

/**
 * Parse the host's live-quiz questions: blocks separated by a blank line, first line the
 * question, then 2–6 options (bullets or A) B) letters optional), the correct one marked
 * with a trailing *. A block with no * is a vote ("Who's most likely to…"):
 *
 *   What is BNI's core philosophy?
 *   - Givers Gain *
 *   - Winner takes all
 */
function parseLiveQuiz(text) {
  const questions = [];
  const skipped = [];
  const blocks = String(text ?? '').split(/\n\s*\n/).map((b) => b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  blocks.forEach((lines, i) => {
    const skip = (reason) => skipped.push({ block: i + 1, text: lines[0].slice(0, 60), reason });
    const q = clean(lines[0].replace(/^(?:Q\s*\d*\s*[.:)]|\d+\s*[.)])\s*/i, ''), 200);
    const options = [];
    let answer = -1;
    for (let line of lines.slice(1)) {
      line = line.replace(/^(?:[-•]|[A-Fa-f]\s*[.):]|\d+\s*[.)])\s*/, '');
      let correct = false;
      if (/^\*\s*/.test(line)) { correct = true; line = line.replace(/^\*\s*/, ''); }
      if (/\s*(?:\*|✓|\(correct\))\s*$/i.test(line)) { correct = true; line = line.replace(/\s*(?:\*|✓|\(correct\))\s*$/i, ''); }
      const opt = clean(line, 80);
      if (!opt) continue;
      if (correct) answer = options.length;
      options.push(opt);
    }
    if (!q || options.length < 2) return skip('needs a question line and at least 2 options');
    if (options.length > 6) return skip('more than 6 options');
    questions.push({ q, options, answer: answer < 0 ? null : answer }); // no * → a vote: no right answer, no points
  });
  return { questions, skipped };
}

class GameState extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.settings = defaultSettings();
    this.players = new Map();
    this.byToken = new Map();
    this.attempts = new Map();
    this.runtimes = new Map(); // attemptId → in-memory game state (quiz questions etc.)
    this.recent = []; // last activity items for a freshly loaded big screen
    this.cache = null;
    this.pending = new Set(); // store writes still in flight (see flush)
    this.liveScores = new Map(); // attemptId → { playerId, gameId, score, at }: running scores of games in progress
    this.cacheConfirmed = null;
    this.round = null; // Team Tap Battle round in progress (in memory only; see startRound)
    this.roundTimers = [];
    this.live = null; // Live Quiz question on the big screen right now (see askLive)
    this.liveTimers = [];
    store.attach(() => this.snapshot());
    setInterval(() => this.sweep(), 60 * 1000).unref();
    setInterval(() => this.sweepLive(), 5 * 1000).unref();
  }

  async load() {
    const data = await this.store.load();
    if (!data) return;
    this.settings = { ...defaultSettings(), ...(data.settings || {}) };
    this.settings.enabledGames = this.settings.enabledGames.filter((g) => GAME_MAP[g]);
    if (this.settings.screenMode === 'reveal' && !this.settings.reveal) this.settings.screenMode = 'hidden';
    this.settings.roster = (Array.isArray(this.settings.roster) ? this.settings.roster : [])
      .filter((g) => g && typeof g.name === 'string' && Array.isArray(g.phones) && g.phones.length);
    const s = this.settings;
    s.teams = (Array.isArray(s.teams) ? s.teams : []).filter((t) => t && t.id && t.name);
    s.teamScores = s.teamScores && typeof s.teamScores === 'object' ? s.teamScores : {};
    s.teamRounds = Array.isArray(s.teamRounds) ? s.teamRounds : [];
    if (!['live', 'hidden', 'reveal'].includes(s.screenMode)) s.screenMode = 'live'; // e.g. the retired 'team' mode
    s.liveQuiz = (Array.isArray(s.liveQuiz) ? s.liveQuiz : []).filter((q) => q && typeof q.q === 'string' && Array.isArray(q.options) && (Number.isInteger(q.answer) || q.answer === null));
    // Games added in an update start enabled, without undoing games the admin switched off.
    const saved = data.settings || {};
    const known = new Set(Array.isArray(saved.knownGames) ? saved.knownGames : ['rush', 'reflex', 'memory', 'colors', 'quiz']);
    let added = false;
    for (const g of GAMES) {
      if (known.has(g.id)) continue;
      known.add(g.id);
      if (!s.enabledGames.includes(g.id)) s.enabledGames.push(g.id);
      added = true;
    }
    s.knownGames = [...known];
    if (added) this.persist('saveSettings', s);
    s.liveAsked = (Array.isArray(s.liveAsked) ? s.liveAsked : []).filter((i) => Number.isInteger(i) && s.liveQuiz[i]);
    s.luckyDraws = Array.isArray(s.luckyDraws) ? s.luckyDraws : [];
    for (const p of this.players.values()) p.emoji = validEmoji(p.emoji);
    for (const p of data.players || []) {
      this.players.set(p.id, p);
      this.byToken.set(p.token, p);
    }
    for (const a of data.attempts || []) if (this.players.has(a.playerId)) this.attempts.set(a.id, a);
  }

  snapshot() {
    return { version: 1, settings: this.settings, players: [...this.players.values()], attempts: [...this.attempts.values()] };
  }

  persist(op, ...args) {
    const p = Promise.resolve()
      .then(() => this.store[op](...args))
      .catch((err) => console.error(`[store] ${op} failed:`, err.message))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Resolves once every write issued so far has landed — used at shutdown. */
  flush() {
    return Promise.allSettled([...this.pending]);
  }

  changed() {
    this.cache = null;
    this.cacheConfirmed = null;
    this.emit('change');
  }

  /** Drop in-memory runtimes of abandoned games. */
  sweep() {
    const cutoff = Date.now() - ATTEMPT_TTL_MS;
    for (const attemptId of this.runtimes.keys()) {
      const a = this.attempts.get(attemptId);
      if (!a || a.startedAt < cutoff) this.runtimes.delete(attemptId);
    }
  }

  /** Drop running scores that went quiet (phone died or was pocketed mid-game), so the row stops showing "playing". */
  sweepLive() {
    const stale = Date.now() - LIVE_STALE_MS;
    let dropped = false;
    for (const [attemptId, l] of this.liveScores) {
      if (l.at < stale || !this.attempts.has(attemptId)) {
        this.liveScores.delete(attemptId);
        dropped = true;
      }
    }
    if (dropped) this.changed();
  }

  // ------------------------------------------------------------- settings

  publicSettings() {
    const { eventTitle, tagline, playOpen, screenMode, attemptsPerGame, enabledGames, chapters, roster, teams } = this.settings;
    // The list itself never leaves the admin API; phones only learn which login form to show.
    return { eventTitle, tagline, playOpen, screenMode, attemptsPerGame, enabledGames, chapters, teams, emojis: EMOJIS, loginMode: roster.length ? 'phone' : 'open' };
  }

  /** Ranks are secret while the board is hidden or being revealed — the team battle view is not a secret. */
  get hidden() {
    return this.settings.screenMode === 'hidden' || this.settings.screenMode === 'reveal';
  }

  updateSettings(patch = {}) {
    const s = this.settings;
    if ('eventTitle' in patch) s.eventTitle = clean(patch.eventTitle, 80) || s.eventTitle;
    if ('tagline' in patch) s.tagline = clean(patch.tagline, 100);
    if ('playOpen' in patch) s.playOpen = Boolean(patch.playOpen);
    if ('attemptsPerGame' in patch) {
      const n = Number(patch.attemptsPerGame);
      if (!Number.isInteger(n) || n < 0 || n > 50) throw new HttpError(400, 'Attempts must be 0 (unlimited) to 50');
      s.attemptsPerGame = n;
    }
    if ('enabledGames' in patch) {
      if (!Array.isArray(patch.enabledGames)) throw new HttpError(400, 'enabledGames must be a list');
      // Hosted games (Live Quiz) aren't on the switch list and stay on.
      s.enabledGames = GAMES.filter((g) => g.hosted || patch.enabledGames.includes(g.id)).map((g) => g.id);
    }
    if ('chapters' in patch) {
      if (!Array.isArray(patch.chapters)) throw new HttpError(400, 'chapters must be a list');
      s.chapters = [...new Set(patch.chapters.map((c) => clean(c, 40)).filter(Boolean))].slice(0, 100);
    }
    if ('screenMode' in patch) {
      if (!['live', 'hidden'].includes(patch.screenMode)) throw new HttpError(400, 'Screen mode must be live or hidden');
      s.screenMode = patch.screenMode;
    }
    this.persist('saveSettings', s);
    this.emit('settings', this.publicSettings());
    this.changed();
    return s;
  }

  startReveal(count) {
    const n = REVEAL_SIZES.includes(Number(count)) ? Number(count) : 10;
    const board = this.board(false); // confirmed scores only — nothing provisional in the reveal
    if (!board.ranked.length) throw new HttpError(400, 'Nobody has scored yet — nothing to reveal');
    Object.assign(this.settings, {
      screenMode: 'reveal',
      revealCount: n,
      reveal: { at: Date.now(), entries: board.ranked.slice(0, n).map(publicRow) },
    });
    this.persist('saveSettings', this.settings);
    this.emit('reveal', this.settings.reveal);
    this.emit('settings', this.publicSettings());
    this.changed();
    return this.settings.reveal;
  }

  // ------------------------------------------------------------- players

  playerByToken(t) {
    return (t && this.byToken.get(t)) || null;
  }

  join(body = {}) {
    const chapter = clean(body.chapter, 40);
    if (this.settings.chapters.length && chapter && !this.settings.chapters.includes(chapter)) {
      throw new HttpError(400, 'Please pick your chapter from the list');
    }
    const emoji = validEmoji(body.emoji);
    if (this.settings.roster.length) return this.loginByPhone(body.phone, chapter, emoji);
    const name = clean(body.name, 40);
    if (name.length < 2) throw new HttpError(400, 'Please enter your name');
    return this.addPlayer({ name, business: clean(body.business, 60), chapter, emoji });
  }

  setEmoji(player, emoji) {
    player.emoji = validEmoji(emoji);
    this.persist('savePlayer', player);
    this.changed(); // the board shows avatars
  }

  /**
   * Guest-list mode: the number must be on the list. Logging in again (another phone, a
   * cleared browser) returns the same player, so their scores carry on.
   */
  loginByPhone(phone, chapter, emoji = '') {
    const p = normalizePhone(phone);
    if (!p) throw new HttpError(400, 'Please enter your 10-digit mobile number');
    const guest = this.settings.roster.find((g) => g.phones.includes(p));
    if (!guest) throw new HttpError(403, 'This number isn’t on the guest list — please check with the organiser', 'NOT_INVITED');
    const key = guest.phones[0]; // a guest with two numbers is still one player
    const existing = [...this.players.values()].find((x) => x.phone === key);
    if (!existing) return this.addPlayer({ name: guest.name, business: '', chapter, phone: key, emoji });
    // Pick up a name corrected on the list, or a chapter / avatar chosen on this login.
    let dirty = false;
    if (existing.name !== guest.name) { existing.name = guest.name; dirty = true; }
    if (chapter && existing.chapter !== chapter) { existing.chapter = chapter; dirty = true; }
    if (emoji && existing.emoji !== emoji) { existing.emoji = emoji; dirty = true; }
    if (this.autoTeam(existing)) dirty = true;
    if (dirty) {
      this.persist('savePlayer', existing);
      this.changed();
    }
    return existing;
  }

  addPlayer({ name, business, chapter, phone = '', emoji = '' }) {
    const p = { id: id(), token: token(), name, emoji, business, chapter, phone, createdAt: Date.now() };
    this.autoTeam(p);
    this.players.set(p.id, p);
    this.byToken.set(p.token, p);
    this.persist('savePlayer', p);
    this.changed();
    return p;
  }

  /** Replace the guest list from pasted text. Returns what was saved and which lines were skipped. */
  saveRoster(text) {
    if (typeof text !== 'string') throw new HttpError(400, 'Send the guest list as text');
    const { entries, skipped } = parseRoster(text);
    if (entries.length > 1000) throw new HttpError(400, 'The guest list can hold up to 1000 guests');
    this.settings.roster = entries;
    this.persist('saveSettings', this.settings);
    this.emit('settings', this.publicSettings()); // phones switch between name and phone login
    this.changed();
    return { count: entries.length, phones: entries.reduce((n, g) => n + g.phones.length, 0), skipped };
  }

  deletePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) throw new HttpError(404, 'Player not found');
    this.players.delete(p.id);
    this.byToken.delete(p.token);
    for (const [aid, a] of this.attempts) {
      if (a.playerId === p.id) {
        this.attempts.delete(aid);
        this.runtimes.delete(aid);
        this.liveScores.delete(aid);
      }
    }
    this.recent = this.recent.filter((r) => r.playerId !== p.id);
    this.persist('deletePlayer', p.id);
    this.changed();
  }

  /**
   * Fresh scoreboard, same guests: every score, team round, lucky-draw winner and quiz
   * progress goes; players stay logged in (teams and avatars included). For after a rehearsal.
   */
  resetScores() {
    this.attempts.clear();
    this.runtimes.clear();
    this.liveScores.clear();
    this.recent = [];
    Object.assign(this.settings, { screenMode: 'live', reveal: null, playOpen: true, teamScores: {}, teamRounds: [], liveAsked: [], luckyDraws: [] });
    for (const q of this.settings.liveQuiz) delete q.askedAt;
    this.endRoundTimers();
    this.round = null;
    this.emit('round', this.roundPayload());
    this.endLiveTimers();
    this.live = null;
    this.emit('livequiz', this.liveQuizPayload());
    this.persist('resetAttempts');
    this.persist('saveSettings', this.settings);
    this.emit('scoresReset');
    this.emit('settings', this.publicSettings());
    this.changed();
  }

  /** Wipe the event: players too. Settings, the guest list and quiz questions stay. */
  reset() {
    this.players.clear();
    this.byToken.clear();
    this.attempts.clear();
    this.runtimes.clear();
    this.liveScores.clear();
    this.recent = [];
    Object.assign(this.settings, { screenMode: 'live', reveal: null, playOpen: true, teams: [], teamScores: {}, teamRounds: [], liveAsked: [], luckyDraws: [] });
    for (const q of this.settings.liveQuiz) delete q.askedAt; // keep the questions, let them be asked again
    this.endRoundTimers();
    this.round = null;
    this.emit('round', this.roundPayload());
    this.endLiveTimers();
    this.live = null;
    this.emit('livequiz', this.liveQuizPayload());
    this.persist('reset');
    this.persist('saveSettings', this.settings);
    this.emit('reset');
    this.emit('settings', this.publicSettings());
    this.changed();
  }

  usedAttempts(playerId) {
    const used = Object.fromEntries(GAMES.map((g) => [g.id, 0]));
    for (const a of this.attempts.values()) if (a.playerId === playerId) used[a.gameId]++;
    return used;
  }

  attemptsLeft(used) {
    const limit = this.settings.attemptsPerGame;
    return limit > 0 ? Math.max(0, limit - used) : null;
  }

  me(player) {
    const row = this.board().rankById.get(player.id);
    const used = this.usedAttempts(player.id);
    const games = {};
    for (const g of GAMES) {
      games[g.id] = { best: row?.scores[g.id] ?? null, used: used[g.id], left: this.attemptsLeft(used[g.id]) };
    }
    return { player: publicPlayer(player), games, ...this.livePayload(player.id) };
  }

  /** The small per-player live update pushed to phones. */
  livePayload(playerId) {
    const board = this.board();
    const row = board.rankById.get(playerId);
    return {
      total: row?.total ?? 0,
      rank: this.hidden ? null : row?.rank ?? null,
      ranked: board.ranked.length,
      hidden: this.hidden,
      top: this.hidden ? [] : board.ranked.slice(0, LIVE_TOP).map(publicRow),
      team: this.teamOf(this.players.get(playerId)),
      // The player one place above — phones use it for "Priya just overtook you" nudges.
      above: !this.hidden && row && row.rank > 1 ? (({ name, emoji, total }) => ({ name, emoji, total }))(board.ranked[row.rank - 2]) : null,
    };
  }

  // ------------------------------------------------------------- playing

  ownAttempt(player, attemptId) {
    const a = this.attempts.get(attemptId);
    if (!a || a.playerId !== player.id) throw new HttpError(404, 'Game not found');
    return a;
  }

  startAttempt(player, gameId) {
    const game = GAME_MAP[gameId];
    if (!game) throw new HttpError(404, 'Unknown game');
    if (game.hosted) throw new HttpError(403, 'This one is hosted on the big screen — join in when the organiser starts it', 'HOSTED');
    if (!this.settings.playOpen) throw new HttpError(403, 'Games are closed right now', 'CLOSED');
    if (!this.settings.enabledGames.includes(gameId)) throw new HttpError(403, 'This game is closed right now', 'CLOSED');
    const used = this.usedAttempts(player.id)[gameId];
    const left = this.attemptsLeft(used);
    if (left === 0) throw new HttpError(403, 'No tries left for this game', 'NO_ATTEMPTS');

    const { runtime, payload } = game.start ? game.start() : {};
    const a = { id: id(12), playerId: player.id, gameId, startedAt: Date.now(), finishedAt: null, score: null, meta: null, pb: false };
    this.attempts.set(a.id, a);
    if (runtime) this.runtimes.set(a.id, runtime);
    this.persist('saveAttempt', a);
    return { attemptId: a.id, gameId, attemptsLeft: left === null ? null : left - 1, payload: payload || null };
  }

  /** One step of a server-run question game (quiz, pictionary): 'next' serves a question, 'answer' grades one. */
  quizStep(player, attemptId, step, body) {
    const a = this.ownAttempt(player, attemptId);
    const game = GAME_MAP[a.gameId];
    if (!game?.steps || a.score != null) throw new HttpError(409, 'This game is already finished');
    const rt = this.runtimes.get(a.id);
    if (!rt) {
      // Server restarted mid-game: give the try back instead of burning it.
      this.attempts.delete(a.id);
      this.persist('deleteAttempt', a.id);
      quizRuntime(rt); // throws "expired"
    }
    return game.steps[step](rt, body);
  }

  finishAttempt(player, attemptId, result) {
    const a = this.ownAttempt(player, attemptId);
    if (a.score != null) return this.summary(player, a); // retry after a dropped response
    const elapsedMs = Date.now() - a.startedAt;
    if (elapsedMs > ATTEMPT_TTL_MS) throw new HttpError(410, 'This game session expired', 'EXPIRED');
    const game = GAME_MAP[a.gameId];
    if (elapsedMs < game.minMs) throw new HttpError(400, 'That finished suspiciously fast', 'BAD_RESULT');
    if (game.start && !this.runtimes.has(a.id)) {
      this.attempts.delete(a.id); // server restarted mid-game: refund the try
      this.persist('deleteAttempt', a.id);
      throw new HttpError(410, 'This game session expired — please start again', 'EXPIRED');
    }

    const { score, meta } = game.score(result && typeof result === 'object' ? result : {}, {
      elapsedMs,
      runtime: this.runtimes.get(a.id),
    });
    const prevBest = this.board(false).rankById.get(player.id)?.scores[a.gameId];
    Object.assign(a, { score: Math.round(score), meta, finishedAt: Date.now(), pb: prevBest == null || score > prevBest });
    this.runtimes.delete(a.id);
    this.liveScores.delete(a.id); // the confirmed score takes over from the running one
    this.persist('saveAttempt', a);
    this.changed();

    const item = {
      playerId: player.id,
      name: player.name,
      gameId: a.gameId,
      score: a.score,
      improved: prevBest != null && a.score > prevBest,
      at: a.finishedAt,
    };
    this.recent.unshift(item);
    this.recent.length = Math.min(this.recent.length, 12);
    this.emit('activity', item);
    return this.summary(player, a);
  }

  /**
   * A phone reports the running score of a game in progress. Purely provisional — it moves
   * the big screen while people play; the real score is computed in finishAttempt.
   */
  progress(playerId, attemptId, score) {
    const a = this.attempts.get(attemptId);
    if (!a || a.playerId !== playerId || a.score != null) return;
    if (score === null) {
      // The player quit: take the provisional score off the board straight away.
      if (this.liveScores.delete(attemptId)) this.changed();
      return;
    }
    const game = GAME_MAP[a.gameId];
    const s = Number(score);
    if (!game || game.hosted || !Number.isFinite(s)) return;
    const value = Math.max(0, Math.min(MAX, Math.round(s)));
    const prev = this.liveScores.get(attemptId);
    if (prev && prev.score === value) {
      prev.at = Date.now(); // heartbeat: still playing, nothing new to show
      return;
    }
    this.liveScores.set(attemptId, { playerId, gameId: a.gameId, score: value, at: Date.now() });
    this.changed();
  }

  summary(player, a) {
    const row = this.board().rankById.get(player.id);
    const used = this.usedAttempts(player.id)[a.gameId];
    return {
      gameId: a.gameId,
      score: a.score,
      meta: a.meta,
      isBest: a.pb,
      best: row?.scores[a.gameId] ?? a.score,
      total: row?.total ?? 0,
      rank: this.hidden ? null : row?.rank ?? null,
      ranked: this.board().ranked.length,
      attemptsLeft: this.attemptsLeft(used),
    };
  }

  // ------------------------------------------------------------- team tap battle

  teamOf(player) {
    return (player && player.teamId && this.settings.teams.find((t) => t.id === player.teamId)) || null;
  }

  teamSizes() {
    const sizes = Object.fromEntries(this.settings.teams.map((t) => [t.id, 0]));
    for (const p of this.players.values()) if (p.teamId in sizes) sizes[p.teamId]++;
    return sizes;
  }

  /** Once teams exist, a newcomer joins the smallest one so nobody sits out the battle. */
  autoTeam(player) {
    if (!this.settings.teams.length || this.teamOf(player)) return false;
    const sizes = this.teamSizes();
    player.teamId = this.settings.teams.reduce((best, t) => (sizes[t.id] < sizes[best.id] ? t : best)).id;
    return true;
  }

  /** Deal everyone who has logged in into `count` equal teams. Replaces existing teams and their scores. */
  makeTeams(count) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 2 || n > TEAM_PALETTE.length) throw new HttpError(400, `Choose 2 to ${TEAM_PALETTE.length} teams`);
    if (this.roundActive()) throw new HttpError(409, 'A round is running — wait for it to finish');
    const players = [...this.players.values()];
    if (players.length < n) {
      throw new HttpError(400, players.length ? `Only ${players.length} ${players.length === 1 ? 'person has' : 'people have'} logged in — not enough for ${n} teams` : 'Nobody has logged in yet');
    }
    const teams = TEAM_PALETTE.slice(0, n).map((t, i) => ({ id: `t${i + 1}`, ...t }));
    shuffle(players).forEach((p, i) => {
      p.teamId = teams[i % n].id;
      this.persist('savePlayer', p);
    });
    this.endRoundTimers();
    this.round = null;
    Object.assign(this.settings, { teams, teamScores: {}, teamRounds: [] });
    this.persist('saveSettings', this.settings);
    this.emit('settings', this.publicSettings());
    this.emit('round', this.roundPayload());
    this.changed(); // phones learn their team through the live update
    return this.teamSummary();
  }

  roundActive() {
    return Boolean(this.round && this.round.status !== 'ended');
  }

  roundPayload() {
    const r = this.round;
    const now = Date.now();
    if (!r) return { status: 'idle', serverNow: now };
    return {
      status: r.status,
      no: r.no,
      durationMs: r.durationMs,
      countdownMs: Math.max(0, r.startsAt - now),
      remainingMs: Math.max(0, r.endsAt - now),
      taps: r.taps,
      ranking: r.ranking || null,
      tie: Boolean(r.tie),
      tappers: r.status === 'ended' ? r.byPlayer.size : undefined,
      serverNow: now,
    };
  }

  /** Admin starts a round: a 3½ s countdown on every phone, then `durationMs` of tapping. The big screen shows the battle over the live board. */
  startRound(durationMs) {
    const dur = TAP_DURATIONS.includes(Number(durationMs)) ? Number(durationMs) : 30000;
    if (!this.settings.teams.length) throw new HttpError(400, 'Make the teams first');
    if (this.roundActive()) throw new HttpError(409, 'A round is already running');
    // Anyone who joined before the teams were dealt gets one now.
    for (const p of this.players.values()) if (this.autoTeam(p)) this.persist('savePlayer', p);
    this.endRoundTimers();
    const now = Date.now();
    this.round = {
      status: 'countdown',
      no: this.settings.teamRounds.length + 1,
      durationMs: dur,
      startsAt: now + TAP_COUNTDOWN_MS,
      endsAt: now + TAP_COUNTDOWN_MS + dur,
      taps: Object.fromEntries(this.settings.teams.map((t) => [t.id, 0])),
      byPlayer: new Map(),
      dirty: false,
    };
    this.changed();
    this.emit('round', this.roundPayload());
    this.roundTimers.push(setTimeout(() => this.roundRunning(), TAP_COUNTDOWN_MS));
    this.roundTimers.push(setTimeout(() => this.finishRound(), TAP_COUNTDOWN_MS + dur));
    this.roundTimers.push(setInterval(() => {
      if (this.round && this.round.dirty) {
        this.round.dirty = false;
        this.emit('round', this.roundPayload());
      }
    }, TAP_TICK_MS));
    return this.roundPayload();
  }

  roundRunning() {
    if (!this.round || this.round.status !== 'countdown') return;
    this.round.status = 'running';
    this.emit('round', this.roundPayload());
  }

  endRoundTimers() {
    for (const t of this.roundTimers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.roundTimers = [];
  }

  finishRound() {
    const r = this.round;
    if (!r || r.status === 'ended') return;
    this.endRoundTimers();
    r.status = 'ended';
    r.ranking = [...this.settings.teams].sort((a, b) => r.taps[b.id] - r.taps[a.id]).map((t) => t.id);
    r.tie = r.ranking.length > 1 && r.taps[r.ranking[0]] === r.taps[r.ranking[1]];
    for (const [teamId, n] of Object.entries(r.taps)) this.settings.teamScores[teamId] = (this.settings.teamScores[teamId] || 0) + n;
    this.settings.teamRounds.push({ no: r.no, at: Date.now(), durationMs: r.durationMs, taps: { ...r.taps }, ranking: r.ranking, tie: r.tie, tappers: r.byPlayer.size });
    this.persist('saveSettings', this.settings);
    this.emit('round', this.roundPayload());
    this.changed(); // the screen payload carries the standings
  }

  /** Taps batched from a phone. Counted only while the round runs, only for team members, and capped at a human rate. */
  tap(playerId, n) {
    const r = this.round;
    const count = Number(n);
    if (!r || r.status !== 'running' || !Number.isInteger(count) || count < 1) return;
    const team = this.teamOf(this.players.get(playerId));
    if (!team) return;
    const now = Date.now();
    if (now > r.endsAt + 500) return;
    const allowed = Math.ceil((now - r.startsAt) / 1000 + 1) * TAP_MAX_PER_SEC;
    const have = r.byPlayer.get(playerId) || 0;
    const add = Math.min(count, 40, Math.max(0, allowed - have));
    if (!add) return;
    r.byPlayer.set(playerId, have + add);
    r.taps[team.id] += add;
    r.dirty = true;
  }

  resetTeamScores() {
    if (this.roundActive()) throw new HttpError(409, 'A round is running — wait for it to finish');
    this.round = null;
    Object.assign(this.settings, { teamScores: {}, teamRounds: [] });
    this.persist('saveSettings', this.settings);
    this.emit('round', this.roundPayload());
    this.changed();
  }

  /** Teams with sizes, totals and round wins (best first), recent rounds, and the current round. */
  teamSummary() {
    const s = this.settings;
    const sizes = this.teamSizes();
    const wins = {};
    for (const rd of s.teamRounds) if (!rd.tie && rd.ranking[0]) wins[rd.ranking[0]] = (wins[rd.ranking[0]] || 0) + 1;
    const teams = s.teams
      .map((t) => ({ ...t, members: sizes[t.id], total: s.teamScores[t.id] || 0, wins: wins[t.id] || 0 }))
      .sort((a, b) => b.total - a.total || b.wins - a.wins);
    return { teams, rounds: s.teamRounds.slice(-8), round: this.roundPayload() };
  }

  // ------------------------------------------------------------- live quiz (hosted on the big screen)

  /** Replace the host's question list from pasted text (see parseLiveQuiz). */
  saveLiveQuiz(text) {
    if (typeof text !== 'string') throw new HttpError(400, 'Send the questions as text');
    if (this.live && this.live.status === 'open') throw new HttpError(409, 'A question is open — close it first');
    const { questions, skipped } = parseLiveQuiz(text);
    if (questions.length > 100) throw new HttpError(400, 'Up to 100 questions');
    this.settings.liveQuiz = questions;
    this.settings.liveAsked = [];
    this.persist('saveSettings', this.settings);
    return { count: questions.length, skipped };
  }

  /** What everyone sees about the current question. The answer is included only once it's closed (or for the admin). */
  liveQuizPayload(forAdmin = false) {
    const l = this.live;
    if (!l) return { status: 'idle' };
    const now = Date.now();
    const p = {
      status: l.status,
      kind: l.answer == null ? 'vote' : 'quiz',
      index: l.index,
      no: l.no,
      q: l.q,
      options: l.options,
      limitMs: l.limitMs,
      remainingMs: Math.max(0, l.closesAt - now),
      answered: l.answers.size,
      players: this.players.size,
      serverNow: now,
    };
    if (l.status === 'closed' || forAdmin) Object.assign(p, { answer: l.answer, result: l.result });
    return p;
  }

  /** Host puts question `index` on the big screen for `limitMs`. Phones get the options; nobody gets the answer. */
  askLive(index, limitMs) {
    const i = Number(index);
    const q = this.settings.liveQuiz[i];
    if (!Number.isInteger(i) || !q) throw new HttpError(400, 'Pick a question from the list');
    if (this.live && this.live.status === 'open') throw new HttpError(409, 'A question is already open — close it first');
    const limit = LIVE_LIMITS.includes(Number(limitMs)) ? Number(limitMs) : 15000;
    this.endLiveTimers();
    const now = Date.now();
    q.askedAt = now;
    this.settings.liveAsked.push(i);
    this.live = { status: 'open', index: i, no: this.settings.liveAsked.length, q: q.q, options: q.options, answer: q.answer, askedAt: now, closesAt: now + limit, limitMs: limit, answers: new Map(), result: null, dirty: false };
    this.persist('saveSettings', this.settings);
    this.emit('livequiz', this.liveQuizPayload());
    this.liveTimers.push(setTimeout(() => this.closeLive(), limit + LIVE_GRACE_MS));
    this.liveTimers.push(setInterval(() => {
      if (this.live && this.live.dirty) {
        this.live.dirty = false;
        this.emit('livequiz', this.liveQuizPayload()); // "34 answered" ticking up on the screen
      }
    }, 500));
    return this.liveQuizPayload(true);
  }

  answerLive(playerId, choice) {
    const l = this.live;
    const player = this.players.get(playerId);
    if (!l || l.status !== 'open' || !player) throw new HttpError(409, 'No question is open right now', 'NO_QUESTION');
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c >= l.options.length) throw new HttpError(400, 'Pick one of the options');
    if (l.answers.has(playerId)) return { ok: true, locked: true, answered: l.answers.size };
    const ms = Date.now() - l.askedAt;
    if (ms > l.limitMs + LIVE_GRACE_MS) throw new HttpError(410, 'Time’s up for this question', 'TOO_LATE');
    l.answers.set(playerId, { choice: c, ms });
    l.dirty = true;
    return { ok: true, answered: l.answers.size, ms };
  }

  endLiveTimers() {
    for (const t of this.liveTimers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.liveTimers = [];
  }

  /**
   * Time's up: reveal the answer, rank the correct answers by speed and credit points.
   * Points: 50 for a correct answer + up to 50 for speed, accumulated in one running
   * 'live' attempt per player (capped at 1000) so they count on the leaderboard.
   */
  closeLive() {
    const l = this.live;
    if (!l || l.status !== 'open') return;
    this.endLiveTimers();
    l.status = 'closed';
    const vote = l.answer == null; // a poll: bars only, no points
    const counts = l.options.map(() => 0);
    const correct = [];
    for (const [pid, a] of l.answers) {
      counts[a.choice]++;
      const p = this.players.get(pid);
      if (p && a.choice === l.answer) {
        const points = 50 + Math.round(50 * Math.max(0, 1 - Math.min(a.ms, l.limitMs) / l.limitMs));
        correct.push({ pid, name: p.name, emoji: p.emoji || '', ms: a.ms, points });
      }
    }
    correct.sort((a, b) => a.ms - b.ms);
    const now = Date.now();
    for (const pid of vote ? [] : l.answers.keys()) {
      if (!this.players.has(pid)) continue;
      let att = [...this.attempts.values()].find((x) => x.playerId === pid && x.gameId === 'live');
      if (!att) {
        att = { id: id(12), playerId: pid, gameId: 'live', startedAt: now, finishedAt: now, score: 0, meta: { correct: 0, answered: 0 }, pb: false };
        this.attempts.set(att.id, att);
      }
      const won = correct.find((c) => c.pid === pid);
      att.meta.answered++;
      if (won) {
        att.meta.correct++;
        att.score = Math.min(MAX, att.score + won.points);
        att.finishedAt = now; // reaching a total later loses ties, as everywhere else
      }
      this.persist('saveAttempt', att);
    }
    l.result = { counts, vote, correctCount: vote ? null : correct.length, fastest: correct.slice(0, 5).map(({ pid, ...c }) => c) };
    this.changed();
    this.emit('livequiz', this.liveQuizPayload());
    if (correct.length) {
      const item = { playerId: correct[0].pid, name: correct[0].name, gameId: 'live', score: correct[0].points, improved: false, fastest: true, at: now };
      this.recent.unshift(item);
      this.recent.length = Math.min(this.recent.length, 12);
      this.emit('activity', item);
    }
  }

  /** Take the question off the big screen (closing it first if it's still open). */
  hideLive() {
    if (this.live && this.live.status === 'open') this.closeLive();
    this.endLiveTimers();
    this.live = null;
    this.emit('livequiz', this.liveQuizPayload());
  }

  // ------------------------------------------------------------- lucky draw

  /** Pick a random guest for a spot prize. The big screen spins a wheel; the winner's phone celebrates. */
  luckyDraw({ onlyPlayed = false, excludeWinners = true } = {}) {
    const board = this.board(false); // "has played" means a finished game
    const previous = new Set(this.settings.luckyDraws.map((d) => d.playerId));
    const pool = [...this.players.values()].filter((p) => (!onlyPlayed || board.rankById.has(p.id)) && (!excludeWinners || !previous.has(p.id)));
    if (!pool.length) throw new HttpError(400, 'Nobody is eligible for the draw');
    const winner = pool[crypto.randomInt(pool.length)];
    const draw = { no: this.settings.luckyDraws.length + 1, playerId: winner.id, name: winner.name, emoji: winner.emoji || '', at: Date.now() };
    this.settings.luckyDraws.push(draw);
    this.persist('saveSettings', this.settings);
    // The wheel shows up to 80 names, the winner always among them.
    const others = shuffle(pool.filter((p) => p !== winner)).slice(0, 79);
    this.emit('luckydraw', { ...draw, winner: publicPlayer(winner), names: shuffle([winner, ...others]).map(publicPlayer), pool: pool.length });
    return draw;
  }

  // ------------------------------------------------------------- leaderboard

  /**
   * Total = sum of each player's best score per game. Ties go to whoever reached the total
   * first. With `includeLive` (the default) games in progress count provisionally, so the big
   * screen moves while people play; the reveal, Admin and the CSV use confirmed scores only.
   * Cached until the next change.
   */
  board(includeLive = true) {
    const cached = includeLive ? this.cache : this.cacheConfirmed;
    if (cached) return cached;
    const finished = [...this.attempts.values()].filter((a) => a.score != null && GAME_MAP[a.gameId]).sort((a, b) => a.finishedAt - b.finishedAt); // games since removed don't count
    const rows = new Map();
    const leaders = {};
    for (const a of finished) {
      const p = this.players.get(a.playerId);
      if (!p) continue;
      let row = rows.get(p.id);
      if (!row) {
        row = { ...publicPlayer(p), total: 0, scores: {}, plays: 0, reachedAt: 0 };
        rows.set(p.id, row);
      }
      row.plays++;
      const prev = row.scores[a.gameId];
      if (prev == null || a.score > prev) {
        row.total += a.score - (prev || 0);
        row.scores[a.gameId] = a.score;
        row.reachedAt = a.finishedAt;
      }
      if (!leaders[a.gameId] || a.score > leaders[a.gameId].score) leaders[a.gameId] = { id: p.id, name: p.name, score: a.score };
    }
    if (includeLive) {
      const now = Date.now();
      for (const [attemptId, l] of this.liveScores) {
        if (now - l.at > LIVE_STALE_MS || !this.attempts.has(attemptId)) continue;
        const p = this.players.get(l.playerId);
        if (!p) continue;
        let row = rows.get(p.id);
        if (!row) {
          row = { ...publicPlayer(p), total: 0, scores: {}, plays: 0, reachedAt: now };
          rows.set(p.id, row);
        }
        const best = row.scores[l.gameId];
        const counts = best == null || l.score > best;
        if (counts) {
          row.total += l.score - (best || 0);
          row.reachedAt = now;
        }
        row.live = { gameId: l.gameId, score: l.score, counts };
      }
    }
    const ranked = [...rows.values()].sort((x, y) => y.total - x.total || x.reachedAt - y.reachedAt);
    ranked.forEach((r, i) => (r.rank = i + 1));

    const chapterMap = new Map();
    for (const r of ranked) {
      if (!r.chapter) continue;
      const c = chapterMap.get(r.chapter.toLowerCase()) || { name: r.chapter, total: 0, members: 0 };
      c.total += r.total;
      c.members++;
      chapterMap.set(r.chapter.toLowerCase(), c);
    }

    const result = {
      ranked,
      rankById: new Map(ranked.map((r) => [r.id, r])),
      leaders: GAMES.map((g) => ({ gameId: g.id, ...(leaders[g.id] || {}) })),
      chapters: [...chapterMap.values()].sort((x, y) => y.total - x.total),
      plays: finished.length,
    };
    if (includeLive) this.cache = result;
    else this.cacheConfirmed = result;
    return result;
  }

  /** What the public big screen gets. Nothing score-related leaks while hidden. */
  screenPayload() {
    const s = this.settings;
    const board = this.board();
    const base = { mode: s.screenMode, title: s.eventTitle, tagline: s.tagline, playOpen: s.playOpen, players: this.players.size, plays: board.plays };
    // The team battle, live quiz and lucky draw ride on top of whichever view is showing.
    const overlays = { teamBattle: s.teams.length ? this.teamSummary() : null, live: this.liveQuizPayload() };
    if (s.screenMode === 'hidden') return { ...base, ...overlays };
    if (s.screenMode === 'reveal') return { ...base, reveal: s.reveal };
    const confirmed = this.board(false);
    return {
      ...base,
      ...overlays,
      top: board.ranked.slice(0, SCREEN_TOP).map(publicRow),
      leaders: board.leaders,
      chapters: board.chapters.slice(0, 8),
      recent: this.recent.slice(0, 8),
      // Who is mid-game right now, with their running score (for the "Playing right now" panel).
      playing: board.ranked
        .filter((r) => r.live)
        .sort((a, b) => b.live.score - a.live.score)
        .slice(0, 8)
        .map((r) => ({ id: r.id, name: r.name, rank: r.rank, gameId: r.live.gameId, score: r.live.score })),
      // The "New leader" banner follows confirmed scores, so provisional ones don't make it flicker.
      confirmedLeader: confirmed.ranked[0] ? publicRow(confirmed.ranked[0]) : null,
    };
  }

  // ------------------------------------------------------------- admin

  adminOverview() {
    const board = this.board(false);
    const players = [...this.players.values()].map((p) => {
      const row = board.rankById.get(p.id);
      const used = this.usedAttempts(p.id);
      return {
        ...publicPlayer(p),
        phone: p.phone || '',
        team: this.teamOf(p)?.name || '',
        createdAt: p.createdAt,
        rank: row?.rank ?? null,
        total: row?.total ?? 0,
        scores: row?.scores ?? {},
        tries: Object.values(used).reduce((a, b) => a + b, 0),
      };
    });
    players.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.createdAt - b.createdAt);
    const { reveal, ...settings } = this.settings;
    return {
      settings: { ...settings, revealedAt: reveal?.at ?? null },
      games: publicGames(),
      players,
      stats: { players: this.players.size, ranked: board.ranked.length, plays: board.plays, started: this.attempts.size, playing: this.liveScores.size },
      teamBattle: this.teamSummary(),
      liveQuiz: {
        questions: this.settings.liveQuiz.map((q, i) => ({ i, q: q.q, options: q.options, answer: q.answer, asked: Boolean(q.askedAt) })),
        current: this.liveQuizPayload(true),
      },
      luckyDraws: this.settings.luckyDraws,
    };
  }

  exportCsv() {
    const { players } = this.adminOverview();
    const header = ['Rank', 'Name', 'Business', 'Chapter', 'Phone', 'Team', ...GAMES.map((g) => g.name), 'Total', 'Tries', 'Joined'];
    const lines = players.map((p) => [
      p.rank ?? '',
      p.name,
      p.business,
      p.chapter,
      p.phone,
      p.team,
      ...GAMES.map((g) => p.scores[g.id] ?? ''),
      p.total,
      p.tries,
      new Date(p.createdAt).toISOString(),
    ]);
    return [header, ...lines].map((cols) => cols.map(csvCell).join(',')).join('\n');
  }
}

module.exports = GameState;
