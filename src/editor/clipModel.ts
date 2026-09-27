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
}

export const DEFAULT_CANVAS: CanvasSettings = {
  ratio: "original",
  background: "#000000",
};

export function canvasOf(project: Project): CanvasSettings {
  return project.canvas ?? DEFAULT_CANVAS;
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
 * True when `next` plays on straight from `prev`: same file, same speed and
 * volume, `next` starts in the source where `prev` stops and on the
 * timeline where `prev` ends. One player can then simply keep playing
 * across the cut — no hand-over to another player, nothing to seek.
 */
export function isContinuation(prev: Clip, next: Clip): boolean {
  return (
    prev.sourceUri === next.sourceUri &&
    prev.speed === next.speed &&
    prev.volume === next.volume &&
    prev.reversed === next.reversed &&
    Math.abs(prev.trimOut - next.trimIn) < CONTINUE_EPSILON &&
    Math.abs(clipEnd(prev) - next.start) < CONTINUE_EPSILON
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
export function splitIntoPlayerSlots(clips: Clip[]): [Clip[], Clip[]] {
  const slots: [Clip[], Clip[]] = [[], []];
  let slot = 1;
  let prev: Clip | null = null;
  for (const clip of clips) {
    slot = prev && isContinuation(prev, clip) ? slot : 1 - slot;
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
  return track === "text";
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
  if (clip.track === "text") {
    const t = textDataOf(clip);
    return `${clip.id} @${clip.start.toFixed(2)}s–${clipEnd(clip).toFixed(2)}s "${t.text.replace(/\s+/g, " ").slice(0, 24)}" (${t.font}, ${t.color}, size ${t.size.toFixed(3)}, at ${t.x.toFixed(2)},${t.y.toFixed(2)})`;
  }
  return `${clip.id} @${clip.start.toFixed(2)}s–${clipEnd(clip).toFixed(2)}s (src ${clip.trimIn.toFixed(2)}–${clip.trimOut.toFixed(2)}s, x${clip.speed}${clip.volume !== 1 ? `, vol ${Math.round(clip.volume * 100)}%` : ""}${clip.opacity !== 1 ? `, opacity ${Math.round(clip.opacity * 100)}%` : ""}${clip.rotate ? `, rotate ${clip.rotate}°` : ""}${clip.flipX ? ", flipped" : ""}, ${clip.linkId ? `locked ${clip.linkId}` : "unlocked"})`;
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
  /** Font size as a fraction of the video frame's height (0.05 = 5%). */
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
