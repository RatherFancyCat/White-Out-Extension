'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const enabledToggle = document.getElementById('enabledToggle');
  const wordCountEl = document.getElementById('wordCount');
  const openOptionsBtn = document.getElementById('openOptions');
  const openSandboxBtn = document.getElementById('openSandbox');
  const langSelect = document.getElementById('langSelect');
  const themeToggle = document.getElementById('themeToggle');

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    themeToggle.checked = theme === 'dark';
  }

  // Populate UI from storage (including language and theme)
  chrome.storage.local.get(['enabled', 'wordMap', 'language', 'theme'], (data) => {
    enabledToggle.checked = data.enabled !== false;
    wordCountEl.textContent = data.wordMap ? Object.keys(data.wordMap).length : 0;
    const lang = data.language || 'en';
    I18n._lang = lang;
    I18n.apply(lang);
    langSelect.value = lang;
    applyTheme(data.theme || 'light');
  });

  // Toggle the extension on/off
  enabledToggle.addEventListener('change', () => {
    chrome.storage.local.set({ enabled: enabledToggle.checked });
  });

  // Open the options/word-list page
  openOptionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Open the sandbox in a new tab
  openSandboxBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('sandbox.html') });
  });

  // Switch language immediately and persist the choice
  langSelect.addEventListener('change', () => {
    const lang = langSelect.value;
    chrome.storage.local.set({ language: lang }, () => {
      I18n.apply(lang);
    });
  });

  // Switch theme immediately and persist the choice
  themeToggle.addEventListener('change', () => {
    const theme = themeToggle.checked ? 'dark' : 'light';
    applyTheme(theme);
    chrome.storage.local.set({ theme });
  });

  // Keep word count, language, and theme in sync while popup is open
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.wordMap) {
      wordCountEl.textContent = Object.keys(changes.wordMap.newValue || {}).length;
    }
    if (changes.language) {
      const lang = changes.language.newValue || 'en';
      I18n.apply(lang);
      langSelect.value = lang;
    }
    if (changes.theme) {
      applyTheme(changes.theme.newValue || 'light');
    }
  });
});
