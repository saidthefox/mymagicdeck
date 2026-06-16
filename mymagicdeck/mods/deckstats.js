// Deck OS demo mod — shows stats for your active deck, using the DeckOS capability API.
// Works sandboxed (read-only deck access over postMessage) or trusted.
// Install: System Settings → Mods → https://mymagicdeck.com/mods/deckstats.js
DeckOS.registerProgram({
  id: 'deckstats',
  title: 'Deck Stats',
  icon: '📊',
  async mount(body) {
    body.style.fontFamily = 'Tahoma, sans-serif';
    body.style.color = '#111';
    body.innerHTML = '<div style="padding:18px">Loading active deck…</div>';
    let deck = null;
    try { deck = await DeckOS.decks.active(); } catch (e) {}
    if (!deck) { body.innerHTML = '<div style="padding:18px">No active deck. Open one in the builder, then reopen this.</div>'; return; }
    const cards = deck.cards || {};
    const keys = Object.keys(cards);
    let total = 0;
    keys.forEach(k => { const c = cards[k] || {}; total += (c.qty || c.count || c.quantity || 1); });
    body.innerHTML =
      '<div style="padding:18px">' +
        '<h3 style="margin:0 0 10px">' + (deck.name || 'Untitled Deck') + '</h3>' +
        '<div style="display:flex;gap:18px;margin-bottom:8px">' +
          '<div><div style="font-size:26px;font-weight:800">' + keys.length + '</div><div style="font-size:12px;color:#777">distinct</div></div>' +
          '<div><div style="font-size:26px;font-weight:800">' + total + '</div><div style="font-size:12px;color:#777">total cards</div></div>' +
        '</div>' +
        '<p style="color:#888;font-size:12px;margin-top:10px">Demo mod — reads the active deck through the Deck OS capability API.</p>' +
      '</div>';
  }
});
