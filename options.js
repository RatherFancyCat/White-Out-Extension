'use strict';

let wordMap = {};
let settings = { autoCapitalize: false, blacklistedDomains: [] };
let cbStats = { wordsAdded: 0, correctionsApplied: 0 };
let cbAchievements = {};
let tagDefinitions = [];
let wordTags = {};
let wordFormats = {};
let activeTagFilter = 'all';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function loadAll(callback) {
  chrome.storage.local.get(['wordMap', 'settings', 'language', 'cbStats', 'cbAchievements', 'theme', 'tagDefinitions', 'wordTags', 'wordFormats'], (data) => {
    wordMap = data.wordMap || {};
    settings = data.settings || { autoCapitalize: false, blacklistedDomains: [] };
    cbStats = data.cbStats || { wordsAdded: 0, correctionsApplied: 0 };
    cbAchievements = data.cbAchievements || {};
    tagDefinitions = data.tagDefinitions || [];
    wordTags = data.wordTags || {};
    wordFormats = data.wordFormats || {};
    const lang = data.language || 'en';
    I18n._lang = lang;
    applyTheme(data.theme || 'light');
    if (callback) callback(lang);
  });
}

function saveWordMap(callback) {
  chrome.storage.local.set({ wordMap }, callback);
}

function saveSettings(callback) {
  chrome.storage.local.set({ settings }, callback);
}

function saveTagDefinitions(callback) {
  chrome.storage.local.set({ tagDefinitions }, callback);
}

function saveWordTags(callback) {
  chrome.storage.local.set({ wordTags }, callback);
}

