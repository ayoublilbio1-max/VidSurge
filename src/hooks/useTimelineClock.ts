import { useCallback, useEffect, useRef, useState } from "react";

// How close (in seconds) the playhead has to be to a clip's edge to still
// count as "inside" it. Guards against float rounding at the boundary.
const CLIP_EPSILON = 0.001;
const END_EPSILON = 0.001;
// In the last few ms of a clip, stop reading the decoder and just run on the
// wall clock. A decoder can stop a hair short of the exact trim end, and if
// we kept deriving time from it the playhead could get stuck just before the
// clip's end forever.
const CLIP_TAIL = 0.05;
// A decoder that is AHEAD of the playhead by up to this much is simply
// followed (small forward step). Anything further away — ahead or behind —
// means the player is still on an old position (a seek in flight).
const MAX_FOLLOW_AHEAD = 1.0;
// How long the playhead waits for a decoder that is behind / still on an
// old position before doing anything about it. A player normally needs
// 0.2–0.9s to really start after play(), so this is comfortably above that.
const MAX_HOLD_MS = 1200;
// Cap on how far a single frame can advance the wall clock (protects
// against huge jumps after a long JS stall or the app being backgrounded).
const MAX_WALL_CLOCK_STEP = 0.25;

export type ClockTrack = {
  /** Just for debug logs, e.g. "video" / "audio". */
  label: string;
  /** Where this track's clip starts/ends on the shared timeline (seconds). */
  clipStart: number;
  clipEnd: number;
  /** The trim-in point inside the *source* file for this track. */
  trimStart: number;
  /**
   * Lower number = preferred as "ground truth" when more than one track
   * covers the current playhead position. Video should be 0 (visual sync
   * matters more than audio sync), audio should be 1.
   */
  priority: number;
  /** Returns this track's player's current decoded position (seconds). */
  getCurrentTime: () => number;
  /**
   * Moves this track's player to a source-file position. Only used as a
   * last resort, for a player that is stuck on a wrong position for more
   * than MAX_HOLD_MS.
   */
  resyncTo: (sourceTime: number) => void;
};

type UseTimelineClockParams = {
  isPlaying: boolean;
  timelineDuration: number;
  /** Video + audio track descriptors. Safe to pass a new array every render. */
  tracks: ClockTrack[];
  /** Called once when the playhead reaches the end of the whole timeline. */
  onReachEnd: () => void;
};

/**
 * Master clock for the editor's shared playhead (`timelineTime`).
 *
 * While playing, runs one requestAnimationFrame loop. Each frame:
 *   - Outside any clip (a gap), time advances by wall clock.
 *   - Inside a clip, the playhead FOLLOWS that clip's decoder (video
 *     preferred over audio) whenever the decoder is at or slightly ahead
 *     of the playhead.
 *   - If the decoder is BEHIND (still starting up after play()), or far
 *     away (still on an old position after a seek), the playhead HOLDS —
 *     it doesn't move — until the decoder catches up. So the playhead never
 *     jumps backwards and never runs ahead of the picture, the same way
 *     InShot waits for the video to start.
 *   - If a decoder is still wrong after MAX_HOLD_MS, the player is pulled
 *     to the playhead once. If that still doesn't help, the playhead
 *     follows the decoder so everything lines up again.
 *
 * The authoritative current time lives in `timeRef`. React state is just a
 * mirror of it for rendering. `seekTo` is for explicit jumps (scrub,
 * restart, trim clamp); it bumps `seekVersion`, which `useTrackTimelineSync`
 * watches to force-seek each player.
 */
