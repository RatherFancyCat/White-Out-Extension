'use strict';

let wordMap = {};
let settings = { autoCapitalize: false, blacklistedDomains: [] };
let applying = false;

// Flag to suppress auto-capitalisation for the current sentence (mirrors content.js)
let skipCapForThisSentence = false;

const DEFAULT_CURSOR_LOCATOR_KEY = 'Alt+Q';

// Secret options state
let secretOptions = {
  revealed: false,
  highlightCorrections: false,
  correctionFlair: false,
  xpBar: false,
  xpBarXp: 0,
  cursorLocator: false,
  cursorLocatorKey: DEFAULT_CURSOR_LOCATOR_KEY,
  wordTrail: false,
  wordTrailColor: '#4C90D6',
  wordTrailRgb: false,
};
let cbStats = { wordsAdded: 0, correctionsApplied: 0 };
let cbAchievements = {};

const PUNCT_CLASS = ".,!?;:'\"()\\[\\]{}\\-\\/\\\\«»\u201C\u201D\u2018\u2019";
const SEPARATOR_RE = new RegExp('[\\s' + PUNCT_CLASS + ']');
const SENTENCE_END_RE = /[.!?]/;
const LEADING_PUNCT_RE = new RegExp('^[' + PUNCT_CLASS + ']+');
const TRAILING_PUNCT_RE = new RegExp('[' + PUNCT_CLASS + ']+$');
const FLAIR_OPTIONS = ['✨', '🎉', '⭐', '💫', '✅'];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Returns true when a KeyboardEvent matches a stored keybind string
 * like "Alt+K", "Ctrl+Shift+F", etc.
 */
function matchesKeybind(event, keybindStr) {
  if (!keybindStr) return false;
  const parts = keybindStr.split('+');
  const mainKey = parts[parts.length - 1];
  const needsAlt = parts.includes('Alt');
  const needsCtrl = parts.includes('Ctrl');
  const needsShift = parts.includes('Shift');
  const needsMeta = parts.includes('Meta');
  const eventKey = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const bindKey = mainKey.length === 1 ? mainKey.toUpperCase() : mainKey;
  return (
    eventKey === bindKey &&
    event.altKey === needsAlt &&
    event.ctrlKey === needsCtrl &&
    event.shiftKey === needsShift &&
    event.metaKey === needsMeta
  );
}

/**
 * Format a KeyboardEvent into a human-readable keybind string like "Alt+Q".
 * Returns null when only modifier keys are pressed (no main key yet).
 */
function formatKeybind(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  const key = event.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

function loadAll(callback) {
  chrome.storage.local.get(
    ['wordMap', 'settings', 'language', 'secretOptions', 'cbStats', 'cbAchievements', 'theme'],
    (data) => {
      wordMap = data.wordMap || {};
      settings = data.settings || { autoCapitalize: false, blacklistedDomains: [] };
      secretOptions = data.secretOptions || {
        revealed: false,
        highlightCorrections: false,
        correctionFlair: false,
        xpBar: false,
        xpBarXp: 0,
        cursorLocator: false,
        cursorLocatorKey: DEFAULT_CURSOR_LOCATOR_KEY,
        wordTrail: false,
        wordTrailColor: '#4C90D6',
        wordTrailRgb: false,
      };
      cbStats = data.cbStats || { wordsAdded: 0, correctionsApplied: 0 };
      cbAchievements = data.cbAchievements || {};
      const lang = data.language || 'en';
      I18n._lang = lang;
      applyTheme(data.theme || 'light');
      if (callback) callback(lang);
    }
  );
}

function saveSecretOptions() {
  chrome.storage.local.set({ secretOptions });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  const btn = document.getElementById('headerThemeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.wordMap) {
    wordMap = changes.wordMap.newValue || {};
    renderWordList();
  }
  if (changes.settings) {
    settings = changes.settings.newValue || { autoCapitalize: false, blacklistedDomains: [] };
    if (!settings.autoCapitalize || !settings.skipCapEnabled) {
      skipCapForThisSentence = false;
    }
  }
  if (changes.language) {
    const lang = changes.language.newValue || 'en';
    I18n.apply(lang);
    renderWordList();
    // Re-render the "no corrections yet" placeholder if it is still showing
    const log = document.getElementById('correctionLog');
    if (log && log.querySelector('.no-corrections')) {
      log.innerHTML = `<li class="no-corrections">${I18n.t('sandbox-no-corrections')}</li>`;
    }
  }
  // cbAchievements must be updated BEFORE cbStats so that when both keys
  // change atomically (content.js saves them together after an unlock),
  // checkAndSaveAchievements() sees the already-updated map and
  // processAchievements() returns no new unlocks – preventing duplicate toasts.
  if (changes.cbAchievements) {
    cbAchievements = changes.cbAchievements.newValue || {};
  }
  if (changes.cbStats) {
    cbStats = changes.cbStats.newValue || { wordsAdded: 0, correctionsApplied: 0 };
    checkAndSaveAchievements();
  }
  if (changes.secretOptions) {
    secretOptions = changes.secretOptions.newValue || secretOptions;
    updateSecretUI();
  }
  if (changes.theme) {
    applyTheme(changes.theme.newValue || 'light');
  }
});

// ---------------------------------------------------------------------------
// Correction helpers (mirror of content.js logic)
// ---------------------------------------------------------------------------

function getCorrection(word) {
  if (!word) return null;
  if (Object.prototype.hasOwnProperty.call(wordMap, word)) return wordMap[word];

  const lower = word.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(wordMap, lower)) return null;

  const correction = wordMap[lower];
  if (word === word.toUpperCase() && word.length > 1) return correction.toUpperCase();
  if (word[0] !== word[0].toLowerCase()) {
    return correction[0].toUpperCase() + correction.slice(1);
  }
  return correction;
}

