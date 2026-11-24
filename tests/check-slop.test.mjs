// Self-check: node --test tests/check-slop.test.mjs (name the file: node --test <folder> fails on Node 24)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkText, checkPaths, checkPairing, typeChecks, contrast, RULES, rulesFor, maskProse, loadProfile, applyPolicy, trendScore, proseWordCount, readingGrade, buildVoice, compareVoice, factCheck, diffFindings, loadVoice } from '../check-slop.mjs';

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
// ---- v2.1: the code context, interface practice, prose tells and quote marks ----
const codeHits = (src, file) => rulesHit(checkText(src, 'code', file, { context: 'code' }));
const plantCode = (src, file, rule) => assert.ok(codeHits(src, file).has(rule), `missed ${rule} in ${file}: ${src.slice(0, 80)}`);
const quietCode = (src, file, rule) => assert.ok(!codeHits(src, file).has(rule), `${rule} fired on clean ${file}: ${src.slice(0, 80)}`);

test('v2.1 code detectors: JavaScript and TypeScript', () => {
  plantCode('// increment the counter\ncount++;\n', 'a.js', 'code-narrating-comments');
  quietCode('// retry once: the upstream API drops the first call after idle\ncount++;\n', 'a.js', 'code-narrating-comments');
  plantCode('function save(x) {\n  console.log("saving", x);\n  return store.put(x);\n}\n', 'a.js', 'code-debug-output');
  plantCode('if (x) {\n  debugger;\n}\n', 'a.js', 'code-debug-output');
  quietCode('#!/usr/bin/env node\nconsole.log("usage: tool <file>");\n', 'cli.js', 'code-debug-output');
  plantCode('// const old = load();\n// old.run();\nrun();\n', 'a.js', 'code-dead-code');
  plantCode('function f(a) {\n  return a;\n  a++;\n}\n', 'a.js', 'code-dead-code');
  plantCode('if (false) {\n  run();\n}\n', 'a.js', 'code-dead-code');
  quietCode('// Load the saved draft first, so the form never opens empty.\nrun();\n', 'a.js', 'code-dead-code');
  plantCode('try {\n  run();\n} catch (e) {}\n', 'a.js', 'code-swallowed-errors');
  plantCode('fetchAll().catch(() => {});\n', 'a.js', 'code-swallowed-errors');
  plantCode('try { run(); } catch (err) { console.error(err); }\n', 'a.js', 'code-swallowed-errors');
  quietCode('try {\n  fs.rmSync(tmp);\n} catch {\n  // already gone: nothing to clean up\n}\n', 'a.js', 'code-swallowed-errors');
  plantCode('function getUser(id) {\n  return fetchUser(id);\n}\n', 'a.js', 'code-needless-wrappers');
  plantCode('const load = (id, opts) => loadRecord(id, opts);\n', 'a.js', 'code-needless-wrappers');
  quietCode('function getUser(id) {\n  return fetchUser(id, { cache: true });\n}\n', 'a.js', 'code-needless-wrappers');
  plantCode('const data = await res.json();\nfunction handleStuff() { return 1; }\n', 'a.js', 'code-generic-names');
  quietCode('const overdueLoans = await res.json();\n', 'a.js', 'code-generic-names');
  plantCode('const user = payload as any;\n', 'a.ts', 'code-redundant-casts');
  plantCode('const n = el as unknown as HTMLInputElement;\n', 'a.ts', 'code-redundant-casts');
  plantCode('const ok = Boolean(!!flag);\n', 'a.js', 'code-redundant-casts');
  quietCode('const ok = Boolean(flag);\n', 'a.js', 'code-redundant-casts');
  plantCode('export function parse(input: any): any[] { return [input]; }\n', 'a.ts', 'code-loose-types');
  quietCode('export function parse(input: unknown): string[] { return [String(input)]; }\n', 'a.ts', 'code-loose-types');
  plantCode('// TODO: add error handling\nrun();\n', 'a.js', 'code-todo-residue');
  plantCode('function f() {\n  // ... rest of the code here\n}\n', 'a.js', 'code-todo-residue');
  plantCode('export function pay() {\n  throw new Error("Not implemented");\n}\n', 'a.js', 'code-todo-residue');
  quietCode('// TODO(maria): drop the v1 fallback after the 2026-12 migration, see #142\nrun();\n', 'a.js', 'code-todo-residue');
  plantCode(["const a = 'one';", "const b = 'two';", "const c = 'three';", "const d = 'four';", "const e = 'five';", 'const f = "six";', 'const g = "seven";', 'const h = "eight";', 'const i = "nine";', 'const j = "ten";'].join('\n'), 'a.js', 'code-style-drift');
  plantCode('var total = 0;\nconst a = 1;\nconst b = 2;\nlet c = 3;\n', 'a.js', 'code-style-drift');
  quietCode("const a = 'one';\nconst b = 'two';\nconst c = `three ${a}`;\n", 'a.js', 'code-style-drift');
  plantCode("import { readFile, writeFile } from 'node:fs';\nreadFile('x');\n", 'a.js', 'code-unused-imports');
  quietCode("import { readFile } from 'node:fs';\nimport './styles.css';\nconst t = `${readFile('x')}`;\n", 'a.js', 'code-unused-imports');
  plantCode('function f(a) {\n  if (a) {\n    for (const b of a) {\n      if (b) {\n        while (b.next) {\n          try {\n            if (b.ok) {\n              run(b);\n            }\n          } finally {}\n        }\n      }\n    }\n  }\n}\n', 'a.js', 'code-deep-nesting');
  plantCode('/**\n * Gets the name.\n * This function returns the name.\n * It reads the name field.\n * The name is a string.\n * @returns {string} the name\n */\nfunction getName() { return this.name; }\n', 'a.js', 'code-docstring-bloat');
  plantCode('throw new Error("Something went wrong");\n', 'a.js', 'code-generic-errors');
  quietCode('throw new Error("LOAN_NOT_FOUND: no loan with that id. Check the link or search by member.");\n', 'a.js', 'code-generic-errors');
});
test('v2.1 code detectors: Python', () => {
  plantCode('# create user\nuser = User()\n', 'a.py', 'code-narrating-comments');
  plantCode('def f():\n    breakpoint()\n', 'a.py', 'code-debug-output');
  plantCode('def f(x):\n    print("here", x)\n    return x\n', 'a.py', 'code-debug-output');
  quietCode('def main():\n    print(f"Copied {n} files")\n', 'a.py', 'code-debug-output');
  plantCode('# old = load()\n# return old\nrun()\n', 'a.py', 'code-dead-code');
  plantCode('def f(x):\n    return x\n    x += 1\n', 'a.py', 'code-dead-code');
  plantCode('try:\n    run()\nexcept:\n    pass\n', 'a.py', 'code-swallowed-errors');
  plantCode('try:\n    run()\nexcept Exception:\n    pass\n', 'a.py', 'code-swallowed-errors');
  quietCode('try:\n    os.remove(tmp)\nexcept FileNotFoundError:\n    pass  # already gone, nothing to clean up\n', 'a.py', 'code-swallowed-errors');
  plantCode('def get_user(user_id):\n    return fetch_user(user_id)\n', 'a.py', 'code-needless-wrappers');
  plantCode('result = compute()\n', 'a.py', 'code-generic-names');
  plantCode('name = str("fixed")\n', 'a.py', 'code-redundant-casts');
  plantCode('from typing import Any\ndef f(x: Any) -> Any:\n    return x\n', 'a.py', 'code-loose-types');
  plantCode('def f():\n    pass  # TODO: implement this\n', 'a.py', 'code-todo-residue');
  plantCode('import os\nimport sys\nprint(sys.argv)\n', 'a.py', 'code-unused-imports');
  quietCode('import os\nfrom typing import List\ndef f(p: List[str]) -> str:\n    return os.path.join(*p)\n', 'a.py', 'code-unused-imports');
  plantCode('def get_name(self):\n    """Get the name.\n\n    This returns the name.\n    It reads the field.\n    The name is a string.\n    """\n    return self.name\n', 'a.py', 'code-docstring-bloat');
  plantCode('raise ValueError("Invalid input")\n', 'a.py', 'code-generic-errors');
  plantCode('def loadUsers():\n    pass\ndef saveUsers():\n    pass\ndef load_items():\n    pass\ndef save_items():\n    pass\n', 'a.py', 'code-style-drift');
  plantCode('def f(a):\n    if a:\n        for b in a:\n            if b:\n                while b.next:\n                    if b.ok:\n                        run(b)\n', 'a.py', 'code-deep-nesting');
});
test('v2.1 code context: routing, scratch files and the --context code list', () => {
  const notes = checkText('# Plan\n- step one', 'text', 'NOTES.md', { context: 'code' });
  assert.ok(notes.some((f) => f.rule === 'code-scratch-files'), 'scratch-file missed');
  assert.deepEqual(checkText('# Readme\nHow to run it.', 'text', 'README.md', { context: 'code' }), []);
  assert.deepEqual(checkText('console.log(1)', 'code', 'a.js', { context: 'web' }), [], 'code is checked only in the code context');
  assert.deepEqual(checkText('<p>Hi</p>', 'html', 'a.html', { context: 'code' }), [], 'pages are skipped in the code context');
  assert.ok(rulesFor('code').length >= 15 && rulesFor('code').every((r) => r.contexts.includes('code')));
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const list = execFileSync(process.execPath, [path.join(root, 'check-slop.mjs'), '--list', '--context', 'code'], { encoding: 'utf8' });
  assert.match(list, /code-swallowed-errors/);
  assert.match(list, /Code: it builds/);
});
// Vendored copies carry tests/ but not examples/, so this one runs only where the examples are.
const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'code');
test('v2.1 code: the clean example passes and the sloppy one is caught', { skip: !fs.existsSync(EXAMPLES) && 'examples/ not present (vendored copy)' }, () => {
  const clean = path.join(EXAMPLES, 'clean.js'), sloppy = path.join(EXAMPLES, 'sloppy.js');
  assert.deepEqual(checkText(fs.readFileSync(clean, 'utf8'), 'code', clean, { context: 'code' }).map((f) => `${f.rule}: ${f.evidence}`), []);
  assert.ok(rulesHit(checkText(fs.readFileSync(sloppy, 'utf8'), 'code', sloppy, { context: 'code' })).size >= 10);
});

