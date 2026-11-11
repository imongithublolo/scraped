/**
 * frost-tab-info — the tab shape the chrome shares (stage-owned).
 * Lives apart from the chrome components so any of them can type
 * against the stage's tab list without importing a whole widget.
 */

export interface FrostTabInfo {
  id: string;
  /** null = a new-tab page */
  url: string | null;
  title: string;
}