function correctTextarea(element) {
  if (applying) return;
  const value = element.value;
  const cursorPos = element.selectionStart;
  if (cursorPos === null || cursorPos === undefined) return;

  const charBefore = value[cursorPos - 1];
  if (!charBefore || !SEPARATOR_RE.test(charBefore)) return;

  const textBefore = value.substring(0, cursorPos - 1);
  const wordMatch = textBefore.match(/(\S+)$/);
  if (!wordMatch) return;

  const rawToken = wordMatch[1];
  // Strip leading and trailing separator characters so that words wrapped in
  // quotes or parentheses (e.g. "(nao)", '"nao"', «nao») are still matched.
  const strippedLeading = rawToken.replace(LEADING_PUNCT_RE, '');
  const typedWord = strippedLeading.replace(TRAILING_PUNCT_RE, '');
  if (!typedWord) return;
  const correction = getCorrection(typedWord);
  if (!correction) return;

  const leadingLen = rawToken.length - strippedLeading.length;
  const trailingLen = strippedLeading.length - typedWord.length;
  const wordStart = cursorPos - 1 - rawToken.length + leadingLen;

  applying = true;
  try {
    const newValue =
      value.substring(0, wordStart) + correction + value.substring(wordStart + typedWord.length);
    element.value = newValue;
    const newCursorPos = wordStart + correction.length + trailingLen + 1;
    element.setSelectionRange(newCursorPos, newCursorPos);
    logCorrection(typedWord, correction);
  } finally {
    applying = false;
  }

  // Secret features (called after applying = false so they don't interfere)
  showCorrectionFlair();
  highlightCorrectedWord(element, wordStart, correction.length);
  incrementCorrections();
}

// ---------------------------------------------------------------------------
// Auto-capitalise helpers (mirror of content.js logic)
// ---------------------------------------------------------------------------

function isAtSentenceStart(textBefore) {
  if (textBefore.length === 0) return true;
  let i = textBefore.length - 1;
  while (i >= 0 && (textBefore[i] === ' ' || textBefore[i] === '\t')) {
    i--;
  }
  if (i < 0) return true;
  const ch = textBefore[i];
  return ch === '\n' || SENTENCE_END_RE.test(ch);
}

function autoCapitalizeTextarea(element, event) {
  if (skipCapForThisSentence) return;
  if (!event || event.inputType !== 'insertText') return;
  const typedChar = event.data;
  if (!typedChar || typedChar.length !== 1) return;
  if (typedChar === typedChar.toUpperCase()) return;

  const value = element.value;
  const cursorPos = element.selectionStart;
  if (cursorPos === null || cursorPos < 1) return;

  const textBefore = value.substring(0, cursorPos - 1);
  if (!isAtSentenceStart(textBefore)) return;

  const upper = typedChar.toUpperCase();
  applying = true;
  try {
    element.value = value.substring(0, cursorPos - 1) + upper + value.substring(cursorPos);
    element.setSelectionRange(cursorPos, cursorPos);
  } finally {
    applying = false;
  }
}

// ---------------------------------------------------------------------------
// Correction log
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function logCorrection(original, corrected) {
  const log = document.getElementById('correctionLog');
  const placeholder = log.querySelector('.no-corrections');
  if (placeholder) placeholder.remove();

  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString(I18n.locale());
  li.innerHTML =
    `<span class="log-time">${time}</span>` +
    ` <span class="log-original">${escapeHtml(original)}</span>` +
    ` <span class="log-arrow">&#8594;</span>` +
    ` <span class="log-corrected">${escapeHtml(corrected)}</span>`;
  log.insertBefore(li, log.firstChild);

  // Keep at most 30 entries
  while (log.children.length > 30) {
    log.removeChild(log.lastChild);
  }
}

// ---------------------------------------------------------------------------
// Active word list panel
// ---------------------------------------------------------------------------

