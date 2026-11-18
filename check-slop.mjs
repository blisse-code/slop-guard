#!/usr/bin/env node
// slop-guard checker: finds the machine-checkable anti-slop rules (rules.json) in HTML,
// CSS, Markdown and text. A hit is evidence for a reviewer, not a verdict: the rules are
// design preferences, not an AI-authorship test. No dependencies.
//
// Usage:
//   node check-slop.mjs <file or folder>... [--context web|app|deck|doc|copy|image]
//                       [--json out.json] [--strict] [--year 2026]
//   node check-slop.mjs --list [--context deck]        rules for a context, as Markdown
//   node check-slop.mjs --rubric [--context doc]       screenshot and judgement checks only
//   node check-slop.mjs --rules-md > RULES.md            regenerate RULES.md from rules.json
//   add --pairing <file.md> to require a "Type pairing" record (Display:, Body:, Why:) in that file
// Exit code: 0, or 1 with --strict when any High finding is found.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES = JSON.parse(fs.readFileSync(path.join(HERE, 'rules.json'), 'utf8'));

// ---- small helpers -----------------------------------------------------------------------
const lineAt = (text, i) => text.slice(0, i).split('\n').length;
const toPx = (v) => {
  const m = String(v).trim().match(/^(-?[\d.]+)(px|rem|em|pt)?$/);
  if (!m) return null;
  const n = +m[1];
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : m[2] === 'pt' ? n * 1.333 : n;
};
function parseColor(c) {
  c = c.trim().toLowerCase();
  let m = c.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = c.match(/^rgba?\(([^)]*)\)$/);
  if (m) { const n = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return { r: n[0], g: n[1], b: n[2], a: n[3] ?? 1 }; }
  const named = { white: [255, 255, 255], black: [0, 0, 0], purple: [128, 0, 128], violet: [238, 130, 238], indigo: [75, 0, 130], cyan: [0, 255, 255], magenta: [255, 0, 255], fuchsia: [255, 0, 255] }[c];
  return named ? { r: named[0], g: named[1], b: named[2], a: 1 } : null;
}
const COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:purple|violet|indigo|cyan|magenta|fuchsia)\b/gi;
function hsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const isVioletish = (c) => { const { h, s, l } = hsl(c); return s > 0.35 && l > 0.15 && l < 0.85 && h >= 235 && h <= 300; };
const isSaturated = (c) => { const { s, l } = hsl(c); return s > 0.45 && l > 0.2 && l < 0.85; };

