// Tap Frenzy — one big button, 10 seconds, tap as fast as you can. Every tap is 7 points
// (143 taps = a perfect 1000). Taps anywhere in the play area count, so thumbs can go wild.
import { vibrate, abortError } from '../common.js';

const DURATION = 10000;
const POINTS = 7; // mirrors the server formula (server/games.js)
const MILESTONES = { 25: '🔥 Warming up!', 50: '⚡ Fast fingers!', 75: '🚀 Unstoppable!', 100: '🏆 Century!', 125: '👑 Legendary!' };

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="frenzy">
        <p class="frenzy-hint" id="frenzy-hint">Tap anywhere — as fast as you can!</p>
        <button class="frenzy-btn" type="button" aria-label="Tap!">
          <span class="frenzy-count" id="frenzy-count">0</span>
          <span class="frenzy-sub">taps</span>
        </button>
        <div class="frenzy-rate" id="frenzy-rate">0 taps / sec</div>
      </div>`;
    const root = stage.querySelector('.frenzy');
    const btn = stage.querySelector('.frenzy-btn');
    const count = stage.querySelector('#frenzy-count');
    const rate = stage.querySelector('#frenzy-rate');
    const hint = stage.querySelector('#frenzy-hint');
    const t0 = performance.now();
    const recent = []; // tap times within the last second, for the pace meter and the glow
    let taps = 0;
    let final = false;
    let raf = 0;
    let endTimer = 0;
    hud.time(10);
    hud.scoreLabel('Points');
    hud.score(0);

    return new Promise((resolve, reject) => {
      function popText(text) {
        const el = document.createElement('div');
        el.className = 'frenzy-pop';
        el.textContent = text;
        root.appendChild(el);
        setTimeout(() => el.remove(), 900);
      }

      function onTap(e) {
        e.preventDefault();
        const now = performance.now();
        if (now - t0 >= DURATION) return;
        taps++;
        recent.push(now);
        count.textContent = taps;
        hud.score(taps * POINTS);
        live(taps * POINTS);
        btn.classList.remove('hit');
        void btn.offsetWidth;
        btn.classList.add('hit');
        sfx.tap();
        vibrate(5);
        if (MILESTONES[taps]) {
          popText(MILESTONES[taps]);
          sfx.combo(Math.round(taps / 10));
          vibrate([20, 20, 20]);
        }
      }

      function tick() {
        const now = performance.now();
        const left = DURATION - (now - t0);
        hud.time(Math.max(0, Math.ceil(left / 1000)));
        while (recent.length && now - recent[0] > 1000) recent.shift();
        rate.textContent = `${recent.length} taps / sec`;
        root.style.setProperty('--heat', Math.min(1, recent.length / 12));
        if (!final && left <= 3000) {
          final = true;
          sfx.alarm();
          hint.textContent = '⏰ Last 3 seconds — go go go!';
        }
        if (left <= 0) {
          cancelAnimationFrame(raf);
          root.removeEventListener('pointerdown', onTap);
          btn.classList.add('over');
          root.style.setProperty('--heat', 0);
          hint.textContent = `⏱️ Time! ${taps} taps · ${taps * POINTS} points`;
          sfx.good();
          endTimer = setTimeout(() => { cleanup(); resolve({ taps }); }, 1100);
          return;
        }
        raf = requestAnimationFrame(tick);
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        clearTimeout(endTimer);
        root.removeEventListener('pointerdown', onTap);
      }

      root.addEventListener('pointerdown', onTap);
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      tick();
    });
  },
};