function saveWordFormats(callback) {
  chrome.storage.local.set({ wordFormats }, callback);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  const btn = document.getElementById('headerThemeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Tag utilities
// ---------------------------------------------------------------------------

function getTag(tagId) {
  return tagDefinitions.find((t) => t.id === tagId) || null;
}

function generateTagId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return 'tag_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return 'tag_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function getContrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#333' : '#fff';
}

function renderTagFilter() {
  const sel = document.getElementById('tagFilterSelect');
  const current = activeTagFilter;
  sel.innerHTML =
    `<option value="all">${I18n.t('opts-tag-filter-all')}</option>` +
    `<option value="untagged">${I18n.t('opts-tag-filter-untagged')}</option>` +
    tagDefinitions.map((t) =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`
    ).join('');
  if ([...sel.options].some((o) => o.value === current)) {
    sel.value = current;
  } else {
    activeTagFilter = 'all';
    sel.value = 'all';
  }
}

function renderWordList(filter) {
  const tbody = document.getElementById('wordTableBody');
  const emptyMsg = document.getElementById('emptyMessage');
  const wordCountEl = document.getElementById('wordCount');

  const q = (filter || '').toLowerCase().trim();
  const entries = Object.entries(wordMap);

  wordCountEl.textContent = entries.length;

  let visible = q
    ? entries.filter(([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q))
    : entries;

  if (activeTagFilter === 'untagged') {
    visible = visible.filter(([k]) => !wordTags[k]);
  } else if (activeTagFilter !== 'all') {
    visible = visible.filter(([k]) => wordTags[k] === activeTagFilter);
  }

  tbody.innerHTML = '';

  if (visible.length === 0) {
    emptyMsg.hidden = false;
    emptyMsg.textContent = (q || activeTagFilter !== 'all')
      ? I18n.t('err-no-words-found')
      : I18n.t('opts-empty-msg');
    return;
  }

  emptyMsg.hidden = true;

  visible.sort((a, b) => a[0].localeCompare(b[0]));

  for (const [incorrect, correct] of visible) {
    const tagId = wordTags[incorrect] || null;
    const tag = tagId ? getTag(tagId) : null;
    let tagCellHtml;
    if (tag) {
      const contrast = getContrastColor(tag.color);
      tagCellHtml = `<button class="tag-badge assign-tag-btn"
        data-word="${escapeHtml(incorrect)}"
        style="background:${escapeHtml(tag.color)};color:${contrast}"
        >${escapeHtml(tag.name)}</button>`;
    } else {
      tagCellHtml = `<button class="tag-badge tag-badge--none assign-tag-btn"
        data-word="${escapeHtml(incorrect)}">${I18n.t('opts-tag-add')}</button>`;
    }
    const tr = document.createElement('tr');
    const fmt = wordFormats[incorrect] || {};
    const fmtCellHtml = [
      fmt.bold ? `<span class="fmt-badge"><b>B</b></span>` : '',
      fmt.italic ? `<span class="fmt-badge"><i>I</i></span>` : '',
    ].join(' ') || '—';
    tr.innerHTML = `
      <td class="word-incorrect">${escapeHtml(incorrect)}</td>
      <td class="word-correct">
        <span class="word-correct-inner">
          <span>${escapeHtml(correct)}</span>
          <button class="lookup-btn" data-word="${escapeHtml(correct)}"
                  title="${escapeHtml(I18n.t('lookup-btn-title'))}">?</button>
        </span>
      </td>
      <td class="col-format">${fmtCellHtml}</td>
      <td class="col-tag">${tagCellHtml}</td>
      <td class="col-action">
        <button class="btn btn-sm btn-danger delete-btn"
                data-word="${escapeHtml(incorrect)}">${I18n.t('btn-delete')}</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

function populateSettings() {
  const autoCapOn = settings.autoCapitalize;
  document.getElementById('autoCapitalizeChk').checked = autoCapOn;
  document.getElementById('blacklistDomains').value =
    (settings.blacklistedDomains || []).join('\n');

  // Sub-option: skip-capitalisation keybind
  document.getElementById('skipCapSection').hidden = !autoCapOn;
  const skipEnabled = !!settings.skipCapEnabled;
  document.getElementById('skipCapEnabledChk').checked = skipEnabled;
  document.getElementById('skipCapKeyRow').hidden = !skipEnabled;
  document.getElementById('skipCapKeyInput').value = settings.skipCapKey || 'Alt+K';
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = [];
    let inQuote = false;
    let current = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === ',' && !inQuote) {
        row.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    row.push(current.trim());
    rows.push(row);
  }
  return rows;
}

function escapeCSV(value) {
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ---------------------------------------------------------------------------
// Stats tracking (for achievements)
// ---------------------------------------------------------------------------

function recordWordsAdded(count) {
  if (!count || count <= 0) return;
  chrome.storage.local.get('cbStats', (data) => {
    const stats = data.cbStats || { wordsAdded: 0, correctionsApplied: 0 };
    stats.wordsAdded = (stats.wordsAdded || 0) + count;
    chrome.storage.local.set({ cbStats: stats });
  });
}

// ---------------------------------------------------------------------------
// Event: Add word pair
// ---------------------------------------------------------------------------

document.getElementById('addWordForm').addEventListener('submit', (e) => {
  e.preventDefault();

  const incorrectEl = document.getElementById('incorrectWord');
  const correctEl = document.getElementById('correctWord');
  const errorEl = document.getElementById('addError');

  const incorrect = incorrectEl.value.trim().toLowerCase();
  const correct = correctEl.value.trim();

  errorEl.hidden = true;

  if (!incorrect) {
    errorEl.textContent = I18n.t('err-empty-incorrect');
    errorEl.hidden = false;
    incorrectEl.focus();
    return;
  }
  if (!correct) {
    errorEl.textContent = I18n.t('err-empty-correct');
    errorEl.hidden = false;
    correctEl.focus();
    return;
  }
  const fmt = {
    bold: document.getElementById('fmtBoldBtn').classList.contains('active'),
    italic: document.getElementById('fmtItalicBtn').classList.contains('active'),
  };
  if (incorrect === correct && !fmt.bold && !fmt.italic) {
    errorEl.textContent = I18n.t('err-same-words');
    errorEl.hidden = false;
    return;
  }

  wordMap[incorrect] = correct;
  if (fmt.bold || fmt.italic) {
    wordFormats[incorrect] = fmt;
  } else {
    delete wordFormats[incorrect];
  }
  saveWordMap(() => {
    saveWordFormats(() => {
      incorrectEl.value = '';
      correctEl.value = '';
      // Reset format toggles
      document.getElementById('fmtBoldBtn').classList.remove('active');
      document.getElementById('fmtItalicBtn').classList.remove('active');
      incorrectEl.focus();
      renderWordList(document.getElementById('searchInput').value);
      recordWordsAdded(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Event: Delete / Tag-assign (delegated)
// ---------------------------------------------------------------------------

document.getElementById('wordTableBody').addEventListener('click', (e) => {
  if (e.target.classList.contains('assign-tag-btn')) {
    e.stopPropagation();
    openTagPicker(e.target);
    return;
  }
  if (e.target.classList.contains('lookup-btn')) {
    e.stopPropagation();
    openLookupPopup(e.target.dataset.word, e.target);
    return;
  }
  if (!e.target.classList.contains('delete-btn')) return;
  const word = e.target.dataset.word;
  if (Object.prototype.hasOwnProperty.call(wordMap, word)) {
    delete wordMap[word];
    delete wordTags[word];
    delete wordFormats[word];
    saveWordMap(() => {
      saveWordTags(() => saveWordFormats(() => renderWordList(document.getElementById('searchInput').value)));
    });
  }
});

// ---------------------------------------------------------------------------
// Event: Search
// ---------------------------------------------------------------------------

document.getElementById('searchInput').addEventListener('input', (e) => {
  renderWordList(e.target.value);
});

// ---------------------------------------------------------------------------
// Event: Tag filter
// ---------------------------------------------------------------------------

document.getElementById('tagFilterSelect').addEventListener('change', (e) => {
  activeTagFilter = e.target.value;
  renderWordList(document.getElementById('searchInput').value);
});

// ---------------------------------------------------------------------------
// Event: Clear all
// ---------------------------------------------------------------------------

document.getElementById('clearAllBtn').addEventListener('click', () => {
  if (Object.keys(wordMap).length === 0) {
    alert(I18n.t('err-list-empty'));
    return;
  }
  if (confirm(I18n.t('confirm-clear-all'))) {
    wordMap = {};
    saveWordMap(() => renderWordList());
  }
});

// ---------------------------------------------------------------------------
// Event: Settings – auto-capitalise
// ---------------------------------------------------------------------------

document.getElementById('autoCapitalizeChk').addEventListener('change', (e) => {
  settings.autoCapitalize = e.target.checked;
  document.getElementById('skipCapSection').hidden = !e.target.checked;
  if (!e.target.checked) {
    // Disable skip-cap when auto-cap is turned off
    settings.skipCapEnabled = false;
    document.getElementById('skipCapEnabledChk').checked = false;
    document.getElementById('skipCapKeyRow').hidden = true;
  }
  saveSettings();
});

// ---------------------------------------------------------------------------
// Event: Settings – skip-capitalisation keybind
// ---------------------------------------------------------------------------

document.getElementById('skipCapEnabledChk').addEventListener('change', (e) => {
  settings.skipCapEnabled = e.target.checked;
  document.getElementById('skipCapKeyRow').hidden = !e.target.checked;
  saveSettings();
});

/**
 * Format a KeyboardEvent into a human-readable keybind string like "Alt+K".
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

let recording = false;

document.getElementById('skipCapRecordBtn').addEventListener('click', () => {
  recording = !recording;
  const btn = document.getElementById('skipCapRecordBtn');
  const input = document.getElementById('skipCapKeyInput');
  if (recording) {
    btn.textContent = I18n.t('opts-skipcap-recording');
    input.value = '…';
    input.classList.add('recording');
  } else {
    // Cancel recording
    btn.textContent = I18n.t('opts-skipcap-record-btn');
    input.value = settings.skipCapKey || 'Alt+K';
    input.classList.remove('recording');
  }
});

document.getElementById('saveBlacklistBtn').addEventListener('click', () => {
  const raw = document.getElementById('blacklistDomains').value;
  settings.blacklistedDomains = raw
    .split('\n')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);

  const btn = document.getElementById('saveBlacklistBtn');
  saveSettings(() => {
    btn.textContent = I18n.t('opts-btn-saved');
    setTimeout(() => { btn.textContent = I18n.t('opts-btn-save'); }, 1500);
  });
});

// ---------------------------------------------------------------------------
// Event: Language selector
// ---------------------------------------------------------------------------

document.getElementById('languageSelect').addEventListener('change', (e) => {
  const lang = e.target.value;
  chrome.storage.local.set({ language: lang }, () => {
    I18n.apply(lang);
    renderTagFilter();
    renderWordList(document.getElementById('searchInput').value);
  });
});

// ---------------------------------------------------------------------------
// Event: Import CSV
// ---------------------------------------------------------------------------

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    const rows = parseCSV(evt.target.result);
    let imported = 0;
    let skipped = 0;

    // Skip header row if it reads "incorrect"
    const start =
      rows[0] && rows[0][0] && rows[0][0].toLowerCase() === 'incorrect' ? 1 : 0;

    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      if (row.length < 2) { skipped++; continue; }
      const incorrect = row[0].toLowerCase();
      const correct = row[1];
      if (!incorrect || !correct) { skipped++; continue; }
      if (incorrect === correct) { skipped++; continue; }
      wordMap[incorrect] = correct;
      imported++;
    }

    saveWordMap(() => {
      renderWordList(document.getElementById('searchInput').value);
      let msg = I18n.t('msg-imported', { count: imported });
      if (skipped > 0) msg += ' ' + I18n.t('msg-skipped', { count: skipped });
      alert(msg);
      recordWordsAdded(imported);
    });
  };
  reader.readAsText(file);
  e.target.value = ''; // allow re-importing the same file
});

// ---------------------------------------------------------------------------
// Event: Export CSV
// ---------------------------------------------------------------------------

document.getElementById('exportBtn').addEventListener('click', () => {
  const entries = Object.entries(wordMap);
  if (entries.length === 0) {
    alert(I18n.t('err-nothing-to-export'));
    return;
  }

  const rows = [['incorrect', 'correct'], ...entries];
  const csv = rows.map((row) => row.map(escapeCSV).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'corretor_branco_palavras.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

function renderAchievements() {
  const list = document.getElementById('achievementsList');
  const unlockedCount = ACHIEVEMENT_DEFINITIONS.filter((d) => cbAchievements[d.id]).length;

  let html =
    `<div class="ach-summary">${I18n.t('ach-summary', { unlocked: unlockedCount, total: ACHIEVEMENT_DEFINITIONS.length })}</div>`;

  for (const def of ACHIEVEMENT_DEFINITIONS) {
    const unlockedAt = cbAchievements[def.id];
    const dateStr = unlockedAt ? new Date(unlockedAt).toLocaleString(I18n.locale()) : null;
    const rewardText = def.reward
      ? escapeHtml(I18n.t('ach-reward-' + def.reward))
      : I18n.t('ach-reward-none');

    html +=
      `<div class="ach-item ${unlockedAt ? 'ach-unlocked' : 'ach-locked'}">` +
      `<div class="ach-icon">${unlockedAt ? '🏆' : '🔒'}</div>` +
      `<div class="ach-info">` +
      `<strong class="ach-name">${escapeHtml(I18n.t('ach-' + def.id + '-name'))}</strong>` +
      `<span class="ach-desc">${escapeHtml(I18n.t('ach-' + def.id + '-desc'))}</span>` +
      `<span class="ach-reward">${I18n.t('ach-reward-label')} ${rewardText}</span>` +
      (dateStr ? `<span class="ach-date">${I18n.t('ach-unlocked-on')} ${escapeHtml(dateStr)}</span>` : '') +
      `</div>` +
      `</div>`;
  }

  list.innerHTML = html;

  // Show the "View My Rewards" button only when at least one reward-bearing achievement is unlocked
  const anyRewardUnlocked = ACHIEVEMENT_DEFINITIONS.some((d) => d.reward && cbAchievements[d.id]);
  document.getElementById('viewRewardsBtn').hidden = !anyRewardUnlocked;
}

function openAchievementsModal() {
  renderAchievements();
  document.getElementById('achievementsModal').hidden = false;
}

function closeAchievementsModal() {
  document.getElementById('achievementsModal').hidden = true;
}

function resetAchievements() {
  if (!confirm(I18n.t('confirm-reset-achievements'))) return;
  cbAchievements = {};
  cbStats = { wordsAdded: 0, correctionsApplied: 0 };
  chrome.storage.local.set({ cbAchievements: {}, cbStats: { wordsAdded: 0, correctionsApplied: 0 } }, () => {
    renderAchievements();
  });
}

document.getElementById('viewAchievementsBtn').addEventListener('click', openAchievementsModal);
document.getElementById('viewRewardsBtn').addEventListener('click', () => {
  window.open(chrome.runtime.getURL('sandbox.html'), '_blank');
});
document.getElementById('closeAchievementsBtn').addEventListener('click', closeAchievementsModal);
document.getElementById('resetAchievementsBtn').addEventListener('click', resetAchievements);
document.getElementById('achievementsModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeAchievementsModal();
});

// ---------------------------------------------------------------------------
// Tag Picker Popup
// ---------------------------------------------------------------------------

let tagPickerWord = null;

function openTagPicker(btn) {
  const popup = document.getElementById('tagPickerPopup');
  const list = document.getElementById('tagPickerList');
  tagPickerWord = btn.dataset.word;

  let html = `<div class="tag-picker-item" data-tag-id="">
    <span class="tag-picker-swatch tag-picker-none-swatch">−</span>
    <span>${I18n.t('opts-tag-no-tag')}</span>
  </div>`;

  for (const tag of tagDefinitions) {
    const active = wordTags[tagPickerWord] === tag.id;
    html += `<div class="tag-picker-item${active ? ' active' : ''}" data-tag-id="${escapeHtml(tag.id)}">
      <span class="tag-picker-swatch" style="background:${escapeHtml(tag.color)}"></span>
      <span>${escapeHtml(tag.name)}</span>
    </div>`;
  }

  if (tagDefinitions.length === 0) {
    html += `<p class="tag-picker-hint">${I18n.t('opts-tag-picker-empty')}</p>`;
  }

  list.innerHTML = html;

  const rect = btn.getBoundingClientRect();
  const popupWidth = 220;
  let left = rect.left;
  let top = rect.bottom + window.scrollY + 4;
  if (left + popupWidth > window.innerWidth) {
    left = Math.max(0, window.innerWidth - popupWidth - 8);
  }
  popup.style.top = top + 'px';
  popup.style.left = left + 'px';
  popup.hidden = false;
}

function closeTagPicker() {
  document.getElementById('tagPickerPopup').hidden = true;
  tagPickerWord = null;
}

document.getElementById('tagPickerPopup').addEventListener('click', (e) => {
  const item = e.target.closest('.tag-picker-item');
  if (!item || !tagPickerWord) return;
  const tagId = item.dataset.tagId;
  if (tagId) {
    wordTags[tagPickerWord] = tagId;
  } else {
    delete wordTags[tagPickerWord];
  }
  saveWordTags(() => renderWordList(document.getElementById('searchInput').value));
  closeTagPicker();
});

document.addEventListener('click', (e) => {
  const popup = document.getElementById('tagPickerPopup');
  if (!popup.hidden && !e.target.closest('#tagPickerPopup') && !e.target.closest('.assign-tag-btn')) {
    closeTagPicker();
  }
  const lp = document.getElementById('lookupPopup');
  if (lp && !lp.hidden && !e.target.closest('#lookupPopup') && !e.target.closest('.lookup-btn')) {
    closeLookupPopup();
  }
});

// ---------------------------------------------------------------------------
// Definition Lookup Popup (options page)
// ---------------------------------------------------------------------------

// Languages handled by dictionaryapi.dev (subset used by this extension).
// Keep in sync with the identical constant in background.js (separate execution context).
const DICT_API_LANGS = new Set(['en']);

// Parse a dicionario-aberto.net response (array of { word, xml }) into the
// dictionaryapi.dev-like shape used by renderLookupResult.
// An identical copy of this function lives in background.js (separate execution context).
function normalizeDicionarioAberto(apiData) {
  if (!Array.isArray(apiData) || !apiData[0]) return null;
  const xmlStr = apiData[0].xml || '';

  // Strip all XML tags then remove any stray angle brackets that remain
  // (e.g. from malformed/incomplete tags). Decode entities with &amp; last
  // to avoid double-decoding sequences like &amp;lt;.
  // NOTE: The decoded text is only ever assigned to DOM textContent (never
  // innerHTML), so any resulting '<' characters are display-safe.
  function xmlToText(s) {
    return s
      .replace(/<[^>]*>/g, '')    // strip complete tags
      .replace(/</g, '')          // remove any stray <
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')     // amp last: prevents double-decoding
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Part of speech: <pos>…</pos> or <gram type="pos">…</gram>
  const posMatch = xmlStr.match(/<pos[^>]*>([\s\S]*?)<\/pos>/) ||
    xmlStr.match(/<gram[^>]*type="pos"[^>]*>([\s\S]*?)<\/gram>/);
  const pos = posMatch ? xmlToText(posMatch[1]) : '';

  // Definitions: all <def>…</def> blocks
  const defs = [];
  for (const m of xmlStr.matchAll(/<def[^>]*>([\s\S]*?)<\/def>/g)) {
    const text = xmlToText(m[1]);
    if (text) defs.push({ definition: text });
    if (defs.length === 4) break;
  }

  if (!defs.length) return null;
  return [{ phonetics: [], meanings: [{ partOfSpeech: pos, definitions: defs }] }];
}

function openLookupPopup(word, btn) {
  const popup = document.getElementById('lookupPopup');
  const wordEl = document.getElementById('lookupPopupWord');
  const bodyEl = document.getElementById('lookupPopupBody');

  wordEl.textContent = word;
  bodyEl.innerHTML = `<p class="lookup-loading">${I18n.t('lookup-loading')}</p>`;

  // Position: prefer to the right of the button, flip left if near edge
  const popupWidth = 290;
  const rect = btn.getBoundingClientRect();
  let left = rect.right + 8;
  let top = rect.top + window.scrollY;
  if (left + popupWidth > window.innerWidth - 8) {
    left = Math.max(4, rect.left - popupWidth - 8);
  }
  popup.style.top = top + 'px';
  popup.style.left = left + 'px';
  popup.hidden = false;

  // Fetch: route by language
  const lang = I18n._lang || 'en';
  const searchUrl = 'https://www.google.com/search?q=' + encodeURIComponent(word);
  const showFallback = () => {
    bodyEl.innerHTML =
      `<p class="lookup-not-found">${I18n.t('lookup-not-found')}</p>` +
      `<a href="${searchUrl}" target="_blank" class="lookup-search-link">${I18n.t('lookup-search-online')} ↗</a>`;
  };

  let fetchPromise;
  if (lang === 'pt') {
    // Portuguese: dicionario-aberto.net
    const url = `https://api.dicionario-aberto.net/word/${encodeURIComponent(word)}`;
    fetchPromise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('not-found');
        return res.json();
      })
      .then((data) => {
        const normalized = normalizeDicionarioAberto(data);
        if (!normalized) throw new Error('not-found');
        renderLookupResult(normalized, word);
      });
  } else if (DICT_API_LANGS.has(lang)) {
    // English, Spanish, French, German: dictionaryapi.dev
    const url = `https://api.dictionaryapi.dev/api/v2/entries/${lang}/${encodeURIComponent(word)}`;
    fetchPromise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('not-found');
        return res.json();
      })
      .then((data) => renderLookupResult(data, word));
  } else {
    // Chinese and other unsupported languages: skip API
    showFallback();
    return;
  }

  fetchPromise.catch(showFallback);
}

function renderLookupResult(data, word) {
  const bodyEl = document.getElementById('lookupPopupBody');
  bodyEl.innerHTML = '';

  function addText(className, text) {
    const el = document.createElement('p');
    el.className = className;
    el.textContent = text;
    bodyEl.appendChild(el);
  }

  if (!data || !data[0]) {
    addText('lookup-not-found', I18n.t('lookup-not-found'));
    return;
  }
  const entry = data[0];

  const phonetic = (entry.phonetics || []).find((p) => p.text);
  if (phonetic) addText('lookup-phonetic', phonetic.text);

  const meanings = (entry.meanings || []).slice(0, 3);
  for (const m of meanings) {
    addText('lookup-pos', m.partOfSpeech);
    for (const d of (m.definitions || []).slice(0, 2)) {
      addText('lookup-def', '\u2022 ' + d.definition);
    }
  }

  if (!meanings.length) addText('lookup-not-found', I18n.t('lookup-not-found'));

  const divider = document.createElement('div');
  divider.className = 'lookup-divider';
  bodyEl.appendChild(divider);

  const searchUrl = 'https://www.google.com/search?q=' + encodeURIComponent(word);
  const link = document.createElement('a');
  link.href = searchUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'lookup-search-link';
  link.textContent = I18n.t('lookup-search-online') + ' \u2197';
  bodyEl.appendChild(link);
}

function closeLookupPopup() {
  const popup = document.getElementById('lookupPopup');
  if (popup) popup.hidden = true;
}

document.getElementById('closeLookupPopupBtn').addEventListener('click', closeLookupPopup);

// ---------------------------------------------------------------------------
// Tags Management Modal
// ---------------------------------------------------------------------------

function openTagsModal() {
  renderTagsModal();
  document.getElementById('tagsModal').hidden = false;
}

function closeTagsModal() {
  document.getElementById('tagsModal').hidden = true;
}

function renderTagsModal() {
  const list = document.getElementById('tagsList');
  if (tagDefinitions.length === 0) {
    list.innerHTML = `<p class="tags-empty-msg">${I18n.t('opts-tag-no-tags-msg')}</p>`;
    return;
  }
  list.innerHTML = '';
  for (const tag of tagDefinitions) {
    const count = Object.values(wordTags).filter((t) => t === tag.id).length;
    const item = document.createElement('div');
    item.className = 'tag-item';
    item.dataset.id = tag.id;
    item.innerHTML = `
      <span class="tag-swatch" style="background:${escapeHtml(tag.color)}"></span>
      <span class="tag-item-name">${escapeHtml(tag.name)}</span>
      <span class="tag-item-count">${count}</span>
      <div class="tag-item-actions">
        <button class="btn btn-sm btn-secondary tag-edit-btn" data-id="${escapeHtml(tag.id)}">${I18n.t('opts-tag-btn-edit')}</button>
        <button class="btn btn-sm btn-danger tag-delete-btn" data-id="${escapeHtml(tag.id)}">${I18n.t('opts-tag-btn-delete')}</button>
      </div>`;
    list.appendChild(item);
  }
}

document.getElementById('manageTagsBtn').addEventListener('click', openTagsModal);

document.getElementById('addTagForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const nameEl = document.getElementById('newTagName');
  const colorEl = document.getElementById('newTagColor');
  const name = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }
  tagDefinitions.push({ id: generateTagId(), name, color: colorEl.value });
  saveTagDefinitions(() => {
    renderTagsModal();
    renderTagFilter();
    renderWordList(document.getElementById('searchInput').value);
    nameEl.value = '';
    colorEl.value = '#4A90D9';
  });
});

document.getElementById('tagsList').addEventListener('click', (e) => {
  if (e.target.classList.contains('tag-delete-btn')) {
    const id = e.target.dataset.id;
    if (!confirm(I18n.t('confirm-delete-tag'))) return;
    tagDefinitions = tagDefinitions.filter((t) => t.id !== id);
    wordTags = Object.fromEntries(
      Object.entries(wordTags).filter(([, tid]) => tid !== id)
    );
    if (activeTagFilter === id) {
      activeTagFilter = 'all';
    }
    saveTagDefinitions(() => {
      saveWordTags(() => {
        renderTagsModal();
        renderTagFilter();
        renderWordList(document.getElementById('searchInput').value);
      });
    });
    return;
  }

  if (e.target.classList.contains('tag-edit-btn')) {
    const id = e.target.dataset.id;
    const tag = getTag(id);
    if (!tag) return;
    const item = e.target.closest('.tag-item');
    if (!item) return;

    const savedHtml = item.innerHTML;
    item.innerHTML = `
      <input type="text" class="tag-edit-name-input" value="${escapeHtml(tag.name)}" maxlength="30">
      <input type="color" class="tag-edit-color-input" value="${escapeHtml(tag.color)}">
      <div class="tag-item-actions">
        <button class="btn btn-sm btn-primary tag-save-edit-btn" data-id="${escapeHtml(id)}">${I18n.t('opts-tag-btn-save')}</button>
        <button class="btn btn-sm btn-secondary tag-cancel-edit-btn">${I18n.t('opts-tag-btn-cancel')}</button>
      </div>`;
    item.querySelector('.tag-edit-name-input').focus();

    item.querySelector('.tag-cancel-edit-btn').addEventListener('click', () => {
      item.innerHTML = savedHtml;
    }, { once: true });

    item.querySelector('.tag-save-edit-btn').addEventListener('click', () => {
      const newName = item.querySelector('.tag-edit-name-input').value.trim();
      const newColor = item.querySelector('.tag-edit-color-input').value;
      if (!newName) { item.querySelector('.tag-edit-name-input').focus(); return; }
      const idx = tagDefinitions.findIndex((t) => t.id === id);
      if (idx >= 0) {
        tagDefinitions[idx] = { id, name: newName, color: newColor };
        saveTagDefinitions(() => {
          renderTagsModal();
          renderTagFilter();
          renderWordList(document.getElementById('searchInput').value);
        });
      }
    }, { once: true });
  }
});

document.getElementById('closeTagsModalBtn').addEventListener('click', closeTagsModal);
document.getElementById('tagsModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeTagsModal();
});

document.addEventListener('keydown', (e) => {
  // While recording a new keybind, intercept all key events
  if (recording) {
    e.preventDefault();
    if (e.key === 'Escape') {
      // Cancel recording
      recording = false;
      document.getElementById('skipCapRecordBtn').textContent = I18n.t('opts-skipcap-record-btn');
      document.getElementById('skipCapKeyInput').value = settings.skipCapKey || 'Alt+K';
      document.getElementById('skipCapKeyInput').classList.remove('recording');
    } else {
      const formatted = formatKeybind(e);
      if (formatted) {
        settings.skipCapKey = formatted;
        document.getElementById('skipCapKeyInput').value = formatted;
        recording = false;
        document.getElementById('skipCapRecordBtn').textContent = I18n.t('opts-skipcap-record-btn');
        document.getElementById('skipCapKeyInput').classList.remove('recording');
        saveSettings();
      }
    }
    return;
  }
  if (e.key === 'Escape') {
    closeAchievementsModal();
    closeTagsModal();
    closeTagPicker();
    closeLookupPopup();
  }
});

// ---------------------------------------------------------------------------
// Sync language changes made from another page (e.g. popup)
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.language) {
    const lang = changes.language.newValue || 'en';
    I18n.apply(lang);
    document.getElementById('languageSelect').value = lang;
    renderTagFilter();
    renderWordList(document.getElementById('searchInput').value);
    const modal = document.getElementById('achievementsModal');
    if (modal && !modal.hidden) renderAchievements();
  }
  if (changes.cbAchievements) {
    cbAchievements = changes.cbAchievements.newValue || {};
    const modal = document.getElementById('achievementsModal');
    if (modal && !modal.hidden) renderAchievements();
  }
  if (changes.cbStats) {
    cbStats = changes.cbStats.newValue || { wordsAdded: 0, correctionsApplied: 0 };
  }
  if (changes.theme) {
    applyTheme(changes.theme.newValue || 'light');
  }
  if (changes.tagDefinitions) {
    tagDefinitions = changes.tagDefinitions.newValue || [];
    renderTagFilter();
    renderWordList(document.getElementById('searchInput').value);
  }
  if (changes.wordTags) {
    wordTags = changes.wordTags.newValue || {};
    renderWordList(document.getElementById('searchInput').value);
  }
  if (changes.wordFormats) {
    wordFormats = changes.wordFormats.newValue || {};
    renderWordList(document.getElementById('searchInput').value);
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.getElementById('fmtBoldBtn').addEventListener('click', () => {
  document.getElementById('fmtBoldBtn').classList.toggle('active');
});

document.getElementById('fmtItalicBtn').addEventListener('click', () => {
  document.getElementById('fmtItalicBtn').classList.toggle('active');
});

loadAll((lang) => {
  I18n.apply(lang);
  document.getElementById('languageSelect').value = lang;
  renderTagFilter();
  renderWordList();
  populateSettings();
});

document.getElementById('headerThemeToggle').addEventListener('click', () => {
  const isDark = document.documentElement.dataset.theme === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  applyTheme(newTheme);
  chrome.storage.local.set({ theme: newTheme });
});
