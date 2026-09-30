// Saved projects ("Recent projects").
//
// Everything lives in the app's own storage (Paths.document), one folder
// per project:
//
//   projects/<id>/meta.json          name, dates, length, thumbnail (the list)
//   projects/<id>/project.json       the whole edit (clips, canvas...)
//   projects/<id>/thumb-<time>.jpg   the picture shown in the list
//   projects/<id>/media/<name>       copies of the videos / photos / songs
//
// Media is COPIED in: picked files often sit in the phone's temporary
// cache, which Android may empty at any time — an old project would then
// open with missing clips. The copy happens once per file (same name every
// time), and media the edit no longer uses is removed on the next save.
//
// The copies are only used in the SAVED project: the editor that is open
// keeps playing its original files (swapping a playing player's file would
// make it reload). When the project is opened again, it uses the copies.

import { Directory, File, Paths } from "expo-file-system";
import * as VideoThumbnails from "expo-video-thumbnails";
import {
  projectEnd,
  TRACK_IDS,
  type Clip,
  type Project,
} from "../editor/clipModel";

/** Bumped if the saved format ever changes in an incompatible way. */
const FORMAT = 1;

/** What the "Recent projects" list shows. */
export type ProjectItem = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Length of the edit (seconds). */
  duration: number;
  /** The first video (a copy in the project folder) — opens the editor. */
  videoUri: string;
  thumbnailUri: string | null;
};

type SavedMeta = ProjectItem & { format: number };

export type SavedProject = ProjectItem & { project: Project };

// ---- Change notifications ------------------------------------------------
// The home screen listens, so the list updates when a save that was still
// running when you left the editor finishes.

const listeners = new Set<() => void>();

