import { describe, expect, it } from "vitest";
import {
  DEFAULT_GALLERY_STATE,
  GALLERY_STORAGE_KEY,
  loadGalleryState,
  sanitizeGalleryState,
  saveGalleryState,
} from "./galleryState";

function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    map,
  };
}

describe("loadGalleryState", () => {
  it("returns defaults when storage is empty", () => {
    expect(loadGalleryState(makeStorage())).toEqual(DEFAULT_GALLERY_STATE);
  });

  it("returns defaults on corrupt JSON", () => {
    const storage = makeStorage({ [GALLERY_STORAGE_KEY]: "{not json" });
    expect(loadGalleryState(storage)).toEqual(DEFAULT_GALLERY_STATE);
  });

  it("returns defaults when the stored value is not an object", () => {
    expect(loadGalleryState(makeStorage({ [GALLERY_STORAGE_KEY]: "42" }))).toEqual(
      DEFAULT_GALLERY_STATE,
    );
    expect(loadGalleryState(makeStorage({ [GALLERY_STORAGE_KEY]: "null" }))).toEqual(
      DEFAULT_GALLERY_STATE,
    );
  });

  it("round-trips a full custom state through save + load", () => {
    const storage = makeStorage();
    const state = {
      query: "clutch",
      gameFilter: "cs2",
      sortKey: "largest" as const,
      audioOnly: true,
      favOnly: true,
      tagFilter: "ace",
      compact: true,
    };
    saveGalleryState(state, storage);
    expect(loadGalleryState(storage)).toEqual(state);
  });

  it("swallows a throwing storage on save", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => saveGalleryState(DEFAULT_GALLERY_STATE, throwing)).not.toThrow();
  });
});

describe("sanitizeGalleryState", () => {
  it("falls back per-field on wrong types", () => {
    expect(
      sanitizeGalleryState({
        query: 42,
        gameFilter: 7,
        sortKey: "bogus",
        audioOnly: "yes",
        favOnly: 1,
        tagFilter: 123,
        compact: "on",
      }),
    ).toEqual(DEFAULT_GALLERY_STATE);
  });

  it("keeps only valid sort keys", () => {
    expect(sanitizeGalleryState({ sortKey: "oldest" }).sortKey).toBe("oldest");
    expect(sanitizeGalleryState({ sortKey: "random" }).sortKey).toBe("newest");
  });

  it("fills missing fields with defaults from a partial object", () => {
    const out = sanitizeGalleryState({ query: "valorant" });
    expect(out.query).toBe("valorant");
    expect(out.gameFilter).toBe("all");
    expect(out.sortKey).toBe("newest");
    expect(out.audioOnly).toBe(false);
    expect(out.favOnly).toBe(false);
    expect(out.tagFilter).toBeNull();
    expect(out.compact).toBe(false);
  });

  it("truncates overly long queries", () => {
    expect(sanitizeGalleryState({ query: "x".repeat(500) }).query.length).toBe(200);
  });
});
