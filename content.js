'use strict';

let wordMap = {};
let wordFormats = {};
let enabled = true;
let settings = { autoCapitalize: false, blacklistedDomains: [] };
let blockedByDomain = false;
let currentLang = 'en';

// Flag to prevent re-entrant corrections when we programmatically set element.value
let applying = false;

const FLAIR_OPTIONS = ['✨', '🎉', '⭐', '💫', '✅'];
let secretOptions = { revealed: false, highlightCorrections: false, correctionFlair: false, wordTrail: false, wordTrailColor: '#4C90D6', wordTrailRgb: false };

// Flag to suppress auto-capitalisation for the current sentence.
// Set by the user's keybind; cleared on the next sentence-ending character.
let skipCapForThisSentence = false;

// Set when Enter is pressed in a contenteditable while autoCapitalize is on.
// Causes the very next typed letter to be capitalised (Enter = sentence start).
let pendingCapitalizeAfterEnter = false;

// Characters that mark the end of a word
// PUNCT_CLASS is the non-whitespace subset; SEPARATOR_RE also includes \s.
const PUNCT_CLASS = ".,!?;:'\"()\\[\\]{}\\-\\/\\\\«»\u201C\u201D\u2018\u2019";
const SEPARATOR_RE = new RegExp('[\\s' + PUNCT_CLASS + ']');

// Used to strip wrapping punctuation from an extracted token so that words
// inside quotes or parentheses (e.g. "(nao)", '"nao"', «nao») are still
// matched in the word map.
const LEADING_PUNCT_RE = new RegExp('^[' + PUNCT_CLASS + ']+');
const TRAILING_PUNCT_RE = new RegExp('[' + PUNCT_CLASS + ']+$');

// Sentence-ending characters (for auto-capitalise)
const SENTENCE_END_RE = /[.!?]/;

// Block-level tags whose boundaries mark a new sentence start.
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TD', 'TH', 'PRE',
]);

/**
 * Returns the nearest block-level ancestor of `node` that is still a
 * descendant of (or equal to) `element`.  Falls back to `element` itself when
 * no block ancestor is found within `element`.
 * Used to scope sentence-start detection to a single paragraph / block so
 * that text from previous blocks does not count as preceding context.
 */
function getBlockRoot(node, element) {
  let cur = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  while (cur && cur !== element) {
    if (BLOCK_TAGS.has(cur.nodeName)) return cur;
    cur = cur.parentNode;
  }
  return element;
}

/** Capitalise the first character of a string, leaving the rest unchanged. */
function capitalizeFirst(s) {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

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
  // Normalise single characters to upper-case for case-insensitive comparison
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

function checkDomainBlock() {
  const hostname = window.location.hostname;
  const domains = (settings && settings.blacklistedDomains) || [];
  blockedByDomain = domains.some(
    (d) => d && (hostname === d || hostname.endsWith('.' + d))
  );
}

function loadSettings() {
  chrome.storage.local.get(['wordMap', 'wordFormats', 'enabled', 'settings', 'language', 'secretOptions'], (data) => {
    wordMap = data.wordMap || {};
    wordFormats = data.wordFormats || {};
    enabled = data.enabled !== false;
    settings = data.settings || { autoCapitalize: false, blacklistedDomains: [] };
    currentLang = data.language || 'en';
    secretOptions = data.secretOptions || { revealed: false, highlightCorrections: false, correctionFlair: false, wordTrail: false, wordTrailColor: '#4C90D6', wordTrailRgb: false };
    checkDomainBlock();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Update wordFormats first so recheckAllElements sees the latest formatting
  // when both wordMap and wordFormats change in the same storage.set() call.
  if (changes.wordFormats) {
    wordFormats = changes.wordFormats.newValue || {};
  }
  if (changes.wordMap) {
    wordMap = changes.wordMap.newValue || {};
    recheckAllElements();
  }
  if (changes.enabled !== undefined) enabled = changes.enabled.newValue !== false;
  if (changes.settings) {
    settings = changes.settings.newValue || { autoCapitalize: false, blacklistedDomains: [] };
    if (!settings.autoCapitalize || !settings.skipCapEnabled) {
      skipCapForThisSentence = false;
    }
    if (!settings.autoCapitalize) {
      pendingCapitalizeAfterEnter = false;
    }
    checkDomainBlock();
  }
  if (changes.language) currentLang = changes.language.newValue || 'en';
  if (changes.secretOptions) {
    const prev = secretOptions;
    secretOptions = changes.secretOptions.newValue || secretOptions;
    if (prev.wordTrail && !secretOptions.wordTrail) {
      clearWordTrailOverlays();
      wordTrailEntries = [];
    }
  }
});

loadSettings();

// Re-render word trail overlays after any scroll so they track their words.
// capture:true ensures we catch scrolls on inner scrollable elements too.
// Throttled via rAF to avoid redundant repaints within the same frame.
let _trailScrollRaf = null;
window.addEventListener('scroll', () => {
  if (!secretOptions.wordTrail || !wordTrailEntries.length) return;
  if (_trailScrollRaf) return;
  _trailScrollRaf = requestAnimationFrame(() => {
    _trailScrollRaf = null;
    renderWordTrailOverlays();
  });
}, { passive: true, capture: true });


// Uses capture so it fires even when a text field has focus.
document.addEventListener('keydown', (e) => {
  if (!enabled || blockedByDomain) return;

  // Skip-capitalisation keybind
  if (settings.autoCapitalize && settings.skipCapEnabled) {
    if (matchesKeybind(e, settings.skipCapKey || 'Alt+K')) {
      skipCapForThisSentence = true;
      e.preventDefault();
      return;
    }
  }

  // Cursor locator keybind – works in any text input on any page
  if (secretOptions.cursorLocator && matchesKeybind(e, secretOptions.cursorLocatorKey || 'Alt+Q')) {
    const el = document.activeElement;
    if (el) {
      const isTextInput =
        ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'password') ||
        !!el.isContentEditable;
      if (isTextInput) {
        showCursorLocator(el);
        e.preventDefault();
      }
    }
  }

  // On Enter (plain or Shift+Enter), correct the in-progress word in
  // contenteditable elements *before* the browser moves the cursor to a new
  // block.  For <textarea>, the normal input-event path already handles Enter
  // because '\n' is a separator character.
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    const el = document.activeElement;
    if (el && el.isContentEditable) {
      if (Object.keys(wordMap).length > 0) {
        correctLastWordInContentEditable(el);
      }
      if (settings.autoCapitalize) {
        pendingCapitalizeAfterEnter = true;
      }
    }
  }
}, true);

// ---------------------------------------------------------------------------
// Stats tracking (for achievements)
// ---------------------------------------------------------------------------

// Counts toasts currently on screen so each new one stacks above the last.
let __cbToastCount = 0;

