// Exported videos (the Exports screen).
//
// Every finished export is kept in the app's own storage, next to a small
// list of what they are:
//
//   exports/index.json     the list (newest first)
//   exports/<id>.mp4       the video
//   exports/<id>.jpg       its picture for the list
//
// The engine writes into the cache (Android may empty it any time), so the
// file is MOVED here right after the export. The copy in the phone's
// gallery is separate: deleting an export here doesn't touch it.

import { Directory, File, Paths } from "expo-file-system";
import * as VideoThumbnails from "expo-video-thumbnails";

export type ExportItem = {
  id: string;
  /** file:// of the video in the app's storage. */
  uri: string;
  thumbnailUri: string | null;
  createdAt: number;
  /** Seconds. */
  duration: number;
  sizeBytes: number;
  width: number;
  height: number;
  fps: number;
  /** The project it came from (its name at export time). */
  projectId: string | null;
  projectName: string | null;
  /** Also saved in the phone's gallery. */
  inGallery: boolean;
};

// ---- Change notifications ------------------------------------------------

const listeners = new Set<() => void>();

export function subscribeExports(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // a listener's error is not the storage's problem
    }
  }
}

// ---- Files -------------------------------------------------------------------

function rootDir(): Directory {
  const dir = new Directory(Paths.document, "exports");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function indexFile(): File {
  return new File(rootDir(), "index.json");
}

async function readIndex(): Promise<ExportItem[]> {
  try {
    const f = indexFile();
    if (!f.exists) return [];
    const list = JSON.parse(await f.text()) as ExportItem[];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    if (__DEV__) console.log("[exports] couldn't read the list", e);
    return [];
  }
}

function writeIndex(list: ExportItem[]) {
  const f = indexFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify(list));
}

// One change at a time (two exports finishing together must not lose one).
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

function newExportId(): string {
  return `e-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The export's picture (a frame near the start), kept next to it. */
async function makeThumbnail(
  videoUri: string,
  id: string,
  duration: number,
): Promise<string | null> {
  const at = Math.min(500, Math.max(0, duration * 1000 * 0.1));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const shot = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: Math.floor(at),
      });
      const dest = new File(rootDir(), `${id}.jpg`);
      if (dest.exists) dest.delete();
      new File(shot.uri).copy(dest);
      return dest.uri;
    } catch (e) {
      if (__DEV__)
        console.log(`[exports] thumbnail attempt ${attempt + 1} failed`, e);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return null;
}

// ---- API -----------------------------------------------------------------------

export type NewExport = {
  /** The engine's output (in the cache) — moved into the app's storage. */
  fileUri: string;
  duration: number;
  sizeBytes: number;
  width: number;
  height: number;
  fps: number;
  projectId: string | null;
  projectName: string | null;
};

/**
 * Keeps a finished export: moves the file into the app's storage, makes
 * its picture and adds it to the top of the list. Returns the kept item —
 * its `uri` is where the video now is (share / gallery from there).
 */
export function addExport(e: NewExport): Promise<ExportItem> {
  return serial(async () => {
    const id = newExportId();
    const source = new File(e.fileUri);
    const dest = new File(rootDir(), `${id}.mp4`);
    try {
      source.move(dest);
    } catch (err) {
      // Moving across folders can fail on some phones: copy instead.
      if (__DEV__) console.log("[exports] move failed — copying", err);
      source.copy(dest);
      try {
        source.delete();
      } catch {
        // the cache copy goes away with the cache
      }
    }
    const uri = dest.uri;
    const thumbnailUri = await makeThumbnail(uri, id, e.duration);
    const item: ExportItem = {
      id,
      uri,
      thumbnailUri,
      createdAt: Date.now(),
      duration: e.duration,
      sizeBytes: e.sizeBytes,
      width: e.width,
      height: e.height,
      fps: e.fps,
      projectId: e.projectId,
      projectName: e.projectName,
      inGallery: false,
    };
    const list = await readIndex();
    writeIndex([item, ...list]);
    if (__DEV__)
      console.log(
        `[exports] kept ${id} — ${e.width}x${e.height} ${e.fps}fps, ${e.duration.toFixed(2)}s, ${(e.sizeBytes / 1e6).toFixed(1)} MB (${list.length + 1} export(s))`,
      );
    notify();
    return item;
  });
}

/** Marks an export as saved in the phone's gallery. */
export function markInGallery(id: string): Promise<void> {
  return serial(async () => {
    const list = await readIndex();
    writeIndex(
      list.map((it) => (it.id === id ? { ...it, inGallery: true } : it)),
    );
    notify();
  });
}

/** The list, newest first. Exports whose video file is gone are dropped. */
export function loadExports(): Promise<ExportItem[]> {
  return serial(async () => {
    const list = await readIndex();
    const kept = list.filter((it) => {
      try {
        return new File(it.uri).exists;
      } catch {
        return false;
      }
    });
    if (kept.length !== list.length) {
      if (__DEV__)
        console.log(
          `[exports] ${list.length - kept.length} missing file(s) removed from the list`,
        );
      writeIndex(kept);
    }
    return kept;
  });
}

/** Deletes an export from the app (the gallery copy stays). */
export function deleteExport(id: string): Promise<void> {
  return serial(async () => {
    const list = await readIndex();
    const item = list.find((it) => it.id === id);
    if (item) {
      for (const uri of [item.uri, item.thumbnailUri]) {
        if (!uri) continue;
        try {
          const f = new File(uri);
          if (f.exists) f.delete();
        } catch (e) {
          if (__DEV__) console.log("[exports] couldn't delete", uri, e);
        }
      }
    }
    writeIndex(list.filter((it) => it.id !== id));
    if (__DEV__) console.log(`[exports] deleted ${id}`);
    notify();
  });
}
