// App-wide preferences (Settings screen), kept in the app's storage, plus
// the cache tools the Settings screen uses.
//
// The default export quality is used by every project that hasn't picked
// its own (clipModel's exportOf reads it). It's loaded once when the app
// starts (this file is imported by clipModel) and kept in memory.

import { Directory, File, Paths } from "expo-file-system";
import type {
  ExportFps,
  ExportResolution,
  ExportSettings,
} from "../editor/clipModel";

/** Shown in Settings → Version. */
export const APP_VERSION = "1.0.0 (demo)";

/** Feedback goes here (Settings / Account → Send feedback). */
// Change to the address you want feedback sent to.
export const FEEDBACK_EMAIL = "feedback@vidsurge.app";

type AppPrefs = { defaultExport: ExportSettings };

const FALLBACK: AppPrefs = { defaultExport: { resolution: 1080, fps: 30 } };
const RESOLUTIONS: ExportResolution[] = [480, 720, 1080, 1440, 2160];
const FPS: ExportFps[] = [24, 30, 60];

let current: AppPrefs = FALLBACK;
const listeners = new Set<() => void>();

function prefsFile() {
  return new File(Paths.document, "app-prefs.json");
}

/** The default export quality right now (in memory). */
export function defaultExport(): ExportSettings {
  return current.defaultExport;
}

export function subscribeAppPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function load(): Promise<void> {
  try {
    const file = prefsFile();
    if (!file.exists) return;
    const data = JSON.parse(await file.text()) as Partial<AppPrefs>;
    const e = data.defaultExport;
    if (e && RESOLUTIONS.includes(e.resolution) && FPS.includes(e.fps)) {
      current = { defaultExport: { resolution: e.resolution, fps: e.fps } };
      if (__DEV__)
        console.log(
          `[appPrefs] loaded — default export ${e.resolution}P ${e.fps}fps`,
        );
      listeners.forEach((l) => l());
    }
  } catch (e) {
    if (__DEV__) console.log("[appPrefs] load failed", e);
  }
}
// Read once, as soon as the app starts.
void load();

export function setDefaultExport(settings: ExportSettings): void {
  current = { ...current, defaultExport: settings };
  listeners.forEach((l) => l());
  try {
    const file = prefsFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify(current));
    if (__DEV__)
      console.log(
        `[appPrefs] default export → ${settings.resolution}P ${settings.fps}fps`,
      );
  } catch (e) {
    if (__DEV__) console.log("[appPrefs] save failed", e);
  }
}

// ---- Cache ------------------------------------------------------------------

type SizedFile = File & { size?: number | null };

function sizeOf(entry: File | Directory): number {
  if (entry instanceof Directory) {
    let total = 0;
    try {
      for (const child of entry.list()) total += sizeOf(child);
    } catch {
      // unreadable folder: counted as empty
    }
    return total;
  }
  const s = (entry as SizedFile).size;
  return typeof s === "number" && s > 0 ? s : 0;
}

/** Bytes of temporary files (thumbnails, text pictures, picked media copies…). */
export function cacheSize(): number {
  try {
    return sizeOf(Paths.cache);
  } catch {
    return 0;
  }
}

/**
 * Deletes the temporary files. Projects and exports are NOT in the cache
 * (they're kept in the app's documents), so nothing of the user's is lost;
 * thumbnails are made again when needed. Returns the bytes freed.
 */
export function clearCache(): number {
  const before = cacheSize();
  let failed = 0;
  try {
    for (const entry of Paths.cache.list()) {
      try {
        entry.delete();
      } catch {
        failed++; // in use right now: left for next time
      }
    }
  } catch (e) {
    if (__DEV__) console.log("[appPrefs] clear cache failed", e);
  }
  const freed = Math.max(0, before - cacheSize());
  if (__DEV__)
    console.log(
      `[appPrefs] cache cleared — ${(freed / 1e6).toFixed(1)} MB freed${failed ? `, ${failed} item(s) in use kept` : ""}`,
    );
  return freed;
}

/** "12.3 MB", "640 KB", "0 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}