// HTML to CSS-shaped text with the same line numbers: only <style> bodies and style="" survive.
function htmlToCss(html) {
  const out = html.replace(/[^\n]/g, ' ').split('');
  const put = (start, s) => { for (let k = 0; k < s.length; k++) if (s[k] !== '\n') out[start + k] = s[k]; };
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) put(m.index + m[0].indexOf('>') + 1, m[1]);
  for (const m of html.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) put(m.index + m[0].indexOf(m[1]), `x{${m[2]};}`);
  return out.join('');
}
// CSS rules as { sel, decls: {prop: value}, line }. Nested at-rules are flattened.
function cssRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const rules = [];
  for (const m of clean.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    const decls = {};
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim(); }
    rules.push({ sel: m[1].trim(), decls, line: lineAt(clean, m.index + m[1].search(/\S/)), at: m.index });
  }
  const keyframes = [...clean.matchAll(/@keyframes\s+([\w-]+)/g)].map((k) => k[1]);
  return { rules, keyframes };
}
// Visible text of an HTML file, with tags reduced to markers we can search.
const stripHtml = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, (s) => s.replace(/[^\n]/g, ' '));
const textOf = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const EMOJI = /\p{Extended_Pictographic}/u;
const HYPE = /\b(unlock (?:your|the) (?:full )?potential|revolutioni[sz]e|revolutionary|ai[- ]powered|supercharge[ds]?|unleash(?:es|ed)?|empower(?:s|ing|ed)?|next[- ]gen(?:eration)?|seamless(?:ly)?|elevate[ds]?|game[- ]chang(?:er|ing)|cutting[- ]edge|welcome back,? \w+ ?✨?)\b/gi;
const BUILD = /\b(built with (?:react|next(?:\.js)?|tailwind|vue|svelte|ai|love)|powered by (?:ai|gpt|claude|openai)|made with (?:❤️?|love|ai))\b/gi;
const PLACEHOLDER = /\b(acme(?: inc| corp)?|jane doe|john doe|lorem ipsum|dolor sit amet|you@example\.com|[\w.+-]+@example\.(?:com|org)|your name here|company name)\b/gi;
const SECTION_NUM = /^\s*(?:0\d|\d{1,2})[.)/]?\s+\S/;
// Type pairing rules: these four are banned by name; the rest are widely overused.
const BANNED_FONTS = ['inter', 'roboto', 'poppins', 'space grotesk'];
const OVERUSED_FONTS = ['fraunces', 'geist', 'plus jakarta sans'];
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'helvetica neue', 'helvetica', 'arial', 'cursive', 'fantasy', 'emoji', 'inherit', 'initial', 'unset', 'math', 'apple color emoji', 'segoe ui emoji', 'noto color emoji']);
const DECORATIVE_HEADINGS = /^(conclusion|in conclusion|summary|in summary|closing thoughts|final thoughts|final words|parting thoughts|the takeaway|key takeaways|the road ahead|what'?s next|looking forward|the big(?:ger)? picture|why it matters|the bottom line)$/i;
// Filler vocabulary: words that sound weighty and carry no fact (hype words are in HYPE).
const FILLER = /\b(delve[sd]?|delving|tapestry|a testament to|testament to|pivotal|multifaceted|myriad|plethora|realm|paradigm|interplay|meticulous(?:ly)?|intricate|garner(?:ed)?|holistic|transformative|world-class|best-in-class|state-of-the-art|unparalleled|nestled|it'?s worth noting|it is worth noting|it'?s important to note|in today'?s (?:fast-paced|rapidly evolving|ever-changing|digital|modern) (?:world|landscape|age|era))\b/gi;
const STAGED = [
  /\b(?:it'?s|it is) not (?:just )?[^.!?\n]{1,40}[.!] (?:it'?s|it is) [^.!?\n]{1,40}[.!]/gi,
  /\bno [^.!?\n]{1,25}\. no [^.!?\n]{1,25}\. just [^.!?\n]{1,30}\./gi,
  /\bthe (?:result|answer|catch|kicker)\? /gi,
  /\bhere'?s (?:the (?:part|thing|kicker)|what) (?:nobody|no one|most people|everyone)[^.\n]{0,30}/gi,
  /\bwhat nobody tells you\b|\blet that sink in\b|\bread that again\b/gi,
  /\b\w+ theater\b/gi,
];
const BAIT = /(what'?s your take\??|let me know in the comments|drop a comment|curious (?:what others think|to hear your thoughts)|agree\?$|thoughts\?$|🧵|^thread:)/gim;
const VALIDATION = /^(?:great question|you'?re absolutely right|great catch|that'?s a great point)/gim;
// Copy tells added in v2. Each is a pattern for a reviewer, not proof of anything.
const STOCK_LINES = [/\bsay goodbye to\b/gi, /\blook no further\b/gi, /\bjoin (?:thousands|millions|hundreds) of\b/gi, /\bimagine a world\b/gi, /\bready to (?:transform|take your|level up|elevate)\b/gi,
  /\bone-stop shop\b/gi, /\b\w+ made (?:simple|easy)\b/gi, /\bat your fingertips\b/gi, /\b(?:in|with) (?:just )?a few clicks\b/gi, /\bwe'?ve got you covered\b/gi, /\bthe possibilities are endless\b/gi,
  /\bthe future of \w+ is (?:here|now)\b/gi, /\btake (?:it|your \w+|things) to the next level\b/gi, /\bwhether you'?re an? [^.,!?\n]{1,30} or an? /gi, /\bnot only\b[^.!?\n]{1,60}\bbut also\b/gi, /\bever-evolving\b/gi];
const PUFFERY = /\b(serves as(?: an?)?|stands as(?: an?)?|plays an? (?:key|vital|crucial|pivotal|central) role|in the heart of|where \w+(?: \w+)? meets \w+|the world of|in the \w+ space)\b/gi;
const ING_RIDER = /,\s(ensuring|highlighting|underscoring|reflecting|showcasing|emphasi[sz]ing|signal(?:l)?ing|cementing|solidifying|paving the way for|fostering|marking)\b[^.!?\n]{0,60}/gi;
const PROCESS_TALK = [/\bthis (?:section|article|post|page) (?:shows|covers|explores|will)\b/gi, /\bbelow,? (?:you'?ll find|we)\b/gi, /\bhere are (?:\d+|three|four|five|six|seven) (?:reasons|ways|things|tips)\b/gi,
  /\bin this (?:article|post|section),? (?:we|i)\b/gi, /\blet'?s (?:take a look|explore|dive in)\b/gi, /\b(?:one|a single) (?:thing|change|idea|rule|question)[^.:!?\n]{0,30}: /gi];
const VIRTUE = [/\b(to be honest|to be clear|honestly,|frankly,|let me be (?:direct|honest|clear)|i'?ll be honest|this is (?:deliberate|intentional|by design)|that'?s by design)/gi,
  /\b(?:we|our (?:team|approach|process|service|studio|product|people)) (?:are|is|'re|stay|stays) (?:honest|genuine|thoughtful|intentional|transparent|human)\b/gi, /\b(?:genuinely|truly) (?:\w+)\b/gi];
const WORDY = /\b(ha(?:s|ve) the ability to|(?:is|are) able to|due to the fact that|at this point in time|for the purpose of|in the event that|a large number of|in spite of the fact that|with regard to|in close proximity to|on a daily basis|make use of)\b/gi;
const HEDGE = /\b(arguably|to some extent|in many ways|in some ways|it could be argued|it could be said|to a certain degree|more or less|somewhat|perhaps)\b/gi;
const AUTHORITY = /\b(studies (?:show|suggest|have shown)|research (?:shows|suggests|has shown)|experts (?:agree|say|believe)|scientists (?:say|agree)|it is widely (?:believed|accepted|known)|many (?:people|experts) (?:believe|say|argue)|according to (?:experts|research|studies))\b/gi;
const TRANSITIONS = /(?:^|[.!?]\s+|\n)(Moreover|Furthermore|Additionally|Notably|Importantly|Interestingly|Ultimately|Overall|In essence),/g;
const COURTESY = /(certainly!|absolutely!|i hope (?:this|you) (?:finds you well|helps|are well)|i hope this email finds you well|(?:please )?(?:do not|don'?t) hesitate to (?:reach out|contact)|happy to help|i'?d be happy to|feel free to reach out|as an ai\b)/gi;
const RESIDUE = /(\{\{\s*[\w.]+\s*\}\}|\[(?:your |company |brand |business )?(?:company|brand|business|product|first|last|full)? ?name\]|\[insert\b[^\]]*\]|\[need\b[^\]]*\]|\[tbd\])/gi;
const DEFAULT_CAST = /\b(Northwind|Contoso|Fabrikam|Globex|Initech|Brightloop|Fieldnote)\b/g;
const NUMW = '(one|two|three|four|five|six|seven|eight|nine|ten|\\d+)';
const MONO = /^(monospace|ui-monospace|jetbrains mono|ibm plex mono|space mono|fira code|fira mono|courier|courier new|sf mono|roboto mono|dm mono|source code pro|menlo|consolas|geist mono)$/;

// ---- detectors -----------------------------------------------------------------------------
// Each returns findings { detector, line, evidence, message, severity? }.
function cssDetectors(css, file) {
  const { rules, keyframes } = cssRules(css);
  const out = [];
  const add = (detector, r, evidence, message, severity) => out.push({ detector, file, line: r.line, evidence: evidence.slice(0, 160), message, severity });
  const headingSel = /(^|[\s,>])(h1|h2|\.hero[\w-]*|\.headline|\.display|\.title)\b/i;
  const bodySel = /(^|[\s,>])(body|p|\.body|\.text|li)\b/i;
  const sizes = {};
  for (const r of rules) {
    const d = r.decls;
    const bg = [d.background, d['background-image'], d['background-color']].filter(Boolean).join(' ');
    // gradient text
    if (/text/.test(d['background-clip'] || '') || /text/.test(d['-webkit-background-clip'] || '') || /transparent/.test(d['-webkit-text-fill-color'] || '') && /gradient/.test(bg))
      add('gradient-text', r, `${r.sel} { background-clip: text }`, 'Gradient fill on text.');
    // violet / AI palette gradients
    if (/gradient\(/.test(bg)) {
      const cols = (bg.match(COLOR_RE) || []).map(parseColor).filter(Boolean);
      if (cols.some(isVioletish)) add('violet-gradient', r, `${r.sel} { background: ${bg} }`, 'Indigo/violet gradient: the default AI palette.');
      if (/radial-gradient/.test(bg) && /^(html|body|main|\.hero|\.page|:root)/i.test(r.sel) && cols.some((c) => isSaturated(c) && c.a > 0.05)) add('glow', r, `${r.sel} { background: ${bg} }`, 'Coloured radial haze over the page.');
      if (/repeating-(linear|radial)-gradient/.test(bg)) add('stripes', r, `${r.sel} { background: ${bg} }`, 'Decorative repeating stripes: keep only if they carry meaning.', 'low');
      if (/(^|[\s,>.#])(button|\.btn|\.button|\.cta)\b/i.test(r.sel) && cols.length >= 2) add('gradient-button', r, `${r.sel} { background: ${bg} }`, 'Two-tone gradient button.');
    }
    // glows
    for (const p of ['box-shadow', 'text-shadow', 'filter']) {
      const v = d[p]; if (!v) continue;
      for (const part of v.split(/,(?![^(]*\))/)) {
        const nums = (part.replace(COLOR_RE, '').match(/-?[\d.]+(px|rem|em)?/g) || []).map(toPx);
        const col = (part.match(COLOR_RE) || []).map(parseColor).filter(Boolean)[0];
        const blur = p === 'filter' ? (nums[2] ?? 0) : nums[2] ?? 0;
        if (col && isSaturated(col) && col.a >= 0.25 && blur >= 12) add('glow', r, `${r.sel} { ${p}: ${v} }`, 'Coloured glow shadow.');
        if (p === 'box-shadow' && nums.length >= 2 && (Math.abs(nums[0]) >= 4 || Math.abs(nums[1]) >= 4) && (nums[2] ?? 0) === 0 && !/inset/.test(part)) add('offset-shadow', r, `${r.sel} { box-shadow: ${v} }`, 'Hard offset shadow (fine only if the whole design is neobrutalist).', 'low');
      }
    }
    // side stripe and thick border on rounded card
    for (const side of ['left', 'right']) {
      const v = d[`border-${side}`] || (d[`border-${side}-width`] ? `${d[`border-${side}-width`]} ${d[`border-${side}-color`] || ''}` : '');
      if (!v) continue;
      const w = (v.match(/([\d.]+)px/) || [])[1];
      const col = (v.match(COLOR_RE) || []).map(parseColor).filter(Boolean)[0];
      if (w >= 3 && (!col || isSaturated(col)) && !/\bblockquote\b|\bq\b|\bpre\b|\bcode\b/i.test(r.sel)) add('side-stripe', r, `${r.sel} { border-${side}: ${v} }`, 'Thick coloured stripe down one side of a card.');
    }
    if (d.border && /([3-9]|\d{2})px\s+solid/.test(d.border) && toPx(d['border-radius'] || '0') >= 12) add('side-stripe', r, `${r.sel} { border: ${d.border}; border-radius: ${d['border-radius']} }`, 'Thick accent border on a rounded card.');
    // pills
    const rad = d['border-radius'];
    if (rad && /(9{3,}|50%|[1-9]\d{2,}px)/.test(rad)) {
      if (/(card|panel|section|hero|container|modal|banner|tile|dialog)/i.test(r.sel)) add('pill', r, `${r.sel} { border-radius: ${rad} }`, 'Large element made pill-shaped.');
      else if (/(button|\.btn|\.cta)/i.test(r.sel)) add('pill', r, `${r.sel} { border-radius: ${rad} }`, 'Pill-shaped button: use straight or subtly rounded corners unless pills are the deliberate shape language.', 'low');
    }
    // backdrop blur
    if (/blur\(/.test(d['backdrop-filter'] || d['-webkit-backdrop-filter'] || '')) add('backdrop-blur', r, `${r.sel} { backdrop-filter: ${d['backdrop-filter'] || d['-webkit-backdrop-filter']} }`, 'Frosted glass: keep only over rich imagery.', 'low');
    // tiny text
    const fs_ = toPx(d['font-size'] || '');
    if (fs_ != null && fs_ > 0) {
      if (fs_ < 11) add('tiny-text', r, `${r.sel} { font-size: ${d['font-size']} }`, `Text at ${Math.round(fs_ * 10) / 10}px: below the 11px floor for any label or control.`);
      else if (fs_ < 12 && bodySel.test(r.sel)) add('tiny-text', r, `${r.sel} { font-size: ${d['font-size']} }`, `Body text at ${fs_}px: below 12px.`);
      for (const h of ['body', 'h1', 'h2', 'h3', 'h4']) if (new RegExp(`^${h}$`, 'i').test(r.sel.trim())) sizes[h] = fs_;
    }
    // eyebrow: uppercase + wide tracking + small size
    const ls = d['letter-spacing'] || '';
    const lsPx = /em$/.test(ls) ? parseFloat(ls) * (fs_ || 14) : toPx(ls);
    if (/uppercase/.test(d['text-transform'] || '') && lsPx >= 1 && (fs_ == null || fs_ <= 14) && /(eyebrow|kicker|overline|pre-?title|tagline|label|caption)/i.test(r.sel))
      add('eyebrow', r, `${r.sel} { text-transform: uppercase; letter-spacing: ${ls} }`, 'Small spaced-out uppercase label: banned outright above headings.');
    // reading
    if (bodySel.test(r.sel)) {
      const lh = d['line-height']; const lhN = lh && (/px$/.test(lh) ? toPx(lh) / (fs_ || 16) : parseFloat(lh));
      if (lhN && lhN < 1.3) add('reading', r, `${r.sel} { line-height: ${lh} }`, 'Body line spacing below 1.3.', 'low');
      if (/justify/.test(d['text-align'] || '')) add('reading', r, `${r.sel} { text-align: justify }`, 'Justified text: gaps run through narrow columns.', 'low');
      if (lsPx > 1.5) add('reading', r, `${r.sel} { letter-spacing: ${ls} }`, 'Body letters spaced too far apart.', 'low');
      if (/uppercase/.test(d['text-transform'] || '')) add('reading', r, `${r.sel} { text-transform: uppercase }`, 'Body text in capitals.');
      if (lsPx != null && lsPx < -0.6) add('reading', r, `${r.sel} { letter-spacing: ${ls} }`, 'Letters squashed together.', 'low');
    }
    // hairline headline
    if (headingSel.test(r.sel)) {
      const fw = parseInt(d['font-weight'] || '0', 10);
      if (fw && fw <= 200 && (fs_ == null || fs_ >= 28)) add('thin-headline', r, `${r.sel} { font-weight: ${d['font-weight']} }`, 'Hairline-thin headline.');
      if (d.opacity && parseFloat(d.opacity) < 0.7) add('thin-headline', r, `${r.sel} { opacity: ${d.opacity} }`, 'Headline faded to low opacity.');
    }
    // fonts: the four the pairing rules ban by name, then the other overused ones
    const fam = (d['font-family'] || '').split(',')[0]?.replace(/["']/g, '').trim().toLowerCase();
    if (fam && BANNED_FONTS.includes(fam)) out.push({ detector: 'overused-font', rule: 'type-banned-defaults', file, line: r.line, evidence: `${r.sel} { font-family: ${d['font-family']} }`, message: `${fam} is a banned default: choose a pairing under the type rules, or record why the brand mandates it.`, severity: 'medium' });
    else if (fam && OVERUSED_FONTS.includes(fam)) out.push({ detector: 'overused-font', rule: 'overused-font', file, line: r.line, evidence: `${r.sel} { font-family: ${d['font-family']} }`, message: `${fam} is an overused default: keep it only if it was chosen for this brand, and record why.`, severity: 'low' });
    // one personality, one workhorse: the display token on running text and controls
    if (/var\(\s*--(?:font|ff|type)-(?:display|heading|head|title)\b/.test(d['font-family'] || d.font || '') && /(^|[\s,>])(p|body|button|input|textarea|select|label|li|td|\.btn|\.button|\.body|\.text)\b/i.test(r.sel) && !/(^|[\s,>])(h[1-6]|\.title|\.heading)\b/i.test(r.sel))
      add('type-display-on-body', r, `${r.sel} { font-family: ${d['font-family'] || d.font} }`, 'Display face on paragraphs, forms or buttons: keep it for headings and short labels.');
    // display type limits
    if (/(^|[\s,>])(h1|\.hero[\w-]*|\.display)\b/i.test(r.sel)) {
      if (/italic/.test(d['font-style'] || '') && /(serif|fraunces|recoleta|playfair|newsreader|garamond|didot|bodoni)/i.test(d['font-family'] || '') && !/sans-serif/i.test((d['font-family'] || '').split(',')[0])) add('display-type', r, `${r.sel} { font-style: italic; font-family: ${d['font-family']} }`, 'Italic serif hero headline by default.', 'low');
      if (fs_ != null && fs_ > 96) add('display-type', r, `${r.sel} { font-size: ${d['font-size']} }`, `Display headline at ${Math.round(fs_)}px, above about 6rem.`, 'low');
    }
    if (headingSel.test(r.sel) && /em$/.test(ls) && parseFloat(ls) < -0.04) add('display-type', r, `${r.sel} { letter-spacing: ${ls} }`, 'Heading tracking tighter than -0.04em.', 'low');
    // transition: all
    if (/(^|[\s,])all\b/.test(d['transition-property'] || '') || /^all\b/.test((d.transition || '').trim())) add('transition-all', r, `${r.sel} { transition: ${d.transition || d['transition-property']} }`, 'transition: all as a reflex: name the properties that change.', 'low');
    // hairline grid texture
    if (/linear-gradient\([^)]*1px/.test(bg) && /\d+px/.test(d['background-size'] || '')) add('grid-background', r, `${r.sel} { background: ${bg.slice(0, 80)}; background-size: ${d['background-size']} }`, 'Hairline grid background as default texture.', 'low');
    if (fam && ['impact', 'arial black'].includes(fam) || fam && ['arial', 'helvetica', 'system-ui', '-apple-system', 'sans-serif'].includes(fam) && headingSel.test(r.sel)) add('default-headline-font', r, `${r.sel} { font-family: ${d['font-family']} }`, 'Default or system font for a headline.');
    // low contrast: a rule that sets both its text colour and its background
    const fg = d.color && parseColor(d.color.replace(/!important/, ''));
    const bgc = (d['background-color'] || (d.background && !/gradient|url\(/.test(d.background) ? d.background : '')).replace(/!important/, '').trim();
    const bgp = bgc && parseColor(bgc.split(/\s+/)[0]);
    if (fg && bgp && fg.a >= 0.99 && bgp.a >= 0.99) {
      const cr = contrast(fg, bgp);
      if (cr < 4.5) add('low-contrast', r, `${r.sel} { color: ${d.color}; background: ${bgc} }`, `Contrast ${cr.toFixed(2)}:1, below 4.5:1 for body text${cr >= 3 ? ' (passes 3:1 only for large text)' : ''}.`, cr >= 3 ? 'medium' : undefined);
    }
    // cream default
    if (/^(html|body|:root)$/i.test(r.sel.trim()) && bgp) { const { h, s, l } = hsl(bgp); if (l > 0.88 && s > 0.25 && h >= 30 && h <= 60) add('cream-background', r, `${r.sel} { background: ${bgc} }`, 'Warm cream page background: choose it for the brand, not as a default.', 'low'); }
    // truncation
    if (/ellipsis/.test(d['text-overflow'] || '') || d['-webkit-line-clamp']) add('ellipsis', r, `${r.sel} { ${d['text-overflow'] ? 'text-overflow: ellipsis' : '-webkit-line-clamp: ' + d['-webkit-line-clamp']} }`, 'Text cut off with "…": never cut what people need to read.', 'low');
    // bouncy
    for (const v of [d.transition, d['transition-timing-function'], d.animation, d['animation-timing-function']].filter(Boolean)) {
      const cb = v.match(/cubic-bezier\(([^)]*)\)/);
      if (cb) { const n = cb[1].split(',').map(parseFloat); if (n[1] > 1.05 || n[3] > 1.05 || n[1] < -0.05 || n[3] < -0.05) add('bouncy-motion', r, `${r.sel} { ${v} }`, 'Overshooting (bouncy) easing.', 'low'); }
      if (/\b(bounce|elastic|wobble|jello)\b/i.test(v)) add('bouncy-motion', r, `${r.sel} { ${v} }`, 'Bouncy or elastic animation.', 'low');
      if (/\b(marquee|ticker|scroll-x|scrolling)\b/i.test(v) && /infinite/.test(v)) add('ticker', r, `${r.sel} { animation: ${v} }`, 'Content that scrolls by itself, non-stop.');
      if (/\b(pulse|ping|blink)\b/i.test(v) && /infinite/.test(v) && /(live|status|dot|badge|active|verified|online)/i.test(r.sel)) add('pulse-status', r, `${r.sel} { animation: ${v} }`, 'Pulsing status indicator: keep it only if it shows real, changing live data.', 'low');
    }
    // floating widgets
    if (/fixed/.test(d.position || '') && /(chat|newsletter|popup|pop-up|back-?to-?top|scroll-?top|floating|fab|badge|promo)/i.test(r.sel)) add('floating-widgets', r, `${r.sel} { position: fixed }`, 'Floating widget following the reader: keep only the navigation fixed.');
    // monospace as costume: a mono face on prose or headings (code, pre, kbd, samp and data cells are fine)
    if (fam && MONO.test(fam) && /(^|[\s,>])(body|p|h[1-6]|li|\.hero[\w-]*|\.title|\.headline|\.lead|\.body|\.text)\b/i.test(r.sel) && !/\b(code|pre|kbd|samp|td|th|\.mono|\.code|\.data|\.num)/i.test(r.sel))
      add('mono-text', r, `${r.sel} { font-family: ${d['font-family']} }`, 'Monospace on prose or headings: keep it for code, data and measurements.', 'low');
    // animating layout properties
    for (const v of [d.transition, d['transition-property']].filter(Boolean)) {
      const props = v.split(/,(?![^(]*\))/).map((x) => x.trim().split(/\s+/)[0].toLowerCase());
      const bad = props.filter((x) => /^(width|height|top|left|right|bottom|margin(-\w+)?|padding(-\w+)?|max-height|max-width)$/.test(x));
      if (bad.length) add('layout-animation', r, `${r.sel} { transition: ${v} }`, `Transition on ${bad.join(', ')}: animate transform or opacity instead.`, 'low');
    }
    if (/^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/.test(r.sel.trim()) && Object.keys(d).some((k) => /^(width|height|top|left|right|bottom|margin(-\w+)?|padding(-\w+)?)$/.test(k)))
      add('layout-animation', r, `${r.sel} { ${Object.keys(d).join('; ')} }`, 'Keyframes that animate layout properties.', 'low');
    // focus outline removed with nothing in its place
    if (/^(none|0|0px)\b/.test((d.outline || '').trim()) && /:focus|^\*$|(^|[\s,])(a|button|input|select|textarea)($|[\s,:])/i.test(r.sel) && !d['box-shadow'] && !d.border && !d['border-color'] && !d['outline-offset'] && !/:focus-visible/.test(r.sel))
      add('focus-removed', r, `${r.sel} { outline: ${d.outline} }`, 'Focus outline removed with no visible replacement.');
    // pure black text
    if (/^(#000(000)?|black|rgb\(0,\s*0,\s*0\))$/i.test((d.color || '').trim()) && /^(html|body|:root|p|h[1-6]|main|article)(\s*,\s*(html|body|:root|p|h[1-6]|main|article))*$/i.test(r.sel.trim()))
      add('pure-black', r, `${r.sel} { color: ${d.color} }`, 'Pure black text: use a near-black ink tinted toward the palette.', 'low');
    // highlighter marks behind words
    if (/(^|[\s,>.])(mark|highlight|marker|hl|text-highlight)\b/i.test(r.sel) && (d['background-color'] || d.background || d['background-image']) && !/transparent|none/.test(d['background-color'] || d.background || ''))
      add('marker-highlight', r, `${r.sel} { background: ${d['background-color'] || d.background || d['background-image']} }`, 'Highlighter colour behind words.', 'low');
    // whole-page scroll snapping
    if (d['scroll-snap-type'] && /^(html|body|:root|main)$/i.test(r.sel.trim()) && !/none/.test(d['scroll-snap-type']))
      add('scroll-hijack', r, `${r.sel} { scroll-snap-type: ${d['scroll-snap-type']} }`, 'Whole-page scroll snapping: let the page scroll natively unless snapping is the recorded idea.', 'low');
    // content hidden until a script reveals it
    if (/^0(\.0+)?$/.test((d.opacity || '').trim()) && /(reveal|fade|animate|aos|appear|in-?view|scroll-?in|slide-?in|\[data-aos|\[data-sal|\[data-reveal|wow\b)/i.test(r.sel) && !/:hover|:focus|\.is-|\.visible|\.in\b|\.active|\.show/.test(r.sel))
      add('hidden-at-rest', r, `${r.sel} { opacity: ${d.opacity} }`, 'Content starts invisible and waits for a script to reveal it.');
    // blurred colour blobs behind the hero
    const blurPx = ((d.filter || '').match(/blur\(\s*([\d.]+)(px|rem)\s*\)/) || []);
    if (blurPx[1] && toPx(blurPx[1] + blurPx[2]) >= 40 && (/(absolute|fixed)/.test(d.position || '') || /(blob|orb|glow|aurora|halo)/i.test(r.sel)))
      add('blur-blob', r, `${r.sel} { filter: ${d.filter} }`, 'Heavily blurred colour blob used as background decoration.');
    // framework defaults
    if (/^slate|#64748b|#475569|#334155/i.test((d.color || '') + (d['background-color'] || ''))) add('framework-defaults', r, `${r.sel} { color: ${d.color || d['background-color']} }`, 'Tailwind slate default: retheme tokens to the chosen style.', 'low');
  }
  for (const k of keyframes) if (/^(bounce|elastic|wobble|jello)/i.test(k)) out.push({ detector: 'bouncy-motion', file, line: lineAt(css, css.indexOf(k)), evidence: `@keyframes ${k}`, message: 'Bouncy or elastic keyframes.', severity: 'low' });
  return out;
}

// Typography across a whole project (every stylesheet together), so a component file that
// only uses the tokens is not blamed for the tokens living elsewhere.
export function typeChecks(sources) {
  const out = [];
  const fams = new Map(); // family -> first place seen
  const sizes = {}, weights = {}, famOf = {};
  let headTok = null, bodyTok = null; const used = new Set();
  let declaresFont = false;
  for (const { css, file } of sources) {
    const { rules } = cssRules(css);
    for (const r of rules) {
      const d = r.decls;
      for (const [k, v] of Object.entries(d)) {
        const m = k.match(/^--(?:font|ff|type)-(display|heading|head|title|body|text|base)$/);
        if (m && !/^\d/.test(v)) { if (/body|text|base/.test(m[1])) bodyTok ||= { name: k, file, line: r.line }; else headTok ||= { name: k, file, line: r.line }; }
        for (const u of String(v).matchAll(/var\(\s*(--[\w-]+)/g)) used.add(u[1]);
        if (k === 'font-family' || k.startsWith('--font-') || k.startsWith('--ff-') || (k === 'font' && /,/.test(v))) {
          const famStr = k === 'font' ? v.replace(/^.*?\d[\w.%]*(?:\/[\w.]+)?\s+/, '') : v;
          if (/var\(/.test(famStr)) continue;
          if (k === 'font-family') declaresFont = true;
          const first = famStr.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
          if (first && !GENERIC.has(first) && !/^\d/.test(first)) { if (!fams.has(first)) fams.set(first, { file, line: r.line }); }
        }
      }
      const sel = r.sel.trim().toLowerCase();
      for (const h of ['body', 'p', 'h1', 'h2', 'h3', 'h4']) if (sel === h || sel.split(/\s*,\s*/).includes(h)) {
        const px = toPx(d['font-size'] || ''); if (px) sizes[h] ??= px;
        if (d['font-weight']) weights[h] ??= d['font-weight'];
        if (d['font-family']) famOf[h] ??= d['font-family'];
      }
    }
  }
  const where = sources[0]?.file || '<input>';
  if (fams.size > 3) out.push({ detector: 'type-families', file: where, line: 1, evidence: [...fams.keys()].join(', '), message: `${fams.size} font families: two are usually enough and three is the limit. Give each a job or drop it.` });
  if (fams.size || declaresFont) {
    if (!headTok || !bodyTok) out.push({ detector: 'type-tokens', file: where, line: 1, evidence: `heading token: ${headTok?.name || 'none'}; body token: ${bodyTok?.name || 'none'}`, message: 'Set a heading (display) font token and a body font token, e.g. --font-display and --font-body, and use them everywhere.' });
    else for (const t of [headTok, bodyTok]) if (!used.has(t.name)) out.push({ detector: 'type-tokens', file: t.file, line: t.line, evidence: t.name, message: `${t.name} is defined but never used through var().` });
  }
  const body = sizes.body || sizes.p;
  for (const h of ['h2', 'h1']) if (body && sizes[h] && sizes[h] / body < 1.25) out.push({ detector: 'type-scale', file: where, line: 1, evidence: `body ${body}px → ${h} ${sizes[h]}px (${(sizes[h] / body).toFixed(2)}×)`, message: `${h} is less than 1.25× the body size.`, rule: 'type-heading-body-step' });
  const steps = [['h3', 'h2'], ['h2', 'h1']].filter(([a, b]) => sizes[a] && sizes[b] && sizes[b] / sizes[a] < 1.25);
  if (steps.length) out.push({ detector: 'type-scale', file: where, line: 1, evidence: steps.map(([a, b]) => `${a} ${sizes[a]} → ${b} ${sizes[b]}`).join(', '), message: 'Adjacent heading levels within 1.25×.', severity: 'low', rule: 'flat-type-scale' });
  const hw = weights.h1 || weights.h2, bw = weights.body || weights.p || '400';
  if (hw && String(hw) === String(bw)) out.push({ detector: 'type-same-weight', file: where, line: 1, evidence: `headings weight ${hw}, body weight ${bw}`, message: 'Headings and body share the same weight: vary weight, width or size.' });
  return out;
}

// Project-level checks beyond type: motion without a reduced-motion guard, and values that
// drift off the scale (too many distinct radii, font sizes or literal colours).
export function projectChecks(sources) {
  const out = typeChecks(sources);
  const where = sources[0]?.file || '<input>';
  let motion = null, transitions = null, guarded = false;
  const radii = new Set(), sizes = new Set(), colours = new Set();
  for (const { css, file } of sources) {
    if (/prefers-reduced-motion/.test(css)) guarded = true;
    const { rules, keyframes } = cssRules(css);
    if (keyframes.length && !motion) motion = { file, evidence: `@keyframes ${keyframes[0]}` };
    for (const r of rules) {
      const d = r.decls;
      if ((d.animation || d['animation-name']) && !/^none\b/.test(d.animation || d['animation-name']) && !motion) motion = { file, line: r.line, evidence: `${r.sel} { animation: ${d.animation || d['animation-name']} }` };
      if (d.transition && !/^none\b/.test(d.transition) && !transitions) transitions = { file, line: r.line, evidence: `${r.sel} { transition: ${d.transition} }` };
      const rad = d['border-radius'];
      if (rad && !/var\(|^0(px)?$|50%|9{3,}/.test(rad)) radii.add(rad.trim());
      const fz = d['font-size'];
      if (fz && /^[\d.]+(px|rem|em|pt)$/.test(fz.trim())) sizes.add(String(toPx(fz.trim())));
      for (const [k, v] of Object.entries(d)) if (!k.startsWith('--')) for (const c of String(v).match(COLOR_RE) || []) { const p = parseColor(c); if (p && p.a > 0.05) colours.add(`${p.r},${p.g},${p.b}`); }
    }
  }
  const hit = motion || transitions;
  if (hit && !guarded) out.push({ detector: 'no-reduced-motion', file: hit.file, line: hit.line || 1, evidence: hit.evidence, message: motion ? 'Animation with no prefers-reduced-motion fallback anywhere in the project.' : 'Transitions with no prefers-reduced-motion fallback anywhere in the project.', severity: motion ? undefined : 'low' });
  if (radii.size > 5) out.push({ detector: 'value-sprawl', file: where, line: 1, evidence: `${radii.size} radii: ${[...radii].slice(0, 8).join(', ')}`, message: `${radii.size} different corner radii typed by hand: keep a small radius scale as tokens.` });
  if (sizes.size > 10) out.push({ detector: 'value-sprawl', file: where, line: 1, evidence: `${sizes.size} font sizes`, message: `${sizes.size} different literal font sizes: keep a type scale as tokens.` });
  if (colours.size > 16) out.push({ detector: 'value-sprawl', file: where, line: 1, evidence: `${colours.size} literal colours outside custom properties`, message: `${colours.size} different colours typed by hand outside the tokens: keep a palette as tokens.` });
  return out;
}

// The pairing record that creation workflows write before building: a "Type pairing"
// heading with Display:, Body: and Why: lines. Returns findings (empty when complete).
export function checkPairing(text, file = '<record>') {
  const m = text.match(/^#{1,6}\s*(?:type|typography|font)\s+pairing\b.*$/im);
  if (!m) return [{ detector: 'pairing-record', file, line: 1, evidence: 'no "Type pairing" section', message: 'No type pairing recorded: choose a display and a body font under the pairing rules and record them before building.' }];
  const sec = text.slice(m.index).split(/\n#{1,6}\s/)[0];
  const line = text.slice(0, m.index).split('\n').length;
  const out = [];
  // A value counts only when it is filled in: "[fill in ...]" or "TBD" is still a question.
  for (const [k, re] of [['Display', /^\s*[-*]?\s*\**(display|heading)s?\b[^:\n]*\**\s*:\s*(?!\[|tbd|todo|-\s*$)\S/im], ['Body', /^\s*[-*]?\s*\**body\b[^:\n]*\**\s*:\s*(?!\[|tbd|todo|-\s*$)\S/im], ['Why', /^\s*[-*]?\s*\**(why|reason|rationale)\b[^:\n]*\**\s*:\s*(?!\[|tbd|todo)\S.{2,}/im]])
    if (!re.test(sec)) out.push({ detector: 'pairing-record', file, line, evidence: `"Type pairing" has no ${k}: line`, message: `The pairing record is missing its ${k}: line.` });
  for (const f of BANNED_FONTS) if (new RegExp(`\\b${f}\\b`, 'i').test(sec) && !/mandat|brand (?:requires|guide)|required by/i.test(sec)) out.push({ detector: 'pairing-record', file, line, evidence: f, message: `The pairing uses ${f}, a banned default, without saying the brand mandates it.`, severity: 'medium' });
  return out;
}

function htmlDetectors(html, file, year) {
  const out = [];
  const src = stripHtml(html);
  const add = (detector, i, evidence, message, severity) => out.push({ detector, file, line: lineAt(src, i), evidence: String(evidence).slice(0, 160), message, severity });
  // headings: emoji, code-style, section numbers, order
  let prev = 0;
  for (const m of src.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const lvl = +m[1], t = textOf(m[2]);
    if (EMOJI.test(t)) add('emoji-heading', m.index, t, 'Emoji in a heading.');
    if (/^(\/\/|\/\*|#\s|<\/?\w|\$ |>_)/.test(t)) add('code-heading', m.index, t, 'Code-styled heading on non-code content.');
    if (SECTION_NUM.test(t) && lvl >= 2) add('numbered-headings', m.index, t, 'Small number beside a section heading.', 'low');
    if (prev && lvl > prev + 1) add('heading-order', m.index, `h${prev} → h${lvl}`, `Heading levels jump from h${prev} to h${lvl}.`);
    if (DECORATIVE_HEADINGS.test(t)) add('decorative-heading', m.index, t, 'Heading that could sit over any section: say what this one shows.');
    if (/^([A-Z][a-z]+ [a-z]+\.\s*){2,3}$/.test(t)) add('verb-pair', m.index, t, 'Two clipped orders as a headline ("Ship faster. Build smarter.").');
    if (new RegExp(`^${NUMW}\\b[^.]*?[,.]\\s+${NUMW}\\b`, 'i').test(t)) out.push({ detector: 'number-pair', file, line: lineAt(src, m.index), evidence: t, message: 'Number-pair heading formula: say what the section holds.' });
    prev = lvl;
  }
  // icon in a box above a heading (the feature-card template)
  for (const m of src.matchAll(/<(div|span|i)\b[^>]*class="[^"]*\b(icon[-_]?(?:box|tile|wrap|wrapper|circle|bg|container)|feature-icon)\b[^"]*"[^>]*>[\s\S]{0,300}?<\/\1>\s*<h[2-4]/gi)) out.push({ detector: 'icon-tile', rule: 'auto-tile-grid', file, line: lineAt(src, m.index), evidence: m[2], message: 'Rounded icon tile stacked above a heading.' });
  // broken or placeholder images
  for (const m of src.matchAll(/<img\b([^>]*)>/gi)) { const s = (m[1].match(/\bsrc\s*=\s*["']([^"']*)["']/i) || [])[1]; if (s === undefined || /^(#|about:blank)?$/.test(s.trim()) || /placeholder\.com|placehold\.co|dummyimage|via\.placeholder|picsum\.photos/i.test(s)) add('broken-image', m.index, m[0], 'Image with an empty, missing or placeholder source.'); }
  // sparkles as the AI badge, decorative shortcut pills
  for (const m of src.matchAll(/(?:class|data-icon|name)="[^"]*\bsparkles?\b[^"]*"|✨\s*AI\b|\bAI\s*✨/gi)) { add('sparkles-ai', m.index, m[0], 'Sparkles used as the AI badge: name the capability instead.'); break; }
  for (const m of src.matchAll(/⌘\s?[A-Z↵]|Ctrl\s?\+\s?K\b/g)) { add('shortcut-hint', m.index, m[0], 'Shortcut hint pill: show it only if the shortcut exists and works.'); break; }
  // code-style labels just before headings ("// features")
  for (const m of src.matchAll(/>\s*(\/\/\s*[\w ]{2,30}|\/\*[^*]{2,30}\*\/)\s*<\/(?:p|span|div|small)>\s*<h[1-3]/gi)) add('code-heading', m.index, m[1], 'Code comment used as a label above a heading.');
  // eyebrow labels: small element with eyebrow-ish class right before h1-h3
  for (const m of src.matchAll(/<(p|span|div|small)\b[^>]*class="[^"]*\b(eyebrow|kicker|overline|pretitle|pre-title|tagline|label)\b[^"]*"[^>]*>[^<]{1,40}<\/\1>\s*<h[1-3]/gi)) add('eyebrow', m.index, textOf(m[0]).slice(0, 60), 'Small label on its own line above a heading: banned outright.');
  // emoji in list items and buttons (interface icons)
  for (const m of src.matchAll(/<(li|button|a)\b[^>]*>([\s\S]*?)<\/\1>/gi)) { const t = textOf(m[2]); if (t.length < 160 && /^\p{Extended_Pictographic}/u.test(t)) add('emoji-heading', m.index, t, 'Emoji used as an interface icon or bullet.'); }
  // forms: placeholder-only labels
  const labelled = new Set([...src.matchAll(/<label\b[^>]*\bfor="([^"]+)"/gi)].map((m) => m[1]));
  for (const m of src.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
    const a = m[2];
    if (/type="(hidden|submit|button|checkbox|radio|image|reset)"/i.test(a)) continue;
    if (!/placeholder=/i.test(a)) continue;
    const id = (a.match(/\bid="([^"]+)"/) || [])[1];
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    const wrapped = /<label\b(?![\s\S]*<\/label>)/i.test(before);
    if (!(id && labelled.has(id)) && !wrapped && !/aria-label(ledby)?=/i.test(a)) add('placeholder-label', m.index, m[0], 'Field whose only label is its placeholder.');
  }
  // CTAs
  const ctas = [...src.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => ({ t: textOf(m[2]).toLowerCase(), i: m.index })).filter((x) => x.t && x.t.length < 40);
  const count = {};
  for (const c of ctas) count[c.t] = (count[c.t] || 0) + 1;
  for (const [t, n] of Object.entries(count)) if (n >= 3 && /(book|get started|sign up|contact|try|start|buy|request|demo|call)/.test(t)) add('cta-repeat', ctas.find((c) => c.t === t).i, `"${t}" ×${n}`, 'The same call to action shown three or more times.', 'low');
  if (count['get started'] && count['learn more']) add('twin-ctas', ctas.find((c) => c.t === 'learn more').i, '"Get started" + "Learn more"', 'Twin buttons: make the second a quiet text link.', 'low');
  if (/<marquee\b/i.test(src)) add('ticker', src.search(/<marquee\b/i), '<marquee>', 'Content that scrolls by itself.');
  for (const m of src.matchAll(/<(s|del|strike)\b[^>]*>\s*[$€£¥₹]|RM\s?\d/gi)) if (/<(s|del|strike)/i.test(m[0])) add('strikethrough-price', m.index, m[0], 'Struck-through price: show a discount only for a real, time-limited offer.', 'low');
  // controls: vague labels, no accessible name, an arrow on every one
  let arrows = 0, firstArrow = -1;
  for (const m of src.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const t = textOf(m[3]), a = m[2];
    if (/^(ok|okay|submit|yes|no|go|click here|here|read more|more|click)$/i.test(t)) add('vague-control', m.index, `<${m[1]}>${t}</${m[1]}>`, `"${t}" does not say what happens: name the action and its object.`);
    if (!t && !/aria-label(ledby)?\s*=\s*["'][^"']+|title\s*=\s*["'][^"']+/i.test(a) && !/<img\b[^>]*\balt\s*=\s*["'][^"']+/i.test(m[3]) && !/aria-label\s*=/.test(m[3])) add('unnamed-control', m.index, m[0], `A ${m[1] === 'a' ? 'link' : 'button'} with no name a screen reader can say.`);
    if (/(→|->|›|»|&rarr;|&raquo;)\s*$/.test(t)) { arrows++; if (firstArrow < 0) firstArrow = m.index; }
  }
  if (arrows >= 3) add('arrow-cta', firstArrow, `${arrows} buttons or links end in an arrow`, 'An arrow on every button: keep it for the main action, or drop it.', 'low');
  for (const m of src.matchAll(/<input\b[^>]*type\s*=\s*["']submit["'][^>]*value\s*=\s*["'](ok|submit|go)["']/gi)) add('vague-control', m.index, m[0], `"${m[1]}" does not say what happens.`);
  for (const m of src.matchAll(/<img\b([^>]*)>/gi)) if (!/\balt\s*=/i.test(m[1])) add('unnamed-control', m.index, m[0], 'Image with no alt attribute (use alt="" for pure decoration).');
  for (const m of src.matchAll(/\btabindex\s*=\s*["']?([1-9]\d*)/gi)) add('focus-removed', m.index, m[0], `tabindex="${m[1]}" overrides the natural Tab order.`);
  // page basics, for full documents only
  if (/<html\b/i.test(html)) {
    const head = (html.match(/<head\b[\s\S]*?<\/head>/i) || [''])[0];
    const miss = [];
    if (!/<html\b[^>]*\blang\s*=\s*["']?\w/i.test(html)) miss.push('lang');
    if (!/<title\b[^>]*>\s*\S/i.test(head)) miss.push('title');
    if (!/<meta\b[^>]*name\s*=\s*["']?viewport/i.test(head)) miss.push('viewport');
    const soft = [];
    if (!/<meta\b[^>]*name\s*=\s*["']?description/i.test(head)) soft.push('description');
    if (!/<meta\b[^>]*property\s*=\s*["']?og:image/i.test(head)) soft.push('og:image');
    if (!/<link\b[^>]*rel\s*=\s*["'][^"']*icon/i.test(head)) soft.push('favicon');
    if (miss.length || soft.length) add('page-basics', 0, `missing: ${[...miss, ...soft].join(', ')}`, `The page has no ${[...miss, ...soft].join(', ')}.`, miss.length ? undefined : 'low');
  }
  // things that move by themselves, scroll hijacking, scroll reveals, count-ups, highlighter marks
  for (const m of src.matchAll(/\b(?:class\s*=\s*["'][^"']*\b(carousel|swiper|slick-\w+|splide|glide|owl-carousel|marquee|ticker)\b[^"']*["']|(data-tilt|data-autoplay|data-carousel|data-slider)\b)/gi)) { add('auto-advance', m.index, m[0], 'Carousel, slider or tilt effect: show items whole and let people move them.'); break; }
  for (const m of html.matchAll(/<script\b[^>]*src\s*=\s*["'][^"']*(lenis|locomotive-scroll|fullpage|smooth-scrollbar|scrollmagic|skrollr|rellax)[^"']*["']/gi)) add('scroll-hijack', m.index, m[1], `${m[1]} takes over scrolling: keep native scroll unless this is the recorded idea.`, 'low');
  for (const m of src.matchAll(/\b(data-aos|data-sal|data-scroll-reveal|data-reveal)\b|class\s*=\s*["'][^"']*\bwow\b/gi)) { add('hidden-at-rest', m.index, m[0], 'Scroll-reveal attribute: the element starts hidden until a script shows it.'); break; }
  for (const m of src.matchAll(/\b(data-count(?:up|-to)?|data-target)\s*=|class\s*=\s*["'][^"']*\b(count-?up|counter|odometer)\b/gi)) { out.push({ detector: 'count-up', rule: 'fake-proof', file, line: lineAt(src, m.index), evidence: m[0], message: 'Numbers that count up on scroll: show the figure plainly, and only if it is real and sourced.', severity: 'low' }); break; }
  for (const m of src.matchAll(/<h[1-6]\b[^>]*>[\s\S]*?<mark\b[\s\S]*?<\/h[1-6]>/gi)) add('marker-highlight', m.index, textOf(m[0]).slice(0, 80), 'Highlighter mark inside a heading.', 'low');
  // conversation or template left in the page: markdown that never rendered
  for (const m of textOf(src).matchAll(/\*\*(?=\S)[^*\n]{1,60}(?<=\S)\*\*|(?:^|\s)#{2,3} [A-Z]/g)) { add('residue', src.indexOf(m[0].trim().slice(0, 12)), m[0].trim(), 'Markdown symbols showing on the page.'); break; }
  out.push(...textDetectors(textOf(src), file, year, src));
  return out;
}

// Plain text, Markdown and the visible text of HTML.
function textDetectors(text, file, year, original = text) {
  const out = [];
  const lineOf = (needle) => { const i = original.indexOf(needle); return i >= 0 ? lineAt(original, i) : 1; };
  const add = (detector, evidence, message, severity) => out.push({ detector, file, line: lineOf(evidence), evidence: String(evidence).slice(0, 160), message, severity });
  const seen = new Set();
  const once = (k) => (seen.has(k) ? false : (seen.add(k), true));
  for (const m of text.matchAll(HYPE)) if (once('h' + m[0].toLowerCase())) add('hype-words', m[0], `"${m[0]}": say concretely what it does for whom.`);
  for (const m of text.matchAll(BUILD)) if (once('b' + m[0].toLowerCase())) add('build-slogan', m[0], `"${m[0]}" describes how it was made, not what it does for the reader.`);
  for (const m of text.matchAll(PLACEHOLDER)) if (once('p' + m[0].toLowerCase())) add('placeholders', m[0], `Placeholder content "${m[0]}".`);
  for (const m of text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)) if (+m[1] < year - 1 && once('y' + m[1])) add('placeholders', m[0], `Copyright year ${m[1]} is out of date.`);
  for (const m of text.matchAll(/\b\d{1,3}(?:[,.]\d{3})+\+?\s+(?:happy |satisfied |trusted )?(?:customers|users|clients|teams|companies|businesses)\b/gi)) if (once('f' + m[0])) add('fake-proof', m[0], `"${m[0]}": show only if it is real and sourced.`, 'medium');
  for (const m of text.matchAll(/[—–-]\s*([A-Z][a-z]+ [A-Z]\.)(?=[\s,<]|$)/g)) if (once('q' + m[1])) add('fake-proof', m[0], `Quote attributed to "${m[1]}": use a real, named person with permission, or leave it out.`, 'medium');
  if (/\btrusted by\b/i.test(text) && once('t')) add('trusted-by', 'Trusted by', '"Trusted by" strip: only real clients with official logo files.', 'medium');
  if (/\bmost popular\b/i.test(text) && once('mp')) add('most-popular', text.match(/most popular/i)[0], '"Most popular": keep only if it is actually the plan most people pick.', 'low');
  if (/✦|✧|★\s*\S+\s*★|•\s*[A-Z ]{6,}\s*•/.test(text) && once('tk')) add('ticker', (text.match(/✦|✧|★/) || ['✦'])[0], 'Sparkle-separated phrases: one clear headline instead.');
  // writing tells
  const dashes = (text.match(/—/g) || []).length;
  if (dashes) add('em-dash', '—', `${dashes} em dash${dashes > 1 ? 'es' : ''}: use commas, colons, parentheses or a new sentence.`, dashes >= 3 ? 'medium' : 'low');
  const staged = [];
  for (const re of STAGED) for (const m of text.matchAll(re)) {
    const t = m[0].toLowerCase();
    if (staged.some((x) => x.includes(t) || t.includes(x))) continue; // one finding for overlapping patterns
    staged.push(t); add('staged-copy', m[0], `"${m[0].trim()}": state the point directly.`);
  }
  for (const m of original.matchAll(BAIT)) if (once('e' + m[0].toLowerCase())) add('engagement-bait', m[0], `"${m[0].trim()}": end on the last concrete point.`);
  for (const m of original.matchAll(VALIDATION)) if (once('v' + m[0].toLowerCase())) add('engagement-bait', m[0], `"${m[0]}": respond to the substance, skip the compliment.`);
  for (const m of text.matchAll(FILLER)) if (once('w' + m[0].toLowerCase())) add('filler-words', m[0], `"${m[0]}" adds words without meaning.`);
  // copy tells added in v2
  for (const re of STOCK_LINES) for (const m of text.matchAll(re)) if (once('sl' + m[0].toLowerCase())) add('stock-line', m[0], `"${m[0].trim()}" fits any business: say what this one does, for whom.`);
  for (const m of text.matchAll(PUFFERY)) if (once('pf' + m[0].toLowerCase())) add('puffery', m[0], `"${m[0]}": use is, has or does, or name the thing.`);
  for (const m of text.matchAll(ING_RIDER)) if (once('ir' + m[1].toLowerCase())) add('ing-rider', m[0].slice(2), `", ${m[1]} ..." claims a meaning the sentence never shows: state the result or stop at the fact.`);
  for (const re of PROCESS_TALK) for (const m of text.matchAll(re)) if (once('pt' + m[0].toLowerCase())) add('process-talk', m[0], `"${m[0].trim()}": the copy is describing itself. Give the content instead.`);
  for (const re of VIRTUE) for (const m of text.matchAll(re)) if (once('vw' + m[0].toLowerCase())) add('virtue-word', m[0], `"${m[0].trim()}": show it with a fact rather than announcing it.`);
  for (const m of text.matchAll(WORDY)) if (once('wd' + m[0].toLowerCase())) add('wordy', m[0], `"${m[0]}": use the short form.`);
  for (const m of text.matchAll(AUTHORITY)) if (once('va' + m[0].toLowerCase())) add('vague-authority', m[0], `"${m[0]}": name the source and its date, or drop the claim.`);
  for (const m of text.matchAll(COURTESY)) if (once('cc' + m[0].toLowerCase())) add('canned-courtesy', m[0], `"${m[0]}": open with the point, close with the next step.`);
  for (const m of original.matchAll(RESIDUE)) if (once('rs' + m[0].toLowerCase())) add('residue', m[0], `Template token "${m[0]}" left in.`);
  for (const m of text.matchAll(DEFAULT_CAST)) if (once('dc' + m[0])) out.push({ detector: 'default-cast', file, line: lineOf(m[0]), evidence: m[0], message: `"${m[0]}" is a stock sample company name: use the real one or leave it out.`, severity: 'low' });
  const hedges = [...text.matchAll(HEDGE)].map((m) => m[0]);
  if (hedges.length >= 3) add('hedge', hedges[0], `${hedges.length} hedges (${[...new Set(hedges.map((h) => h.toLowerCase()))].slice(0, 4).join(', ')}): commit where the evidence is solid.`);
  const trans = [...original.matchAll(TRANSITIONS)].map((m) => m[1]);
  if (trans.length >= 2) add('stock-transition', trans[0], `${trans.length} sentences open on stock connectors (${[...new Set(trans)].join(', ')}).`);
  const prose = original.split('\n').filter((l) => !/^\s*(#|[-*]\s|\d+\.\s|\||>|```)/.test(l)).join(' ');
  const bangs = (prose.replace(/<!--|!=|!\[|!important/g, '').match(/!/g) || []).length;
  if (bangs >= 2) add('exclaim', '!', `${bangs} exclamation marks in body copy.`);
  for (const m of prose.matchAll(/[a-z]{2} [-–] [a-z]{2}/gi)) if (once('ds')) add('dash-swap', m[0], `"${m[0]}": a spaced hyphen standing in for a dash. Rewrite the sentence.`, 'low');
  const sents = prose.split(/(?<=[.!?])\s+/).map((x) => x.trim().toLowerCase().split(/\s+/).slice(0, 2).join(' ')).filter((x) => /^[a-z']+ [a-z']+$/.test(x));
  for (let i = 2; i < sents.length; i++) if (sents[i] === sents[i - 1] && sents[i] === sents[i - 2] && once('eo' + sents[i])) add('echo-openers', sents[i], `Three sentences in a row open with "${sents[i]}".`);
  const tags = text.match(/(?:^|\s)#[A-Za-z][\w]+/g) || [];
  if (tags.length >= 3) add('hashtags', tags[0].trim(), `${tags.length} hashtags: two at most, worked into the text.`);
  let run = 0, runStart = null;
  for (const l of original.split('\n')) { if (/^\s*([-*+]|\d+[.)])\s+\S/.test(l)) { if (!run) runStart = l; run++; if (run === 8) add('bullet-run', runStart.trim(), 'Eight or more bullets in a row: write the connected parts as prose.'); } else if (l.trim()) run = 0; }
  const MINOR = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'vs', 'as', 'is', 'from', 'into', 'via']);
  for (const m of original.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const w = m[1].replace(/[*_`]/g, '').split(/\s+/).filter((x) => /^[A-Za-z]/.test(x) && !MINOR.has(x.toLowerCase()));
    if (w.length >= 4 && w.slice(1).every((x) => /^[A-Z][a-z]/.test(x)) && once('tc')) out.push({ detector: 'title-case', file, line: lineAt(original, m.index), evidence: m[1].slice(0, 80), message: 'Heading in Title Case: use sentence case unless the brand says otherwise.' });
    if (new RegExp(`^${NUMW}\\b[^.]*?[,.]\\s+${NUMW}\\b`, 'i').test(m[1]) && once('np')) out.push({ detector: 'number-pair', file, line: lineAt(original, m.index), evidence: m[1].slice(0, 80), message: 'Number-pair heading formula: say what the section holds.' });
  }
  // Markdown headings and bullets
  for (const m of original.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    if (EMOJI.test(m[2])) out.push({ detector: 'emoji-heading', file, line: lineAt(original, m.index), evidence: m[2].slice(0, 120), message: 'Emoji in a heading.' });
    if (/^(\/\/|\/\*)/.test(m[2])) out.push({ detector: 'code-heading', file, line: lineAt(original, m.index), evidence: m[2].slice(0, 120), message: 'Code-styled heading on non-code content.' });
    const h = m[2].replace(/[*_`]/g, '').trim();
    if (DECORATIVE_HEADINGS.test(h)) out.push({ detector: 'decorative-heading', file, line: lineAt(original, m.index), evidence: h, message: 'Heading that could sit over any section: say what this one shows.' });
    else if (/\?$/.test(h) && m[1].length >= 2) out.push({ detector: 'decorative-heading', file, line: lineAt(original, m.index), evidence: h, message: 'Heading phrased as a question: state what the section shows.' });
  }
  for (const m of original.matchAll(/^\s*[-*]\s+\*\*[^*\n]{1,40}[.:]\*\*\s+\S/gm)) { out.push({ detector: 'decorative-heading', file, line: lineAt(original, m.index), evidence: m[0].trim().slice(0, 80), message: 'Bullet that opens with a bolded label: write it as a plain sentence.' }); break; }
  for (const m of original.matchAll(/^\s*[-*]\s+(\p{Extended_Pictographic}.*)$/gmu)) out.push({ detector: 'emoji-heading', file, line: lineAt(original, m.index), evidence: m[1].slice(0, 120), message: 'Emoji as a bullet in a list.' });
  // ALL CAPS paragraphs and very long lines (Markdown or text)
  for (const para of original.split(/\n\s*\n/)) {
    const t = para.replace(/[#>*_`-]/g, '').trim();
    const letters = t.replace(/[^A-Za-z]/g, '');
    if (letters.length > 60 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8) out.push({ detector: 'reading', file, line: lineOf(para.slice(0, 40)), evidence: t.slice(0, 80), message: 'A paragraph set in capitals.' });
  }
  return out;
}

// ---- driver ---------------------------------------------------------------------------------
const EXT = { '.html': 'html', '.htm': 'html', '.css': 'css', '.md': 'text', '.mdx': 'text', '.txt': 'text' };
const DEFAULT_CONTEXT = { html: ['web', 'app'], css: ['web', 'app'], text: ['doc', 'copy'] };
function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) if (!['node_modules', '.git', 'dist', 'vendor', '.cache', 'fonts'].includes(e)) walk(path.join(p, e), out); }
  // Licence and notice files are legal text, not design or copy.
  else if (EXT[path.extname(p).toLowerCase()] && !/^(licen[cs]e|ofl|notice|copying|third[-_]?party)/i.test(path.basename(p)) && !/\.min\./.test(p)) out.push(p);
  return out;
}
const RULE = Object.fromEntries(RULES.rules.map((r) => [r.id, r]));
// Detectors that report under another rule's id.
const ALIAS = { residue: 'placeholder-content', 'default-cast': 'placeholder-content', 'blur-blob': 'glow', hashtags: 'engagement-bait', 'dash-swap': 'em-dashes', 'number-pair': 'casing-and-formula' };
function resolve(raw, contexts) {
  const byDetector = {};
  for (const r of RULES.rules) if (r.detector) (byDetector[r.detector] ||= []).push(r);
  return raw.flatMap((f) => {
    const id = f.rule || ALIAS[f.detector];
    const cands = id ? [RULE[id]].filter(Boolean) : byDetector[f.detector] || [];
    const r = cands.find((x) => x.contexts.some((c) => contexts.includes(c)));
    if (!r) return [];
    return [{ rule: r.id, detector: f.detector, severity: f.severity || r.severity, file: f.file, line: f.line, evidence: f.evidence, message: f.message, instead: r.instead }];
  });
}
// One file. With project: true (the default) the file's own CSS also gets the
// project-level typography checks; checkPaths runs those once across every file instead.
export function checkText(content, kind, file = '<input>', { context, year = new Date().getFullYear(), project = true } = {}) {
  // Markdown and text in a UI context are working notes, not interface copy: UI rules check HTML and CSS only.
  if (kind === 'text' && (context === 'app' || context === 'web')) return [];
  const raw = kind === 'html' ? [...htmlDetectors(content, file, year), ...cssDetectors(htmlToCss(content), file)]
    : kind === 'css' ? cssDetectors(content, file) : textDetectors(content, file, year);
  if (project && kind !== 'text') raw.push(...projectChecks([{ css: kind === 'html' ? htmlToCss(content) : content, file }]));
  return resolve(raw, context ? [context] : DEFAULT_CONTEXT[kind]);
}
export function checkPaths(paths, opts = {}) {
  const files = paths.flatMap((p) => walk(p));
  const findings = files.flatMap((f) => checkText(fs.readFileSync(f, 'utf8'), EXT[path.extname(f).toLowerCase()], f, { ...opts, project: false }));
  const styled = files.filter((f) => EXT[path.extname(f).toLowerCase()] !== 'text').map((f) => ({ file: f, css: EXT[path.extname(f).toLowerCase()] === 'html' ? htmlToCss(fs.readFileSync(f, 'utf8')) : fs.readFileSync(f, 'utf8') }));
  if (styled.length) findings.push(...resolve(projectChecks(styled), opts.context ? [opts.context] : ['web', 'app']));
  if (opts.pairing) findings.push(...resolve(checkPairing(fs.existsSync(opts.pairing) ? fs.readFileSync(opts.pairing, 'utf8') : '', opts.pairing), opts.context ? [opts.context] : ['web', 'app', 'deck', 'doc']));
  return { files: files.length, findings };
}
export function rulesFor(context, kinds) {
  return RULES.rules.filter((r) => (!context || r.contexts.includes(context)) && (!kinds || r.check.some((k) => kinds.includes(k))));
}
function listMarkdown(context, kinds) {
  const rows = rulesFor(context, kinds).map((r) => `| ${r.id} | ${r.dont.replace(/\|/g, '/')} | ${r.instead.replace(/\|/g, '/')} | ${r.check.join(', ')} | ${r.severity} |`);
  const done = RULES.done_checklist.filter((d) => !context || d.contexts.includes(context)).map((d) => `- [ ] ${d.check}`);
  return `| Rule | Don't | Instead | How to check | Severity |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n**Before you say it's done:**\n${done.join('\n')}\n`;
}

// Run as a CLI only when this file is the entry point. Resolve symlinks on both sides, so
// running it through an installed link (~/.claude/skills/slop-guard/check-slop.mjs) works.
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); } catch { return false; } })();
// The CLI sets process.exitCode rather than exiting at once, so piped output is never cut short.
function cli() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const context = opt('--context');
  if (context && !RULES.contexts[context]) { console.error(`Unknown context "${context}". Use one of: ${Object.keys(RULES.contexts).join(', ')}`); process.exitCode = 2; return; }
  if (args.includes('--rules-md')) {
    const parts = Object.entries(RULES.contexts).map(([c, label]) => `## ${c}: ${label}\n\n${listMarkdown(c)}`);
    process.stdout.write(`# slop-guard rules by context\n\nGenerated from \`rules.json\` v${RULES.version} by \`node check-slop.mjs --rules-md\`. Do not edit by hand. ${RULES.rules.length} rules. These are design and writing preferences, not a test of who or what made something.\n\n${parts.join('\n')}`);
    return;
  }
  if (args.includes('--list')) { process.stdout.write(listMarkdown(context)); return; }
  if (args.includes('--rubric')) { process.stdout.write(listMarkdown(context, ['screenshot', 'judgement'])); return; }
  const skip = new Set(['--context', '--json', '--year', '--pairing']);
  const targets = args.filter((a, i) => !a.startsWith('--') && !skip.has(args[i - 1]));
  if (!targets.length) { console.error('Usage: node check-slop.mjs <file or folder>... [--context web|app|deck|doc|copy|image] [--json out.json] [--strict]'); process.exitCode = 2; return; }
  const res = checkPaths(targets, { context, year: +(opt('--year') || new Date().getFullYear()), pairing: opt('--pairing') });
  const order = { high: 0, medium: 1, low: 2 };
  res.findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of res.findings) counts[f.severity]++;
  for (const f of res.findings) console.log(`${f.severity.toUpperCase().padEnd(6)} ${f.rule.padEnd(20)} ${path.relative(process.cwd(), f.file)}:${f.line}  ${f.message}\n       ${f.evidence}`);
  console.log(`\nslop-guard: ${res.files} file(s), ${res.findings.length} finding(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low${context ? ` (context: ${context})` : ''}. Hits are evidence for a reviewer, not a verdict.`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ version: RULES.version, context: context || null, counts, ...res }, null, 2));
  process.exitCode = args.includes('--strict') && counts.high ? 1 : 0;
}
if (isMain) cli();
