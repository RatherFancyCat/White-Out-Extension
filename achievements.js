'use strict';

/**
 * ACHIEVEMENT DEFINITIONS
 *
 * To add a new achievement, push a new entry to ACHIEVEMENT_DEFINITIONS:
 *
 *   {
 *     id    : 'my-unique-id',          // stored in chrome.storage as key
 *     name  : 'Achievement Name',      // display name shown in the UI
 *     desc  : 'How to earn it',        // description shown in the UI
 *     reward: 'What it unlocks',       // string, or null for no reward
 *     check : (stats) => boolean,      // stats = { wordsAdded, correctionsApplied }
 *   }
 *
 * The check function receives the current global stats object and should
 * return true when the achievement condition has been met.
 *
 * NOTE: The `name` and `desc` fields are English reference strings kept for
 * documentation purposes. The UI reads the displayed text from the i18n keys
 * `ach-{id}-name` / `ach-{id}-desc` defined in i18n.js.
 */
const ACHIEVEMENT_DEFINITIONS = [
  {
    id: 'first-word-added',
    name: 'First Steps',
    desc: 'Add your first word to the correction list',
    reward: null,
    check: (s) => s.wordsAdded >= 1,
  },
  {
    id: 'corrections-5',
    name: 'Getting Started',
    desc: 'Have 5 words corrected — unlocks Cursor Locator',
    reward: 'cursorlocator',
    check: (s) => s.correctionsApplied >= 5,
  },
  {
    id: 'corrections-10',
    name: 'Double Digits',
    desc: 'Have 10 words corrected',
    reward: 'highlight',
    check: (s) => s.correctionsApplied >= 10,
  },
  {
    id: 'corrections-50',
    name: 'Fifty Fixes',
    desc: 'Have 50 words corrected — unlocks Word Trail',
    reward: 'wordtrail',
    check: (s) => s.correctionsApplied >= 50,
  },
  {
    id: 'corrections-100',
    name: 'Century',
    desc: 'Have 100 words corrected',
    reward: 'flair',
    check: (s) => s.correctionsApplied >= 100,
  },
  {
    id: 'corrections-500',
    name: 'Half Thousand',
    desc: 'Have 500 words corrected — unlocks Word Trail custom colour',
    reward: 'wordtrailcolor',
    check: (s) => s.correctionsApplied >= 500,
  },
  {
    id: 'corrections-1000',
    name: 'One Thousand',
    desc: 'Have 1,000 words corrected',
    reward: 'xpbar',
    check: (s) => s.correctionsApplied >= 1000,
  },
  {
    id: 'corrections-5000',
    name: 'Five Thousand',
    desc: 'Have 5,000 words corrected — unlocks Word Trail rainbow mode',
    reward: 'wordtrailrgb',
    check: (s) => s.correctionsApplied >= 5000,
  },
  {
    id: 'corrections-10000',
    name: 'Ten Thousand',
    desc: 'Have 10,000 words corrected',
    reward: null,
    check: (s) => s.correctionsApplied >= 10000,
  },
];

/**
 * Compare current stats against all achievement definitions and unlock any
 * newly-earned achievements. The updated unlocked map is returned together
 * with the list of ids that were just unlocked so callers can react (e.g.
 * show a notification).
 *
 * @param {{ wordsAdded: number, correctionsApplied: number }} stats
 * @param {Object<string, string>} unlocked  Already-unlocked map { id → ISO date string }
 * @returns {{ newlyUnlocked: string[], updated: Object<string, string> }}
 */
function processAchievements(stats, unlocked) {
  const updated = Object.assign({}, unlocked);
  const newlyUnlocked = [];
  const now = new Date().toISOString();

  for (const def of ACHIEVEMENT_DEFINITIONS) {
    if (updated[def.id]) continue; // already unlocked
    if (def.check(stats)) {
      updated[def.id] = now;
      newlyUnlocked.push(def.id);
    }
  }

  return { newlyUnlocked, updated };
}