test('v2.1 interface detectors', () => {
  plant('<a href="#">Pricing</a>', 'html', 'web', 'dead-controls');
  plant('<a href="javascript:void(0)">Open</a>', 'html', 'app', 'dead-controls');
  quiet('<a href="#main">Skip to content</a><a href="/pricing">Pricing</a>', 'html', 'web', 'dead-controls');
  plant('<nav><a href="/blog">Blog (coming soon)</a></nav>', 'html', 'web', 'placeholder-pages');
  plant('<p class="error">Something went wrong.</p>', 'html', 'app', 'generic-status-copy');
  plant('<p>No items to display</p>', 'html', 'app', 'generic-status-copy');
  quiet('<p class="error">Could not save: you are offline. Your draft is kept on this device.</p>', 'html', 'app', 'generic-status-copy');
  plant('.icon-btn{width:28px;height:28px}', 'css', 'app', 'small-touch-targets');
  quiet('.icon-btn{width:28px;height:28px;min-width:44px;min-height:44px}', 'css', 'app', 'small-touch-targets');
  quiet('.toggle .slider::before{width:14px;height:14px}', 'css', 'app', 'small-touch-targets');
  plant('<input type="text" id="q">', 'html', 'app', 'unlabelled-fields');
  plant('<select name="size"><option>S</option></select>', 'html', 'app', 'unlabelled-fields');
  quiet('<label for="q">Search loans</label><input type="search" id="q">', 'html', 'app', 'unlabelled-fields');
  plant('<label for="e">Email</label><input type="text" id="e" name="email">', 'html', 'web', 'field-types-autofill');
  plant('<label>Name <input type="text" name="name" autocomplete="off"></label>', 'html', 'web', 'field-types-autofill');
  quiet('<label for="e">Email</label><input type="email" id="e" name="email" autocomplete="email">', 'html', 'web', 'field-types-autofill');
  plant('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">', 'html', 'web', 'zoom-blocked');
  quiet('<meta name="viewport" content="width=device-width, initial-scale=1">', 'html', 'web', 'zoom-blocked');
  plant('input{font-size:14px}', 'css', 'app', 'small-input-text');
  quiet('input{font-size:16px}', 'css', 'app', 'small-input-text');
  plant('<nav class="bottom-nav">' + ['Home', 'Search', 'Loans', 'Tools', 'Members', 'Settings'].map((t) => `<a href="/${t}">${t}</a>`).join('') + '</nav>', 'html', 'app', 'nav-limits');
  plant('<nav><a href="/"><svg width="20" height="20"></svg></a></nav>', 'html', 'app', 'nav-limits');
  quiet('<nav class="bottom-nav"><a href="/">Home</a><a href="/loans">Loans</a></nav>', 'html', 'app', 'nav-limits');
  plant('<canvas id="loans"></canvas>', 'html', 'app', 'chart-text-alternative');
  plant('<svg class="chart" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>', 'html', 'web', 'chart-text-alternative');
  quiet('<svg class="chart" role="img" aria-label="Loans per week, rising from 12 to 30"><path d="M0 0"/></svg>', 'html', 'web', 'chart-text-alternative');
  plant('<img src="drill.jpg" alt="A cordless drill">', 'html', 'web', 'layout-shift');
  plant('@font-face{font-family:"Archivo";src:url(a.woff2)}', 'css', 'web', 'layout-shift');
  quiet('<img src="drill.jpg" alt="A cordless drill" width="800" height="600">', 'html', 'web', 'layout-shift');
  plant('.hero{height:100vh}', 'css', 'web', 'mobile-viewport-units');
  quiet('.hero{height:100vh;height:100dvh}', 'css', 'web', 'mobile-viewport-units');
  quiet('.page{min-height:100vh}', 'css', 'web', 'mobile-viewport-units');
  plant('.modal{z-index:9999}', 'css', 'app', 'z-index-scale');
  quiet('.modal{z-index:var(--layer-modal)}', 'css', 'app', 'z-index-scale');
  plant('.row .actions{opacity:0}.row:hover .actions{opacity:1}', 'css', 'app', 'hover-only');
  quiet('.row .actions{opacity:0}.row:hover .actions,.row:focus-within .actions{opacity:1}', 'css', 'app', 'hover-only');
  plant('.menu{transition:opacity .8s ease}', 'css', 'app', 'slow-ui-motion');
  quiet('.menu{transition:opacity .2s ease}', 'css', 'app', 'slow-ui-motion');
  quiet('html, body{transition:background-color 600ms ease}', 'css', 'web', 'slow-ui-motion');
  plant('<p>Due back on 03/04/2026.</p>', 'html', 'app', 'ambiguous-dates');
  quiet('<p>Due back on 3 April 2026.</p>', 'html', 'app', 'ambiguous-dates');
});
test('v2.1 quote marks: straight quotes in visible HTML text only, never in code, attributes or Markdown', () => {
  plant('<p>It\'s open on Saturdays.</p>', 'html', 'web', 'straight-quotes');
  plant('<p>Members call it "the shed".</p>', 'html', 'doc', 'straight-quotes');
  quiet('<p class="note" data-x=\'1\'>It\u2019s open on \u201cSaturdays\u201d.</p><pre>echo "it\'s fine"</pre><code>x = \'a\'</code>', 'html', 'web', 'straight-quotes');
  quiet('It\'s open on "Saturdays".', 'text', 'doc', 'straight-quotes');
  // curly quotes do not hide other tells from the copy checks
  plant('It\u2019s not a checklist. It\u2019s a promise.', 'text', 'copy', 'staged-reveals');
});
test('v2.1 prose detectors', () => {
  const cases = {
    'false-ranges': 'We help everything from startups to global enterprises.',
    'bold-overuse': 'We cut **costs**, sped up **delivery** and kept **quality** high.',
    'cutoff-disclaimers': 'As of my last update, the library had 300 tools.',
    'generic-endings': 'The library opens next month. Only time will tell.',
    'plain-words': 'We utilize volunteers in order to keep costs down.',
    'promo-adjectives': 'A vibrant space with a stunning view.',
    'formulaic-challenges': 'Despite these challenges, the library continues to thrive.',
  };
  for (const [rule, t] of Object.entries(cases)) plant(t, 'text', 'doc', rule);
  for (const rule of Object.keys(cases)) quiet(F('clean.md'), 'text', 'doc', rule);
  quiet('Loans rose from 12 to 30 a week between March and May.', 'text', 'doc', 'false-ranges');
});