/** Render an achievement toast notification on the active web page. */
function showAchievementToastOnPage(def) {
  const DISPLAY_MS = 7000;
  const SLIDE_MS = 400;

  const bottomOffset = 20 + __cbToastCount * 130;
  __cbToastCount++;

  // ── Outer toast container ────────────────────────────────────────────────
  const toast = document.createElement('div');
  Object.assign(toast.style, {
    position: 'fixed',
    right: '-380px',
    bottom: bottomOffset + 'px',
    width: '340px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: '#fff',
    borderRadius: '10px',
    padding: '12px 16px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.28)',
    transition: 'right ' + SLIDE_MS + 'ms cubic-bezier(0.34, 1.56, 0.64, 1)',
    zIndex: '2147483647',
    pointerEvents: 'auto',
    userSelect: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    boxSizing: 'border-box',
  });

  // ── Top row: icon + text + dismiss ──────────────────────────────────────
  const topRow = document.createElement('div');
  Object.assign(topRow.style, {
    display: 'flex', alignItems: 'center', gap: '10px',
  });

  const icon = document.createElement('span');
  Object.assign(icon.style, { fontSize: '26px', flexShrink: '0' });
  icon.textContent = '🏆';

  const body = document.createElement('div');
  Object.assign(body.style, {
    display: 'flex', flexDirection: 'column', gap: '2px',
    minWidth: '0', overflow: 'hidden', flex: '1',
  });

  const titleEl = document.createElement('strong');
  Object.assign(titleEl.style, {
    fontSize: '12px', letterSpacing: '0.3px', opacity: '0.85',
    textTransform: 'uppercase', display: 'block',
  });
  titleEl.textContent = I18n.t('ach-toast-title');

  const nameEl = document.createElement('span');
  Object.assign(nameEl.style, {
    fontSize: '14px', fontWeight: '600', whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis', display: 'block',
  });
  nameEl.textContent = I18n.t('ach-' + def.id + '-name');

  body.appendChild(titleEl);
  body.appendChild(nameEl);

  // Dismiss (×) button
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
  dismissBtn.title = I18n.t('ach-toast-btn-dismiss');
  dismissBtn.textContent = '✕';
  dismissBtn.addEventListener('click', () => slideOut());

  topRow.appendChild(icon);
  topRow.appendChild(body);
  topRow.appendChild(dismissBtn);

  // ── Bottom row: action buttons ───────────────────────────────────────────
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, {
    display: 'flex', gap: '6px', justifyContent: 'flex-end',
  });

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
    showAchievementListPanel();
  });
  btnRow.appendChild(viewListBtn);

  // "View Reward" — only when the achievement has a reward; opens sandbox tab
  if (def.reward) {
    const viewRewardBtn = makeBtn(I18n.t('ach-toast-btn-view-reward'));
    viewRewardBtn.addEventListener('click', () => {
      slideOut();
      chrome.runtime.sendMessage({ action: 'openSandbox' });
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
    toast.style.right = '-380px';
    setTimeout(() => {
      toast.remove();
      __cbToastCount = Math.max(0, __cbToastCount - 1);
    }, SLIDE_MS);
  }

  // Slide in on next frame
  requestAnimationFrame(() => { toast.style.right = '20px'; });

  // Slide out after DISPLAY_MS
  slideOutTimer = setTimeout(slideOut, DISPLAY_MS);
}

// ---------------------------------------------------------------------------
// In-page achievement list panel (shown when "View Achievements" is clicked)
// ---------------------------------------------------------------------------

function showAchievementListPanel() {
  // Only one panel at a time
  if (document.getElementById('__cb_ach_panel__')) return;

  chrome.storage.local.get(['cbAchievements'], (data) => {
    const achievements = data.cbAchievements || {};

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
      zIndex: '2147483646',
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
    Object.assign(listEl.style, {
      overflowY: 'auto',
      padding: '16px',
      flex: '1',
    });

    const unlockedCount = ACHIEVEMENT_DEFINITIONS.filter((d) => achievements[d.id]).length;

    const summary = document.createElement('div');
    Object.assign(summary.style, {
      textAlign: 'center',
      fontSize: '13px',
      color: '#888',
      marginBottom: '14px',
      padding: '8px',
      background: '#f8f9fa',
      borderRadius: '6px',
    });
    summary.textContent = I18n.t('ach-summary', {
      unlocked: unlockedCount,
      total: ACHIEVEMENT_DEFINITIONS.length,
    });
    listEl.appendChild(summary);

    for (const def of ACHIEVEMENT_DEFINITIONS) {
      const unlockedAt = achievements[def.id];
      const isUnlocked = !!unlockedAt;

      const item = document.createElement('div');
      Object.assign(item.style, {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '12px',
        borderRadius: '8px',
        marginBottom: '8px',
        border: '1px solid ' + (isUnlocked ? '#86efac' : '#eee'),
        background: isUnlocked ? '#f0fdf4' : '#fafafa',
        opacity: isUnlocked ? '1' : '0.65',
      });

      const itemIcon = document.createElement('div');
      Object.assign(itemIcon.style, { fontSize: '24px', flexShrink: '0', marginTop: '1px' });
      itemIcon.textContent = isUnlocked ? '🏆' : '🔒';

      const info = document.createElement('div');
      Object.assign(info.style, {
        display: 'flex', flexDirection: 'column', gap: '3px', flex: '1',
      });

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
        Object.assign(achDate.style, { fontSize: '11px', color: '#22c55e', fontWeight: '600', marginTop: '2px' });
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
  });
}

function recordCorrection() {
  chrome.storage.local.get(['cbStats', 'cbAchievements', 'secretOptions'], (data) => {
    const stats = data.cbStats || { wordsAdded: 0, correctionsApplied: 0 };
    stats.correctionsApplied = (stats.correctionsApplied || 0) + 1;

    // Increment XP whenever the XP bar feature is enabled, regardless of which page the
    // correction happened on. Previously this was only done in sandbox.js, causing XP to
    // be skipped for corrections made on other pages.
    const opts = data.secretOptions || { revealed: false, highlightCorrections: false, correctionFlair: false, wordTrail: false, wordTrailColor: '#4C90D6', wordTrailRgb: false };
    let secretChanged = false;
    if (opts.xpBar) {
      opts.xpBarXp = (opts.xpBarXp || 0) + 1;
      secretChanged = true;
    }

    const currentAchievements = data.cbAchievements || {};
    const { newlyUnlocked, updated } = processAchievements(stats, currentAchievements);

    if (newlyUnlocked.length > 0) {
      // Grant any rewards and mark the secret panel as revealed
      newlyUnlocked.forEach((id) => {
        const def = ACHIEVEMENT_DEFINITIONS.find((d) => d.id === id);
        if (!def) return;
        if (def.reward === 'highlight' && !opts.highlightCorrections) {
          opts.highlightCorrections = true;
          opts.revealed = true;
          secretChanged = true;
        } else if (def.reward === 'flair' && !opts.correctionFlair) {
          opts.correctionFlair = true;
          opts.revealed = true;
          secretChanged = true;
        } else if (
          (def.reward === 'xpbar' || def.reward === 'cursorlocator' ||
            def.reward === 'wordtrail' || def.reward === 'wordtrailcolor' ||
            def.reward === 'wordtrailrgb') && !opts.revealed
        ) {
          opts.revealed = true;
          secretChanged = true;
        }
      });

      // Save stats + newly unlocked achievements atomically (and secretOptions if changed).
      // Saving cbAchievements together with cbStats means sandbox.js's onChanged listener
      // will see the updated cbAchievements before it calls checkAndSaveAchievements(),
      // preventing duplicate toasts when the sandbox page is also open.
      const toSave = { cbStats: stats, cbAchievements: updated };
      if (secretChanged) {
        toSave.secretOptions = opts;
        secretOptions = opts;
      }
      chrome.storage.local.set(toSave, () => {
        newlyUnlocked.forEach((id, i) => {
          const def = ACHIEVEMENT_DEFINITIONS.find((d) => d.id === id);
          if (def) setTimeout(() => showAchievementToastOnPage(def), i * 400);
        });
      });
    } else {
      const toSave = { cbStats: stats };
      if (secretChanged) {
        toSave.secretOptions = opts;
        secretOptions = opts;
      }
      chrome.storage.local.set(toSave);
    }
  });
}

// ---------------------------------------------------------------------------
// Secret reward features
// ---------------------------------------------------------------------------

/**
 * Lazily inject the CSS keyframe animations needed by the reward effects.
 * Only runs once per document; uses an id-guard to avoid duplicates.
 */
function ensureContentStyles() {
  if (document.getElementById('__cb_content_styles__')) return;
  const s = document.createElement('style');
  s.id = '__cb_content_styles__';
  s.textContent =
    '@keyframes __cb_flair_float__{' +
    '0%{opacity:1;transform:translateY(0) scale(1) rotate(0deg)}' +
    '100%{opacity:0;transform:translateY(-60px) scale(1.5) rotate(20deg)}}' +
    '@keyframes __cb_word_flash__{' +
    '0%{opacity:.7}100%{opacity:0}}' +
    '@keyframes __cb_word_ring__{' +
    '0%{transform:scale(1);opacity:.9}' +
    '100%{transform:scale(1.35);opacity:0}}' +
    '@keyframes __cb_cursor_beacon__{' +
    '0%{opacity:1;transform:translateY(0)}' +
    '60%{opacity:1;transform:translateY(-5px)}' +
    '100%{opacity:0;transform:translateY(-14px)}}' +
    '@keyframes __cb_cursor_ring__{' +
    '0%{transform:scale(1);opacity:.9}' +
    '100%{transform:scale(2.8);opacity:0}}';
  (document.head || document.documentElement).appendChild(s);
}

/** Show a floating emoji burst near the element that was just corrected. */
function showCorrectionFlair(element) {
  if (!secretOptions.correctionFlair) return;
  ensureContentStyles();
  const rect = element.getBoundingClientRect();
  const flair = document.createElement('div');
  Object.assign(flair.style, {
    position: 'fixed',
    fontSize: '22px',
    left: (rect.left + Math.random() * Math.max(rect.width - 30, 10)) + 'px',
    top: (rect.top + Math.random() * Math.max(rect.height / 2, 10)) + 'px',
    pointerEvents: 'none',
    zIndex: '2147483647',
    userSelect: 'none',
    animation: '__cb_flair_float__ 0.8s ease-out forwards',
  });
  flair.textContent = FLAIR_OPTIONS[Math.floor(Math.random() * FLAIR_OPTIONS.length)];
  document.body.appendChild(flair);
  setTimeout(() => flair.remove(), 800);
}

/**
 * Overlay a brief green highlight over the corrected word in an input/textarea.
 * Uses the "mirror div" technique to measure the word's pixel position without
 * altering the element's content or cursor.
 */
function highlightCorrectedWord(element, wordStart, wordLength) {
  if (!secretOptions.highlightCorrections) return;
  ensureContentStyles();

  const cs = window.getComputedStyle(element);
  const mirror = document.createElement('div');
  [
    'boxSizing', 'width',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'wordSpacing', 'tabSize', 'lineHeight',
  ].forEach((p) => { mirror.style[p] = cs[p]; });

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
  markEl.textContent = text.substring(wordStart, wordStart + wordLength);
  mirror.appendChild(document.createTextNode(text.substring(0, wordStart)));
  mirror.appendChild(markEl);
  document.body.appendChild(mirror);
  mirror.scrollTop = element.scrollTop;

  const markRect = markEl.getBoundingClientRect();
  mirror.remove();

  if (markRect.width === 0 || markRect.height === 0) return;

  const hl = document.createElement('div');
  Object.assign(hl.style, {
    position: 'fixed',
    left: markRect.left + 'px',
    top: markRect.top + 'px',
    width: markRect.width + 'px',
    height: markRect.height + 'px',
    background: 'transparent',
    border: '2px solid rgba(74,144,217,0.85)',
    borderRadius: '4px',
    pointerEvents: 'none',
    zIndex: '2147483647',
    animation: '__cb_word_ring__ 1.5s ease-out forwards',
  });
  document.body.appendChild(hl);
  setTimeout(() => hl.remove(), 1500);
}

/**
 * Same as highlightCorrectedWord but for a contenteditable text node.
 * Uses the Range API to get the exact bounding rect of the word.
 */
function highlightCorrectedWordCE(node, wordStart, wordLength) {
  if (!secretOptions.highlightCorrections) return;
  ensureContentStyles();

  const startOffset = Math.min(wordStart, node.textContent.length);
  const endOffset = Math.min(wordStart + wordLength, node.textContent.length);
  if (startOffset >= endOffset) return;

  const range = document.createRange();
  range.setStart(node, startOffset);
  range.setEnd(node, endOffset);
  const markRect = range.getBoundingClientRect();

  if (markRect.width === 0 || markRect.height === 0) return;

  const hl = document.createElement('div');
  Object.assign(hl.style, {
    position: 'fixed',
    left: markRect.left + 'px',
    top: markRect.top + 'px',
    width: markRect.width + 'px',
    height: markRect.height + 'px',
    background: 'transparent',
    border: '2px solid rgba(74,144,217,0.85)',
    borderRadius: '4px',
    pointerEvents: 'none',
    zIndex: '2147483647',
    animation: '__cb_word_ring__ 1.5s ease-out forwards',
  });
  document.body.appendChild(hl);
  setTimeout(() => hl.remove(), 1500);
}

/**
 * Show a beacon pointing at the cursor's current position in the given element.
 * Triggered by the Alt+Q keybind when the cursor locator reward is active.
 */
function showCursorLocator(el) {
  if (!secretOptions.cursorLocator) return;
  ensureContentStyles();

  let cursorRect = null;

  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const cs = window.getComputedStyle(el);
    const mirror = document.createElement('div');
    [
      'boxSizing', 'width',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
      'wordSpacing', 'tabSize', 'lineHeight',
    ].forEach((p) => { mirror.style[p] = cs[p]; });

    const elRect = el.getBoundingClientRect();
    Object.assign(mirror.style, {
      position: 'fixed',
      top: elRect.top + 'px',
      left: elRect.left + 'px',
      visibility: 'hidden',
      overflow: 'hidden',
      height: el.offsetHeight + 'px',
      whiteSpace: 'pre-wrap',
      wordWrap: 'break-word',
    });

    const pos = el.selectionStart || 0;
    const cursorSpan = document.createElement('span');
    cursorSpan.textContent = '\u200B'; // zero-width space marks cursor position
    mirror.appendChild(document.createTextNode(el.value.substring(0, pos)));
    mirror.appendChild(cursorSpan);
    document.body.appendChild(mirror);
    mirror.scrollTop = el.scrollTop;
    cursorRect = cursorSpan.getBoundingClientRect();
    mirror.remove();
  } else if (el.isContentEditable) {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0).cloneRange();
      range.collapse(true);
      cursorRect = range.getBoundingClientRect();
    }
  }

  if (!cursorRect || cursorRect.height === 0) return;

  const x = cursorRect.left;
  const y = cursorRect.top;

  const arrow = document.createElement('div');
  Object.assign(arrow.style, {
    position: 'fixed',
    left: (x - 10) + 'px',
    top: (y - 28) + 'px',
    fontSize: '20px',
    color: '#4A90D9',
    pointerEvents: 'none',
    zIndex: '2147483647',
    userSelect: 'none',
    animation: '__cb_cursor_beacon__ 2.5s ease-out forwards',
  });
  arrow.textContent = '▼';
  document.body.appendChild(arrow);

  const ring = document.createElement('div');
  Object.assign(ring.style, {
    position: 'fixed',
    left: (x - 10) + 'px',
    top: (y - 2) + 'px',
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    border: '2px solid #4A90D9',
    pointerEvents: 'none',
    zIndex: '2147483647',
    animation: '__cb_cursor_ring__ 2.5s ease-out forwards',
  });
  document.body.appendChild(ring);

  setTimeout(() => { arrow.remove(); ring.remove(); }, 2500);
}

