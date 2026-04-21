# White-Out Spell Checker (Corretor Branco)

A browser extension that automatically corrects spelling errors in real-time based on your custom word list.

## 📋 Overview

White-Out Spell Checker is a powerful, customizable spell-checking browser extension that corrects your misspellings as you type across all websites. Unlike traditional spell checkers that only highlight errors, this extension automatically replaces misspelled words with their correct versions based on your personal dictionary.

## ✨ Features

### Core Functionality
- **Real-Time Auto-Correction**: Automatically corrects words as you type when you press space or punctuation
- **Custom Word Dictionary**: Build your own list of commonly misspelled words and their corrections
- **Multi-Language Interface**: Available in  English, Portuguese, Spanish, French, German, and Chinese (More to be added)
- **Universal Coverage**: Works on all websites (unless specifically blacklisted)

### Smart Capitalization
- **Auto-Capitalize**: Automatically capitalizes the first letter of sentences
- **Sentence Detection**: Recognizes sentence boundaries (periods, exclamation marks, question marks, and block-level elements)
- **Skip Capitalization**: Configurable keyboard shortcut to temporarily disable capitalization for the current sentence

### Customization Options
- **Domain Blacklist**: Disable the extension on specific websites
- **Word Formatting**: Preserve specific capitalization patterns for corrected words
- **Theme Support**: Choose between light and dark themes
- **Visual Effects**: Unlock special effects through the achievement system:
  - Cursor Locator
  - Highlight Corrections
  - Word Trail with customizable colors
  - Correction Flair (emoji celebrations)
  - Rainbow Word Trail

### Additional Tools
- **Context Menu Integration**: Right-click selected text to:
  - Add words to your correction dictionary
  - Look up word definitions
  - Change capitalization (uppercase/lowercase)
- **Definition Lookup**: Integrated dictionary lookup supporting English and Portuguese
- **Test Sandbox**: Dedicated testing area to try out your corrections without affecting other pages
- **Achievement System**: Gamified progression that unlocks new features as you use the extension

## 🎯 How to Use

### Chrome Web Store Extension
[[Link to Extension!]](https://chromewebstore.google.com/detail/white-out-spell-checker/fdiadagnneccmgfgddbnnnobgafeodid)

### Manual Installation
1. Clone or download this repository
2. Open your browser's extension management page:
   - **Chrome/Edge**: Navigate to `chrome://extensions/`
   - **Firefox**: Navigate to `about:addons`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the extension directory
5. The White-Out Spell Checker icon will appear in your browser toolbar

### Adding Word Pairs
1. Click the extension icon in your browser toolbar
2. Click "Manage Words"
3. Add word pairs in the format: `misspelledword → correctword`
   - Example: `teh → the`
   - Example: `recieve → receive`
4. Save your changes

### Quick Add via Context Menu
1. Select any word on a webpage
2. Right-click and choose "Add as misspelled word"
3. Enter the correct spelling
4. The word pair is immediately added to your dictionary

### Configuring Settings

#### Auto-Capitalization
1. Open the Options page (Manage Words)
2. Check "Automatically capitalize the first word of a sentence"
3. Optionally enable the skip-capitalization keybind (default: Alt+K)

#### Domain Blacklist
1. Open the Options page
2. Scroll to "Domain Blacklist"
3. Add one domain per line (e.g., `example.com`)
4. Click "Save"

#### Changing the Interface Language
1. Click the extension icon
2. Use the language dropdown at the bottom
3. Select your preferred language

### Using the Test Sandbox
1. Click the extension icon
2. Click "Test Area"
3. Type text to see your corrections in action
4. View a log of all corrections made in real-time

## ⚡ Keyboard Shortcuts

- **Skip Capitalization** (when enabled): `Alt+K` (customizable)
  - Temporarily disables auto-capitalization until the end of the current sentence
  - Useful for typing abbreviations, code, or intentionally lowercase text

## 🏆 Achievement System

The extension includes a gamification system that rewards you for using it:

| Achievement | Requirement | Reward |
|------------|-------------|---------|
| First Steps | Add your first word | - |
| Getting Started | 5 corrections applied | Unlocks Cursor Locator |
| Double Digits | 10 corrections applied | Unlocks Highlight Corrections |
| Fifty Fixes | 50 corrections applied | Unlocks Word Trail |
| Century | 100 corrections applied | Unlocks Correction Flair |
| Half Thousand | 500 corrections applied | Unlocks Word Trail Custom Color |
| One Thousand | 1,000 corrections applied | Unlocks XP Bar |
| Five Thousand | 5,000 corrections applied | Unlocks Rainbow Word Trail |
| Ten Thousand | 10,000 corrections applied | Master Status! |

## 🎨 Visual Effects

Once unlocked through achievements, you can enable various visual effects in the Options page:

- **Highlight Corrections**: Briefly highlights corrected words
- **Correction Flair**: Shows celebratory emojis (✨🎉⭐💫✅) when corrections are made
- **Word Trail**: Leaves a colorful trail behind corrected words
- **Cursor Locator**: Visual indicator for cursor position
- **Rainbow Mode**: Enables a special feature that allows the word trail cycle through rainbow colors

## 📝 Tips and Best Practices

1. **Start Small**: Begin with your most common typos
2. **Case Sensitivity**: The extension preserves the case of your typing unless auto-capitalize is triggered
3. **Test First**: Use the sandbox to verify corrections before relying on them in important documents
4. **Domain Blacklist**: Add sites like code editors or terminals where auto-correction might interfere
5. **Import/Export from CSV**: You can Export or Import word pairs. Take your list with you, or share with colleagues.

## 🔧 Technical Details

- **Manifest Version**: 3
- **Permissions Required**:
  - `storage`: Store your word dictionary and settings
  - `tabs`: Manage extension state across tabs
  - `contextMenus`: Add right-click menu options
  - `host_permissions: <all_urls>`: Apply corrections on all websites

### File Structure
```
Corretor_Branco_v2/
├── manifest.json          # Extension configuration
├── background.js          # Service worker for context menus
├── content.js             # Main correction logic
├── popup.html/js/css      # Extension popup interface
├── options.html/js/css    # Settings and word management page
├── sandbox.html/js/css    # Testing environment
├── achievements.js        # Achievement system logic
├── i18n.js               # Internationalization strings
└── icons/                # Extension icons
```

## 🌐 Supported Languages

**Interface Languages:**
- 🇬🇧 English
- 🇵🇹 Portuguese (Portugal)
- 🇪🇸 Spanish
- 🇫🇷 French
- 🇩🇪 German
- 🇨🇳 Chinese

**Dictionary Lookup:**
- English (via dictionaryapi.dev)
- Portuguese (via dicionario-aberto.net)
- Other languages do not have a direct API *that I know of.*

## 🐛 Troubleshooting

**Corrections aren't working:**
- Check if the extension is enabled (toggle in popup)
- Verify the current domain isn't in your blacklist
- Ensure the word pair exists in your dictionary

**Auto-capitalization not working:**
- Enable it in the Options page
- Check if you've pressed the skip-capitalization keybind

**Visual effects not appearing:**
- Make sure you've unlocked them through achievements
- Enable them in the Secret Options section (Options page)
- Some pages may have specific css styles that may prevent this.

## 📜 License

This project is available for personal and educational use.

## 🤝 Contributing

Feel free to submit issues, suggestions, or improvements to enhance the extension!

---

**Version**: 2.7.3
Made with ❤️ for better typing
