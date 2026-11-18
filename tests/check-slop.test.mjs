// Self-check: node --test tests/check-slop.test.mjs (name the file: node --test <folder> fails on Node 24)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkText, checkPairing, typeChecks, contrast, RULES, rulesFor } from '../check-slop.mjs';

const F = (n) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n), 'utf8');
const rulesHit = (fs_) => new Set(fs_.map((f) => f.rule));

test('seeded HTML: every planted pattern is found', () => {
  const hits = rulesHit(checkText(F('slop.html'), 'html', 'slop.html', { year: 2026 }));
  for (const r of ['gradient-hero', 'gradient-text', 'eyebrow-label', 'side-stripe', 'glow', 'decorative-glass', 'gradient-button', 'large-pills', 'tiny-text', 'low-contrast', 'fake-status', 'floating-widgets', 'scattered-motion', 'emoji-headings', 'hype-copy', 'code-headings', 'fake-proof', 'fake-logos', 'placeholder-content', 'twin-ctas', 'cta-everywhere', 'fake-discount', 'most-popular', 'sparkle-ticker', 'placeholder-labels', 'build-slogans', 'hairline-headline', 'heading-order', 'type-banned-defaults', 'type-tokens', 'em-dashes'])
    assert.ok(hits.has(r), `missed ${r}; found ${[...hits].join(', ')}`);
});
test('clean HTML: no findings', () => {
  const f = checkText(F('clean.html'), 'html', 'clean.html', { year: 2026 });
  assert.deepEqual(f.map((x) => `${x.rule}: ${x.evidence}`), []);
});
test('seeded Markdown report: writing rules fire', () => {
  const hits = rulesHit(checkText(F('slop.md'), 'text', 'slop.md', { year: 2026 }));
  for (const r of ['emoji-headings', 'code-headings', 'hype-copy', 'fake-proof', 'reading-defects', 'placeholder-content']) assert.ok(hits.has(r), `missed ${r}`);
});
test('clean Markdown report: no findings', () => {
  assert.deepEqual(checkText(F('clean.md'), 'text', 'clean.md', { year: 2026 }).map((x) => x.rule), []);
});
test('context filters rules: web-only rules never fire on a document', () => {
  const doc = checkText('<p>Most popular plan</p>', 'html', 'x.html', { context: 'doc' });
  assert.ok(!doc.some((f) => f.rule === 'most-popular'));
  const web = checkText('<p>Most popular plan</p>', 'html', 'x.html', { context: 'web' });
  assert.ok(web.some((f) => f.rule === 'most-popular'));
});
test('contrast maths matches WCAG reference values', () => {
  assert.equal(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }).toFixed(1), '21.0');
  assert.ok(Math.abs(contrast({ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 }) - 4.54) < 0.02);
});
test('every rule names contexts, a check kind and a severity; detectors exist for machine rules', () => {
  for (const r of RULES.rules) {
    assert.ok(r.contexts.length && r.check.length && ['high', 'medium', 'low'].includes(r.severity), r.id);
    for (const c of r.contexts) assert.ok(RULES.contexts[c], `${r.id}: unknown context ${c}`);
    if (r.check.includes('machine')) assert.ok(r.detector, `${r.id}: machine rule without a detector`);
  }
  assert.ok(rulesFor('doc').length < rulesFor('web').length);
});