// ---------------------------------------------------------------------------
// Word Trail
// ---------------------------------------------------------------------------

const WORD_TRAIL_OPACITIES = [0.30, 0.25, 0.20, 0.15, 0.10];
const WORD_TRAIL_DEFAULT_COLOR = '#4C90D6';

// Trail state – in-memory only, per-tab
// Each entry: { type: 'input', element, start, length, hue }
//          or { type: 'ce',    node,    start, length, hue }
let wordTrailEntries = [];
let wordTrailRgbHue = 0; // advances 30° per word, not persisted

/** Convert #rrggbb to rgba() with the given alpha. */
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Remove all word trail overlays injected by this script. */
function clearWordTrailOverlays() {
  document.querySelectorAll('[data-cb-trail]').forEach((el) => el.remove());
}

const TRAIL_STYLE_PROPS = [
  'boxSizing', 'width',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
  'wordSpacing', 'tabSize', 'lineHeight',
];

/**
 * Re-render all trail overlays.  Called every time a new word is added so
 * positions are always fresh (relative to the current viewport).
 */
function renderWordTrailOverlays() {
  clearWordTrailOverlays();
  if (!wordTrailEntries.length) return;
  ensureContentStyles();

  wordTrailEntries.forEach(({ type, element, node, start, length, hue }, i) => {
    const opacity = WORD_TRAIL_OPACITIES[i];
    let markRect = null;

    if (type === 'input') {
      if (!element.isConnected) return;
      const cs = window.getComputedStyle(element);
      const mirror = document.createElement('div');
      TRAIL_STYLE_PROPS.forEach((p) => { mirror.style[p] = cs[p]; });
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
      markRect = markEl.getBoundingClientRect();
      mirror.remove();
    } else {
      // contenteditable text node
      if (!node.isConnected) return;
      const startOffset = Math.min(start, node.textContent.length);
      const endOffset = Math.min(start + length, node.textContent.length);
      if (startOffset >= endOffset) return;
      const range = document.createRange();
      range.setStart(node, startOffset);
      range.setEnd(node, endOffset);
      markRect = range.getBoundingClientRect();
    }

    if (!markRect || markRect.width === 0 || markRect.height === 0) return;

    let bgColor;
    if (hue >= 0) {
      bgColor = `hsla(${hue},100%,60%,${opacity})`;
    } else {
      const base = (secretOptions.wordTrailColor && /^#[0-9a-fA-F]{6}$/.test(secretOptions.wordTrailColor))
        ? secretOptions.wordTrailColor
        : WORD_TRAIL_DEFAULT_COLOR;
      bgColor = hexToRgba(base, opacity);
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
      zIndex: '2147483646',
    });
    document.body.appendChild(overlay);
  });
}

