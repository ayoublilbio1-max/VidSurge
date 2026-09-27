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
// clip's nearer edge — and pushes later clips right (clips never overlap).
// Delete (step 3): DELETE_CLIP removes a clip — and its locked partner.
// The timeline is free-form, so the gap it leaves stays; nothing moves.

import {
  addClips,
  allowsOverlap,
  clipEnd,
  createClip,
  createTextClip,
  findClip,
  findLinkedPartner,
  insertionPoint,
  newId,
  pickLane,
  removeClips,
  replaceClip,
  resolveOverlaps,
  sameRange,
  sanitizeRange,
  splitClip,
  type Clip,
  type ClipRange,
  type Project,
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
    };

/** A new text at timeline time `at` (TEXT_DEFAULT_LENGTH long). */
export function addTextClipAction(
  data: TextClipData,
  at: number,
): ProjectAction {
  return { type: "ADD_CLIP", clip: createTextClip(newId("text"), at, data) };
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
        const lane = pickLane(state.tracks[clip.track], moved, clip.lane ?? 0);
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
        const lane = pickLane(state.tracks[clip.track], placed, clip.lane ?? 0);
        return addClips(state, [{ ...placed, lane }]);
      }
      const start = insertionPoint(
        state.tracks[clip.track],
        Math.max(0, clip.start),
      );
      const next = addClips(state, [{ ...clip, start }]);
      return resolveOverlaps(next, [clip.id]);
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
