// Deck OS demo mod — a cosmetic desktop lamp.
// Install: System Settings → Mods → https://mymagicdeck.com/mods/lamp.js  (sandboxed is fine)
DeckOS.registerProgram({
  id: 'lamp',
  title: 'Lamp',
  icon: '💡',
  mount(body) {
    body.style.padding = '0';
    body.innerHTML =
      '<div style="text-align:center;padding:28px 16px;font-family:Tahoma,sans-serif">' +
        '<div id="lamp-glow" style="font-size:84px;line-height:1;transition:opacity .25s,filter .25s;filter:drop-shadow(0 0 18px #ffe27a)">💡</div>' +
        '<button id="lamp-btn" style="margin-top:14px;padding:6px 18px;font:inherit">Toggle light</button>' +
        '<p style="color:#888;font-size:12px;margin-top:12px">A cozy desktop lamp — demo mod for Deck OS.</p>' +
      '</div>';
    let on = true;
    const glow = body.querySelector('#lamp-glow');
    body.querySelector('#lamp-btn').onclick = () => {
      on = !on;
      glow.style.opacity = on ? '1' : '0.2';
      glow.style.filter = on ? 'drop-shadow(0 0 18px #ffe27a)' : 'grayscale(1)';
    };
  }
});