/**
 * Detect the last completed word in a standard input/textarea and push it
 * to the trail.  Must be called AFTER correctInputElement() so that any
 * correction is already reflected in element.value / selectionStart.
 */
function trackWordTrailInput(element) {
  if (!secretOptions.wordTrail) return;
  let cursorPos;
  try { cursorPos = element.selectionStart; } catch { return; }
  if (cursorPos === null || cursorPos === undefined) return;

  const value = element.value;
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

  if (secretOptions.wordTrailRgb) {
    wordTrailRgbHue = (wordTrailRgbHue + 30) % 360;
  }
  const hue = secretOptions.wordTrailRgb ? wordTrailRgbHue : -1;
  wordTrailEntries.unshift({ type: 'input', element, start: wordStart, length: word.length, hue });
  if (wordTrailEntries.length > WORD_TRAIL_OPACITIES.length) {
    wordTrailEntries.length = WORD_TRAIL_OPACITIES.length;
  }
  renderWordTrailOverlays();
}

/**
 * Same as trackWordTrailInput but for contenteditable elements.
 */
function trackWordTrailCE(element) {
  if (!secretOptions.wordTrail) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return;
  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  if (!element.contains(node)) return;

  const cursorPos = range.startOffset;
  const text = node.textContent;
  const charBefore = text[cursorPos - 1];
  if (!charBefore || !SEPARATOR_RE.test(charBefore)) return;

  const textBefore = text.substring(0, cursorPos - 1);
  const wordMatch = textBefore.match(/(\S+)$/);
  if (!wordMatch) return;

  const rawToken = wordMatch[1];
  const strippedLeading = rawToken.replace(LEADING_PUNCT_RE, '');
  const word = strippedLeading.replace(TRAILING_PUNCT_RE, '');
  if (!word) return;

  const leadingLen = rawToken.length - strippedLeading.length;
  const wordStart = cursorPos - 1 - rawToken.length + leadingLen;

  if (secretOptions.wordTrailRgb) {
    wordTrailRgbHue = (wordTrailRgbHue + 30) % 360;
  }
  const hue = secretOptions.wordTrailRgb ? wordTrailRgbHue : -1;
  wordTrailEntries.unshift({ type: 'ce', node, start: wordStart, length: word.length, hue });
  if (wordTrailEntries.length > WORD_TRAIL_OPACITIES.length) {
    wordTrailEntries.length = WORD_TRAIL_OPACITIES.length;
  }
  renderWordTrailOverlays();
}



/**
 * Look up a correction for the given word.
 * Matching is case-insensitive; the returned correction preserves the
 * casing pattern of the original word (ALL CAPS or Title Case).
 */
function getCorrection(word) {
  if (!word) return null;

  // 1. Exact match
  if (Object.prototype.hasOwnProperty.call(wordMap, word)) return wordMap[word];

  // 2. Case-insensitive match
  const lower = word.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(wordMap, lower)) return null;

  const correction = wordMap[lower];

  // Preserve ALL CAPS
  if (word === word.toUpperCase() && word.length > 1) {
    return correction.toUpperCase();
  }
  // Preserve Title Case (first letter capital)
  if (word[0] !== word[0].toLowerCase()) {
    return correction[0].toUpperCase() + correction.slice(1);
  }
  return correction;
}

/**
 * Apply all wordMap corrections to a full string of text.
 * Preserves surrounding punctuation and case, using the same tokenisation
 * rules as correctInputElement / correctContentEditable.
 */
function applyWordMapToText(text) {
  return text.replace(/\S+/g, (token) => {
    const strippedLeading = token.replace(LEADING_PUNCT_RE, '');
    const coreWord = strippedLeading.replace(TRAILING_PUNCT_RE, '');
    if (!coreWord) return token;
    const correction = getCorrection(coreWord);
    if (!correction) return token;
    const leading = token.slice(0, token.length - strippedLeading.length);
    const trailing = strippedLeading.slice(coreWord.length);
    return leading + correction + trailing;
  });
}

/**
 * Apply wordMap corrections (including bold/italic formatting) to a single
 * text node inside a contenteditable element.
 *
 * When no word in the node has formatting the node's textContent is updated in
 * place (fast path).  When at least one corrected word carries bold/italic
 * formatting the text node is replaced with a DocumentFragment that contains
 * plain TextNodes and <strong>/<em> elements as required.
 */
