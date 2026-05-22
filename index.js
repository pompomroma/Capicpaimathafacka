// Replit's Run button auto-detects a Node project's entry point via
// (1) `.replit`, (2) `package.json` scripts.start, (3) `package.json` main,
// (4) `index.js`. When `.replit` is stripped at import, paths 2–4 take over.
// This file makes path 4 work too — so the Run button starts the server
// regardless of which heuristic Replit ends up using.
require('./server.js');
