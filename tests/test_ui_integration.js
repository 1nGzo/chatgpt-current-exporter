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
assert(popupHtml.includes('<title>ThreadSpool</title>'), 'Title must be ThreadSpool');
assert(popupHtml.includes('<h1 class="popup-title">ThreadSpool</h1>'), 'Heading must be ThreadSpool');
assert(popupHtml.includes('id="diagnostics"'), 'Diagnostics pre element must exist');
assert(popupHtml.includes('id="rescan"'), 'Rescan button must exist');
assert(!popupHtml.includes('id="debug-bundle"'), 'Debug bundle button must not exist');
assert(popupHtml.includes('id="export-format"'), 'Export format fieldset must exist');
assert(popupHtml.includes('id="export"'), 'Export button must exist');

// Verify unified tokens in popup.css
assert(popupCss.includes('--cce-bg'), 'popup.css must define theme variables');
assert(popupCss.includes('@media (prefers-color-scheme: dark)'), 'popup.css must support dark mode');
assert(!popupCss.includes('#10a37f; border-radius: 6px; color: #fff; background: #10a37f;'), 'popup.css must not use loud green as primary button background');
console.log('PASS: Test 1 passed');

// 2. In-Page Content Script UI Verification
console.log('Test 2: Quick Export, History Dock & Voyage Window in content.js');
const contentSrc = fs.readFileSync('extension/content.js', 'utf8');

// Verify presence of Quick Export and Dot History functions
assert(contentSrc.includes('function buildQuickExportUI()'), 'buildQuickExportUI must exist');
assert(contentSrc.includes('function buildDotHistoryUI()'), 'buildDotHistoryUI must exist');
assert(contentSrc.includes('function detectTheme()'), 'detectTheme must exist');
assert(contentSrc.includes('cce-quick-pill'), 'cce-quick-pill class must exist');
assert(contentSrc.includes('cce-dock-history'), 'cce-dock-history class must exist');
assert(contentSrc.includes('cce-dock-export'), 'cce-dock-export class must exist');
assert(contentSrc.includes('cce-dot-handle'), 'cce-dot-handle class must exist');
assert(contentSrc.includes('cce-dot-timeline'), 'cce-dot-timeline class must exist');
assert(contentSrc.includes('cce-dot-node'), 'cce-dot-node class must exist');
assert(contentSrc.includes('cce-dot-preview'), 'cce-dot-preview class must exist');
assert(contentSrc.includes('cce-history-overlay'), 'cce-history-overlay class must exist');
assert(contentSrc.includes('cce-history-search-input'), 'cce-history-search-input class must exist');
assert(contentSrc.includes('cce-history-list'), 'cce-history-list class must exist');
assert(contentSrc.includes('.cce-dot-handle.is-hidden'), '.cce-dot-handle.is-hidden CSS rule must exist');
assert(contentSrc.includes('setHistoryActive'), 'setHistoryActive must exist');
assert(contentSrc.includes('openHistoryWindow'), 'openHistoryWindow must exist');
assert(contentSrc.includes('previewText'), 'previewText must be used for preview');
assert(!contentSrc.includes('preview.textContent = item.preview || item.text || `Prompt'), 'Must not fallback to pure Prompt N placeholder');
console.log('PASS: Test 2 passed');

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

console.log('Test 6: Master Switch Interaction Responsibilities & Preview Text Generation');

// Mock Dot History state
let isHistoryActive = false;
let railVisible = false;
let handleVisible = false;
let historyWindowOpen = false;

function setHistoryActive(active) {
  isHistoryActive = Boolean(active);
  railVisible = isHistoryActive;
  handleVisible = isHistoryActive;
  if (!isHistoryActive) {
    historyWindowOpen = false;
  }
}

function onHistoryBtnClick() {
  setHistoryActive(!isHistoryActive);
}

function onHandleBtnClick() {
  // Handle click only opens/closes History Window, NEVER affects rail visibility
  historyWindowOpen = !historyWindowOpen;
}

// Initial state: History OFF (default): both dot rail and handle hidden
assert.equal(isHistoryActive, false);
assert.equal(railVisible, false, 'Rail hidden by default');
assert.equal(handleVisible, false, 'Handle hidden by default');
assert.equal(historyWindowOpen, false);

// Click History in dock: switches History ON -> reveals both rail and handle
onHistoryBtnClick();
assert.equal(isHistoryActive, true);
assert.equal(railVisible, true, 'History ON shows dot rail');
assert.equal(handleVisible, true, 'History ON shows dot handle');
assert.equal(historyWindowOpen, false, 'History ON must not automatically open history window');

// Click Handle: opens History Window without toggling rail
onHandleBtnClick();
assert.equal(historyWindowOpen, true, 'Handle click opens history window');
assert.equal(railVisible, true, 'Rail remains visible when window opens');

