// Project reducer (VidSurge step 1).
//
// All edits to the clip model go through here as actions. Each timeline
// gesture commits exactly once, on release, so one action = one undo step
// later: step 4 wraps this reducer with past/present/future and nothing
// here has to change.
//
// Rules:
//   - Pure: no logging, no ids generated here (action creators make them),
//     no players. Same state + same action = same result, so the editor can
//     preview an action's result before dispatching it, and React's
//     StrictMode double-call is harmless.
//   - An action that changes nothing returns the SAME state object, so a
//     no-op edit never becomes an undo step.
//   - Lock lives in the clips themselves: two clips sharing a `linkId`
//     are locked together, and every edit to one is applied to the other.
//     Unlocking (UNLINK_CLIP) clears the link for good — there is no
//     re-lock action. Undo (step 4) is the only way back.
//
// Add audio: ADD_CLIP puts a new clip (e.g. music from the phone) on its
// track at the given time — or, if that's inside another clip, at that
// clip's nearer edge — shortened to fit before the next clip (clips never
// overlap, and the clips already there never move).
// Delete (step 3): DELETE_CLIP removes a clip — and its locked partner.
// The timeline is free-form, so the gap it leaves stays; nothing moves.

import {
  addClips,
  allowsOverlap,
  canvasOf,
  clipEnd,
  clipLength,
  createClip,
  createPipClip,
  createStickerClip,
  createTextClip,
  exportOf,
  findClip,
  findLinkedPartner,
  insertionPoint,
  laneClips,
  newId,
  normalizeCrop,
  normalizeRotation,
  pickLane,
  removeClips,
  replaceClip,
  resolveOverlaps,
  sameRange,
  sanitizeRange,
  splitClip,
  type CanvasSettings,
  type Clip,
  type ClipRange,
  type CropRect,
  type ExportSettings,
  type PipClipData,
  type Project,
  type StickerClipData,
  type TextClipData,
} from "./clipModel";