function recheckContentEditableNode(textNode) {
  const text = textNode.textContent;
  const parts = [];   // { text: string, formatted: bool, bold?: bool, italic?: bool }
  let lastIndex = 0;
  let hasFormatting = false;

  text.replace(/\S+/g, (token, offset) => {
    // Preserve any whitespace / text before this token
    if (offset > lastIndex) {
      parts.push({ text: text.substring(lastIndex, offset), formatted: false });
    }

    const strippedLeading = token.replace(LEADING_PUNCT_RE, '');
    const coreWord = strippedLeading.replace(TRAILING_PUNCT_RE, '');
    const correction = coreWord ? getCorrection(coreWord) : null;

    if (correction) {
      const fmt = wordFormats[coreWord.toLowerCase()] || {};
      const leading  = token.slice(0, token.length - strippedLeading.length);
      const trailing = strippedLeading.slice(coreWord.length);

      if (fmt.bold || fmt.italic) {
        hasFormatting = true;
        if (leading)  parts.push({ text: leading,  formatted: false });
        parts.push({ text: correction, formatted: true, bold: !!fmt.bold, italic: !!fmt.italic });
        if (trailing) parts.push({ text: trailing, formatted: false });
      } else {
        parts.push({ text: leading + correction + trailing, formatted: false });
      }
    } else {
      parts.push({ text: token, formatted: false });
    }

    lastIndex = offset + token.length;
  });

  // Preserve any trailing whitespace
  if (lastIndex < text.length) {
    parts.push({ text: text.substring(lastIndex), formatted: false });
  }

  if (!hasFormatting) {
    // Fast path: plain text update
    textNode.textContent = parts.map((p) => p.text).join('');
    return;
  }

  // Slow path: rebuild as DOM nodes with inline formatting elements
  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (!part.formatted) {
      if (part.text) fragment.appendChild(document.createTextNode(part.text));
    } else {
      let el;
      if (part.bold && part.italic) {
        el = document.createElement('strong');
        const inner = document.createElement('em');
        inner.textContent = part.text;
        el.appendChild(inner);
      } else if (part.bold) {
        el = document.createElement('strong');
        el.textContent = part.text;
      } else {
        el = document.createElement('em');
        el.textContent = part.text;
      }
      fragment.appendChild(el);
    }
  }
  textNode.parentNode.replaceChild(fragment, textNode);
}

/**
 * Scan all editable elements on the page and apply the current wordMap to
 * any text that hasn't been corrected yet.  Called after wordMap changes so
 * that words the user just added don't remain wrong in existing fields.
 */
function recheckAllElements() {
  if (!enabled || blockedByDomain || Object.keys(wordMap).length === 0) return;
  applying = true;
  try {
    document.querySelectorAll(SELECTOR).forEach((el) => {
      const tag = el.tagName;
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.type !== 'password') {
        const newValue = applyWordMapToText(el.value);
        if (newValue !== el.value) el.value = newValue;
      } else if (el.isContentEditable) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const pending = [];
        let node;
        while ((node = walker.nextNode())) {
          const newText = applyWordMapToText(node.textContent);
          if (newText !== node.textContent) pending.push(node);
        }
        // Nodes are collected before any DOM changes to avoid invalidating the
        // TreeWalker mid-walk.  recheckContentEditableNode replaces individual
        // text nodes in place; guard with isConnected in case an earlier
        // replacement happened to be an ancestor of a later pending node
        // (text nodes have no children, so this is a theoretical edge-case,
        // but the check is cheap and makes the loop robust).
        for (const node of pending) {
          if (node.isConnected) recheckContentEditableNode(node);
        }
      }
    });
  } finally {
    applying = false;
  }
}

/**
 * A word is "completed" when followed by a separator character.
 */
function correctInputElement(element) {
  const value = element.value;
  // selectionStart throws a TypeError on input types that don't support text
  // selection (e.g. type="email"). This is a defensive fallback in case such an
  // element somehow bypasses the SELECTOR filter.
  let cursorPos;
  try {
    cursorPos = element.selectionStart;
  } catch {
    return;
  }
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

    const newCursorPos = wordStart + correction.length + trailingLen + 1; // +1 for the separator
    element.setSelectionRange(newCursorPos, newCursorPos);

    // Notify JS frameworks (React, Vue, etc.) that the value changed.
    // `composed: true` is required so the event crosses Shadow DOM boundaries.
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, cancelable: false }));
  } finally {
    applying = false;
  }

  showCorrectionFlair(element);
  highlightCorrectedWord(element, wordStart, correction.length);
  recordCorrection();
}

/**
 * Find and replace the last completed word in a contenteditable element.
 */
function correctContentEditable(element) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!range.collapsed) return;

  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  if (!element.contains(node)) return;

  const cursorPos = range.startOffset;
  const text = node.textContent;

  const charBefore = text[cursorPos - 1];
  if (!charBefore || !SEPARATOR_RE.test(charBefore)) return;

  const textBefore = text.substring(0, cursorPos - 1);
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

  // Check if this word has bold/italic formatting.  The wordMap key is always
  // lower-case, so use the lower-case form of the typed word as the lookup key.
  const fmt = wordFormats[typedWord.toLowerCase()] || {};

  applying = true;
  try {
    if (fmt.bold || fmt.italic) {
      // --- Formatted replacement: split text node, insert inline element ---
      const beforeText = text.substring(0, wordStart);
      const afterText  = text.substring(wordStart + typedWord.length);

      // Build the inline formatting element (nesting <em> inside <strong> when
      // both options are active)
      let fmtEl;
      if (fmt.bold && fmt.italic) {
        fmtEl = document.createElement('strong');
        const inner = document.createElement('em');
        inner.textContent = correction;
        fmtEl.appendChild(inner);
      } else if (fmt.bold) {
        fmtEl = document.createElement('strong');
        fmtEl.textContent = correction;
      } else {
        fmtEl = document.createElement('em');
        fmtEl.textContent = correction;
      }

      const beforeNode = document.createTextNode(beforeText);
      const afterNode  = document.createTextNode(afterText);

      const parent = node.parentNode;
      parent.insertBefore(beforeNode, node);
      parent.insertBefore(fmtEl, node);
      parent.insertBefore(afterNode, node);
      parent.removeChild(node);

      // Place cursor after the trailing punctuation + separator in afterNode.
      // When the cursor would land at the very end of afterNode (which sits
      // directly after the <strong>/<em> element), some browsers inherit the
      // inline formatting for subsequent keystrokes ("cursor gravity").
      // Positioning the cursor in the parent node after afterNode avoids this.
      const newRange = document.createRange();
      const newOffset = Math.min(trailingLen + 1, afterNode.textContent.length);
      if (newOffset >= afterNode.textContent.length) {
        newRange.setStartAfter(afterNode);
      } else {
        newRange.setStart(afterNode, newOffset);
      }
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);

      // Pass the innermost text node to the highlight helper.
      // Structure: bold-only → <strong>text</strong>
      //            italic-only → <em>text</em>
      //            both        → <strong><em>text</em></strong>
      // fmtEl is always the outermost element; its lastChild is either the
      // text node (single-level) or the inner <em> element (two-level).
      // The defensive checks below handle both cases safely.
      let correctionNode = fmtEl.lastChild;
      if (correctionNode && correctionNode.nodeType !== Node.TEXT_NODE) {
        correctionNode = correctionNode.firstChild || null;
      }
      showCorrectionFlair(element);
      if (correctionNode && correctionNode.nodeType === Node.TEXT_NODE) {
        highlightCorrectedWordCE(correctionNode, 0, correction.length);
      }
    } else {
      // --- Plain text replacement (original logic) ---
      node.textContent =
        text.substring(0, wordStart) + correction + text.substring(wordStart + typedWord.length);

      const newRange = document.createRange();
      const newOffset = Math.min(wordStart + correction.length + trailingLen + 1, node.textContent.length);
      newRange.setStart(node, newOffset);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);

      showCorrectionFlair(element);
      highlightCorrectedWordCE(node, wordStart, correction.length);
    }
  } finally {
    applying = false;
  }

  recordCorrection();
}

/**
 * Correct the last word directly before the cursor in a contenteditable,
 * without requiring a trailing separator character.
 * Used when Enter is pressed so the in-progress word is corrected before the
 * browser moves the cursor to a new block.
 */
