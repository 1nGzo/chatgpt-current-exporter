// Run from any directory: node extension/tests/grok-regression.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const extension = path.resolve(__dirname, '..');
function load(source) { const ctx = {}; vm.runInNewContext(source, ctx); return ctx.CCEConversationConverter; }
const before = load(cp.execFileSync('git', ['show', 'HEAD:extension/converter.js'], {cwd: extension, encoding:'utf8'}));
const after = load(fs.readFileSync(path.join(extension, 'converter.js'), 'utf8'));
const fixtures = path.resolve(extension, '../fixtures');
let count = 0;
for (const file of fs.readdirSync(fixtures).filter(name => name.endsWith('.json'))) {
 const payload = JSON.parse(fs.readFileSync(path.join(fixtures,file),'utf8'));
 let expected;
 try { expected = before.renderMarkdown(payload).markdown; } catch (_) { continue; }
 assert.equal(after.renderMarkdown(payload).markdown, expected, file);
 count++;
}
assert.ok(count > 0);
for (const title of ['Hello / world', '中文：会话', '', 'x'.repeat(200)]) assert.equal(after.filenameStem(title,'id'),before.filenameStem(title,'id'));
const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
assert.equal(manifest.manifest_version,3);
const grok=manifest.content_scripts.find(entry=>entry.matches.includes('https://grok.com/*'));
assert.ok(grok.matches.includes('https://www.grok.com/*'));
for(const entry of manifest.content_scripts) for(const file of entry.js) new vm.Script(fs.readFileSync(path.join(extension,file),'utf8'),{filename:file});
console.log(`PASS: ${count} ChatGPT Markdown fixtures identical to HEAD; filenames unchanged; manifest scripts present and valid`);