export type ProjectAction =
  | {
      type: "INIT_SOURCE";
      sourceUri: string;
      sourceDuration: number;
      videoClipId: string;
      audioClipId: string;
      linkId: string;
    }
  | {
      /**
       * Multi-select: move every picked clip (and their locked partners)
       * by the same time, keeping their spacing. The earliest one stops at
       * 0. Clips they land on are pushed right (clips never overlap on a
       * track); texts / stickers take a row with room.
       */
      type: "MOVE_CLIPS";
      clipIds: string[];
      delta: number;
    }
  | {
      /** Multi-select: delete every picked clip (and locked partners). */
      type: "DELETE_CLIPS";
      clipIds: string[];
    }
  | {
      /**
       * Multi-select: copy the picked clips (and locked partners) and put
       * the copy right after the group, same spacing. Later clips are
       * pushed right. Copied locked pairs stay locked to each other.
       * `copies` (made by duplicateClipsAction) gives each copy its id.
       */
      type: "DUPLICATE_CLIPS";
      copies: { fromId: string; id: string; linkId: string | null }[];
    }
  | {
      /**
       * The timeline's "+": a new video from the phone goes first, at 0s —
       * one video clip and its linked audio clip, the whole file. Everything
       * already in the project (every track) moves right by its length, so
       * the edit after it stays exactly as it was.
       */
      type: "INSERT_VIDEO_AT_START";
      sourceUri: string;
      sourceDuration: number;
      videoClipId: string;
      audioClipId: string;
      linkId: string;
    }
  | {
      /**
       * The "+" at the end of the video row: a new video from the phone goes
       * right after the last video clip — with its sound in the audio row at
       * the same time. Nothing already in the project moves. If music is
       * already there, the music stays: the new sound is shortened to the
       * free space (and then not locked to the picture), or left out when
       * there's no room at all.
       */
      type: "INSERT_VIDEO_AT_END";
      sourceUri: string;
      sourceDuration: number;
      videoClipId: string;
      audioClipId: string;
      linkId: string;
    }
  | {
      /**
       * A trim or a move from the timeline. Carries the clip's full new
       * range (start + trim points), exactly what the gesture committed.
       * If the clip is linked, its partner gets the same range (locked
       * video + audio always cut and move together).
       */
      type: "UPDATE_CLIP_RANGE";
      clipId: string;
      range: ClipRange;
    }
  | {
      /**
       * A move (drag and drop) on the timeline: the clip — and its locked
       * partner — go to `start`, or to the nearer edge of the clip they
       * were dropped onto; anything they overlap is pushed right (see
       * resolveOverlaps). Clips never overlap on a track.
       */
      type: "MOVE_CLIP";
      clipId: string;
      start: number;
    }
  | {
      /**
       * Unlock: separates a clip from its linked partner, permanently.
       * Both clips keep their current range; they just stop moving
       * together. Does nothing if the clip isn't linked.
       */
      type: "UNLINK_CLIP";
      clipId: string;
    }
  | {
      /**
       * Split at the playhead: cuts the clip at timeline time `at` into two
       * clips (the left keeps the original id). If the clip is locked to a
       * partner, the partner is cut at the same moment and the two right
       * halves are locked to each other (the left halves keep the original
       * link). An unlocked clip is cut alone. Does nothing if either half
       * would be shorter than MIN_SPLIT_PART.
       */
      type: "SPLIT_CLIP";
      clipId: string;
      at: number;
      /** Ids for the new right halves, made by splitClipAction. */
      rightId: string;
      partnerRightId: string;
      rightLinkId: string;
    }
  | {
      /**
       * Delete: removes the clip, and its locked partner with it (a locked
       * pair acts as one). An unlocked clip goes alone. The space it took
       * stays empty — nothing after it moves (free-form timeline).
       */
      type: "DELETE_CLIP";
      clipId: string;
    }
  | {
      /** A new clip (made by addAudioClipAction). See the note at the top. */
      type: "ADD_CLIP";
      clip: Clip;
    }
  | {
      /**
       * Replaces a clip's `data` (e.g. a text's words / colour / size).
       * Same content → same state (no undo step).
       */
      type: "UPDATE_CLIP_DATA";
      clipId: string;
      data: unknown;
    }
  | {
      /**
       * Speed (0.1×–10×) of a clip — and its locked partner. The clip gets
       * shorter / longer on the timeline (same part of the source, played
       * faster / slower). Longer: later clips are pushed right if needed;
       * shorter: the space after it stays (free-form timeline).
       */
      type: "SET_CLIP_SPEED";
      clipId: string;
      speed: number;
    }
  | {
      /** Volume of an audio clip, 0–2 (0–200%). */
      type: "SET_CLIP_VOLUME";
      clipId: string;
      volume: number;
    }
  | {
      // Rotation (degrees) + mirror of a video clip's picture. Only this
      // clip — a locked audio partner has no picture.
      type: "SET_CLIP_ROTATION";
      clipId: string;
      rotate: number;
      flipX: boolean;
    }
  | {
      // Part of a video clip's picture to keep (normalized; null = all).
      // Only this clip — a locked audio partner has no picture.
      type: "SET_CLIP_CROP";
      clipId: string;
      crop: CropRect | null;
    }
  | {
      // Output frame shape + background (Canvas tool; whole project).
      type: "SET_CANVAS";
      canvas: CanvasSettings;
    }
  | {
      // Export resolution / frame rate (the "1080P" button; whole project).
      type: "SET_EXPORT_SETTINGS";
      settings: ExportSettings;
    }
  | {
      // Opacity of a video clip's picture (0 = invisible, 1 = solid).
      // Only this clip — a locked audio partner has no picture.
      type: "SET_CLIP_OPACITY";
      clipId: string;
      opacity: number;
    };

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;
export const MAX_VOLUME = 2;