function correctLastWordInContentEditable(element) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!range.collapsed) return;

  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  if (!element.contains(node)) return;

  const cursorPos = range.startOffset;
  const text = node.textContent;

  // No separator to skip — match the last non-whitespace run up to the cursor.
  const textBefore = text.substring(0, cursorPos);
  const wordMatch = textBefore.match(/(\S+)$/);
  if (!wordMatch) return;

  const rawToken = wordMatch[1];
  const strippedLeading = rawToken.replace(LEADING_PUNCT_RE, '');
  const typedWord = strippedLeading.replace(TRAILING_PUNCT_RE, '');
  if (!typedWord) return;
  const correction = getCorrection(typedWord);
  if (!correction) return;

  const leadingLen = rawToken.length - strippedLeading.length;
  const trailingLen = strippedLeading.length - typedWord.length;
  const rawStart  = cursorPos - rawToken.length;
  const coreStart = rawStart + leadingLen;

  // Capitalise the correction if auto-capitalise is on and the word is at a
  // sentence start.  Scope the look-behind to the current block element so
  // that text from a previous <p>/<div> is not mistaken for preceding context.
  let finalCorrection = correction;
  if (settings.autoCapitalize && !skipCapForThisSentence && finalCorrection.length > 0) {
    const textBeforeWord = text.substring(0, coreStart);
    if (textBeforeWord.length === 0) {
      const blockRoot = getBlockRoot(node, element);
      let textInBlock = '';
      const preWalker = document.createTreeWalker(blockRoot, NodeFilter.SHOW_TEXT);
      let cur;
      while ((cur = preWalker.nextNode())) {
        if (cur === node) break;
        textInBlock += cur.textContent;
      }
      if (isAtSentenceStart(textInBlock)) {
        finalCorrection = capitalizeFirst(finalCorrection);
      }
    } else if (isAtSentenceStart(textBeforeWord)) {
      finalCorrection = capitalizeFirst(finalCorrection);
    }
  }

  const fmt = wordFormats[typedWord.toLowerCase()] || {};

  applying = true;
  try {
    if (fmt.bold || fmt.italic) {
      const beforeText = text.substring(0, coreStart);
      const afterText  = text.substring(coreStart + typedWord.length);

      let fmtEl;
      if (fmt.bold && fmt.italic) {
        fmtEl = document.createElement('strong');
        const inner = document.createElement('em');
        inner.textContent = finalCorrection;
        fmtEl.appendChild(inner);
      } else if (fmt.bold) {
        fmtEl = document.createElement('strong');
        fmtEl.textContent = finalCorrection;
      } else {
        fmtEl = document.createElement('em');
        fmtEl.textContent = finalCorrection;
      }

      const beforeNode = document.createTextNode(beforeText);
      const afterNode  = document.createTextNode(afterText);
      const parent = node.parentNode;
      parent.insertBefore(beforeNode, node);
      parent.insertBefore(fmtEl, node);
      parent.insertBefore(afterNode, node);
      parent.removeChild(node);

      // Leave the cursor right after the trailing-punctuation node so Enter
      // splits the block at the correct position.
      const newRange = document.createRange();
      newRange.setStartAfter(afterNode);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);

      let correctionNode = fmtEl.lastChild;
      if (correctionNode && correctionNode.nodeType !== Node.TEXT_NODE) {
        correctionNode = correctionNode.firstChild || null;
      }
      showCorrectionFlair(element);
      if (correctionNode && correctionNode.nodeType === Node.TEXT_NODE) {
        highlightCorrectedWordCE(correctionNode, 0, finalCorrection.length);
      }
    } else {
      node.textContent =
        text.substring(0, coreStart) + finalCorrection + text.substring(coreStart + typedWord.length);

      const newRange = document.createRange();
      const newOffset = coreStart + finalCorrection.length + trailingLen;
      newRange.setStart(node, Math.min(newOffset, node.textContent.length));
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);

      showCorrectionFlair(element);
      highlightCorrectedWordCE(node, coreStart, finalCorrection.length);
    }
  } finally {
    applying = false;
  }

  recordCorrection();
}

// ---------------------------------------------------------------------------
// Auto-capitalise logic
// ---------------------------------------------------------------------------

/**
 * Returns true if textBefore represents a position at the start of a sentence:
 * - beginning of the field (empty or only whitespace)
 * - after a newline (possibly preceded by spaces/tabs)
 * - after a sentence-ending character (. ! ?) possibly followed by spaces/tabs
 */
function isAtSentenceStart(textBefore) {
  if (textBefore.length === 0) return true;

  // Scan backwards past spaces and tabs (newline is itself a trigger, not skipped)
  let i = textBefore.length - 1;
  while (i >= 0 && (textBefore[i] === ' ' || textBefore[i] === '\t')) {
    i--;
  }

  if (i < 0) return true; // nothing but whitespace before
  const ch = textBefore[i];
  return ch === '\n' || SENTENCE_END_RE.test(ch);
}

/**
 * Capitalise the just-typed letter if it follows a sentence-ending context.
 * Only fires when a single lowercase letter was inserted (event.inputType === 'insertText').
 */
function autoCapitalizeInput(element, event) {
  if (skipCapForThisSentence) return;
  if (!event || event.inputType !== 'insertText') return;
  const typedChar = event.data;
  if (!typedChar || typedChar.length !== 1) return;
  // Only act when the character has an uppercase form and is currently lowercase
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
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, cancelable: false }));
  } finally {
    applying = false;
  }
}

/**
 * Capitalise the just-typed letter in a contenteditable element.
 */
function autoCapitalizeContentEditable(element, event) {
  if (!event || event.inputType !== 'insertText') return;
  const typedChar = event.data;
  if (!typedChar || typedChar.length !== 1) return;

  // Always consume the pending-capitalize flag on any insertText event so it
  // doesn't linger if the first character after Enter is already uppercase.
  const wasPendingCapitalize = pendingCapitalizeAfterEnter;
  pendingCapitalizeAfterEnter = false;

  if (skipCapForThisSentence) return;
  // Only act when the character has an uppercase form and is currently lowercase
  if (typedChar === typedChar.toUpperCase()) return;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return;
  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  if (!element.contains(node)) return;

  const cursorPos = range.startOffset;
  if (cursorPos < 1) return;
  const text = node.textContent;
  const charOffset = cursorPos - 1; // offset of the just-typed character in node

  // Collect text preceding the typed character, scoped to the current block
  // element (e.g. the <p> the cursor is in) so that content from previous
  // blocks is not included when checking for sentence boundaries.
  const blockRoot = getBlockRoot(node, element);
  let textBefore = '';
  const walker = document.createTreeWalker(blockRoot, NodeFilter.SHOW_TEXT);
  let currentNode;
  while ((currentNode = walker.nextNode())) {
    if (currentNode === node) {
      textBefore += currentNode.textContent.substring(0, charOffset);
      break;
    }
    textBefore += currentNode.textContent;
  }

  if (!isAtSentenceStart(textBefore) && (!wasPendingCapitalize || textBefore.length > 0)) return;

  const upper = typedChar.toUpperCase();
  applying = true;
  try {
    node.textContent = text.substring(0, charOffset) + upper + text.substring(cursorPos);
    const newRange = document.createRange();
    newRange.setStart(node, cursorPos);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
  } finally {
    applying = false;
  }
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function handleInput(event) {
  if (applying) return;
  if (!enabled || blockedByDomain) return;

  const el = event.target;
  const tag = el.tagName;

  const isTextInput =
    (tag === 'INPUT' || tag === 'TEXTAREA') && el.type !== 'password';

  // Word correction (triggers on separator character)
  if (Object.keys(wordMap).length > 0) {
    if (isTextInput) {
      correctInputElement(el);
    } else if (el.isContentEditable) {
      correctContentEditable(el);
    }
  }

  // Word trail (tracks ALL typed words, runs after correction so word
  // positions reflect any replacement already applied above)
  if (secretOptions.wordTrail) {
    if (isTextInput) {
      trackWordTrailInput(el);
    } else if (el.isContentEditable) {
      trackWordTrailCE(el);
    }
  }

  // Auto-capitalise (triggers on alphabetic letter at sentence start)
  if (settings.autoCapitalize) {
    // Reset skip flag when a sentence-ending character (or newline) is typed
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

    // In contenteditable, treat Enter as the start of a new sentence so the
    // first letter typed on the new line gets auto-capitalised.
    if (el.isContentEditable && (
      event.inputType === 'insertParagraph' ||
      event.inputType === 'insertLineBreak'
    )) {
      pendingCapitalizeAfterEnter = true;
    }

    if (isTextInput) {
      autoCapitalizeInput(el, event);
    } else if (el.isContentEditable) {
      autoCapitalizeContentEditable(el, event);
    }
  }
}

// ---------------------------------------------------------------------------
// DOM attachment
// ---------------------------------------------------------------------------

const SELECTOR = [
  'input:not([type="password"]):not([type="hidden"]):not([type="file"])' +
  ':not([type="checkbox"]):not([type="radio"]):not([type="submit"])' +
  ':not([type="button"]):not([type="reset"]):not([type="image"])' +
  ':not([type="color"]):not([type="range"]):not([type="number"])' +
  ':not([type="date"]):not([type="time"]):not([type="datetime-local"])' +
  ':not([type="month"]):not([type="week"]):not([type="email"])',
  'textarea',
  '[contenteditable]:not([contenteditable="false" i])',
].join(', ');

function attachToElement(el) {
  if (!el || el._correctorAttached) return;
  if (typeof el.matches !== 'function') return;
  if (!el.matches(SELECTOR)) return;
  el.addEventListener('input', handleInput);
  el._correctorAttached = true;
}

function attachToAll(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll(SELECTOR).forEach(attachToElement);
}

if (document.body) {
  attachToAll(document.body);
} else {
  document.addEventListener('DOMContentLoaded', () => attachToAll(document.body));
}

// Watch for dynamically added elements
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        attachToElement(node);
        attachToAll(node);
      }
    }
  }
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ---------------------------------------------------------------------------
// "Add as misspelled" dialog (triggered via context menu → background.js)
// ---------------------------------------------------------------------------

