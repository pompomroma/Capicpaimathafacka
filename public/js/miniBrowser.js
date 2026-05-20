const mb = document.getElementById('mini-browser');
const frame = document.getElementById('mb-frame');
const title = document.getElementById('mb-title');
document.getElementById('mb-close').addEventListener('click', () => close());

const ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?igu=1&q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  youtube: { name: 'YouTube', url: 'https://www.youtube.com/results?search_query=' },
  wikipedia: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Special:Search?search=' },
};

function pickEngine(name) {
  const n = (name || '').toLowerCase().replace(/\s+/g, '');
  if (ENGINES[n]) return ENGINES[n];
  if (/ddg/.test(n)) return ENGINES.duckduckgo;
  if (/yt/.test(n)) return ENGINES.youtube;
  if (/wiki/.test(n)) return ENGINES.wikipedia;
  return ENGINES.duckduckgo; // default
}

export function open(engineName, query = '') {
  const eng = pickEngine(engineName);
  title.textContent = eng.name + (query ? ` · ${query}` : '');
  frame.src = eng.url + encodeURIComponent(query);
  mb.hidden = false;
}

export function close() {
  mb.hidden = true;
  frame.src = 'about:blank';
}

export function isOpen() { return !mb.hidden; }