/** A new text at timeline time `at` (TEXT_DEFAULT_LENGTH long). */
export function addTextClipAction(
  data: TextClipData,
  at: number,
): ProjectAction {
  return { type: "ADD_CLIP", clip: createTextClip(newId("text"), at, data) };
}

/** A new PIP (video or photo from the phone) at timeline time `at`. */
export function addPipClipAction(
  uri: string,
  data: PipClipData,
  duration: number,
  at: number,
): ProjectAction {
  return {
    type: "ADD_CLIP",
    clip: createPipClip(newId("pip"), at, uri, data, duration),
  };
}

/** A new sticker at timeline time `at` (STICKER_DEFAULT_LENGTH long). */
export function addStickerClipAction(
  data: StickerClipData,
  at: number,
): ProjectAction {
  return {
    type: "ADD_CLIP",
    clip: createStickerClip(newId("sticker"), at, data),
  };
}

/**
 * A copy of `clip` right after it (same length and settings, new id).
 * Only for tracks that allow overlaps (text); elsewhere ADD_CLIP's
 * insertion rules would apply.
 */
export function duplicateClipAction(clip: Clip): ProjectAction {
  return {
    type: "ADD_CLIP",
    clip: {
      ...clip,
      id: newId(clip.track),
      linkId: null,
      start: clipEnd(clip),
    },
  };
}

/** What an added music clip keeps in `data`: its file name, for the label. */
export type AudioClipData = { title: string };

/**
 * Music picked from the phone: a new, unlinked audio clip covering the
 * whole file (full length, even if it runs past the video), placed at
 * timeline time `at`.
 */
export function addAudioClipAction(
  sourceUri: string,
  sourceDuration: number,
  title: string,
  at: number,
): ProjectAction {
  const data: AudioClipData = { title };
  return {
    type: "ADD_CLIP",
    clip: createClip({
      id: newId("music"),
      track: "audio",
      sourceUri,
      sourceDuration,
      linkId: null,
      start: Math.max(0, at),
      trimIn: 0,
      trimOut: sourceDuration,
      data,
    }),
  };
}

/**
 * First load of a video: one video clip and one audio clip covering the
 * whole file, both at timeline 0, linked to each other. Does nothing if the
 * project already has clips.
 */
export function initSourceAction(
  sourceUri: string,
  sourceDuration: number,
): ProjectAction {
  return {
    type: "INIT_SOURCE",
    sourceUri,
    sourceDuration,
    videoClipId: newId("video"),
    audioClipId: newId("audio"),
    linkId: newId("link"),
  };
}

/**
 * The clips with these ids plus their locked partners, each once (in
 * timeline order). Unknown ids are ignored.
 */
