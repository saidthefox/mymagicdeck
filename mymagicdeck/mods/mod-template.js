// ─────────────────────────────────────────────────────────────────────────────
// Deck OS mod template
//
// A "mod" is just a JS file that calls DeckOS.registerProgram(). When installed
// (System Settings → Mods), it shows up as a program in the Start menu and opens
// as a Win95 window. Copy this file, change the id/title/icon, fill in mount().
//
// Install by URL — host it anywhere public (this site's /mods/, a GitHub raw URL,
// a gist, any static host) and paste the URL in System Settings → Mods.
//
// TWO TRUST MODES (chosen at install):
//   • Sandboxed (recommended) — runs in an isolated iframe. It CANNOT touch the
//     page, your account, cookies, or localStorage. It can only use the capability
//     API below, and those calls are async (they return Promises — use await).
//   • Trusted — runs with full access to your session (like a userscript). Same
//     API, but the data calls are synchronous. `await` works in both, so write
//     your mod with `await` and it runs correctly either way.
//
// CAPABILITY API (available as `DeckOS.*` inside your mod):
//   DeckOS.registerProgram({ id, title, icon, mount(bodyEl){…} })
//   await DeckOS.decks.list()     → [{id,name,cards,sideboard,commander}, …]  (read-only)
//   await DeckOS.decks.active()   → the current deck, or null
//   await DeckOS.store.get(key)   → your mod's saved value (scoped to this mod)
//   await DeckOS.store.set(key,v) → persist a value (JSON-serializable)
//   DeckOS.ui.toast(message)      → show a toast
//   (set title/icon dynamically by passing them to registerProgram)
//
// `mount(body)` is handed the window's content element — render whatever you want
// into it. Keep it self-contained; you're drawing your own little app.
// ─────────────────────────────────────────────────────────────────────────────

DeckOS.registerProgram({
  id: 'my-mod',                 // unique — change this for your mod
  title: 'My Mod',
  icon: '🧩',
  async mount(body) {
    body.style.fontFamily = 'Tahoma, sans-serif';
    body.style.color = '#111';
    body.innerHTML = '<div style="padding:18px">Loading…</div>';

    // Example: read the active deck through the capability API.
    let deck = null;
    try { deck = await DeckOS.decks.active(); } catch (e) {}

    const name = deck ? (deck.name || 'Untitled Deck') : 'no active deck';
    const count = deck ? Object.keys(deck.cards || {}).length : 0;

    body.innerHTML =
      '<div style="padding:18px">' +
        '<h3 style="margin:0 0 10px">Hello from My Mod 👋</h3>' +
        '<p>Active deck: <b>' + name + '</b> (' + count + ' distinct cards)</p>' +
        '<button id="mm-btn" style="margin-top:10px;padding:6px 14px;font:inherit">Save a note</button>' +
        '<p id="mm-note" style="color:#777;font-size:12px;margin-top:10px"></p>' +
      '</div>';

    // Example: persist mod-scoped data + show a toast.
    const noteEl = body.querySelector('#mm-note');
    (async () => {
      const saved = await DeckOS.store.get('lastNote');
      if (saved) noteEl.textContent = 'Last note: ' + saved;
    })();
    body.querySelector('#mm-btn').onclick = async () => {
      const stamp = new Date().toLocaleTimeString();
      await DeckOS.store.set('lastNote', stamp);
      noteEl.textContent = 'Last note: ' + stamp;
      DeckOS.ui.toast('Saved!');
    };
  }
});
