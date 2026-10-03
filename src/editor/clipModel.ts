// Shared clip model for the editor (VidSurge step 1).
//
// Every track (video, audio, and later text/stickers/PIP/voice/effects) is
// a list of clips. A clip is one piece of a source file placed on the
// shared timeline:
//
//   start            where the clip begins on the timeline (seconds)
//   trimIn/trimOut   which part of the source file it plays (source seconds)
//   speed            playback speed; the clip's timeline length is
//                    (trimOut - trimIn) / speed
//
// Speed is in every calculation from day one (always 1 for now), so the
// speed tool later is just a new value, not a rewrite.
//
// Everything in this file is pure: no React, no players, no logging.

import { defaultExport } from "../lib/appPrefs";

export type TrackId =
  | "video"
  | "audio"
  | "text"
  | "sticker"
  | "pip"
  | "voice"
  | "effect";

export const TRACK_IDS: TrackId[] = [
  "video",
  "audio",
  "text",
  "sticker",
  "pip",
  "voice",
  "effect",
];

/**
 * Picture rotation in degrees, clockwise, normalised to (-180, 180]
 * (any angle — the Rotate tool has 90° buttons and a free slider).
 */
export type Rotation = number;

/** An angle in degrees brought into (-180, 180]. */
export function normalizeRotation(deg: number): number {
  let a = ((deg % 360) + 360) % 360; // 0…360
  if (a > 180) a -= 360;
  return Math.round(a * 10) / 10;
}

/** Normalized crop rectangle (0–1 of the source frame). */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole picture (no crop). */
export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
/** Smallest crop side, as a fraction of the picture. */
export const MIN_CROP = 0.1;

/**
 * A crop rect made valid: inside the picture, at least MIN_CROP on each
 * side, rounded to 1/1000. The whole picture (or near enough) → null.
 */
export function normalizeCrop(c: CropRect | null): CropRect | null {
  if (!c) return null;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const w = Math.min(1, Math.max(MIN_CROP, c.w));
  const h = Math.min(1, Math.max(MIN_CROP, c.h));
  const x = Math.min(1 - w, Math.max(0, c.x));
  const y = Math.min(1 - h, Math.max(0, c.y));
  const out = { x: r(x), y: r(y), w: r(w), h: r(h) };
  if (out.x <= 0.002 && out.y <= 0.002 && out.w >= 0.998 && out.h >= 0.998)
    return null;
  return out;
}

export interface Clip {
  id: string;
  track: TrackId;
  /** The file this clip plays. Split/voice/PIP clips each need their own. */
  sourceUri: string;
  /** Length of the whole source file (seconds). Caps trimOut. */
  sourceDuration: number;
  /**
   * Pairs a video clip with its audio clip. While Lock is on, an edit to
   * one is applied to the other. null = not linked to anything.
   */
  linkId: string | null;
  /** Timeline position of the clip's left edge (seconds). */
  start: number;
  /** Source-file in/out points (seconds). */
  trimIn: number;
  trimOut: number;
  speed: number;
  volume: number;
  opacity: number;
  rotate: Rotation;
  /** Picture mirrored left↔right (Rotate tool's Flip). */
  flipX?: boolean;
  crop: CropRect | null;
  filter: string | null;
  reversed: boolean;
  /** Track-specific payload (text content, sticker id...). */
  data?: unknown;
  /**
   * Row on the timeline for tracks whose clips may overlap in time (text):
   * each clip keeps its own row, so moving one never shuffles the others.
   */
  lane?: number;
}

export interface Project {
  /** One list per track, each kept sorted by `start`. */
  tracks: Record<TrackId, Clip[]>;
  /** Output frame shape + background (Canvas tool). Missing = defaults. */
  canvas?: CanvasSettings;
  /** Export quality (the "1080P" button). Missing = defaults. */
  export?: ExportSettings;
}

// ---- Export settings (resolution / frame rate) -------------------------------

/** The short side of the exported video, in pixels. */
export type ExportResolution = 480 | 720 | 1080 | 1440 | 2160;
export type ExportFps = 24 | 30 | 60;

export interface ExportSettings {
  resolution: ExportResolution;
  fps: ExportFps;
}

export const EXPORT_RESOLUTIONS: ExportResolution[] = [
  480, 720, 1080, 1440, 2160,
];
export const EXPORT_FPS: ExportFps[] = [24, 30, 60];
export const DEFAULT_EXPORT: ExportSettings = { resolution: 1080, fps: 30 };

