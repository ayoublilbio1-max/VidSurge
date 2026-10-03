// The user's Lib: their own audio, videos (intros, outros, clips) and images
// (logos, overlays), kept in the app to reuse in any edit.
//
//   library/index.json      the list (newest first)
//   library/<id>.<ext>      the file (a copy — the original can be deleted)
//   library/<id>.jpg        a video's picture for the list
//
// A project that uses a Lib item copies it into the project when saved, so
// deleting it from the Lib later never breaks a project.

import { Directory, File, Paths } from "expo-file-system";
import * as VideoThumbnails from "expo-video-thumbnails";

export type LibKind = "audio" | "video" | "image";

export type LibItem = {
  id: string;
  kind: LibKind;
  name: string;
  /** file:// of the copy in the app's storage. */
  uri: string;
  /** A video's frame / the image itself; null for audio. */
  thumbnailUri: string | null;
  /** Seconds (0 for images). */
  duration: number;
  /** Pixels (0 for audio). */
  width: number;
  height: number;
  createdAt: number;
};

const listeners = new Set<() => void>();

export function subscribeLibrary(listener: () => void): () => void {
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

// ---- Files ---------------------------------------------------------------------

function rootDir(): Directory {
  const dir = new Directory(Paths.document, "library");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function indexFile(): File {
  return new File(rootDir(), "index.json");
}

async function readIndex(): Promise<LibItem[]> {
  try {
    const f = indexFile();
    if (!f.exists) return [];
    const list = JSON.parse(await f.text()) as LibItem[];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    if (__DEV__) console.log("[lib] couldn't read the list", e);
    return [];
  }
}

function writeIndex(list: LibItem[]) {
  const f = indexFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify(list));
}

// One change at a time.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

function newId(): string {
  return `l-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function extensionOf(uri: string, kind: LibKind): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(uri.split("/").pop() ?? "");
  if (m) return m[1].toLowerCase();
  return kind === "audio" ? "m4a" : kind === "video" ? "mp4" : "jpg";
}

async function videoThumbnail(
  uri: string,
  id: string,
  duration: number,
): Promise<string | null> {
  try {
    const shot = await VideoThumbnails.getThumbnailAsync(uri, {
      time: Math.floor(Math.min(1000, duration * 1000 * 0.1)),
    });
    const dest = new File(rootDir(), `${id}.jpg`);
    if (dest.exists) dest.delete();
    new File(shot.uri).copy(dest);
    return dest.uri;
  } catch (e) {
    if (__DEV__) console.log("[lib] video picture failed", e);
    return null;
  }
}

// ---- API -----------------------------------------------------------------------------

export type NewLibItem = {
  kind: LibKind;
  /** The picked file (copied into the Lib). */
  sourceUri: string;
  name: string;
  duration: number;
  width: number;
  height: number;
};

/** Copies a picked file into the Lib and adds it to the top of the list. */
export function addToLibrary(n: NewLibItem): Promise<LibItem> {
  return serial(async () => {
    const id = newId();
    const dest = new File(
      rootDir(),
      `${id}.${extensionOf(n.sourceUri, n.kind)}`,
    );
    new File(n.sourceUri).copy(dest);
    const thumbnailUri =
      n.kind === "video"
        ? await videoThumbnail(dest.uri, id, n.duration)
        : n.kind === "image"
          ? dest.uri
          : null;
    const item: LibItem = {
      id,
      kind: n.kind,
      name:
        n.name.trim() ||
        (n.kind === "audio" ? "Audio" : n.kind === "video" ? "Video" : "Image"),
      uri: dest.uri,
      thumbnailUri,
      duration: n.duration,
      width: n.width,
      height: n.height,
      createdAt: Date.now(),
    };
    const list = await readIndex();
    writeIndex([item, ...list]);
    if (__DEV__)
      console.log(
        `[lib] added ${n.kind} "${item.name}" (${n.duration.toFixed(2)}s) — ${list.length + 1} item(s)`,
      );
    notify();
    return item;
  });
}

/** The list, newest first (items whose file is gone are dropped). */
export function loadLibrary(): Promise<LibItem[]> {
  return serial(async () => {
    const list = await readIndex();
    const kept = list.filter((it) => {
      try {
        return new File(it.uri).exists;
      } catch {
        return false;
      }
    });
    if (kept.length !== list.length) writeIndex(kept);
    return kept;
  });
}

export function renameLibraryItem(id: string, name: string): Promise<void> {
  return serial(async () => {
    const clean = name.trim();
    if (!clean) return;
    const list = await readIndex();
    writeIndex(list.map((it) => (it.id === id ? { ...it, name: clean } : it)));
    if (__DEV__) console.log(`[lib] renamed ${id} → "${clean}"`);
    notify();
  });
}

export function deleteLibraryItem(id: string): Promise<void> {
  return serial(async () => {
    const list = await readIndex();
    const item = list.find((it) => it.id === id);
    if (item) {
      const uris = new Set(
        [item.uri, item.thumbnailUri].filter((u): u is string => !!u),
      );
      for (const uri of uris) {
        try {
          const f = new File(uri);
          if (f.exists) f.delete();
        } catch (e) {
          if (__DEV__) console.log("[lib] couldn't delete", uri, e);
        }
      }
    }
    writeIndex(list.filter((it) => it.id !== id));
    if (__DEV__) console.log(`[lib] deleted ${id}`);
    notify();
  });
}

/** "0:07", "1:05:30". */
export function formatLibDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}
