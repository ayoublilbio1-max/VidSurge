import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

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
// While playing, React state (`timelineTime`) is only committed this often
// (plus immediately whenever the playhead crosses a clip edge, so players
// still start/stop exactly on time). The smooth visual movement of the
// timeline no longer depends on React at all — it runs on the UI thread
// from `playhead` below — so re-rendering the whole editor 60x/s was pure
// waste and was what made playback choppy.
const JS_COMMIT_INTERVAL_MS = 50;
// When playback is paused, the playhead the user SEES (drawn by the UI
// thread, which predicts between the decoder's coarse time reports) is
// usually a little ahead of the clock's last decoder report — up to ~0.2s.
// Committing the older clock value made the timeline jump BACK a bit on
// every pause (very visible when zoomed in). If the drawn playhead is ahead
// by no more than this, the pause keeps the drawn position instead, and the
// players are seeked there so the preview frame matches it.
const PAUSE_ALIGN_MAX_AHEAD = 0.4;

/**
 * Shared values the UI thread reads every frame to move the timeline
 * smoothly while playing (see EditorTimeline's frame callback):
 *   - targetSV:  the clock's latest authoritative time (seconds)
 *   - rateSV:    1 while time is advancing, 0 while holding for a decoder
 *   - snapSV:    bumped on every explicit jump / playback start; tells the
 *                UI thread to jump straight to targetSV instead of easing
 *   - playingSV: whether the clock loop is running
 *   - uiTimeSV:  written BY the UI thread (EditorTimeline) — the playhead
 *                time it's actually drawing. Read back on pause so the
 *                playhead stays exactly where the user saw it stop.
 */