export function exportOf(project: Project): ExportSettings {
  const e = project.export;
  // Not picked for this project: the app's default (Settings).
  const fallback = defaultExport();
  if (!e) return fallback;
  return {
    resolution: EXPORT_RESOLUTIONS.includes(e.resolution)
      ? e.resolution
      : fallback.resolution,
    fps: EXPORT_FPS.includes(e.fps) ? e.fps : fallback.fps,
  };
}

/** "480P", "720P", "1080P", "2K", "4K". */
export function resolutionLabel(r: ExportResolution): string {
  return r === 1440 ? "2K" : r === 2160 ? "4K" : `${r}P`;
}

/**
 * Pixel size of the exported video: the short side is the resolution, the
 * long side follows the frame's shape (`aspect` = width ÷ height). Both
 * even (video encoders need that).
 */
export function exportFrameSize(
  settings: ExportSettings,
  aspect: number,
): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const a = aspect > 0 ? aspect : 9 / 16;
  // The frame fits in the chosen quality's 16:9 box (1080P → 1920 × 1080,
  // either way round): the short side is the resolution unless that makes
  // the long side longer than the box — a thin crop (e.g. 5.4 : 1) would
  // otherwise ask for 5840 × 1080, beyond what phone encoders can make.
  let short: number = settings.resolution;
  const maxLong = Math.round((settings.resolution * 16) / 9);
  const longFor = (s: number) => (a >= 1 ? s * a : s / a);
  if (longFor(short) > maxLong) short = a >= 1 ? maxLong / a : maxLong * a;
  return a >= 1
    ? { width: even(short * a), height: even(short) }
    : { width: even(short), height: even(short / a) };
}

// Typical H.264 bitrates (Mbit/s) at 30 fps for a 16:9 / 9:16 frame.
const BASE_MBPS: Record<ExportResolution, number> = {
  480: 2.5,
  720: 5,
  1080: 10,
  1440: 18,
  2160: 40,
};
const FPS_FACTOR: Record<ExportFps, number> = { 24: 0.85, 30: 1, 60: 1.6 };

/** Video bitrate (bits/s) the export asks the encoder for. */
export function exportVideoBitrate(
  settings: ExportSettings,
  aspect: number,
): number {
  const { width, height } = exportFrameSize(settings, aspect);
  const r = settings.resolution;
  const areaFactor = (width * height) / (r * ((r * 16) / 9));
  return Math.round(
    BASE_MBPS[r] * FPS_FACTOR[settings.fps] * areaFactor * 1_000_000,
  );
}

/** Rough size of the exported file (bytes): video bitrate + 128 kbit/s sound. */
export function estimateExportBytes(
  settings: ExportSettings,
  aspect: number,
  durationSec: number,
): number {
  const { width, height } = exportFrameSize(settings, aspect);
  const r = settings.resolution;
  const areaFactor = (width * height) / (r * ((r * 16) / 9));
  const mbps = BASE_MBPS[r] * FPS_FACTOR[settings.fps] * areaFactor + 0.128;
  return (mbps * 1_000_000 * Math.max(0, durationSec)) / 8;
}

export function describeExport(settings: ExportSettings): string {
  return `${resolutionLabel(settings.resolution)} ${settings.fps}fps`;
}

// ---- Canvas (the output frame) --------------------------------------------

/** Frame shapes offered by the Canvas tool. "original" = the first video's. */
export type CanvasRatio = "original" | "9:16" | "16:9" | "1:1" | "4:5" | "3:4";

export const CANVAS_RATIOS: CanvasRatio[] = [
  "original",
  "9:16",
  "16:9",
  "1:1",
  "4:5",
  "3:4",
];

export interface CanvasSettings {
  ratio: CanvasRatio;
  /** Colour behind the pictures (hex). */
  background: string;
  /**
   * Crop tool (whole video): the part of the video picture to keep,
   * normalized to the first video. When set, the frame takes exactly its
   * shape (and `ratio` is ignored) and every video clip shows only that
   * part, filling the frame. null / missing = no crop.
   */
  crop?: CropRect | null;
}

export const DEFAULT_CANVAS: CanvasSettings = {
  ratio: "original",
  background: "#000000",
};

export function canvasOf(project: Project): CanvasSettings {
  return project.canvas ?? DEFAULT_CANVAS;
}

/**
 * Width ÷ height of the project's frame: the crop's shape when the video
 * is cropped, otherwise the chosen ratio (see canvasAspect).
 */
