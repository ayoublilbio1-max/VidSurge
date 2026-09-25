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
// Split and delete arrive in steps 2 and 3 as new actions.

import {
  addClips,
  createClip,
  findClip,
  findLinkedPartner,
  newId,
  replaceClip,
  sameRange,
  sanitizeRange,
  type ClipRange,
  type Project,
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
       * Unlock: separates a clip from its linked partner, permanently.
       * Both clips keep their current range; they just stop moving
       * together. Does nothing if the clip isn't linked.
       */
      type: "UNLINK_CLIP";
      clipId: string;
    };

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

    case "UNLINK_CLIP": {
      const clip = findClip(state, action.clipId);
      if (!clip) return state;
      const partner = findLinkedPartner(state, clip);
      if (!partner) return state;
      let next = replaceClip(state, { ...clip, linkId: null });
      next = replaceClip(next, { ...partner, linkId: null });
      return next;
    }

    default:
      return state;
  }
}