function renderWordList() {
  const container = document.getElementById('wordListContainer');
  const countEl = document.getElementById('wordCount');
  const entries = Object.entries(wordMap);

  countEl.textContent = entries.length;

  if (entries.length === 0) {
    container.innerHTML =
      `<p class="no-words">${I18n.t('sandbox-no-words')} ` +
      `<a href="#" id="goToOptions">${I18n.t('sandbox-go-options')}</a></p>`;
    attachGoToOptions();
    return;
  }

  const sorted = entries.sort((a, b) => a[0].localeCompare(b[0]));
  const rows = sorted
    .map(
      ([k, v]) =>
        `<tr><td class="wl-incorrect">${escapeHtml(k)}</td>` +
        `<td class="wl-arrow">&#8594;</td>` +
        `<td class="wl-correct">${escapeHtml(v)}</td></tr>`
    )
    .join('');

  container.innerHTML =
    '<table class="word-table">' +
    `<thead><tr><th>${I18n.t('sandbox-th-incorrect')}</th><th></th><th>${I18n.t('sandbox-th-correct')}</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
}

function attachGoToOptions() {
  const link = document.getElementById('goToOptions');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }
}

// ---------------------------------------------------------------------------
// Easter egg
// ---------------------------------------------------------------------------

const EASTER_EGG_PHRASE = 'ratherfancycat is a cool dude';

function checkEasterEgg() {
  const val = document.getElementById('testArea').value.toLowerCase();
  if (!val.includes(EASTER_EGG_PHRASE)) return;

  // Only act if at least one achievement is still locked
  const allAlreadyUnlocked = ACHIEVEMENT_DEFINITIONS.every((d) => cbAchievements[d.id]);
  if (allAlreadyUnlocked) return;

  // Unlock every achievement at once
  const now = new Date().toISOString();
  const newlyUnlocked = [];
  ACHIEVEMENT_DEFINITIONS.forEach((d) => {
    if (!cbAchievements[d.id]) {
      cbAchievements[d.id] = now;
      newlyUnlocked.push(d);
    }
  });
  chrome.storage.local.set({ cbAchievements });

  // Grant all rewards automatically
  secretOptions.highlightCorrections = true;
  secretOptions.correctionFlair = true;
  secretOptions.xpBar = true;
  secretOptions.cursorLocator = true;
  secretOptions.wordTrail = true;
  secretOptions.revealed = true;
  saveSecretOptions();

  revealSecretPanel();

  // Show a toast for each newly unlocked achievement, staggered
  newlyUnlocked.forEach((def, i) => {
    setTimeout(() => showAchievementToast(def), i * 400);
  });
}

function revealSecretPanel() {
  const panel = document.getElementById('secretPanel');
  if (!panel) return;
  panel.hidden = false;
  // Trigger the entrance animation on the next frame
  requestAnimationFrame(() => panel.classList.add('secret-revealed'));
  updateSecretUI();
}

// ---------------------------------------------------------------------------
// Secret features
// ---------------------------------------------------------------------------

function showCorrectionFlair() {
  if (!secretOptions.correctionFlair) return;
  const textarea = document.getElementById('testArea');
  const rect = textarea.getBoundingClientRect();
  const flair = document.createElement('div');
  flair.className = 'correction-flair';
  flair.textContent = FLAIR_OPTIONS[Math.floor(Math.random() * FLAIR_OPTIONS.length)];
  flair.style.left = (rect.left + Math.random() * Math.max(rect.width - 30, 10)) + 'px';
  flair.style.top = (rect.top + Math.random() * Math.max(rect.height / 2, 10)) + 'px';
  document.body.appendChild(flair);
  setTimeout(() => flair.remove(), 800);
}

function highlightCorrectedWord(element, wordStart, wordLength) {
  if (!secretOptions.highlightCorrections) return;
  const wrapper = element.closest('.textarea-wrapper');
  if (!wrapper) return;

  // Build a hidden mirror div that exactly replicates the textarea's text layout
  // so we can measure the pixel position of the corrected word.
  const cs = window.getComputedStyle(element);
  const mirror = document.createElement('div');
  [
    'boxSizing', 'width',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'wordSpacing', 'tabSize', 'lineHeight',
  ].forEach((p) => { mirror.style[p] = cs[p]; });
  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  mirror.style.height = element.offsetHeight + 'px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';

  const text = element.value;
  const markEl = document.createElement('mark');
  markEl.textContent = text.substring(wordStart, wordStart + wordLength);
  mirror.appendChild(document.createTextNode(text.substring(0, wordStart)));
  mirror.appendChild(markEl);
  wrapper.appendChild(mirror);
  mirror.scrollTop = element.scrollTop;

  const markRect = markEl.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();
  mirror.remove();

  if (markRect.width === 0 || markRect.height === 0) return;

  const hl = document.createElement('div');
  hl.className = 'correction-word-flash';
  hl.style.left = (markRect.left - wrapperRect.left) + 'px';
  hl.style.top = (markRect.top - wrapperRect.top) + 'px';
  hl.style.width = markRect.width + 'px';
  hl.style.height = markRect.height + 'px';
  wrapper.appendChild(hl);
  setTimeout(() => hl.remove(), 1500);
}

/**
 * Show a beacon overlay pointing at the cursor's current position inside
 * the test-area textarea. Triggered by the Alt+Q keybind.
 */
function showCursorLocatorSandbox() {
  if (!secretOptions.cursorLocator) return;
  const element = document.getElementById('testArea');
  const wrapper = element.closest('.textarea-wrapper');
  if (!wrapper) return;

  const cs = window.getComputedStyle(element);
  const mirror = document.createElement('div');
  [
    'boxSizing', 'width',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'wordSpacing', 'tabSize', 'lineHeight',
  ].forEach((p) => { mirror.style[p] = cs[p]; });
  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  mirror.style.height = element.offsetHeight + 'px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';

  const pos = element.selectionStart || 0;
  const cursorSpan = document.createElement('span');
  cursorSpan.textContent = '\u200B'; // zero-width space marks cursor position
  mirror.appendChild(document.createTextNode(element.value.substring(0, pos)));
  mirror.appendChild(cursorSpan);
  wrapper.appendChild(mirror);
  mirror.scrollTop = element.scrollTop;

  const spanRect = cursorSpan.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();
  mirror.remove();

  if (spanRect.height === 0) return;

  const x = spanRect.left - wrapperRect.left;
  const y = spanRect.top - wrapperRect.top;

  const arrow = document.createElement('div');
  arrow.className = 'cursor-locator-arrow';
  arrow.textContent = '▼';
  arrow.style.left = (x - 10) + 'px';
  arrow.style.top = (y - 28) + 'px';
  wrapper.appendChild(arrow);

  const ring = document.createElement('div');
  ring.className = 'cursor-locator-ring';
  ring.style.left = (x - 10) + 'px';
  ring.style.top = (y - 2) + 'px';
  wrapper.appendChild(ring);

  setTimeout(() => { arrow.remove(); ring.remove(); }, 2500);
}

// ---------------------------------------------------------------------------
// Word Trail
// ---------------------------------------------------------------------------

const WORD_TRAIL_OPACITIES = [0.30, 0.25, 0.20, 0.15, 0.10];
const WORD_TRAIL_DEFAULT_COLOR = '#4C90D6';

// Trail state – kept in memory, not persisted
let wordTrailEntries = []; // [{ start, length, hue }, ...] most recent first
let wordTrailRgbHue = 0;   // in-memory hue (0–360), advances per word

/** Convert #rrggbb + alpha to an rgba() colour string. */
function hexToRgbaSandbox(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Remove all current word trail overlays from the document. */
function clearWordTrailOverlaysSandbox() {
  document.querySelectorAll('[data-cb-trail]').forEach((el) => el.remove());
}

/**
 * Re-render all trail overlays for the sandbox test area.
 * Uses position:fixed overlays (viewport-relative) for simplicity.
 */
function renderWordTrailSandbox() {
  clearWordTrailOverlaysSandbox();
  if (!wordTrailEntries.length) return;

  const element = document.getElementById('testArea');
  if (!element) return;

  const cs = window.getComputedStyle(element);
  const STYLE_PROPS = [
    'boxSizing', 'width',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'wordSpacing', 'tabSize', 'lineHeight',
  ];

  wordTrailEntries.forEach(({ start, length, hue }, i) => {
    const opacity = WORD_TRAIL_OPACITIES[i];

    const mirror = document.createElement('div');
    STYLE_PROPS.forEach((p) => { mirror.style[p] = cs[p]; });
    const elRect = element.getBoundingClientRect();
    Object.assign(mirror.style, {
      position: 'fixed',
      top: elRect.top + 'px',
      left: elRect.left + 'px',
      visibility: 'hidden',
      overflow: 'hidden',
      height: element.offsetHeight + 'px',
      whiteSpace: 'pre-wrap',
      wordWrap: 'break-word',
    });

    const text = element.value;
    const markEl = document.createElement('mark');
    markEl.textContent = text.substring(start, start + length);
    mirror.appendChild(document.createTextNode(text.substring(0, start)));
    mirror.appendChild(markEl);
    document.body.appendChild(mirror);
    mirror.scrollTop = element.scrollTop;
    const markRect = markEl.getBoundingClientRect();
    mirror.remove();

    if (markRect.width === 0 || markRect.height === 0) return;

    let bgColor;
    if (hue >= 0) {
      bgColor = `hsla(${hue},100%,60%,${opacity})`;
    } else {
      const base = (secretOptions.wordTrailColor && /^#[0-9a-fA-F]{6}$/.test(secretOptions.wordTrailColor))
        ? secretOptions.wordTrailColor
        : WORD_TRAIL_DEFAULT_COLOR;
      bgColor = hexToRgbaSandbox(base, opacity);
    }

    const overlay = document.createElement('div');
    overlay.setAttribute('data-cb-trail', '1');
    Object.assign(overlay.style, {
      position: 'fixed',
      left: markRect.left + 'px',
      top: markRect.top + 'px',
      width: markRect.width + 'px',
      height: markRect.height + 'px',
      background: bgColor,
      borderRadius: '2px',
      pointerEvents: 'none',
      zIndex: '2',
    });
    document.body.appendChild(overlay);
  });
}

/**
 * Detect the most recently completed word in the test area (at a separator
 * boundary) and add it to the trail.  Called from the testArea input handler
 * on every keystroke — independently of whether a correction was made.
 */
function trackWordTrailSandbox(element) {
  if (!secretOptions.wordTrail) return;

  const value = element.value;
  const cursorPos = element.selectionStart;
  if (cursorPos === null || cursorPos === undefined) return;

  const charBefore = value[cursorPos - 1];
  if (!charBefore || !SEPARATOR_RE.test(charBefore)) return;

  const textBefore = value.substring(0, cursorPos - 1);
  const wordMatch = textBefore.match(/(\S+)$/);
  if (!wordMatch) return;

  const rawToken = wordMatch[1];
  const strippedLeading = rawToken.replace(LEADING_PUNCT_RE, '');
  const word = strippedLeading.replace(TRAILING_PUNCT_RE, '');
  if (!word) return;

  const leadingLen = rawToken.length - strippedLeading.length;
  const wordStart = cursorPos - 1 - rawToken.length + leadingLen;

  // Advance RGB hue if the rainbow mode is on
  if (secretOptions.wordTrailRgb) {
    wordTrailRgbHue = (wordTrailRgbHue + 30) % 360;
  }

  const hue = secretOptions.wordTrailRgb ? wordTrailRgbHue : -1;
  wordTrailEntries.unshift({ start: wordStart, length: word.length, hue });
  if (wordTrailEntries.length > WORD_TRAIL_OPACITIES.length) {
    wordTrailEntries.length = WORD_TRAIL_OPACITIES.length;
  }

  renderWordTrailSandbox();
}

function incrementCorrections() {
  chrome.storage.local.get('cbStats', (data) => {
    const stats = data.cbStats || { wordsAdded: 0, correctionsApplied: 0 };
    stats.correctionsApplied = (stats.correctionsApplied || 0) + 1;
    cbStats = stats;
    if (secretOptions.xpBar) {
      secretOptions.xpBarXp = (secretOptions.xpBarXp || 0) + 1;
      chrome.storage.local.set({ cbStats: stats, secretOptions }, checkAndSaveAchievements);
    } else {
      chrome.storage.local.set({ cbStats: stats }, checkAndSaveAchievements);
    }
  });
}

// ---------------------------------------------------------------------------
// XP / Level helpers
// ---------------------------------------------------------------------------

/**
 * Compute the current level and XP progress from a total XP value.
 * Required XP to level up from level N = N * 6.
 * (Total XP to reach level N = 3 * N * (N - 1).)
 *
 * @param {number} totalXp
 * @returns {{ level: number, currentXp: number, requiredXp: number }}
 */
function computeLevel(totalXp) {
  let level = 1;
  let xpUsed = 0;
  while (true) {
    const needed = level * 6;
    if (xpUsed + needed > totalXp) break;
    xpUsed += needed;
    level++;
  }
  return { level, currentXp: totalXp - xpUsed, requiredXp: level * 6 };
}

/** Refresh the XP bar widget to reflect the current XP earned while the option is enabled. */
function updateXpBar() {
  const fill = document.getElementById('xpBarFill');
  const levelEl = document.getElementById('xpBarLevel');
  if (!fill || !levelEl) return;
  const { level, currentXp, requiredXp } = computeLevel(secretOptions.xpBarXp || 0);
  fill.style.width = (requiredXp > 0 ? Math.min(100, (currentXp / requiredXp) * 100) : 0) + '%';
  levelEl.textContent = level;
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

function checkAndSaveAchievements() {
  const { newlyUnlocked, updated } = processAchievements(cbStats, cbAchievements);
  if (newlyUnlocked.length > 0) {
    cbAchievements = updated;
    chrome.storage.local.set({ cbAchievements: updated });

    let secretChanged = false;
    let shouldReveal = false;

    // Show a toast and apply any reward for each newly unlocked achievement
    newlyUnlocked.forEach((id, i) => {
      const def = ACHIEVEMENT_DEFINITIONS.find((d) => d.id === id);
      if (!def) return;

      if (def.reward === 'highlight' && !secretOptions.highlightCorrections) {
        secretOptions.highlightCorrections = true;
        secretChanged = true;
        shouldReveal = true;
      } else if (def.reward === 'flair' && !secretOptions.correctionFlair) {
        secretOptions.correctionFlair = true;
        secretChanged = true;
        shouldReveal = true;
      } else if (def.reward === 'xpbar') {
        shouldReveal = true;
      } else if (def.reward === 'cursorlocator') {
        shouldReveal = true;
      } else if (def.reward === 'wordtrail' || def.reward === 'wordtrailcolor' || def.reward === 'wordtrailrgb') {
        shouldReveal = true;
      }

      setTimeout(() => showAchievementToast(def), i * 400);
    });

    if (shouldReveal) {
      secretOptions.revealed = true;
      secretChanged = true;
      revealSecretPanel();
    }

    if (secretChanged) {
      saveSecretOptions();
    }
  }
  // Always keep the XP bar up to date whenever stats change
  updateXpBar();
}

// ---------------------------------------------------------------------------
// Achievement toast notifications
// ---------------------------------------------------------------------------

function showAchievementToast(def) {
  const DISPLAY_MS = 7000;
  const SLIDE_MS = 400;

  // Stack toasts upward: each new toast sits above existing ones
  const existing = document.querySelectorAll('.ach-toast');
  const bottomOffset = 20 + existing.length * 130;

  // ── Outer toast container ────────────────────────────────────────────────
  const toast = document.createElement('div');
  toast.className = 'ach-toast';
  toast.style.bottom = bottomOffset + 'px';
  toast.style.flexDirection = 'column';
  toast.style.gap = '8px';
  toast.style.padding = '12px 16px 10px';
  toast.style.width = '340px';
  toast.style.pointerEvents = 'auto';

  // ── Top row: icon + text + dismiss ──────────────────────────────────────
  const topRow = document.createElement('div');
  Object.assign(topRow.style, { display: 'flex', alignItems: 'center', gap: '10px' });

  topRow.innerHTML =
    `<span class="ach-toast-icon">🏆</span>` +
    `<div class="ach-toast-body" style="flex:1">` +
    `<strong>${I18n.t('ach-toast-title')}</strong>` +
    `<span title="${escapeHtml(I18n.t('ach-' + def.id + '-name'))}">${escapeHtml(I18n.t('ach-' + def.id + '-name'))}</span>` +
    `</div>`;

  const dismissBtn = document.createElement('button');
  Object.assign(dismissBtn.style, {
    background: 'rgba(255,255,255,0.20)',
    border: 'none',
    color: '#fff',
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    cursor: 'pointer',
    fontSize: '13px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: '0',
    alignSelf: 'flex-start',
    padding: '0',
    lineHeight: '1',
  });
  dismissBtn.textContent = '✕';
  dismissBtn.addEventListener('click', () => slideOut());
  topRow.appendChild(dismissBtn);

  // ── Bottom row: action buttons ───────────────────────────────────────────
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '6px', justifyContent: 'flex-end' });

  const makeBtn = (label) => {
    const b = document.createElement('button');
    Object.assign(b.style, {
      background: 'rgba(255,255,255,0.20)',
      border: '1px solid rgba(255,255,255,0.35)',
      color: '#fff',
      borderRadius: '6px',
      padding: '4px 10px',
      fontSize: '12px',
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontWeight: '600',
      whiteSpace: 'nowrap',
    });
    b.textContent = label;
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.35)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'rgba(255,255,255,0.20)'; });
    return b;
  };

  // "View Achievements" — shows an in-page achievement list panel
  const viewListBtn = makeBtn(I18n.t('ach-toast-btn-view-list'));
  viewListBtn.addEventListener('click', () => {
    slideOut();
    showAchievementListPanelSandbox();
  });
  btnRow.appendChild(viewListBtn);

  // "View Reward" — only when the achievement has a reward;
  // on the sandbox page we scroll to the secret panel directly
  if (def.reward) {
    const viewRewardBtn = makeBtn(I18n.t('ach-toast-btn-view-reward'));
    viewRewardBtn.addEventListener('click', () => {
      slideOut();
      const panel = document.getElementById('secretPanel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    btnRow.appendChild(viewRewardBtn);
  }

  toast.appendChild(topRow);
  toast.appendChild(btnRow);
  document.body.appendChild(toast);

  // ── Auto-slide lifecycle ─────────────────────────────────────────────────
  let dismissed = false;
  let slideOutTimer;

  function slideOut() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(slideOutTimer);
    toast.classList.remove('ach-toast-visible');
    setTimeout(() => toast.remove(), SLIDE_MS);
  }

  // Slide in on next frame
  requestAnimationFrame(() => toast.classList.add('ach-toast-visible'));

  // Slide out after DISPLAY_MS
  slideOutTimer = setTimeout(slideOut, DISPLAY_MS);
}

// ---------------------------------------------------------------------------
// In-page achievement list panel (used by sandbox toast "View Achievements")
// ---------------------------------------------------------------------------

function showAchievementListPanelSandbox() {
  if (document.getElementById('__cb_ach_panel__')) return;

  // ── Backdrop ──────────────────────────────────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.id = '__cb_ach_panel__';
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    background: 'rgba(0,0,0,0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: '9999',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  // ── Dialog ────────────────────────────────────────────────────────────
  const dialog = document.createElement('div');
  Object.assign(dialog.style, {
    background: '#fff',
    borderRadius: '12px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
    width: '480px',
    maxWidth: '90vw',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxSizing: 'border-box',
  });

  // ── Header ────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '18px 20px',
    borderBottom: '1px solid #eee',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: '#fff',
    flexShrink: '0',
  });

  const headerTitle = document.createElement('h2');
  Object.assign(headerTitle.style, {
    margin: '0', fontSize: '17px', fontWeight: '700', color: '#fff',
  });
  headerTitle.textContent = I18n.t('modal-achievements-h2');

  const closeBtn = document.createElement('button');
  Object.assign(closeBtn.style, {
    background: 'rgba(255,255,255,0.2)',
    border: 'none',
    color: '#fff',
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    cursor: 'pointer',
    fontSize: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  });
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => backdrop.remove());

  header.appendChild(headerTitle);
  header.appendChild(closeBtn);

  // ── Achievement list ──────────────────────────────────────────────────
  const listEl = document.createElement('div');
  Object.assign(listEl.style, { overflowY: 'auto', padding: '16px', flex: '1' });

  const unlockedCount = ACHIEVEMENT_DEFINITIONS.filter((d) => cbAchievements[d.id]).length;

  const summary = document.createElement('div');
  Object.assign(summary.style, {
    textAlign: 'center', fontSize: '13px', color: '#888',
    marginBottom: '14px', padding: '8px', background: '#f8f9fa', borderRadius: '6px',
  });
  summary.textContent = I18n.t('ach-summary', {
    unlocked: unlockedCount, total: ACHIEVEMENT_DEFINITIONS.length,
  });
  listEl.appendChild(summary);

  for (const def of ACHIEVEMENT_DEFINITIONS) {
    const unlockedAt = cbAchievements[def.id];
    const isUnlocked = !!unlockedAt;

    const item = document.createElement('div');
    Object.assign(item.style, {
      display: 'flex', alignItems: 'flex-start', gap: '12px',
      padding: '12px', borderRadius: '8px', marginBottom: '8px',
      border: '1px solid ' + (isUnlocked ? '#86efac' : '#eee'),
      background: isUnlocked ? '#f0fdf4' : '#fafafa',
      opacity: isUnlocked ? '1' : '0.65',
    });

    const itemIcon = document.createElement('div');
    Object.assign(itemIcon.style, { fontSize: '24px', flexShrink: '0', marginTop: '1px' });
    itemIcon.textContent = isUnlocked ? '🏆' : '🔒';

    const info = document.createElement('div');
    Object.assign(info.style, { display: 'flex', flexDirection: 'column', gap: '3px', flex: '1' });

    const achName = document.createElement('strong');
    Object.assign(achName.style, { fontSize: '14px', color: '#333' });
    achName.textContent = I18n.t('ach-' + def.id + '-name');

    const achDesc = document.createElement('span');
    Object.assign(achDesc.style, { fontSize: '12px', color: '#666' });
    achDesc.textContent = I18n.t('ach-' + def.id + '-desc');

    const rewardText = def.reward
      ? I18n.t('ach-reward-' + def.reward)
      : I18n.t('ach-reward-none');
    const achReward = document.createElement('span');
    Object.assign(achReward.style, { fontSize: '11px', color: '#999', fontStyle: 'italic' });
    achReward.textContent = I18n.t('ach-reward-label') + ' ' + rewardText;

    info.appendChild(achName);
    info.appendChild(achDesc);
    info.appendChild(achReward);

    if (unlockedAt) {
      const achDate = document.createElement('span');
      Object.assign(achDate.style, {
        fontSize: '11px', color: '#22c55e', fontWeight: '600', marginTop: '2px',
      });
      achDate.textContent = I18n.t('ach-unlocked-on') + ' ' + new Date(unlockedAt).toLocaleString(I18n.locale());
      info.appendChild(achDate);
    }

    item.appendChild(itemIcon);
    item.appendChild(info);
    listEl.appendChild(item);
  }

  dialog.appendChild(header);
  dialog.appendChild(listEl);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
}

// ---------------------------------------------------------------------------
// Secret UI state
// ---------------------------------------------------------------------------

function updateSecretUI() {
  const optHighlight = document.getElementById('optHighlight');
  const optFlair = document.getElementById('optFlair');
  const optXpBar = document.getElementById('optXpBar');
  const optCursorLocator = document.getElementById('optCursorLocator');
  if (!optHighlight) return; // DOM not ready yet

  optHighlight.checked = !!secretOptions.highlightCorrections;
  optFlair.checked = !!secretOptions.correctionFlair;
  if (optXpBar) optXpBar.checked = !!secretOptions.xpBar;
  if (optCursorLocator) optCursorLocator.checked = !!secretOptions.cursorLocator;

  // Show each reward row only if its corresponding achievement has been earned
  const highlightEarned = ACHIEVEMENT_DEFINITIONS.some((d) => d.reward === 'highlight' && cbAchievements[d.id]);
  const flairEarned = ACHIEVEMENT_DEFINITIONS.some((d) => d.reward === 'flair' && cbAchievements[d.id]);
  const xpBarEarned = ACHIEVEMENT_DEFINITIONS.some((d) => d.reward === 'xpbar' && cbAchievements[d.id]);
  const cursorLocatorEarned = ACHIEVEMENT_DEFINITIONS.some((d) => d.reward === 'cursorlocator' && cbAchievements[d.id]);
  const wordTrailEarned = ACHIEVEMENT_DEFINITIONS.some((d) => d.reward === 'wordtrail' && cbAchievements[d.id]);
  const wordTrailColorEarned = ACHIEVEMENT_DEFINITIONS.some((d) => d.reward === 'wordtrailcolor' && cbAchievements[d.id]);
  const wordTrailRgbEarned = ACHIEVEMENT_DEFINITIONS.some((d) => d.reward === 'wordtrailrgb' && cbAchievements[d.id]);

  const highlightRow = document.getElementById('optHighlightRow');
  const flairRow = document.getElementById('optFlairRow');
  const xpBarRow = document.getElementById('optXpBarRow');
  const cursorLocatorRow = document.getElementById('optCursorLocatorRow');
  const wordTrailRow = document.getElementById('optWordTrailRow');
  if (highlightRow) highlightRow.hidden = !highlightEarned;
  if (flairRow) flairRow.hidden = !flairEarned;
  if (xpBarRow) xpBarRow.hidden = !xpBarEarned;
  if (cursorLocatorRow) cursorLocatorRow.hidden = !cursorLocatorEarned;
  if (wordTrailRow) wordTrailRow.hidden = !wordTrailEarned;

  // Show/hide and hydrate the cursor locator keybind row
  const cursorLocatorKeyRow = document.getElementById('cursorLocatorKeyRow');
  const cursorLocatorKeyInput = document.getElementById('cursorLocatorKeyInput');
  if (cursorLocatorKeyRow) cursorLocatorKeyRow.hidden = !secretOptions.cursorLocator;
  if (cursorLocatorKeyInput) cursorLocatorKeyInput.value = secretOptions.cursorLocatorKey || DEFAULT_CURSOR_LOCATOR_KEY;

  // Show/hide the XP bar widget based on whether the option is enabled
  const xpBarWidget = document.getElementById('xpBarWidget');
  const xpBarDesc = document.getElementById('xpBarDesc');
  if (xpBarWidget) xpBarWidget.hidden = !secretOptions.xpBar;
  if (xpBarDesc) xpBarDesc.hidden = !!secretOptions.xpBar;
  if (secretOptions.xpBar) updateXpBar();

  // Word trail: sync checkbox, colour picker, and RGB toggle visibility
  const optWordTrail = document.getElementById('optWordTrail');
  const optWordTrailRgb = document.getElementById('optWordTrailRgb');
  if (optWordTrail) optWordTrail.checked = !!secretOptions.wordTrail;
  if (optWordTrailRgb) optWordTrailRgb.checked = !!secretOptions.wordTrailRgb;

  const wordTrailColorRow = document.getElementById('wordTrailColorRow');
  const wordTrailColorInput = document.getElementById('wordTrailColorInput');
  if (wordTrailColorRow) wordTrailColorRow.hidden = !(wordTrailColorEarned && secretOptions.wordTrail);
  if (wordTrailColorInput) wordTrailColorInput.value = secretOptions.wordTrailColor || WORD_TRAIL_DEFAULT_COLOR;

  const wordTrailRgbRow = document.getElementById('wordTrailRgbRow');
  if (wordTrailRgbRow) wordTrailRgbRow.hidden = !(wordTrailRgbEarned && secretOptions.wordTrail);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  loadAll((lang) => {
    I18n.apply(lang);
    renderWordList();

    // Show secret panel immediately if already revealed in a previous session
    if (secretOptions.revealed) {
      const panel = document.getElementById('secretPanel');
      if (panel) {
        panel.hidden = false;
        panel.classList.add('secret-revealed');
      }
      updateSecretUI();
    }

    // Process any achievements that may have been earned while the page was closed
    checkAndSaveAchievements();
  });

  const testArea = document.getElementById('testArea');

  // Skip-cap keybind + Alt+Q cursor locator listener on the test area
  testArea.addEventListener('keydown', (e) => {
    // Skip-capitalisation keybind
    if (settings.autoCapitalize && settings.skipCapEnabled) {
      if (matchesKeybind(e, settings.skipCapKey || 'Alt+K')) {
        skipCapForThisSentence = true;
        e.preventDefault();
        return;
      }
    }

    // Cursor locator Alt+Q keybind
    if (secretOptions.cursorLocator && matchesKeybind(e, secretOptions.cursorLocatorKey || DEFAULT_CURSOR_LOCATOR_KEY)) {
      showCursorLocatorSandbox();
      e.preventDefault();
    }
  });

  testArea.addEventListener('input', (event) => {
    if (applying) return;
    if (Object.keys(wordMap).length > 0) correctTextarea(testArea);
    trackWordTrailSandbox(testArea);
    if (settings.autoCapitalize) {
      // Reset skip flag when a sentence-ending character or newline is typed
      if (skipCapForThisSentence && settings.skipCapEnabled) {
        const typedChar = event.data;
        const inputType = event.inputType;
        if (
          (typedChar && (SENTENCE_END_RE.test(typedChar) || typedChar === '\n')) ||
          inputType === 'insertParagraph' ||
          inputType === 'insertLineBreak'
        ) {
          skipCapForThisSentence = false;
        }
      }
      autoCapitalizeTextarea(testArea, event);
    }
    checkEasterEgg();
  });

  // Re-render word trail overlays after any scroll so they track their words.
  // Throttled via rAF to avoid redundant repaints within the same frame.
  let _sandboxTrailScrollRaf = null;
  const _reRenderTrailOnScroll = () => {
    if (!secretOptions.wordTrail || !wordTrailEntries.length) return;
    if (_sandboxTrailScrollRaf) return;
    _sandboxTrailScrollRaf = requestAnimationFrame(() => {
      _sandboxTrailScrollRaf = null;
      renderWordTrailSandbox();
    });
  };
  window.addEventListener('scroll', _reRenderTrailOnScroll, { passive: true });
  testArea.addEventListener('scroll', _reRenderTrailOnScroll, { passive: true });

  document.getElementById('clearTextBtn').addEventListener('click', () => {
    testArea.value = '';
    testArea.focus();
    const log = document.getElementById('correctionLog');
    log.innerHTML = `<li class="no-corrections">${I18n.t('sandbox-no-corrections')}</li>`;
    // Clear word trail
    wordTrailEntries = [];
    clearWordTrailOverlaysSandbox();
  });

  // Secret option checkboxes
  document.getElementById('optHighlight').addEventListener('change', (e) => {
    secretOptions.highlightCorrections = e.target.checked;
    saveSecretOptions();
  });
  document.getElementById('optFlair').addEventListener('change', (e) => {
    secretOptions.correctionFlair = e.target.checked;
    saveSecretOptions();
  });
  document.getElementById('optXpBar').addEventListener('change', (e) => {
    secretOptions.xpBar = e.target.checked;
    saveSecretOptions();
    const xpBarWidget = document.getElementById('xpBarWidget');
    const xpBarDesc = document.getElementById('xpBarDesc');
    if (xpBarWidget) xpBarWidget.hidden = !secretOptions.xpBar;
    if (xpBarDesc) xpBarDesc.hidden = !!secretOptions.xpBar;
    if (secretOptions.xpBar) updateXpBar();
  });
  document.getElementById('optCursorLocator').addEventListener('change', (e) => {
    secretOptions.cursorLocator = e.target.checked;
    const cursorLocatorKeyRow = document.getElementById('cursorLocatorKeyRow');
    if (cursorLocatorKeyRow) cursorLocatorKeyRow.hidden = !e.target.checked;
    saveSecretOptions();
  });

  // Word trail option
  document.getElementById('optWordTrail').addEventListener('change', (e) => {
    secretOptions.wordTrail = e.target.checked;
    saveSecretOptions();
    if (!secretOptions.wordTrail) {
      wordTrailEntries = [];
      clearWordTrailOverlaysSandbox();
    }
    updateSecretUI();
  });

  document.getElementById('wordTrailColorInput').addEventListener('input', (e) => {
    secretOptions.wordTrailColor = e.target.value;
    saveSecretOptions();
    if (secretOptions.wordTrail) renderWordTrailSandbox();
  });

  document.getElementById('optWordTrailRgb').addEventListener('change', (e) => {
    secretOptions.wordTrailRgb = e.target.checked;
    saveSecretOptions();
    if (secretOptions.wordTrail) renderWordTrailSandbox();
  });

  // Cursor locator keybind recording
  let cursorLocatorRecording = false;

  document.getElementById('cursorLocatorRecordBtn').addEventListener('click', () => {
    cursorLocatorRecording = !cursorLocatorRecording;
    const btn = document.getElementById('cursorLocatorRecordBtn');
    const input = document.getElementById('cursorLocatorKeyInput');
    if (cursorLocatorRecording) {
      btn.textContent = I18n.t('secret-opt-cursorlocator-recording');
      input.value = '…';
      input.classList.add('recording');
    } else {
      btn.textContent = I18n.t('secret-opt-cursorlocator-record-btn');
      input.value = secretOptions.cursorLocatorKey || DEFAULT_CURSOR_LOCATOR_KEY;
      input.classList.remove('recording');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!cursorLocatorRecording) return;
    e.preventDefault();
    if (e.key === 'Escape') {
      cursorLocatorRecording = false;
      document.getElementById('cursorLocatorRecordBtn').textContent = I18n.t('secret-opt-cursorlocator-record-btn');
      document.getElementById('cursorLocatorKeyInput').value = secretOptions.cursorLocatorKey || DEFAULT_CURSOR_LOCATOR_KEY;
      document.getElementById('cursorLocatorKeyInput').classList.remove('recording');
    } else {
      const formatted = formatKeybind(e);
      if (formatted) {
        secretOptions.cursorLocatorKey = formatted;
        document.getElementById('cursorLocatorKeyInput').value = formatted;
        cursorLocatorRecording = false;
        document.getElementById('cursorLocatorRecordBtn').textContent = I18n.t('secret-opt-cursorlocator-record-btn');
        document.getElementById('cursorLocatorKeyInput').classList.remove('recording');
        saveSecretOptions();
      }
    }
  });

  // Header theme toggle
  document.getElementById('headerThemeToggle').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    applyTheme(newTheme);
    chrome.storage.local.set({ theme: newTheme });
  });

  attachGoToOptions();
});
