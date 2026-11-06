/* "Which game do you want to play?" pop-up. Any element with data-play opens it; without JavaScript the link still goes to /play. */
(function () {
  var GAMES = [
    { name: 'Bhabhi Thulla', href: '/play', meta: '3–8 players · shedding game', text: 'Follow suit or throw a Thulla — the last player holding cards is the Bhabhi.' },
    { name: 'Bluff', href: '/play/bluff', meta: '3–10 players · bluffing game', text: 'Play cards face down, name a rank, and call out anyone you think is lying.' },
    { name: 'Jack Thief', href: '/play/jack-thief', meta: '2–10 players · matching game', text: 'Pair up your cards and avoid being left holding the lonely Jack.' }
  ];
  var css = '.gm-back{position:fixed;inset:0;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;z-index:1000;padding:16px}.gm-back.on{display:flex}' +
    '.gm-box{background:#0a3d29;border:2px solid #f5c542;border-radius:20px;padding:22px 20px 18px;max-width:440px;width:100%;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5);max-height:92vh;overflow:auto}' +
    '.gm-box h2{margin:0 0 4px;font-size:1.4rem;text-align:center}.gm-box p.s{margin:0 0 14px;text-align:center;opacity:.8;font-size:.95rem}' +
    '.gm-opt{display:block;text-decoration:none;color:#fff;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:12px 16px;margin-bottom:10px;transition:transform .08s,background .15s}' +
    '.gm-opt:hover,.gm-opt:focus-visible{background:rgba(245,197,66,.18);border-color:#f5c542;outline:none;transform:translateY(-1px)}' +
    '.gm-opt b{display:block;font-size:1.15rem;color:#f5c542}.gm-opt small{display:block;opacity:.75;margin:1px 0 4px}.gm-opt span{font-size:.92rem;opacity:.92;line-height:1.4;display:block}' +
    '.gm-x{display:block;margin:6px auto 0;background:none;border:0;color:#fff;opacity:.75;font:inherit;cursor:pointer;padding:6px 14px}.gm-x:hover{opacity:1}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var back = document.createElement('div'); back.className = 'gm-back'; back.setAttribute('role', 'presentation');
  var html = '<div class="gm-box" role="dialog" aria-modal="true" aria-labelledby="gm-t"><h2 id="gm-t">Which game do you want to play?</h2><p class="s">Pick a game — you can create a room or join one with a code.</p>';
  GAMES.forEach(function (g) { html += '<a class="gm-opt" href="' + g.href + '"><b>' + g.name + '</b><small>' + g.meta + '</small><span>' + g.text + '</span></a>'; });
  html += '<button class="gm-x" type="button">Cancel</button></div>';
  back.innerHTML = html; document.body.appendChild(back);
  var opener = null;
  function open(e) { opener = document.activeElement; back.classList.add('on'); var f = back.querySelector('.gm-opt'); if (f) f.focus(); }
  function close() { back.classList.remove('on'); if (opener && opener.focus) opener.focus(); }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-play]');
    if (t && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); open(); }
  });
  back.addEventListener('click', function (e) { if (e.target === back) close(); });
  back.querySelector('.gm-x').addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (!back.classList.contains('on')) return;
    if (e.key === 'Escape') return close();
    if (e.key === 'Tab') {                         // keep focus inside the dialog
      var f = back.querySelectorAll('a,button'), first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
})();
