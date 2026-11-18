#!/usr/bin/env node
// Builds the README diagrams in docs/ as SVG, each in a light and a dark version.
//   node docs/build-docs.mjs            (embeds font subsets from Google Fonts; needs the network)
//   node docs/build-docs.mjs --no-fonts (system fonts only, works offline)
// No dependencies. Type pairing: docs/type-pairing.md. Chart rules: one axis, two validated
// colours (checked with a CVD and contrast validator), direct labels, a faint grid.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
const EMBED = !process.argv.includes('--no-fonts');

const THEME = {
  light: { surface: '#fcfcfb', ink: '#1d211c', ink2: '#52514e', line: '#d9d8d3', grid: '#ebeae6', box: '#ffffff', s1: '#2a78d6', s2: '#eb6834', term: '#f3f3f0' },
  dark: { surface: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', line: '#45443f', grid: '#2c2c2a', box: '#222221', s1: '#3987e5', s2: '#d95926', term: '#121211' },
};
const FONTS = {
  display: { family: 'Archivo', query: 'Archivo:wdth,wght@75,700', stack: "'Archivo', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif", stretch: 'condensed' },
  body: { family: 'Source Serif 4', query: 'Source+Serif+4:wght@400', stack: "'Source Serif 4', Georgia, 'Times New Roman', serif" },
  mono: { family: 'JetBrains Mono', query: 'JetBrains+Mono:wght@400', stack: "'JetBrains Mono', Menlo, Consolas, monospace" },
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function fontFaces(used) {
  if (!EMBED) return '';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  let css = '';
  for (const [key, text] of Object.entries(used)) {
    if (!text) continue;
    const f = FONTS[key];
    const chars = [...new Set(text)].join('');
    const res = await fetch(`https://fonts.googleapis.com/css2?family=${f.query}&text=${encodeURIComponent(chars)}`, { headers: { 'User-Agent': UA } });
    const sheet = await res.text();
    for (const m of sheet.matchAll(/@font-face\s*{([^}]*)}/g)) {
      const url = (m[1].match(/url\(([^)]+)\)/) || [])[1];
      if (!url) continue;
      const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
      const weight = (m[1].match(/font-weight:\s*(\d+)/) || [])[1] || '400';
      const stretch = (m[1].match(/font-stretch:\s*([\w%]+)/) || [])[1];
      css += `@font-face{font-family:'${f.family}';font-weight:${weight};${stretch ? `font-stretch:${stretch};` : ''}src:url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');}`;
    }
  }
  return css;
}