export type PlayheadSync = {
  targetSV: SharedValue<number>;
  rateSV: SharedValue<number>;
  snapSV: SharedValue<number>;
  playingSV: SharedValue<boolean>;
  uiTimeSV: SharedValue<number>;
};

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
 * (throttled) mirror of it for rendering, and `playhead` is the per-frame
 * mirror for the UI thread, which is what actually moves the timeline.
 * `seekTo` is for explicit jumps (scrub, restart, trim clamp); it bumps
 * `seekVersion`, which `useTrackTimelineSync` watches to force-seek each
 * player.
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
  // Set by `halt()`: a gesture (scrub, pinch, clip move/trim...) interrupted
  // playback. The loop must stop on the spot — not a few frames later when
  // React gets around to the isPlaying=false render.
  const haltedRef = useRef(false);

  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  const durationRef = useRef(timelineDuration);
  durationRef.current = timelineDuration;

  const onReachEndRef = useRef(onReachEnd);
  onReachEndRef.current = onReachEnd;

  const targetSV = useSharedValue(0);
  const rateSV = useSharedValue(0);
  const snapSV = useSharedValue(0);
  const playingSV = useSharedValue(false);
  const uiTimeSV = useSharedValue(0);
  const playhead = useMemo<PlayheadSync>(
    () => ({ targetSV, rateSV, snapSV, playingSV, uiTimeSV }),
    [targetSV, rateSV, snapSV, playingSV, uiTimeSV],
  );

  useEffect(() => {
    if (!isPlaying) return;
    haltedRef.current = false;

    let rafId: number | null = null;
    let lastTs = Date.now();
    // When the playhead started waiting for the current ground-truth decoder.
    let holdingSince: number | null = null;
    // Whether we already pulled the player once during this wait.
    let nudged = false;
    let lastGroundTruthLabel = "";
    let lastSource = "";
    // Performance counters, logged once per second while playing (dev only).
    // `ticks` = animation frames the loop ran, `updates` = how many of those
    // actually moved the playhead (React re-renders), `decoderChanges` = how
    // many times the ground-truth decoder reported a NEW time. These tell us
    // where choppiness comes from: few ticks = JS thread overloaded; many
    // ticks but few decoder changes = decoder time is coarse.
    let perfWindowStart = Date.now();
    let perfTicks = 0;
    let perfUpdates = 0;
    let perfDecoderChanges = 0;
    let lastDecoderValue = NaN;
    let lastCommitTs = 0;

    // Hand the UI thread its starting point: jump (snap) to the current
    // time, not moving yet (rate 0) until the first tick decides.
    targetSV.value = timeRef.current;
    rateSV.value = 0;
    snapSV.value = snapSV.value + 1;
    playingSV.value = true;

    if (__DEV__) {
      console.log(
        `[timelineClock] loop start @ ${timeRef.current.toFixed(2)}s (duration ${durationRef.current.toFixed(2)}s)`,
      );
    }

    const tick = () => {
      if (haltedRef.current) {
        rafId = null;
        return;
      }
      const now = Date.now();
      const rawDt = (now - lastTs) / 1000;
      lastTs = now;

      const prev = timeRef.current;
      const duration = durationRef.current;

      if (__DEV__) {
        perfTicks += 1;
        if (now - perfWindowStart >= 1000) {
          console.log(
            `[timelineClock] perf (last ${now - perfWindowStart}ms): ${perfTicks} JS frames, ${perfUpdates} React commits, decoder time changed ${perfDecoderChanges}x @ ${prev.toFixed(2)}s`,
          );
          perfWindowStart = now;
          perfTicks = 0;
          perfUpdates = 0;
          perfDecoderChanges = 0;
        }
      }

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

        const decoderTime = gt.getCurrentTime();
        if (__DEV__ && decoderTime !== lastDecoderValue) {
          perfDecoderChanges += 1;
          lastDecoderValue = decoderTime;
        }
        const candidate = gt.clipStart + (decoderTime - gt.trimStart);
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

      // Feed the UI thread every tick (cheap: no React involved).
      targetSV.value = next;
      rateSV.value = source.startsWith("holding") ? 0 : 1;

      if (next >= duration - END_EPSILON) {
        timeRef.current = duration;
        targetSV.value = duration;
        rateSV.value = 0;
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
        // Commit to React at a reduced rate — except when a clip edge was
        // crossed, so the track sync starts/stops players right on time.
        const crossedClipEdge = tracksRef.current.some(
          (t) =>
            prev < t.clipStart !== next < t.clipStart ||
            prev < t.clipEnd !== next < t.clipEnd,
        );
        if (crossedClipEdge || now - lastCommitTs >= JS_COMMIT_INTERVAL_MS) {
          setTimelineTime(next);
          lastCommitTs = now;
          if (__DEV__) perfUpdates += 1;
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      // rafId is only null here if the loop already stopped by itself (end
      // of the timeline, or halted by a gesture) — then there's nothing to
      // align: the end position is exact, and after a halt the gesture
      // (e.g. the scrub's seekTo) owns the playhead.
      const halted = haltedRef.current;
      const pausedMidway = rafId !== null && !halted;
      if (rafId !== null) cancelAnimationFrame(rafId);
      playingSV.value = false;
      rateSV.value = 0;

      // Keep the playhead where the user saw it stop (see
      // PAUSE_ALIGN_MAX_AHEAD) instead of snapping back to the last,
      // slightly stale decoder report.
      const clockTime = timeRef.current;
      const drawnTime = uiTimeSV.value;
      const ahead = drawnTime - clockTime;
      const alignToDrawn =
        pausedMidway &&
        ahead > 0.001 &&
        ahead <= PAUSE_ALIGN_MAX_AHEAD &&
        drawnTime < durationRef.current - END_EPSILON;
      if (alignToDrawn) {
        timeRef.current = drawnTime;
      }

      targetSV.value = timeRef.current;
      // Commit the exact final position (the last few ticks may not have
      // been committed because of the reduced commit rate).
      setTimelineTime(timeRef.current);
      // Players are paused at roughly the clock time — move them to the
      // drawn position so the preview frame matches the playhead.
      if (alignToDrawn) setSeekVersion((v) => v + 1);
      if (__DEV__) {
        console.log(
          alignToDrawn
            ? `[timelineClock] loop stop @ ${timeRef.current.toFixed(2)}s (kept drawn playhead; clock was ${clockTime.toFixed(2)}s, ${ahead.toFixed(2)}s behind)`
            : halted
              ? `[timelineClock] loop stop @ ${timeRef.current.toFixed(2)}s (halted by gesture)`
              : `[timelineClock] loop stop @ ${timeRef.current.toFixed(2)}s`,
        );
      }
    };
  }, [isPlaying]);

  /**
   * Explicit jump to a position (scrub, restart-from-0, clamp-after-trim).
   * Updates the authoritative time immediately and bumps `seekVersion` so
   * every track's sync hook force-seeks its player to match.
   */
  const seekTo = useCallback(
    (time: number) => {
      if (__DEV__) {
        console.log(`[timelineClock] seekTo -> ${time.toFixed(2)}s`);
      }
      timeRef.current = time;
      targetSV.value = time;
      snapSV.value = snapSV.value + 1;
      setTimelineTime(time);
      setSeekVersion((v) => v + 1);
    },
    [targetSV, snapSV],
  );

  /**
   * Stop the playhead RIGHT NOW because a gesture took over (scrub, pinch,
   * clip move/trim, zoom...). Call it together with setIsPlaying(false).
   * Without it, the loop kept following the still-playing video for a few
   * more frames (many more when the JS thread is busy) and overwrote the
   * position the user had just scrubbed to — in one log the playhead ran
   * from 1.07s to 1.77s after the user had scrubbed to 1.07s.
   */
  const halt = useCallback(() => {
    if (haltedRef.current) return;
    haltedRef.current = true;
    playingSV.value = false;
    rateSV.value = 0;
    targetSV.value = timeRef.current;
    if (__DEV__) {
      console.log(
        `[timelineClock] halted by gesture @ ${timeRef.current.toFixed(2)}s`,
      );
    }
  }, [playingSV, rateSV, targetSV]);

  return { timelineTime, seekVersion, seekTo, playhead, halt };
}