test('typography: more than three families, missing tokens, flat step and banned defaults are found', () => {
  const css = 'body{font-family:Poppins,sans-serif;font-size:16px;font-weight:400} h1{font-family:"Playfair Display";font-size:18px;font-weight:400} .a{font-family:Lato} .b{font-family:Merriweather}';
  const ids = typeChecks([{ css, file: 't.css' }]).map((f) => f.detector);
  for (const d of ['type-families', 'type-tokens', 'type-scale', 'type-same-weight']) assert.ok(ids.includes(d), `missed ${d}`);
  const hits = rulesHit(checkText(css, 'css', 't.css'));
  assert.ok(hits.has('type-banned-defaults') && hits.has('type-every-font-a-job') && hits.has('type-heading-body-step'));
});
test('typography: a token-based two-family pairing with a clear step passes', () => {
  const css = ':root{--font-display:"Archivo Black",sans-serif;--font-body:"Source Serif 4",serif} body{font-family:var(--font-body);font-size:16px} h1{font-family:var(--font-display);font-size:40px;font-weight:800} h2{font-size:28px}';
  assert.deepEqual(typeChecks([{ css, file: 'ok.css' }]), []);
});
test('typography: the display face on buttons and paragraphs is flagged', () => {
  const hits = rulesHit(checkText(':root{--font-display:"Anton";--font-body:"Lora"} .btn{font-family:var(--font-display)} h1{font-family:var(--font-display)} p{font-family:var(--font-body)}', 'css', 'x.css'));
  assert.ok(hits.has('type-one-personality'));
});
test('pairing record: complete record passes; missing lines and banned defaults fail', () => {
  assert.deepEqual(checkPairing('## Type pairing\n- Display: Archivo Black (--font-display)\n- Body: Source Serif 4 (--font-body)\n- Why: sans display over serif body, heavy over regular, similar x-height, both plain-spoken.'), []);
  assert.equal(checkPairing('# Tokens\nnothing here').length, 1);
  assert.ok(checkPairing('## Type pairing\n- Display: Inter\n- Body: Inter').length >= 2);
  assert.equal(checkPairing('## Type pairing\n- Display: [fill in: family]\n- Body: [fill in]\n- Why: [fill in]').length, 3);
});
test('writing tells fire on copy and stay quiet on the clean report', () => {
  const t = "Here's what nobody tells you about onboarding. It's not a checklist. It's a promise. We delve into it below \u2014 and more.\n\n## Final thoughts\n\nWhat's your take?";
  const hits = rulesHit(checkText(t, 'text', 'post.md', { context: 'copy' }));
  for (const r of ['staged-reveals', 'em-dashes', 'decorative-headings', 'engagement-bait', 'ai-filler-words']) assert.ok(hits.has(r), `missed ${r}; found ${[...hits]}`);
  assert.deepEqual(checkText(F('clean.md'), 'text', 'clean.md', { context: 'doc' }).map((x) => x.rule), []);
});
test('UI contexts skip Markdown working notes', () => {
  assert.deepEqual(checkText(F('slop.md'), 'text', 'notes.md', { context: 'app' }), []);
});
test('rules carry no per-rule source notes (sources are credited once, in SKILL.md and NOTICE)', () => {
  for (const r of RULES.rules) for (const k of ['credit', 'sources', 'from']) assert.ok(!(k in r), `${r.id} has ${k}`);
  assert.equal(new Set(RULES.rules.map((r) => r.id)).size, RULES.rules.length, 'duplicate rule ids');
});

// ---- v2 detectors: each one planted, then a clean counterpart that must stay quiet ----
const ruleHits = (src, kind, context) => rulesHit(checkText(src, kind, `x.${kind === 'text' ? 'md' : kind}`, { context, year: 2026 }));
const plant = (src, kind, context, rule) => assert.ok(ruleHits(src, kind, context).has(rule), `missed ${rule} in: ${src.slice(0, 80)}`);
const quiet = (src, kind, context, rule) => assert.ok(!ruleHits(src, kind, context).has(rule), `${rule} fired on clean: ${src.slice(0, 80)}`);

