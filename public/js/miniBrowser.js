const mb = document.getElementById('mini-browser');
const frame = document.getElementById('mb-frame');
const title = document.getElementById('mb-title');
const searchForm = document.getElementById('mb-searchbar');
const searchInput = document.getElementById('mb-input');
document.getElementById('mb-close').addEventListener('click', () => close());

const ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?igu=1&q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  youtube: { name: 'YouTube', url: 'https://www.youtube.com/results?search_query=' },
  wikipedia: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Special:Search?search=' },
};

// Remember which engine is active so re-searches (typed or by voice) reuse it.
let currentEngine = ENGINES.duckduckgo;

function pickEngine(name) {
  const n = (name || '').toLowerCase().replace(/\s+/g, '');
  if (ENGINES[n]) return ENGINES[n];
  if (/ddg/.test(n)) return ENGINES.duckduckgo;
  if (/yt/.test(n)) return ENGINES.youtube;
  if (/wiki/.test(n)) return ENGINES.wikipedia;
  return ENGINES.duckduckgo; // default
}

function navigate(query) {
  const q = (query || '').trim();
  title.textContent = currentEngine.name + (q ? ` · ${q}` : '');
  frame.src = currentEngine.url + encodeURIComponent(q);
  if (searchInput) searchInput.value = q;
}

export function open(engineName, query = '') {
  if (engineName) currentEngine = pickEngine(engineName);
  mb.hidden = false;
  navigate(query);
}

// Run a search in the currently-open engine (opens the browser on the
// default engine first if it is not already showing). No API key / no
// credits — this just points the embedded iframe at a public search URL.
export function search(query) {
  if (mb.hidden) mb.hidden = false;
  navigate(query);
  // Surface the popup and focus the box so the user can keep typing.
  try { searchInput?.focus(); } catch {}
}

export function close() {
  mb.hidden = true;
  frame.src = 'about:blank';
}

export function isOpen() { return !mb.hidden; }

// Typed-search: the user can type directly into the popup's own search bar
// and hit Enter / "go" to load results in the embedded browser.
if (searchForm) {
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = (searchInput?.value || '').trim();
    if (q) search(q);
  });
}