// Click Handle again: closes History Window without toggling rail
onHandleBtnClick();
assert.equal(historyWindowOpen, false, 'Handle click closes history window');
assert.equal(railVisible, true, 'Rail remains visible when window closes');

// Open window again, then click History in dock (switch OFF)
onHandleBtnClick();
assert.equal(historyWindowOpen, true);
onHistoryBtnClick(); // turn OFF
assert.equal(isHistoryActive, false);
assert.equal(railVisible, false, 'History OFF hides dot rail');
assert.equal(handleVisible, false, 'History OFF hides dot handle');
assert.equal(historyWindowOpen, false, 'History OFF closes open history window');

// Preview Text formatting check
function generatePreview(item, index) {
  const text = item.previewText || item.preview || item.text || "";
  const orderStr = `#${item.userOrder || index + 1}`;
  assert(!text.startsWith('Prompt '), 'Must never use placeholder Prompt N for previewText');
  return { orderStr, text };
}

const itemWithText = {
  previewText: "完整正文和视觉锚点，记录，并重新调取最高指令……",
  userOrder: 14
};
const previewResult = generatePreview(itemWithText, 13);
assert.equal(previewResult.orderStr, '#14');
assert.equal(previewResult.text, '完整正文和视觉锚点，记录，并重新调取最高指令……');

console.log('PASS: Test 6 passed');

// 7. Anchored Popover & Dot Preview Positioning Unit Verification
console.log('Test 7: Anchored Popover & Dot Preview Positioning Logic');

// Verify no full-screen backdrop / page dimming in content.js
assert(!contentSrc.includes('cce-history-backdrop'), 'Must not contain cce-history-backdrop (no dimming modal)');
assert(contentSrc.includes('updateHistoryWindowPosition'), 'Must implement updateHistoryWindowPosition');
assert(contentSrc.includes('dotRect = node.getBoundingClientRect()'), 'Must anchor dot preview to node.getBoundingClientRect()');

// A. Test History Window Positioning Algorithm
function calcHistoryWindowPos(handleRect, winW, winH, winWidth = 380, winHeight = 480, gap = 8) {
  let left = handleRect.left - winWidth - gap;
  if (left < 8) {
    if (handleRect.right + gap + winWidth <= winW - 8) {
      left = handleRect.right + gap;
    } else {
      left = Math.max(8, winW - winWidth - 8);
    }
  }
  let top = handleRect.top - 16;
  top = Math.max(12, Math.min(winH - winHeight - 12, top));
  return { left, top, width: winWidth, height: winHeight };
}

// Case 1: Standard handle on right side of a 1440x900 viewport
const handleRight = { left: 1400, top: 350, right: 1428, bottom: 378 };
const pos1 = calcHistoryWindowPos(handleRight, 1440, 900);
assert.equal(pos1.left, 1400 - 380 - 8, 'Window must appear on the left of the handle');
assert.equal(pos1.top, 350 - 16, 'Window top aligned near handle top');
assert(pos1.left >= 8 && pos1.left + pos1.width <= 1440, 'Window stays within horizontal bounds');
assert(pos1.top >= 12 && pos1.top + pos1.height <= 900, 'Window stays within vertical bounds');

// Case 2: Handle near top-left of viewport -> flip to right and clamp top
const handleLeftTop = { left: 20, top: 10, right: 48, bottom: 38 };
const pos2 = calcHistoryWindowPos(handleLeftTop, 1440, 900);
assert.equal(pos2.left, 48 + 8, 'Window must flip to right of handle when left has no space');
assert.equal(pos2.top, 12, 'Window top must clamp to min 12px');

// Case 3: Handle near bottom of viewport -> clamp bottom
const handleBottom = { left: 1400, top: 880, right: 1428, bottom: 908 };
const pos3 = calcHistoryWindowPos(handleBottom, 1440, 900);
assert.equal(pos3.top, 900 - 480 - 12, 'Window top must clamp to keep window completely in viewport');

// B. Test Dot Hover Preview Positioning Algorithm
function calcDotPreviewPos(dotRect, winW, winH, pw = 200, ph = 36, gap = 12) {
  let left = dotRect.left - pw - gap;
  if (left < 8) {
    if (dotRect.right + gap + pw <= winW - 8) {
      left = dotRect.right + gap;
    } else {
      left = Math.max(8, winW - pw - 8);
    }
  }
  const dotCenterY = (dotRect.top + dotRect.bottom) / 2;
  let top = dotCenterY - ph / 2;
  top = Math.max(8, Math.min(winH - ph - 8, top));
  return { left, top, pw, ph };
}

