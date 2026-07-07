/* Default private-content repo the shell reads/writes.
 * These are only defaults — the gallery Settings panel can override them and
 * persists the override in localStorage. Nothing secret lives here: the PAT is
 * entered at runtime and never committed.
 */
window.DECKS_CONFIG = {
  owner: 'strikingwolf876', // GitHub owner/org of the PRIVATE decks repo
  repo:  'decks',          // repo name
  branch: 'main',          // branch to read/commit
};
