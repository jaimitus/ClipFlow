/**
 * Persisted gallery view state (filter / sort / compact), so reopening the app
 * lands exactly where the user left the library. Stored in localStorage as a
 * single JSON blob; storage is injected so the logic is unit-testable in node.
 */

export type SortKey =
  | "newest"
  | "oldest"
  | "largest"
  | "smallest"
  | "longest"
  | "shortest";

export const SORT_KEYS: readonly SortKey[] = [
  "newest",
  "oldest",
  "largest",
  "smallest",
  "longest",
  "shortest",
];

export interface GalleryState {
  query: string;
  gameFilter: string;
  sortKey: SortKey;
  audioOnly: boolean;
  favOnly: boolean;
  tagFilter: string | null;
  compact: boolean;
}

export const DEFAULT_GALLERY_STATE: GalleryState = {
  query: "",
  gameFilter: "all",
  sortKey: "newest",
  audioOnly: false,
  favOnly: false,
  tagFilter: null,
  compact: false,
};

export const GALLERY_STORAGE_KEY = "clipflow.gallery.state.v1";

/** Longest query worth keeping — guards against junk data. */
const MAX_QUERY_LENGTH = 200;

const isSortKey = (v: unknown): v is SortKey =>
  typeof v === "string" && (SORT_KEYS as readonly string[]).includes(v);

/** Coerces whatever came out of storage into a valid GalleryState. */
export function sanitizeGalleryState(raw: unknown): GalleryState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GALLERY_STATE };
  const r = raw as Record<string, unknown>;
  return {
    query:
      typeof r.query === "string"
        ? r.query.slice(0, MAX_QUERY_LENGTH)
        : DEFAULT_GALLERY_STATE.query,
    gameFilter:
      typeof r.gameFilter === "string" ? r.gameFilter : DEFAULT_GALLERY_STATE.gameFilter,
    sortKey: isSortKey(r.sortKey) ? r.sortKey : DEFAULT_GALLERY_STATE.sortKey,
    audioOnly: r.audioOnly === true,
    favOnly: r.favOnly === true,
    tagFilter: typeof r.tagFilter === "string" ? r.tagFilter : null,
    compact: r.compact === true,
  };
}

export function loadGalleryState(
  storage: Pick<Storage, "getItem"> = localStorage,
): GalleryState {
  try {
    const raw = storage.getItem(GALLERY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GALLERY_STATE };
    return sanitizeGalleryState(JSON.parse(raw));
  } catch {
    // Unreadable / corrupt blob — start fresh.
    return { ...DEFAULT_GALLERY_STATE };
  }
}

export function saveGalleryState(
  state: GalleryState,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(GALLERY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable (e.g. disabled) — the filter simply won't persist.
  }
}
