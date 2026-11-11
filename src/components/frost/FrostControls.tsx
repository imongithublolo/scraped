"use client";

/**
 * FrostControls — the floating chrome that rides on top of the borderless
 * proxy. Left corner: back / forward / home glass circles. Right corner:
 * the reload button (left of devtools), the tabs button and the devtools
 * <> toggle. When idle they melt to near-invisible; any pointer/key
 * activity brings them back. The whole layer can be switched off in
 * settings.
 *
 * Back/forward/reload route through the stage (onBack/onForward/
 * onReload) so the frame can blur-wipe while the hop lands.
 */

import { ArrowLeft, ArrowRight, Home, RotateCw } from "lucide-react";

export default function FrostControls({
  onBack,
  onForward,
  onHome,
  onReload,
  onTabs,
  tabsOpen,
  tabCount,
  onDevtools,
  devtoolsOpen,
  idle,
}: {
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  /** reload the active page — rides the same blur wipe as back/forward */
  onReload: () => void;
  onTabs: () => void;
  tabsOpen: boolean;
  tabCount: number;
  onDevtools: () => void;
  devtoolsOpen: boolean;
  /** true = melted to near-invisible (owned by the stage: it hears both the
      parent world and the frame) */
  idle: boolean;
}) {
  return (
    <>
      {/* nav trio — bottom-left, floating glass */}
      <div
        className="frost-float frost-float-nav"
        style={{ opacity: idle ? 0.05 : 1 }}
        aria-hidden={idle}
      >
        <button
          type="button"
          className="frost-float-btn frost-glass"
          aria-label="back"
          title="back"
          onClick={onBack}
        >
          <ArrowLeft strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="frost-float-btn frost-glass"
          aria-label="forward"
          title="forward"
          onClick={onForward}
        >
          <ArrowRight strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="frost-float-btn frost-glass"
          aria-label="home"
          title="home"
          onClick={onHome}
        >
          <Home strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* tabs + reload + devtools — bottom-right, floating glass */}
      <div
        className="frost-float frost-float-dev"
        style={{ opacity: idle ? 0.05 : 1 }}
        aria-hidden={idle}
      >
        <button
          type="button"
          className="frost-float-btn frost-glass frost-float-tabs"
          aria-label={`tabs (${tabCount} open)`}
          title="tabs"
          aria-pressed={tabsOpen}
          onClick={onTabs}
        >
          {/* two stacked rounded squares — the overview mark */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4.5" y="3.5" width="15" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="1.9" />
            <path d="M3 9.6v5.9a3 3 0 0 0 3 3h9.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          {tabCount > 1 && (
            <span className="frost-float-badge" aria-hidden="true">
              {tabCount > 9 ? "9+" : tabCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className="frost-float-btn frost-glass frost-float-reload"
          aria-label="reload page"
          title="reload"
          onClick={onReload}
        >
          <RotateCw strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="frost-float-btn frost-glass"
          aria-label="devtools"
          title="devtools"
          aria-pressed={devtoolsOpen}
          onClick={onDevtools}
        >
          <span className="frost-float-devcode" aria-hidden="true">
            &lt;&gt;
          </span>
        </button>
      </div>
    </>
  );
}
