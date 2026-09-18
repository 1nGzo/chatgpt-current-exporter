const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = name => fs.readFileSync(`extension/${name}`, 'utf8');
let saved = {};
const storage = { get: async defaults => ({ ...defaults, ...saved }), set: async value => { saved = { ...saved, ...value }; } };
const downloads = [], timers = [];
const blobs = new Map();
const context = vm.createContext({ chrome: { storage: { local: storage } }, Blob,
  URL: { createObjectURL(blob) { const url = String(blobs.size); blobs.set(url, blob); return url; }, revokeObjectURL() {} },
  document: { createElement: () => ({ style: {}, click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); }, remove() {} }), body: { appendChild() {} } },
  window: { setTimeout(fn, delay) { if (delay === 300) timers.push(fn); } }
});
vm.runInContext(source('converter.js'), context);
const converter = context.CCEConversationConverter;
function popup() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, addEventListener(type, fn) { this[type] = fn; } });
    return elements.get(id);
  };
  const inputs = ['markdown', 'json', 'both'].map(value => ({ value, checked: value === 'markdown' }));
  element('export-format').querySelectorAll = () => inputs;
  const messages = [];
  vm.runInNewContext(source('popup.js'), { document: { getElementById: element }, chrome: {
    storage: { local: storage }, runtime: {}, tabs: { query(_, cb) { cb([{ id: 1 }]); }, sendMessage(_, message, cb) {
      messages.push(message); cb(message.type === 'GET_STATUS' ? null : { ok: true, files: ['fixture.md'] });
    } }
  } });
  return { element, inputs, messages };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const chatSource = source('content.js');
  const start = chatSource.indexOf('  async function exportCurrent()');
  const end = chatSource.indexOf('  function exportGeminiDebugBundle', start);
  // Export has no dependency on provider parsing: retain real download code and stub capture/render.
  const exportFunction = end < 0 ? chatSource.slice(start, chatSource.indexOf('\n  function ', start + 10)) : chatSource.slice(start, end);
  const payload = { fixture: true }, raw = JSON.stringify(payload, null, 2) + '\n', markdown = '# unchanged\n';
  const chat = vm.createContext({ namingConfigReady: Promise.resolve(), platformId: 'chatgpt', currentId: 'id',
    currentEntry: () => ({ payload, rawText: raw, document: { title: 'fixture', conversationId: 'id', messages: [{}], stats: { incompleteReasons: [] } } }),
    converter: { ...converter, renderMarkdown: () => ({ markdown }) }, updatePanel() {}, lastError: '' });
  vm.runInContext(exportFunction, chat);
  let grokListener;
  const value = { title: 'fixture', conversationId: 'id', sourceUrl: 'https://grok.com/c/id', metadata: {} };
  vm.runInNewContext(source('grok-content.js'), { CCEConversationConverter: { ...converter, renderNormalized: () => ({ markdown }) },
    CCEGrokAdapter: { capture: async () => value }, location: { href: value.sourceUrl }, document: {},
    fetch: async () => ({ ok: false }), chrome: { runtime: { getURL: x => x, onMessage: { addListener(fn) { grokListener = fn; } } } } });
  for (const format of [undefined, 'markdown', 'json', 'both', 'invalid']) {
    saved = format === undefined ? {} : { exportFormat: format };
    for (const [run, expectedRaw] of [[() => chat.exportCurrent(), raw],
      [() => new Promise(resolve => grokListener({ type: 'EXPORT_CURRENT' }, null, resolve)), JSON.stringify(value, null, 2) + '\n']]) {
      downloads.length = 0;
      const result = await run(); timers.splice(0).forEach(fn => fn());
      const expected = format === 'both' ? ['fixture.raw.json', 'fixture.md'] : format === 'json' ? ['fixture.raw.json'] : ['fixture.md'];
      assert.equal(result.ok, true);
      assert.deepEqual(Array.from(result.files), expected);
      assert.deepEqual(downloads.map(d => d.name), expected);
      for (const d of downloads) assert.equal(await d.blob.text(), d.name.endsWith('.md') ? markdown : expectedRaw);
    }
  }
  saved = {};
  let ui = popup(); await settle();
  assert.equal(ui.inputs.find(i => i.checked).value, 'markdown');
  for (const format of ['json', 'both', 'markdown']) {
    ui.element('export-format').change({ target: { value: format } });
    await ui.element('export').click();
    assert.equal(saved.exportFormat, format);
    assert.equal(ui.messages.at(-1).type, 'EXPORT_CURRENT');
    ui = popup(); await settle();
    assert.equal(ui.inputs.find(i => i.checked).value, format);
  }
  assert.ok(JSON.parse(source('manifest.json')).permissions.includes('storage'));
  console.log('PASS: both provider paths, default/invalid formats, unchanged bytes/names, popup save/reopen and export ordering');
})().catch(error => { console.error(error); process.exitCode = 1; });