test('every machine rule is planted by name somewhere in this file (no untested rules)', () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const named = (x) => src.includes(`'${x}'`) || src.includes(`${x}:`);
  // type-pairing-record is exercised through checkPairing above
  for (const r of RULES.rules.filter((x) => x.detector && x.id !== 'type-pairing-record')) assert.ok(named(r.id) || named(r.detector) || RULES.rules.some((o) => o.detector === r.detector && named(o.id)), `no test plants ${r.id}`);
});

test('the CLI works when run through a symlink (installed skill path)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-guard-link-'));
  const link = path.join(linkDir, 'slop-guard');
  try {
    fs.symlinkSync(path.join(here, '..'), link, 'dir');
    const out = execFileSync(process.execPath, [path.join(link, 'check-slop.mjs'), path.join(here, 'fixtures', 'slop.html'), '--context', 'web', '--year', '2026'], { encoding: 'utf8' });
    assert.match(out, /gradient-text/);
    assert.match(out, /slop-guard: 1 file\(s\), [1-9]\d* finding/);
  } finally { fs.rmSync(linkDir, { recursive: true, force: true }); }
});
test('pairing record: a Why line that starts with a short word still counts', () => {
  assert.deepEqual(checkPairing('## Type pairing\n- Display: Archivo (--font-display)\n- Body: Lora (--font-body)\n- Why: a narrow sans over a book serif.'), []);
});
test('RULES.md matches rules.json, and piped CLI output is complete', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = execFileSync(process.execPath, [path.join(root, 'check-slop.mjs'), '--rules-md'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(out, fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'));
});

// ---- v2.2: masking, literal sense, rhetoric and rhythm, genres, profiles, hard and soft, score ----
const tmp = (name, content) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-guard-')); const f = path.join(d, name); fs.writeFileSync(f, content); return f; };
const PD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'public-domain');

test('v2.2 masking: quotes, code, blockquotes and marked regions are not checked as prose', () => {
  assert.equal(maskProse('a `seamless` b').length, 'a `seamless` b'.length);
  quiet('The brief said "unlock your potential" and we refused it.', 'text', 'copy', 'hype-copy');
  quiet("Avoid lines like 'the future looks bright' in reports.", 'text', 'doc', 'generic-endings');
  quiet('> Studies show this is seamless.\n\nWe disagree.', 'text', 'doc', 'vague-authority');
  quiet('Run:\n\n```\nnpm run seamless\n```\n', 'text', 'doc', 'hype-copy');
  quiet('<p>Use <code>elevate()</code> to raise the card.</p>', 'html', 'web', 'hype-copy');
  quiet('<!-- slop-guard: off -->\nSeamless, elevated, revolutionary.\n<!-- slop-guard: on -->\nPlain text.', 'text', 'copy', 'hype-copy');
  assert.deepEqual(checkText('<!-- slop-guard: ignore-file -->\nUnlock your potential!', 'text', 'x.md', { context: 'copy' }), []);
  plant('It’s seamless and it’s quick to set up.', 'text', 'copy', 'hype-copy');
  plant('It\'s a seamless setup for everyone.', 'text', 'copy', 'hype-copy');
});
test('v2.2 literal-sense guards clear literal uses and keep the metaphors', () => {
  quiet('Enter the company name exactly as it appears on the invoice.', 'text', 'doc', 'placeholder-content');
  plant('Welcome to Company Name, the home of great tools.', 'text', 'copy', 'placeholder-content');
  quiet('Contoso is a pseudonym for the client, used with their permission.', 'text', 'doc', 'placeholder-content');
  plant('Our partners include Contoso and Fabrikam.', 'text', 'doc', 'placeholder-content');
  quiet('Patients with elevated blood pressure were excluded.', 'text', 'doc', 'hype-copy');
  plant('We elevate your brand with every post.', 'text', 'copy', 'hype-copy');
  quiet('The pipes are seamless steel tubes rated to 300 bar.', 'text', 'doc', 'hype-copy');
  quiet('The flywheel stores energy from the engine between strokes.', 'text', 'doc', 'plain-words');
  plant('Referrals are our growth flywheel.', 'text', 'copy', 'plain-words');
  quiet('Studies show a 12% drop in readmissions (Lee et al., 2021).', 'text', 'doc', 'vague-authority');
  plant('Studies show that people prefer shorter forms.', 'text', 'doc', 'vague-authority');
  quiet('The French Revolution reshaped land ownership.', 'text', 'doc', 'hype-copy');
});
test('v2.2 rhetoric and rhythm detectors', () => {
  plant('It is a system, not a tool. It is a partner, not a vendor. It is a habit, not a hack. We built it slowly.', 'text', 'copy', 'not-slogans');
  quiet('Send the form to the clinic, not the hospital.', 'text', 'copy', 'not-slogans');
  plant("Here's the thing: most teams skip the brief.", 'text', 'copy', 'colon-reveals');
  quiet('The thing to check first is the brief.', 'text', 'copy', 'colon-reveals');
  plant('Ever wondered why meetings run long?\n\nThey have no agenda.', 'text', 'copy', 'hook-formulas');
  quiet('Meetings run long when they have no agenda.', 'text', 'copy', 'hook-formulas');
  plant('The result? A faster team. The cost? Almost nothing. We shipped it in May.', 'text', 'copy', 'self-answered-questions');
  quiet('What changed in May? We moved the review to Tuesdays, which gave the team two clear days to fix what it found.', 'text', 'copy', 'self-answered-questions');
  plant(['We shipped it.', 'Nobody noticed.', 'Then the numbers moved.', 'The team met on Monday to look at what had changed and why it had taken so long to show up in the weekly report.', 'Speed matters.', 'Ship it.'].join('\n\n'), 'text', 'copy', 'punch-paragraphs');
  plant('We kept the weekly review board. The weekly review board met on Monday. Nobody missed the weekly review board. Then the weekly review board stopped.', 'text', 'doc', 'repeated-phrases');
  quiet(fs.readFileSync(path.join(PD, 'dickens.txt'), 'utf8'), 'text', 'doc', 'repeated-phrases');
  const even = Array.from({ length: 14 }, (_, i) => `The ${['team', 'group', 'crew', 'staff'][i % 4]} reviewed the plan for the new branch on day ${i + 1}.`).join(' ');
  plant(even, 'text', 'doc', 'uniform-rhythm');
  plant('It is fast, simple and secure. Teams find it clear, calm and useful. Setup is quick, cheap and easy. Support is kind, quick and human.', 'text', 'copy', 'rule-of-three');
  quiet('Bring a drill, a level and a tape measure.', 'text', 'copy', 'rule-of-three');
});
test('v2.2 false-alarm set: public-domain prose raises nothing at medium or above, and no hard finding', () => {
  for (const f of fs.readdirSync(PD).filter((x) => x.endsWith('.txt'))) for (const context of ['doc', 'copy']) {
    const found = checkText(fs.readFileSync(path.join(PD, f), 'utf8'), 'text', f, { context, year: 2026 });
    assert.deepEqual(found.filter((x) => x.kind === 'hard' || x.severity !== 'low').map((x) => `${x.rule}: ${x.evidence}`), [], `${f} (${context})`);
  }
});
test('v2.2 every rule is hard or soft, every high rule is hard, and genres name real rules', () => {
  for (const r of RULES.rules) { assert.ok(['hard', 'soft'].includes(r.kind), r.id); if (r.severity === 'high') assert.equal(r.kind, 'hard', r.id); }
  const ids = new Set(RULES.rules.map((r) => r.id));
  for (const [g, v] of Object.entries(RULES.genres)) for (const id of [...v.off, ...v.lower]) assert.ok(ids.has(id), `${g}: ${id}`);
});
test('v2.2 genres: allowances switch soft rules off or lower them, never hard ones', () => {
  const t = 'This is arguably the right term, to some extent, in many ways. Enter {{client_name}} here.';
  const plain = rulesHit(checkText(t, 'text', 'x.md', { context: 'doc' }));
  const legal = rulesHit(checkText(t, 'text', 'x.md', { context: 'doc', genre: 'legal' }));
  assert.ok(plain.has('hedge-stacks') && !legal.has('hedge-stacks'));
  assert.ok(legal.has('placeholder-content'), 'a genre must not hide a hard finding');
  const lowered = checkText('We utilize volunteers.', 'text', 'x.md', { context: 'doc', genre: 'clinical' }).find((x) => x.rule === 'plain-words');
  assert.equal(lowered.severity, 'low');
});
test('v2.2 profiles: off, severity, allow and ban; hard rules need allowHardOff; bad profiles fail clearly', () => {
  const f = tmp('p.json', JSON.stringify({ name: 'house', off: ['exclamations', 'placeholder-content'], severity: { 'hype-copy': 'low' }, allow: ['Contoso'], ban: [{ phrase: 'synergy', instead: 'say who works with whom' }, 'circle back'] }));
  const profile = loadProfile(f);
  const found = checkText('We launched! It is seamless! Contoso joined. Let us circle back on synergy. Hi {{name}}.', 'text', 'x.md', { context: 'copy', profile });
  const ids = rulesHit(found);
  assert.ok(!ids.has('exclamations'));
  assert.ok(ids.has('placeholder-content'), 'hard rule stays on without allowHardOff');
  assert.ok(!found.some((x) => /Contoso/.test(x.evidence)));
  assert.equal(found.find((x) => x.rule === 'hype-copy').severity, 'low');
  assert.equal(found.filter((x) => x.rule === 'profile-words').length, 2);
  assert.match(found.find((x) => x.rule === 'profile-words' && x.evidence === 'synergy').message, /say who works with whom/);
  const loose = loadProfile(tmp('q.json', JSON.stringify({ off: ['placeholder-content'], allowHardOff: true })));
  assert.ok(!rulesHit(checkText('Hi {{name}}.', 'text', 'x.md', { context: 'copy', profile: loose })).has('placeholder-content'));
  assert.throws(() => loadProfile(tmp('r.json', '{"offf": []}')), /unknown key offf/);
  assert.throws(() => loadProfile(tmp('s.json', '{"off": ["no-such-rule"]}')), /"no-such-rule", which does not exist/);
  assert.throws(() => loadProfile(tmp('t.json', '{"genre": "poetry"}')), /unknown genre "poetry"/);
  // vendored copies carry tests/ but not profiles/
  const PROFILES = path.join(PD, '..', '..', '..', 'profiles');
  if (fs.existsSync(PROFILES)) for (const ex of fs.readdirSync(PROFILES).filter((x) => x.endsWith('.json'))) loadProfile(path.join(PROFILES, ex));
});
test('v2.2 trend score: skips short texts, drops as findings pile up, and the CLI reports and records it', () => {
  assert.equal(trendScore([{ severity: 'high' }], 100), null);
  assert.equal(trendScore([], 600), 100);
  assert.ok(trendScore([{ severity: 'medium' }], 600) > trendScore([{ severity: 'medium' }, { severity: 'high' }], 600));
  assert.ok(proseWordCount('# Title\n\nOne two three.\n\n```\nnot prose here\n```', 'text') === 3);
  const walden = fs.readFileSync(path.join(PD, 'walden.txt'), 'utf8');
  const r = checkPaths([tmp('walden.md', walden)], { context: 'doc' });
  assert.equal(r.scores.length, 1); assert.ok(r.score >= 90, `score ${r.score}`);
  const hist = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slop-guard-h-')), 'h.jsonl');
  const file = tmp('post.md', `${walden}\n\nUnlock your potential with our seamless, revolutionary platform!`);
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const run = () => execFileSync(process.execPath, [path.join(root, 'check-slop.mjs'), file, '--context', 'copy', '--history', hist], { encoding: 'utf8' });
  assert.match(run(), /Trend score: \d+\/100\./);
  assert.match(run(), /\(\+0 since last run\)/);
  assert.equal(fs.readFileSync(hist, 'utf8').trim().split('\n').length, 2);
});
test('v2.2 CLI: --fail-on hard and --genre, with unknown values refused', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cli = (...a) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(root, 'check-slop.mjs'), ...a], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: e.stdout + e.stderr }; } };
  const soft = tmp('soft.md', 'It is seamless.');
  const hard = tmp('hard.md', 'Dear {{first_name}}, welcome.');
  assert.equal(cli(soft, '--context', 'copy', '--fail-on', 'hard').code, 0);
  assert.equal(cli(soft, '--context', 'copy', '--fail-on', 'medium').code, 1);
  assert.equal(cli(hard, '--context', 'copy', '--fail-on', 'hard').code, 1);
  assert.match(cli(soft, '--genre', 'poetry').out, /Unknown genre "poetry"/);
  assert.match(cli(soft, '--fail-on', 'sometimes').out, /--fail-on takes hard, high, medium or low/);
  assert.match(cli('--genres').out, /legal: Contracts/);
});

