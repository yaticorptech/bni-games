# 🏆 BNI Award Night Games

Five quick phone games and a **live public leaderboard** for the big screen. Guests scan a QR code, play, and watch the rankings change in real time. Before the awards, you can hide the board and run a **grand reveal** of the winners.

| Page | URL | Who uses it |
|---|---|---|
| Player app | `/` | Guests on their phones (they scan the QR code) |
| Big screen | `/screen` | Projector or TV: live leaderboard, QR code, live feed, reveal |
| Admin | `/admin` | You: open/close games, hide or reveal the board, players, CSV export |

## Quick start

```bash
cd ~/bni-games/backend
npm install
cp .env.example .env      # then set ADMIN_PASSWORD
npm start                 # → http://localhost:8110
```

Locally the backend also serves the pages in `frontend/`, so everything runs from one command. If you'd rather run the frontend separately, open a second terminal and run `cd frontend && npm run dev` (add `-- --host` for phones). That serves the pages on http://localhost:5173 and forwards API and live traffic to the backend on 8110. There's nothing to install. The terminal prints the address phones should use, for example `http://192.168.1.5:8110/`. No database is needed: data is saved to `backend/data/db.json`.

## The games (each scores 0–1000)

| Game | What you do | Scoring |
|---|---|---|
| 🤝 **Referral Rush** (30s) | Whack-a-mole: tap referrals, avoid ghost clients | 🤝 +20 · ⭐ +50 · 👻 −15 |
| ⚡ **Lightning Reflex** (5 rounds) | Tap the moment the pad turns green | Up to 200 per round (faster = more), early tap −25 |
| 🧠 **Memory Match** (2 min max) | Find all 8 pairs | 1000 − 20 per move over 8 − 5 per second over 20 (min 150 if completed) |
| 🎨 **Colour Clash** (30s) | Tap the ink colour, not the word | Right +30 · Wrong −15 |
| 🎓 **Givers Gain Quiz** (10 questions) | BNI and business trivia, 15s each | Correct = 50 + up to 50 speed bonus |
| 🎭 **Emoji Pictionary** (10 puzzles) | Guess the profession from two emojis, 8s each (edit `backend/config/pictionary.json`) | Correct = 50 + up to 50 speed bonus |
| 🎵 **Handshake Sequence** | Simon says: repeat a growing sequence of pads until you slip | 80 per level to 5, then 120 per level — level 10 = 1000 |
| 🔍 **Odd One Out** (30s) | Spot the one different emoji in a growing grid | Right +35 · Wrong −15 |
| 📺 **Live Quiz** (hosted) | The organiser asks questions on the big screen; answer on your phone | Correct = 50 + up to 50 speed bonus, max 1000 |

A player's **total = their best score in each game added together** (max 9000 with the Live Quiz). Ties go to whoever reached that total first. By default each player gets **3 tries per game**; you can change this in Admin (1–10 or unlimited).

**Edit the quiz:** `backend/config/quiz-questions.json`. `answer` is the 0-based position of the correct option. Options are shuffled for each player. Changes apply to the next quiz started, with no restart needed. **Check the BNI facts against your region before the event.**

## Guest list (phone login)

If only invited guests should play, give the app the guest list: **Admin → Guest list**, paste one guest per line as `Name, Phone` (a CSV copied from a spreadsheet pastes in as-is; a guest may have two numbers written `… / …`), then **Save guest list**. The server reports any lines it skipped, such as a header row.

While the list has names, the join form asks for a mobile number instead of a name: only listed numbers get in, the player's name comes from the list, and logging in again (another phone, a cleared browser) returns the same player with their scores. Fix a wrong number or add a late guest in Admin at any time, no redeploy needed. Clear the list to go back to open joining by name. Phone numbers are shown only in Admin and the CSV export, never on the big screen or to other players.

## Hosted moments on the big screen

The big screen always stays on the live leaderboard. The hosted moments below appear **on top of it** as overlays and get out of the way by themselves.

### Team Tap Battle (group game)

In **Admin → Team Tap Battle**, choose 2–6 teams and press **Make random teams**: everyone who has logged in is dealt into equal teams (Red, Blue, Green…), and anyone who logs in later joins the smallest team. Phones show their team on the home screen.

