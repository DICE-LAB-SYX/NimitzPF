# NimitzPF

A lineup planner for the Pacific Front event in World of Warships. Open the official web version of the event, and NimitzPF reads your current operation: enemies, battle conditions, unit HP and modifier stock. It then works out which units to send to each key point, how to line them up and which modifiers to bring. Win chances match what the game shows. You still place the cards and start the battles yourself.

Install it here: https://dice-lab-syx.github.io/NimitzPF/

## Features

- Reads the live operation from the web version on the Asia, EU and NA servers. There is nothing to type in.
- Plans the whole operation at once, taking card HP, modifier stock and conditions between key points into account
- Three goals: Safe clear, Perfect, Max reward (with your own weight for each reward type)
- Follows the key point you open in game, and re-plans by itself after every battle
- Change any suggested lineup and the rest gets re-planned around it
- Checks the suggested lineup against the official battle engine on the game page

The battle rules are rewritten from the official engine, and the tests compare results against it.

## Usage

1. Sign in to the event's web version in a desktop browser (Chrome, Edge or Firefox), for example https://pacificfront.worldofwarships.asia/. The game client's built-in browser cannot run the script.
2. Install an entry point from the site above, which walks you through it. The recommended way is the userscript: install Tampermonkey, allow it to run user scripts, then install the NimitzPF script, and the panel loads by itself every time. If you would rather not install an extension, drag the NimitzPF bookmarklet to your bookmarks bar instead.
3. Open the game page. The panel opens on the right (with the bookmarklet, click it first); enter an operation and the plan appears.

The panel only sends the same read-only requests the game page itself makes. It never plays cards, starts battles or buys anything, and everything is computed in your browser.

Shortcuts inside the panel: `1`–`4` pick a slot, `←` `→` switch key points, `↑` `↓` switch stages, `Enter` deep solve.

## Running locally

Requires Node.js 20+ and pnpm 9 (Node 24+ for `pnpm extract`).

```sh
pnpm install
pnpm dev
```

`http://localhost:5173/?demo` shows the panel with sample data. Install the dev userscript from `http://localhost:5173/nimitzpf.user.js`, or use the bookmarklet on the local landing page, to load the dev build into the game page. Chrome asks the game site for local network access the first time; allow it.

`pnpm test` runs the tests and `pnpm build` builds the panel and `bridge.js` to `apps/web/dist`. After a game update, run `pnpm extract` to pull fresh data and assets. It reads the Asia server by default; use `node scripts/extract-data.mjs --realm=eu` for others.

## Disclaimer

Fan-made, not affiliated with Wargaming. Game text and art belong to their owners.
