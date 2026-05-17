// Notepad priority note — omcp-specific. Renders the first non-empty,
// non-bullet line of .omcp/notepad.md (truncated to NOTE_MAX chars).
// Kept as a HUD element for parity with omc's "PRD/active task" surfaces.

import type { HudState } from "../types.js";

const NOTE_MAX = 60;

export function renderNotepadPriority(state: HudState): string | null {
  const note = state.priorityNote;
  if (!note) return null;
  if (note.length > NOTE_MAX) {
    return `${note.slice(0, NOTE_MAX - 1)}…`;
  }
  return note;
}

export { NOTE_MAX };