export function frameAspect(
  canvas: CanvasSettings,
  videoAspect: number | null,
): number {
  if (canvas.crop && videoAspect && videoAspect > 0) {
    return (canvas.crop.w * videoAspect) / canvas.crop.h;
  }
  return canvasAspect(canvas.ratio, videoAspect);
}

/** Short text for logs, e.g. "1:1 on #000000" or "crop 0.2,0.1 0.5×0.6 on #000000". */
export function describeCanvas(canvas: CanvasSettings): string {
  const shape = canvas.crop
    ? `crop ${canvas.crop.x},${canvas.crop.y} ${canvas.crop.w}×${canvas.crop.h}`
    : canvas.ratio;
  return `${shape} on ${canvas.background}`;
}

/**
 * Width ÷ height of the frame. "original" uses the video's own shape
 * (`videoAspect`, or 9:16 while it isn't known yet).
 */
export function canvasAspect(
  ratio: CanvasRatio,
  videoAspect: number | null,
): number {
  if (ratio === "original")
    return videoAspect && videoAspect > 0 ? videoAspect : 9 / 16;
  const [w, h] = ratio.split(":").map(Number);
  return w / h;
}

/** The part of a clip that trim/move edits change. */
export interface ClipRange {
  start: number;
  trimIn: number;
  trimOut: number;
}

// Smallest source length a clip may have. The timeline's own trim handles
// already enforce a bigger minimum (0.5s); this is only a safety floor so
// the model can never hold a zero/negative-length clip.
const MIN_SOURCE_LENGTH = 0.01;
const TIME_EPSILON = 0.001;

export function emptyTracks(): Record<TrackId, Clip[]> {
  return {
    video: [],
    audio: [],
    text: [],
    sticker: [],
    pip: [],
    voice: [],
    effect: [],
  };
}

export const EMPTY_PROJECT: Project = { tracks: emptyTracks() };

// ---- Ids ------------------------------------------------------------------

let idCounter = 0;

/**
 * Unique-enough id for clips and links. Generated in action creators, never
 * inside the reducer, so the reducer stays pure (same action → same result).
 */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

// ---- Construction -----------------------------------------------------------

export function createClip(
  fields: Pick<
    Clip,
    | "id"
    | "track"
    | "sourceUri"
    | "sourceDuration"
    | "linkId"
    | "start"
    | "trimIn"
    | "trimOut"
  > &
    Partial<Clip>,
): Clip {
  return {
    speed: 1,
    volume: 1,
    opacity: 1,
    rotate: 0,
    crop: null,
    filter: null,
    reversed: false,
    ...fields,
  };
}

// ---- Time math ----------------------------------------------------------------

/** How long the clip lasts on the timeline (seconds), speed included. */
export function clipLength(clip: Clip): number {
  const speed = clip.speed > 0 ? clip.speed : 1;
  return (clip.trimOut - clip.trimIn) / speed;
}

/** Timeline position of the clip's right edge (seconds). */
export function clipEnd(clip: Clip): number {
  return clip.start + clipLength(clip);
}

/** Timeline time → position in the clip's source file. Not clamped. */
export function timelineToSource(clip: Clip, timelineTime: number): number {
  return clip.trimIn + (timelineTime - clip.start) * clip.speed;
}

/** Source-file position → timeline time. Not clamped. */
export function sourceToTimeline(clip: Clip, sourceTime: number): number {
  const speed = clip.speed > 0 ? clip.speed : 1;
  return clip.start + (sourceTime - clip.trimIn) / speed;
}

/** Whether the playhead at `time` is inside the clip ([start, end)). */
export function clipContains(clip: Clip, time: number): boolean {
  return time >= clip.start - TIME_EPSILON && time < clipEnd(clip);
}

// Two clips "continue" each other when the second picks up the same file
// exactly where the first stops, right where it ends on the timeline (e.g.
// the two halves of a split, untouched).
const CONTINUE_EPSILON = 0.02;

/**
 * True when `next` plays on straight from `prev`: same file, same speed,
 * `next` starts in the source where `prev` stops and on the timeline where
 * `prev` ends. One player can then simply keep playing across the cut — no
 * hand-over to another player, nothing to seek.
 *
 * - "audio": the volume MAY differ — the clock sets the new clip's volume
 *   on the player right at the cut (its `activate`), so a split where one
 *   part is quieter still plays on one player.
 * - "video": rotation, flip and opacity must match — those are drawn per
 *   player and set on React's re-render, which comes a little after the
 *   cut; a different look there would show late. (Video players are always
 *   muted, so their volume doesn't matter.)
 */
