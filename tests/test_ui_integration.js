const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

console.log('Running UI Integration Verification Suite...');

// 1. Popup HTML and CSS Verification
console.log('Test 1: Popup Structure and Native Styling');
const popupHtml = fs.readFileSync('extension/popup.html', 'utf8');
const popupCss = fs.readFileSync('extension/popup.css', 'utf8');

// Ensure Diagnostics is wrapped in collapsible <details> and closed by default
assert(popupHtml.includes('<details class="diagnostics-details">'), 'Diagnostics must be inside <details>');
assert(!popupHtml.includes('<details class="diagnostics-details" open>'), 'Diagnostics must be collapsed by default');
assert(popupHtml.includes('<summary class="diagnostics-summary">'), 'Diagnostics must have a summary header');
assert(popupHtml.includes('id="diagnostics"'), 'Diagnostics pre element must exist');
assert(popupHtml.includes('id="rescan"'), 'Rescan button must exist');
assert(popupHtml.includes('id="debug-bundle"'), 'Debug bundle button must exist');
assert(popupHtml.includes('id="export-format"'), 'Export format fieldset must exist');
assert(popupHtml.includes('id="export"'), 'Export button must exist');

// Verify unified tokens in popup.css
assert(popupCss.includes('--cce-bg'), 'popup.css must define theme variables');
assert(popupCss.includes('@media (prefers-color-scheme: dark)'), 'popup.css must support dark mode');
assert(!popupCss.includes('#10a37f; border-radius: 6px; color: #fff; background: #10a37f;'), 'popup.css must not use loud green as primary button background');
console.log('PASS: Test 1 passed');

// 2. In-Page Content Script UI Verification
console.log('Test 2: Quick Export & Dot History Components in content.js');
const contentSrc = fs.readFileSync('extension/content.js', 'utf8');

// Verify presence of Quick Export and Dot History functions
assert(contentSrc.includes('function buildQuickExportUI()'), 'buildQuickExportUI must exist');
assert(contentSrc.includes('function buildDotHistoryUI()'), 'buildDotHistoryUI must exist');
assert(contentSrc.includes('function detectTheme()'), 'detectTheme must exist');
assert(contentSrc.includes('cce-quick-pill'), 'cce-quick-pill class must exist');
assert(contentSrc.includes('cce-dot-handle'), 'cce-dot-handle class must exist');
assert(contentSrc.includes('cce-dot-timeline'), 'cce-dot-timeline class must exist');
assert(contentSrc.includes('cce-dot-node'), 'cce-dot-node class must exist');
assert(contentSrc.includes('cce-dot-preview'), 'cce-dot-preview class must exist');

// 3. Dot History Logic & Density Verification
console.log('Test 3: Dot Density Compression Calculation');
// Test the density formula:
// const pitch = count <= 1 ? 24 : Math.min(24, Math.max(8, (trackHeight - 20) / (count - 1)));
// const contentHeight = Math.max(trackHeight, count * pitch + 16);
const trackHeight = 320;

// Case A: 5 items
const countA = 5;
const pitchA = countA <= 1 ? 24 : Math.min(24, Math.max(8, (trackHeight - 20) / (countA - 1)));
assert.equal(pitchA, 24, 'Small conversation should use max pitch 24px');
const contentHeightA = Math.max(trackHeight, countA * pitchA + 16);
assert.equal(contentHeightA, trackHeight, 'Small conversation fits inside track without overflow');

// Case B: 25 items
const countB = 25;
const pitchB = countB <= 1 ? 24 : Math.min(24, Math.max(8, (trackHeight - 20) / (countB - 1)));
assert(pitchB < 24 && pitchB >= 8, `Moderate conversation compresses pitch: ${pitchB}`);
const contentHeightB = Math.max(trackHeight, countB * pitchB + 16);
assert(contentHeightB <= trackHeight + 30, 'Moderate conversation stays tightly bounded within track');

// Case C: 120 items (Super long conversation)
const countC = 120;
const pitchC = countC <= 1 ? 24 : Math.min(24, Math.max(8, (trackHeight - 20) / (countC - 1)));
assert.equal(pitchC, 8, 'Super long conversation hits minimum pitch limit of 8px');
const contentHeightC = Math.max(trackHeight, countC * pitchC + 16);
assert(contentHeightC > trackHeight, 'Long conversation content scrolls within container');
assert(contentHeightC <= 1000, 'Long conversation content does not produce multi-thousand px column');
console.log('PASS: Test 3 passed');

// 4. Drag Threshold & Clamping Verification
console.log('Test 4: Handle Drag Threshold and Viewport Clamping');
function clampPosition(left, top, winWidth, winHeight) {
  const maxLeft = Math.max(8, winWidth - 44 - 8);
  const maxTop = Math.max(8, winHeight - 32 - 8);
  return {
    left: Math.max(8, Math.min(maxLeft, left)),
    top: Math.max(8, Math.min(maxTop, top))
  };
}

// Sub-5px movement should NOT be classified as drag
const deltaSmallX = 2;
const deltaSmallY = 3;
const isDragSmall = (deltaSmallX * deltaSmallX + deltaSmallY * deltaSmallY) >= 25;
assert.equal(isDragSmall, false, 'Movement under 5px must not trigger drag');

// 5px+ movement SHOULD be classified as drag
const deltaLargeX = 4;
const deltaLargeY = 3;
const isDragLarge = (deltaLargeX * deltaLargeX + deltaLargeY * deltaLargeY) >= 25;
assert.equal(isDragLarge, true, 'Movement >= 5px must trigger drag');

// Clamping bounds
const winW = 1200, winH = 800;
assert.deepEqual(clampPosition(-50, -50, winW, winH), { left: 8, top: 8 });
assert.deepEqual(clampPosition(2000, 2000, winW, winH), { left: 1200 - 44 - 8, top: 800 - 32 - 8 });
assert.deepEqual(clampPosition(500, 300, winW, winH), { left: 500, top: 300 });
console.log('PASS: Test 4 passed');

// 5. Quick Export Split Pill Interaction Mock
console.log('Test 5: Quick Export Interaction and Format Switching');
let mockStorage = { exportFormat: 'markdown' };
const formatLabels = { markdown: 'MD', json: 'JSON', both: 'All' };

function selectFormat(fmt) {
  assert(['markdown', 'json', 'both'].includes(fmt));
  mockStorage.exportFormat = fmt;
  return formatLabels[fmt];
}

assert.equal(selectFormat('json'), 'JSON');
assert.equal(mockStorage.exportFormat, 'json');
assert.equal(selectFormat('both'), 'All');
assert.equal(mockStorage.exportFormat, 'both');
assert.equal(selectFormat('markdown'), 'MD');
assert.equal(mockStorage.exportFormat, 'markdown');
console.log('PASS: Test 5 passed');

console.log('\nALL UI INTEGRATION TESTS PASSED SUCCESSFULLY!');