Press **Start round** (15–60 s). Every phone counts down 3-2-1 and turns into a giant TAP button; the big screen shows the team bars racing live. When time is up the winning team is announced with confetti, the result lingers for a few seconds, and the standings (taps across all rounds, rounds won) take a turn in the sidebar. Run as many rounds as you like; **Reset team scores** clears the totals, **Make random teams** again reshuffles everyone. Taps are counted on the server and capped at a human rate per phone, so auto-clickers don't help. Team totals never affect individual scores.

### Live Quiz (hosted)

A Kahoot-style quiz you run from **Admin → Live Quiz**. Write your questions in the editor — one per block, a blank line between blocks, the question on the first line, then 2–6 options with `*` at the end of the correct one:

```
Who is always first at the breakfast buffet?
- Rahul *
- Priya
- Suresh
```

Leave the `*` out and the block becomes a **Live Vote** ("Who's most likely to close a deal at a wedding?" with member names as options): no right answer, no points, just the bars filling up and "The room has spoken".

Press **Ask**: the question fills the big screen while every phone shows the options (10–30 s to answer). When time runs out the screen reveals the answer, how the room voted and the fastest guests. Correct = 50 points + up to 50 for speed, counted on the leaderboard as the 📺 Live Quiz game (max 1000). Inside jokes about the members get the biggest laughs.

### Lucky Draw

**Admin → Lucky Draw → Spin the wheel**: the big screen spins a wheel of everyone who has logged in (optionally only those who have played, skipping previous winners), lands on a random guest with drumroll and confetti, and the winner's phone lights up. Winners are listed in Admin.

### Avatars and nudges

Guests pick an emoji when they log in (changeable from the home screen); it shows next to their name on the big screen, in the reveal and in Admin. Phones get a nudge when someone overtakes them ("🍕 Priya just overtook you — play again!") and a cheer when they climb into the top 3.

The rehearsal bots (`npm run simulate`) tap along in team rounds and guess in live-quiz questions.

## Event-night runbook

**A day before**
1. Choose where to host it (see *Hosting* below) and open the player URL on two different phones.
2. Set `ADMIN_PASSWORD`. Then in `/admin`, set the event title, paste the guest list if only invited guests should play (see above) and, optionally, the list of chapters. With chapters set, the join form shows a dropdown and the big screen shows chapter standings.
3. Rehearse: `npm run simulate -- --players 25` (in `backend/`; add `--url <backend URL>` for the hosted one, and `--admin <password>` when a guest list is set so the bots log in as listed guests) adds fake guests who play for real, so you can watch `/screen` update and practise the reveal.
4. **In `/admin`, press Reset everything** to clear the rehearsal data.

**On the night**
1. Open `/screen` on the projector laptop. Click once to enable sound, then press **F** for fullscreen.
2. Optionally print the QR code for tables (Admin → *Open QR to print*).
3. Keep `/admin` open on your phone or laptop to watch players and remove any junk entries.

**Results time**
1. Admin → Game play → **Closed**. Games already in progress can still finish.
2. Admin → Big screen → **Hidden**. Phones also hide ranks, which builds suspense.
3. Choose Top 3, 5, 10 or 15, then press **🏆 Start grand reveal**. The screen counts down to #1 with drumrolls and confetti.
4. **Export CSV** for your records and certificates. Switch the big screen back to **Live** whenever you like.

## Hosting

**Option A: a laptop at the venue (simplest).** Run `npm start` in `backend/` on a laptop. Every phone must join the **same Wi-Fi**, and the QR code automatically shows the laptop's Wi-Fi address.
⚠️ Many venue and hotel networks block devices from reaching each other ("client isolation"). Test with a phone at the venue beforehand. A mobile hotspot from the organiser's phone is a reliable fallback, but it only supports about 10–15 devices.

**Option B: the cloud (recommended for more than about 30 guests).** Guests can use mobile data, so there's no Wi-Fi dependency. The backend goes on Railway and the frontend on Vercel, both from this one repo.

1. **Backend → Railway.** New service from the repo, **Root Directory `backend`**. Railway runs `npm install` and `npm start` by itself. Add the variables:
   - `ADMIN_PASSWORD`
   - `MONGODB_URI=<Atlas URI>`: required, because Railway's disk is wiped on every deploy/restart
   - `PUBLIC_URL=https://your-app.vercel.app` (fill in after step 2): the QR code points here, and only this site may call the API

   Under *Networking*, generate a domain (e.g. `https://bni-games.up.railway.app`). Opening it should show `{"ok":true,…}`. Keep it at **one instance (replica)**, because the live state lives in memory.