export function useTimelineClock({
  isPlaying,
  timelineDuration,
  tracks,
  onReachEnd,
}: UseTimelineClockParams) {
  const [timelineTime, setTimelineTime] = useState(0);
  const [seekVersion, setSeekVersion] = useState(0);

  const timeRef = useRef(0);

  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  const durationRef = useRef(timelineDuration);
  durationRef.current = timelineDuration;

  const onReachEndRef = useRef(onReachEnd);
  onReachEndRef.current = onReachEnd;

  useEffect(() => {
    if (!isPlaying) return;

    let rafId: number | null = null;
    let lastTs = Date.now();
    // When the playhead started waiting for the current ground-truth decoder.
    let holdingSince: number | null = null;
    // Whether we already pulled the player once during this wait.
    let nudged = false;
    let lastGroundTruthLabel = "";
    let lastSource = "";

    if (__DEV__) {
      console.log(
        `[timelineClock] loop start @ ${timeRef.current.toFixed(2)}s (duration ${durationRef.current.toFixed(2)}s)`,
      );
    }

    const tick = () => {
      const now = Date.now();
      const rawDt = (now - lastTs) / 1000;
      lastTs = now;

      const prev = timeRef.current;
      const duration = durationRef.current;

      const active = tracksRef.current
        .filter(
          (t) =>
            prev >= t.clipStart - CLIP_EPSILON && prev < t.clipEnd - CLIP_TAIL,
        )
        .sort((a, b) => a.priority - b.priority);

      let next = prev + Math.min(rawDt, MAX_WALL_CLOCK_STEP);
      let source = "wall-clock";

      if (active.length > 0) {
        const gt = active[0];

        // Ground truth switched to a different track: start fresh.
        if (gt.label !== lastGroundTruthLabel) {
          holdingSince = null;
          nudged = false;
          lastGroundTruthLabel = gt.label;
        }

        const candidate = gt.clipStart + (gt.getCurrentTime() - gt.trimStart);
        const gap = candidate - prev;

        if (gap >= 0 && gap <= MAX_FOLLOW_AHEAD) {
          // Decoder is at/just ahead of the playhead: follow it.
          if (holdingSince !== null && __DEV__) {
            console.log(
              `[timelineClock] ${gt.label} caught up after ${now - holdingSince}ms — following again @ ${candidate.toFixed(2)}s`,
            );
          }
          next = candidate;
          source = gt.label;
          holdingSince = null;
          nudged = false;
        } else {
          // Decoder is behind (starting up) or far away (old position).
          // Hold the playhead where it is.
          next = prev;
          source = `holding for ${gt.label}`;

          if (holdingSince === null) {
            holdingSince = now;
            if (__DEV__) {
              console.log(
                `[timelineClock] holding @ ${prev.toFixed(2)}s — ${gt.label} decoder at ${candidate.toFixed(2)}s (gap ${gap.toFixed(2)}s)`,
              );
            }
          } else if (now - holdingSince >= MAX_HOLD_MS) {
            if (!nudged) {
              const target = gt.trimStart + (prev - gt.clipStart);
              if (__DEV__) {
                console.log(
                  `[timelineClock] ${gt.label} still off by ${gap.toFixed(2)}s after ${MAX_HOLD_MS}ms — pulling player to playhead (source ${target.toFixed(2)}s)`,
                );
              }
              gt.resyncTo(target);
              nudged = true;
              holdingSince = now;
            } else {
              if (__DEV__) {
                console.log(
                  `[timelineClock] ${gt.label} still off after pull — following it (${candidate.toFixed(2)}s)`,
                );
              }
              next = candidate;
              source = gt.label;
              holdingSince = null;
              nudged = false;
            }
          }
        }
      } else {
        holdingSince = null;
        nudged = false;
        lastGroundTruthLabel = "";
      }

      if (source !== lastSource) {
        if (__DEV__) {
          console.log(
            `[timelineClock] time source -> ${source} @ ${prev.toFixed(2)}s`,
          );
        }
        lastSource = source;
      }

      next = Math.max(0, next);

      if (next >= duration - END_EPSILON) {
        timeRef.current = duration;
        setTimelineTime(duration);
        rafId = null;
        if (__DEV__) {
          console.log(
            `[timelineClock] reached timeline end @ ${duration.toFixed(2)}s`,
          );
        }
        onReachEndRef.current();
        return; // stop the loop, no more frames
      }

      if (next !== prev) {
        timeRef.current = next;
        setTimelineTime(next);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (__DEV__) {
        console.log(
          `[timelineClock] loop stop @ ${timeRef.current.toFixed(2)}s`,
        );
      }
    };
  }, [isPlaying]);

  /**
   * Explicit jump to a position (scrub, restart-from-0, clamp-after-trim).
   * Updates the authoritative time immediately and bumps `seekVersion` so
   * every track's sync hook force-seeks its player to match.
   */
  const seekTo = useCallback((time: number) => {
    if (__DEV__) {
      console.log(`[timelineClock] seekTo -> ${time.toFixed(2)}s`);
    }
    timeRef.current = time;
    setTimelineTime(time);
    setSeekVersion((v) => v + 1);
  }, []);

  return { timelineTime, seekVersion, seekTo };
}