export function isContinuation(
  prev: Clip,
  next: Clip,
  kind: "audio" | "video" = "audio",
): boolean {
  const sameMedia =
    prev.sourceUri === next.sourceUri &&
    prev.speed === next.speed &&
    prev.reversed === next.reversed &&
    Math.abs(prev.trimOut - next.trimIn) < CONTINUE_EPSILON &&
    Math.abs(clipEnd(prev) - next.start) < CONTINUE_EPSILON;
  if (!sameMedia) return false;
  if (kind === "audio") return true;
  return (
    prev.rotate === next.rotate &&
    !!prev.flipX === !!next.flipX &&
    prev.opacity === next.opacity
  );
}

/**
 * Share a track's clips (sorted by start) between its two players, 0 and 1.
 * Normally they alternate, so the next clip's player is free to get ready
 * during the current one. A clip that continues the previous one
 * (isContinuation) stays on the same player instead: that player just
 * plays on across the cut, which is seamless even when the JS thread is
 * too busy to start another player on time.
 */
export function splitIntoPlayerSlots(
  clips: Clip[],
  kind: "audio" | "video" = "audio",
): [Clip[], Clip[]] {
  const slots: [Clip[], Clip[]] = [[], []];
  let slot = 1;
  let prev: Clip | null = null;
  for (const clip of clips) {
    slot = prev && isContinuation(prev, clip, kind) ? slot : 1 - slot;
    slots[slot].push(clip);
    prev = clip;
  }
  return slots;
}

/**
 * The clip on this track under the playhead, or null in a gap. If clips
 * ever overlap, the one that starts latest wins (it sits "on top").
 */
export function activeClipAt(clips: Clip[], time: number): Clip | null {
  let found: Clip | null = null;
  for (const clip of clips) {
    if (clipContains(clip, time)) found = clip;
  }
  return found;
}

/** Where the last clip on any track ends (seconds). 0 for an empty project. */
export function projectEnd(project: Project): number {
  let end = 0;
  for (const track of TRACK_IDS) {
    for (const clip of project.tracks[track]) {
      end = Math.max(end, clipEnd(clip));
    }
  }
  return end;
}

// ---- Lookup ----------------------------------------------------------------