2. **Frontend → Vercel.** Put the Railway URL in `frontend/js/config.js` (`export const API_URL = 'https://bni-games.up.railway.app';`), then import the repo into Vercel with **Root Directory `frontend`**, Framework *Other*, and no build command.
3. Set `PUBLIC_URL` on Railway to the Vercel URL and let it redeploy. Open `https://your-app.vercel.app/screen`: the QR code should show the Vercel address, and the LIVE pill should be green.

Using a custom domain for the frontend? Use it as `PUBLIC_URL`, and list any other frontend addresses in `CORS_ORIGINS` (comma-separated).

**Live deployment**
- Players / big screen / admin: https://bni-games-nine.vercel.app (`/screen`, `/admin`) — Vercel project `bni-games`, deployed from `frontend/` with `npx vercel --prod`.
- API: https://bni-backend-production.up.railway.app — Railway project `bni-games`, service `bni-backend`, deployed from `backend/` with `npx @railway/cli up --service bni-backend`. Variables live in Railway; `PUBLIC_URL` and `CORS_ORIGINS` point at the Vercel aliases.
- Local development uses a separate database (`MONGODB_DB=bni_games_dev` in `backend/.env`), so rehearsing on a laptop never touches the live event.

**Going-live checklist (hosted)**
- Railway → Variables: `ADMIN_PASSWORD` (long, not the default), `MONGODB_URI`, `PUBLIC_URL`. The server refuses to start on Railway without `MONGODB_URI`; the Admin page shows **Storage: ☁️ MongoDB** when it's in use.
- Railway → Settings: pick the region nearest the venue and the MongoDB cluster (e.g. Singapore for India), keep **1 replica**, and make sure **App Sleeping** is off — a sleeping service takes several seconds to wake for the first guest.
- `API_URL` in `frontend/js/config.js` must be the `https://` Railway address (a plain `http://` one is blocked by browsers on an `https://` page).
- Open the Vercel URL on two phones (Wi-Fi and mobile data), play one game each, and check `/screen` shows them live.
- Don't redeploy either side during the event: a backend redeploy restarts the server, which drops games in progress (players get the try back) and reconnects every phone.
- After the rehearsal, Admin → **Reset everything** to clear the fake data.

## Configuration

**Backend** (`backend/.env` locally, *Variables* on Railway):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8110` | Railway sets this itself |
| `ADMIN_PASSWORD` | `bni-admin` | **Change it** |
| `EVENT_TITLE` | `BNI Award Night` | Initial title (editable live in Admin) |
| `PUBLIC_URL` | auto | Frontend address: shown under the QR code and allowed to call the API. Set it when hosted |
| `CORS_ORIGINS` | empty | Extra frontend addresses allowed to call the API, comma-separated |
| `MONGODB_URI` / `MONGODB_DB` | empty / `bni_games` | Use MongoDB instead of `backend/data/db.json` |

**Frontend:** `frontend/js/config.js` sets `API_URL`, the backend address. Leave it `''` when the backend serves the pages (local/laptop mode); the backend then ignores it anyway.

## Fair play

Scores are **calculated on the server** from what happened in the game (hits, reaction times, moves), never taken directly from the phone. Every value is range-checked, and the server measures each game's duration itself. A result that comes back faster than the game can be played is rejected. The quiz is fully server-side: answers never reach the phone and every answer is timed by the server. This won't stop a determined hacker, but it does stop the obvious tricks. The admin can remove any suspicious player.

## Project layout

```
backend/              Node API + live updates → Railway
  server/             Express + Socket.IO
    games.js          game registry and scoring (the single source of truth for points)
    state.js          players, tries, leaderboard, reveal (in memory + persisted)
    realtime.js       live pushes to the screen, phones and admin (throttled to 1/s)
    store/            JSON-file or MongoDB persistence
  config/quiz-questions.json
  scripts/simulate.js rehearsal bot
frontend/             static site, no build step: plain HTML/CSS/JS modules → Vercel
  js/config.js        API_URL: where the backend lives
  js/games/           one file per game
  js/vendor/          Socket.IO client
  vercel.json         /screen and /admin without .html
  dev-server.js       local only: `npm run dev` (not deployed, see .vercelignore)
```
