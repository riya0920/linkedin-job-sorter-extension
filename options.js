const $ = id => document.getElementById(id);

function setStatus(msg, cls, persist) {
  const s = $('status');
  s.textContent = msg;
  s.className = cls || '';
  if (msg && !persist) setTimeout(() => { if (s.textContent === msg) s.textContent = ''; }, 2500);
}

// Load existing settings.
chrome.storage.local.get(['ljsGeminiKey', 'ljsGeminiModel'], v => {
  if (v.ljsGeminiKey) $('key').value = v.ljsGeminiKey;
  if (v.ljsGeminiModel) $('model').value = v.ljsGeminiModel;
});

function saveKey(cb) {
  const key = $('key').value.trim();
  const model = $('model').value;
  chrome.storage.local.set({ ljsGeminiKey: key, ljsGeminiModel: model }, () => cb && cb(key));
}

$('save').onclick = () => {
  saveKey(key => {
    // "Save & test" is the real validator; don't nag about key format here,
    // since some working keys are not the classic AIza... shape.
    setStatus(key ? '✓ Saved (use "Save & test" to verify)' : '✓ Saved (no key)', 'ok');
  });
};

// Save the key, then do a live Gemini call so the user gets a definitive
// yes/no on whether it actually works, with the real error if it does not.
$('test').onclick = () => {
  saveKey(key => {
    if (!key) { setStatus('Enter a key first', 'bad', true); return; }
    setStatus('Testing…', '', true);
    chrome.runtime.sendMessage({ type: 'ljs-gemini-test' }, r => {
      if (chrome.runtime.lastError) { setStatus('✗ Extension error: ' + chrome.runtime.lastError.message + ' (reload the extension)', 'bad', true); return; }
      if (!r) { setStatus('✗ No response - reload the extension at chrome://extensions', 'bad', true); return; }
      if (r.ok) setStatus('✓ Key works! Gemini replied "' + r.sample + '"', 'ok', true);
      else setStatus('✗ ' + (r.error || 'failed') + (r.error === 'no-key' ? ' (key did not save)' : ''), 'bad', true);
    });
  });
};

$('model').onchange = () => {
  chrome.storage.local.set({ ljsGeminiModel: $('model').value });
};

$('toggle').onclick = () => {
  const el = $('key');
  const showing = el.type === 'text';
  el.type = showing ? 'password' : 'text';
  $('toggle').textContent = showing ? 'Show' : 'Hide';
};

$('clear').onclick = () => {
  $('key').value = '';
  chrome.storage.local.remove('ljsGeminiKey', () => setStatus('Key removed', 'ok'));
};
