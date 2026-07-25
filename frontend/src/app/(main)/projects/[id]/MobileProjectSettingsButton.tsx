"use client";

/**
 * Standalone mobile button removed: the project pill in `ChatHeader` is now
 * itself a clickable affordance (toggles the settings panel on project
 * routes, navigates to /projects/[id] from elsewhere), and a fixed FAB
 * overlapped the Composer Send button. This file is kept as a no-op export
 * so the existing imports in the project routes still resolve, but the
 * rendered element is invisible.
 */
export function MobileProjectSettingsButton() {
  return null;
}
