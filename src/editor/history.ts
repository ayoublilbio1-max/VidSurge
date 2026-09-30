// Undo / redo (step 4).
//
// Wraps projectReducer with past / present / future. Every edit that
// changes the project (split, delete, move, trim, unlock, add audio...) is
// one step; an action that changes nothing (the reducer returns the same
// state) is not recorded. Loading the source (INIT_SOURCE) starts a fresh
// history — you can't undo the video away.
//
// Pure, like projectReducer: no logging, no side effects.

import type { Project } from "./clipModel";
import { projectReducer, type ProjectAction } from "./projectReducer";

/** How many steps are kept (oldest dropped first). */
export const MAX_HISTORY = 100;

/** A project the user can go back / forward to, and what led away from it. */
export type HistoryEntry = {
  project: Project;
  /** The edit that turned this project into the next one ("split video"). */
  label: string;
};

export type History = {
  past: HistoryEntry[];
  present: Project;
  future: HistoryEntry[];
};

export type HistoryAction =
  | { type: "APPLY"; action: ProjectAction; label: string }
  | { type: "UNDO" }
  | { type: "REDO" }
  // A saved project was opened: it becomes the present, with a fresh
  // history (undo doesn't go back past the moment it was opened).
  | { type: "RESET"; project: Project };

export function createHistory(project: Project): History {
  return { past: [], present: project, future: [] };
}

export function historyReducer(
  history: History,
  action: HistoryAction,
): History {
  switch (action.type) {
    case "APPLY": {
      const next = projectReducer(history.present, action.action);
      if (next === history.present) return history;
      if (action.action.type === "INIT_SOURCE") return createHistory(next);
      return {
        past: [
          ...history.past,
          { project: history.present, label: action.label },
        ].slice(-MAX_HISTORY),
        present: next,
        future: [], // a new edit after an undo drops the redo steps
      };
    }

    case "UNDO": {
      const previous = history.past[history.past.length - 1];
      if (!previous) return history;
      return {
        past: history.past.slice(0, -1),
        present: previous.project,
        future: [
          { project: history.present, label: previous.label },
          ...history.future,
        ],
      };
    }

    case "REDO": {
      const next = history.future[0];
      if (!next) return history;
      return {
        past: [
          ...history.past,
          { project: history.present, label: next.label },
        ],
        present: next.project,
        future: history.future.slice(1),
      };
    }

    case "RESET":
      return createHistory(action.project);

    default:
      return history;
  }
}