// Collects text per font while a picture is drawn, so the embedded subsets hold only what is used.
function canvas() {
  const used = { display: '', body: '', mono: '' };
  const t = (font, x, y, s, size, fill, extra = '') => { used[font] += s; return `<text x="${x}" y="${y}" class="${font}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`; };
  return { used, t };
}
async function wrap(w, h, title, desc, body, used, th) {
  const faces = await fontFaces(used);
  const cls = Object.entries(FONTS).map(([k, f]) => `${k === 'mono' ? '.mono{font-variant-ligatures:none}' : ''}.${k}{font-family:${f.stack};${f.stretch ? `font-stretch:${f.stretch};font-weight:700;` : ''}}`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
<style>${faces}${cls}</style>
<rect width="${w}" height="${h}" rx="12" fill="${th.surface}" stroke="${th.line}"/>
${body}
</svg>
`;
}

// 1. The flow: sources, rules.json, contexts, three kinds of check, the done checklist.
async function flow(mode) {
  const th = THEME[mode]; const { used, t } = canvas();
  const W = 1000;
  const wrapText = (str, n) => str.split(' ').reduce((a, w) => { const l = a[a.length - 1]; if (l && (l + ' ' + w).length <= n) a[a.length - 1] = l + ' ' + w; else a.push(w); return a; }, []);
  const m = RULES.rules.filter((r) => r.check.includes('machine')).length;
  const cols = [
    { title: 'Sources', items: ["The author's own rules", 'Impeccable (Apache-2.0)', 'taste-skill (MIT)', 'Ideas from deslop-skills, in our own words', 'General UI and writing practice'] },
    { title: 'rules.json', items: [`${RULES.rules.length} rules, version ${RULES.version}`, 'Each rule: the pattern, what to do instead, its contexts, how to check it, a severity'] },
    { title: 'Contexts', items: Object.keys(RULES.contexts).map((c) => `${c}: ${RULES.rules.filter((r) => r.contexts.includes(c)).length} rules`) },
    { title: 'Checks', items: [`The checker finds ${m} rules in HTML, CSS, Markdown and text`, 'Screenshots at 390, 820 and 1280 px', 'Judgement against the brief'] },
    { title: 'Done', items: ['Works at phone width', 'Text is readable', 'Keyboard reaches everything', 'Empty and error states', 'Say what was and was not checked'] },
  ];
  const bw = 174, gap = 22, x0 = 22, top = 88, lh = 21, n = 21;
  const laid = cols.map((c) => c.items.map((it) => wrapText(it, n)));
  const bh = Math.max(...laid.map((items) => items.reduce((h, l) => h + l.length * lh + 10, 0))) + 64;
  const H = top + bh + 56;
  let body = t('display', 24, 52, 'How slop-guard works', 26, th.ink);
  cols.forEach((c, i) => {
    const x = x0 + i * (bw + gap);
    body += `<rect x="${x}" y="${top}" width="${bw}" height="${bh}" rx="8" fill="${th.box}" stroke="${th.line}"/>`;
    body += t('display', x + 14, top + 32, c.title, 20, th.ink);
    let y = top + 62;
    for (const lines of laid[i]) { for (const l of lines) { body += t('body', x + 14, y, l, 14.5, th.ink2); y += lh; } y += 10; }
    if (i < cols.length - 1) {
      const x1 = x + bw + 3, x2 = x + bw + gap - 3, yy = top + bh / 2;
      body += `<path d="M${x1} ${yy} H${x2}" stroke="${th.ink2}" stroke-width="2"/><path d="M${x2 - 6} ${yy - 5} L${x2} ${yy} L${x2 - 6} ${yy + 5}" fill="none" stroke="${th.ink2}" stroke-width="2"/>`;
    }
  });
  body += t('body', 24, H - 22, 'A checker hit is evidence for a reviewer, not a verdict. Screenshot and judgement rows are done by eye.', 14.5, th.ink2);
  return wrap(W, H, 'How slop-guard works', 'Rules from several sources go into rules.json, are filtered by context, then checked by the checker, by screenshot and by judgement, ending in a done checklist.', body, used, th);
}

// 2. Rules per context, split into machine-checked and checked by eye. One axis, direct labels.
async function contextsChart(mode) {
  const th = THEME[mode]; const { used, t } = canvas();
  const data = Object.keys(RULES.contexts).map((c) => {
    const rs = RULES.rules.filter((r) => r.contexts.includes(c));
    const m = rs.filter((r) => r.check.includes('machine')).length;
    return { c, total: rs.length, machine: m, eye: rs.length - m };
  });
  const W = 1000, rowH = 46, top = 118, left = 96, right = 210;
  const H = top + data.length * rowH + 64;
  const max = Math.ceil(Math.max(...data.map((d) => d.total)) / 20) * 20;
  const sx = (v) => left + (v / max) * (W - left - right);
  let body = t('display', 24, 52, 'Rules per context', 26, th.ink);
  body += t('body', 24, 80, `${RULES.rules.length} rules in all. Most rules apply to more than one context.`, 15, th.ink2);
  // legend
  body += `<rect x="${left}" y="93" width="14" height="14" rx="3" fill="${th.s1}"/>` + t('body', left + 22, 105, 'Found by the checker', 14.5, th.ink2);
  body += `<rect x="${left + 190}" y="93" width="14" height="14" rx="3" fill="${th.s2}"/>` + t('body', left + 212, 105, 'Checked by eye (screenshot or judgement)', 14.5, th.ink2);
  // grid and axis labels
  for (let v = 0; v <= max; v += 20) {
    const x = sx(v);
    body += `<path d="M${x} ${top} V${top + data.length * rowH}" stroke="${th.grid}" stroke-width="1"/>`;
    body += t('body', x, top + data.length * rowH + 22, String(v), 14, th.ink2, 'text-anchor="middle"');
  }
  data.forEach((d, i) => {
    const y = top + i * rowH + 12, h = 24;
    body += t('display', left - 14, y + 18, d.c, 17, th.ink, 'text-anchor="end"');
    const xm = sx(d.machine);
    body += `<rect x="${left}" y="${y}" width="${Math.max(0, xm - left - 1)}" height="${h}" rx="4" fill="${th.s1}"/>`;
    if (d.eye) body += `<rect x="${xm + 1}" y="${y}" width="${Math.max(0, sx(d.total) - xm - 1)}" height="${h}" rx="4" fill="${th.s2}"/>`;
    body += t('body', sx(d.total) + 10, y + 17, `${d.total} rules, ${d.machine} by the checker`, 14.5, th.ink);
  });
  return wrap(W, H, 'Rules per context', data.map((d) => `${d.c}: ${d.total} rules, ${d.machine} found by the checker, ${d.eye} checked by eye`).join('; '), body, used, th);
}

// 3. Real checker output on examples/writing/sloppy.md, as a terminal.
async function terminal(mode) {
  const th = THEME[mode]; const { used, t } = canvas();
  const out = fs.readFileSync(path.join(ROOT, 'examples', 'writing', 'sloppy.txt'), 'utf8').trimEnd().split('\n');
  const pick = [];
  for (let i = 0; i < out.length && pick.length < 16; i += 2) if (/^(HIGH|MEDIUM|LOW)/.test(out[i])) pick.push(out[i]);
  const summary = out[out.length - 1];
  const fit = (s, n) => (s.length > n ? s.slice(0, n - 3) + '...' : s);
  const lines = ['$ node check-slop.mjs sloppy.md --context copy', '', ...pick.map((l) => fit(l.replace(/\s+/g, ' ').replace(/^(\w+) (\S+) /, (m, a, b) => `${a.padEnd(6)} ${b.padEnd(18)} `), 104)), '...', '', ...summary.split(/(?<=low \(context: copy\)\.) /)];
  const W = 1000, lh = 22, top = 70, H = top + lines.length * lh + 30;
  let body = `<rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="8" fill="${th.term}" stroke="${th.line}"/>`;
  body += t('display', 36, 50, 'Checker output on examples/writing/sloppy.md', 18, th.ink);
  lines.forEach((l, i) => {
    const sev = (l.match(/^(HIGH|MEDIUM|LOW)/) || [])[1];
    body += t('mono', 36, top + 14 + i * lh, l, 13, l.startsWith('$') || l.startsWith('slop-guard') ? th.ink : sev ? th.ink : th.ink2, 'xml:space="preserve"');
  });
  return wrap(W, H, 'Checker output', `Real output of check-slop.mjs on examples/writing/sloppy.md: ${summary}`, body, used, th);
}

for (const mode of ['light', 'dark']) {
  fs.writeFileSync(path.join(HERE, `flow-${mode}.svg`), await flow(mode));
  fs.writeFileSync(path.join(HERE, `contexts-${mode}.svg`), await contextsChart(mode));
  fs.writeFileSync(path.join(HERE, `terminal-${mode}.svg`), await terminal(mode));
}
console.log('docs: wrote flow, contexts and terminal SVGs (light and dark)');