export function findClip(project: Project, clipId: string): Clip | null {
  for (const track of TRACK_IDS) {
    const clip = project.tracks[track].find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

/** The other clip sharing this clip's linkId (on a different track). */
export function findLinkedPartner(project: Project, clip: Clip): Clip | null {
  if (clip.linkId === null) return null;
  for (const track of TRACK_IDS) {
    if (track === clip.track) continue;
    const partner = project.tracks[track].find((c) => c.linkId === clip.linkId);
    if (partner) return partner;
  }
  return null;
}

// ---- Immutable updates -------------------------------------------------------

function sortByStart(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

/**
 * Returns a new project with `clip` replacing the clip of the same id on
 * its track (track re-sorted). Other tracks keep their array references.
 */
export function replaceClip(project: Project, clip: Clip): Project {
  const list = project.tracks[clip.track];
  const index = list.findIndex((c) => c.id === clip.id);
  if (index === -1) return project;
  const nextList = [...list];
  nextList[index] = clip;
  return {
    ...project,
    tracks: { ...project.tracks, [clip.track]: sortByStart(nextList) },
  };
}

/** Removes the clips with these ids (unknown ids are ignored). */
export function removeClips(project: Project, ids: string[]): Project {
  const drop = new Set(ids);
  const tracks = { ...project.tracks };
  let changed = false;
  for (const key of Object.keys(tracks) as (keyof typeof tracks)[]) {
    const kept = tracks[key].filter((c) => !drop.has(c.id));
    if (kept.length !== tracks[key].length) {
      tracks[key] = kept;
      changed = true;
    }
  }
  return changed ? { ...project, tracks } : project;
}

/** Adds clips to their tracks (each track re-sorted). */
export function addClips(project: Project, clips: Clip[]): Project {
  const tracks = { ...project.tracks };
  for (const clip of clips) {
    tracks[clip.track] = sortByStart([...tracks[clip.track], clip]);
  }
  return { ...project, tracks };
}

/**
 * Keeps a requested range valid for this clip's source: start ≥ 0, trim
 * points inside the source file, trimOut after trimIn. With the values the
 * timeline gestures send today, this changes nothing.
 */
export function sanitizeRange(clip: Clip, range: ClipRange): ClipRange {
  const maxOut = clip.sourceDuration > 0 ? clip.sourceDuration : range.trimOut;
  const trimIn = Math.max(
    0,
    Math.min(range.trimIn, maxOut - MIN_SOURCE_LENGTH),
  );
  const trimOut = Math.max(
    trimIn + MIN_SOURCE_LENGTH,
    Math.min(range.trimOut, maxOut),
  );
  return { start: Math.max(0, range.start), trimIn, trimOut };
}

export function sameRange(clip: Clip, range: ClipRange): boolean {
  return (
    clip.start === range.start &&
    clip.trimIn === range.trimIn &&
    clip.trimOut === range.trimOut
  );
}

// ---- Placement (no overlaps on a track) -----------------------------------------
//
// Clips on the same track never overlap (one player per track can't play two
// clips at once). A moved clip may pass over others while dragging; on drop:
//   - dropped where it fits → it lands exactly there
//   - dropped with its start INSIDE another clip → it's inserted at that
//     clip's nearer edge
//   - whatever it then overlaps is pushed right, just far enough; pushed
//     locked clips take their partner along (which can push clips on the
//     other track too)

const PLACE_EPSILON = 0.001;

/**
 * Tracks whose clips MAY overlap in time (shown in stacked lanes on the
 * timeline, see textLanes): text. Every other track keeps the no-overlap
 * rules above.
 */
export function allowsOverlap(track: TrackId): boolean {
  return track === "text" || track === "sticker";
}

/**
 * Overlay tracks (text + stickers) share one set of timeline rows (lanes):
 * the clips a new / moved overlay clip must find room among.
 */
export function laneClips(project: Project, track: TrackId): Clip[] {
  return allowsOverlap(track)
    ? [...project.tracks.text, ...project.tracks.sticker]
    : project.tracks[track];
}

/**
 * Where a clip dropped at `start` actually goes on a track: `start` itself,
 * unless that falls inside one of `others` — then that clip's nearer edge.
 */
export function insertionPoint(others: Clip[], start: number): number {
  for (const o of others) {
    const end = clipEnd(o);
    if (start > o.start + PLACE_EPSILON && start < end - PLACE_EPSILON) {
      return start - o.start <= end - start ? o.start : end;
    }
  }
  return start;
}

/**
 * Removes overlaps on every track by pushing clips right, without moving
 * the `fixed` clips (the ones just placed). A clip is pushed only as far as
 * needed; later clips move only if they then overlap. Locked pairs are kept
 * aligned (both halves at the later of their two starts), which can push
 * clips on the other track too; repeats until nothing overlaps.
 */
export function resolveOverlaps(
  project: Project,
  fixedIds: Iterable<string>,
): Project {
  let next = project;
  const fixed = new Set(fixedIds);
  for (let iteration = 0; iteration < 20; iteration++) {
    let changed = false;

    for (const track of TRACK_IDS) {
      if (allowsOverlap(track)) continue;
      const clips = next.tracks[track];
      if (clips.length < 2) continue;
      const occupied = clips
        .filter((c) => fixed.has(c.id))
        .map((c) => ({ start: c.start, end: clipEnd(c) }));
      const free = clips
        .filter((c) => !fixed.has(c.id))
        .sort((a, b) => a.start - b.start);
      for (const c of free) {
        const len = clipLength(c);
        let start = c.start;
        let moved = true;
        while (moved) {
          moved = false;
          for (const o of occupied) {
            if (
              start < o.end - PLACE_EPSILON &&
              start + len > o.start + PLACE_EPSILON
            ) {
              start = o.end;
              moved = true;
            }
          }
        }
        occupied.push({ start, end: start + len });
        if (start !== c.start) {
          next = replaceClip(next, { ...c, start });
          changed = true;
        }
      }
    }

    // Locked pairs stay aligned: if one half got pushed, the other follows.
    for (const track of TRACK_IDS) {
      for (const c of next.tracks[track]) {
        const partner = findLinkedPartner(next, c);
        if (!partner || Math.abs(partner.start - c.start) < PLACE_EPSILON) {
          continue;
        }
        const start = Math.max(c.start, partner.start);
        next = replaceClip(next, { ...c, start });
        next = replaceClip(next, { ...partner, start });
        fixed.add(c.id);
        fixed.add(partner.id);
        changed = true;
      }
    }

    if (!changed) break;
  }
  return next;
}

// ---- Split -------------------------------------------------------------------

/** Each half of a split must be at least this long on the timeline (s). */
export const MIN_SPLIT_PART = 0.1;

/**
 * Whether the clip can be cut at timeline time `t`: the playhead is inside
 * it, with at least MIN_SPLIT_PART on each side.
 */
export function canSplitAt(clip: Clip, t: number): boolean {
  return (
    t >= clip.start + MIN_SPLIT_PART && t <= clipEnd(clip) - MIN_SPLIT_PART
  );
}

/**
 * Cuts a clip at timeline time `t` into two clips that play back exactly
 * like the original: the left keeps the original id, start and trim-in and
 * now ends at `t`; the right (new id) starts at `t` and keeps the original
 * end. Every other setting (speed, volume...) is copied to both halves.
 * Returns null if the clip can't be cut there (see canSplitAt).
 */
export function splitClip(
  clip: Clip,
  t: number,
  rightId: string,
  rightLinkId: string | null,
): [Clip, Clip] | null {
  if (!canSplitAt(clip, t)) return null;
  const cut = timelineToSource(clip, t);
  const left: Clip = { ...clip, trimOut: cut };
  const right: Clip = {
    ...clip,
    id: rightId,
    start: t,
    trimIn: cut,
    linkId: rightLinkId,
  };
  return [left, right];
}

// ---- Debug ----------------------------------------------------------------

/** One-line summary of a clip, for [project] logs. */
export function describeClip(clip: Clip): string {
  if (clip.track === "pip") {
    const d = pipDataOf(clip);
    return `${clip.id} @${clip.start.toFixed(2)}s–${clipEnd(clip).toFixed(2)}s PIP ${d.kind} ${clip.sourceUri.split("/").pop()} (src ${clip.trimIn.toFixed(2)}–${clip.trimOut.toFixed(2)}s, width ${d.width.toFixed(2)}×${d.scale.toFixed(2)}, at ${d.x.toFixed(2)},${d.y.toFixed(2)}, ${d.rotation}°${clip.volume !== 1 ? `, vol ${Math.round(clip.volume * 100)}%` : ""}${clip.opacity !== 1 ? `, opacity ${Math.round(clip.opacity * 100)}%` : ""})`;
  }
  if (clip.track === "sticker") {
    const s = stickerDataOf(clip);
    return `${clip.id} @${clip.start.toFixed(2)}s–${clipEnd(clip).toFixed(2)}s ${s.emoji} (size ${s.size.toFixed(2)}×${s.scale.toFixed(2)}, at ${s.x.toFixed(2)},${s.y.toFixed(2)}, ${s.rotation}°, lane ${clip.lane ?? 0})`;
  }
  if (clip.track === "text") {
    const t = textDataOf(clip);
    return `${clip.id} @${clip.start.toFixed(2)}s–${clipEnd(clip).toFixed(2)}s "${t.text.replace(/\s+/g, " ").slice(0, 24)}" (${t.font}, ${t.color}, size ${t.size.toFixed(3)}, at ${t.x.toFixed(2)},${t.y.toFixed(2)})`;
  }
  return `${clip.id} @${clip.start.toFixed(2)}s–${clipEnd(clip).toFixed(2)}s (src ${clip.trimIn.toFixed(2)}–${clip.trimOut.toFixed(2)}s, x${clip.speed}${clip.volume !== 1 ? `, vol ${Math.round(clip.volume * 100)}%` : ""}${clip.opacity !== 1 ? `, opacity ${Math.round(clip.opacity * 100)}%` : ""}${clip.rotate ? `, rotate ${clip.rotate}°` : ""}${clip.crop ? `, crop ${clip.crop.x},${clip.crop.y} ${clip.crop.w}×${clip.crop.h}` : ""}${clip.flipX ? ", flipped" : ""}, ${clip.linkId ? `locked ${clip.linkId}` : "unlocked"})`;
}

// ---- Text clips -------------------------------------------------------------
//
// A text clip has no media file. Its words and look live in `data`
// (TextClipData); its time range uses the same start / trimIn / trimOut as
// every clip, over a made-up "source" of TEXT_SOURCE_LENGTH seconds. New
// texts start in the MIDDLE of that range (TEXT_SOURCE_ORIGIN) so the left
// trim handle can also make them longer, not only shorter.

export const TEXT_SOURCE_LENGTH = 7200;
export const TEXT_SOURCE_ORIGIN = 3600;
/** Length of a new text on the timeline (seconds). */
export const TEXT_DEFAULT_LENGTH = 3;

/**
 * Font id: one of the phone's built-in fonts ("normal", "bold", "serif",
 * "mono") or a downloadable Google font (see src/editor/fonts.ts).
 */
export type TextFont = string;
export type TextAlign = "left" | "center" | "right";

export interface TextClipData {
  text: string;
  font: TextFont;
  /** Text colour, "#RRGGBB", and how opaque the whole text is (0–1). */
  color: string;
  opacity: number;
  /**
   * Font size as a fraction of the frame's size (see textSizeReference;
   * 0.05 = 5% of a 9:16 frame's height).
   */
  size: number;
  align: TextAlign;
  /** Outline (null = none); width as a fraction of the font size. */
  strokeColor: string | null;
  strokeWidth: number;
  /** Soft glow around the letters (null = none); radius × font size. */
  glowColor: string | null;
  glowRadius: number;
  /** Box behind the text (null = none); corner radius × font size. */
  bgColor: string | null;
  bgOpacity: number;
  bgRadius: number;
  /** Drop shadow (null = none); distance and blur × font size. */
  shadowColor: string | null;
  shadowDistance: number;
  shadowBlur: number;
  /** Centre of the text on the video frame, 0–1 of its width / height. */
  x: number;
  y: number;
  /** Extra scale (resize handle) and rotation in degrees. */
  scale: number;
  rotation: number;
}

export const DEFAULT_TEXT_DATA: TextClipData = {
  text: "",
  font: "bold",
  color: "#FFFFFF",
  opacity: 1,
  size: 0.05,
  align: "center",
  strokeColor: null,
  strokeWidth: 0.08,
  glowColor: null,
  glowRadius: 0.5,
  bgColor: null,
  bgOpacity: 0.7,
  bgRadius: 0.25,
  shadowColor: null,
  shadowDistance: 0.08,
  shadowBlur: 0.15,
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
};

/** The text settings of a text clip (defaults for anything missing). */
export function textDataOf(clip: Clip): TextClipData {
  const raw = (clip.data ?? {}) as Partial<TextClipData> & {
    background?: boolean;
  };
  const data = { ...DEFAULT_TEXT_DATA, ...raw };
  // Texts made before the style panel had `background: true`.
  if (raw.background === true && raw.bgColor === undefined) {
    data.bgColor = "#000000";
  }
  delete (data as { background?: boolean }).background;
  return data;
}

/** A new text clip at timeline time `start`. */
export function createTextClip(
  id: string,
  start: number,
  data: TextClipData,
  length = TEXT_DEFAULT_LENGTH,
): Clip {
  return createClip({
    id,
    track: "text",
    sourceUri: "",
    sourceDuration: TEXT_SOURCE_LENGTH,
    linkId: null,
    start: Math.max(0, start),
    trimIn: TEXT_SOURCE_ORIGIN,
    trimOut: TEXT_SOURCE_ORIGIN + length,
    data,
  });
}

/** Whether `lane` has room for [start, end) among `clips` (except one). */
export function laneIsFree(
  clips: Clip[],
  lane: number,
  start: number,
  end: number,
  exceptId?: string,
): boolean {
  return !clips.some(
    (c) =>
      c.id !== exceptId &&
      (c.lane ?? 0) === lane &&
      start < clipEnd(c) - PLACE_EPSILON &&
      end > c.start + PLACE_EPSILON,
  );
}

/**
 * The lane a clip goes into: `preferred` if it fits there, otherwise the
 * first lane (from the top) where it fits — a new one below if none does.
 */
export function pickLane(clips: Clip[], clip: Clip, preferred: number): number {
  const start = clip.start;
  const end = clipEnd(clip);
  if (laneIsFree(clips, preferred, start, end, clip.id)) return preferred;
  const maxLane = clips.reduce((m, c) => Math.max(m, c.lane ?? 0), 0);
  for (let lane = 0; lane <= maxLane + 1; lane++) {
    if (laneIsFree(clips, lane, start, end, clip.id)) return lane;
  }
  return maxLane + 1;
}

/**
 * Timeline rows for clips that may overlap (text): each clip's own `lane`,
 * with empty lanes skipped (rows are packed top-down). Returns the row per
 * clip id and how many rows there are (at least 1).
 */
export function textLanes(clips: Clip[]): {
  laneOf: Record<string, number>;
  count: number;
} {
  const used = [...new Set(clips.map((c) => c.lane ?? 0))].sort(
    (a, b) => a - b,
  );
  const rowOfLane = new Map(used.map((lane, row) => [lane, row]));
  const laneOf: Record<string, number> = {};
  for (const clip of clips)
    laneOf[clip.id] = rowOfLane.get(clip.lane ?? 0) ?? 0;
  return { laneOf, count: Math.max(1, used.length) };
}

/**
 * What a text's `size` is a fraction of, for a frame of w × h px: the
 * frame's overall size (√(w·h)), scaled so a 9:16 frame gives exactly its
 * height. Based on the frame's HEIGHT alone, a text looked tiny in a wide
 * frame (a cropped banner) — then, made big there, it became huge when
 * the frame went back to 9:16.
 */
export function textSizeReference(frameW: number, frameH: number): number {
  return (Math.sqrt(Math.max(0, frameW * frameH)) * 4) / 3;
}

/** A text's font size (px) in a frame of w × h px. */
export function textFontSize(
  data: TextClipData,
  frameW: number,
  frameH: number,
): number {
  return Math.max(
    6,
    data.size * textSizeReference(frameW, frameH) * data.scale,
  );
}

// ---- Sticker clips ------------------------------------------------------------
//
// A sticker is an emoji drawn over the video, placed / turned / resized on
// the preview like a text. Like a text it has no media file: its look lives
// in `data` and its time range uses the long empty "source" of text clips,
// so both trim handles can extend it.

export interface StickerClipData {
  emoji: string;
  /** Centre, as a fraction of the frame (0–1). */
  x: number;
  y: number;
  /** Size as a fraction of the frame's size (see textSizeReference). */
  size: number;
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
}

export const STICKER_DEFAULT_LENGTH = 3;

export const DEFAULT_STICKER_DATA: Omit<StickerClipData, "emoji"> = {
  x: 0.5,
  y: 0.5,
  size: 0.14,
  scale: 1,
  rotation: 0,
};

export function stickerDataOf(clip: Clip): StickerClipData {
  const d = (clip.data ?? {}) as Partial<StickerClipData>;
  return { ...DEFAULT_STICKER_DATA, emoji: "⭐", ...d };
}

/** A new sticker clip at timeline time `start`. */
export function createStickerClip(
  id: string,
  start: number,
  data: StickerClipData,
  length = STICKER_DEFAULT_LENGTH,
): Clip {
  return createClip({
    id,
    track: "sticker",
    sourceUri: "",
    sourceDuration: TEXT_SOURCE_LENGTH,
    linkId: null,
    start: Math.max(0, start),
    trimIn: TEXT_SOURCE_ORIGIN,
    trimOut: TEXT_SOURCE_ORIGIN + length,
    data,
  });
}

/** A sticker's emoji size (px) in a frame of w × h px. */
export function stickerFontSize(
  data: StickerClipData,
  frameW: number,
  frameH: number,
): number {
  return Math.max(
    10,
    data.size * textSizeReference(frameW, frameH) * data.scale,
  );
}

// ---- PIP clips (picture-in-picture) ------------------------------------------
//
// A video or photo from the phone shown as a layer over the main video,
// moved / turned / resized on the preview like a sticker. One PIP at a time
// (the PIP track doesn't allow overlaps). A PIP video plays on its own
// player, with its own sound. A photo has no length of its own: like a
// text it uses the long empty "source", so it can be trimmed to any length.

export interface PipClipData {
  kind: "video" | "image";
  /** Width ÷ height of the picture. */
  aspect: number;
  /** Centre, as a fraction of the frame (0–1). */
  x: number;
  y: number;
  /** Width as a fraction of the frame's width (before `scale`). */
  width: number;
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** File name, for the timeline label. */
  title?: string;
}

export const PIP_IMAGE_LENGTH = 3;

export function pipDataOf(clip: Clip): PipClipData {
  const d = (clip.data ?? {}) as Partial<PipClipData>;
  return {
    kind: "video",
    aspect: 16 / 9,
    x: 0.5,
    y: 0.5,
    width: 0.5,
    scale: 1,
    rotation: 0,
    ...d,
  };
}

/** A new PIP clip at timeline time `start`. `duration` = the video's length. */
export function createPipClip(
  id: string,
  start: number,
  uri: string,
  data: PipClipData,
  duration: number,
): Clip {
  const isImage = data.kind === "image";
  return createClip({
    id,
    track: "pip",
    sourceUri: uri,
    sourceDuration: isImage ? TEXT_SOURCE_LENGTH : duration,
    linkId: null,
    start: Math.max(0, start),
    trimIn: isImage ? TEXT_SOURCE_ORIGIN : 0,
    trimOut: isImage ? TEXT_SOURCE_ORIGIN + PIP_IMAGE_LENGTH : duration,
    data,
  });
}

/** A PIP's size (px) in a frame of w × h px. */
export function pipSize(
  data: PipClipData,
  frameW: number,
): { w: number; h: number } {
  const w = Math.max(20, data.width * data.scale * frameW);
  return { w, h: w / (data.aspect > 0 ? data.aspect : 1) };
}