// ---- v2.3: arrangement of ideas, repetition across files, unsourced claims, text outside the body ----
const para = (seed, n = 95) => Array.from({ length: n }, (_, i) => ['library', 'volunteers', 'borrowers', 'tools', 'opening', 'hours', 'deposit', 'repairs', 'ladders', 'drills', 'members', 'weekend'][(i * 7 + seed) % 12]).join(' ');
test('v2.3 arrangement: an ending that restates the opening, and preview-then-recap structure', () => {
  const opening = 'Our tool library lends drills, ladders and sanders to members for a small yearly fee, run by volunteers on weekends.';
  const middle = [1, 2, 3].map((i) => `${para(i)}.`).join('\n\n');
  plant(`${opening}\n\n${middle}\n\nIn short, our tool library lends drills, ladders and sanders to members for a small yearly fee, run by volunteers.`, 'text', 'doc', 'recap-endings');
  quiet(`${opening}\n\n${middle}\n\nNext month we add a repair bench on Saturdays; members can book it from the 3rd.`, 'text', 'doc', 'recap-endings');
  const doc = `# Guide\n\nThis guide covers borrowing, returns and repairs at the tool library, run by volunteers for members.\n\n## Borrowing\n\n${para(1)}.\n\n## Returns\n\n${para(2)}.\n\n## Repairs\n\n${para(3)}.\n\nIn short, this guide covered borrowing, returns and repairs at the tool library, run by volunteers for members.`;
  plant(doc, 'text', 'doc', 'signposted-structure');
  for (const f of fs.readdirSync(PD).filter((x) => x.endsWith('.txt'))) for (const r of ['recap-endings', 'signposted-structure']) quiet(fs.readFileSync(path.join(PD, f), 'utf8'), 'text', 'doc', r);
});
test('v2.3 unsourced claims: superlatives, proof words and figures need a source', () => {
  plant('We are the fastest booking platform in Malaysia.', 'text', 'copy', 'unsourced-claims');
  plant('Our method is proven to cut churn.', 'text', 'copy', 'unsourced-claims');
  plant('Teams answer tickets 40% faster with it.', 'text', 'copy', 'unsourced-claims');
  quiet('Teams answered tickets 40% faster in the pilot (Lee et al., 2024).', 'text', 'doc', 'unsourced-claims');
  quiet('According to Statistics Malaysia, 31% of households rent.', 'text', 'doc', 'unsourced-claims');
  quiet('Loans rose 12% in May.\n\n## Sources\n\n- Library ledger, May 2026.', 'text', 'doc', 'unsourced-claims');
  quiet('It was the best of times, it was the worst of times.', 'text', 'doc', 'unsourced-claims');
  quiet('<p>Response times fell 30% (<a href="https://example.org/report">county report</a>).</p>', 'html', 'web', 'unsourced-claims');
});
test('v2.3 repeated across files: the same sentence on three pages, but not in navigation or footers', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-guard-site-'));
  const line = 'We help ambitious teams unlock their full potential every single day.';
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(d, `${n}.html`), `<html lang="en"><head><title>${n}</title></head><body><nav><a href="/">Home of the tool library and its many volunteers</a></nav><main><p>${line}</p><p>Page ${n} lists ${n} things.</p></main><footer><p>Run by volunteers in Petaling Jaya since the spring of 2019.</p></footer></body></html>`);
  const found = checkPaths([d], { context: 'web' }).findings.filter((f) => f.rule === 'repeated-across-files');
  assert.equal(found.length, 1); assert.match(found[0].evidence, /ambitious teams/);
  assert.equal(checkPaths([path.join(d, 'a.html'), path.join(d, 'b.html')], { context: 'web' }).findings.filter((f) => f.rule === 'repeated-across-files').length, 0);
});
test('v2.3 text outside the page body: alt text, meta descriptions, SVG text, JSX and stdin', () => {
  plant('<img src="a.png" alt="A seamless, revolutionary dashboard" width="10" height="10">', 'html', 'web', 'hype-copy');
  plant('<html lang="en"><head><title>x</title><meta name="description" content="Unlock your potential with our platform."></head><body><p>Hours.</p></body></html>', 'html', 'web', 'hype-copy');
  assert.ok(rulesHit(checkText('<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="1">Revolutionary insights at your fingertips</text></svg>', 'svg', 'chart.svg')).has('stock-lines'));
  const jsx = 'export const Hero = () => (<section><h1>Supercharge your workflow</h1><img src="a.png" alt="Team photo" /></section>);\n';
  assert.ok(rulesHit(checkText(jsx, 'code', 'Hero.jsx', { context: 'code' })).has('hype-copy'));
  assert.ok(!rulesHit(checkText(jsx.replace('Supercharge your workflow', 'Borrow a drill for the weekend'), 'code', 'Hero.jsx', { context: 'code' })).has('hype-copy'));
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = execFileSync(process.execPath, [path.join(root, 'check-slop.mjs'), '--stdin', '--context', 'doc'], { input: 'Refactor: a seamless, game-changing update to the parser.\n', encoding: 'utf8' });
  assert.match(out, /hype-copy\s+<stdin>:1/);
});