export function subscribeProjects(listener: () => void): () => void {
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

// ---- Paths -----------------------------------------------------------------

function rootDir(): Directory {
  const dir = new Directory(Paths.document, "projects");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function projectDir(id: string): Directory {
  return new Directory(rootDir(), id);
}

function mediaDir(id: string): Directory {
  const dir = new Directory(projectDir(id), "media");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function writeJson(file: File, data: unknown) {
  if (!file.exists) file.create();
  file.write(JSON.stringify(data));
}

async function readJson<T>(file: File): Promise<T | null> {
  try {
    if (!file.exists) return null;
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
}

/** Same file → same name every time (so it's copied only once). */
function mediaNameFor(uri: string): string {
  let h = 5381;
  for (let i = 0; i < uri.length; i++) h = ((h * 33) ^ uri.charCodeAt(i)) >>> 0;
  const clean = uri.split("?")[0].split("#")[0];
  const last = clean.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  const ext =
    dot > 0
      ? last
          .slice(dot + 1)
          .toLowerCase()
          .slice(0, 5)
      : "bin";
  return `${h.toString(36)}.${ext}`;
}

function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** "Project 28 Sep, 02:10" */
function defaultName(time: number): string {
  const d = new Date(time);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `Project ${d.getDate()} ${months[d.getMonth()]}, ${hh}:${mm}`;
}

/** Does the edit have anything worth saving? */
export function hasContent(project: Project): boolean {
  return TRACK_IDS.some((t) => project.tracks[t].length > 0);
}

// ---- Saving ------------------------------------------------------------------

// One save at a time (leaving the editor and the app going to the
// background can both ask for one at the same moment).
let queue: Promise<unknown> = Promise.resolve();

export type SaveRequest = {
  /** null = a new project (an id is made up and returned). */
  id: string | null;
  /** The source the editor was opened with. */
  videoUri: string;
  project: Project;
};

export function saveProject(req: SaveRequest): Promise<ProjectItem> {
  const run = queue.then(() => doSave(req));
  queue = run.catch(() => undefined);
  return run;
}

async function doSave(req: SaveRequest): Promise<ProjectItem> {
  const startedAt = Date.now();
  const id = req.id ?? newProjectId();
  const dir = projectDir(id);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const media = mediaDir(id);
  const mediaUri = media.uri.endsWith("/") ? media.uri : `${media.uri}/`;

  // 1. Copy every file the edit uses into the project folder.
  const map = new Map<string, string>();
  const copyIn = (uri: string): string => {
    if (!uri) return uri;
    if (map.has(uri)) return map.get(uri)!;
    if (uri.startsWith(mediaUri)) {
      map.set(uri, uri);
      return uri;
    }
    let result = uri;
    try {
      const dest = new File(media, mediaNameFor(uri));
      if (!dest.exists) {
        new File(uri).copy(dest);
        if (__DEV__)
          console.log(
            `[projects] copied ${uri.split("/").pop()} → ${dest.name}`,
          );
      }
      result = dest.uri;
    } catch (e) {
      // Keep the original (the project still opens while it exists).
      if (__DEV__)
        console.log(
          `[projects] could not copy ${uri} — keeping the original`,
          e,
        );
    }
    map.set(uri, result);
    return result;
  };

  const tracks = { ...req.project.tracks };
  for (const t of TRACK_IDS) {
    tracks[t] = req.project.tracks[t].map((clip: Clip) => {
      const next = copyIn(clip.sourceUri);
      return next === clip.sourceUri ? clip : { ...clip, sourceUri: next };
    });
  }
  const saved: Project = { ...req.project, tracks };
  const videoUri = req.videoUri
    ? copyIn(req.videoUri)
    : (tracks.video[0]?.sourceUri ?? "");

  // 2. Media the edit no longer uses: removed.
  const used = new Set(map.values());
  try {
    for (const entry of media.list()) {
      if (entry instanceof File && !used.has(entry.uri)) {
        entry.delete();
        if (__DEV__) console.log(`[projects] removed unused ${entry.name}`);
      }
    }
  } catch {
    // not important
  }

  // 3. The list picture: a frame of the first video clip (or PIP video).
  const old = await readJson<SavedMeta>(new File(dir, "meta.json"));
  const now = Date.now();
  let thumbnailUri: string | null = old?.thumbnailUri ?? null;
  const first =
    tracks.video[0] ??
    tracks.pip.find(
      (c) => (c.data as { kind?: string } | undefined)?.kind === "video",
    ) ??
    null;
  if (first) {
    try {
      // The frame at the clip's start; if the phone can't grab that one
      // (it failed on the very first save — a file that was just copied),
      // a bit later, then from the original file.
      const originalUri =
        [...map.entries()].find(([, copy]) => copy === first.sourceUri)?.[0] ??
        first.sourceUri;
      const at = Math.floor(first.trimIn * 1000);
      const attempts: [string, number][] = [
        [first.sourceUri, at],
        [first.sourceUri, at + 500],
        [originalUri, at],
      ];
      let shot: { uri: string } | null = null;
      for (const [uri, time] of attempts) {
        try {
          shot = await VideoThumbnails.getThumbnailAsync(uri, {
            time,
            quality: 0.6,
          });
          break;
        } catch {
          if (__DEV__)
            console.log(
              `[projects] thumbnail at ${time}ms failed — trying again`,
            );
        }
      }
      if (!shot) throw new Error("no frame");
      // A new file name each time: image views cache by address.
      const dest = new File(dir, `thumb-${now}.jpg`);
      new File(shot.uri).copy(dest);
      for (const entry of dir.list()) {
        if (
          entry instanceof File &&
          entry.name.startsWith("thumb-") &&
          entry.uri !== dest.uri
        ) {
          entry.delete();
        }
      }
      thumbnailUri = dest.uri;
    } catch (e) {
      if (__DEV__) console.log("[projects] thumbnail failed", e);
    }
  }

  // 4. Write the edit, then the list entry.
  writeJson(new File(dir, "project.json"), { format: FORMAT, project: saved });
  const meta: SavedMeta = {
    format: FORMAT,
    id,
    name: old?.name ?? defaultName(now),
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    duration: projectEnd(saved),
    videoUri,
    thumbnailUri,
  };
  writeJson(new File(dir, "meta.json"), meta);

  if (__DEV__)
    console.log(
      `[projects] saved "${meta.name}" (${id}) in ${Date.now() - startedAt}ms — ${meta.duration.toFixed(2)}s, ${used.size} media file(s)`,
    );
  notify();
  const { format: _f, ...item } = meta;
  return item;
}

// ---- Reading -------------------------------------------------------------------

/** All saved projects, last edited first. */
export async function loadProjects(): Promise<ProjectItem[]> {
  const items: ProjectItem[] = [];
  try {
    for (const entry of rootDir().list()) {
      if (!(entry instanceof Directory)) continue;
      const meta = await readJson<SavedMeta>(new File(entry, "meta.json"));
      if (!meta || !meta.id) continue;
      const { format: _f, ...item } = meta;
      if (item.thumbnailUri && !new File(item.thumbnailUri).exists)
        item.thumbnailUri = null;
      items.push(item);
    }
  } catch (e) {
    if (__DEV__) console.log("[projects] list failed", e);
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  if (__DEV__) console.log(`[projects] ${items.length} saved project(s)`);
  return items;
}

/** One project, ready for the editor (null if it's gone or unreadable). */
export async function loadProject(id: string): Promise<SavedProject | null> {
  const dir = projectDir(id);
  const meta = await readJson<SavedMeta>(new File(dir, "meta.json"));
  const body = await readJson<{ format: number; project: Project }>(
    new File(dir, "project.json"),
  );
  if (!meta || !body?.project?.tracks) return null;
  // Tracks added to the app after this project was saved: empty.
  const tracks = { ...body.project.tracks };
  for (const t of TRACK_IDS) if (!Array.isArray(tracks[t])) tracks[t] = [];
  const { format: _f, ...item } = meta;
  return { ...item, project: { ...body.project, tracks } };
}

// ---- Rename / delete -------------------------------------------------------------

export async function renameProject(id: string, name: string): Promise<void> {
  const file = new File(projectDir(id), "meta.json");
  const meta = await readJson<SavedMeta>(file);
  const clean = name.trim();
  if (!meta || !clean) return;
  writeJson(file, { ...meta, name: clean });
  if (__DEV__) console.log(`[projects] renamed ${id} → "${clean}"`);
  notify();
}

export async function deleteProject(id: string): Promise<void> {
  try {
    const dir = projectDir(id);
    if (dir.exists) dir.delete();
    if (__DEV__) console.log(`[projects] deleted ${id}`);
  } catch (e) {
    if (__DEV__) console.log(`[projects] delete ${id} failed`, e);
  }
  notify();
}
