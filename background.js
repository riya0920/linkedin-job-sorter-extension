// LinkedIn Job Sorter - background service worker.
// Its only job: take (company, job description) pairs from the content script
// and ask Gemini whether each company sponsors H-1B, per the user's rules.
// The API key lives in chrome.storage.local (set on the Options page) and never
// leaves the browser or appears in the codebase.

const GEMINI_HOST = 'https://generativelanguage.googleapis.com/v1beta/models/';

// The classification rules, verbatim to the user's intent.
const SYSTEM_PROMPT = [
  'You decide whether each company sponsors H-1B visas, for a job seeker who needs sponsorship.',
  'For every item (a company name and a job description) decide a verdict of "yes" or "no":',
  '',
  '1. If the job description explicitly says they will NOT sponsor, or requires US citizenship,',
  '   a security/government clearance, "must be authorized to work without sponsorship", or anything',
  '   equivalent to that -> verdict "no" (a complete blocker).',
  '2. If the description says nothing like that, judge by the company\'s H-1B sponsorship history over',
  '   roughly the past 3 years. If they have sponsored -> "yes".',
  '',
  'Only answer "no" when it is a COMPLETE blocker: an explicit non-sponsor / clearance / citizens-only',
  'statement, OR you are genuinely confident the company does not and has not sponsored H-1B.',
  'If you are unsure or iffy about whether a company will sponsor -> answer "yes" (keep it in sponsors).',
  '',
  'Return ONLY strict JSON, no prose, in this exact shape, one entry per input in the same order:',
  '{"results":[{"i":<index>,"verdict":"yes"|"no","reason":"<=8 words"}]}'
].join('\n');

async function getConfig() {
  const { ljsGeminiKey, ljsGeminiModel } = await chrome.storage.local.get(['ljsGeminiKey', 'ljsGeminiModel']);
  return { key: ljsGeminiKey || '', model: ljsGeminiModel || 'gemini-2.5-flash' };
}

async function classify(items) {
  const { key, model } = await getConfig();
  if (!key) return { ok: false, error: 'no-key' };
  if (!items || !items.length) return { ok: true, results: [] };

  const userPayload = items.map((it, i) => ({
    i: i,
    company: String(it.company || '').slice(0, 120),
    job_description: String(it.jd || '').replace(/\s+/g, ' ').slice(0, 1500)
  }));

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text: JSON.stringify(userPayload) }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };

  const url = GEMINI_HOST + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { ok: false, error: 'network: ' + (e && e.message || e) };
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error?.message || ''; } catch (e) {}
    return { ok: false, error: 'http ' + resp.status + (detail ? ': ' + detail : '') };
  }

  let data;
  try { data = await resp.json(); } catch (e) { return { ok: false, error: 'bad json response' }; }
  const text = data && data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!text) return { ok: false, error: 'empty response' };

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    // Model occasionally wraps JSON in fences; salvage the object.
    const mtch = text.match(/\{[\s\S]*\}/);
    try { parsed = JSON.parse(mtch ? mtch[0] : text); } catch (e2) { return { ok: false, error: 'unparseable verdicts' }; }
  }
  const results = (parsed && parsed.results) || [];
  return { ok: true, results: results };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ljs-gemini-classify') {
    classify(msg.items).then(sendResponse);
    return true; // async response
  }
  if (msg && msg.type === 'ljs-gemini-haskey') {
    getConfig().then(c => sendResponse({ hasKey: !!c.key, model: c.model }));
    return true;
  }
});
