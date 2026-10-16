# NimitzPF

A lineup planner for the Pacific Front event in World of Warships. Open the event's official web version and NimitzPF reads the operation you're playing: enemies, battle conditions, unit HP and modifier stock. It works out which units to send to each key point, where to put them and which modifiers to bring, and its win chances match the game to the percent. You place the cards and start the battles yourself, unless you switch on auto play and let it do the clicking.

Install it here: https://dice-lab-syx.github.io/NimitzPF/

## What it does

- Reads the live operation from the web version on the Asia, EU, NA and CN (360) servers, so there's nothing to type in
- Plans the whole operation at once, with card HP, modifier stock and conditions between key points all taken into account
- Three goals: Safe clear, Perfect, and Max reward (you set how much each reward type is worth to you)
- Follows the key point you open in game and plans again after every battle
- Lets you change any suggested lineup, then plans the rest around your change
- Double-checks the lineup against the official battle engine on the game page
- Optional auto play (off by default): plays the whole operation for you right on the game screen, battle by battle and stage by stage, planning again after every step

The battle rules are rewritten from the official engine, and the tests compare the results against it.

## Getting started

1. Sign in to the event's web version in a desktop browser (Chrome, Edge or Firefox), for example https://pacificfront.worldofwarships.asia/ (CN server: https://oceanfront.wowsgame.cn/). The browser built into the game client can't run the script.
2. Load NimitzPF using one of the two ways the site above walks you through. The userscript is the easy one: install Tampermonkey, allow it to run user scripts, install the NimitzPF script, and the panel loads by itself from then on. If you'd rather not install an extension, drag the NimitzPF bookmarklet to your bookmarks bar instead.
3. Open the game page. The panel opens on the right (click the bookmarklet first if you use that), and the plan shows up once you're in an operation.

Out of the box the panel only makes the same read-only requests the game page makes. It never plays, starts battles or buys anything, and all the maths runs in your browser.

### Auto play

Tick **Auto play** in the top bar and confirm, and two things show up: a **Battle** button on each key point you can fight, and **Auto play the operation**. It plays through the game's own screen the way you would: a yellow cursor opens the key point, drags the units and modifiers into place, presses Battle and waits for the fight to finish, then moves on. Once everything planned for a stage is done it hits "Go to Stage", and it keeps going until the last stage. Every step gets a 3 second countdown you can cancel, and your mouse is held back on the game page while it works so nothing gets knocked loose. The game sends every request itself; NimitzPF never talks to the game's servers directly. It never buys anything, and the final rewards are left for you to claim.

It's experimental, and a game update can break it. Having a third-party tool play for you may also go against the game's terms of service, so use it at your own risk.

Scripts and bookmarklets installed before auto play existed stay read-only. If the panel asks you to reinstall, install the userscript again, or delete the old bookmarklet and drag a new one, then reload the game page.

Shortcuts inside the panel: `1`–`4` pick a slot, `←` `→` switch key points, `↑` `↓` switch stages, `Enter` runs a deep solve.

### Tips

- Standard modifiers can be bought ahead of time with Fleet Supplies in the game; special ones only come from rewards. The plan only uses what's in your stock, so stock up before you start. The panel plans again as soon as you buy.
- New units are on you for now: get them with Obtain Units in the game. NimitzPF only plans with units already in your fleet, doesn't suggest which ones to get yet, and auto play won't get them for you.
- Lineups you change in the panel are kept, and auto play plays them the way you set them. "Back to the plan" on a key point brings the suggestion back.

## Running locally

Requires Node.js 20+ and pnpm 9 (Node 24+ for `pnpm extract`).

```sh
pnpm install
pnpm dev
```

`http://localhost:5173/?demo` shows the panel with sample data. To load the dev build into the game page, install the dev userscript from `http://localhost:5173/nimitzpf.user.js` or use the bookmarklet on the local landing page. The first time, Chrome asks the game site for local network access; allow it.

`pnpm test` runs the tests, and `pnpm build` builds the panel and `bridge.js` into `apps/web/dist`. After a game update, run `pnpm extract` to pull fresh data and assets. It reads the Asia server by default; use `node scripts/extract-data.mjs --realm=eu` for the others (`--realm=cn` for the CN server).

## Disclaimer

Fan-made and not affiliated with Wargaming. Game text and art belong to their owners.
