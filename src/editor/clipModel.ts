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

export type Rotation = 0 | 90 | 180 | 270;

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
  crop: CropRect | null;
  filter: string | null;
  reversed: boolean;
  /** Track-specific payload (text content, sticker id...). */
  data?: unknown;
}

export interface Project {
  /** One list per track, each kept sorted by `start`. */
  tracks: Record<TrackId, Clip[]>;
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
  return `${clip.id} @${clip.start.toFixed(2)}s–${clipEnd(clip).toFixed(2)}s (src ${clip.trimIn.toFixed(2)}–${clip.trimOut.toFixed(2)}s, x${clip.speed}, ${clip.linkId ? `locked ${clip.linkId}` : "unlocked"})`;
}
