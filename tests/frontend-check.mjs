#!/usr/bin/env node
// Static checks on the single-file frontend. No browser needed — catches the breakage
// that actually bites when hand-editing index.html. Exit non-zero on any failure.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(here, '../mymagicdeck/index.html');
const html = readFileSync(INDEX, 'utf8');

let fails = 0, warns = 0;
const ok = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = m => { console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); fails++; };
const warn = m => { console.log('  \x1b[33m! ' + m + '\x1b[0m'); warns++; };

console.log('frontend-check: ' + INDEX);

// 1. The inline app script must parse.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts.sort((a, b) => b.length - a.length)[0] || '';
writeFileSync('/tmp/mmd-app.js', app);
try { execSync('node --check /tmp/mmd-app.js', { stdio: 'pipe' }); ok('inline app script parses (node --check)'); }
catch (e) { fail('inline app script FAILS node --check:\n' + (e.stderr || e.stdout || e).toString().split('\n').slice(0, 4).join('\n')); }

// 2. Balanced tags / braces (cheap structural smoke).
const cnt = (s, re) => (html.match(re) || []).length;
const open = cnt(html, /<div\b/g), close = cnt(html, /<\/div>/g);
open === close ? ok(`<div> balanced (${open})`) : fail(`<div> unbalanced: ${open} open / ${close} close`);
// Only the real </script> should be unescaped (sandbox srcdoc escapes its own as <\/script>).
const closeScript = cnt(html, /<\/script>/g);
closeScript === scripts.length ? ok(`</script> count matches (${closeScript})`) : warn(`</script>=${closeScript} vs ${scripts.length} <script> blocks (ok if a string embeds one)`);

// 3. DOM-order gotcha that has bitten us: the guess overlay must exist BEFORE the app script.
const ovIdx = html.indexOf('id="mguess-overlay"');
const scriptIdx = html.indexOf('<script>' + app.slice(0, 40));
(ovIdx > -1 && ovIdx < scriptIdx) ? ok('#mguess-overlay is before the app <script>') : fail('#mguess-overlay must come before the app <script>');

// 4. Required structural ids (the shell + program overlays).
const ids = ['pc-desktop','pc-deskcontent','site-window','site-titlebar','mguess-overlay','mguess-card',
  'modal-battle','modal-hud','modal-sysset','modal-about','modal-bin','search-results','app','header'];
const missing = ids.filter(id => !html.includes('id="' + id + '"'));
missing.length === 0 ? ok('all required element ids present') : fail('missing ids: ' + missing.join(', '));

// 5. Public API + PWA wiring present.
[['window.DeckOS', 'DeckOS API'], ['registerProgram', 'DeckOS.registerProgram'],
 ['serviceWorker', 'service-worker registration'], ['manifest.webmanifest', 'manifest link']]
  .forEach(([needle, label]) => html.includes(needle) ? ok(label + ' wired') : fail(label + ' missing'));

// 6. Hygiene (warn-only): stray console.log / debugger.
const logs = cnt(app, /console\.log\(/g);
if (logs > 8) warn(`${logs} console.log calls in the app script (consider trimming for release)`);
if (/\bdebugger\b/.test(app)) fail('a `debugger` statement is left in the app script');

console.log(`\nfrontend-check: ${fails} failed, ${warns} warning(s).`);
process.exit(fails ? 1 : 0);
