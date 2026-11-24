#!/usr/bin/env node
// slop-guard checker: finds the machine-checkable anti-slop rules (rules.json) in HTML,
// CSS, Markdown, text and JS/TS/Python source. A hit is evidence for a reviewer, not a verdict:
// the rules are design preferences, not an AI-authorship test. No dependencies.
//
// Usage:
//   node check-slop.mjs <file or folder>... [--context web|app|deck|doc|copy|image|code]
//                       [--json out.json] [--strict] [--year 2026]
//   node check-slop.mjs --list [--context deck]        rules for a context, as Markdown
//   node check-slop.mjs --rubric [--context doc]       screenshot and judgement checks only
//   node check-slop.mjs --rules-md > RULES.md            regenerate RULES.md from rules.json
//   add --pairing <file.md> to require a "Type pairing" record (Display:, Body:, Why:) in that file
// Exit code: 0, or 1 with --strict when any High finding is found.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
// Added in v2.1: interface copy, prose tells and control selectors.
const GENERIC_STATUS = /\b(something went wrong|an? (?:unexpected |unknown )?error (?:has )?occurred|oops[!.,]|unknown error|no (?:items|data|results|records) (?:to display|to show|available|found)|invalid input)/gi;
const COMING_SOON = /\b(coming soon|under construction|stay tuned|page (?:is )?not (?:ready|built) yet)\b/gi;
const FALSE_RANGE = /\b(?:everything |anything )?from (?:[\w-]+ ){0,2}[\w-]+ to (?:[\w-]+ ){0,2}[\w-]+(?:,? and everything in between|,? and beyond)|\beverything from (?:[\w-]+ ){0,2}[\w-]+ to (?:[\w-]+ ){0,2}[\w-]+/gi;
const CUTOFF = /\b(as of my (?:last|latest) (?:update|training)|my (?:knowledge|training) (?:cutoff|cut-off)|i (?:don'?t|do not) have (?:access to )?real-time|while (?:specific )?(?:details|information) (?:is|are) (?:limited|scarce)|(?:specific|detailed) (?:details|information) (?:is|are) not (?:readily )?available)/gi;
const GENERIC_ENDING = /\b(the future (?:looks|is) bright|only time will tell|(?:it )?remains to be seen|exciting times (?:lie )?ahead|watch this space|the journey (?:is just|has only just) beg(?:un|inning))\b/gi;
const FANCY = /\b(utili[sz](?:e|es|ed|ing)|leverag(?:e|es|ed|ing) (?:the|our|your|their|this|these|a|an|its)\b|facilitat(?:e|es|ed|ing)|commenc(?:e|es|ed|ing)|prior to|in order to|numerous|synerg(?:y|ies|istic)|north star|flywheel|substrate)\b/gi;
const PROMO = /\b(vibrant|breathtaking|stunning|renowned|world-renowned|iconic|groundbreaking|must-(?:see|visit|have)|awe-inspiring|unforgettable)\b/gi;
const DESPITE = /\bdespite (?:these|those|its|their|the|some|many|numerous) (?:challenges|setbacks|obstacles|hurdles|difficulties)[^.!?\n]{0,80}?\b(?:continues? to|remains?|still manages? to|has managed to)\b/gi;
const AMBIG_DATE = /\b(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})\b/g;
const CONTROL_SEL = /(^|[\s,>+~(])(button|\.btn[\w-]*|\.button[\w-]*|\.icon-?(?:btn|button)[\w-]*|\[role=["']?button["']?\]|select|\.chip[\w-]*|\.tab|\.toggle[\w-]*|\.close[\w-]*|\.fab)(?=$|[\s,>+~:.\[)])/i;
const FIELD_SEL = /(^|[\s,>+~])(input|select|textarea|\.input[\w-]*|\.field[\w-]*|\.form-control)(?=$|[\s,>+~:.\[])/i;

// ---- v2.2: masking, literal sense, rhetoric and rhythm ---------------------------------------
const blank = (s) => s.replace(/[^\n]/g, ' ');
// Quoted, cited and code text is someone else's words, or not prose at all. Blank it before the
// prose patterns run, keeping every offset and line number. Quote marks themselves stay.
export function maskProse(s, { quotes = true, code = true, blockquotes = true, urls = true } = {}) {
  if (code) s = s.replace(/^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\2[^\n]*$/gm, blank).replace(/`[^`\n]+`/g, blank).replace(/^(?: {4}|\t)(?!\s*[-*+]\s|\s*\d+[.)]\s).*$/gm, (l, i, all) => (/\n\s*\n$/.test(all.slice(Math.max(0, i - 2), i)) || i === 0 ? blank(l) : l));
  if (blockquotes) s = s.replace(/^[ \t]*>.*$/gm, blank);
  if (urls) s = s.replace(/\bhttps?:\/\/[^\s)>\]]+/g, blank);
  if (quotes) s = s.replace(/"[^"\n]{1,400}"|“[^”\n]{1,400}”/g, (m) => m[0] + blank(m.slice(1, -1)) + m.slice(-1))
    // single quotes as quote marks: opened after a space or bracket, closed before punctuation,
    // so the apostrophe in "it's" does not end the quote
    .replace(/(^|[\s(\[])'([^'\n]{1,200}?)'(?=[\s.,;:!?)\]]|$)/gm, (m, pre, body) => `${pre}'${blank(body)}'`);
  // a region the writer marked: <!-- slop-guard: off --> ... <!-- slop-guard: on -->
  s = s.replace(/slop-guard:\s*off\b[\s\S]*?(?:slop-guard:\s*on\b|$)/g, blank);
  return s;
}
// A file that opts out entirely, such as a catalogue of the patterns themselves.
const IGNORE_FILE = /slop-guard:\s*ignore-file\b/;
// A citation in the same sentence: (Author 2020), [3], [^note], a link, a DOI or "et al.".
const CITATION = /\(\s*[A-Z][^()\n]{0,80}?\b(?:1[89]|20)\d{2}[a-z]?\s*\)|\[\d+(?:\s*[,–-]\s*\d+)*\]|\[\^[^\]\n]+\]|https?:\/\/|\bdoi:|\bet al\.|\b(?:source|sources|via):\s/i;
// Words that are slop as metaphor and fine in their literal sense. Each entry names the finding it
// clears and the evidence it needs: the word itself, then what comes straight after or before it,
// or what sits nearby (within about a sentence).
const LITERAL = [
  { det: 'placeholders', word: /^company name$/i, before: /\b(?:the|a|an|their|its|our|his|her|each|any|this|that|every|real|legal|registered|full|trading|new|old)\s+$/i },
  { det: 'default-cast', near: /\b(?:pseudonyms?|fictional|made[- ]up|not (?:its|their|the|his|her) real name|anonymi[sz]ed|stand-in|renamed|sample (?:company|data|tenant)|demo tenant)\b/i },
  { det: 'hype-words', word: /^elevated?s?$/i, after: /^\s+(?:blood|levels?|risks?|temperatures?|pressures?|heart|position|platforms?|floors?|roads?|railways?|trains?|walkways?|terrain|ground|enzymes?|readings?|concentrations?|liver)\b/i },
  { det: 'hype-words', word: /^elevated$/i, before: /\b(?:is|are|was|were|remain(?:s|ed)?|became|stays?|slightly|mildly|highly|significantly)\s+$/i, near: /\b(?:levels?|blood|risk|pressure|temperature|count|enzymes?|readings?|marker|patients?|dose)\b/i },
  { det: 'hype-words', word: /^seamless(?:ly)?$/i, after: /^\s+(?:pipes?|tubes?|tubing|steel|fabric|garments?|knit\w*|gutters?|floors?|stockings?|joints?|welds?)\b/i },
  { det: 'hype-words', word: /^unleash/i, near: /\b(?:leash|dogs?|pupp(?:y|ies)|hounds?)\b/i },
  { det: 'hype-words', word: /^revolution/i, near: /\b(?:war|independence|french|american|industrial|russian|bolshevik|cultural|history|historians?|orbits?|rotations?|planets?|axis)\b/i },
  { det: 'fancy-word', word: /^flywheel$/i, near: /\b(?:engines?|motors?|inertia|rpm|crankshaft|torque|clutch|bearings?|energy storage)\b/i },
  { det: 'fancy-word', word: /^substrates?$/i, near: /\b(?:enzymes?|wafers?|cells?|soil|semiconductors?|pcbs?|chemicals?|reactions?|layers?|coatings?|films?|growth|microb\w*|silicon|catalys\w*)\b/i },
  { det: 'fancy-word', word: /^north star$/i, near: /\b(?:polaris|sky|night|navigat\w*|constellations?|astronom\w*|celestial)\b/i },
  { det: 'fancy-word', word: /^leverag/i, near: /\b(?:debt|loans?|margin|ratios?|equity|financial|fulcrum|levers?|borrow\w*|buyout)\b/i },
  { det: 'filler-words', word: /^realm$/i, near: /\b(?:kings?|kingdom|crown|queens?|monarch\w*|fantasy|dungeons?|games?|defence of the|coins?)\b/i },
  { det: 'filler-words', word: /^paradigm$/i, near: /\b(?:programming|kuhn|scientific revolutions?|grammar|inflection|declension|conjugation)\b/i },
  { det: 'filler-words', word: /^pivotal$/i, near: /\b(?:pivots?|hinges?|joints?|axles?)\b/i },
  { det: 'promo-word', word: /^stunning$/i, near: /\b(?:stun (?:gun|grenade)|tasers?|concussion|blow to the head)\b/i },
  { det: 'puffery', word: /^serves as/i, near: /\b(?:tennis|volleyball|badminton|squash)\b/i },
  { det: 'vague-authority', sentence: CITATION },
  { det: 'fake-proof', sentence: CITATION },
];
// Drop findings whose evidence is used in its literal sense in `raw` (the unmasked text).
function guardLiteral(out, text, raw) {
  return out.filter((f) => {
    const rules = LITERAL.filter((g) => g.det === f.detector && (!g.word || g.word.test(String(f.evidence).trim())));
    if (!rules.length) return true;
    const ev = String(f.evidence).trim();
    let from = 0, i, kept = false;
    // the finding stands if any occurrence is not cleared by a guard
    while ((i = text.toLowerCase().indexOf(ev.toLowerCase(), from)) >= 0) {
      from = i + 1;
      const before = raw.slice(Math.max(0, i - 40), i), after = raw.slice(i + ev.length, i + ev.length + 40);
      const near = raw.slice(Math.max(0, i - 160), i + ev.length + 160);
      const s0 = Math.max(raw.lastIndexOf('. ', i), raw.lastIndexOf('\n', i), 0), s1 = raw.slice(i).search(/[.!?](?:\s|$)|\n\s*\n/);
      const sentence = raw.slice(s0, s1 < 0 ? undefined : i + s1 + 1);
      const cleared = rules.some((g) => (!g.before || g.before.test(before)) && (!g.after || g.after.test(after)) && (!g.near || g.near.test(near)) && (!g.sentence || g.sentence.test(sentence)));
      if (!cleared) { kept = true; break; }
    }
    return kept || i === -1 && from === 0;
  });
}
const STOPWORDS = new Set('a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those i you he she we they me him her us them my your his our their not no so than then there here what which who whom whose when where why how all any each few more most other some such only own same too very can will just do does did done have has had having would should could may might must shall into over under about after before again further once up down out off above below between through during against both either neither nor also yet one two'.split(' '));
const NOT_SLOGAN = /,\s+not\s+(?:a |an |the |just |only |your |our |their )?[\w'-]+(?:\s+[\w'-]+){0,3}[.!](?=\s|$)/gi;
const REVEAL = /(?:^|[.!?]\s+|\n)((?:here'?s the (?:thing|truth|deal|problem|twist|kicker)|the (?:truth|secret|lesson|twist|irony|catch|problem|point|reality|kicker|difference|real question)(?: is| was| here)?):)\s/gim;
const HOOK = /^[ \t]*(ever (?:wondered|noticed|asked yourself)|what if i told you|have you ever (?:wondered|noticed|felt|asked)|picture this|imagine (?:this|if)\b|let'?s be (?:real|honest)|hot take:|unpopular opinion:|stop (?:doing|using|saying) [^.!?\n]{1,30}\.|nobody talks about)/gim;
const TRIPLET = /\b([a-z]+(?: [a-z]+)?), ([a-z]+(?: [a-z]+)?),? and ([a-z]+(?: [a-z]+)?)\b/gi;
const stats = (xs) => { const n = xs.length, mean = xs.reduce((a, b) => a + b, 0) / (n || 1); const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n || 1)); return { n, mean, sd, cv: mean ? sd / mean : 0 }; };
// Prose of a Markdown or text body: headings, list items, tables, quotes and code removed.
const proseLines = (s) => s.split('\n').map((l) => (/^\s*(#|[-*+]\s|\d+[.)]\s|\||>|```|~~~|<)/.test(l) ? '' : l));
const proseParagraphs = (s) => proseLines(s).join('\n').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => /[a-z]/i.test(p));
const sentencesOf = (p) => p.split(/(?<=[.!?])["”’)]?\s+(?=["“‘(]?[A-Z0-9])/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 1 && /[a-z]/i.test(x));
const wordCount = (s) => (s.match(/[A-Za-z0-9][\w'’-]*/g) || []).length;
// Rhetoric and rhythm: counted habits, one use of which is a choice.
function rhetoricDetectors(text, add) {
  // dialogue and quoted passages are someone else's rhythm: leave those paragraphs out of the counts
  const paras = proseParagraphs(text).filter((p) => !/"/.test(p));
  const sents = paras.flatMap(sentencesOf);
  const notSlogans = [...text.matchAll(NOT_SLOGAN)].map((m) => m[0]);
  if (notSlogans.length >= 3) add('not-slogan', notSlogans[0].replace(/^,\s*/, ''), `${notSlogans.length} sentences end on ", not ...": state what it is and drop most of the contrasts.`);
  const reveals = [...text.matchAll(REVEAL)].map((m) => m[1]);
  if (reveals.length) add('colon-reveal', reveals[0], `"${reveals[0]}" sets up a reveal${reveals.length > 1 ? ` (${reveals.length} in all)` : ''}: say the point in the sentence itself.`);
  for (const m of text.matchAll(HOOK)) { add('hook-formula', m[1], `"${m[1].trim()}" is a stock hook: open on the specific thing instead.`); break; }
  let qa = 0, firstQa = null;
  for (let i = 0; i + 1 < sents.length; i++) {
    const q = sents[i], a = sents[i + 1];
    if (/\?$/.test(q) && wordCount(q) <= 8 && !/\?$/.test(a) && wordCount(a) <= 8) { qa++; firstQa ||= `${q} ${a}`; }
  }
  if (qa >= 2) add('self-qa', firstQa, `${qa} short questions answered at once by the writer ("${firstQa}"): make the statement instead.`);
  const punch = paras.filter((p) => sentencesOf(p).length === 1 && wordCount(p) <= 6);
  if (paras.length >= 6 && punch.length >= 3 && punch.length / paras.length >= 0.3) add('punch-paragraph', punch[0], `${punch.length} of ${paras.length} paragraphs are a single line of six words or fewer: fold most of them into the argument.`);
  const tokens = (proseLines(text).join(' ').toLowerCase().match(/[a-z][a-z'’-]*/g) || []);
  const grams = {};
  for (let i = 0; i + 3 < tokens.length; i++) {
    const g = tokens.slice(i, i + 4);
    if (g.filter((w) => !STOPWORDS.has(w)).length < 2) continue;
    const k = g.join(' '); grams[k] = (grams[k] || 0) + 1;
  }
  const rep = Object.entries(grams).filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]);
  if (rep.length) add('repeated-phrase', rep[0][0], `"${rep[0][0]}" appears ${rep[0][1]} times${rep.length > 1 ? `, and ${rep.length - 1} other phrase${rep.length > 2 ? 's' : ''} four or more times` : ''}: vary it or cut the repeats.`);
  const lens = sents.map(wordCount).filter((n) => n >= 3);
  const st = stats(lens);
  if (st.n >= 12 && st.mean >= 8 && st.cv < 0.3) add('uniform-rhythm', sents[0], `${st.n} sentences average ${st.mean.toFixed(0)} words with little variation (spread ${st.sd.toFixed(1)}): mix short sentences with long ones.`);
  else {
    const pl = stats(paras.map(wordCount).filter((n) => n >= 20));
    if (pl.n >= 6 && pl.cv < 0.15) add('uniform-rhythm', paras[0], `${pl.n} paragraphs of almost the same length (about ${pl.mean.toFixed(0)} words each): let their length follow the content.`);
  }
  const words = tokens.length;
  const triplets = [...proseLines(text).join('\n').matchAll(TRIPLET)].map((m) => m[0]);
  if (triplets.length >= 4 && words / triplets.length <= 150) add('triplets', triplets[0], `${triplets.length} lists of exactly three ("${triplets[0]}"): keep the threes that are real and break the pattern elsewhere.`);
}

// ---- v2.3: arrangement of ideas, unsourced claims ------------------------------------------
const stem = (w) => w.replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s)$/, '');
const contentWords = (t) => new Set((t.toLowerCase().match(/[a-z][a-z'’-]{3,}/g) || []).filter((w) => !STOPWORDS.has(w)).map(stem));
const overlap = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.min(a.size, b.size); };
const RECAP = /^(?:in short|in sum|to sum (?:it )?up|to summari[sz]e|in summary|so,|ultimately|in the end|all in all|the bottom line|in conclusion|overall|to conclude|that'?s why|which is why)\b/i;
// Preview, body, recap: the ending restates the opening, or the introduction lists every
// section and the ending repeats it.
function arrangementDetectors(text, add) {
  const lines = text.split('\n');
  const heads = [], body = [];
  let intro = [], seenHead = false;
  for (const l of lines) {
    const h = l.match(/^#{2,3}\s+(.+)/);
    if (h) { heads.push(h[1]); seenHead = true; continue; }
    if (!seenHead && !/^\s*#/.test(l)) intro.push(l);
  }
  const paras = proseParagraphs(text).filter((p) => !/"/.test(p));
  if (paras.length < 4 || wordCount(paras.join(' ')) < 250) return;
  const first = contentWords(paras[0]), last = contentWords(paras[paras.length - 1]);
  const o = overlap(first, last), lastP = paras[paras.length - 1];
  const recap = (RECAP.test(lastP) && o >= 0.4 && last.size >= 4) || (o >= 0.6 && last.size >= 6);
  if (recap) add('recap-ending', lastP.slice(0, 80), `The last paragraph restates the first (${Math.round(o * 100)}% of its key words): end on something new, such as the decision, the next step or the open question.`);
  const introWords = contentWords(proseParagraphs(intro.join('\n')).join(' '));
  const previewed = heads.filter((h) => { const w = contentWords(h); return w.size && [...w].every((x) => introWords.has(x)); });
  if (heads.length >= 3 && previewed.length / heads.length >= 0.75 && recap) add('preview-recap', heads[0], `The introduction names ${previewed.length} of ${heads.length} section headings and the ending repeats the opening: say it once, in the section where it belongs.`);
}
// Claims a reader would want a source for. Commercial superlatives and proof words are medium;
// bare percentages and multipliers are low, and count as sourced when the document has a
// Sources or References section.
const SUPERLATIVE = /\b(?:the|our|its|their) (?:best|fastest|cheapest|safest|easiest|smartest|leading|top-rated|highest-rated|most (?:trusted|popular|advanced|accurate|reliable|secure|powerful|affordable|loved))\b(?: [\w-]+){0,3}? (?:tools?|apps?|platforms?|products?|services?|solutions?|software|agenc(?:y|ies)|compan(?:y|ies)|teams?|choices?|options?|ways?|providers?|brands?|models?|systems?|partners?|studios?)\b|\b(?:#1|number one|no\. 1) (?:[\w-]+ ){0,2}(?:tools?|apps?|platforms?|products?|services?|solutions?|software|agency|company|choice|provider|brand)\b|\bworld'?s (?:first|leading|largest|best|fastest|most (?:trusted|popular|advanced|accurate|reliable|secure|powerful|loved|used))\b|\b(?:industry|market|category)[- ]leading\b|\bclinically (?:proven|tested)\b|\bscientifically proven\b|\bproven to\b|\bguaranteed? (?:to|results?|success)\b|\baward-winning\b/gi;
const FIGURE = /(?<![\w.])\d+(?:\.\d+)?\s?%|(?<![\w.])\d+(?:\.\d+)?x (?:faster|more|better|cheaper|less|fewer|higher|lower|quicker)\b|\b\d+(?:\.\d+)? times (?:faster|more|better|cheaper|less|fewer|higher|lower|quicker)\b/gi;
const SOURCES_SECTION = /^#{1,6}\s*(?:sources?|references?|bibliography|citations?|notes|endnotes|footnotes|data sources?|methodology)\b|<h[1-6][^>]*>\s*(?:sources?|references?|bibliography|citations?|notes)\b/im;
const ATTRIBUTION = /\b[Aa]ccording to [A-Z]|\b(?:reports?|found|finds|survey|study|data) (?:by|from) [A-Z]|\b[A-Z][\w&.-]+(?: [A-Z][\w&.-]+){0,3} (?:reports?|reported|found|finds|estimates?|estimated) (?:that )?/;
function claimDetectors(raw, add) {
  const docSourced = SOURCES_SECTION.test(raw);
  const clean = maskProse(raw, { quotes: false, urls: false });
  const paras = proseParagraphs(clean);
  const sup = [], fig = [];
  for (const p of paras) {
    const sents = sentencesOf(p);
    sents.forEach((sent, i) => {
      const sourced = CITATION.test(sent) || ATTRIBUTION.test(sent) || CITATION.test(sents[i + 1] || '');
      if (sourced) return;
      const unquoted = maskProse(sent, { code: false, blockquotes: false, urls: false });
      for (const m of unquoted.matchAll(SUPERLATIVE)) sup.push(m[0]);
      if (!docSourced) for (const m of unquoted.matchAll(FIGURE)) fig.push(m[0]);
    });
  }
  if (sup.length) add('unsourced-claim', sup[0], `${sup.length} claim${sup.length > 1 ? 's' : ''} like "${sup[0]}" with no source nearby: cite who measured it, or drop the claim.`);
  if (fig.length) add('unsourced-claim', fig[0], `${fig.length} figure${fig.length > 1 ? 's' : ''} such as "${fig[0]}" with no source in the sentence or the next: link or name the source, or add a Sources section.`, 'low');
}
// Text people see outside the page body: alt text, titles, labels and meta descriptions in HTML,
// text in SVG, and text in JSX. Returned as a copy of the source the same length, with everything
// else blanked, so line numbers stay right.
function keepOnly(src, ranges) {
  const out = src.replace(/[^\n]/g, ' ').split('');
  for (const [a, b] of ranges) for (let k = a; k < b; k++) out[k] = src[k] === '\n' ? '\n' : src[k];
  return out.join('');
}
const SENTENCE_END = (s) => (/[.!?:]\s*$/.test(s) ? '' : '.');
function attributeText(html) {
  const ranges = [];
  for (const m of html.matchAll(/\s(alt|title|aria-label|aria-description)\s*=\s*(["'])([^"'\n]{3,})\2/gi)) { const at = m.index + m[0].lastIndexOf(m[3]); ranges.push([at, at + m[3].length]); }
  for (const m of html.matchAll(/<meta\b[^>]*(?:name|property)\s*=\s*["'](?:description|og:description|og:title|twitter:description|twitter:title)["'][^>]*>/gi)) { const c = m[0].match(/\scontent\s*=\s*(["'])([^"']+)\1/i); if (c) { const at = m.index + m[0].indexOf(c[2]); ranges.push([at, at + c[2].length]); } }
  return keepOnly(html, ranges);
}
function svgText(svg) {
  const ranges = [];
  for (const m of svg.matchAll(/<(text|tspan|title|desc)\b[^>]*>([^<]+)</gi)) { const at = m.index + m[0].indexOf('>') + 1; ranges.push([at, at + m[2].length]); }
  return keepOnly(svg, ranges);
}
function jsxText(src) {
  const ranges = [];
  for (const m of src.matchAll(/>([^<>{}`;=()]*[A-Za-z]{2,}[^<>{}`;=()]*)<\/?[A-Za-z]/g)) { if (/^\s*$/.test(m[1]) || /&&|\|\||=>/.test(m[1])) continue; const at = m.index + 1; ranges.push([at, at + m[1].length]); }
  for (const m of src.matchAll(/\s(alt|title|aria-label|label|description|heading|subtitle|cta)\s*=\s*(["'])([^"'\n]{3,})\2/g)) { const at = m.index + m[0].lastIndexOf(m[3]); ranges.push([at, at + m[3].length]); }
  return keepOnly(src, ranges);
}

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
    // v2.1: touch targets, field text size, viewport units, z-index, slow transitions, font-display
    const lastParts = r.sel.split(',').map((x) => x.trim().split(/\s*[\s>+~]\s*/).pop());
    if (lastParts.some((x) => CONTROL_SEL.test(x) && !/::|checkbox|radio|range|:disabled|\[disabled|sr-only|visually-hidden/i.test(x))) {
      const small = ['height', 'width', 'min-height', 'min-width'].map((p) => [p, toPx(d[p] || '')]).filter(([, v]) => v != null && v > 0 && v < 44);
      const ok = ['min-height', 'min-width'].some((p) => (toPx(d[p] || '') || 0) >= 44);
      if (small.length && !ok) add('touch-target', r, `${r.sel} { ${small.map(([p]) => `${p}: ${d[p]}`).join('; ')} }`, `A control set to ${Math.round(small[0][1])}px: tap targets need at least 44px each way.`);
    }
    if (FIELD_SEL.test(r.sel) && !/checkbox|radio|range|::?placeholder|label/i.test(r.sel) && fs_ != null && fs_ > 0 && fs_ < 16)
      add('small-input', r, `${r.sel} { font-size: ${d['font-size']} }`, `Form field text at ${Math.round(fs_ * 10) / 10}px: phones zoom the page in on fields under 16px.`);
    if (/^100vh$/.test((d.height || '').trim())) add('vh-height', r, `${r.sel} { height: ${d.height} }`, 'height: 100vh runs under the address bar on phones: use 100dvh (with 100vh as a fallback), or min-height.');
    const z = parseInt(d['z-index'] || '', 10);
    if (Number.isFinite(z) && Math.abs(z) >= 1000) add('z-index', r, `${r.sel} { z-index: ${d['z-index']} }`, `z-index ${z}: take it from a short layer scale instead.`);
    for (const v of (CONTROL_SEL.test(r.sel) || /(menu|dropdown|tooltip|modal|dialog|popover|toast|drawer|sheet|tab|nav|link|input|field|card|:hover|:focus|:active)/i.test(r.sel) ? [d.transition, d['transition-duration']] : []).filter(Boolean)) {
      const ms = [...v.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)].map((m) => (m[2] === 's' ? +m[1] * 1000 : +m[1]));
      if (ms.length && ms[0] > 500) { add('slow-transition', r, `${r.sel} { transition: ${v} }`, `A ${ms[0]} ms interface transition: keep small transitions to about 150 to 300 ms.`); break; }
    }
    if (r.sel.trim().toLowerCase() === 'font-face' && !d['font-display']) add('layout-shift', r, `@font-face { font-family: ${d['font-family'] || '?'} }`, '@font-face with no font-display: text stays invisible or jumps while the font loads.');
  }
  // actions revealed only on hover, with no focus route to the same reveal anywhere in the stylesheet
  const focusReveal = rules.some((r) => /:focus-within|:focus-visible|:focus\b/.test(r.sel) && (/^1$/.test((r.decls.opacity || '').trim()) || /visible/.test(r.decls.visibility || '') || (r.decls.display && !/none/.test(r.decls.display))));
  if (!focusReveal) for (const r of rules) {
    const d = r.decls;
    if (/:hover\s*[>+~]?\s*[\w.#[]/.test(r.sel) && (/^1$/.test((d.opacity || '').trim()) || /visible/.test(d.visibility || '') || (d.display && !/none/.test(d.display))) && /(action|button|btn|menu|control|tool|edit|delete|remove|option|more)/i.test(r.sel.split(':hover').pop()))
      { add('hover-only', r, `${r.sel} { ${Object.entries(d).map(([k, v]) => `${k}: ${v}`).join('; ')} }`, 'Controls that only appear on hover: touch and keyboard users never see them. Also reveal them on :focus-within, or show them.'); break; }
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

function htmlDetectors(html, file, year, opts = {}) {
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
  // v2.1 ---------------------------------------------------------------------------------------
  // straight quotes in visible text only: tags (and so attributes), comments, code, pre, kbd, samp,
  // textarea, svg and math are blanked first, keeping offsets
  const blankAll = (s) => s.replace(/[^\n]/g, ' ');
  const vis = src.replace(/<!--[\s\S]*?-->/g, blankAll).replace(/<(code|pre|kbd|samp|textarea|svg|math)\b[\s\S]*?<\/\1>/gi, blankAll).replace(/<[^>]*>/g, blankAll);
  const quotes = [...vis.matchAll(/["']|&(?:quot|apos|#0*3[49]|#x0*2[27]);/gi)];
  if (quotes.length) { const q = quotes[0].index; add('straight-quote', q, vis.slice(Math.max(0, q - 30), q + 30).replace(/\s+/g, ' ').trim(), `${quotes.length} straight quote mark${quotes.length > 1 ? 's' : ''} in visible text: use curly quotes and apostrophes.`); }
  // controls wired to nothing
  for (const m of src.matchAll(/<a\b[^>]*\bhref\s*=\s*["'](#|javascript:[^"']*)["'][^>]*>/gi)) add('dead-link', m.index, m[0], `A link to "${m[1]}" goes nowhere: link it to a real page or make it a button that does something.`);
  for (const m of src.matchAll(/<(?:button|a|div|span)\b[^>]*\bonclick\s*=\s*["']\s*(?:return false;?|void\(0\);?)?\s*["'][^>]*>/gi)) add('dead-link', m.index, m[0], 'A control with an empty click handler.');
  // fields with no label at all (placeholder-only fields are the placeholder-labels rule)
  for (const m of src.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
    const a = m[2];
    if (/type\s*=\s*["']?(hidden|submit|button|image|reset)\b/i.test(a) || /placeholder\s*=/i.test(a)) continue;
    const id = (a.match(/\bid\s*=\s*["']([^"']+)["']/) || [])[1];
    const wrapped = /<label\b(?![\s\S]*<\/label>)/i.test(src.slice(Math.max(0, m.index - 300), m.index));
    const untied = /<label\b(?![^>]*\bfor\s*=)[^>]*>[^<]{1,80}<\/label>\s*(?:<[^>]+>\s*){0,2}$/i.test(src.slice(Math.max(0, m.index - 200), m.index));
    if (!(id && labelled.has(id)) && !wrapped && !/aria-label(ledby)?\s*=|\btitle\s*=/i.test(a)) add('unlabelled-field', m.index, m[0], untied ? `A ${m[1]} next to a label that is not tied to it: add for="${id || '...'}" to the label${id ? '' : ' and an id to the field'}.` : `A ${m[1]} with no label: give it a visible <label for>.`);
  }
  // field types and autofill
  for (const m of src.matchAll(/<input\b([^>]*)>/gi)) {
    const a = m[1], hint = ((a.match(/\b(?:name|id|autocomplete)\s*=\s*["']([^"']+)["']/gi) || []).join(' ')).toLowerCase();
    const type = ((a.match(/\btype\s*=\s*["']?([\w-]+)/i) || [])[1] || 'text').toLowerCase();
    if (/(^|[^a-z])e-?mail/.test(hint) && type === 'text') add('input-type', m.index, m[0], 'An email field typed as text: use type="email" for the right phone keyboard and checks.');
    else if (/(^|[^a-z])(phone|tel|mobile)/.test(hint) && type === 'text') add('input-type', m.index, m[0], 'A phone field typed as text: use type="tel".');
    if (/autocomplete\s*=\s*["']off["']/i.test(a) && /(name|e-?mail|phone|tel|address|postal|zip|city|country)/.test(hint)) add('input-type', m.index, m[0], 'Autocomplete switched off on a field browsers could fill: set a real autocomplete value.');
  }
  // zoom switched off
  for (const m of html.matchAll(/<meta\b[^>]*name\s*=\s*["']?viewport[^>]*>/gi)) if (/user-scalable\s*=\s*(?:no|0)\b|maximum-scale\s*=\s*1(?:\.0*)?(?![\d.])/i.test(m[0])) add('zoom-blocked', m.index, m[0], 'The viewport tag blocks zooming: people who need bigger text cannot get it.');
  // navigation: crowded bottom or tab bars, icon-only items
  for (const m of src.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)) {
    const items = [...m[2].matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)];
    if (/class\s*=\s*["'][^"']*\b(bottom|tab-?bar|tabbar|bottom-nav|mobile-nav|tabs)\b/i.test(m[1]) && items.length > 5) add('nav-overload', m.index, `${items.length} items in ${m[0].slice(0, 60)}`, `${items.length} items in a bottom or tab bar: five is the limit.`);
    const iconOnly = items.filter((x) => x[1].toLowerCase() === 'a' && !textOf(x[3]) && /<(svg|img|i)\b/i.test(x[3]));
    if (iconOnly.length) add('nav-overload', m.index + m[0].indexOf(iconOnly[0][0]), iconOnly[0][0], `${iconOnly.length} navigation item${iconOnly.length > 1 ? 's' : ''} shown as an icon with no words: add a visible label.`, 'low');
  }
  // charts with no text alternative
  for (const m of src.matchAll(/<canvas\b([^>]*)>([\s\S]*?)<\/canvas>/gi)) if (!/aria-label(ledby)?\s*=\s*["'][^"']+/i.test(m[1]) && !textOf(m[2])) add('chart-no-text', m.index, m[0].slice(0, 100), 'A canvas with no label or fallback text: screen readers get nothing.');
  for (const m of html.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi)) if (/(?:class|id)\s*=\s*["'][^"']*\b(chart|graph|plot|sparkline)/i.test(m[1]) && !/aria-label(ledby)?\s*=\s*["'][^"']+/i.test(m[1]) && !/<title\b/i.test(m[2]) && !/aria-hidden\s*=\s*["']true/i.test(m[1])) add('chart-no-text', m.index, m[0].slice(0, 100), 'A chart SVG with no title or label: screen readers get nothing.');
  // images that reserve no space
  const noSize = [...src.matchAll(/<img\b([^>]*)>/gi)].filter((m) => !(/\bwidth\s*=/i.test(m[1]) && /\bheight\s*=/i.test(m[1])) && !/aspect-ratio/i.test(m[1]));
  if (noSize.length && !/aspect-ratio/i.test(html)) add('layout-shift', noSize[0].index, noSize[0][0], `${noSize.length} image${noSize.length > 1 ? 's' : ''} with no width and height: the page jumps as they load.`);
  // bold sprinkled through paragraphs
  for (const m of src.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) if ((m[1].match(/<(strong|b)\b/gi) || []).length >= 3) { add('bold-overuse', m.index, textOf(m[1]).slice(0, 80), 'Three or more bold phrases in one paragraph.'); break; }
  const prose = opts.mask === false ? src : src.replace(/<(code|pre|kbd|samp|blockquote|q)\b[\s\S]*?<\/\1>/gi, blank);
  out.push(...textDetectors(textOf(prose), file, year, prose, opts));
  // v2.3: alt text, titles, labels and meta descriptions get the word-level prose checks too
  const attrs = attributeText(html);
  if (/\S/.test(attrs)) out.push(...textDetectors(attrs, file, year, attrs, { ...opts, fragments: true }).filter((f) => !['exclaim', 'em-dash', 'ambiguous-date'].includes(f.detector)).map((f) => ({ ...f, message: `In alt text, a title, a label or a meta description: ${f.message}` })));
  return out;
}

// Plain text, Markdown and the visible text of HTML.
function textDetectors(text, file, year, original = text, opts = {}) {
  // Curly quotes are the preferred form in visible text, so match patterns on straight ones.
  // One character for one character, so offsets and line numbers stay the same.
  const flat = (s) => s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  const same = original === text;
  text = flat(text); original = flat(original);
  // Quotes, code, blockquotes and links are blanked for the prose patterns (v2.2). `raw` keeps the
  // unmasked text for the literal-sense guards, which need to see citations and links.
  const raw = text;
  // fragments (alt text, SVG and JSX text) sit in blanked source, so indentation is not code there
  if (opts.mask !== false) { text = maskProse(text, { ...(opts.mask || {}), ...(opts.fragments ? { code: false } : {}) }); original = same ? text : maskProse(original, { ...(opts.mask || {}), quotes: false }); }
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
    // Markdown: bold sprinkled through one paragraph (lists, tables and headings excluded)
    const proseOnly = para.split('\n').filter((l) => !/^\s*(#|[-*+]\s|\d+[.)]\s|\||>|```)/.test(l)).join('\n');
    // field labels ("**Status:** draft") are structure, not emphasis
    if ((proseOnly.match(/\*\*(?=\S)[^*\n]+?\*\*/g) || []).filter((b) => !/:\*\*$|:\s*\*\*$/.test(b)).length >= 3 && once('bo')) out.push({ detector: 'bold-overuse', file, line: lineOf(para.slice(0, 40)), evidence: para.trim().slice(0, 80), message: 'Three or more bold phrases in one paragraph.' });
  }
  // v2.1 interface copy and prose tells
  for (const m of text.matchAll(GENERIC_STATUS)) if (once('gs' + m[0].toLowerCase())) add('generic-status', m[0], `"${m[0]}" says nothing about what happened or what to do next.`);
  for (const m of text.matchAll(COMING_SOON)) if (once('cs' + m[0].toLowerCase())) add('coming-soon', m[0], `"${m[0]}": ship the page with its link, or leave the link out.`);
  for (const m of text.matchAll(FALSE_RANGE)) if (once('fr' + m[0].toLowerCase())) add('false-range', m[0], `"${m[0]}": a range with no scale. List what is covered.`);
  for (const m of original.matchAll(CUTOFF)) if (once('co' + m[0].toLowerCase())) add('cutoff-disclaimer', m[0], `"${m[0]}": find and cite the source, or drop the claim.`);
  for (const m of text.matchAll(GENERIC_ENDING)) if (once('ge' + m[0].toLowerCase())) add('generic-ending', m[0], `"${m[0]}" could end any piece: end on the last concrete point.`);
  for (const m of text.matchAll(FANCY)) if (once('fw' + m[0].toLowerCase())) add('fancy-word', m[0], `"${m[0]}": use the plain word.`);
  for (const m of text.matchAll(PROMO)) if (once('pw' + m[0].toLowerCase())) add('promo-word', m[0], `"${m[0]}": describe what is there instead.`);
  for (const m of text.matchAll(DESPITE)) if (once('df' + m[0].toLowerCase())) add('despite-formula', m[0], `"${m[0]}": name the problem and the result.`);
  for (const m of text.matchAll(AMBIG_DATE)) if (+m[1] <= 12 && +m[3] <= 12 && m[1] !== m[3] && once('ad' + m[0])) add('ambiguous-date', m[0], `"${m[0]}" reads two ways: write the month as a word.`);
  // v2.2 rhetoric and rhythm, v2.3 arrangement and claims, and the words a profile bans
  if (!opts.fragments) {
    const body = same ? text : original.replace(/<[^>]+>/g, (t) => blank(t));
    rhetoricDetectors(body, add);
    if (same) arrangementDetectors(body, add);
    claimDetectors(same ? raw : flat(original).replace(/<(script|style)[\s\S]*?<\/\1>/gi, blank).replace(/<a\b[^>]*>/gi, ' [^link] ').replace(/<(?!\/?h[1-6]\b)[^>]+>/g, (t) => blank(t)).replace(/<h[1-6][^>]*>/gi, (t) => `\n## ${blank(t).slice(4)}`), add);
  }
  for (const b of opts.ban || []) {
    const re = new RegExp(`(?<![\\w-])${escapeRe(b.phrase)}(?![\\w-])`, 'gi');
    for (const m of text.matchAll(re)) { add('profile-ban', m[0], b.message || `"${m[0]}" is on this profile's banned list${b.instead ? `: ${b.instead}` : ''}.`, b.severity); break; }
  }
  return guardLiteral(out, text, raw);
}

// ---- code: JavaScript, TypeScript and Python --------------------------------------------------
// Splits source into code, strings and comments. Returns `code`, a copy the same length as the
// source with comments and string contents blanked (the quote marks stay), plus the comments and
// strings found. Template literal and f-string expressions stay as code, so names used inside
// them still count as used.
function scanCode(src, lang) {
  const py = lang === 'py', n = src.length;
  const code = src.split(''), comments = [], strings = [];
  const blank = (arr, a, b) => { for (let k = a; k < b; k++) if (arr[k] !== '\n') arr[k] = ' '; };
  const ownLine = (i) => /^\s*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i));
  // the end of a ${...} or {...} expression, skipping nested quotes
  const exprEnd = (j) => { let depth = 1; while (j < n && depth) { const ch = src[j]; if (ch === '{') depth++; else if (ch === '}') depth--; else if (ch === '"' || ch === "'" || ch === '`') { const q = ch; j++; while (j < n && src[j] !== q) j += src[j] === '\\' ? 2 : 1; } j++; } return j; };
  const KW = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'yield', 'await', 'else', 'do']);
  let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if ((py && c === '#') || (!py && c === '/' && d === '/')) {
      let j = src.indexOf('\n', i); if (j < 0) j = n;
      comments.push({ start: i, end: j, text: src.slice(i + (py ? 1 : 2), j), block: false, own: ownLine(i) });
      blank(code, i, j); i = j; continue;
    }
    if (!py && c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
      comments.push({ start: i, end: j, text: src.slice(i + 2, j - 2), block: true, own: ownLine(i) });
      blank(code, i, j); i = j; continue;
    }
    // In JS a quote straight after a letter is an apostrophe in JSX text ("don't"), not a string.
    if ((c === '"' || c === "'" || (c === '`' && !py)) && !(!py && c === "'" && /[A-Za-z0-9]/.test(src[i - 1] || ''))) {
      const triple = py && src.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      const fstr = py && /[fF][rRbB]?$|[rRbB][fF]$/.test(src.slice(Math.max(0, i - 2), i));
      let j = i + close.length, seg = j;
      const parts = [];
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src.startsWith(close, j)) break;
        if (!triple && c !== '`' && src[j] === '\n') break; // unterminated: stop at the line end
        if ((c === '`' && src[j] === '$' && src[j + 1] === '{') || (fstr && src[j] === '{' && src[j + 1] !== '{')) {
          parts.push([seg, j]); j = exprEnd(j + (c === '`' ? 2 : 1)); seg = j; continue;
        }
        if (fstr && src[j] === '{') { j += 2; continue; }
        j++;
      }
      parts.push([seg, Math.min(j, n)]);
      for (const [a, b] of parts) blank(code, a, b);
      const end = Math.min(n, j + (src.startsWith(close, j) ? close.length : 0));
      strings.push({ start: i, end, quote: c, triple, value: src.slice(i + close.length, Math.min(j, n)) });
      i = end; continue;
    }
    if (!py && c === '/') {
      // a regex literal when the previous token cannot end an expression
      let p = i - 1; while (p >= 0 && /\s/.test(code[p])) p--;
      const prev = p < 0 ? '' : code[p];
      // after "<" it is a JSX closing tag, not a regex
      let isRe = !prev || /[(,=:[!&|?{};+\-*%>~^]/.test(prev);
      if (!isRe && /[\w$]/.test(prev)) { let q = p; while (q >= 0 && /[\w$]/.test(code[q])) q--; isRe = KW.has(code.slice(q + 1, p + 1).join('')); }
      if (isRe) {
        let j = i + 1, cls = false;
        while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
        blank(code, i + 1, j); i = j + 1; continue;
      }
    }
    i++;
  }
  return { code: code.join(''), comments, strings };
}
const codeLang = (file) => (/\.py$/i.test(file) ? 'py' : /\.(ts|tsx|mts|cts)$/i.test(file) ? 'ts' : 'js');
const splitIdent = (id) => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_$]+/).filter((x) => x.length >= 3);
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'new', 'all', 'each', 'its', 'our', 'out', 'then', 'now', 'here', 'list', 'value', 'values']);
const NARRATE = /^(?:initiali[sz]es?|increments?|decrements?|creates?|returns?|sets?|gets?|calls?|imports?|defines?|declares?|assigns?|loops?|iterates?|checks? if|adds?|saves?|updates?|prints?|logs?|instantiates?|exports?|appends?|push(?:es)?|closes?|opens?|reads?|writes?|converts?|parses?|fetch(?:es)?|loads?|stores?|calculates?|computes?|increase[sd]?|decrease[sd]?|send[s]?|removes?|deletes?|filters?|sorts?|renders?|validates?|waits?|builds?|formats?|finds?|clears?|resets?|shows?|hides?|copies|copy|moves?|merges?)\b/i;
const WHY = /\b(because|so that|so the|why|note|workaround|hack|see|https?|todo|fixme|eslint|prettier|ts-|type:|noqa|pragma|istanbul|otherwise|unless|until|in case|avoid|must|never|always|only|keep|instead|without|else|first|before|after|once|cache|retry|limit)\b/i;
const JS_CODE_LINE = /^(?:(?:const|let|var)\s+[\w$[{]+\s*=|return\b[^;]*;\s*$|(?:await\s+)?[\w$.[\]]+\(.*\)\s*;\s*$|import\s.+\sfrom\s|import\s+['"]|export\s+(?:default|const|function|class|\{)|function\s*\*?\s*[\w$]*\s*\(.*\)\s*\{|if\s*\(.*\)\s*\{\s*$|(?:for|while|switch)\s*\(.*\)\s*\{?\s*$|\}\s*(?:else\b.*)?\{?\s*$|[\w$.[\]]+\s*(?:[+\-*/]?=|\+\+|--)\s*.*;\s*$|\}\);?\s*$)/;
const PY_CODE_LINE = /^(?:def\s+\w+\s*\(.*\)\s*(?:->.*)?:\s*$|class\s+\w+(?:\(.*\))?\s*:\s*$|return(?:\s+[\w.[\]()'",]+)?\s*$|import\s+[\w.]+(?:\s+as\s+\w+)?\s*$|from\s+[\w.]+\s+import\s+[\w*, ()]+$|(?:if|elif|while)\s+[\w.()[\]=!<> '"]+:\s*$|for\s+\w+(?:\s*,\s*\w+)*\s+in\s+.+:\s*$|else\s*:\s*$|print\(.*\)\s*$|[\w.[\]]+\s*[+\-*/]?=\s*[\w"'([{-].*$|[\w.]+\(.*\)\s*$)/;
// A comment line that reads as code: it fits a code shape and has no two plain words in a row
// (keywords such as "if", "in", "not" or "new" excepted), so "# quiet = no sound at night" stays prose.
const CODE_WORDS = new Set(['if', 'else', 'elif', 'for', 'while', 'in', 'of', 'is', 'not', 'and', 'or', 'as', 'from', 'import', 'return', 'yield', 'await', 'async', 'new', 'typeof', 'instanceof', 'void', 'delete', 'lambda', 'def', 'class', 'const', 'let', 'var', 'function', 'export', 'default', 'None', 'True', 'False', 'null', 'undefined', 'raise', 'throw', 'with', 'case', 'extends']);
const looksLikeCode = (t, py) => (py ? PY_CODE_LINE : JS_CODE_LINE).test(t) && ![...t.matchAll(/\b([A-Za-z_]\w*) (?=([A-Za-z_]\w*)\b)/g)].some((m) => !CODE_WORDS.has(m[1]) && !CODE_WORDS.has(m[2]));
const GENERIC_JS_NAMES = /^(data|result|results|temp|tmp|obj|stuff|thing|things|foo|baz|myVar|val|info|ret)$/;
const GENERIC_PY_NAMES = /^(data|result|results|temp|tmp|obj|stuff|thing|things|foo|baz|my_var|val|info|ret)$/;
const GENERIC_FN = /^(?:(?:handle|do|process|manage)[_]?(?:stuff|data|things?|it|everything|something|info)|my_?function|helper(?:_?function)?|do_?it|func\d*|fn\d+)$/i;
const VAGUE_ERROR = /^\s*(?:error|failed|failure|oops|unknown error|something went wrong|an? (?:unexpected |unknown )?error (?:has )?occurred|invalid(?: input)?|bad request|not found)[.!]?\s*$/i;
const RESIDUE_CODE = /(\.\.\.\s*(?:the )?(?:rest of|existing|remaining|other) (?:the )?(?:code|implementation|logic|methods?|properties|fields|file)|(?:your|add your|insert|put your) (?:code|logic|implementation) here|\bimplement (?:me|this)\b|placeholder (?:implementation|logic|code)|same as (?:before|above)\b)/i;

function codeDetectors(src, file) {
  const lang = codeLang(file), py = lang === 'py', jsx = /\.(jsx|tsx)$/i.test(file);
  const { code, comments, strings } = scanCode(src, lang);
  const lines = src.split('\n'), cl = code.split('\n');
  const starts = []; { let p = 0; for (const l of lines) { starts.push(p); p += l.length + 1; } }
  // 0-based line of an offset, by binary search over the line starts
  const lineNo = (i) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; } return lo; };
  const out = [], seen = {};
  const add = (detector, i, evidence, message, severity, rule) => {
    seen[detector] = (seen[detector] || 0) + 1;
    if (seen[detector] <= 10) out.push({ detector, rule, file, line: lineNo(i) + 1, evidence: String(evidence).replace(/\s+/g, ' ').trim().slice(0, 160), message, severity });
  };
  const indent = (l) => (l.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;
  const nextCode = (li) => { let j = li + 1; while (j < cl.length && !cl[j].trim()) j++; return j; };

  // comments: narrating, commented-out code, TODO and placeholder residue
  let run = null;
  const flush = () => { if (run && run.strong) add('commented-code', run.i, run.firstStrong, run.n > 1 ? `${run.n} lines of commented-out code: delete them, version control keeps them.` : 'Commented-out code: delete it, version control keeps it.'); run = null; };
  for (const c of comments) {
    const t = c.text.replace(/^[\s*]+/, '').trimEnd();
    if (!c.block && c.own && looksLikeCode(t.trim(), py) && !/^[!/@#]|^\s*(?:eslint|prettier|type:|noqa|pragma|-\*-)/.test(c.text)) {
      const li = lineNo(c.start);
      const strong = !/^[{}()[\];,\s]+$/.test(t);
      if (run && run.last === li - 1) { run.n++; run.last = li; run.strong ||= strong; if (!run.firstStrong && strong) run.firstStrong = t; } else { flush(); run = { i: c.start, first: t, n: 1, last: li, strong, firstStrong: strong ? t : null }; }
    } else flush();
    if (!c.block && c.own && !looksLikeCode(t.trim(), py)) {
      const words = t.trim().split(/\s+/).filter(Boolean);
      const li = lineNo(c.start), next = cl[li + 1] || '';
      if (words.length && words.length <= 6 && NARRATE.test(t.trim()) && !WHY.test(t) && next.trim()) {
        const ids = (next.match(/[A-Za-z_$][\w$]*/g) || []).flatMap(splitIdent);
        const said = words.map((w) => w.toLowerCase().replace(/[^a-z]/g, '')).filter((w) => w.length >= 3 && !STOP.has(w));
        if (said.some((w) => ids.some((id) => id.slice(0, 4) === w.slice(0, 4)))) add('narrating-comment', c.start, `${t.trim()}  /  ${(lines[li + 1] || '').trim()}`, 'A comment that says what the next line plainly does: delete it, or say why instead.');
      }
    }
    for (const line of c.text.split('\n')) {
      if (RESIDUE_CODE.test(line)) add('todo-residue', c.start, line, 'Placeholder left where code should be.', 'high');
      else if (/^\s*(?:TODO|FIXME|XXX|HACK)\b|\b(?:TODO|FIXME|XXX|HACK)\s*[:(]/.test(line) && !/#\d+|\b[A-Z][A-Z0-9]+-\d+\b|https?:\/\/|@\w+|\b(?:TODO|FIXME)\s*\(\w+\)/.test(line)) add('todo-residue', c.start, line, 'A TODO with no owner or ticket: finish it, or link the ticket.', 'low');
    }
  }
  flush();
  // stubs that throw "not implemented", and errors with messages that name no cause
  for (const s of strings) {
    const before = code.slice(Math.max(0, s.start - 60), s.start);
    if (!/(?:new\s+\w*Error\s*\(|raise\s+\w+\s*\(|reject\s*\(\s*new\s+\w*Error\s*\()\s*[fFrR]?$/.test(before)) continue;
    if (/^\s*not (?:yet )?implemented\.?\s*$/i.test(s.value)) add('todo-residue', s.start, lines[lineNo(s.start)], 'A "not implemented" stub on a code path.', 'medium');
    else if (VAGUE_ERROR.test(s.value)) add('generic-error', s.start, lines[lineNo(s.start)], `"${s.value.trim()}" names no cause: give a stable code and say what failed and what to do.`);
  }
  // debug output
  if (py) {
    for (const m of code.matchAll(/\bbreakpoint\s*\(\s*\)|\bi?pdb\.set_trace\s*\(|^[ \t]*import\s+i?pdb\b/gm)) add('debug-output', m.index, m[0], 'Debugger call left in.', 'high');
    for (const m of code.matchAll(/\bp?print\s*\(/g)) {
      const l = lines[lineNo(m.index)];
      if (/\bp?print\(\s*[fF]?["'](?:debug|here|test|xxx|>>>|-{3,}|\*{3,}|got here|checkpoint|dbg)|\bprint\(\s*(?:type|dir|vars)\(|\bprint\(\s*f["'][^"']*=\}|\bpprint\(/i.test(l)) add('debug-output', m.index, l, 'Debug print left in.');
    }
  } else {
    for (const m of code.matchAll(/\bdebugger\b/g)) add('debug-output', m.index, lines[lineNo(m.index)], 'debugger statement left in.', 'high');
    const testFile = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^|[\/])(?:tests?|__tests__)[\/]/.test(file);
    const cliFile = /^#!/.test(src) || /\bprocess\.(?:argv|exit)\b/.test(code) || /(?:^|[\/])(?:scripts|bin|cli)[\/]/.test(file);
    if (!cliFile) for (const m of code.matchAll(/\bconsole\.(log|debug|trace|dir|table|time|timeEnd|count)\s*\(/g)) add('debug-output', m.index, lines[lineNo(m.index)], `console.${m[1]} left in: remove it or use the project's logger.`, testFile ? 'low' : undefined);
  }
  // dead code: unreachable lines and constant-false branches
  for (let li = 0; li < cl.length; li++) {
    const l = cl[li];
    const term = py ? /^\s*(?:return\b|raise\b|break\s*$|continue\s*$)/.test(l) && !/[([{,\\]\s*$/.test(l) && (l.match(/[([{]/g) || []).length === (l.match(/[)\]}]/g) || []).length
      : /^\s*(?:return\b[^;{]*;|throw\b[^;]*;|break;|continue;)\s*$/.test(l);
    if (!term) continue;
    const j = nextCode(li);
    if (j >= cl.length) continue;
    const nl = cl[j];
    if (indent(nl) === indent(l) && !(py ? /^\s*(?:else|elif|except|finally|case|def|class|async\s+def|@)\b/ : /^\s*(?:\}|\)|\]|case\b|default\b|function\b)/).test(nl))
      add('commented-code', starts[j], lines[j], `Unreachable: this line comes after a ${l.trim().split(/[\s;(]/)[0]} at the same level.`, undefined, 'code-dead-code');
  }
  for (const m of code.matchAll(py ? /^[ \t]*(?:if|while)\s+(?:False|0)\s*:/gm : /\b(?:if|while)\s*\(\s*(?:false|0)\s*\)/g)) add('commented-code', m.index, m[0], 'A branch that can never run.', undefined, 'code-dead-code');
  // errors swallowed
  if (py) {
    for (const m of code.matchAll(/^([ \t]*)except\s*:/gm)) add('swallowed-error', m.index, m[0], 'A bare except catches everything, even Ctrl+C: name the error you expect.');
    for (const m of code.matchAll(/^([ \t]*)except\b([^:\n]*):[ \t]*(?:\n(?:[ \t]*\n)*[ \t]*)?pass[ \t]*$/gm)) if (!/#/.test(src.slice(m.index, m.index + m[0].length))) {
      const broad = !m[2].trim() || /\b(?:Base)?Exception\b/.test(m[2]);
      add('swallowed-error', m.index, m[0], broad ? 'except Exception: pass hides every failure: catch the error you expect, or let it raise.' : 'An expected error ignored with no word of why: add a short comment.', broad ? 'high' : 'low');
    }
  } else {
    for (const m of code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) if (!/\/\/|\/\*/.test(src.slice(m.index, m.index + m[0].length))) add('swallowed-error', m.index, m[0], 'An empty catch block hides the failure: handle it, or say in a comment why it is safe to ignore.');
    for (const m of code.matchAll(/\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|null|undefined)\s*\)/g)) if (!/\/\/|\/\*/.test(src.slice(m.index, m.index + m[0].length))) add('swallowed-error', m.index, m[0], 'A promise catch that throws the error away.', /\{\s*\}/.test(m[0]) ? undefined : 'medium');
    for (const m of code.matchAll(/\bcatch\s*\(\s*([\w$]+)\s*\)\s*\{\s*console\.(?:log|error|warn)\([^;{}]*\);?\s*\}/g)) add('swallowed-error', m.index, m[0], 'A catch that only logs, then carries on as if nothing failed.', 'medium');
  }
  // pass-through wrappers
  const norm = (s) => s.replace(/\s+/g, '');
  if (py) {
    for (const m of code.matchAll(/^([ \t]*)def\s+(\w+)\s*\(([^)]*)\)\s*(?:->[^:]+)?:[ \t]*\n[ \t]+return\s+([\w.]+)\s*\(([^)]*)\)[ \t]*$/gm))
      if (m[2] !== m[4] && norm(m[3]) && norm(m[3]) === norm(m[5]) && !/[=*:]/.test(m[3])) { const j = nextCode(lineNo(m.index + m[0].length)); if (j >= cl.length || indent(cl[j]) <= indent(m[1])) add('pass-through-wrapper', m.index, m[0], `${m[2]}() only passes its arguments to ${m[4]}(): call ${m[4]}() directly.`); }
  } else {
    for (const m of code.matchAll(/\bfunction\s+([\w$]+)\s*\(([^)]*)\)\s*\{\s*return\s+(?:await\s+)?([\w$.]+)\s*\(([^)]*)\)\s*;?\s*\}/g))
      if (m[1] !== m[3] && norm(m[2]) && norm(m[2]) === norm(m[4]) && !/[={}:]/.test(m[2])) add('pass-through-wrapper', m.index, m[0], `${m[1]}() only passes its arguments to ${m[3]}(): call ${m[3]}() directly.`);
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*(?:\{\s*return\s+)?(?:await\s+)?([\w$.]+)\s*\(([^)]*)\)\s*;?\s*\}?\s*;?\s*$/gm))
      if (m[1] !== m[3] && norm(m[2]) && norm(m[2]) === norm(m[4]) && !/[={}:]/.test(m[2])) add('pass-through-wrapper', m.index, m[0], `${m[1]}() only passes its arguments to ${m[3]}(): call ${m[3]}() directly.`);
  }
  // generic names
  const named = new Set();
  const decl = py ? /^[ \t]*([A-Za-z_]\w*)\s*=(?!=)|\bdef\s+(\w+)\s*\(/gm : /\b(?:const|let|var)\s+([\w$]+)\s*=|\bfunction\s+([\w$]+)\s*\(/g;
  for (const m of code.matchAll(decl)) {
    const name = m[1] || m[2];
    if (named.has(name)) continue;
    if ((m[1] && (py ? GENERIC_PY_NAMES : GENERIC_JS_NAMES).test(name)) || GENERIC_FN.test(name)) { named.add(name); add('generic-name', m.index, m[0], `"${name}" says nothing about what it holds or does.`); }
  }
  // casts that change nothing, and loose types
  const castRes = py ? [/\b(str|int|float|list|tuple|bool)\s*\(\s*\1\s*\(/g, /\bstr\s*\(\s*[fFrR]?["']/g, /\bint\s*\(\s*len\s*\([^()]*\)\s*\)/g, /\blist\s*\(\s*sorted\s*\(/g, /\bbool\s*\(\s*(?:True|False)\s*\)/g]
    : [/\bas\s+unknown\s+as\b/g, /\bas\s+any\b/g, /(?<![\w$])<any>\s*[\w$(]/g, /\bBoolean\s*\(\s*!!/g, /!!\s*Boolean\s*\(/g, /\bString\s*\(\s*(["'`])\s*\1\s*\)/g, /\bString\s*\(\s*String\s*\(/g, /\bNumber\s*\(\s*(?:Number|parseInt|parseFloat)\s*\(/g, /\.toString\(\)\s*\.toString\(\)/g];
  for (const re of castRes) for (const m of code.matchAll(re)) add('redundant-cast', m.index, lines[lineNo(m.index)], /any|unknown/.test(m[0]) ? `"${m[0].trim()}" switches the type checker off: fix the type where it starts.` : `"${m[0].trim()}" converts a value to the type it already has.`, /any|unknown/.test(m[0]) ? 'medium' : 'low');
  if (lang === 'ts') for (const m of code.matchAll(/:\s*any\b(?!\s*[\w$])|\bany\[\]|\b(?:Array|Promise|Record<\s*string\s*,)\s*<?\s*any\s*>/g)) add('any-type', m.index, lines[lineNo(m.index)], 'any as a type: write the real type, or use unknown and narrow it.');
  if (py && /\bfrom\s+typing\s+import\b[^\n]*\bAny\b/.test(code)) for (const m of code.matchAll(/(?::|->)\s*Any\b/g)) add('any-type', m.index, lines[lineNo(m.index)], 'Any as a type: write the real type.');
  // unused imports
  const uses = (name, from) => { const re = new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'); return [...code.matchAll(re)].some((x) => x.index < from[0] || x.index >= from[1]); };
  if (py) {
    if (!/(^|\/)__init__\.py$/.test(file)) for (const m of code.matchAll(/^[ \t]*(?:from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n]+)|import\s+([^\n]+))/gm)) {
      if (m[1] === '__future__') continue;
      const list = (m[2] || m[3]).replace(/[()]/g, '').split(',').map((x) => x.trim()).filter((x) => x && x !== '*');
      if (/noqa/.test(lines[lineNo(m.index)])) continue;
      for (const item of list) { const [base, alias] = item.split(/\s+as\s+/); const name = alias || (m[3] ? base.split('.')[0] : base); if (name && /^\w+$/.test(name) && !uses(name, [m.index, m.index + m[0].length]) && !new RegExp(`["']${name}["']`).test(src)) add('unused-import', m.index, lines[lineNo(m.index)], `"${name}" is imported and never used.`); }
    }
  } else {
    for (const m of code.matchAll(/^[ \t]*import\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\*\s+as\s+([\w$]+)|\{([^}]*)\})?\s*from\s*["']/gm)) {
      const names = [m[1], m[2], ...(m[3] || '').split(',').map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop())].filter((x) => x && /^[\w$]+$/.test(x));
      if (/eslint-disable|@ts-ignore/.test(lines[lineNo(m.index)] + (lines[lineNo(m.index) - 1] || ''))) continue;
      for (const name of names) if (!uses(name, [m.index, m.index + m[0].length])) add('unused-import', m.index, lines[lineNo(m.index)], `"${name}" is imported and never used.`);
    }
  }
  // nesting five or more levels deep
  const steps = cl.filter((l) => l.trim()).map(indent).filter((x) => x > 0);
  const unit = Math.max(2, Math.min(...(steps.length ? steps : [4])));
  for (let li = 0; li < cl.length; li++) if (/^\s*(?:if|for|while|switch|try|with|elif|else\s+if)\b/.test(cl[li]) && (py ? /:\s*$/ : /\{\s*$/).test(cl[li]) && indent(cl[li]) / unit >= (py ? 5 : 6)) { add('deep-nesting', starts[li], cl[li], `Control flow ${Math.round(indent(cl[li]) / unit)} levels deep: return early or pull the block into a named function.`); break; }
  // docstrings longer than the function they describe, that mostly repeat its name
  const restates = (doc, name) => {
    const stems = splitIdent(name).map((w) => w.slice(0, 4));
    const rows = doc.split('\n').map((x) => x.replace(/^[\s*]+/, '').trim()).filter((x) => x && !/^(?:@|:param|:return|args:|returns?:|raises:)/i.test(x));
    return rows.length >= 3 && !WHY.test(doc) && rows.filter((x) => (x.toLowerCase().match(/[a-z]{3,}/g) || []).some((w) => stems.includes(w.slice(0, 4)))).length / rows.length >= 0.6;
  };
  if (py) {
    for (const m of src.matchAll(/^([ \t]*)def\s+(\w+)\s*\([^)]*\)[^:\n]*:[ \t]*\n[ \t]+[rRuU]?("""|''')([\s\S]*?)\3[ \t]*\n/gm)) {
      const docLines = m[4].split('\n').filter((x) => x.trim()).length;
      let j = lineNo(m.index + m[0].length), body = 0;
      while (j < lines.length && (!cl[j].trim() || indent(cl[j]) > indent(m[1]))) { if (cl[j].trim()) body++; j++; }
      if (docLines >= 4 && body <= 2 && restates(m[4], m[2])) add('docstring-bloat', m.index, m[0].split('\n')[0], `A ${docLines}-line docstring on a ${body}-line function, mostly repeating its name.`);
    }
  } else {
    for (const c of comments) {
      if (!c.block || !/^\*/.test(c.text)) continue;
      const docLines = c.text.split('\n').filter((x) => x.replace(/^[\s*]+/, '').trim()).length;
      const fn = code.slice(c.end, c.end + 400).match(/^\s*(?:export\s+)?(?:async\s+)?(?:function\s*([\w$]*)\s*\([^)]*\)|(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s*\{([^{}]*)\}/);
      if (fn && docLines >= 4 && fn[3].split(/[;\n]/).filter((x) => x.trim()).length <= 1 && restates(c.text, fn[1] || fn[2] || '')) add('docstring-bloat', c.start, c.text.split('\n').map((x) => x.replace(/^[\s*]+/, '').trim()).find(Boolean), `A ${docLines}-line doc comment on a one-line function, mostly repeating its name.`);
    }
  }
  // style drift against the rest of the file
  const tabLines = lines.filter((l) => /^\t/.test(l)).length, spaceLines = cl.filter((l) => /^ {2,}\S/.test(l)).length;
  if (tabLines >= 3 && spaceLines >= 3 && Math.min(tabLines, spaceLines) / (tabLines + spaceLines) >= 0.1) add('style-drift', starts[lines.findIndex((l) => (tabLines < spaceLines ? /^\t/ : /^ {2,}\S/).test(l))] || 0, `${tabLines} lines indented with tabs, ${spaceLines} with spaces`, 'Tabs and spaces mixed for indentation: match the file.');
  if (!jsx) {
    const q = strings.filter((s) => !s.triple && s.quote !== '`' && !/["']/.test(s.value));
    const sq = q.filter((s) => s.quote === "'"), dq = q.filter((s) => s.quote === '"');
    const minority = sq.length < dq.length ? sq : dq;
    if (sq.length >= 5 && dq.length >= 5 && minority.length / q.length >= 0.2) add('style-drift', minority[0].start, `${sq.length} single-quoted and ${dq.length} double-quoted strings`, 'Single and double quotes mixed for strings: match the file.');
  }
  if (!py) {
    const vars = [...code.matchAll(/\bvar\s+[\w$]/g)], lets = (code.match(/\b(?:let|const)\s+[\w$[{]/g) || []).length;
    if (vars.length && lets >= 3) add('style-drift', vars[0].index, lines[lineNo(vars[0].index)], 'var mixed with let and const: match the file.');
  }
  const ids = [...code.matchAll(py ? /\bdef\s+([A-Za-z_]\w*)|^[ \t]*([A-Za-z_]\w*)\s*=(?!=)/gm : /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => [m[1] || m[2], m.index]).filter(([x]) => /[a-z]/.test(x) && !/^[A-Z0-9_]+$/.test(x));
  const snake = ids.filter(([x]) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(x)), camel = ids.filter(([x]) => /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(x));
  const fewer = snake.length < camel.length ? snake : camel;
  if (snake.length >= 2 && camel.length >= 2 && fewer.length / (snake.length + camel.length) >= 0.2) add('style-drift', fewer[0][1], `${camel.length} camelCase and ${snake.length} snake_case names`, 'camelCase and snake_case names mixed: match the file.');
  return out;
}

// ---- driver ---------------------------------------------------------------------------------
const EXT = { '.html': 'html', '.htm': 'html', '.css': 'css', '.md': 'text', '.mdx': 'text', '.txt': 'text',
  '.js': 'code', '.mjs': 'code', '.cjs': 'code', '.jsx': 'code', '.ts': 'code', '.tsx': 'code', '.mts': 'code', '.cts': 'code', '.py': 'code', '.svg': 'svg' };
const DEFAULT_CONTEXT = { html: ['web', 'app'], css: ['web', 'app'], text: ['doc', 'copy'], code: ['code'], svg: ['web', 'deck', 'doc'] };
const SCRATCH = /^(notes|plan|thoughts|ideas|scratch|temp|tmp|todo|summary|implementation[-_ ]?summary|changes[-_ ]?summary|progress)\.mdx?$/i;
function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) if (!['node_modules', '.git', 'dist', 'vendor', '.cache', 'fonts', '__pycache__', '.venv', 'venv', 'coverage', 'build', '.next'].includes(e)) walk(path.join(p, e), out); }
  // Licence and notice files are legal text, not design or copy.
  else if (EXT[path.extname(p).toLowerCase()] && !/^(licen[cs]e|ofl|notice|copying|third[-_]?party)/i.test(path.basename(p)) && !/\.min\.|\.d\.ts$/.test(p)) out.push(p);
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
    return [{ rule: r.id, detector: f.detector, severity: f.severity || r.severity, kind: r.kind, file: f.file, line: f.line, evidence: f.evidence, message: f.message, instead: r.instead }];
  });
}
// One file. With project: true (the default) the file's own CSS also gets the
// project-level typography checks; checkPaths runs those once across every file instead.
export function checkText(content, kind, file = '<input>', { context, year = new Date().getFullYear(), project = true, profile, genre, voice } = {}) {
  // Markdown and text in a UI context are working notes, not interface copy: UI rules check HTML and CSS only.
  if (kind === 'text' && (context === 'app' || context === 'web')) return [];
  if (kind !== 'code' && IGNORE_FILE.test(content.slice(0, 2000))) return [];
  // Source code is checked only in the code context. In the code context, pages and stylesheets are
  // skipped, and Markdown is checked only for working notes left in the change.
  if (kind === 'code' && context && context !== 'code') return [];
  if (kind === 'svg' && context === 'code') return [];
  if (context === 'code' && kind !== 'code') return kind === 'text' && SCRATCH.test(path.basename(file)) ? resolve([{ detector: 'scratch-file', file, line: 1, evidence: path.basename(file), message: `${path.basename(file)} looks like working notes: keep it out of the change, or fold what matters into the docs.` }], ['code']) : [];
  const dopts = { mask: profile?.mask, ban: profile?.ban };
  if (kind === 'svg') { const t = svgText(content); return applyPolicy(resolve(textDetectors(t, file, year, t, { ...dopts, fragments: true }).filter((f) => f.detector !== 'exclaim'), context ? [context] : DEFAULT_CONTEXT.svg), { profile, genre }); }
  // v2.3: words people read inside JSX get the prose checks, reported under the web rules
  const ui = kind === 'code' && /\.(jsx|tsx)$/i.test(file) ? (() => { const t = jsxText(content); return /\S/.test(t) ? resolve(textDetectors(t, file, year, t, { ...dopts, fragments: true }).filter((f) => !['exclaim', 'em-dash', 'ambiguous-date', 'straight-quote'].includes(f.detector)).map((f) => ({ ...f, message: `In interface text: ${f.message}` })), ['web', 'app']) : []; })() : [];
  const raw = kind === 'code' ? codeDetectors(content, file)
    : kind === 'html' ? [...htmlDetectors(content, file, year, dopts), ...cssDetectors(htmlToCss(content), file)]
    : kind === 'css' ? cssDetectors(content, file) : textDetectors(content, file, year, content, dopts);
  if (project && (kind === 'html' || kind === 'css')) raw.push(...projectChecks([{ css: kind === 'html' ? htmlToCss(content) : content, file }]));
  if (kind === 'text' || kind === 'html') raw.push(...profileDetectors(content, kind, file, context, profile, voice || profile?.voice));
  return applyPolicy([...resolve(raw, context ? [context] : DEFAULT_CONTEXT[kind]), ...ui], { profile, genre });
}
export function checkPaths(paths, opts = {}) {
  const files = paths.flatMap((p) => walk(p));
  const findings = [], scores = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8'), kind = EXT[path.extname(f).toLowerCase()];
    const found = checkText(content, kind, f, { ...opts, project: false });
    findings.push(...found);
    const words = proseWordCount(content, kind);
    if (words) scores.push({ file: f, words, score: trendScore(found, words, opts.profile?.minScoreWords) });
  }
  // project-level style checks have no rules in the code context, so skip their work there
  const styled = opts.context === 'code' ? [] : files.filter((f) => ['html', 'css'].includes(EXT[path.extname(f).toLowerCase()])).map((f) => ({ file: f, css: EXT[path.extname(f).toLowerCase()] === 'html' ? htmlToCss(fs.readFileSync(f, 'utf8')) : fs.readFileSync(f, 'utf8') }));
  if (styled.length) findings.push(...resolve(projectChecks(styled), opts.context ? [opts.context] : ['web', 'app']));
  if (opts.pairing) findings.push(...applyPolicy(resolve(checkPairing(fs.existsSync(opts.pairing) ? fs.readFileSync(opts.pairing, 'utf8') : '', opts.pairing), opts.context ? [opts.context] : ['web', 'app', 'deck', 'doc']), opts));
  findings.push(...applyPolicy(resolve(repeatedAcrossFiles(files), opts.context ? [opts.context] : ['web', 'doc', 'copy', 'deck']), opts));
  const scored = scores.filter((x) => x.score != null);
  const words = scored.reduce((a, x) => a + x.words, 0);
  const overall = words ? Math.round(scored.reduce((a, x) => a + x.score * x.words, 0) / words) : null;
  return { files: files.length, findings, scores, score: overall };
}

// v2.3: the same sentence on three or more pages or documents. Navigation, headers, footers
// and asides repeat by design, so they are left out.
function repeatedAcrossFiles(files) {
  if (files.length < 3) return [];
  const seen = new Map();
  for (const f of files) {
    const kind = EXT[path.extname(f).toLowerCase()];
    if (kind !== 'text' && kind !== 'html') continue;
    const c = fs.readFileSync(f, 'utf8');
    if (IGNORE_FILE.test(c.slice(0, 2000))) continue;
    const prose = kind === 'text' ? proseParagraphs(maskProse(c)) : [stripHtml(c).replace(/<(head|nav|header|footer|aside|code|pre|script|style)\b[\s\S]*?<\/\1>/gi, blank).replace(/<\/(p|li|h[1-6]|div|td|th|dd|dt|figcaption|blockquote|section|article)>/gi, (t) => `${t}\u0000`)].flatMap((t) => t.split('\u0000').map(textOf));
    for (const sent of new Set(prose.flatMap(sentencesOf))) {
      if (wordCount(sent) < 8) continue;
      const k = sent.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      if (!seen.has(k)) seen.set(k, { sent, files: new Set() });
      seen.get(k).files.add(f);
    }
  }
  return [...seen.values()].filter((x) => x.files.size >= 3).slice(0, 10).map((x) => {
    const [first, ...rest] = [...x.files];
    const c = fs.readFileSync(first, 'utf8'), i = c.indexOf(x.sent.slice(0, 30));
    return { detector: 'cross-file-repeat', file: first, line: i >= 0 ? lineAt(c, i) : 1, evidence: x.sent.slice(0, 160), message: `The same sentence appears in ${x.files.size} files (also ${rest.slice(0, 3).map((r) => path.basename(r)).join(', ')}${rest.length > 3 ? ' and more' : ''}): write it for each page, or keep it in one place.`, severity: x.files.size >= 5 ? 'medium' : 'low' };
  });
}

// ---- v2.4: voice, reading grade, spelling, diff with fact check ------------------------------
// A voice file holds numbers only: rates of punctuation, pronouns and common function words, and
// sentence and paragraph lengths, each as a mean and spread across the samples. No sentence or
// content word from the samples is stored, so a voice file can be shared without the writing.
const FUNCTION_WORDS = 'the of and to a in that is it for on with as was but be at by this have from or not are an they which you one were all we there their been has would will can if more when so no what out up about who into them than its some could only other then also these just because how most even any very much such through those both each might while where should own though however may yet still often perhaps rather quite really'.split(' ');
const syllables = (w) => { w = w.toLowerCase().replace(/[^a-z]/g, ''); if (w.length <= 3) return 1; w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, ''); return Math.max(1, (w.match(/[aeiouy]{1,2}/g) || []).length); };
// Flesch-Kincaid grade of the prose in a text (null when there is too little to judge).
export function readingGrade(text) {
  const sents = proseParagraphs(maskProse(text)).flatMap(sentencesOf).filter((x) => wordCount(x) >= 3);
  const words = sents.flatMap((x) => x.match(/[A-Za-z][A-Za-z'’-]*/g) || []);
  if (words.length < 60 || sents.length < 3) return null;
  const syl = words.reduce((a, w) => a + syllables(w), 0);
  return +(0.39 * (words.length / sents.length) + 11.8 * (syl / words.length) - 15.59).toFixed(1);
}
// Measurements of one text, used both to build a voice and to compare a draft with it.
export function voiceFeatures(text) {
  const masked = maskProse(text);
  const paras = proseParagraphs(masked);
  const body = paras.join('\n\n');
  const words = body.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  const n = words.length || 1, per1k = (re) => ((body.match(re) || []).length * 1000) / n;
  const sents = paras.flatMap(sentencesOf).map(wordCount).filter((x) => x >= 1);
  const st = stats(sents), pl = stats(paras.map(wordCount));
  const lower = words.map((w) => w.toLowerCase().replace(/[’']/g, "'"));
  const fw = {};
  for (const w of FUNCTION_WORDS) fw[w] = 0;
  for (const w of lower) if (w in fw) fw[w]++;
  for (const w of FUNCTION_WORDS) fw[w] = (fw[w] * 1000) / n;
  return {
    words: words.length,
    features: {
      'sentence length': st.mean, 'sentence spread': st.cv, 'short sentences': sents.filter((x) => x <= 6).length / (sents.length || 1), 'long sentences': sents.filter((x) => x >= 30).length / (sents.length || 1),
      'paragraph length': pl.mean, 'word length': words.reduce((a, w) => a + w.length, 0) / n,
      commas: per1k(/,/g), semicolons: per1k(/;/g), colons: per1k(/:(?!\/\/)/g), dashes: per1k(/—|–|\s-\s/g), parentheses: per1k(/\(/g),
      questions: per1k(/\?/g), exclamations: per1k(/!/g), contractions: per1k(/\b\w+['’](?:s|t|re|ve|ll|d|m)\b/gi),
      'I, me, my': per1k(/\b(?:i|me|my|mine|myself)\b/gi), 'we, us, our': per1k(/\b(?:we|us|our|ours|ourselves)\b/gi), 'you, your': per1k(/\b(?:you|your|yours|yourself)\b/gi),
      'figures': per1k(/\b\d[\d,.]*\b/g),
    },
    functionWords: fw,
  };
}
// Build a voice from samples: each sample of 60 words or more counts once.
export function buildVoice(samples) {
  const measured = samples.map((t) => voiceFeatures(t)).filter((m) => m.words >= 60);
  if (measured.length < 3) throw new Error(`A voice needs at least 3 samples of 60 words or more; found ${measured.length}. Add more writing the person wrote themselves.`);
  const features = {};
  for (const k of Object.keys(measured[0].features)) { const st = stats(measured.map((m) => m.features[k])); features[k] = { mean: +st.mean.toFixed(4), sd: +st.sd.toFixed(4) }; }
  const functionWords = {};
  for (const w of FUNCTION_WORDS) functionWords[w] = +(measured.reduce((a, m) => a + m.functionWords[w], 0) / measured.length).toFixed(3);
  const gb = samples.reduce((a, t) => a + (t.match(GB_RE) || []).length, 0), us = samples.reduce((a, t) => a + (t.match(US_RE) || []).length, 0);
  return { slopGuardVoice: 1, version: RULES.version, samples: measured.length, words: measured.reduce((a, m) => a + m.words, 0), features, functionWords, spelling: { gb, us } };
}
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (const k of Object.keys(b)) { d += (a[k] || 0) * b[k]; x += (a[k] || 0) ** 2; y += b[k] ** 2; } return x && y ? d / Math.sqrt(x * y) : 0; };
// Compare a draft with a voice: a 0-100 match and the features furthest from it.
export function compareVoice(text, voice) {
  const m = voiceFeatures(text);
  if (m.words < 80) return { words: m.words, match: null, drift: [] };
  const drift = [];
  for (const [k, v] of Object.entries(voice.features)) {
    // a spread no smaller than one use in a 200-word post, so a single "you" is not a crisis
    const floor = { 'sentence length': 1.5, 'paragraph length': 12, 'word length': 0.2, 'sentence spread': 0.08, 'short sentences': 0.08, 'long sentences': 0.06 }[k] ?? 6;
    const sd = Math.max(v.sd, Math.abs(v.mean) * 0.15, floor);
    const z = (m.features[k] - v.mean) / sd;
    drift.push({ feature: k, draft: m.features[k], voice: v.mean, z });
  }
  drift.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  // Each feature scores 1 at the voice's mean and falls away with distance; every feature far
  // outside the samples' range costs a further 15%. Function words count for a fifth, because on
  // short texts they are noisy.
  const kernel = drift.reduce((a, d) => a + Math.exp(-(d.z ** 2) / 8), 0) / drift.length;
  const far = drift.filter((d) => Math.abs(d.z) >= 2.5).length;
  const fw = cosine(m.functionWords, voice.functionWords);
  const match = Math.round(100 * kernel * 0.85 ** far * (0.8 + 0.2 * Math.max(0, Math.min(1, (fw - 0.5) / 0.5))));
  return { words: m.words, match: Math.max(0, Math.min(100, match)), functionWordSimilarity: +fw.toFixed(3), drift: drift.filter((d) => Math.abs(d.z) >= 2.5) };
}
const fmt = (k, x) => (/spread|short|long sentences/.test(k) && !/length/.test(k) ? `${Math.round(x * 100)}%` : x >= 10 ? x.toFixed(0) : x.toFixed(1));
// British and American spellings with one clear meaning each (pairs like program, meter and
// check are left out because both spellings are right in some sense).
const SPELLING = [['colour', 'color'], ['flavour', 'flavor'], ['honour', 'honor'], ['labour', 'labor'], ['neighbour', 'neighbor'], ['favour', 'favor'], ['behaviour', 'behavior'], ['endeavour', 'endeavor'], ['harbour', 'harbor'], ['humour', 'humor'], ['rumour', 'rumor'], ['vapour', 'vapor'], ['centre', 'center'], ['theatre', 'theater'], ['fibre', 'fiber'], ['litre', 'liter'], ['calibre', 'caliber'], ['sombre', 'somber'], ['catalogue', 'catalog'], ['dialogue', 'dialog'], ['analogue', 'analog'], ['defence', 'defense'], ['offence', 'offense'], ['pretence', 'pretense'], ['analyse', 'analyze'], ['paralyse', 'paralyze'], ['organise', 'organize'], ['organisation', 'organization'], ['realise', 'realize'], ['recognise', 'recognize'], ['apologise', 'apologize'], ['prioritise', 'prioritize'], ['optimise', 'optimize'], ['minimise', 'minimize'], ['maximise', 'maximize'], ['emphasise', 'emphasize'], ['summarise', 'summarize'], ['customise', 'customize'], ['visualise', 'visualize'], ['standardise', 'standardize'], ['travelled', 'traveled'], ['travelling', 'traveling'], ['cancelled', 'canceled'], ['cancelling', 'canceling'], ['modelling', 'modeling'], ['labelled', 'labeled'], ['labelling', 'labeling'], ['grey', 'gray'], ['aluminium', 'aluminum'], ['sceptical', 'skeptical'], ['mould', 'mold'], ['plough', 'plow'], ['jewellery', 'jewelry'], ['manoeuvre', 'maneuver'], ['paediatric', 'pediatric'], ['haemorrhage', 'hemorrhage'], ['oesophagus', 'esophagus'], ['anaesthetic', 'anesthetic'], ['enrolment', 'enrollment'], ['fulfil', 'fulfill'], ['instalment', 'installment'], ['ageing', 'aging'], ['cheque', 'check-NONE'], ['kerb', 'curb-NONE']].filter(([, u]) => !u.endsWith('-NONE'));
const inflect = (w) => `${w}(?:s|d|ed|ing|es|er|ers|ation|ations)?`;
const GB_RE = new RegExp(`\\b(?:${SPELLING.map(([g]) => inflect(g)).join('|')})\\b`, 'gi');
const US_RE = new RegExp(`\\b(?:${SPELLING.map(([, u]) => inflect(u)).join('|')})\\b`, 'gi');
// Extra checks that need a profile, a voice or a target: reading grade, spelling, voice drift.
function profileDetectors(text, kind, file, context, profile, voice) {
  const out = [];
  if (kind !== 'text' && kind !== 'html') return out;
  const prose = kind === 'html' ? textOf(stripHtml(text).replace(/<(code|pre|kbd|samp|blockquote|q|nav|footer)\b[\s\S]*?<\/\1>/gi, blank).replace(/<\/(p|li|h[1-6]|div)>/gi, '$&\n\n')) : text;
  const target = { copy: 9, web: 9, app: 9, deck: 10, doc: 13, ...(profile?.readingGrade || {}) }[context || (kind === 'html' ? 'web' : 'doc')];
  const g = readingGrade(prose);
  if (g != null && target != null && g > target) out.push({ detector: 'reading-grade', file, line: 1, evidence: `grade ${g}`, message: `Reads at about grade ${g}; this context aims for ${target} or below. Shorter sentences and plainer words bring it down.` });
  const sp = profile?.spelling;
  if (sp) {
    const wrong = [...(prose.match(sp === 'en-GB' ? US_RE : GB_RE) || [])];
    const masked = maskProse(prose);
    const hits = wrong.filter((w) => new RegExp(`\\b${w}\\b`).test(masked));
    if (hits.length) out.push({ detector: 'spelling-variant', file, line: lineAt(text, Math.max(0, text.indexOf(hits[0]))), evidence: hits[0], message: `${hits.length} word${hits.length > 1 ? 's' : ''} in ${sp === 'en-GB' ? 'American' : 'British'} spelling (${[...new Set(hits.map((h) => h.toLowerCase()))].slice(0, 5).join(', ')}); this profile uses ${sp}.` });
  }
  if (voice) {
    const v = compareVoice(prose, voice);
    if (v.match != null && v.drift.length) out.push({ detector: 'voice-drift', file, line: 1, evidence: `voice match ${v.match}/100`, message: `Further from the voice than its samples usually are: ${v.drift.slice(0, 3).map((d) => `${d.feature} ${fmt(d.feature, d.draft)} (samples ${fmt(d.feature, d.voice)})`).join('; ')}.`, severity: v.drift.length >= 3 ? 'medium' : 'low' });
  }
  return out;
}
// Facts an edit must keep: figures with their units, names, and negations.
const FACT_FIGURE = /(?:[$€£¥₹]\s?|\b(?:RM|USD|MYR|EUR|GBP|SGD|INR)\s?)?\b\d[\d,]*(?:\.\d+)?(?:\s?%|\s?(?:percent|k|m|bn|million|billion|thousand|km|kg|g|mg|ml|l|ms|px|gb|mb|tb|hours?|hrs?|days?|weeks?|months?|years?|x|times)\b|(?![\w.]))/gi;
const NEGATION = /\b(?:not|no|never|none|nobody|nothing|neither|nor|without|cannot)\b|n['’]t\b/gi;
const normFig = (x) => x.toLowerCase().replace(/[\s,]/g, '').replace(/percent$/, '%').replace(/hrs?$|hours?$/, 'h');
// Capitalised names; a single capitalised word that only starts a sentence is not counted.
const namesIn = (t) => new Set([...t.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|[A-Z][a-z]+|[A-Z]{2,}[a-z]*)\b/g)].filter((m) => /\s/.test(m[1]) || /[A-Z]{2}/.test(m[1]) || !/(?:^|[.!?]\s+|\n\s*)$/.test(t.slice(Math.max(0, m.index - 3), m.index))).map((m) => m[1]).filter((x) => !/^(I|A|The|This|That|It|We|They|You|He|She|In|On|At|If|But|And|Or|So)$/.test(x)));
export function factCheck(before, after, file = '<after>') {
  const out = [];
  const b = maskProse(before, { quotes: false }), a = maskProse(after, { quotes: false });
  const figs = (t) => { const m = new Map(); for (const x of t.match(FACT_FIGURE) || []) { const k = normFig(x); if (/\d/.test(k)) m.set(k, (m.get(k) || 0) + 1); } return m; };
  const fb = figs(b), fa = figs(a);
  const lost = [...fb.keys()].filter((k) => !fa.has(k)), added = [...fa.keys()].filter((k) => !fb.has(k));
  if (lost.length) out.push({ detector: 'fact-change', file, line: 1, evidence: lost.slice(0, 6).join(', '), message: `${lost.length} figure${lost.length > 1 ? 's' : ''} from the earlier version ${lost.length > 1 ? 'are' : 'is'} gone (${lost.slice(0, 6).join(', ')}): check the edit kept the facts.` });
  if (added.length) out.push({ detector: 'fact-change', file, line: lineAt(after, Math.max(0, after.indexOf((after.match(FACT_FIGURE) || []).find((x) => added.includes(normFig(x))) || ''))), evidence: added.slice(0, 6).join(', '), message: `${added.length} new figure${added.length > 1 ? 's' : ''} that the earlier version did not have (${added.slice(0, 6).join(', ')}): check each one has a source.` });
  const lostN = [...namesIn(b)].filter((x) => !new RegExp(`\\b${escapeRe(x)}\\b`).test(a));
  if (lostN.length) out.push({ detector: 'fact-change', file, line: 1, evidence: lostN.slice(0, 6).join(', '), message: `Name${lostN.length > 1 ? 's' : ''} dropped by the edit: ${lostN.slice(0, 6).join(', ')}.`, severity: 'low' });
  const gb = (b.match(NEGATION) || []).length, ga = (a.match(NEGATION) || []).length;
  if (gb !== ga) out.push({ detector: 'fact-change', file, line: 1, evidence: `negations ${gb} → ${ga}`, message: `The number of negations changed from ${gb} to ${ga} (not, no, never, without…): check no statement flipped its meaning.`, severity: Math.abs(gb - ga) >= 2 ? 'medium' : 'low' });
  return out;
}
// digits are left out of the key, so a finding whose evidence is a count or a figure matches its earlier self
const findingKey = (f) => `${f.rule}|${String(f.evidence).toLowerCase().replace(/\d+(?:[.,]\d+)*/g, '#').replace(/\s+/g, ' ').trim()}`;
export function diffFindings(before, after) {
  const bk = new Set(before.map(findingKey)), ak = new Set(after.map(findingKey));
  return { added: after.filter((f) => !bk.has(findingKey(f))), removed: before.filter((f) => !ak.has(findingKey(f))), kept: after.filter((f) => bk.has(findingKey(f))).length };
}

// ---- v2.2: profiles, genres, hard and soft findings, the trend score ------------------------
// A profile is an optional JSON file the user supplies (examples in profiles/). With none, the
// neutral defaults in rules.json apply. Hard rules stay on unless the profile sets allowHardOff.
const PROFILE_KEYS = ['$schema', 'name', 'description', 'genre', 'off', 'severity', 'allowHardOff', 'allow', 'ban', 'mask', 'minScoreWords', 'spelling', 'readingGrade', 'voice'];
export function loadProfile(file) {
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Profile ${file} could not be read: ${e.message}`); }
  const bad = Object.keys(p).filter((k) => !PROFILE_KEYS.includes(k) && !k.startsWith('_'));
  if (bad.length) throw new Error(`Profile ${file} has unknown key${bad.length > 1 ? 's' : ''} ${bad.join(', ')}. Allowed: ${PROFILE_KEYS.join(', ')}.`);
  for (const id of [...(p.off || []), ...Object.keys(p.severity || {})]) if (!RULE[id]) throw new Error(`Profile ${file} names the rule "${id}", which does not exist. List rules with --list.`);
  for (const [id, sev] of Object.entries(p.severity || {})) if (!['high', 'medium', 'low'].includes(sev)) throw new Error(`Profile ${file}: severity for "${id}" must be high, medium or low, not "${sev}".`);
  if (p.genre && !RULES.genres[p.genre]) throw new Error(`Profile ${file}: unknown genre "${p.genre}". Use one of: ${Object.keys(RULES.genres).join(', ')}.`);
  p.ban = (p.ban || []).map((b) => (typeof b === 'string' ? { phrase: b } : b));
  p.dir = path.dirname(path.resolve(file));
  if (p.spelling && !['en-GB', 'en-US'].includes(p.spelling)) throw new Error(`Profile ${file}: spelling must be "en-GB" or "en-US", not "${p.spelling}".`);
  for (const [c, g] of Object.entries(p.readingGrade || {})) if (!RULES.contexts[c] || typeof g !== 'number') throw new Error(`Profile ${file}: readingGrade needs a known context and a number, not ${c}: ${g}.`);
  if (typeof p.voice === 'string') p.voice = loadVoice(path.resolve(p.dir, p.voice));
  return p;
}
export function loadVoice(file) {
  let v;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Voice file ${file} could not be read: ${e.message}`); }
  if (v.slopGuardVoice !== 1 || !v.features || !v.functionWords) throw new Error(`${file} is not a voice file. Make one with --build-voice <samples>.`);
  return v;
}
const LOWER = { high: 'medium', medium: 'low', low: 'low' };
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Apply a genre's allowances and a profile's choices to resolved findings.
export function applyPolicy(findings, { profile, genre } = {}) {
  const g = RULES.genres[genre || profile?.genre];
  const off = new Set(profile?.off || []);
  const allow = (profile?.allow || []).map((w) => new RegExp(`(?<![\\w-])${escapeRe(w)}(?![\\w-])`, 'i'));
  return findings.flatMap((f) => {
    const hard = f.kind === 'hard', mayTouch = !hard || profile?.allowHardOff;
    if (off.has(f.rule) && mayTouch) return [];
    if (g && !hard && g.off.includes(f.rule)) return [];
    if (allow.length && f.rule !== 'profile-words' && allow.some((re) => re.test(String(f.evidence)))) return [];
    let severity = f.severity;
    if (g && !hard && g.lower.includes(f.rule)) severity = LOWER[severity];
    if (profile?.severity?.[f.rule] && mayTouch) severity = profile.severity[f.rule];
    return [{ ...f, severity }];
  });
}
// Words of prose a reader sees: Markdown or text without code, headings, lists and quotes;
// HTML without scripts, styles, code, navigation and footers.
export function proseWordCount(content, kind) {
  if (kind === 'text') return wordCount(proseLines(maskProse(content)).join(' ').replace(/"[ ]*"/g, ' '));
  if (kind === 'html') return wordCount(textOf(stripHtml(content).replace(/<(code|pre|kbd|samp|blockquote|q|nav|footer)\b[\s\S]*?<\/\1>/gi, blank)));
  return 0;
}
// A 0-100 number for watching one piece of work over time. It is not a grade and not a
// comparison between writers. Texts under minWords (150 by default) get no score, because a
// couple of findings would swing it wildly; short texts are also counted as at least 400 words.
const WEIGHT = { high: 10, medium: 4, low: 1 };
export function trendScore(findings, words, minWords = 150) {
  if (words < minWords) return null;
  const penalty = findings.reduce((a, f) => a + WEIGHT[f.severity], 0);
  return Math.round(100 * Math.exp(-(penalty * 1000 / Math.max(words, 400)) / 50));
}
// Text that is not in a file: a commit message, a pull request description, a generated reply.
export function checkStdin(content, { kind = 'text', name = '<stdin>', ...opts } = {}) {
  if (!['text', 'html'].includes(kind)) throw new Error(`--kind takes text or html, not "${kind}".`);
  const findings = checkText(content, kind, name, opts);
  const words = proseWordCount(content, kind);
  const score = trendScore(findings, words, opts.profile?.minScoreWords);
  return { files: 1, findings, scores: [{ file: name, words, score }], score };
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
const countBy = (fs_) => { const c = { high: 0, medium: 0, low: 0 }; for (const f of fs_) c[f.severity]++; return c; };
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); } catch { return false; } })();
// The CLI sets process.exitCode rather than exiting at once, so piped output is never cut short.
function cli() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const context = opt('--context');
  if (context && !RULES.contexts[context]) { console.error(`Unknown context "${context}". Use one of: ${Object.keys(RULES.contexts).join(', ')}`); process.exitCode = 2; return; }
  if (args.includes('--rules-md')) {
    const parts = Object.entries(RULES.contexts).map(([c, label]) => `## ${c}: ${label}\n\n${listMarkdown(c)}`);
    process.stdout.write(`<!-- slop-guard: ignore-file (this file lists the patterns themselves) -->\n# slop-guard rules by context\n\nGenerated from \`rules.json\` v${RULES.version} by \`node check-slop.mjs --rules-md\`. Do not edit by hand. ${RULES.rules.length} rules. These are design and writing preferences, not a test of who or what made something.\n\n${parts.join('\n')}`);
    return;
  }
  if (args.includes('--list')) { process.stdout.write(listMarkdown(context)); return; }
  if (args.includes('--rubric')) { process.stdout.write(listMarkdown(context, ['screenshot', 'judgement'])); return; }
  let profile;
  const profilePath = opt('--profile') || process.env.SLOP_GUARD_PROFILE;
  if (profilePath) { try { profile = loadProfile(profilePath); } catch (e) { console.error(e.message); process.exitCode = 2; return; } }
  const genre = opt('--genre');
  if (genre && !RULES.genres[genre]) { console.error(`Unknown genre "${genre}". Use one of: ${Object.keys(RULES.genres).join(', ')}`); process.exitCode = 2; return; }
  if (args.includes('--genres')) { process.stdout.write(Object.entries(RULES.genres).map(([k, g]) => `- ${k}: ${g.label}. Off: ${g.off.join(', ') || 'none'}. Lowered: ${g.lower.join(', ') || 'none'}.`).join('\n') + '\n'); return; }
  const failOn = opt('--fail-on') || (args.includes('--strict') ? 'high' : null);
  if (failOn && !['hard', 'high', 'medium', 'low'].includes(failOn)) { console.error(`--fail-on takes hard, high, medium or low, not "${failOn}".`); process.exitCode = 2; return; }
  const skip = new Set(['--context', '--json', '--year', '--pairing', '--profile', '--genre', '--history', '--fail-on', '--kind', '--name', '--voice', '--split', '--before', '--git-base', '--build-voice']);
  // v2.4: build a voice file from samples the person wrote themselves, and print it
  if (args.includes('--build-voice')) {
    const from = args.filter((a, i) => !a.startsWith('--') && !skip.has(args[i - 1]) || args[i - 1] === '--build-voice');
    // split before each match, so a heading stays with its sample and is dropped as a heading
    const split = opt('--split') ? new RegExp(`(?=${opt('--split')})`, 'm') : null;
    const samples = from.flatMap((p) => walk(p)).filter((f) => ['text', 'html'].includes(EXT[path.extname(f).toLowerCase()])).flatMap((f) => { const c = fs.readFileSync(f, 'utf8'); const t = EXT[path.extname(f).toLowerCase()] === 'html' ? textOf(stripHtml(c)) : c; return split ? t.split(split).filter((x) => x.trim()) : [t]; });
    try { process.stdout.write(JSON.stringify(buildVoice(samples), null, 2) + '\n'); } catch (e) { console.error(e.message); process.exitCode = 2; }
    return;
  }
  let voice;
  if (opt('--voice')) { try { voice = loadVoice(opt('--voice')); } catch (e) { console.error(e.message); process.exitCode = 2; return; } }
  voice ||= profile?.voice;
  const targets = args.filter((a, i) => !a.startsWith('--') && !skip.has(args[i - 1]));
  // v2.3: --stdin checks text piped in, such as a commit message or a pull request description
  const stdin = args.includes('--stdin') ? fs.readFileSync(0, 'utf8') : null;
  if (!targets.length && stdin == null) { console.error('Usage: node check-slop.mjs <file or folder>... [--context web|app|deck|doc|copy|image|code] [--json out.json] [--strict]'); process.exitCode = 2; return; }
  const year = +(opt('--year') || new Date().getFullYear());
  const res = stdin ? checkStdin(stdin, { context, year, profile, genre, voice, kind: opt('--kind') || 'text', name: opt('--name') || '<stdin>' }) : checkPaths(targets, { context, year, pairing: opt('--pairing'), profile, genre, voice });
  // v2.4: compare with an earlier version, from a file (--before) or from git (--git-base <rev>)
  let diff = null;
  if (opt('--before') || opt('--git-base')) {
    const files = stdin ? [] : targets.flatMap((p) => walk(p));
    if (opt('--before') && files.length !== 1) { console.error('--before compares one file: name exactly one target.'); process.exitCode = 2; return; }
    diff = { added: [], removed: [], kept: 0, facts: [] };
    for (const f of files) {
      let before = null;
      if (opt('--before')) before = fs.readFileSync(opt('--before'), 'utf8');
      else { try { before = execFileSync('git', ['-C', path.dirname(path.resolve(f)), 'show', `${opt('--git-base')}:./${path.basename(f)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); } catch { before = null; } }
      const kind = EXT[path.extname(f).toLowerCase()];
      const now = res.findings.filter((x) => x.file === f);
      if (before == null) { diff.added.push(...now); continue; }
      const d = diffFindings(checkText(before, kind, f, { context, year, profile, genre, voice }), now);
      diff.added.push(...d.added); diff.removed.push(...d.removed); diff.kept += d.kept;
      if (kind === 'text' || kind === 'html') diff.facts.push(...applyPolicy(resolve(factCheck(kind === 'html' ? textOf(stripHtml(before)) : before, kind === 'html' ? textOf(stripHtml(fs.readFileSync(f, 'utf8'))) : fs.readFileSync(f, 'utf8'), f), context ? [context] : DEFAULT_CONTEXT[kind]), { profile, genre }));
    }
    res.findings.push(...diff.facts);
  }
  const order = { high: 0, medium: 1, low: 2 };
  res.findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of res.findings) counts[f.severity]++;
  const hard = res.findings.filter((f) => f.kind === 'hard').length;
  for (const f of res.findings) console.log(`${f.severity.toUpperCase().padEnd(6)} ${f.rule.padEnd(20)} ${path.relative(process.cwd(), f.file)}:${f.line}  ${f.message}${f.kind === 'hard' ? ' [hard]' : ''}\n       ${f.evidence}`);
  const setting = [context && `context: ${context}`, (genre || profile?.genre) && `genre: ${genre || profile.genre}`, profile && `profile: ${profile.name || path.basename(profilePath)}`].filter(Boolean).join(', ');
  console.log(`\nslop-guard: ${res.files} file(s), ${res.findings.length} finding(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low; ${hard} hard${setting ? ` (${setting})` : ''}. Hits are evidence for a reviewer, not a verdict.`);
  if (profile?.allowHardOff) console.log('Note: this profile may switch off hard rules (allowHardOff), so defects can go unreported.');
  if (diff) {
    console.log(`Compared with ${opt('--before') || `git ${opt('--git-base')}`}: ${diff.added.length} new finding(s), ${diff.removed.length} fixed, ${diff.kept} unchanged${diff.facts.length ? `, ${diff.facts.length} fact check(s) to review` : ', facts kept'}.`);
    for (const f of diff.added.slice(0, 15)) console.log(`  + ${f.rule}  ${path.relative(process.cwd(), f.file)}:${f.line}  ${f.evidence}`);
    for (const f of diff.removed.slice(0, 15)) console.log(`  - ${f.rule}  ${String(f.evidence).slice(0, 100)}`);
  }
  if (voice && !stdin) for (const f of res.scores.filter((x) => x.words >= 80)) { const v = compareVoice(fs.readFileSync(f.file, 'utf8'), voice); if (v.match != null) console.log(`Voice match: ${v.match}/100 for ${path.relative(process.cwd(), f.file)} (function words ${Math.round(v.functionWordSimilarity * 100)}% alike). A guide to drafting, not proof of who wrote it.`); }
  if (voice && stdin) { const v = compareVoice(stdin, voice); if (v.match != null) console.log(`Voice match: ${v.match}/100. A guide to drafting, not proof of who wrote it.`); }
  const history = opt('--history');
  let previous = {};
  if (history && fs.existsSync(history)) for (const l of fs.readFileSync(history, 'utf8').split('\n')) { try { const h = JSON.parse(l); previous[h.file] = h.score; } catch { /* a malformed history line is skipped, not fatal */ } }
  const scored = res.scores.filter((x) => x.score != null);
  if (scored.length) {
    const delta = (x) => (previous[x.file] != null ? ` (${x.score - previous[x.file] >= 0 ? '+' : ''}${x.score - previous[x.file]} since last run)` : '');
    console.log(`Trend score: ${scored.length === 1 ? `${scored[0].score}/100${delta(scored[0])}` : `${res.score}/100 across ${scored.length} files of prose`}. Use it to compare versions of the same work over time; it is not a grade.`);
    if (scored.length > 1 && scored.length <= 20) for (const x of scored) console.log(`  ${String(x.score).padStart(3)}  ${path.relative(process.cwd(), x.file)}${delta(x)}`);
  }
  if (history) { const at = new Date().toISOString(); fs.appendFileSync(history, scored.map((x) => JSON.stringify({ at, version: RULES.version, file: x.file, words: x.words, score: x.score, ...countBy(res.findings.filter((f) => f.file === x.file)) }) + '\n').join('')); }
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ version: RULES.version, context: context || null, genre: genre || profile?.genre || null, profile: profile?.name || null, counts: { ...counts, hard }, ...res, ...(diff ? { diff: { added: diff.added.length, removed: diff.removed.length, kept: diff.kept, facts: diff.facts } } : {}) }, null, 2));
  const failing = failOn === 'hard' ? hard : failOn ? res.findings.filter((f) => order[f.severity] <= order[failOn]).length : 0;
  process.exitCode = failing ? 1 : 0;
}
if (isMain) cli();