test('v2 CSS detectors', () => {
  plant('h1{font-family:"JetBrains Mono",monospace}', 'css', 'web', 'mono-costume');
  quiet('pre, code{font-family:"JetBrains Mono",monospace}', 'css', 'web', 'mono-costume');
  plant('.panel{transition: height .3s ease}', 'css', 'app', 'layout-animation');
  plant('@keyframes grow{from{width:0}to{width:100px}}', 'css', 'app', 'layout-animation');
  quiet('.panel{transition: transform .3s ease, opacity .3s}', 'css', 'app', 'layout-animation');
  plant('button:focus{outline:none}', 'css', 'app', 'focus-removed');
  quiet('button:focus{outline:none;box-shadow:0 0 0 2px #1a5fb4}', 'css', 'app', 'focus-removed');
  plant('body{color:#000}', 'css', 'web', 'pure-black');
  quiet('body{color:#1b1a17}', 'css', 'web', 'pure-black');
  plant('mark{background:#fde047}', 'css', 'web', 'marker-highlights');
  plant('html{scroll-snap-type:y mandatory}', 'css', 'web', 'scroll-hijack');
  plant('.reveal{opacity:0;transform:translateY(20px)}', 'css', 'web', 'hidden-at-rest');
  quiet('.reveal.is-visible{opacity:0}', 'css', 'web', 'hidden-at-rest');
  plant('.blob{position:absolute;filter:blur(80px);background:#0ea5e9}', 'css', 'web', 'glow');
});
test('v2 project checks: reduced motion and off-scale values', () => {
  plant('.a{animation:spin 2s linear infinite}@keyframes spin{to{transform:rotate(1turn)}}', 'css', 'web', 'reduced-motion');
  quiet('.a{animation:spin 2s linear infinite}@keyframes spin{to{transform:rotate(1turn)}}@media (prefers-reduced-motion: reduce){.a{animation:none}}', 'css', 'web', 'reduced-motion');
  plant([2, 3, 5, 7, 9, 11].map((n, i) => `.r${i}{border-radius:${n}px}`).join(''), 'css', 'app', 'off-scale-values');
  quiet('.a{border-radius:4px}.b{border-radius:8px}.c{border-radius:var(--r-lg)}', 'css', 'app', 'off-scale-values');
});
test('v2 HTML detectors', () => {
  plant('<button>Submit</button>', 'html', 'app', 'vague-controls');
  quiet('<button>Save draft</button>', 'html', 'app', 'vague-controls');
  plant('<button><svg width="16" height="16"></svg></button>', 'html', 'app', 'unnamed-controls');
  plant('<img src="team.jpg">', 'html', 'web', 'unnamed-controls');
  quiet('<button aria-label="Close dialog"><svg></svg></button><img src="a.jpg" alt="">', 'html', 'app', 'unnamed-controls');
  plant('<div tabindex="3">x</div>', 'html', 'app', 'focus-removed');
  plant('<a href="/a">One →</a><a href="/b">Two →</a><a href="/c">Three →</a>', 'html', 'web', 'arrow-every-cta');
  quiet('<a href="/a">Start a trial →</a><a href="/b">Pricing</a>', 'html', 'web', 'arrow-every-cta');
  plant('<!doctype html><html><head></head><body><p>x</p></body></html>', 'html', 'web', 'page-basics');
  plant('<div class="swiper"><div class="swiper-slide">a</div></div>', 'html', 'web', 'auto-advancing');
  plant('<script src="https://cdn.example/lenis.min.js"></script>', 'html', 'web', 'scroll-hijack');
  plant('<section data-aos="fade-up">x</section>', 'html', 'web', 'hidden-at-rest');
  plant('<span class="counter" data-target="1200">0</span>', 'html', 'web', 'fake-proof');
  plant('<h2>Fast <mark>and</mark> calm</h2>', 'html', 'web', 'marker-highlights');
  plant('<p>Welcome to **our new app**</p>', 'html', 'web', 'placeholder-content');
  plant('<h2>Four projects, four very different problems</h2>', 'html', 'web', 'casing-and-formula');
});
test('v2 copy detectors', () => {
  const cases = {
    'stock-lines': 'Say goodbye to spreadsheets. Booking made simple, at your fingertips.',
    puffery: 'The cafe serves as a meeting point in the heart of the old town.',
    'ing-riders': 'We added file search, highlighting our focus on better workflows.',
    'process-talk': 'Here are 5 reasons to switch. Below, you\'ll find the details.',
    'virtue-words': 'To be honest, our team is genuinely thoughtful about pricing.',
    exclamations: 'We launched today! It is fast! Try it now.',
    'wordy-phrases': 'The tool has the ability to export files due to the fact that people asked.',
    'hedge-stacks': 'This is arguably the best option, and to some extent the cheapest, in many ways.',
    'vague-authority': 'Studies show that most teams waste time in meetings.',
    'stock-transitions': 'Moreover, the plan is cheap. Furthermore, it is quick to set up.',
    'canned-courtesies': 'I hope this email finds you well. Please do not hesitate to reach out.',
    'echo-openers': 'It means fewer calls. It means faster answers. It means happier staff.',
    'em-dashes': 'The plan is cheap - and quick to set up.',
    'placeholder-content': 'Dear {{first_name}}, thanks for joining Northwind.',
    'engagement-bait': 'New release today. #design #ux #product #ai',
  };
  for (const [rule, t] of Object.entries(cases)) plant(t, 'text', 'copy', rule);
  plant(Array.from({ length: 8 }, (_, i) => `- item ${i}`).join('\n'), 'text', 'doc', 'bullet-overuse');
  plant('## How We Measure Customer Satisfaction Today\n\nText.', 'text', 'doc', 'title-case-headings');
  quiet('## How we measure customer satisfaction\n\nText.', 'text', 'doc', 'title-case-headings');
  for (const rule of Object.keys(cases)) quiet(F('clean.md'), 'text', 'doc', rule);
});
test('v1 detectors that had no planted test before v2', () => {
  plant('h1{font-family:Impact,sans-serif}', 'css', 'web', 'default-headline-font');
  plant('.x{color:#64748b}', 'css', 'app', 'framework-defaults');
  plant('.card p{text-overflow:ellipsis;overflow:hidden}', 'css', 'app', 'truncated-cards');
  plant('.band{background:repeating-linear-gradient(45deg,#111 0 2px,#222 2px 6px)}', 'css', 'web', 'fake-texture');
  plant('body{background:#f5ecd7}', 'css', 'web', 'unmotivated-mode');
  plant('<h2>01 Our approach</h2>', 'html', 'web', 'section-numbers');
  plant('.card{box-shadow:6px 6px 0 #111}', 'css', 'web', 'offset-shadow');
  plant('<span>Ask anything ⌘K</span>', 'html', 'app', 'decorative-shortcuts');
  plant('<span class="icon sparkles"></span>', 'html', 'app', 'ai-iconography');
  plant('.bg{background-image:linear-gradient(#ddd 1px,transparent 1px);background-size:24px 24px}', 'css', 'web', 'grid-texture');
  plant('.btn{transition:all .2s}', 'css', 'web', 'transition-all');
  plant('h1{font-size:140px}', 'css', 'web', 'display-type-limits');
  plant('<img src="" alt="Team">', 'html', 'web', 'broken-images');
});
test('every machine rule is planted by name somewhere in this file (no untested rules)', () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const named = (x) => src.includes(`'${x}'`) || src.includes(`${x}:`);
  // type-pairing-record is exercised through checkPairing above
  for (const r of RULES.rules.filter((x) => x.detector && x.id !== 'type-pairing-record')) assert.ok(named(r.id) || named(r.detector) || RULES.rules.some((o) => o.detector === r.detector && named(o.id)), `no test plants ${r.id}`);
});

test('the CLI works when run through a symlink (installed skill path)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-guard-link-'));
  const link = path.join(tmp, 'slop-guard');
  try {
    fs.symlinkSync(path.join(here, '..'), link, 'dir');
    const out = execFileSync(process.execPath, [path.join(link, 'check-slop.mjs'), path.join(here, 'fixtures', 'slop.html'), '--context', 'web', '--year', '2026'], { encoding: 'utf8' });
    assert.match(out, /gradient-text/);
    assert.match(out, /slop-guard: 1 file\(s\), [1-9]\d* finding/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('pairing record: a Why line that starts with a short word still counts', () => {
  assert.deepEqual(checkPairing('## Type pairing\n- Display: Archivo (--font-display)\n- Body: Lora (--font-body)\n- Why: a narrow sans over a book serif.'), []);
});
test('RULES.md matches rules.json, and piped CLI output is complete', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = execFileSync(process.execPath, [path.join(root, 'check-slop.mjs'), '--rules-md'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(out, fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'));
});
