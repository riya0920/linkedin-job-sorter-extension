// LinkedIn Job Sorter - background service worker.
// Its only job: take (company, job description) pairs from the content script
// and ask Gemini whether each company sponsors H-1B, per the user's rules.
// The API key lives in chrome.storage.local (set on the Options page) and never
// leaves the browser or appears in the codebase.

const GEMINI_HOST = 'https://generativelanguage.googleapis.com/v1beta/models/';

// The classification rules, verbatim to the user's intent.
const SYSTEM_PROMPT = [
  'You decide whether each company sponsors H-1B visas, for a job seeker who needs sponsorship.',
  'For every item (a company name and a job description) return a verdict of "yes", "no", or "unsure":',
  '',
  '1. "no" (a COMPLETE blocker) if EITHER: the job description explicitly says they will NOT sponsor,',
  '   or requires US citizenship, a security/government clearance, "must be authorized to work without',
  '   sponsorship", or anything equivalent; OR you are genuinely confident the company does not and has',
  '   not sponsored H-1B.',
  '2. "yes" ONLY when you actually know the company has a clear, established record of sponsoring H-1B in',
  '   roughly the past 3 years (a large or well-documented sponsor), OR the job description explicitly',
  '   says they sponsor. Do NOT answer "yes" from a vague impression, a guess, or because sponsoring',
  '   merely seems plausible for a company of that type.',
  '3. "unsure" for everything in between: no clear H-1B record either way, a small or unfamiliar company,',
  '   a startup, a job aggregator or reposter, or any case where a "yes" would really be a guess. When in',
  '   doubt between yes and unsure, choose "unsure". Most companies you do not clearly recognize as active',
  '   H-1B sponsors should be "unsure", not "yes".',
  '',
  'Return ONLY strict JSON, no prose, in this exact shape, one entry per input in the same order:',
  '{"results":[{"i":<index>,"verdict":"yes"|"no"|"unsure","reason":"<=8 words"}]}'
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
  // Live end-to-end check with the currently saved key, so the Options page can
  // tell the user plainly whether the key actually works.
  if (msg && msg.type === 'ljs-gemini-test') {
    classify([{ company: 'Google', jd: 'Software engineer. We sponsor H-1B visas.' }])
      .then(r => {
        if (!r.ok) return sendResponse(r);
        const v = (r.results && r.results[0] && r.results[0].verdict) || '(no verdict)';
        sendResponse({ ok: true, sample: v });
      })
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
});
