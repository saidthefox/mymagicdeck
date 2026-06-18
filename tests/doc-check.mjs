#!/usr/bin/env node
// Doc-drift guard. Every backend route registered in api/server.js must be
// documented (by its literal path) in DOCUMENTATION.md. Fails when a route ships
// undocumented — so "the docs match the code" stays *enforced*, not just fixed once.
//
// Forward direction only (route exists → must be documented). The reverse (a doc
// lists a route that no longer exists) is a warn-only heuristic at the bottom.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(resolve(here, '../api/server.js'), 'utf8');
const doc = readFileSync(resolve(here, '../DOCUMENTATION.md'), 'utf8');

let fails = 0, warns = 0;
const ok = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = m => { console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); fails++; };
const warn = m => { console.log('  \x1b[33m! ' + m + '\x1b[0m'); warns++; };

console.log('doc-check: api/server.js routes ↔ DOCUMENTATION.md');

// app.<method>('<path>', …) registrations.
const routeRe = /app\.(get|post|put|patch|delete)\(\s*['"`](\/api\/[^'"`]+)['"`]/g;
const routes = [...server.matchAll(routeRe)].map(m => ({ method: m[1].toUpperCase(), path: m[2] }));
const paths = [...new Set(routes.map(r => r.path))].sort();

// Forward: every live route must appear literally in the doc.
const missing = paths.filter(p => !doc.includes(p));
if (missing.length === 0) ok(`all ${paths.length} routes documented in DOCUMENTATION.md`);
else missing.forEach(p => fail(`route not documented in DOCUMENTATION.md: ${p}`));

// Reverse (warn-only): /api/ paths mentioned in the doc's backtick spans that are
// no longer real routes. Catches stale entries left behind after a route is removed.
const live = new Set(paths);
const docPaths = [...doc.matchAll(/`(\/api\/[^`]+)`/g)].map(m => m[1].split(/[?\s]/)[0]);
for (const p of new Set(docPaths)) {
  if (!live.has(p)) warn(`DOCUMENTATION.md mentions a path with no live route: ${p}`);
}

console.log(`\ndoc-check: ${fails} undocumented route(s), ${warns} warning(s).`);
process.exit(fails ? 1 : 0);