function showAddWordDialog(selectedWord) {
  // Remove any pre-existing dialog
  const existing = document.getElementById('__cb_add_word_host__');
  if (existing) existing.remove();

  // Strip leading/trailing punctuation from the selection so the field
  // starts with a clean word (mirrors the correction logic in the corrector).
  const cleaned = selectedWord.trim()
    .replace(LEADING_PUNCT_RE, '')
    .replace(TRAILING_PUNCT_RE, '');

  // ---- Overlay host (fixed, full-screen, semi-transparent backdrop) --------
  const host = document.createElement('div');
  host.id = '__cb_add_word_host__';
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.45)',
    zIndex: '2147483647',
    // Isolate from any font the page may set on <html>
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
  });

  // Attach a shadow DOM so page styles cannot affect the dialog and the
  // dialog styles cannot leak to the page.
  const shadow = host.attachShadow({ mode: 'open' });

  // ---- Styles inside shadow ------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
    .dialog {
      background: #fff;
      border-radius: 12px;
      padding: 20px 22px 18px;
      box-shadow: 0 6px 28px rgba(0,0,0,0.22);
      min-width: 300px;
      max-width: 90vw;
    }
    .cols {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 14px;
    }
    .col-label {
      font-size: 13px;
      font-weight: 600;
      color: #444;
      text-align: center;
      margin-bottom: 6px;
    }
    .col-input {
      width: 100%;
      padding: 7px 14px;
      border: 1.5px solid #ccc;
      border-radius: 999px;
      font-size: 13px;
      color: #222;
      outline: none;
      text-align: center;
      background: #fff;
      font-family: inherit;
    }
    .col-input:focus { border-color: #4A90D9; }
    .btns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .btn {
      padding: 8px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .btn-cancel { background: #e04040; color: #fff; }
    .btn-cancel:hover { background: #c83434; }
    .btn-ok { background: #38b560; color: #fff; }
    .btn-ok:hover { background: #2d9e52; }
    .fmt-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .fmt-row-label {
      font-size: 11px;
      font-weight: 600;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .btn-fmt {
      width: 30px;
      height: 30px;
      border: 1.5px solid #ccc;
      border-radius: 6px;
      background: #fff;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
      color: #555;
    }
    .btn-fmt:hover { background: #f0f4ff; border-color: #4A90D9; }
    .btn-fmt.active { background: #4A90D9; border-color: #4A90D9; color: #fff; }
    .error {
      font-size: 11px;
      color: #e04040;
      text-align: center;
      margin-top: 10px;
      min-height: 1em;
    }
  `;

  // ---- Dialog markup -------------------------------------------------------
  I18n._lang = currentLang;

  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  // Stop clicks inside the dialog from bubbling to the backdrop
  dialog.addEventListener('click', (e) => e.stopPropagation());

  // Column headers + inputs
  const cols = document.createElement('div');
  cols.className = 'cols';

  function makeCol(labelKey, inputValue, inputId) {
    const col = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'col-label';
    label.textContent = I18n.t(labelKey);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'col-input';
    input.value = inputValue;
    input.id = inputId;
    col.appendChild(label);
    col.appendChild(input);
    return { col, input };
  }

  const { col: incorrectCol, input: incorrectInput } =
    makeCol('sandbox-th-incorrect', cleaned, 'cb-incorrect');
  const { col: correctCol, input: correctInput } =
    makeCol('sandbox-th-correct', '', 'cb-correct');
  cols.appendChild(incorrectCol);
  cols.appendChild(correctCol);

  // Format row (bold / italic toggles)
  const fmtRow = document.createElement('div');
  fmtRow.className = 'fmt-row';
  const fmtLabel = document.createElement('span');
  fmtLabel.className = 'fmt-row-label';
  fmtLabel.textContent = I18n.t('opts-format-label');
  const boldBtn = document.createElement('button');
  boldBtn.type = 'button';
  boldBtn.className = 'btn-fmt';
  boldBtn.title = I18n.t('opts-format-bold');
  boldBtn.innerHTML = '<b>B</b>';
  const italicBtn = document.createElement('button');
  italicBtn.type = 'button';
  italicBtn.className = 'btn-fmt';
  italicBtn.title = I18n.t('opts-format-italic');
  italicBtn.innerHTML = '<i>I</i>';
  boldBtn.addEventListener('click', () => boldBtn.classList.toggle('active'));
  italicBtn.addEventListener('click', () => italicBtn.classList.toggle('active'));
  fmtRow.appendChild(fmtLabel);
  fmtRow.appendChild(boldBtn);
  fmtRow.appendChild(italicBtn);

  // Buttons
  const btns = document.createElement('div');
  btns.className = 'btns';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-cancel';
  cancelBtn.textContent = I18n.t('ctx-dialog-cancel');
  const okBtn = document.createElement('button');
  okBtn.className = 'btn btn-ok';
  okBtn.textContent = I18n.t('ctx-dialog-ok');
  btns.appendChild(cancelBtn);
  btns.appendChild(okBtn);

  // Error message area
  const errorEl = document.createElement('p');
  errorEl.className = 'error';

  dialog.appendChild(cols);
  dialog.appendChild(fmtRow);
  dialog.appendChild(btns);
  dialog.appendChild(errorEl);

  shadow.appendChild(style);
  shadow.appendChild(dialog);
  document.documentElement.appendChild(host);

  // Auto-focus the "Correct" input (incorrect is pre-filled)
  setTimeout(() => correctInput.focus(), 30);

  // ---- Close helpers -------------------------------------------------------
  function handleKeyDown(e) {
    if (e.key === 'Escape') closeDialog();
  }
  document.addEventListener('keydown', handleKeyDown);

  function closeDialog() {
    document.removeEventListener('keydown', handleKeyDown);
    host.remove();
  }

  // Close on backdrop click (host itself, outside dialog)
  host.addEventListener('click', closeDialog);

  cancelBtn.addEventListener('click', closeDialog);

  // ---- Save on OK ----------------------------------------------------------
  function handleOk() {
    const incorrect = incorrectInput.value.trim().toLowerCase();
    const correct = correctInput.value.trim();
    errorEl.textContent = '';

    if (!incorrect) {
      errorEl.textContent = I18n.t('err-empty-incorrect');
      incorrectInput.focus();
      return;
    }
    if (!correct) {
      errorEl.textContent = I18n.t('err-empty-correct');
      correctInput.focus();
      return;
    }
    if (incorrect === correct) {
      errorEl.textContent = I18n.t('err-same-words');
      return;
    }

    chrome.storage.local.get(['wordMap', 'wordFormats'], (data) => {
      const wm = data.wordMap || {};
      wm[incorrect] = correct;
      const wf = data.wordFormats || {};
      const isBold = boldBtn.classList.contains('active');
      const isItalic = italicBtn.classList.contains('active');
      if (isBold || isItalic) {
        wf[incorrect] = { bold: isBold, italic: isItalic };
      } else {
        delete wf[incorrect];
      }
      chrome.storage.local.set({ wordMap: wm, wordFormats: wf }, closeDialog);
    });
  }

  okBtn.addEventListener('click', handleOk);
  correctInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleOk();
  });
}


// ---------------------------------------------------------------------------
// Definition lookup overlay (context menu → background → content script)
// ---------------------------------------------------------------------------

function showDefinitionLookup(word, lang) {
  // Remove any pre-existing lookup overlay
  const existingLookup = document.getElementById('__cb_lookup_host__');
  if (existingLookup) existingLookup.remove();

  const cleanWord = word.trim()
    .replace(LEADING_PUNCT_RE, '')
    .replace(TRAILING_PUNCT_RE, '');

  // ---- Overlay host --------------------------------------------------------
  const host = document.createElement('div');
  host.id = '__cb_lookup_host__';
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.45)',
    zIndex: '2147483647',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
  });

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
    .panel {
      background: #fff;
      border-radius: 12px;
      padding: 0;
      box-shadow: 0 6px 28px rgba(0,0,0,0.22);
      width: 320px;
      max-width: 90vw;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px 12px;
      border-bottom: 1px solid #eee;
      gap: 10px;
    }
    .panel-word {
      font-size: 22px;
      font-weight: 700;
      color: #4A90D9;
      word-break: break-word;
    }
    .close-btn {
      background: #f0f0f0;
      border: none;
      border-radius: 50%;
      width: 26px; height: 26px;
      cursor: pointer;
      font-size: 13px;
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      color: #555;
    }
    .close-btn:hover { background: #ddd; }
    .panel-body {
      padding: 14px 18px 16px;
      overflow-y: auto;
      flex: 1;
    }
    .loading { color: #888; font-size: 13px; }
    .phonetic { font-size: 13px; color: #888; margin-bottom: 10px; }
    .pos {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: #aaa; margin-top: 10px; margin-bottom: 4px;
    }
    .def { font-size: 13px; color: #333; line-height: 1.5; margin-bottom: 4px; padding-left: 12px; }
    .not-found { color: #888; font-size: 13px; }
    .search-link {
      display: inline-block;
      margin-top: 12px;
      font-size: 12px;
      color: #4A90D9;
      text-decoration: none;
    }
    .search-link:hover { text-decoration: underline; }
    .divider { height: 1px; background: #eee; margin: 10px 0; }
  `;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.addEventListener('click', (e) => e.stopPropagation());

  // Header
  const header = document.createElement('div');
  header.className = 'panel-header';
  const wordEl = document.createElement('span');
  wordEl.className = 'panel-word';
  wordEl.textContent = cleanWord;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = '✕';
  header.appendChild(wordEl);
  header.appendChild(closeBtn);

  // Body
  const body = document.createElement('div');
  body.className = 'panel-body';

  I18n._lang = currentLang;
  body.innerHTML = `<p class="loading">${I18n.t('lookup-loading')}</p>`;

  panel.appendChild(header);
  panel.appendChild(body);
  shadow.appendChild(style);
  shadow.appendChild(panel);
  document.documentElement.appendChild(host);

  // ---- Close helpers -------------------------------------------------------
  function handleKeyDown(e) {
    if (e.key === 'Escape') closeLookup();
  }
  document.addEventListener('keydown', handleKeyDown);

  function closeLookup() {
    document.removeEventListener('keydown', handleKeyDown);
    host.remove();
  }

  host.addEventListener('click', closeLookup);
  closeBtn.addEventListener('click', closeLookup);

  // ---- Fetch via background proxy ------------------------------------------
  chrome.runtime.sendMessage(
    { action: 'lookupWordApi', word: cleanWord, lang: lang || currentLang },
    (response) => {
      I18n._lang = currentLang;

      // Build DOM nodes with textContent so no user-supplied text touches innerHTML.
      function addText(className, text) {
        const el = document.createElement('p');
        el.className = className;
        el.textContent = text;
        body.appendChild(el);
      }

      const searchUrl = 'https://www.google.com/search?q=define+' + encodeURIComponent(cleanWord);
      function addSearchLink() {
        const hr = document.createElement('div');
        hr.className = 'divider';
        body.appendChild(hr);
        const a = document.createElement('a');
        a.href = searchUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'search-link';
        a.textContent = I18n.t('lookup-search-online') + ' ↗';
        body.appendChild(a);
      }

      if (!response || !response.ok || !response.data || !response.data[0]) {
        addText('not-found', I18n.t('lookup-not-found'));
        addSearchLink();
        return;
      }
      const entry = response.data[0];
      const phonetic = (entry.phonetics || []).find((p) => p.text);
      if (phonetic) addText('phonetic', phonetic.text);
      const meanings = (entry.meanings || []).slice(0, 3);
      for (const m of meanings) {
        addText('pos', m.partOfSpeech);
        for (const d of (m.definitions || []).slice(0, 2)) {
          addText('def', '• ' + d.definition);
        }
      }
      if (!meanings.length) addText('not-found', I18n.t('lookup-not-found'));
      addSearchLink();
    }
  );
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Message listener (background.js → content script)
// ---------------------------------------------------------------------------

/**
 * Transforms the current text selection to upper or lower case.
 * Works for both input/textarea elements and contenteditable regions.
 */
function applySelectionCase(transform) {
  const active = document.activeElement;

  // --- Input / Textarea ---
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') &&
      active.type !== 'password') {
    const start = active.selectionStart;
    const end   = active.selectionEnd;
    if (start === end) return; // nothing selected
    const val = active.value;
    const replacement = transform === 'upper'
      ? val.slice(start, end).toUpperCase()
      : val.slice(start, end).toLowerCase();
    active.value = val.slice(0, start) + replacement + val.slice(end);
    active.setSelectionRange(start, start + replacement.length);
    active.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  // --- ContentEditable ---
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

  const range = selection.getRangeAt(0);
  const selectedText = range.toString();
  if (!selectedText) return;

  const replacement = transform === 'upper'
    ? selectedText.toUpperCase()
    : selectedText.toLowerCase();

  const textNode = document.createTextNode(replacement);
  range.deleteContents();
  range.insertNode(textNode);

  // Re-select the inserted text using the explicit text node reference,
  // since range.startContainer/Offset may point to the parent after insertNode.
  range.setStart(textNode, 0);
  range.setEnd(textNode, replacement.length);
  selection.removeAllRanges();
  selection.addRange(range);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'showAddWordDialog') {
    showAddWordDialog(msg.word || '');
  }
  if (msg.action === 'showDefinitionLookup') {
    showDefinitionLookup(msg.word || '', msg.lang || 'en');
  }
  if (msg.action === 'applyCase') {
    applySelectionCase(msg.transform || 'upper');
  }
});