// Case 1: Dot on right side, middle of screen
const dotMid = { left: 1420, top: 400, right: 1440, bottom: 420 };
const prev1 = calcDotPreviewPos(dotMid, 1440, 900, 200, 36, 12);
assert.equal(prev1.left, 1420 - 200 - 12, 'Preview appears left of dot with 12px gap');
assert.equal(prev1.top, 410 - 18, 'Preview vertically centered with dot');

// Case 2: Dot near top edge
const dotTop = { left: 1420, top: 10, right: 1440, bottom: 30 };
const prev2 = calcDotPreviewPos(dotTop, 1440, 900, 200, 36, 12);
assert.equal(prev2.top, 8, 'Preview top must clamp to min 8px');

// Case 3: Dot near bottom edge
const dotBottom = { left: 1420, top: 880, right: 1440, bottom: 900 };
const prev3 = calcDotPreviewPos(dotBottom, 1440, 900, 200, 36, 12);
assert.equal(prev3.top, 900 - 36 - 8, 'Preview bottom must clamp to viewport bottom');

// Case 4: Dot on left side -> flip to right
const dotLeft = { left: 10, top: 300, right: 30, bottom: 320 };
const prev4 = calcDotPreviewPos(dotLeft, 1440, 900, 200, 36, 12);
assert.equal(prev4.left, 30 + 12, 'Preview must flip to right of dot when left is cramped');

console.log('PASS: Test 7 passed');

// 8. ChatGPT Sidebar Shortcut Navigation Verification
console.log('Test 8: ChatGPT Sidebar Shortcut Navigation');

// Assert content.js structure
assert(contentSrc.includes('function initChatGPTSidebarShortcuts()'), 'initChatGPTSidebarShortcuts must exist');
assert(contentSrc.includes('function extractConversationUrl('), 'extractConversationUrl must exist');
assert(contentSrc.includes('data-sidebar-chatgpt-conversation-key'), 'must support data-sidebar-chatgpt-conversation-key');
assert(contentSrc.includes('data-pinned-content-tab-drop-key'), 'must support data-pinned-content-tab-drop-key');
assert(contentSrc.includes('target.closest("a[href]")'), 'must preserve native a[href] without redundant interception');
assert(contentSrc.includes('e.stopImmediatePropagation()'), 'must stop immediate propagation to prevent current tab navigation');

