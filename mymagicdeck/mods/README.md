# Deck OS mods

A **mod** adds a program to Deck OS (the Win95-style mobile shell of MyMagicDeck).
It's a single JS file that calls `DeckOS.registerProgram(...)`. When installed it
appears in the **Start menu → Programs** and opens as a Win95 window.

## Install one

**System Settings → Mods** → paste the mod's URL → **Install**.

- Leave **"Run sandboxed (recommended)"** checked unless you wrote/fully trust the mod.
- Installed mods are remembered (in `DeckOS.store`) and re-loaded every time the app boots.

Two demos live here you can install right now:

- `https://mymagicdeck.com/mods/lamp.js` — a cosmetic desktop lamp 💡
- `https://mymagicdeck.com/mods/deckstats.js` — 📊 active-deck stats (uses the capability API)

## Write one

Copy [`mod-template.js`](mod-template.js), change the `id`/`title`/`icon`, and fill in
`mount(body)` — you're handed the window's content element and render whatever you like.

```js
DeckOS.registerProgram({
  id: 'lamp', title: 'Lamp', icon: '💡',
  mount(body) { body.innerHTML = '<p style="padding:16px">💡 hello</p>'; }
});
```

## The two trust modes

Chosen at install time:

| | Sandboxed (recommended) | Trusted |
|---|---|---|
| Runs in | an isolated `iframe` (opaque origin) | your page directly (like a userscript) |
| Can access the page / cookies / your account? | **No** | Yes |
| API calls | **async** (return Promises) | synchronous |
| Use for | anything, incl. mods from other people | only mods you wrote / fully trust |

Write your mod with `await` on the data calls — it works correctly in **both** modes
(awaiting a non-Promise just returns the value), so you never have to care which mode
a user picked.

## Capability API (`DeckOS.*` inside a mod)

| Call | Returns / does |
|---|---|
| `DeckOS.registerProgram({id,title,icon,mount})` | register the program (required) |
| `await DeckOS.decks.list()` | `[{id,name,cards,sideboard,commander}, …]` (read-only) |
| `await DeckOS.decks.active()` | the current deck, or `null` |
| `await DeckOS.store.get(key)` | this mod's saved value (storage is scoped per-mod) |
| `await DeckOS.store.set(key, value)` | persist a JSON-serializable value |
| `DeckOS.ui.toast(message)` | show a toast |

Sandboxed mods are intentionally limited to this surface — no DOM access to the host,
no network calls to the backend, no reading your account. That's the safety guarantee
that lets you install a stranger's mod without risk. (A trusted mod can do anything your
browser session can, which is why the installer warns you.)

## Where to host

- **On this site** — drop a `.js` in `/srv/sites/mymagicdeck/mymagicdeck/mods/`; it's
  instantly served at `mymagicdeck.com/mods/<name>.js`.
- **Anywhere public** — a GitHub raw URL, a gist, a CDN, any static host. The installer
  just fetches the URL.

## Roadmap

- A small **manifest** (`{name, icon, permissions}`) + a curated registry for discovery.
- Richer capabilities behind explicit per-mod permission prompts.