export function withPartners(project: Project, ids: string[]): Clip[] {
  const out = new Map<string, Clip>();
  for (const id of ids) {
    const clip = findClip(project, id);
    if (!clip) continue;
    out.set(clip.id, clip);
    const partner = findLinkedPartner(project, clip);
    if (partner) out.set(partner.id, partner);
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

/** Multi-select Duplicate: new ids (and links) for the copies. */
export function duplicateClipsAction(
  project: Project,
  ids: string[],
): ProjectAction {
  const group = withPartners(project, ids);
  const groupIds = new Set(group.map((c) => c.id));
  const newLinks = new Map<string, string>();
  const copies = group.map((c) => {
    // A pair copied together stays a pair (a new link of its own); a clip
    // copied without its partner is a free clip.
    const partner = findLinkedPartner(project, c);
    let linkId: string | null = null;
    if (c.linkId && partner && groupIds.has(partner.id)) {
      linkId = newLinks.get(c.linkId) ?? newId("link");
      newLinks.set(c.linkId, linkId);
    }
    return {
      fromId: c.id,
      id: newId(c.track === "video" || c.track === "audio" ? "clip" : c.track),
      linkId,
    };
  });
  return { type: "DUPLICATE_CLIPS", copies };
}

/** Texts / stickers just placed: each in a row with room (it may overlap). */
function relane(state: Project, ids: string[]): Project {
  let next = state;
  for (const id of ids) {
    const c = findClip(next, id);
    if (!c || !allowsOverlap(c.track)) continue;
    const lane = pickLane(laneClips(next, c.track), c, c.lane ?? 0);
    if (lane !== (c.lane ?? 0)) next = replaceClip(next, { ...c, lane });
  }
  return next;
}

// A new clip is shortened to fit before the next clip only if at least
// this much room (seconds) is free there.
const MIN_FIT_ROOM = 0.5;

/** A video from the phone put first, at 0s (see INSERT_VIDEO_AT_START). */
export function insertVideoAtStartAction(
  sourceUri: string,
  sourceDuration: number,
): ProjectAction {
  return {
    type: "INSERT_VIDEO_AT_START",
    sourceUri,
    sourceDuration,
    videoClipId: newId("video"),
    audioClipId: newId("audio"),
    linkId: newId("link"),
  };
}

/** A video from the phone put after the last video clip (INSERT_VIDEO_AT_END). */
export function insertVideoAtEndAction(
  sourceUri: string,
  sourceDuration: number,
): ProjectAction {
  return {
    type: "INSERT_VIDEO_AT_END",
    sourceUri,
    sourceDuration,
    videoClipId: newId("video"),
    audioClipId: newId("audio"),
    linkId: newId("link"),
  };
}

/**
 * Where the "+ at the end" video's sound goes in the audio row: its start
 * and how long it can be there without touching another audio clip
 * (0 = no room at its start).
 */
export function freeAudioRoom(project: Project, start: number): number {
  let room = Infinity;
  for (const c of project.tracks.audio) {
    const end = clipEnd(c);
    if (c.start <= start + 0.001 && end > start + 0.001) return 0;
    if (c.start > start + 0.001) room = Math.min(room, c.start - start);
  }
  return room;
}

/** Split the clip at timeline time `at` (see SPLIT_CLIP). */
export function splitClipAction(clipId: string, at: number): ProjectAction {
  return {
    type: "SPLIT_CLIP",
    clipId,
    at,
    rightId: newId("clip"),
    partnerRightId: newId("clip"),
    rightLinkId: newId("link"),
  };
}

export function projectReducer(state: Project, action: ProjectAction): Project {
  switch (action.type) {
    case "INIT_SOURCE": {
      if (state.tracks.video.length > 0 || state.tracks.audio.length > 0) {
        return state;
      }
      const common = {
        sourceUri: action.sourceUri,
        sourceDuration: action.sourceDuration,
        linkId: action.linkId,
        start: 0,
        trimIn: 0,
        trimOut: action.sourceDuration,
      };
      return addClips(state, [
        createClip({ ...common, id: action.videoClipId, track: "video" }),
        createClip({ ...common, id: action.audioClipId, track: "audio" }),
      ]);
    }

    case "MOVE_CLIPS": {
      const group = withPartners(state, action.clipIds);
      if (group.length === 0) return state;
      const earliest = Math.min(...group.map((c) => c.start));
      let delta = Math.max(-earliest, action.delta);
      // Like a single move: a clip of the group whose start lands INSIDE
      // another clip goes to that clip's nearer edge (the whole group
      // shifts with it) — dropping music over the video mustn't shove the
      // video away.
      const ids = group.map((c) => c.id);
      const idSet = new Set(ids);
      for (const c of group) {
        if (allowsOverlap(c.track)) continue;
        const others = state.tracks[c.track].filter((o) => !idSet.has(o.id));
        const wanted = c.start + delta;
        const at = insertionPoint(others, Math.max(0, wanted));
        if (Math.abs(at - wanted) > 1e-6) {
          delta = Math.max(-earliest, at - c.start);
          break;
        }
      }
      if (Math.abs(delta) < 1e-6) return state;
      let next = state;
      for (const c of group)
        next = replaceClip(next, { ...c, start: c.start + delta });
      next = relane(next, ids);
      return resolveOverlaps(next, ids);
    }

    case "DELETE_CLIPS": {
      const group = withPartners(state, action.clipIds);
      if (group.length === 0) return state;
      return removeClips(
        state,
        group.map((c) => c.id),
      );
    }

    case "DUPLICATE_CLIPS": {
      const sources = action.copies
        .map((cp) => ({ cp, clip: findClip(state, cp.fromId) }))
        .filter(
          (x): x is { cp: (typeof action.copies)[number]; clip: Clip } =>
            x.clip !== null,
        );
      if (sources.length === 0) return state;
      const groupStart = Math.min(...sources.map((x) => x.clip.start));
      const groupEnd = Math.max(...sources.map((x) => clipEnd(x.clip)));
      const shift = groupEnd - groupStart;
      const copies = sources.map(({ cp, clip }) => ({
        ...clip,
        id: cp.id,
        linkId: cp.linkId,
        start: clip.start + shift,
      }));
      if (copies.some((c) => findClip(state, c.id))) return state;
      let next = addClips(state, copies);
      const ids = copies.map((c) => c.id);
      next = relane(next, ids);
      return resolveOverlaps(next, ids);
    }

    case "INSERT_VIDEO_AT_START": {
      const length = action.sourceDuration;
      if (!(length > 0) || findClip(state, action.videoClipId)) return state;
      const tracks = { ...state.tracks };
      for (const key of Object.keys(tracks) as (keyof typeof tracks)[]) {
        tracks[key] = tracks[key].map((c) => ({
          ...c,
          start: c.start + length,
        }));
      }
      const common = {
        sourceUri: action.sourceUri,
        sourceDuration: action.sourceDuration,
        linkId: action.linkId,
        start: 0,
        trimIn: 0,
        trimOut: action.sourceDuration,
      };
      return addClips({ ...state, tracks }, [
        createClip({ ...common, id: action.videoClipId, track: "video" }),
        createClip({ ...common, id: action.audioClipId, track: "audio" }),
      ]);
    }

    case "INSERT_VIDEO_AT_END": {
      const length = action.sourceDuration;
      if (!(length > 0) || findClip(state, action.videoClipId)) return state;
      const start = state.tracks.video.reduce(
        (m, c) => Math.max(m, clipEnd(c)),
        0,
      );
      const common = {
        sourceUri: action.sourceUri,
        sourceDuration: action.sourceDuration,
        start,
        trimIn: 0,
      };
      const room = freeAudioRoom(state, start);
      const added: Clip[] = [];
      if (room >= length - 0.001) {
        // The audio row is free: picture and sound locked together.
        added.push(
          createClip({
            ...common,
            id: action.videoClipId,
            track: "video",
            linkId: action.linkId,
            trimOut: length,
          }),
          createClip({
            ...common,
            id: action.audioClipId,
            track: "audio",
            linkId: action.linkId,
            trimOut: length,
          }),
        );
      } else {
        added.push(
          createClip({
            ...common,
            id: action.videoClipId,
            track: "video",
            linkId: null,
            trimOut: length,
          }),
        );
        // Music already there: the sound only fills the free part.
        if (room >= MIN_FIT_ROOM) {
          added.push(
            createClip({
              ...common,
              id: action.audioClipId,
              track: "audio",
              linkId: null,
              trimOut: room,
            }),
          );
        }
      }
      return addClips(state, added);
    }

    case "UPDATE_CLIP_RANGE": {
      const clip = findClip(state, action.clipId);
      if (!clip) return state;

      let next = state;
      const range = sanitizeRange(clip, action.range);
      if (!sameRange(clip, range)) {
        next = replaceClip(next, { ...clip, ...range });
      }

      const partner = findLinkedPartner(state, clip);
      if (partner) {
        const partnerRange = sanitizeRange(partner, action.range);
        if (!sameRange(partner, partnerRange)) {
          next = replaceClip(next, { ...partner, ...partnerRange });
        }
      }
      return next;
    }

    case "MOVE_CLIP": {
      const clip = findClip(state, action.clipId);
      if (!clip) return state;
      // Text may overlap other texts: it goes exactly where it was dropped
      // and keeps its row — unless another text is in the way there, then
      // it takes the first row with room (the others never move).
      if (allowsOverlap(clip.track)) {
        const start = Math.max(0, action.start);
        if (Math.abs(start - clip.start) < 1e-6) return state;
        const moved = { ...clip, start };
        const lane = pickLane(
          laneClips(state, clip.track),
          moved,
          clip.lane ?? 0,
        );
        return replaceClip(state, { ...moved, lane });
      }
      const partner = findLinkedPartner(state, clip);
      const group = partner ? [clip, partner] : [clip];
      const groupIds = new Set(group.map((c) => c.id));
      const others = state.tracks[clip.track].filter(
        (c) => !groupIds.has(c.id),
      );
      const at = insertionPoint(others, Math.max(0, action.start));
      const delta = at - clip.start;
      if (Math.abs(delta) < 1e-6) return state;
      let next = state;
      for (const c of group) {
        next = replaceClip(next, { ...c, start: Math.max(0, c.start + delta) });
      }
      return resolveOverlaps(next, groupIds);
    }

    case "UNLINK_CLIP": {
      const clip = findClip(state, action.clipId);
      if (!clip) return state;
      const partner = findLinkedPartner(state, clip);
      if (!partner) return state;
      let next = replaceClip(state, { ...clip, linkId: null });
      next = replaceClip(next, { ...partner, linkId: null });
      return next;
    }

    case "SPLIT_CLIP": {
      const clip = findClip(state, action.clipId);
      if (!clip) return state;
      const partner = findLinkedPartner(state, clip);
      const halves = splitClip(
        clip,
        action.at,
        action.rightId,
        partner ? action.rightLinkId : null,
      );
      if (!halves) return state;
      let next = replaceClip(state, halves[0]);
      const added = [halves[1]];
      if (partner) {
        // A locked pair always has the same range, so the partner can be
        // cut at the same moment; if not, split nothing rather than leave
        // a half-split pair.
        const partnerHalves = splitClip(
          partner,
          action.at,
          action.partnerRightId,
          action.rightLinkId,
        );
        if (!partnerHalves) return state;
        next = replaceClip(next, partnerHalves[0]);
        added.push(partnerHalves[1]);
      }
      return addClips(next, added);
    }

    case "ADD_CLIP": {
      const clip = action.clip;
      if (findClip(state, clip.id)) return state;
      // Text may overlap other texts: placed exactly where asked, in the
      // first row (lane) with room at that time.
      if (allowsOverlap(clip.track)) {
        const placed = { ...clip, start: Math.max(0, clip.start) };
        const lane = pickLane(
          laneClips(state, clip.track),
          placed,
          clip.lane ?? 0,
        );
        return addClips(state, [{ ...placed, lane }]);
      }
      const others = state.tracks[clip.track];
      let start = insertionPoint(others, Math.max(0, clip.start));
      // Music / PIP longer than the free space before the next clip on its
      // track is shortened to fit there (the rest of the file is kept — a
      // trim, not a cut). Less than MIN_FIT_ROOM free there: it goes after
      // that clip instead (and so on). Clips already on the track are never
      // pushed: before, a 2-minute song added at 0.5s threw the video's own
      // sound 2 minutes away from its picture.
      const nextStartAfter = (t: number) =>
        others
          .filter((o) => o.start >= t - 0.001)
          .reduce((m, o) => Math.min(m, o.start), Infinity);
      for (let guard = 0; guard < others.length + 1; guard++) {
        const ns = nextStartAfter(start);
        if (!Number.isFinite(ns) || ns - start >= MIN_FIT_ROOM) break;
        const blocker = others.find((o) => Math.abs(o.start - ns) < 0.001);
        if (!blocker) break;
        start = clipEnd(blocker);
      }
      let placed: Clip = { ...clip, start };
      const nextStart = nextStartAfter(start);
      if (
        Number.isFinite(nextStart) &&
        start + clipLength(clip) > nextStart + 0.001
      ) {
        const speed = clip.speed > 0 ? clip.speed : 1;
        placed = {
          ...placed,
          trimOut: clip.trimIn + (nextStart - start) * speed,
        };
      }
      const next = addClips(state, [placed]);
      return resolveOverlaps(next, [clip.id]);
    }

    case "SET_CLIP_SPEED": {
      const clip = findClip(state, action.clipId);
      if (!clip) return state;
      const speed =
        Math.round(
          Math.max(MIN_SPEED, Math.min(MAX_SPEED, action.speed)) * 100,
        ) / 100;
      if (Math.abs(speed - clip.speed) < 1e-6) return state;
      const partner = findLinkedPartner(state, clip);
      const group = partner ? [clip, partner] : [clip];
      let next = state;
      for (const c of group) next = replaceClip(next, { ...c, speed });
      if (allowsOverlap(clip.track)) return next;
      return resolveOverlaps(
        next,
        group.map((c) => c.id),
      );
    }

    case "SET_CLIP_VOLUME": {
      const clip = findClip(state, action.clipId);
      if (!clip) return state;
      const volume =
        Math.round(Math.max(0, Math.min(MAX_VOLUME, action.volume)) * 100) /
        100;
      if (Math.abs(volume - clip.volume) < 1e-6) return state;
      return replaceClip(state, { ...clip, volume });
    }

    case "SET_CLIP_ROTATION": {
      const clip = findClip(state, action.clipId);
      if (!clip || clip.track !== "video") return state;
      const rotate = normalizeRotation(action.rotate);
      const flipX = action.flipX;
      if (rotate === clip.rotate && flipX === !!clip.flipX) return state;
      return replaceClip(state, { ...clip, rotate, flipX });
    }

    case "SET_CLIP_CROP": {
      const clip = findClip(state, action.clipId);
      if (!clip || clip.track !== "video") return state;
      const crop = normalizeCrop(action.crop);
      if (JSON.stringify(crop) === JSON.stringify(clip.crop ?? null))
        return state;
      return replaceClip(state, { ...clip, crop });
    }

    case "SET_CANVAS": {
      const current = canvasOf(state);
      const next: CanvasSettings = {
        ratio: action.canvas.ratio,
        background: action.canvas.background.toUpperCase(),
        crop: normalizeCrop(action.canvas.crop ?? null),
      };
      const same =
        current.ratio === next.ratio &&
        current.background.toUpperCase() === next.background &&
        JSON.stringify(current.crop ?? null) === JSON.stringify(next.crop);
      if (same) return state;
      return { ...state, canvas: next };
    }

    case "SET_EXPORT_SETTINGS": {
      const current = exportOf(state);
      const next = exportOf({ ...state, export: action.settings });
      if (current.resolution === next.resolution && current.fps === next.fps)
        return state;
      return { ...state, export: next };
    }

    case "SET_CLIP_OPACITY": {
      const clip = findClip(state, action.clipId);
      if (!clip || (clip.track !== "video" && clip.track !== "pip"))
        return state;
      const opacity =
        Math.round(Math.max(0, Math.min(1, action.opacity)) * 100) / 100;
      if (Math.abs(opacity - clip.opacity) < 1e-6) return state;
      return replaceClip(state, { ...clip, opacity });
    }

    case "UPDATE_CLIP_DATA": {
      const clip = findClip(state, action.clipId);
      if (!clip) return state;
      if (JSON.stringify(clip.data) === JSON.stringify(action.data)) {
        return state;
      }
      return replaceClip(state, { ...clip, data: action.data });
    }

    case "DELETE_CLIP": {
      const clip = findClip(state, action.clipId);
      if (!clip) return state;
      const partner = findLinkedPartner(state, clip);
      return removeClips(state, partner ? [clip.id, partner.id] : [clip.id]);
    }

    default:
      return state;
  }
}
