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
assert.deepEqual(grok.js, ['converter.js', 'adapters/grok.js', 'grok-content.js']);
assert.equal(grok.world, 'ISOLATED');
for (const entry of manifest.content_scripts.filter(entry=>entry!==grok)) assert.ok(!entry.matches.some(host=>host.includes('grok.com')));
for(const entry of manifest.content_scripts) for(const file of entry.js) new vm.Script(fs.readFileSync(path.join(extension,file),'utf8'),{filename:file});
console.log(`PASS: ${count} ChatGPT Markdown fixtures identical to HEAD; filenames unchanged; manifest scripts present and valid`);

// Simulate concurrent popup requests across a SPA switch: B must not reuse A.
(async () => {
 const requests=[];
 let listener;
 const ctx={location:{href:'https://grok.com/c/A'},document:{},fetch:async()=>({ok:false}),setTimeout,
  chrome:{runtime:{getURL:x=>x,onMessage:{addListener:fn=>{listener=fn;}}}},
  CCEConversationConverter:{},CCEGrokAdapter:{conversationId:url=>url.split('/').pop(),capture:args=>new Promise((resolve,reject)=>requests.push({args,resolve,reject}))}};
 vm.runInNewContext(fs.readFileSync(path.join(extension,'grok-content.js'),'utf8'),ctx);
 const status=()=>new Promise(resolve=>listener({type:'GET_STATUS'},null,resolve));
 const first=status(); ctx.location.href='https://grok.com/c/B'; const second=status();
 assert.equal(requests.length,2);
 assert.equal(requests[1].args.url,ctx.location.href);
 requests[0].reject(Error('会话已切换，请重新导出')); await first;
 const third=status(); assert.equal(requests.length,2,'Old finally must not clear new pending capture');
 requests[1].resolve({conversationId:'B',sourceUrl:ctx.location.href,messages:[{}],metadata:{source:'api',diagnostics:{conversationId:'B',injected:true}}});
 for(const result of await Promise.all([second,third])) {assert.equal(result.conversationId,'B');assert.equal(result.diagnostics.injected,true);}
 const failure=status();
 requests[2].reject(Object.assign(Error('No DOM'),{diagnostics:{conversationId:'B',apiRequests:[{status:401}]}}));
 assert.equal((await failure).diagnostics.apiRequests[0].status,401);
 console.log('PASS: Grok content script SPA pending isolation and error diagnostics');
})().catch(error=>{console.error(error);process.exitCode=1;});
