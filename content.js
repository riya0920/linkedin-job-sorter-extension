// LinkedIn Job Sorter - Chrome Extension
// Automatically runs on LinkedIn job search pages
//
// Ordering is ALWAYS newest-first. The fit score is shown as a badge, never
// used to re-order — a strong match that is three days old still sorts below
// something posted an hour ago.

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG — edit these lists freely, they are plain strings.
  // ─────────────────────────────────────────────────────────────────────────
  const KEYWORDS = [
    'machine learning', 'ml engineer', 'ai engineer', 'data scientist',
    'deep learning', 'nlp', 'computer vision', 'pytorch', 'tensorflow',
    'llm', 'genai', 'gen ai', 'applied scientist', 'research scientist',
    'mle', 'new grad', 'entry level', 'junior', 'associate'
  ];

  // Titles that usually mean "not a new-grad role".
  const NEGATIVE_KEYWORDS = [
    'senior', 'sr.', 'sr ', 'staff ', 'principal', 'lead ', 'manager',
    'director', 'head of', 'vp ', 'vice president', 'architect',
    '5+ years', '6+ years', '7+ years', '8+ years', '10+ years',
    'iii', ' iv', 'expert', 'fellow'
  ];

  // Work-authorisation blockers, ported from h1b-alert/sponsorship.py.
  // Matched against the CARD text only (title + whatever the card shows), so
  // this catches roles that say it up front. Most postings only say it in the
  // full description, which the card never contains.
  const NO_SPONSOR_PATTERNS = [
    [/\bu\.?\s?s\.?\s+citizens?\s+only\b/i, 'citizens only'],
    [/\bcitizens(hip)?\s+only\b/i, 'citizens only'],
    [/\bmust\s+be\s+a\s+u\.?\s?s\.?\s+citizen\b/i, 'citizens only'],
    [/\b(u\.?\s?s\.?\s+)?citizenship\s+(is\s+)?required\b/i, 'citizens only'],
    [/\bgreen\s+card\s+(holders?\s+)?only\b/i, 'citizens only'],
    [/\bno\s+(visa\s+)?sponsorship\b/i, 'no sponsorship'],
    [/\bsponsorship\s+is\s+not\s+available\b/i, 'no sponsorship'],
    [/\b(cannot|can\s?not|unable\s+to|not\s+able\s+to|will\s+not|does\s+not|do\s+not)\s+(offer\s+|provide\s+|support\s+)?(visa\s+)?sponsor/i, 'no sponsorship'],
    [/\bwithout\s+(the\s+need\s+for\s+)?(visa\s+)?sponsor/i, 'no sponsorship'],
    [/\bnot\s+eligible\s+for\s+(visa\s+)?sponsor/i, 'no sponsorship'],
    [/\bmust\s+be\s+(legally\s+)?authorized\s+to\s+work\s+.{0,40}\bwithout\b/i, 'no sponsorship'],
    [/\b(active\s+)?(security\s+)?clearance\b/i, 'clearance'],
    [/\bts\s?\/\s?sci\b/i, 'clearance'],
    [/\btop\s+secret\b/i, 'clearance'],
    [/\bpolygraph\b/i, 'clearance']
  ];

  // Staffing shops and body-shops that flood ML searches. Matched as whole
  // words against the company name (word-boundary), so "consulting" catches
  // "Apetan Consulting LLC" but not a company merely mentioning consulting.
  const STAFFING_COMPANIES = [
    // named agencies / IT body-shops
    'diverse lynx', 'cybercoders', 'insight global', 'robert half', 'teksystems',
    'randstad', 'adecco', 'kforce', 'motion recruitment', 'jobot', 'dice',
    'apex systems', 'collabera', 'aditi', 'mindlance', 'artech', 'infojini',
    'talentburst', 'compunnel', 'harnham', 'averity', 'jefferson frank',
    'oscar technology', 'phoenix recruitment', 'akkodis', 'experis', 'modis',
    'hays', 'michael page', 'lorien', 'signify technology',
    'understanding recruitment', 'burtch works', 'apetan', 'mastech', 'net2source',
    'nlb services', 'sunrise systems', 'ampcus', 'e-solutions', 'saxon global',
    'photon', 'ust global', 'nastech', 'stellent', 'vdart', 'v-soft', 'zortech',
    // generic role words that signal an agency / body-shop
    'staffing', 'staffing agency', 'recruiting', 'recruitment', 'recruiters',
    'talent solutions', 'talent acquisition', 'talent group', 'consultancy',
    'consulting group', 'consulting llc', 'consulting inc', 'consulting services',
    'consulting', 'consultants', 'it consulting', 'it services', 'it solutions',
    'resourcing', 'resources llc', 'outsourcing', 'workforce', 'placements',
    'placement services', 'staff augmentation', 'infotech', 'softech',
    'info systems', 'infosystems', 'manpower', 'headhunt'
  ];

  const SCORE = {
    base: 20,
    keyword: 18, keywordCap: 45,
    sponsor: 25,
    negative: -20, negativeCap: -40,
    staffing: -25,
    repost: -10,
    noSponsor: -45,          // a hard blocker for someone who needs sponsorship
    recency: [[3600, 20], [43200, 15], [86400, 10], [259200, 5]]
  };

  const MAX_PAGES = 5;          // auto-paginate ceiling
  const CLICK_DELAY = 350;
  const LINK_TIMEOUT = 2500;
  const DEEP_TIMEOUT = 9000;
  const PAGE_TIMEOUT = 10000;
  const STORE_KEY = '__ljs_jobs';
  const SEEN_KEY = '__ljs_seen';
  const APPLIED_KEY = '__ljs_applied';
  const OPTS_KEY = '__ljs_opts';

  const UNIT_SECONDS = {
    second: 1, minute: 60, hour: 3600, day: 86400,
    week: 604800, month: 2592000, year: 31536000
  };

  const NOISE_RE = /^(be an early applicant|easy apply|promoted|actively (hiring|reviewing)|viewed|applied|\d+ (applicants?|connections?)|.*\balumni\b.*)$/i;
  const RELATIVE_RE = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i;
  const BARE_RE = /\b(?:an?|one)\s+(second|minute|hour|day|week|month|year)\s*ago/i;
  const JOB_HREF_RE = /\/jobs\/view\/(\d+)/;

  function cleanTimeText(s) {
    // LinkedIn duplicates the date the same way it duplicates the title:
    // 'Posted 42 minutes ago42 minutes ago' -> 'Posted 42 minutes ago'.
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    const m = t.match(/^(posted\s+|reposted\s+)?(.*?\bago)\s*\2$/i);
    return m ? ((m[1] || '') + m[2]).trim() : t;
  }

  function isTimeText(s) {
    return !!s && (RELATIVE_RE.test(s) || BARE_RE.test(s) ||
      /^posted on/i.test(s) || /just now|moments? ago/i.test(s));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SPONSOR INDEX — built once from sponsors.js (your h1b-job-alert list).
  // ─────────────────────────────────────────────────────────────────────────
  const LEGAL_SUFFIX = /\b(inc|inc\.|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|pbc|gmbh|s\.a|sa|ag|nv|bv|ab|oy|pte|pty|llp|lp|holdings|holding)\b/g;
  // Filler words dropped only to build a secondary alias, so "6Sense Insights"
  // still matches a LinkedIn card that just says "6sense".
  const FILLER = /\b(insights|labs|laboratories|technologies|technology|solutions|systems|services|group|international|worldwide|global|usa|us|america|americas|north)\b/g;
  // Noise specific to H-1B filing names: "ANTHROPIC PBC D B A ANTHROPIC INC",
  // "OPENAI OPCO LLC". Without this they never match the plain LinkedIn name.
  const FILING_NOISE = /\b(dba|d\s+b\s+a|opco|opsco|na|[a-z])\b/g;

  function normName(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[.,'’`()\[\]|/\\-]/g, ' ')
      .replace(LEGAL_SUFFIX, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Collapses "anthropic anthropic" (left behind by stripping "d b a") to one.
  function dedupeTokens(s) {
    const out = [];
    s.split(' ').forEach(t => { if (t && t !== out[out.length - 1]) out.push(t); });
    return out.join(' ');
  }

  function coreName(s) {
    const c = dedupeTokens(
      normName(s).replace(FILING_NOISE, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim()
    );
    return c || normName(s);
  }

  // Words too generic to identify an employer on their own — "Bank" must not
  // match "Bank of America", nor "Capital" match "Capital One".
  const TOO_GENERIC = new Set([
    'bank', 'group', 'capital', 'first', 'american', 'america', 'national',
    'united', 'general', 'international', 'global', 'data', 'tech', 'systems',
    'solutions', 'services', 'health', 'medical', 'university', 'college',
    'city', 'state', 'new', 'north', 'south', 'east', 'west', 'the', 'and',
    'management', 'partners', 'associates', 'consulting', 'research', 'digital'
  ]);

  // A single-token company only counts as a sponsor (via a collapsed core or a
  // prefix into a longer filing) when that filing is a substantial sponsor.
  // Without this "Access Labs" → "access" wrongly matched "ACCESS GLOBAL GROUP".
  const MIN_1TOKEN_PREFIX = 12;

  // normalised name -> new H-1B approvals FY2025 (0 = in the data, count unknown)
  const SPONSOR_INDEX = (function () {
    const map = new Map();
    const rows = (typeof LJS_SPONSOR_ROWS !== 'undefined') ? LJS_SPONSOR_ROWS
      : (typeof LJS_SPONSOR_COMPANIES !== 'undefined')
        ? LJS_SPONSOR_COMPANIES.map(n => [n, 0]) : [];
    // First pass: how many DISTINCT full names collapse to each core key.
    // A core shared by several different employers is ambiguous — "access"
    // came from "ACCESS GLOBAL GROUP" (global+group are both filler) and would
    // then badge any "Access …" firm.
    const coreSources = new Map();
    rows.forEach(row => {
      const nn = normName(row[0]), cn = coreName(row[0]);
      if (cn && cn !== nn) {
        if (!coreSources.has(cn)) coreSources.set(cn, new Set());
        coreSources.get(cn).add(nn);
      }
    });

    rows.forEach(row => {
      const name = row[0], count = row[1] || 0;
      const nn = normName(name), cn = coreName(name);
      const add = k => {
        if (!k) return;
        const toks = k.split(' ').filter(Boolean);
        // Stripping suffixes can reduce a name to one generic word —
        // "NATIONAL SYSTEMS AMERICA L.P." → "national". Never index that.
        if (toks.length === 1 && TOO_GENERIC.has(toks[0])) return;
        if (!map.has(k) || map.get(k) < count) map.set(k, count);
      };
      add(nn);
      // Only index a collapsed core when it's safe: multi-token, OR a single
      // token that names one substantial sponsor unambiguously. This keeps
      // "6sense" (from 6SENSE INSIGHTS) while dropping bogus "access".
      if (cn && cn !== nn) {
        const oneTok = cn.indexOf(' ') === -1;
        const ambiguous = (coreSources.get(cn) || new Set()).size > 1;
        // A single leftover token is safe when it's a real sponsor by volume, or
        // clearly a distinctive brand (has a digit, or is long) rather than a
        // plain word like "access". Ambiguous ones are always dropped.
        const distinctive = /\d/.test(cn) || cn.length >= 8;
        if (!oneTok || (!ambiguous && (count >= MIN_1TOKEN_PREFIX || distinctive))) add(cn);
      } else {
        add(cn);
      }
    });
    return map;
  })();

  const SPONSORS = new Set(SPONSOR_INDEX.keys());   // kept for the test harness

  // LinkedIn shows the brand ("Amazon"); H-1B filings show the legal entity
  // ("AMAZON COM SERVICES LLC"). Exact matching misses every one of those, so
  // a company also matches when its tokens are a PREFIX of a filing's tokens.
  const SPONSOR_PREFIX = (function () {
    const map = new Map();
    SPONSOR_INDEX.forEach((count, key) => {
      const toks = key.split(' ').filter(Boolean);
      if (!toks.length) return;
      if (!map.has(toks[0])) map.set(toks[0], []);
      map.get(toks[0]).push({ toks: toks, count: count });
    });
    return map;
  })();

  function prefixMatch(nameNorm) {
    const toks = nameNorm.split(' ').filter(Boolean);
    if (!toks.length || nameNorm.length < 3) return null;
    if (toks.length === 1 && TOO_GENERIC.has(toks[0])) return null;
    const bucket = SPONSOR_PREFIX.get(toks[0]);
    if (!bucket) return null;
    let best = null;
    for (const cand of bucket) {
      if (cand.toks.length < toks.length) continue;
      // A 1-token needle must fully name the candidate OR the candidate must be
      // a real sponsor by volume — otherwise "access" grabs any "Access …" firm.
      if (toks.length === 1 && cand.toks.length > 1 && cand.count < MIN_1TOKEN_PREFIX) continue;
      let ok = true;
      for (let i = 0; i < toks.length; i++) {
        if (cand.toks[i] !== toks[i]) { ok = false; break; }
      }
      if (ok && (!best || cand.count > best.count)) best = cand;
    }
    return best ? { count: best.count } : null;
  }

  // A hint, not a guarantee: name matching across LinkedIn and the H-1B filings
  // is inherently fuzzy, so this can occasionally mislabel a similarly-named firm.
  function sponsorInfo(company) {
    if (!company) return null;
    const n = normName(company);
    if (!n) return null;
    if (SPONSOR_INDEX.has(n)) return { count: SPONSOR_INDEX.get(n) };
    const c = coreName(company);
    if (SPONSOR_INDEX.has(c)) return { count: SPONSOR_INDEX.get(c) };
    const direct = prefixMatch(n) || prefixMatch(c);
    if (direct) return direct;
    // Fall back to the brand -> legal-name alias table.
    const alias = NAME_ALIASES[n] || NAME_ALIASES[c];
    if (alias) {
      const an = normName(alias);
      if (SPONSOR_INDEX.has(an)) return { count: SPONSOR_INDEX.get(an) };
      const pm = prefixMatch(an);
      if (pm) return pm;
    }
    return null;
  }

  function isKnownSponsor(company) { return sponsorInfo(company) !== null; }

  // Brand name on LinkedIn -> the legal name your H-1B data files it under.
  // These are NAME mappings only; the sponsorship fact still comes from your
  // own dataset. Every target below was verified to exist in sponsors.js.
  const NAME_ALIASES = {
    'amd': 'advanced micro devices',
    'stanford university': 'the leland stanford jr university',
    'stanford': 'the leland stanford jr university',
    'tiktok usds joint venture': 'tiktok u s data security',
    'tiktok usds': 'tiktok u s data security',
    'tiktok': 'tiktok inc',
    'citadel securities': 'citadel americas services',
    'citadel': 'citadel americas services'
  };

  // ─────────────────────────────────────────────────────────────────────────
  // TIME PARSING
  // ─────────────────────────────────────────────────────────────────────────
  // Returns the ABSOLUTE moment the job was posted (epoch ms), or null if unknown.
  function parsePostedAt(text, now) {
    if (!text) return null;
    now = now || Date.now();
    const t = String(text).toLowerCase().trim();

    if (/just now|moments? ago/.test(t)) return now;

    // Absolute dates first: "Posted on Monday, April 13" contains "day", so a
    // substring test would misread it as "1 day ago".
    const abs = String(text).match(/posted on\s+(.+)$/i);
    if (abs) {
      const s = abs[1].trim();
      for (const cand of [s, s.split('·')[0].trim(), s.split('  ')[0].trim()]) {
        if (!cand) continue;
        const d = new Date(cand);
        if (!isNaN(d.getTime())) return Math.min(d.getTime(), now);
      }
    }

    const rel = t.match(RELATIVE_RE);
    if (rel) return now - parseInt(rel[1], 10) * UNIT_SECONDS[rel[2].toLowerCase()] * 1000;

    const bare = t.match(BARE_RE);
    if (bare) return now - UNIT_SECONDS[bare[1].toLowerCase()] * 1000;

    return null;
  }

  function ageOf(job, now) {
    if (job.postedAt == null) return null;
    return Math.max(0, Math.floor(((now || Date.now()) - job.postedAt) / 1000));
  }

  function fmtTime(secs) {
    if (secs == null || !isFinite(secs)) return 'unknown';
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.round(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ' + Math.round((secs % 3600) / 60) + 'm ago';
    return Math.floor(secs / 86400) + 'd ' + Math.floor((secs % 86400) / 3600) + 'h ago';
  }

  function timeColor(secs) {
    if (secs == null || !isFinite(secs)) return { color: '#6b7280', bg: '#f3f4f6' };
    if (secs <= 3600) return { color: '#059669', bg: '#ecfdf5' };
    if (secs <= 43200) return { color: '#0a66c2', bg: '#eff6ff' };
    if (secs <= 86400) return { color: '#b45309', bg: '#fffbeb' };
    return { color: '#6b7280', bg: '#f3f4f6' };
  }

  function groupOf(secs) {
    if (secs == null || !isFinite(secs)) return '⚪ Unknown date';
    if (secs <= 3600) return '🟢 Last Hour';
    if (secs <= 43200) return '🔵 Last 12 Hours';
    if (secs <= 86400) return '🟡 Last 24 Hours';
    return '⚪ Older';
  }


  // ─────────────────────────────────────────────────────────────────────────
  // CLASSIFICATION + SCORING
  // ─────────────────────────────────────────────────────────────────────────
  function matchesKeyword(title) {
    const lower = String(title || '').toLowerCase();
    return KEYWORDS.filter(k => lower.includes(k));
  }

  // Whole-phrase matching. A plain substring test flags "Haystack AI" as an
  // agency (contains "hays") and "Seniority" as senior, so each phrase is
  // anchored to word boundaries wherever it starts/ends with a word character.
  function phraseRe(phrase) {
    const esc = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const pre = /^\w/.test(phrase.trim()) ? '\\b' : '';
    const post = /\w$/.test(phrase.trim()) ? '\\b' : '';
    return new RegExp(pre + esc + post, 'i');
  }

  const NEGATIVE_RES = NEGATIVE_KEYWORDS.map(k => ({ label: k.trim(), re: phraseRe(k) }));
  const STAFFING_RES = STAFFING_COMPANIES.map(s => phraseRe(s));

  function matchesNegative(title) {
    const t = String(title || '');
    if (!t) return [];
    return NEGATIVE_RES.filter(n => n.re.test(t)).map(n => n.label);
  }

  function isStaffing(company) {
    const c = String(company || '');
    if (!c) return false;
    return STAFFING_RES.some(re => re.test(c));
  }

  // Strong "this is a recruiter posting for a client" phrases. Only checked
  // against the description Deep scan captured — kept tight to avoid tagging a
  // direct employer that merely mentions clients.
  const RECRUITER_DESC_RE = /\b(on behalf of (?:our|a|their) client|our client is|our client,|our client is seeking|we are a (?:staffing|recruit\w*|talent)\b|staffing agency|recruitment agency|recruiting firm|is a (?:staffing|recruiting) (?:agency|firm|company))\b/i;

  // A job is "agency" if the company name is a known staffing firm OR the
  // description reads like a recruiter posting for a client.
  function isAgencyJob(j) {
    return isStaffing(j.company) || RECRUITER_DESC_RE.test(String(j.desc || ''));
  }

  // "Reposted", "Re-posted", "Reposted 3 days ago" — anywhere on the card.
  const REPOST_RE = /\bre-?\s?posted\b/i;

  function isRepost(job) {
    // Set by a Deep scan, which reads the job detail panel. LinkedIn does not
    // print "Reposted" on the result cards at all — only in that panel — so the
    // card text alone can never reveal it.
    if (job.repostDetail) return true;
    return REPOST_RE.test(String(job.timeText || '') + ' ' + String(job.raw || ''));
  }

  // Does the currently-open job detail panel say "Reposted"? Everything inside
  // the results list is excluded so a neighbouring card cannot be mistaken for it.
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1 };

  // Page furniture that is neither the results list nor the job detail pane.
  // Without excluding this, a walk of the page returns LinkedIn's nav bar
  // ("Home | My Network | Jobs | Messaging") before ever reaching the pane.
  const CHROME_SEL = 'header, nav, footer, [role="banner"], [role="navigation"],' +
    ' [role="contentinfo"], [role="dialog"], #global-nav, [class*="global-nav"],' +
    ' [class*="msg-overlay"], [id*="msg-overlay"]';

  // Excluding one big container fails: the results list resolves to the whole
  // main element, which also holds the detail pane. Excluding each CARD instead
  // leaves the pane readable wherever it sits.
  function excludedRoots() {
    const roots = new Set();
    try { document.querySelectorAll(CHROME_SEL).forEach(el => roots.add(el)); } catch (e) {}
    const p = document.getElementById('ljs-panel'); if (p) roots.add(p);
    const t = document.getElementById('ljs-toggle'); if (t) roots.add(t);
    const main = mainEl();
    if (main) jobCards(main).forEach(c => roots.add(c));
    return roots;
  }

  function isExcluded(node, roots) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (roots.has(el)) return true;
    }
    return false;
  }

  function textSaysReposted(root, roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      // Inline <script>/JSON blobs mention "reposted" constantly; their text
      // nodes are part of the DOM and would match everything.
      if (parent && SKIP_TAGS[parent.tagName]) continue;
      if (isExcluded(node, roots)) continue;
      const t = node.textContent;
      if (t && REPOST_RE.test(t)) return true;
    }
    return false;
  }

  // The narrowest element containing every job card. On LinkedIn the detail
  // pane lives INSIDE [componentkey="SearchResultsMainContent"] alongside the
  // list, so excluding the whole of main would hide the detail pane as well —
  // and detection could never succeed. Only the card list is excluded.
  function resultsListEl() {
    const main = mainEl();
    if (!main) return null;
    const cards = jobCards(main);
    if (!cards.length) return main;
    const last = cards[cards.length - 1];
    let el = cards[0];
    while (el && el !== main && !el.contains(last)) el = el.parentElement;
    return el || main;
  }

  // A bare .click() fires only a click event. React/LinkedIn listen for the
  // pointer/mouse sequence, so a plain click silently does nothing — which is
  // why every deep-scanned job timed out and was recorded as "not a repost".
  function realClick(el) {
    const block = e => e.preventDefault();      // stop the <a> navigating away
    el.addEventListener('click', block, true);
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch (e) {
      try { el.click(); } catch (e2) {}
    }
    setTimeout(() => el.removeEventListener('click', block, true), 0);
  }

  // The element LinkedIn actually wires the handler to.
  function clickTargetFor(card) {
    return card.querySelector('a[href*="/jobs/view/"]') ||
           card.querySelector('div[role="button"]') || card;
  }

  // Is the detail pane showing THIS job? A second signal, in case the URL
  // parameter does not update.
  function detailShowsTitle(title) {
    const t = dedupeDoubled(title).toLowerCase().slice(0, 40);
    if (!t) return false;
    const list = resultsListEl();
    const heads = document.querySelectorAll('h1, h2, [class*="job-title"], [class*="top-card"] a');
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      if (list && list.contains(h)) continue;
      const ht = dedupeDoubled(h.textContent || '').toLowerCase();
      if (ht && ht.indexOf(t) === 0) return true;
    }
    return false;
  }

  // What the detail pane currently shows, recorded per job so a stale or empty
  // read is visible in Debug instead of silently becoming "not a repost".
  // Boilerplate that sits outside every container yet is not pane content.
  // Left in, it fills the probe and makes the fingerprint look identical for
  // every job, hiding whether the pane actually rendered.
  const CHROME_TEXT_RE = new RegExp('^(' + [
    'skip to main content', 'previous', 'next', 'linkedin corporation.*',
    'get job alerts.*', '\\d+ notifications?', 'notifications?', 'dismiss',
    'see more', 'see less', 'show all', 'new feed updates notifications',
    'sign in', 'join now', 'about', 'accessibility', 'privacy.*', 'cookie.*',
    // The search-feedback strip LinkedIn injects between the list and the pane.
    'are these results helpful\\??', 'your feedback helps.*', 'was this helpful\\??',
    // Premium upsell strip that also appears outside the results list.
    'see jobs where you.*top applicant', 'restart premium.*', 'try premium.*',
    'retry premium.*', 'reactivate premium.*'
  ].join('|') + ')$', 'i');

  function detailProbe() {
    const roots = excludedRoots();
    const bits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && bits.length < 20) {
      const node = walker.currentNode, parent = node.parentElement;
      if (parent && SKIP_TAGS[parent.tagName]) continue;
      if (isExcluded(node, roots)) continue;
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      // Single glyphs, bare counters and boilerplate are chrome, not content.
      if (t.length > 2 && !/^\d+$/.test(t) && !CHROME_TEXT_RE.test(t)) bits.push(t);
    }
    return bits.join(' | ').slice(0, 240);
  }

  // Fuller text of the open detail pane — the job description plus its header.
  // Same exclusion logic as detailProbe (drop cards, page chrome, our panel),
  // just a much larger cap so we keep the whole "About the job" block.
  function detailText(cap) {
    const roots = excludedRoots();
    const bits = [];
    let n = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (parent && SKIP_TAGS[parent.tagName]) continue;
      if (isExcluded(node, roots)) continue;
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2 || CHROME_TEXT_RE.test(t)) continue;
      bits.push(t);
      n += t.length;
      if (n > (cap || 6000)) break;
    }
    // Collapse the "Show more" boilerplate LinkedIn injects mid-description.
    return bits.join(' ').replace(/\s*\b(Show more|Show less|See more|See less)\b\s*/gi, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, cap || 6000);
  }

  // Does the pane currently mention this string? The company name is the most
  // reliable marker — unlike the title, LinkedIn does not decorate it.
  function paneMentions(needle, paneNow) {
    const n = String(needle || '').toLowerCase().trim().slice(0, 28);
    if (n.length < 3) return false;
    return (paneNow || detailProbe()).toLowerCase().indexOf(n) !== -1;
  }

  // Scan the whole page minus the job cards, the page chrome and our own panel.
  // What remains is effectively the detail pane, wherever LinkedIn puts it —
  // no container-selector guessing required.
  function detailSaysReposted() {
    return textSaysReposted(document.body, excludedRoots());
  }

  // Returns 'citizens only' | 'no sponsorship' | 'clearance' | null.
  // A negative always wins — the safer read for an applicant who needs sponsorship.
  // Pull a pay figure out of card/description text, e.g. "$65K/yr - $80K/yr",
  // "$120.8K/yr – $181.2K/yr", "$35/hr - $45/hr", "$150,000 a year".
  const SALARY_RE = /\$\s?\d[\d,.]*\s?[KkMm]?(?:\s?\/\s?(?:yr|year|hr|hour|mo|month|wk|week))?(?:\s*(?:-|–|—|to)\s*\$?\s?\d[\d,.]*\s?[KkMm]?(?:\s?\/\s?(?:yr|year|hr|hour|mo|month|wk|week))?)?(?:\s?(?:a|per)\s?(?:year|yr|hour|hr|month|mo))?/;
  function parseSalary(text) {
    const m = String(text || '').match(SALARY_RE);
    if (!m) return '';
    return m[0].replace(/\s*(-|–|—|to)\s*/, ' – ').replace(/\s+/g, ' ').trim();
  }

  function noSponsorSignal(job) {
    // Include the description when Deep scan captured it — that's where
    // "we are unable to sponsor" / "must be a US citizen" usually hides.
    const text = String(job.title || '') + ' · ' + String(job.raw || '') +
      ' · ' + String(job.desc || '');
    for (const [re, label] of NO_SPONSOR_PATTERNS) {
      if (re.test(text)) return label;
    }
    return null;
  }

  // 0-100. Display only — never feeds the sort order.
  function fitScore(job, now) {
    let s = SCORE.base;
    s += Math.min(matchesKeyword(job.title).length * SCORE.keyword, SCORE.keywordCap);
    if (job.sponsor) s += SCORE.sponsor;
    s += Math.max(matchesNegative(job.title).length * SCORE.negative, SCORE.negativeCap);
    if (job.staffing) s += SCORE.staffing;
    if (job.repost) s += SCORE.repost;
    if (job.noSponsor) s += SCORE.noSponsor;
    const age = ageOf(job, now);
    if (age != null) {
      for (const [limit, pts] of SCORE.recency) { if (age <= limit) { s += pts; break; } }
    }
    return Math.max(0, Math.min(100, Math.round(s)));
  }

  function scoreColor(s) {
    if (s >= 70) return { color: '#059669', bg: '#ecfdf5' };
    if (s >= 45) return { color: '#0a66c2', bg: '#eff6ff' };
    if (s >= 25) return { color: '#b45309', bg: '#fffbeb' };
    return { color: '#6b7280', bg: '#f3f4f6' };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // LinkedIn renders a title twice — a visible aria-hidden copy plus a
  // screen-reader copy — so anchor.textContent yields "Junior AI EngineerJunior
  // AI Engineer". Collapse the repeat back to a single copy.
  function dedupeDoubled(s) {
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    // LinkedIn badge text glued onto the title by the same duplication.
    // LinkedIn decorates card titles: a "Selected, " prefix for the open
    // job and a "(Verified job)" badge, both of which break de-duplication.
    t = t.replace(/\s*\(verified job\)\s*/ig, ' ')
         .replace(/^\s*selected,\s*/i, '')
         .replace(/\s+/g, ' ').trim();

    if (t.length > 3 && t.length % 2 === 0) {
      const h = t.length / 2;
      if (t.slice(0, h).trim() === t.slice(h).trim()) return t.slice(0, h).trim();
    }
    // "AbcAbc extra" — the doubled part repeated back-to-back.
    const half = t.match(/^(.{4,}?)\1(.*)$/);
    if (half) return (half[1] + half[2]).replace(/\s+/g, ' ').trim();
    // The second copy can be TRUNCATED relative to the first, e.g.
    // "Associate AI/ML Engineer (Verified job)Associate AI/ML Engineer".
    for (let i = Math.ceil(t.length / 2); i < t.length - 3; i++) {
      const tail = t.slice(i);
      if (tail.length >= 5 && t.slice(0, i).indexOf(tail) === 0) return t.slice(0, i).trim();
    }
    return t;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SORTING — newest first, EXCEPT reposts, which are always pushed to the end.
  // A repost's date describes the re-listing, not the vacancy, so it would
  // otherwise jump the queue over genuinely fresh postings.
  // ─────────────────────────────────────────────────────────────────────────
  function sortJobs(jobs) {
    jobs.sort((a, b) => {
      // 1. reposts last, whatever their date says
      const ra = a.repost ? 1 : 0, rb = b.repost ? 1 : 0;
      if (ra !== rb) return ra - rb;
      // 2. then newest first, unknown dates after the dated ones
      const A = a.postedAt, B = b.postedAt;
      if (A == null && B == null) return String(a.title || '').localeCompare(String(b.title || ''));
      if (A == null) return 1;
      if (B == null) return -1;
      if (B !== A) return B - A;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
    return jobs;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STORAGE
  // ─────────────────────────────────────────────────────────────────────────
  function uidOf(j) {
    return j.jobId ? 'id:' + j.jobId
      : 'tc:' + String(j.title || '').toLowerCase() + '|' + String(j.company || '').toLowerCase();
  }

  function readSet(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || '[]');
      return new Set(Array.isArray(v) ? v : []);
    } catch (e) { return new Set(); }
  }

  function writeSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify(Array.from(set))); }
    catch (e) { console.warn('[LJS] could not save ' + key, e); }
  }

  const DEFAULT_OPTS = {
    hideSeen: false, hideApplied: false, hideNegative: false,
    hideStaffing: false, hideNoSponsor: false,
    tab: 'fresh'            // 'fresh' | 'reposted' — two separate lists
  };

  function loadOpts() {
    try { return Object.assign({}, DEFAULT_OPTS, JSON.parse(localStorage.getItem(OPTS_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULT_OPTS); }
  }
  function saveOpts(o) {
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(o)); } catch (e) {}
  }

  // Older builds stored `timeSeconds` (an age frozen at scrape time), and
  // JSON.stringify turned Infinity into null. Rebuild an absolute postedAt.
  function migrate(j) {
    if (!j || typeof j !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(j, 'postedAt')) {
      const base = Date.parse(j.scrapedAt);
      const anchor = isFinite(base) ? base : Date.now();
      if (typeof j.timeSeconds === 'number' && isFinite(j.timeSeconds)) {
        j.postedAt = anchor - j.timeSeconds * 1000;
      } else {
        j.postedAt = parsePostedAt(j.timeText, anchor);
      }
      delete j.timeSeconds;
    }
    // Fields added after the first release — recompute rather than lose them.
    // Always recompute: the sponsor list grows, so previously-unmatched rows
    // must get a second chance rather than staying stale forever.
    const sp = sponsorInfo(j.company);
    j.sponsor = sp !== null;
    j.sponsorCount = sp ? sp.count : 0;
    // Repair titles saved before the de-duplication fix ("Data AnalystData
    // Analyst"), so existing rows clean themselves up without a rescan.
    const fixedTitle = dedupeDoubled(j.title);
    if (fixedTitle && fixedTitle !== j.title) {
      // The doubled copy often leaked into company as well.
      if (String(j.company || '').trim() === fixedTitle) j.company = '';
      j.title = fixedTitle;
    }

    // Always recompute these too. Storing them once meant a row saved as
    // repost:false could never be corrected when detection improved — which is
    // exactly how a repost ended up sitting in the Fresh tab.
    j.staffing = isAgencyJob(j);
    j.repost = isRepost(j);
    j.noSponsor = noSponsorSignal(j);
    if (j.salary === undefined) j.salary = parseSalary((j.raw || '') + ' ' + (j.desc || ''));
    return j;
  }

  function loadJobs() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return sortJobs(dedupeList(raw.map(migrate).filter(Boolean)));
    } catch (e) { return []; }
  }

  function saveJobs(jobs) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(jobs)); }
    catch (e) { console.warn('[LJS] could not save jobs:', e); }
  }

  // Which tab a job belongs to. One job → one tab, by priority:
  // visa blocker → agency/recruiter → repost → fresh (direct-employer & new).
  function catOf(j) {
    return j.noSponsor ? 'blocked' : (j.staffing ? 'agency' : (j.repost ? 'reposted' : 'fresh'));
  }

  function idKey(j) { return j.jobId ? 'id:' + j.jobId : null; }
  // Normalised so invisible differences — dash type, double spaces, an
  // "(Verified job)" leftover — don't split one role into two rows.
  function normId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  // Include location so the SAME title at the same company in two different
  // cities stays two roles, while a true duplicate (same city) collapses.
  function textKey(j) { return 'tc:' + normId(j.title) + '|' + normId(j.company) + '|' + normId(j.location); }

  // Collapse rows that are the same posting (same normalised title+company),
  // keeping the richest data. Repairs duplicates already saved by older builds
  // and any that a scan produced when one copy came back unconfirmed.
  function dedupeList(jobs) {
    const byKey = new Map();
    const out = [];
    jobs.forEach(j => {
      const k = textKey(j);
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, j); out.push(j); return; }
      // Merge j into prev, preferring present/confirmed values.
      if (!prev.jobId && j.jobId) { prev.jobId = j.jobId; prev.link = j.link; }
      if (!prev.desc && j.desc) prev.desc = j.desc;
      if ((!prev.raw || prev.raw.length < (j.raw || '').length)) prev.raw = j.raw || prev.raw;
      if (!prev.timeText && j.timeText) prev.timeText = j.timeText;
      if (!prev.location && j.location) prev.location = j.location;
      if (prev.postedAt == null && j.postedAt != null) prev.postedAt = j.postedAt;
      if (j.repostDetail) prev.repostDetail = true;
      // Re-derive everything from the merged fields.
      const sp = sponsorInfo(prev.company);
      prev.sponsor = sp !== null; prev.sponsorCount = sp ? sp.count : 0;
      prev.staffing = isAgencyJob(prev);
      prev.repost = isRepost(prev);
      prev.noSponsor = noSponsorSignal(prev);
      prev.salary = parseSalary((prev.raw || '') + ' ' + (prev.desc || ''));
    });
    return out;
  }

  function mergeJobs(existing, newJobs) {
    // Indexed both ways: a row first stored without a link must be recognised
    // again once a later scan resolves its id, instead of being duplicated.
    const byId = new Map(), byText = new Map();
    existing.forEach(j => {
      const k = idKey(j);
      if (k) byId.set(k, j);
      byText.set(textKey(j), j);
    });

    let added = 0;
    newJobs.forEach(j => {
      const prev = (idKey(j) && byId.get(idKey(j))) || byText.get(textKey(j));
      if (!prev) {
        if (idKey(j)) byId.set(idKey(j), j);
        byText.set(textKey(j), j);
        existing.push(j);
        added++;
        return;
      }
      // Refresh the fields that come straight off the DOM. Without this a row
      // keeps whatever text the FIRST scan captured, so a rescan could never
      // correct a misread — which made every scraping fix look like a no-op.
      if (j.title) prev.title = j.title;
      if (j.raw) prev.raw = j.raw;
      if (j.timeText) prev.timeText = j.timeText;
      // A Deep scan's finding is authoritative and must survive later quick scans.
      if (j.repostDetail) prev.repostDetail = true;
      // Keep the captured description; a later quick scan (no desc) must not wipe it.
      if (j.desc) prev.desc = j.desc;
      if (j.detailProbe) prev.detailProbe = j.detailProbe;
      if (j.company) prev.company = j.company;
      if (j.location) prev.location = j.location;
      if (prev.postedAt == null && j.postedAt != null) prev.postedAt = j.postedAt;
      if (!prev.jobId && j.jobId) {
        prev.jobId = j.jobId;
        prev.link = j.link;
        byId.set(idKey(prev), prev);
      }
      // Re-derive everything that depends on the text we just refreshed.
      const sp = sponsorInfo(prev.company);
      prev.sponsor = sp !== null;
      prev.sponsorCount = sp ? sp.count : 0;
      prev.staffing = isAgencyJob(prev);
      prev.repost = isRepost(prev);
      prev.noSponsor = noSponsorSignal(prev);
      prev.salary = parseSalary((prev.raw || '') + ' ' + (prev.desc || ''));
    });
    sortJobs(existing);
    return added;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CSV EXPORT
  // ─────────────────────────────────────────────────────────────────────────
  function exportCSV(jobs) {
    const now = Date.now();
    const seen = readSet(SEEN_KEY), applied = readSet(APPLIED_KEY);
    const header = 'Title,Company,Location,Salary,Posted,Age,Score,Sponsor,Blocker,Repost,Agency,Seen,Applied,Link\n';
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = sortJobs(jobs).map(j => {
      const uid = uidOf(j);
      return [j.title, j.company, j.location, j.salary || '', j.timeText, fmtTime(ageOf(j, now)),
        fitScore(j, now), j.sponsor ? 'yes' : '', j.noSponsor || '', j.repost ? 'yes' : '',
        j.staffing ? 'yes' : '', seen.has(uid) ? 'yes' : '', applied.has(uid) ? 'yes' : '',
        j.link].map(q).join(',');
    }).join('\n');
    const blob = new Blob(['﻿' + header + rows], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'linkedin_jobs_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCRAPING
  // ─────────────────────────────────────────────────────────────────────────
  function mainEl() { return document.querySelector('[componentkey="SearchResultsMainContent"]'); }

  function currentJobId() {
    try { return new URL(window.location.href).searchParams.get('currentJobId'); }
    catch (e) { return null; }
  }

  function idsInside(el) {
    const ids = new Set();
    el.querySelectorAll('a[href*="/jobs/view/"]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(JOB_HREF_RE);
      if (m) ids.add(m[1]);
    });
    return ids;
  }

  // The anchor that BOTH names the job and links to it. One node for both means
  // the row's text and its link can never describe two different jobs.
  function anchorLabel(a) {
    const vis = a.querySelector('[aria-hidden="true"]');
    if (vis) {
      const t = (vis.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return dedupeDoubled(t);
    }
    const sr = a.querySelector('.visually-hidden, .sr-only');
    if (sr) {
      const t = (sr.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return dedupeDoubled(t);
    }
    return dedupeDoubled(a.textContent || '');
  }

  function titleAnchor(el) {
    const anchors = el.querySelectorAll('a[href*="/jobs/view/"]');
    for (let i = 0; i < anchors.length; i++) {
      const m = (anchors[i].getAttribute('href') || '').match(JOB_HREF_RE);
      if (!m) continue;
      let label = anchorLabel(anchors[i]);
      if (!label) label = dedupeDoubled(anchors[i].getAttribute('aria-label') || '');
      return { id: m[1], title: label };
    }
    return null;
  }

  function ownJobId(el) {
    const holder = el.closest('[data-job-id],[data-occludable-job-id]');
    if (!holder) return null;
    const attr = holder.getAttribute('data-job-id') || holder.getAttribute('data-occludable-job-id');
    return attr && /^\d+$/.test(attr) ? attr : null;
  }

  function jobCards(main) {
    let list = Array.prototype.slice.call(
      main.querySelectorAll('[data-occludable-job-id],[data-job-id]'));
    if (list.length === 0) {
      list = Array.prototype.slice.call(main.querySelectorAll('div[role="button"]'));
    }
    return list.filter(el => !list.some(other => other !== el && el.contains(other)));
  }

  // LinkedIn's own hooks for the company name. Positional text-scraping guesses
  // wrong whenever a card carries an extra line ("Promoted", "Easy Apply", a
  // connection blurb), and a wrong company means NO sponsor or agency match.
  const COMPANY_SELECTORS = [
    '[class*="job-card-container__primary-description"]',
    '[class*="job-card-container__company-name"]',
    '[class*="job-card-list__company-name"]',
    '[class*="job-card-square__subtitle"]',
    '.artdeco-entity-lockup__subtitle',
    '[data-test*="company-name"]',
    'a[href*="/company/"]'
  ];

  function companyFromDom(card) {
    for (const sel of COMPANY_SELECTORS) {
      let el;
      try { el = card.querySelector(sel); } catch (e) { continue; }
      if (!el) continue;
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (t && !isTimeText(t) && !NOISE_RE.test(t)) return t;
    }
    return '';
  }

  // "Stripe · New York, NY" -> "Stripe"
  function cleanCompany(s) {
    return String(s || '').split('·')[0].split('  ')[0].trim();
  }

  // The clickable element is often NOT the whole row: LinkedIn puts the footer
  // line ("Reposted", "Easy Apply", the date) as a SIBLING of it. Widen to the
  // enclosing row so that text is in scope — but never into a container holding
  // more than one job, or every row would inherit its neighbours' labels.
  // Climbs while the ancestor still describes ONE job. Relying on closest('li')
  // was too fragile — LinkedIn's newer markup does not always use list items.
  function scanRootFor(card) {
    let best = card, el = card;
    for (let i = 0; i < 5; i++) {
      const parent = el.parentElement;
      if (!parent || parent === document.body || parent.tagName === 'HTML') break;
      // Stop before swallowing a second job, or the row inherits its neighbour's
      // "Reposted"/sponsor text.
      if (idsInside(parent).size > 1) break;
      if (parent.querySelectorAll('[data-occludable-job-id],[data-job-id]').length > 1) break;
      if (parent.querySelectorAll('div[role="button"]').length > 1 &&
          idsInside(parent).size === 0) break;
      el = parent;
      best = parent;
    }
    return best;
  }

  function readCard(card, preferredTitle) {
    const scope = scanRootFor(card);

    const texts = [];
    card.querySelectorAll('p, span, h3, strong, time').forEach(el => {
      if (el.getAttribute('aria-hidden') === 'true') return;
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (t && texts.indexOf(t) === -1) texts.push(t);
    });

    // Every text node, each kept as its own fragment. textContent would glue
    // neighbours together — "CA" + "Reposted 2 hours ago" becomes "CAReposted",
    // which kills the \b in every pattern that scans this text.
    const parts = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode.textContent.replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }

    let timeText = '';
    for (const t of texts) { if (isTimeText(t)) { timeText = t; break; } }
    // Fallback for dates living in tags the selector above does not collect.
    if (!timeText) { for (const t of parts) { if (isTimeText(t)) { timeText = t; break; } } }

    let title = (preferredTitle || '').trim();
    if (!title) {
      for (const t of texts) {
        if (t.length > 5 && !isTimeText(t) && !NOISE_RE.test(t)) { title = t; break; }
      }
    }

    // Also drop anything already contained in the title — otherwise LinkedIn's
    // screen-reader copy of the title gets picked up as the company name.
    const titleLc = title.toLowerCase();
    const rest = texts.filter(t => {
      if (t === title || t === timeText) return false;
      if (isTimeText(t) || NOISE_RE.test(t)) return false;
      const lc = t.toLowerCase();
      if (titleLc && (lc === titleLc || titleLc.indexOf(lc) !== -1)) return false;
      return true;
    });

    // Prefer LinkedIn's labelled company element; fall back to positional text.
    const domCompany = cleanCompany(companyFromDom(card));
    const company = domCompany || cleanCompany(rest[0] || '');
    const location = (domCompany && rest[0] && cleanCompany(rest[0]) !== domCompany)
      ? (rest[1] || rest[0]) : (rest[1] || '');

    // `raw` is scanned for "Reposted" and work-authorisation wording, so it must
    // see the WHOLE card — LinkedIn hides plenty of visible text behind
    // aria-hidden="true" (with an sr-only twin), puts dates in <time>/<div>,
    // and sometimes states the fact only in an aria-label.
    scope.querySelectorAll('[aria-label]').forEach(el => {
      const a = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (a) parts.push(a);
    });
    const sa = (scope.getAttribute && scope.getAttribute('aria-label') || '').trim();
    if (sa) parts.push(sa);
    const raw = parts.join(' · ').slice(0, 2000);

    return { title, timeText: cleanTimeText(timeText), company, location, raw };
  }

  // LinkedIn renders results lazily; without this a scan only sees what has
  // scrolled into view.
  function loadAllCards(main, done) {
    const first = jobCards(main)[0];
    let scroller = null;
    for (let el = first; el && el !== document.body; el = el.parentElement) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 40) {
        scroller = el; break;
      }
    }
    let last = -1, stable = 0, rounds = 0;
    (function pump() {
      const count = jobCards(main).length;
      if (count === last) stable++; else stable = 0;
      last = count;
      // A page mid-load briefly holds one or two cards, and "stable" would fire
      // on that — which is how a deep scan ended up reading a single job.
      // Keep waiting for a plausible page unless we have genuinely waited.
      const enough = count >= 5 || rounds > 12;
      if ((stable >= 2 && enough) || rounds++ > 30) {
        if (scroller) scroller.scrollTop = 0; else window.scrollTo(0, 0);
        setTimeout(done, 200);
        return;
      }
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);
      setTimeout(pump, 400);
    })();
  }

  function scrapeAndCollect(callback, deep) {
    const main = mainEl();
    if (!main) { callback([]); return; }

    loadAllCards(main, () => {
      const cards = jobCards(main);
      const jobs = [];
      const usedIds = new Set();
      let deepMisses = 0, deepUnconfirmed = 0, deepDone = 0;
      let idx = 0;

      showProgress(0, cards.length);

      function step() {
        if (idx >= cards.length) { callback(jobs, deepMisses, deepUnconfirmed, deepDone); return; }

        function advance() { idx++; showProgress(idx, cards.length); step(); }

        const card = cards[idx];
        const anchor = titleAnchor(card);
        const attrId = ownJobId(card);

        // A candidate linking to several different jobs is a wrapper, not a card.
        if (idsInside(card).size > 1 && !attrId) { advance(); return; }

        const info = readCard(card, anchor && anchor.title);

        const junkWords = ['privacy', 'terms', 'business services', 'about', 'accessibility',
          'sign out', 'settings', 'help center'];
        const bad = !info.title || info.title.length < 5 ||
          junkWords.some(jw => info.title.toLowerCase().includes(jw));
        if (bad) { advance(); return; }

        const record = (id, repostFromDetail, probe, desc) => {
          // An id may back exactly one row. A repeat means the pairing slipped.
          if (id && usedIds.has(id)) id = null;
          if (id) usedIds.add(id);
          const job = {
            repostDetail: !!repostFromDetail,
            detailProbe: probe || '',
            desc: desc || '',
            title: info.title,
            company: info.company,
            location: info.location,
            timeText: info.timeText,
            raw: info.raw,
            postedAt: parsePostedAt(info.timeText, Date.now()),
            jobId: id || null,
            link: id ? 'https://www.linkedin.com/jobs/view/' + id + '/' : '',
            scrapedAt: new Date().toISOString()
          };
          const sp = sponsorInfo(job.company);
          job.sponsor = sp !== null;
          job.sponsorCount = sp ? sp.count : 0;
          job.staffing = isAgencyJob(job);
          job.repost = isRepost(job);
          job.noSponsor = noSponsorSignal(job);
          job.salary = parseSalary(job.raw + ' ' + (job.desc || ''));
          jobs.push(job);
          advance();
        };

        const direct = (anchor && anchor.id) || attrId;
        if (direct && !deep) { record(direct); return; }

        // Deep scan: open every job so the detail panel can be read, since that
        // is the only place LinkedIn states a posting was reposted.
        const before = currentJobId();
        if (deep && direct && direct === before) {
          setTimeout(() => record(direct, detailSaysReposted(), detailProbe(), detailText(6000)), 250);
          return;
        }

        // Fingerprint the pane BEFORE clicking; when it changes, this job's
        // panel has rendered. Far more robust than matching the title text,
        // which LinkedIn decorates ("Selected, ", "(Verified job)").
        const paneBefore = deep ? detailProbe() : '';
        realClick(deep ? clickTargetFor(card) : card);
        const started = Date.now();
        (function waitForId() {
          const id = currentJobId();
          // Either the URL caught up, or the pane is visibly showing this job.
          const urlOk = direct ? (id === direct) : (id && id !== before);
          let arrived;
          if (deep) {
            // The URL alone is not enough — LinkedIn changes it before the pane
            // re-renders, so reading then returns the PREVIOUS job's panel.
            // Accept any of: the pane text changed, it shows this title, or the
            // URL matched and enough time has passed (a safety net, so a fussy
            // pane can never take the whole scan down to zero again).
            const paneNow = detailProbe();
            // ONLY accept when the pane names THIS job. Weaker signals were
            // both wrong: "the pane changed" fires on a "Loading…" placeholder,
            // and a URL-plus-delay fallback reads whatever is on screen — which
            // is how one job inherited the previous job's "Reposted" line.
            arrived = paneMentions(info.company, paneNow) ||
                      paneMentions(dedupeDoubled(info.title), paneNow) ||
                      detailShowsTitle(info.title);
          } else {
            arrived = urlOk;
          }
          if (arrived) {
            if (deep) {
              // Retry the confirm read a few times — the pane often shows the
              // "Are these results helpful?" strip for a beat before the job
              // content lands. Only trust the pane's repost when confirmed;
              // otherwise a stale/empty pane would assign a wrong verdict.
              let tries = 0;
              const tryConfirm = () => {
                const finalPane = detailProbe();
                const confirmed = paneMentions(info.company, finalPane) ||
                                  paneMentions(dedupeDoubled(info.title), finalPane);
                if (confirmed || tries >= 3) {
                  if (!confirmed) deepUnconfirmed++;
                  deepDone++;
                  record(id || direct,
                         confirmed ? detailSaysReposted() : null,
                         (confirmed ? '' : 'UNCONFIRMED: ') + finalPane,
                         confirmed ? detailText(6000) : '');
                  return;
                }
                tries++;
                setTimeout(tryConfirm, 450);
              };
              setTimeout(tryConfirm, 300);
            } else record(id);
            return;
          }
          if (Date.now() - started > (deep ? DEEP_TIMEOUT : LINK_TIMEOUT)) {
            // The pane never confirmed this job, so its repost state is unknown
            // rather than false — recorded as such, and counted for the summary.
            // Timed out without the pane ever naming this job. Record it as
            // UNKNOWN rather than guessing 'not a repost' from a panel that
            // may still be loading, or showing the previous job.
            if (deep) { deepUnconfirmed++; record(direct, null, 'UNCONFIRMED: ' + detailProbe()); }
            // Never fall back to whatever id happens to sit in the URL — that is
            // how a row ends up opening the previous job.
            else record(null);
            return;
          }
          setTimeout(waitForId, 100);
        })();
      }

      setTimeout(step, CLICK_DELAY);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PAGINATION
  // ─────────────────────────────────────────────────────────────────────────
  function nextPageButton() {
    const sels = [
      'button[aria-label="View next page"]',
      'button[aria-label="Next"]',
      'a[aria-label="Next"]',
      '.jobs-search-pagination__button--next',
      'button.artdeco-pagination__button--next'
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
          el.offsetParent !== null) return el;
    }
    return null;
  }

  function pageSignature() {
    const main = mainEl();
    if (!main) return '';
    return jobCards(main).slice(0, 5)
      .map(c => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)).join('||');
  }

  function goToNextPage(cb) {
    const btn = nextPageButton();
    if (!btn) { cb(false); return; }
    const before = pageSignature();
    btn.click();
    const started = Date.now();
    (function poll() {
      const sig = pageSignature();
      if (sig && sig !== before) { setTimeout(() => cb(true), 600); return; }
      if (Date.now() - started > PAGE_TIMEOUT) { cb(false); return; }
      setTimeout(poll, 300);
    })();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI
  // ─────────────────────────────────────────────────────────────────────────

  // Null-safe event binding — a missing button never throws.
  function on(id, evt, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  }

  // Briefly flash a label on a button, then restore it.
  function flash(id, msg, restore) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    setTimeout(() => { el.textContent = restore; }, 1400);
  }

  // ── SELF-TEST ─────────────────────────────────────────────────────────────
  // Runs the core invariants against the live code, right in the panel, so the
  // sorting / repost / sponsor logic can be verified without any tooling.
  function runSelfTest() {
    const NOW = Date.now(), H = 3600e3, D = 86400e3, M = 60e3;
    const r = [];
    const t = (group, name, pass) => r.push({ group, name, pass: !!pass });
    const near = (a, b, tol) => Math.abs(a - b) <= tol;

    // Time parsing → absolute posted-at.
    const age = txt => { const p = parsePostedAt(txt, NOW); return p == null ? null : (NOW - p) / H; };
    t('Dates', '"3 days ago" ≈ 72h', near(age('3 days ago'), 72, 1));
    t('Dates', '"Posted 6 hours ago" ≈ 6h', near(age('Posted 6 hours ago'), 6, 0.5));
    t('Dates', '"Reposted 2 weeks ago" ≈ 336h', near(age('Reposted 2 weeks ago'), 336, 1));
    t('Dates', 'unknown text → no date', age('Be an early applicant') === null);
    t('Dates', '"Posted 1 hour ago1 hour ago" de-duped', cleanTimeText('Posted 1 hour ago1 hour ago') === 'Posted 1 hour ago');

    // Sorting: newest first, reposts sink.
    const jobs = [
      { title: 'old fresh', postedAt: NOW - 3 * D, repost: false },
      { title: 'new fresh', postedAt: NOW - 10 * M, repost: false },
      { title: 'fresh repost', postedAt: NOW - 1 * M, repost: true }
    ];
    sortJobs(jobs);
    t('Sorting', 'newest fresh job is first', jobs[0].title === 'new fresh');
    t('Sorting', 'a 1-min-old repost sinks to the bottom', jobs[2].title === 'fresh repost');

    // Repost detection.
    t('Reposts', '"Reposted 5 minutes ago" flagged', isRepost({ timeText: 'Reposted 5 minutes ago', raw: '' }) === true);
    t('Reposts', '"2 hours ago" not flagged', isRepost({ timeText: '2 hours ago', raw: '' }) === false);
    t('Reposts', 'detail-pane signal honoured', isRepost({ repostDetail: true }) === true);

    // Sponsor matching (against the bundled H-1B data).
    t('Sponsors', 'Amazon recognised', isKnownSponsor('Amazon'));
    t('Sponsors', 'Stripe recognised', isKnownSponsor('Stripe'));
    t('Sponsors', 'AMD recognised (alias)', isKnownSponsor('AMD'));
    t('Sponsors', 'unknown firm not badged', isKnownSponsor('Definitely Not A Real Company') === false);
    t('Sponsors', 'generic "Bank" not badged', isKnownSponsor('Bank') === false);

    // Agencies & seniority filters.
    t('Filters', 'Diverse Lynx is an agency', isStaffing('Diverse Lynx') === true);
    t('Filters', '"Haystack" not an agency', isStaffing('Haystack AI') === false);
    t('Filters', '"Senior ML Engineer" flagged senior', matchesNegative('Senior ML Engineer').length > 0);
    t('Filters', '"ML Engineer, New Grad" is clean', matchesNegative('Machine Learning Engineer, New Grad').length === 0);

    // Titles & score.
    t('Display', '"Data ScientistData Scientist" de-doubled', dedupeDoubled('Data ScientistData Scientist') === 'Data Scientist');
    const sc = fitScore({ title: 'Machine Learning Engineer, New Grad', company: 'Stripe', postedAt: NOW - 20 * M, sponsor: true }, NOW);
    t('Display', 'fit score within 0–100', sc >= 0 && sc <= 100);

    return r;
  }

  function renderSelfTest() {
    const list = document.getElementById('ljs-list');
    if (!list) return;
    let results;
    try { results = runSelfTest(); }
    catch (e) { results = [{ group: 'Error', name: String(e && e.message || e), pass: false }]; }

    const passed = results.filter(x => x.pass).length;
    const failed = results.length - passed;
    let ver = '';
    try { ver = ' · v' + chrome.runtime.getManifest().version; } catch (e) {}

    let html = '<div id="ljs-selftest-report">';
    html += '<div class="ljs-st-head">🧪 Self-test' +
      '<span class="ljs-st-pill ' + (failed ? 'bad' : 'ok') + '">' +
      passed + '/' + results.length + ' passed</span></div>';
    html += '<div style="padding:0 10px 8px;font-size:11px;color:#94a3b8;">' +
      (failed ? failed + ' check(s) failed — tell Claude which.' :
       'All core logic verified' + esc(ver) + '.') +
      ' Click a tab to return to jobs.</div>';

    let lastGroup = '';
    results.forEach(x => {
      if (x.group !== lastGroup) { html += '<div class="ljs-st-group">' + esc(x.group) + '</div>'; lastGroup = x.group; }
      html += '<div class="ljs-st-row ' + (x.pass ? 'pass' : 'fail') + '">' +
        '<span class="ljs-st-mark">' + (x.pass ? '✓' : '✕') + '</span>' +
        '<span>' + esc(x.name) + '</span></div>';
    });
    html += '</div>';
    list.innerHTML = html;

    const btn = document.getElementById('ljs-selftest');
    if (btn) flash('ljs-selftest', failed ? '✕ ' + failed + ' failed' : '✓ all passed', '🧪 Self-test');
  }

  // A friendly, in-panel feature list — the "what can this do?" view.
  function renderFeatures() {
    const list = document.getElementById('ljs-list');
    if (!list) return;
    let ver = '';
    try { ver = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
    const groups = [
      ['Sorting', [
        ['🕑', '<b>Newest first, always.</b> The number badge is a fit score, not the sort order.'],
        ['🔁', '<b>Reposts get their own tab</b> so recycled listings never clog the fresh ones.'],
        ['📄', '<b>Scan every page</b> with one click (up to 5).']
      ]],
      ['Sponsors & visa', [
        ['🟢', '<b>H-1B sponsor badge</b> with the employer’s FY2025 approval count.'],
        ['🚫', '<b>Citizens-only / clearance flags</b> — Deep scan reads the full description to catch “cannot sponsor” even when it’s not on the card.'],
        ['🏢', '<b>Agencies get their own tab</b> — staffing / recruiting firms are pulled out so Fresh shows direct employers only.']
      ]],
      ['Read without leaving', [
        ['📄', '<b>Read the job description</b> right in the panel — tap 📄 on any job Deep scan has opened.']
      ]],
      ['Your workflow', [
        ['✓', '<b>Seen & applied tracking</b> — mark jobs and hide what you’ve done.'],
        ['🎯', '<b>Keyword highlights</b> for ML / AI / new-grad roles; hide senior roles.'],
        ['🔗', '<b>Copy links or export CSV</b> to drop into your tracker.']
      ]],
      ['Trust it', [
        ['🧪', '<b>Self-test</b> checks the logic live, in the panel.'],
        ['⌨️', '<b>Alt+J</b> hides / shows this panel anytime.']
      ]]
    ];
    let html = '<div id="ljs-features">';
    html += '<div class="ljs-feat-hero"><div class="e">◆</div>' +
      '<div class="t">Job Sorter ' + esc(ver) + '</div>' +
      '<div class="s">your job-hunting co-pilot</div></div>';
    groups.forEach(g => {
      html += '<div class="ljs-feat-group">' + esc(g[0]) + '</div>';
      g[1].forEach(f => {
        html += '<div class="ljs-feat"><span class="fe">' + f[0] + '</span><span>' + f[1] + '</span></div>';
      });
    });
    html += '<div class="ljs-feat-group">&nbsp;</div>' +
      '<div style="text-align:center;padding:2px 12px 6px;font-size:11px;font-weight:700;color:#b4afc0;">' +
      'Click a tab above to return to your jobs</div>';
    html += '</div>';
    list.innerHTML = html;
  }

  // In-panel reading view for a single job's captured description.
  function renderJobDescription(job) {
    const list = document.getElementById('ljs-list');
    if (!list) return;
    const now = Date.now();
    const kw = matchesKeyword(job.title);
    const linked = job.link && /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/.test(job.link);
    let html = '<div id="ljs-desc-view">';
    html += '<button class="ljs-desc-back" id="ljs-desc-back">← Back to jobs</button>';
    html += '<div class="ljs-desc-title">' + esc(job.title) + '</div>';
    html += '<div class="ljs-desc-company">' + esc(job.company) +
      (job.location ? ' · 📍 ' + esc(job.location) : '') +
      (job.salary ? ' · 💰 ' + esc(job.salary) : '') + '</div>';
    html += '<div class="ljs-desc-tags">';
    if (job.sponsor) html += '<span class="ljs-sponsor-tag">🟢 sponsor' + (job.sponsorCount ? ' ' + job.sponsorCount : '') + '</span>';
    if (job.noSponsor) html += '<span class="ljs-nosponsor-tag">🚫 ' + esc(job.noSponsor) + '</span>';
    if (job.staffing) html += '<span class="ljs-agency-tag">agency</span>';
    if (job.repost) html += '<span class="ljs-repost-tag">repost</span>';
    html += '<span class="ljs-time-badge" style="background:#eef1f5;color:#667085;">' + esc(fmtTime(ageOf(job, now))) + '</span>';
    html += '</div>';
    if (linked) html += '<a class="ljs-desc-open" href="' + esc(job.link) + '" target="_blank" rel="noopener noreferrer">Open on LinkedIn ↗</a>';
    html += '<div class="ljs-desc-body">' + esc(job.desc || '(no description captured)') + '</div>';
    html += '<div class="ljs-desc-foot">Captured during Deep scan — may be shortened where LinkedIn hides text behind “Show more”.</div>';
    html += '</div>';
    list.innerHTML = html;
    const back = document.getElementById('ljs-desc-back');
    if (back) back.onclick = () => renderJobs(loadJobs(), currentFilter());
  }

  function buildPanel() {
    const old = document.getElementById('ljs-panel');
    if (old) old.remove();
    const oldToggle = document.getElementById('ljs-toggle');
    if (oldToggle) oldToggle.remove();

    const toggle = document.createElement('button');
    toggle.id = 'ljs-toggle';
    toggle.textContent = '⚡ Jobs';
    toggle.onclick = () => {
      const panel = document.getElementById('ljs-panel');
      if (panel) panel.classList.toggle('ljs-collapsed');
    };
    document.body.appendChild(toggle);

    const panel = document.createElement('div');
    panel.id = 'ljs-panel';
    panel.innerHTML = `
      <div id="ljs-panel-inner">
        <div id="ljs-header">
          <div id="ljs-header-row">
            <div id="ljs-title"><span class="ljs-spark">◆</span> Job Sorter</div>
            <div class="ljs-headbtns">
              <button id="ljs-filters-toggle" title="Filters">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
                <span class="ljs-fdot" hidden></span>
              </button>
              <button id="ljs-menu-toggle" title="More actions">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
              </button>
              <button id="ljs-close" title="Hide panel (Alt+J to reopen)">✕</button>
            </div>
          </div>
          <div id="ljs-searchrow">
            <input id="ljs-filter" placeholder="Search title, company, location…" />
            <button id="ljs-start" class="ljs-primary">Scan</button>
            <button id="ljs-deep" class="ljs-secondary" title="Opens each job to read its detail panel — the only place LinkedIn shows 'Reposted'. Slower.">🔁 Deep</button>
          </div>
          <div id="ljs-drawer" class="ljs-hidden">
            <div class="ljs-drawer-label">Hide from the list</div>
            <div id="ljs-chips">
              <button class="ljs-chip" data-opt="hideSeen">Seen</button>
              <button class="ljs-chip" data-opt="hideApplied">Applied</button>
              <button class="ljs-chip" data-opt="hideNegative">Senior roles</button>
            </div>
          </div>
          <div id="ljs-stats"></div>
        </div>

        <div id="ljs-menu" class="ljs-hidden">
          <button class="ljs-menu-item" id="ljs-refresh">↻ Rescan this page</button>
          <button class="ljs-menu-item" id="ljs-scan-all">▶▶ Scan all pages</button>
          <button class="ljs-menu-item" id="ljs-mark-seen">✓ Mark everything seen</button>
          <div class="ljs-menu-sep"></div>
          <button class="ljs-menu-item" id="ljs-export-csv">📥 Export CSV</button>
          <button class="ljs-menu-item" id="ljs-copy-links">🔗 Copy links (this tab)</button>
          <div class="ljs-menu-sep"></div>
          <button class="ljs-menu-item" id="ljs-info">✨ Features</button>
          <button class="ljs-menu-item" id="ljs-selftest">🧪 Self-test</button>
          <button class="ljs-menu-item" id="ljs-copy-unmatched">🔍 Debug report</button>
          <div class="ljs-menu-sep"></div>
          <button class="ljs-menu-item ljs-menu-danger" id="ljs-reset">🗑 Reset collected jobs</button>
        </div>

        <div id="ljs-tabs">
          <button class="ljs-tab" data-tab="fresh">Fresh</button>
          <button class="ljs-tab" data-tab="reposted">Reposted</button>
          <button class="ljs-tab" data-tab="agency">Agencies</button>
          <button class="ljs-tab" data-tab="blocked">No sponsor</button>
        </div>
        <div id="ljs-list">
          <div id="ljs-ready">
            <div class="ljs-ready-emoji">◆</div>
            <div class="ljs-ready-title">Ready when you are</div>
            <div class="ljs-ready-sub">Set your LinkedIn filters, then hit <b>Scan</b>. Sorted newest first — the number badge is a fit score, not the order.</div>
            <div class="ljs-ready-hint">Tip: <b>🔁 Deep</b> opens each job to catch reposts · <b>Alt+J</b> toggles this panel</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('ljs-close').onclick = () => panel.classList.add('ljs-collapsed');

    // Filter drawer (⚙) — slides open under the search row.
    on('ljs-filters-toggle', 'click', () => {
      const d = document.getElementById('ljs-drawer');
      if (d) d.classList.toggle('ljs-hidden');
      document.getElementById('ljs-filters-toggle').classList.toggle('active', d && !d.classList.contains('ljs-hidden'));
    });

    // Overflow menu (⋯) — every secondary action lives here.
    const menu = document.getElementById('ljs-menu');
    const closeMenu = () => { if (menu) menu.classList.add('ljs-hidden'); };
    on('ljs-menu-toggle', 'click', e => {
      e.stopPropagation();
      if (menu) menu.classList.toggle('ljs-hidden');
    });
    if (menu) menu.addEventListener('click', () => setTimeout(closeMenu, 0)); // close after any pick
    document.addEventListener('click', e => {
      if (menu && !menu.classList.contains('ljs-hidden') &&
          !menu.contains(e.target) && e.target.id !== 'ljs-menu-toggle' &&
          !(e.target.closest && e.target.closest('#ljs-menu-toggle'))) closeMenu();
    });

    document.getElementById('ljs-reset').onclick = () => {
      if (!confirm('Clear all collected jobs? Seen/applied marks are kept.')) return;
      localStorage.removeItem(STORE_KEY);
      renderJobs([]);
    };
    document.getElementById('ljs-refresh').onclick = () => runScrape(false);
    document.getElementById('ljs-start').onclick = () => runScrape(false);
    document.getElementById('ljs-scan-all').onclick = () => runScrape(true);
    document.getElementById('ljs-deep').onclick = () => runScrape(false, true);
    document.getElementById('ljs-mark-seen').onclick = () => {
      const seen = readSet(SEEN_KEY);
      loadJobs().forEach(j => seen.add(uidOf(j)));
      writeSet(SEEN_KEY, seen);
      renderJobs(loadJobs(), currentFilter());
    };
    document.getElementById('ljs-filter').oninput = function () {
      renderJobs(loadJobs(), this.value);
    };
    document.getElementById('ljs-export-csv').onclick = () => exportCSV(loadJobs());
    // Diagnostic: what did the scraper actually read as the company, and which
    // of those names the sponsor list does not know. Distinguishes "the list is
    // missing employers" from "the company name was scraped wrong".
    document.getElementById('ljs-copy-unmatched').onclick = () => {
      const jobs = loadJobs();
      const out = [];

      // Section 1: exactly what the scraper saw, for the first handful of rows.
      let ver = '?';
      try { ver = chrome.runtime.getManifest().version; } catch (e) {}
      out.push('=== JOB SORTER v' + ver + ' ===');
      out.push('=== RAW CAPTURE (first 6 jobs) ===');
      jobs.slice(0, 6).forEach((j, i) => {
        out.push((i + 1) + '. title="' + j.title + '"');
        out.push('   company="' + j.company + '"  time="' + j.timeText + '"');
        out.push('   repost=' + !!j.repost + '  sponsor=' + !!j.sponsor +
                 '  agency=' + !!j.staffing + '  blocker=' + (j.noSponsor || 'none'));
        out.push('   raw=' + JSON.stringify(String(j.raw || '').slice(0, 260)));
        out.push('   paneRead=' + JSON.stringify(String(j.detailProbe || '(no deep scan)')));
      });

      // Section 2: does the word appear on the page at all, and where?
      const main = mainEl();
      const hits = [];
      if (main) {
        const w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
        while (w.nextNode() && hits.length < 6) {
          const t = w.currentNode.textContent.replace(/\s+/g, ' ').trim();
          if (t && /re-?\s?posted/i.test(t)) {
            const el = w.currentNode.parentElement;
            hits.push('   "' + t.slice(0, 80) + '"  in <' +
              (el ? el.tagName.toLowerCase() : '?') + ' class="' +
              (el && el.className ? String(el.className).slice(0, 60) : '') + '">');
          }
        }
      }
      out.push('', '=== "REPOSTED" FOUND ON PAGE: ' + hits.length + ' ===');
      out.push.apply(out, hits.length ? hits : ['   (not found inside the results container)']);

      // Where the detail pane sits relative to the results list decides whether
      // the deep scan can see it at all.
      const dbgRoots = excludedRoots();
      out.push('', '=== DETAIL PANE VISIBILITY ===');
      out.push('   last scan: ' + (lastScanNote || '(no deep scan run yet this session)'));
      const withPane = jobs.filter(function (j) {
        return j.detailProbe && j.detailProbe.indexOf('UNCONFIRMED') !== 0;
      }).length;
      out.push('   panels read: ' + withPane + ' of ' + jobs.length + ' stored jobs');
      out.push('   cards on this page right now: ' +
        (mainEl() ? jobCards(mainEl()).length : 0));
      out.push('   detailSaysReposted() right now: ' + detailSaysReposted());
      out.push('   pane probe right now: ' + JSON.stringify(detailProbe()));
      let paneHit = '(none)';
      const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (w2.nextNode()) {
        const n = w2.currentNode, p = n.parentElement;
        if (p && SKIP_TAGS[p.tagName]) continue;
        if (isExcluded(n, dbgRoots)) continue;
        if (!REPOST_RE.test(n.textContent || '')) continue;
        paneHit = '"' + n.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) + '" in <' +
          (p ? p.tagName.toLowerCase() : '?') + ' class="' +
          (p && p.className ? String(p.className).slice(0, 50) : '') + '">' +
          '  insideMain=' + !!(main && main.contains(n));
        break;
      }
      out.push('   outside the list, first match: ' + paneHit);

      // Section 3: unmatched company names.
      const counts = new Map();
      jobs.filter(j => !j.sponsor).forEach(j => {
        const c = (j.company || '').trim() || '(BLANK — company not scraped)';
        counts.set(c, (counts.get(c) || 0) + 1);
      });
      const rows = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      out.push('', '=== COMPANIES WITH NO SPONSOR MATCH ===');
      rows.forEach(([c, n]) => out.push('   ' + n + '\t' + c));
      out.push('', jobs.length + ' jobs · ' + jobs.filter(j => j.repost).length + ' flagged repost · ' +
        jobs.filter(j => j.sponsor).length + ' sponsor-matched');

      navigator.clipboard.writeText(out.join('\n')).then(() => {
        const b = document.getElementById('ljs-copy-unmatched');
        b.textContent = '✓ copied';
        setTimeout(() => b.textContent = '🔍 Debug', 2000);
      });
    };
    // Copy the links of whatever is in the current tab, honouring filters.
    on('ljs-copy-links', 'click', () => {
      const opts = loadOpts();
      const cur = { fresh: 1, reposted: 1, blocked: 1, agency: 1 }[opts.tab] ? opts.tab : 'fresh';
      const f = currentFilter().toLowerCase();
      const hay = j => (String(j.title || '') + ' ' + String(j.company || '') + ' ' +
        String(j.location || '')).toLowerCase();
      const links = loadJobs()
        .filter(j => catOf(j) === cur && (!f || hay(j).includes(f)) && j.link)
        .map(j => j.link);
      flash('ljs-copy-links', links.length ? '✓ ' + links.length : '— none', '🔗 Links');
      if (links.length) navigator.clipboard.writeText(links.join('\n')).catch(() => {});
    });

    // Built-in self-test — the in-panel version of the regression suites.
    on('ljs-selftest', 'click', () => renderSelfTest());

    // Features / about view.
    on('ljs-info', 'click', () => renderFeatures());

    // Fresh / Reposted are two separate lists, not one list with a divider.
    document.getElementById('ljs-tabs').addEventListener('click', e => {
      const tab = e.target.closest('.ljs-tab');
      if (!tab) return;
      const opts = loadOpts();
      opts.tab = tab.getAttribute('data-tab');
      saveOpts(opts);
      renderJobs(loadJobs(), currentFilter());
    });

    // Filter chips
    document.getElementById('ljs-chips').addEventListener('click', e => {
      const chip = e.target.closest('.ljs-chip');
      if (!chip) return;
      const opts = loadOpts();
      const key = chip.getAttribute('data-opt');
      opts[key] = !opts[key];
      saveOpts(opts);
      syncChips();
      renderJobs(loadJobs(), currentFilter());
    });

    // Row interactions: clicking a row marks it seen; the ✓ toggles applied.
    document.getElementById('ljs-list').addEventListener('click', e => {
      const descBtn = e.target.closest('.ljs-desc-btn');
      if (descBtn) {
        e.preventDefault();
        e.stopPropagation();
        const uid = descBtn.getAttribute('data-uid');
        const job = loadJobs().find(j => uidOf(j) === uid);
        if (job) renderJobDescription(job);
        return;
      }
      const btn = e.target.closest('.ljs-applied-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const uid = btn.getAttribute('data-uid');
        const applied = readSet(APPLIED_KEY);
        if (applied.has(uid)) applied.delete(uid); else applied.add(uid);
        writeSet(APPLIED_KEY, applied);
        renderJobs(loadJobs(), currentFilter());
        return;
      }
      const row = e.target.closest('.ljs-job');
      if (row) {
        const uid = row.getAttribute('data-uid');
        const seen = readSet(SEEN_KEY);
        if (uid && !seen.has(uid)) { seen.add(uid); writeSet(SEEN_KEY, seen); }
      }
    });

    syncChips();

    const existing = loadJobs();
    if (existing.length > 0) {
      renderJobs(existing);
      document.getElementById('ljs-stats').textContent =
        existing.length + ' jobs from previous pages · hit Scan to add this page';
    }

    // Scanning is deliberately manual — nothing runs until Rescan is clicked.
  }

  function currentFilter() {
    const el = document.getElementById('ljs-filter');
    return el ? el.value : '';
  }

  function syncChips() {
    const opts = loadOpts();
    let anyOn = false;
    document.querySelectorAll('#ljs-chips .ljs-chip').forEach(chip => {
      const active = !!opts[chip.getAttribute('data-opt')];
      chip.classList.toggle('ljs-chip-on', active);
      if (active) anyOn = true;
    });
    // Dot on the ⚙ button signals filters are hiding some jobs.
    const dot = document.querySelector('#ljs-filters-toggle .ljs-fdot');
    if (dot) dot.hidden = !anyOn;
  }

  function showProgress(current, total, note) {
    const list = document.getElementById('ljs-list');
    if (!list) return;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    list.innerHTML = `
      <div id="ljs-progress">
        ${esc(note || 'Scanning job ' + current + ' of ' + total + '...')}
        <div class="ljs-progress-bar">
          <div class="ljs-progress-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }

  function renderJobs(jobs, filter) {
    const list = document.getElementById('ljs-list');
    const stats = document.getElementById('ljs-stats');
    if (!list || !stats) return;

    const now = Date.now();
    sortJobs(jobs);   // ordering is decided here, so ages stay current

    const opts = loadOpts();
    const seen = readSet(SEEN_KEY), applied = readSet(APPLIED_KEY);
    const f = String(filter || '').toLowerCase();
    const hay = j => (String(j.title || '') + ' ' + String(j.company || '') + ' ' +
      String(j.location || '')).toLowerCase();

    // Everything except the fresh/reposted split.
    const base = jobs.filter(j => {
      const uid = uidOf(j);
      if (f && !hay(j).includes(f)) return false;
      if (opts.hideSeen && seen.has(uid)) return false;
      if (opts.hideApplied && applied.has(uid)) return false;
      if (opts.hideNegative && matchesNegative(j.title).length > 0) return false;
      // Agencies and no-sponsor roles now have their own tabs, so no chip here.
      return true;
    });

    // Each job lands in exactly one tab. Priority: a visa blocker matters most
    // (you can't apply anyway), then agencies (indirect), then repost, else fresh.
    // So "Fresh" is direct-employer, genuinely-new roles only.
    const tab = { fresh: 1, reposted: 1, blocked: 1, agency: 1 }[opts.tab] ? opts.tab : 'fresh';
    const counts = { fresh: 0, reposted: 0, blocked: 0, agency: 0 };
    base.forEach(j => counts[catOf(j)]++);
    const filtered = base.filter(j => catOf(j) === tab);

    // Tab labels carry their own counts, so the split is visible before clicking.
    const tabLabel = { fresh: '⚡ Fresh', reposted: '🔁 Reposted', blocked: '🚫 No sponsor', agency: '🏢 Agencies' };
    const tabsEl = document.getElementById('ljs-tabs');
    if (tabsEl) {
      tabsEl.querySelectorAll('.ljs-tab').forEach(t => {
        const which = t.getAttribute('data-tab');
        t.classList.toggle('ljs-tab-on', which === tab);
        t.textContent = tabLabel[which] + ' (' + counts[which] + ')';
      });
    }

    const kwMatches = jobs.filter(j => matchesKeyword(j.title).length > 0).length;
    const sponsors = jobs.filter(j => j.sponsor).length;
    const unseen = jobs.filter(j => !seen.has(uidOf(j))).length;
    const blocked = jobs.filter(j => j.noSponsor).length;
    const reposts = jobs.filter(j => j.repost).length;
    stats.textContent = (jobs.length - reposts) + ' fresh · ' + reposts + ' reposted · ' +
      unseen + ' unseen · ' + sponsors + ' sponsors · ' + blocked + ' blocked · ' +
      kwMatches + ' keyword matches' + (lastScanNote ? ' · ' + lastScanNote : '');

    if (filtered.length === 0) {
      const emptyEmoji = { reposted: '🎉', blocked: '🎉', agency: '🎉', fresh: '🔍' };
      const emptyMsg = {
        reposted: 'No reposts here — all fresh!',
        blocked: 'No visa-blocked roles 🎉',
        agency: 'No recruiters here — all direct employers 🎉',
        fresh: 'No jobs match the current filters'
      };
      list.innerHTML = '<div class="ljs-empty"><span class="ljs-empty-emoji">' +
        (emptyEmoji[tab] || '🔍') + '</span>' + (emptyMsg[tab] || emptyMsg.fresh) + '</div>';
      return;
    }

    let html = '';
    let lastGroup = '';

    if (tab === 'reposted') {
      html += '<div class="ljs-tab-note">Reposts — circulating longer than their dates suggest. ' +
        'Kept out of the Fresh list entirely.</div>';
    } else if (tab === 'blocked') {
      html += '<div class="ljs-tab-note">These say citizens-only / clearance / “no sponsorship” — ' +
        'mostly found by Deep scan reading the full description.</div>';
    } else if (tab === 'agency') {
      html += '<div class="ljs-tab-note">Staffing / recruiting firms posting on behalf of a client — ' +
        'kept out of Fresh so it shows direct employers only.</div>';
    }

    filtered.forEach(j => {
      const uid = uidOf(j);
      const age = ageOf(j, now);
      const tc = timeColor(age);
      const score = fitScore(j, now);
      const sc = scoreColor(score);
      const kw = matchesKeyword(j.title);
      const neg = matchesNegative(j.title);
      const isMatch = kw.length > 0;
      const isSeen = seen.has(uid), isApplied = applied.has(uid);
      // Each tab is its own list, so both group by age normally.
      const group = groupOf(age);
      if (group !== lastGroup) {
        html += `<div class="ljs-section-label">${esc(group)}</div>`;
        lastGroup = group;
      }

      const linked = !!j.link && /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/.test(j.link);
      const attrs = linked
        ? `href="${esc(j.link)}" target="_blank" rel="noopener noreferrer"`
        : `title="No link captured for this job — rescan to resolve it"`;

      const cls = ['ljs-job'];
      if (isMatch) cls.push('ljs-keyword-match');
      if (!linked) cls.push('ljs-nolink');
      if (isSeen) cls.push('ljs-seen');
      if (isApplied) cls.push('ljs-applied');

      html += `
        <a ${attrs} data-uid="${esc(uid)}" class="${cls.join(' ')}" style="border-left: 3px solid ${tc.color};">
          <div class="ljs-job-title">
            ${esc(j.title)}
            ${isMatch ? `<span class="ljs-keyword-tag">${esc(kw[0])}</span>` : ''}
            ${neg.length ? `<span class="ljs-neg-tag">${esc(neg[0].trim())}</span>` : ''}
            ${linked ? '' : '<span class="ljs-nolink-tag">no link</span>'}
          </div>
          <div class="ljs-job-company">
            ${esc(j.company)}
            ${j.noSponsor ? `<span class="ljs-nosponsor-tag" title="This card's text says so — check the full description to confirm">🚫 ${esc(j.noSponsor)}</span>` : ''}
            ${j.sponsor ? `<span class="ljs-sponsor-tag" title="${j.sponsorCount ? j.sponsorCount + ' new H-1B approvals in FY2025' : 'Appears in your H-1B employer data'}">🟢 sponsor${j.sponsorCount ? ' ' + j.sponsorCount : ''}</span>` : ''}
            ${j.staffing ? '<span class="ljs-agency-tag">agency</span>' : ''}
            ${j.repost ? '<span class="ljs-repost-tag" title="Reposted — circulating longer than the date suggests">repost</span>' : ''}
          </div>
          ${(j.location || j.salary) ? `<div class="ljs-job-sub">
            ${j.location ? `<span class="ljs-loc">📍 ${esc(j.location)}</span>` : ''}
            ${j.salary ? `<span class="ljs-salary">💰 ${esc(j.salary)}</span>` : ''}
          </div>` : ''}
          <div class="ljs-job-meta">
            <span class="ljs-job-location"></span>
            <span class="ljs-meta-right">
              ${j.desc ? `<button class="ljs-desc-btn" data-uid="${esc(uid)}" title="Read the job description">📄</button>` : ''}
              <button class="ljs-applied-btn ${isApplied ? 'on' : ''}" data-uid="${esc(uid)}" title="${isApplied ? 'Applied — click to undo' : 'Mark as applied'}">✓</button>
              <span class="ljs-score-badge" style="background:${sc.bg};color:${sc.color};" title="Fit score (display only — order is always newest first)">${score}</span>
              <span class="ljs-time-badge" style="background:${tc.bg};color:${tc.color};">${esc(fmtTime(age))}</span>
            </span>
          </div>
        </a>
      `;
    });

    list.innerHTML = html;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN
  // ─────────────────────────────────────────────────────────────────────────
  let scraping = false;
  // renderJobs rewrites the stats element, so a warning written by finish()
  // was being erased instantly. Keep it here and re-append on every render.
  let lastScanNote = '';

  function runScrape(allPages, deep) {
    if (scraping) return;
    scraping = true;

    let page = 1, totalAdded = 0, deepMissTotal = 0, deepUnconfTotal = 0, deepDoneTotal = 0;

    function scanOne() {
      showProgress(0, 1, (deep ? 'Deep scan — opening each job on page ' : 'Loading page ') + page + '...');
      scrapeAndCollect((newJobs, misses, unconfirmed, done) => {
        deepDoneTotal += (done || 0);
        deepMissTotal += (misses || 0);
        deepUnconfTotal += (unconfirmed || 0);
        const existing = loadJobs();
        totalAdded += mergeJobs(existing, newJobs);
        saveJobs(existing);
        renderJobs(existing, currentFilter());

        if (!allPages || page >= MAX_PAGES) { finish(existing); return; }

        showProgress(0, 1, 'Opening page ' + (page + 1) + '...');
        goToNextPage(ok => {
          if (!ok) { finish(existing); return; }
          page++;
          scanOne();
        });
      }, deep);
    }

    function finish(existing) {
      scraping = false;
      // The COUNT is the thing that matters: a scan that processed 1 card
      // looks identical to a healthy one without it.
      lastScanNote = deep
        ? (deepMissTotal || deepUnconfTotal
            ? '⚠ deep scan: ' + deepDoneTotal + ' panels read, ' + deepMissTotal +
              ' would not open, ' + deepUnconfTotal + ' unconfirmed'
            : '✓ deep scan read ' + deepDoneTotal + ' job panels')
        : lastScanNote;
      const statsEl = document.getElementById('ljs-stats');
      if (statsEl) {
        statsEl.textContent = existing.length + ' jobs · ' + totalAdded +
          ' new · ' + page + ' page' + (page === 1 ? '' : 's') + ' scanned';
      }
      renderJobs(existing, currentFilter());
    }

    scanOne();
  }

  let pollTimer = null;
  function waitAndRun() {
    if (pollTimer) clearInterval(pollTimer);
    const started = Date.now();
    pollTimer = setInterval(() => {
      const main = mainEl();
      if (main && main.querySelectorAll('div[role="button"]').length > 0) {
        clearInterval(pollTimer);
        pollTimer = null;
        buildPanel();
        return;
      }
      if (Date.now() - started > 30000) { clearInterval(pollTimer); pollTimer = null; }
    }, 1000);
  }

  // Re-run on LinkedIn SPA navigation (debounced — this fires on every DOM change).
  let lastUrl = location.href;
  let navTimer = null;
  const observer = new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (!location.href.includes('/jobs/search')) return;
    // Don't tear the panel down mid-scan; pagination changes the URL too.
    if (scraping) return;
    if (navTimer) clearTimeout(navTimer);
    navTimer = setTimeout(waitAndRun, 2000);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Alt+J toggles the panel open/closed.
  document.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'j' || e.key === 'J')) {
      const panel = document.getElementById('ljs-panel');
      if (panel) { e.preventDefault(); panel.classList.toggle('ljs-collapsed'); }
    }
  });

  waitAndRun();
})();
