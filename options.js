const $ = id => document.getElementById(id);

function setStatus(msg, cls) {
  const s = $('status');
  s.textContent = msg;
  s.className = cls || '';
  if (msg) setTimeout(() => { if (s.textContent === msg) s.textContent = ''; }, 2500);
}

// Load existing settings.
chrome.storage.local.get(['ljsGeminiKey', 'ljsGeminiModel'], v => {
  if (v.ljsGeminiKey) $('key').value = v.ljsGeminiKey;
  if (v.ljsGeminiModel) $('model').value = v.ljsGeminiModel;
});

$('save').onclick = () => {
  const key = $('key').value.trim();
  const model = $('model').value;
  chrome.storage.local.set({ ljsGeminiKey: key, ljsGeminiModel: model }, () => {
    setStatus(key ? '✓ Saved' : '✓ Saved (no key)', 'ok');
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
