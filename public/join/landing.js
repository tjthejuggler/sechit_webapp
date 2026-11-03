// Landing page controller (served at /join/): start a new game (random unique
// code → board host) or join an existing one by code. Uses the shared i18n
// dictionary, so the EN/TR toggle works here too.
import { generateGameCode } from '../shared/net.js';
import { applyI18n, createLangToggle, setLang, t, LANGS } from '../shared/i18n.js';

const saved = localStorage.getItem('sechit.lang');
if (LANGS.includes(saved)) setLang(saved);

document.getElementById('lang-toggle').replaceChildren(createLangToggle());
applyI18n();

// New game: the code is generated here and carried in ?host= — the board page
// then claims the matching PeerJS peer id and shows the QR + share links.
document.getElementById('btn-new-game').addEventListener('click', () => {
  location.href = `../board/?host=${generateGameCode()}`;
});

// Join: normalize the code (uppercase, strip confusion chars) → ../play/?g=.
document.getElementById('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = document.getElementById('join-code-input').value.trim().toUpperCase();
  const code = raw.replace(/[^A-Z0-9]/g, '').replace(/[OIL]/g, (c) => ({ O: '0', I: '1', L: '1' }[c]));
  const err = document.getElementById('join-error');
  if (code.length !== 6) {
    err.textContent = t('app.joinBadCode');
    err.classList.remove('hidden');
    return;
  }
  location.href = `../play/?g=${encodeURIComponent(code)}`;
});
