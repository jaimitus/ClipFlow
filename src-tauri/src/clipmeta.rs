//! Per-clip user metadata (favourites + custom tags).
//!
//! Clips are plain files on disk, so this data cannot live inside them. It is
//! kept in a tiny sidecar JSON in the ClipFlow app-data folder, keyed by the
//! absolute clip path, so it survives restarts and stays 100% local — no
//! cloud, no account, no telemetry. The gallery scan merges it on every
//! refresh and prunes entries whose clip has been deleted.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::media::library::ClipMetadata;

/// User metadata for one clip. Both fields are `#[serde(default)]` so older
/// sidecar files (or entries written before a field existed) stay readable.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClipMetaEntry {
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    entries: HashMap<String, ClipMetaEntry>,
}

const MAX_TAGS: usize = 12;
const MAX_TAG_LEN: usize = 24;

/// Shared tag cleaning used by both the single- and batch-tag paths: trim,
/// drop empties, cap length, dedupe, cap count.
fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    tags.into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(MAX_TAG_LEN).collect::<String>())
        .filter(|t| seen.insert(t.clone()))
        .take(MAX_TAGS)
        .collect()
}

pub struct ClipMetaStore {
    path: PathBuf,
    entries: HashMap<String, ClipMetaEntry>,
}

impl ClipMetaStore {
    pub fn load() -> Self {
        let path = store_path();
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StoreFile>(&raw).ok())
            .map(|f| f.entries)
            .unwrap_or_default();
        Self { path, entries }
    }

    fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&StoreFile {
            entries: self.entries.clone(),
        })
        .map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())
    }

    pub fn get(&self, path: &str) -> ClipMetaEntry {
        self.entries.get(path).cloned().unwrap_or_default()
    }

    /// Marks a clip as favourite (or unmarks it). Persists immediately.
    pub fn set_favorite(&mut self, path: &str, favorite: bool) -> Result<ClipMetaEntry, String> {
        {
            let entry = self.entries.entry(path.to_string()).or_default();
            entry.favorite = favorite;
        }
        self.save()?;
        Ok(self.entries.get(path).cloned().unwrap_or_default())
    }

    /// Replaces the tag set of a clip. Tags are trimmed, deduplicated,
    /// length-capped and limited in count, then persisted immediately.
    pub fn set_tags(&mut self, path: &str, tags: Vec<String>) -> Result<ClipMetaEntry, String> {
        let cleaned = clean_tags(tags);
        {
            let entry = self.entries.entry(path.to_string()).or_default();
            entry.tags = cleaned;
        }
        self.save()?;
        Ok(self.entries.get(path).cloned().unwrap_or_default())
    }

    /// Stars / unstars many clips with a single persist. Returns how many
    /// entries actually changed value (batch library management).
    pub fn set_favorite_many(&mut self, paths: &[String], favorite: bool) -> u32 {
        let mut changed = 0u32;
        for p in paths {
            let entry = self.entries.entry(p.clone()).or_default();
            if entry.favorite != favorite {
                entry.favorite = favorite;
                changed += 1;
            }
        }
        let _ = self.save();
        changed
    }

    /// Appends one tag to many clips (dedup + caps, single persist). Returns
    /// how many clips actually gained the tag.
    pub fn add_tag_many(&mut self, paths: &[String], tag: &str) -> u32 {
        let cleaned = clean_tags(vec![tag.to_string()]);
        let Some(tag) = cleaned.into_iter().next() else {
            return 0;
        };
        let mut changed = 0u32;
        for p in paths {
            let entry = self.entries.entry(p.clone()).or_default();
            if entry.tags.len() >= MAX_TAGS || entry.tags.contains(&tag) {
                continue;
            }
            entry.tags.push(tag.clone());
            changed += 1;
        }
        let _ = self.save();
        changed
    }

    /// Removes one tag from many clips (single persist). Returns how many
    /// clips actually lost the tag.
    pub fn remove_tag_many(&mut self, paths: &[String], tag: &str) -> u32 {
        let mut changed = 0u32;
        for p in paths {
            if let Some(entry) = self.entries.get_mut(p) {
                let before = entry.tags.len();
                entry.tags.retain(|t| t != tag);
                if entry.tags.len() != before {
                    changed += 1;
                }
            }
        }
        let _ = self.save();
        changed
    }

    /// Moves an entry to a new key (used when a clip is renamed on disk) so
    /// favourites and tags survive renames.
    pub fn migrate(&mut self, old_path: &str, new_path: &str) {
        if let Some(entry) = self.entries.remove(old_path) {
            self.entries.insert(new_path.to_string(), entry);
            let _ = self.save();
        }
    }

    /// Applies stored metadata onto a scanned clip list (matched by absolute
    /// path) and prunes entries whose clip no longer exists on disk. Runs
    /// inside the gallery scan so the UI always gets one consistent snapshot.
    pub fn merge_into(&mut self, clips: &mut [ClipMetadata]) {
        let live: std::collections::HashSet<String> =
            clips.iter().map(|c| c.path.clone()).collect();
        let before = self.entries.len();
        self.entries.retain(|path, _| live.contains(path));
        let dirty = self.entries.len() != before;
        for clip in clips.iter_mut() {
            if let Some(e) = self.entries.get(&clip.path) {
                clip.favorite = e.favorite;
                clip.tags = e.tags.clone();
            }
        }
        if dirty {
            let _ = self.save();
        }
    }
}

fn store_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("ClipFlow").join("clip_meta.json");
        }
    }
    std::env::temp_dir().join("ClipFlow").join("clip_meta.json")
}
