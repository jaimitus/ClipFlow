/**
 * Pure multi-selection state for the clip gallery (file-manager semantics).
 *
 * The reducer never touches the DOM or the backend — App feeds it the current
 * visible clip order (the `filtered` list) and a click action; it returns the
 * next selection. That keeps Ctrl/Shift range logic unit-testable.
 *
 * Selections are keyed by absolute clip path, which is stable across rescans
 * (unlike `id`, which is re-derived from the path hash + timestamp).
 */

export interface SelectionState {
  /** The last clicked path — shift-clicks extend the range from it. */
  anchor: string | null;
  /** Selected clip paths, in click order. */
  selected: string[];
}

export const EMPTY_SELECTION: SelectionState = { anchor: null, selected: [] };

export type SelectionAction =
  | {
      type: "click";
      path: string;
      /** Visible order of the gallery (used to map shift-click ranges). */
      order: string[];
      ctrl: boolean;
      shift: boolean;
    }
  | { type: "select-all"; order: string[] }
  | { type: "clear" }
  | { type: "remove"; paths: string[] };

export function isSelected(state: SelectionState, path: string): boolean {
  return state.selected.includes(path);
}

export function selectionCount(state: SelectionState): number {
  return state.selected.length;
}

export function selectionReducer(
  state: SelectionState,
  action: SelectionAction,
): SelectionState {
  switch (action.type) {
    case "clear":
      return EMPTY_SELECTION;

    case "select-all":
      return { anchor: action.order[0] ?? null, selected: [...action.order] };

    case "remove": {
      const gone = new Set(action.paths);
      return {
        anchor: state.anchor && gone.has(state.anchor) ? null : state.anchor,
        selected: state.selected.filter((p) => !gone.has(p)),
      };
    }

    case "click": {
      const { path, order, ctrl, shift } = action;

      // Plain click replaces the whole selection with just this clip.
      if (!ctrl && !shift) {
        return { anchor: path, selected: [path] };
      }

      // Shift-click: select the range from the anchor to this clip, in the
      // current visible order. If the anchor is gone (filtered out, deleted),
      // fall back to a plain single selection.
      if (shift && state.anchor) {
        const a = order.indexOf(state.anchor);
        const b = order.indexOf(path);
        if (a !== -1 && b !== -1) {
          const [from, to] = a <= b ? [a, b] : [b, a];
          const range = order.slice(from, to + 1);
          if (ctrl) {
            // Ctrl+Shift: union the range with the existing selection.
            return {
              anchor: path,
              selected: Array.from(new Set([...state.selected, ...range])),
            };
          }
          return { anchor: path, selected: range };
        }
        return { anchor: path, selected: [path] };
      }

      // Ctrl (or Cmd) click: toggle just this clip in the selection.
      const has = state.selected.includes(path);
      const selected = has
        ? state.selected.filter((p) => p !== path)
        : [...state.selected, path];
      return { anchor: path, selected };
    }
  }
}
