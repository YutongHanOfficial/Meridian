# Meridian

A fast, unforgiving geography game played on a 3D globe with no labels. Five modes, three lives, and a clock that keeps shrinking.

| Mode | What you do | What makes it hard |
| --- | --- | --- |
| **Country Hunt** | A country name appears; click it on the globe | Targets get smaller each round (all the way down to microstates); the timer drops from 18s to 7s |
| **Pin Drop** | Drop a pin on a city | The allowed radius shrinks from 2,000 km to 250 km; cities get more obscure |
| **Border Run** | Get from A to B by typing each bordering country in turn | No clicking: you have to know the names. Naming a non-neighbor costs a life; par grows from 2 to 8 steps |
| **Shape Shift** | Name a country from its silhouette | 3 guesses with distance/direction clues; later rounds rotate the shape |
| **Daily Gauntlet** | 10 mixed rounds, same for everyone today | No lives, and only your first run of the day counts (replays are practice). Every miss shows up in your shareable 🟩🟨🟥 grid |

Streaks build a score multiplier (×1.5 at 3 in a row, up to ×4). Daily #1 was October 22, 2026.

**Stats** (from the menu or the results screen) track your lifetime record in the browser: accuracy, best streak, an atlas of every country you've found, per-mode win rates, daily streaks with a 14-day score chart, highlights like your fastest find and closest pin, and your "nemesis" countries.

**Controls:** drag to spin · scroll or pinch to zoom · click or type to answer · `Space` next round · `+`/`-` zoom · `Esc` quit

## Run locally

The map data is loaded with `fetch`, so open it through a local server, not by double-clicking `index.html`:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Publish on GitHub Pages

1. Create a new GitHub repository, for example `meridian`.
2. Upload everything in this folder to the repository root: `index.html`, `.nojekyll`, and the `css/`, `js/`, `lib/` and `data/` folders.
3. In the repository, go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then select `main` and `/ (root)` and save.
4. About a minute later the game is live at `https://<your-username>.github.io/meridian/`.

There's no build step and no backend. d3 and topojson are bundled in `lib/`, so the game doesn't depend on a CDN.

## Tweaking

- **Cities:** `js/data.js` → `CITIES`. Each row is `[name, country, lat, lon, tier]` (tier 1 = famous, 3 = obscure).
- **Country names / aliases:** `DISPLAY_NAMES` and `ALIASES` in `js/data.js`.
- **Difficulty curves:** `DUR` (timers), `pickByRank` (which countries appear when), the Pin Drop radius in `ROUNDS.pin`, and the Border Run par in `pickBorder`, all in `js/game.js`.
- **Daily lineup:** `DAILY_SEQ` in `js/data.js`. Day 1 is `DAY_ONE` in `js/game.js`.

## Files

```
index.html        page shell and HUD
css/style.css     all styling
js/globe.js       canvas globe: rendering, drag/zoom/pinch, fly-to, highlights, effects
js/game.js        modes, scoring, timers, menus
js/data.js        names, cities, mode definitions
js/audio.js       synthesized sound effects (no audio files)
lib/              d3 v7.9.0, topojson-client v3.1.0
data/             world-atlas 2.0.2 country borders (Natural Earth, 50m and 110m)
```

Map data: [world-atlas](https://github.com/topojson/world-atlas) / Natural Earth (public domain). Rendering: [d3-geo](https://d3js.org/d3-geo).