// ---- v2.4: reading grade, spelling, voice, diff with fact check ----
const CASUAL = [
  "I took the new bus to work today. It's quicker than I thought. I didn't miss the car at all, and I read half a book on the way. The driver knew every stop by name. I'll try the early one tomorrow. My neighbour says it's always full by eight, so I'll leave at seven. We'll see. If it works for a week, I'm selling the car. That's the plan, anyway. I can't think of a good reason not to, and the money's better spent on the kids' swimming lessons.",
  "I fixed the gate this morning. It took me an hour, not ten minutes. I'd bought the wrong screws, of course. My daughter laughed and handed me the right ones from the shed. She's twelve and she's already better at this than I am. We painted it blue after lunch. It's a bit bright. I like it, though, and the dog doesn't care. Next week I'll do the fence. I've said that before. This time I mean it, and I've bought the paint already.",
  "I cooked for eight people on Sunday. I'd never done that before. It's harder than it looks on television. The rice burned, the curry was fine, and nobody noticed the rice. My brother brought dessert. He always does. We sat outside until it got dark and the mosquitoes found us. I didn't take a single photo. I'm glad I didn't. I'll remember it anyway, and next time I'll ask someone else to watch the rice while I talk.",
  "I started running again in March. I couldn't do a kilometre without stopping. Now I can do five, slowly. It's not fast. I don't care. I run before work, when the streets are empty and the air's still cool. My knees complain on the hills. I've learned to listen to them. Some days I walk instead, and that's fine too. I'm not training for anything. I just like how the day feels after it, and I sleep better than I have in years.",
];
const FORMAL = 'The municipal transport authority has undertaken a comprehensive evaluation of the proposed bus network reconfiguration, considering operational efficiency, infrastructural constraints, demographic projections and the anticipated environmental consequences associated with each of the alternative scenarios presented to the committee. Following extensive consultation with stakeholders representing commercial, residential and institutional interests throughout the metropolitan region, the authority has determined that the preferred configuration offers the most favourable balance between capital expenditure, recurring maintenance obligations and projected ridership growth over the subsequent decade. Implementation is accordingly scheduled to commence during the forthcoming financial year, subject to the availability of appropriated funds and to the satisfactory completion of the statutory environmental assessment process required under the applicable regulatory framework.';
test('v2.4 reading grade by context, and a profile can set the target', () => {
  assert.ok(readingGrade(CASUAL[0]) < 8, `casual ${readingGrade(CASUAL[0])}`);
  assert.ok(readingGrade(FORMAL) > 16, `formal ${readingGrade(FORMAL)}`);
  assert.equal(readingGrade('Too short.'), null);
  plant(FORMAL, 'text', 'copy', 'reading-grade');
  quiet(CASUAL[0], 'text', 'copy', 'reading-grade');
  const strict = loadProfile(tmp('g.json', JSON.stringify({ readingGrade: { copy: 2 } })));
  assert.ok(rulesHit(checkText(CASUAL[2], 'text', 'x.md', { context: 'copy', profile: strict })).has('reading-grade'));
  assert.ok(!rulesHit(checkText(FORMAL, 'text', 'x.md', { context: 'copy', genre: 'legal' })).has('reading-grade'));
});
test('v2.4 spelling: a profile picks British or American, quoted words are left alone', () => {
  const gb = loadProfile(tmp('gb.json', '{"spelling":"en-GB"}')), us = loadProfile(tmp('us.json', '{"spelling":"en-US"}'));
  const hit = (t, p) => rulesHit(checkText(t, 'text', 'x.md', { context: 'doc', profile: p })).has('spelling-variant');
  assert.ok(hit('We will organize the colors by center.', gb));
  assert.ok(!hit('We will organise the colours by centre.', gb));
  assert.ok(hit('We will organise the colours by centre.', us));
  assert.ok(!hit('The brief said "color" and we kept it.', gb));
  assert.ok(!hit('We will organize the colors.', undefined));
  assert.throws(() => loadProfile(tmp('bad.json', '{"spelling":"en-AU"}')), /en-GB" or "en-US/);
});
test('v2.4 voice: built from samples, stores no content words, and tells a matching draft from a different one', () => {
  const voice = buildVoice(CASUAL.slice(0, 3));
  assert.equal(voice.samples, 3);
  const keys = new Set(Object.keys(voice.functionWords));
  for (const w of ['bus', 'gate', 'rice', 'curry', 'daughter']) assert.ok(!keys.has(w) && !JSON.stringify(voice).includes(w), `voice file leaks "${w}"`);
  const same = compareVoice(CASUAL[3], voice), other = compareVoice(FORMAL, voice);
  assert.ok(same.match > other.match + 25, `same ${same.match} vs other ${other.match}`);
  assert.ok(other.drift.length >= 2 && same.drift.length <= 1, JSON.stringify({ same: same.drift.map((d) => d.feature), other: other.drift.map((d) => d.feature) }));
  assert.ok(rulesHit(checkText(FORMAL, 'text', 'x.md', { context: 'doc', voice })).has('voice-drift'));
  assert.ok(!rulesHit(checkText(CASUAL[3], 'text', 'x.md', { context: 'copy', voice })).has('voice-drift'));
  assert.throws(() => buildVoice([CASUAL[0], 'Too short.']), /at least 3 samples/);
  const vf = tmp('voice.json', JSON.stringify(voice));
  const p = loadProfile(path.join(path.dirname(vf), (fs.writeFileSync(path.join(path.dirname(vf), 'p.json'), JSON.stringify({ voice: 'voice.json' })), 'p.json')));
  assert.equal(p.voice.samples, 3);
  assert.throws(() => loadVoice(tmp('nv.json', '{"a":1}')), /not a voice file/);
});
test('v2.4 fact check: dropped and new figures, dropped names, and flipped negations', () => {
  const before = 'Loans rose 12% in May to 340 items. Siti Rahman runs the desk. The library does not charge a deposit.';
  const ok = factCheck(before, 'In May, loans rose 12% to 340 items. Siti Rahman runs the desk, and the library does not charge a deposit.');
  assert.deepEqual(ok, []);
  const bad = factCheck(before, 'Loans rose 15% in May to 340 items. The desk is run by volunteers. The library charges a deposit.');
  const msgs = bad.map((f) => f.message).join(' | ');
  assert.match(msgs, /12%/); assert.match(msgs, /15%/); assert.match(msgs, /Siti Rahman/); assert.match(msgs, /negations changed from 1 to 0/);
  const d = diffFindings([{ rule: 'hype-copy', evidence: 'seamless' }], [{ rule: 'hype-copy', evidence: 'Seamless' }, { rule: 'stock-lines', evidence: 'say goodbye to' }]);
  assert.equal(d.added.length, 1); assert.equal(d.removed.length, 0); assert.equal(d.kept, 1);
});
test('v2.4 CLI: --build-voice with --split, --voice, --before and --git-base', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const run = (a, o = {}) => execFileSync(process.execPath, [path.join(root, 'check-slop.mjs'), ...a], { encoding: 'utf8', ...o });
  const samples = tmp('samples.md', CASUAL.map((t, i) => `## Sample ${i + 1}\n\n${t}`).join('\n\n'));
  const voice = JSON.parse(run(['--build-voice', samples, '--split', '^## ']));
  assert.equal(voice.samples, 4);
  const vf = tmp('v.json', JSON.stringify(voice));
  assert.match(run([tmp('draft.md', FORMAL), '--context', 'doc', '--voice', vf]), /Voice match: \d+\/100/);
  const after = tmp('after.md', 'Loans rose 15% in May. It is a seamless service.');
  const out = run([after, '--context', 'doc', '--before', tmp('before.md', 'Loans rose 12% in May. It is a quick service.')]);
  assert.match(out, /1 new finding\(s\), 0 fixed/); assert.match(out, /\+ hype-copy/); assert.ok(out.includes('facts-changed'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-guard-git-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'post.md'), 'We cut wait times by 20%. Say goodbye to queues.'); git('add', '.'); git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'post.md'), 'We cut wait times by 20%.');
  assert.match(run([path.join(repo, 'post.md'), '--context', 'copy', '--git-base', 'HEAD']), /0 new finding\(s\), 1 fixed.*facts kept/s);
});