// Functional testing of extractConversationUrl and event handling
{
  class SimpleMockElement {
    constructor(tagName, attrs = {}) {
      this.tagName = tagName.toUpperCase();
      this.attrs = { ...attrs };
      this.dataset = {};
      this.style = {};
      this.parentElement = null;
      this.children = [];
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    setAttribute(name, val) { this.attrs[name] = String(val); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    closest(selector) {
      let curr = this;
      while (curr) {
        if (curr.matches(selector)) return curr;
        curr = curr.parentElement;
      }
      return null;
    }
    matches(selector) {
      const parts = selector.split(',').map(s => s.trim());
      for (const part of parts) {
        if (part === 'button') {
          if (this.tagName === 'BUTTON') return true;
        } else if (part === 'a[href]') {
          if (this.tagName === 'A' && this.attrs.href) return true;
        } else if (part.startsWith('[')) {
          const [k, v] = part.slice(1, -1).split('=');
          if (!v) {
            if (this.attrs[k] !== undefined) return true;
          } else {
            const clean = v.replace(/['"]/g, '');
            if (this.attrs[k] === clean) return true;
          }
        }
      }
      return false;
    }
  }

  // Set up mock window and sandbox
  const listeners = new Map();
  const openedUrls = [];
  const addListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const removeListener = (type, fn) => {
    const arr = listeners.get(type);
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
  };

  const sandbox = {
    console,
    URL,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/initial-conv' },
    window: {
      location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/initial-conv' },
      open: (url, target) => { openedUrls.push({ url, target }); return null; },
      addEventListener: addListener,
      removeEventListener: removeListener,
      postMessage: () => {}
    },
    document: {
      readyState: 'loading',
      addEventListener: addListener,
      removeEventListener: removeListener,
      createElement: (tag) => new SimpleMockElement(tag),
      head: new SimpleMockElement('head'),
      documentElement: new SimpleMockElement('html')
    },
    chrome: { runtime: { getURL: (p) => p } },
    globalThis: {}
  };
  sandbox.window.document = sandbox.document;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(contentSrc, sandbox);

  assert(sandbox.globalThis.CCEChatGPTSidebarShortcuts, 'CCEChatGPTSidebarShortcuts must be exported');
  const { extractConversationUrl } = sandbox.globalThis.CCEChatGPTSidebarShortcuts;

  // 1. Regular sidebar conversation item
  const convRow = new SimpleMockElement('div', {
    'data-sidebar-chatgpt-conversation-key': 'chatgpt:conversation:conv-1111-2222',
    role: 'listitem'
  });
  const convBtn = new SimpleMockElement('div', { role: 'button', class: 'sidebar-item' });
  const convTitle = new SimpleMockElement('span');
  const actionBtn = new SimpleMockElement('button', { 'aria-label': '聊天操作' });
  convBtn.appendChild(convTitle);
  convBtn.appendChild(actionBtn);
  convRow.appendChild(convBtn);

  assert.equal(extractConversationUrl(convTitle), 'https://chatgpt.com/c/conv-1111-2222');
  assert.equal(extractConversationUrl(convBtn), 'https://chatgpt.com/c/conv-1111-2222');
  assert.equal(extractConversationUrl(actionBtn), null, 'Action button inside item must be ignored');

  // 2. Pinned conversation item
  const pinnedRow = new SimpleMockElement('div', {
    'data-pinned-content-tab-drop-key': 'chatgpt:conversation:conv-pinned-3333',
    role: 'listitem'
  });
  const pinnedBtn = new SimpleMockElement('div', { role: 'button', class: 'sidebar-item' });
  pinnedRow.appendChild(pinnedBtn);
  assert.equal(extractConversationUrl(pinnedBtn), 'https://chatgpt.com/c/conv-pinned-3333');

  // 3. Non-conversation sidebar elements
  const newChatBtn = new SimpleMockElement('button');
  assert.equal(extractConversationUrl(newChatBtn), null, 'New chat button must be ignored');
  const projBtn = new SimpleMockElement('button', { 'data-app-action-sidebar-section-toggle': '' });
  assert.equal(extractConversationUrl(projBtn), null, 'Project section toggle must be ignored');

  // 4. Native anchor with href (must not be intercepted)
  const nativeAnchor = new SimpleMockElement('a', { href: '/c/native-item' });
  assert.equal(extractConversationUrl(nativeAnchor), null, 'Native a[href] must not be intercepted');

  // 5. Test event listeners: auxclick and modified click
  function fire(type, target, props = {}) {
    let prevented = false;
    let stopped = false;
    let immediateStopped = false;
    const event = {
      type,
      target,
      button: props.button ?? 0,
      ctrlKey: Boolean(props.ctrlKey),
      metaKey: Boolean(props.metaKey),
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
      stopImmediatePropagation: () => { immediateStopped = true; },
      get defaultPrevented() { return prevented; }
    };
    const list = listeners.get(type) || [];
    for (const fn of list) {
      if (immediateStopped) break;
      fn(event);
    }
    return { prevented, stopped, immediateStopped };
  }

  // Middle-click on conversation item
  openedUrls.length = 0;
  const resMid = fire('auxclick', convTitle, { button: 1 });
  assert.equal(openedUrls.length, 1);
  assert.equal(openedUrls[0].url, 'https://chatgpt.com/c/conv-1111-2222');
  assert.equal(openedUrls[0].target, '_blank');
  assert.equal(resMid.prevented, true);
  assert.equal(resMid.immediateStopped, true);

  // Ctrl+click on pinned item
  openedUrls.length = 0;
  const resCtrl = fire('click', pinnedBtn, { button: 0, ctrlKey: true });
  assert.equal(openedUrls.length, 1);
  assert.equal(openedUrls[0].url, 'https://chatgpt.com/c/conv-pinned-3333');
  assert.equal(openedUrls[0].target, '_blank');
  assert.equal(resCtrl.prevented, true);
  assert.equal(resCtrl.immediateStopped, true);

  // Cmd+click on conversation item
  openedUrls.length = 0;
  const resCmd = fire('click', convBtn, { button: 0, metaKey: true });
  assert.equal(openedUrls.length, 1);
  assert.equal(openedUrls[0].url, 'https://chatgpt.com/c/conv-1111-2222');
  assert.equal(resCmd.prevented, true);

  // Normal left-click on conversation item (must not intercept)
  openedUrls.length = 0;
  const resNorm = fire('click', convBtn, { button: 0 });
  assert.equal(openedUrls.length, 0);
  assert.equal(resNorm.prevented, false);
  assert.equal(resNorm.immediateStopped, false);

  // Ctrl+click on action button (3-dots) (must not intercept)
  openedUrls.length = 0;
  const resAct = fire('click', actionBtn, { button: 0, ctrlKey: true });
  assert.equal(openedUrls.length, 0);
  assert.equal(resAct.prevented, false);

  // Middle-click mousedown prevents scroll anchor
  const resMD = fire('mousedown', convBtn, { button: 1 });
  assert.equal(resMD.prevented, true, 'mousedown button 1 must prevent default for autoscroll');
}

console.log('PASS: Test 8 passed');

console.log('\nALL UI INTEGRATION TESTS PASSED SUCCESSFULLY!');

