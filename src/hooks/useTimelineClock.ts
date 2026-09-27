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
// still start/stop on time). The smooth visual movement of the timeline
// doesn't depend on React at all — it runs on the UI thread from
// `playhead` below — and every commit re-renders the whole editor. At 50ms
// the dev build only managed ~9 clock frames/s; fewer commits leave the JS
// thread free for the clock loop, which makes clip edges more precise.
const JS_COMMIT_INTERVAL_MS = 200;
// A clip's player is paused by the clock itself when the playhead reaches
// the clip's end, instead of waiting for React to re-render and the track
// sync to notice (that came ~0.2s late, so you heard audio from past the
// trim point). When a clip end is less than this far ahead, a timer is set
// to pause the player right at the end.
const END_PAUSE_LOOKAHEAD = 0.4;
// A clip whose end touches the next clip on the same track (a split point)
// is NOT paused at its end — the same player carries straight on into the
// next clip, and the track sync seeks it there.
const CONTINUOUS_EPSILON = 0.02;
// When playback is paused, the playhead the user SEES (drawn by the UI
// thread, which predicts between the decoder's coarse time reports) is
// usually a little ahead of the clock's last decoder report — up to ~0.2s.
// Committing the older clock value made the timeline jump BACK a bit on
// every pause (very visible when zoomed in). If the drawn playhead is ahead
// by no more than this, the pause keeps the position where the picture
// really stopped (read from the player) — or, if that can't be read, the
// drawn position (players seeked there).
const PAUSE_ALIGN_MAX_AHEAD = 0.4;
// Drift correction for the OTHER playing tracks (not the one the playhead
// follows). If one stays off by more than DRIFT_MAX for DRIFT_GRACE_MS, it
// is seeked back in line, at most once per DRIFT_COOLDOWN_MS per track.
const DRIFT_MAX = 0.25;
const DRIFT_GRACE_MS = 1000;
const DRIFT_COOLDOWN_MS = 2500;
// A moving player up to this far BEHIND the playhead is still followed (the
// playhead just doesn't move back for it).
const FOLLOW_BEHIND = 0.15;
// Early start: when a clip is this close (timeline seconds) and its track's
// player is free, the player is started ahead of the clip by its start-up
// time, so it's already running when the playhead gets there.
const PRESTART_WINDOW = 1.0;
// The early start fires this much sooner than the measured start-up time
// alone would say: the JS thread can be busy right when the timer is due.
const PRESTART_MARGIN = 0.05;
// Starting guesses for a player's start-up time after play(), per track.
// Each early start measures the real value and updates it (kept between
// plays). Measured on a real phone with the player parked on its first
// frame (preroll): video ~0.1s, audio ~0.2s. The old guesses (video 0.35,
// audio 0.12) were backwards — the first cut after opening a project
// started the video ~0.25s too early and the audio too late, so the two
// were out of step until a drift fix a second later.
const DEFAULT_START_LATENCY: Record<string, number> = {
  video: 0.15,
  audio: 0.2,
  other: 0.2,
};
// How much a new measurement counts when updating the learned start-up
// time (the rest is the old value). High, so a bad guess is fixed after
// one or two cuts.
const LATENCY_LEARN_WEIGHT = 0.7;
// A late early start (the JS timer fired late — the dev JS thread is very
// busy right after play is pressed) used to seek the player forward before
// play(). That seek threw away the preroll: the new clip then took ~0.25s
// to start and its first frame sat frozen on screen at the cut. Now, if it's
// only a little late, the player starts from its parked frame (fast) and
// plays a bit faster until it has caught up with the playhead.
//   rate: how much faster (video players are muted, so 1.5x is invisible;
//         audio uses a gentler 1.2x).
//   max:  late by more than this → seek as before (catching up would take
//         too long).
const CATCH_UP: Record<string, { rate: number; max: number }> = {
  video: { rate: 1.5, max: 0.45 },
  audio: { rate: 1.2, max: 0.2 },
  other: { rate: 1.2, max: 0.2 },
};
// Caught up once the player is within this of the playhead.
const CATCH_UP_DONE = 0.03;
// How much real time a single frame may count for when estimating "now"
// (last frame's time + time since). A stalled dev JS thread can go 0.5s
// without a frame while the players keep running; the old 0.25s cap made a
// player look ahead when it wasn't.
const MAX_REAL_STEP = 1.0;
// Start of playback: if the picture takes longer than this to start, the
// other players (audio) are paused until it does, then started in step
// with it. Before, the audio ran on alone for up to ~0.8s while the video
// was still frozen (a far seek into a long clip), then needed drift fixes.
const HOLD_OTHERS_AFTER_MS = 150;
// A running player whose position hasn't changed for this long is treated
// as stalled (e.g. right after a seek it can freeze ~0.5–1s): the playhead
// stops following it and runs on another player / the wall clock, instead
// of freezing with it while the other tracks play on.
const STALL_MS = 400;
// A seek on a running player: it lands this much later (it freezes for a
// moment), so the target is set ahead by this, per track kind.
const SEEK_LEAD: Record<string, number> = {
  video: 0.25,
  audio: 0.1,
  other: 0.15,
};
// A measured start-up time below this isn't real (the player had already
// moved before play() took effect, or its position report was stale) —
// learning from it dropped the video lead to 50ms and every following early
// start was late.
const MIN_PLAUSIBLE_START = 0.03;
const LATENCY_MIN = 0.08;
const LATENCY_MAX = 0.8;

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

/**
 * One entry per CLIP (not per track): a track with three clips gives three
 * entries. Only the entry whose clip is under the playhead matters at any
 * moment; its player is the one the track sync has seeked into that clip.
 */
export type ClockTrack = {
  /** Just for debug logs, e.g. "video:<clip id>". Unique per entry. */
  label: string;
  /**
   * Which PLAYER this clip plays on, e.g. "video#0" / "video#1" /
   * "audio#0". Each track has two players that take turns (consecutive
   * clips alternate), so the next clip's player is always free to be
   * parked and started early. Entries with the same key share a player.
   * The part before "#" is the track kind, used for the learned start-up
   * time (DEFAULT_START_LATENCY).
   */
  trackKey: string;
  /** Where this clip starts/ends on the shared timeline (seconds). */
  clipStart: number;
  clipEnd: number;
  /** The clip's trim-in point inside its *source* file. */
  trimStart: number;
  /** Clip playback speed (1 = normal). Source seconds per timeline second. */
  speed: number;
  /**
   * Lower number = preferred as "ground truth" when more than one track
   * covers the current playhead position. Video should be 0 (visual sync
   * matters more than audio sync), audio should be 1.
   */
  priority: number;
  /** Returns this track's player's current decoded position (seconds). */
  getCurrentTime: () => number;
  /**
   * Moves this track's player to a source-file position. Used as a last
   * resort for a stuck ground-truth player (MAX_HOLD_MS), and for drift
   * correction of the other playing tracks (DRIFT_*).
   */
  resyncTo: (sourceTime: number) => void;
  /**
   * Pauses / starts this clip's player. Used at the clip's end (see
   * END_PAUSE_*), for the early start (PRESTART_WINDOW), and to kick a
   * player that never started.
   */
  pause: () => void;
  play: () => void;
  /**
   * Makes this clip's player the one you see / hear on its track (the
   * other player of the track goes invisible / silent). Called at the
   * exact moment the playhead reaches the clip.
   */
  activate?: () => void;
  /**
   * Silences this clip's player before it's started early (audio), so its
   * first ~0.1–0.3s isn't heard before the clip begins. `activate`
   * un-silences it.
   */
  silence?: () => void;
  /**
   * Sets this clip's player's playback rate (1 = normal, before the clip's
   * own speed). Used to let a late-started player catch up by playing a
   * little faster for a moment, instead of seeking it (see CATCH_UP).
   */
  setRate?: (rate: number) => void;
};

/** Decoder position → timeline time, for this clip. */
function decoderToTimeline(t: ClockTrack, decoderTime: number): number {
  const speed = t.speed > 0 ? t.speed : 1;
  return t.clipStart + (decoderTime - t.trimStart) / speed;
}

/** Timeline time → the source position this clip should be at. */
function timelineToDecoder(t: ClockTrack, timelineTime: number): number {
  const speed = t.speed > 0 ? t.speed : 1;
  return t.trimStart + (timelineTime - t.clipStart) * speed;
}

type UseTimelineClockParams = {
  isPlaying: boolean;
  timelineDuration: number;
  /** One entry per clip (all tracks). Safe to pass a new array every render. */
  tracks: ClockTrack[];
  /** Called once when the playhead reaches the end of the whole timeline. */
  onReachEnd: () => void;
};

/**
 * Master clock for the editor's shared playhead (`timelineTime`).
 *
 * While playing, runs one requestAnimationFrame loop. Each frame:
 *   - The playhead FOLLOWS a player: the highest-priority clip under the
 *     playhead (video first) whose player is moving and in step. Outside
 *     any clip (a gap), or while no player is in step yet, it runs on the
 *     wall clock.
 *   - Only the very start of playback holds the playhead, until the top
 *     clip's player is running (all players start together there).
 *     Mid-playback it never holds: a clip that begins while playing has
 *     its player started EARLY (by its measured start-up time), so it is
 *     already running when the playhead arrives; until it's in step, the
 *     playhead follows another player or the wall clock.
 *   - The other players are kept in step (drift correction), paused right
 *     at their clip's end, and kicked once if they never start.
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
  // Measured player start-up time per track (see DEFAULT_START_LATENCY).
  const startLatencyRef = useRef<Record<string, number>>({});

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
    // When the playhead started holding (start of playback only, see below).
    let holdingSince: number | null = null;
    // Whether we already pulled the player once during this hold.
    let nudged = false;
    let lastSource = "";
    // Performance counters, logged once per second while playing (dev only).
    // `ticks` = animation frames the loop ran, `updates` = how many of those
    // actually moved the playhead (React re-renders), `decoderChanges` = how
    // many times the followed decoder reported a NEW time. These tell us
    // where choppiness comes from: few ticks = JS thread overloaded; many
    // ticks but few decoder changes = decoder time is coarse.
    let perfWindowStart = Date.now();
    let perfTicks = 0;
    let perfUpdates = 0;
    let perfDecoderChanges = 0;
    let lastDecoderValue = NaN;
    let lastCommitTs = 0;
    // Drift correction bookkeeping, per clock entry label (see DRIFT_*).
    const driftSince: Record<string, number> = {};
    const lastDriftFix: Record<string, number> = {};
    // End-of-clip pauses (see END_PAUSE_LOOKAHEAD), per clock entry label.
    const endTimers: Record<string, ReturnType<typeof setTimeout>> = {};
    const endPaused: Record<string, boolean> = {};
    // Has the playhead really moved yet in this run? Only the very start of
    // playback holds the playhead (all players starting together).
    let hasMoved = false;
    // Players paused at the start of playback while the picture starts
    // (see HOLD_OTHERS_AFTER_MS), by clip label.
    const heldOthers: Record<string, ClockTrack> = {};
    let othersHeld = false;
    // The picture started: start the held players in step with it (ahead
    // by their start-up time, so they're at the right spot once running).
    const releaseOthers = (at: number) => {
      for (const label of Object.keys(heldOthers)) {
        const t = heldOthers[label];
        delete heldOthers[label];
        delete driftSince[label];
        const target = timelineToDecoder(t, at + startLatency(t.trackKey));
        t.resyncTo(target);
        t.play();
        if (__DEV__) {
          console.log(
            `[timelineClock] ${label} released — started from source ${target.toFixed(2)}s, in step with the picture`,
          );
        }
      }
    };
    // Per clip under the playhead: the player position when first seen, and
    // whether it has moved since. A parked player reports exactly its
    // clip's first frame, which looks "in sync" while it hasn't started.
    const firstSeenPos: Record<string, number> = {};
    const firstSeenAt: Record<string, number> = {};
    // Last decoder position seen per clip, and when it last changed (for
    // STALL_MS).
    const lastPos: Record<string, number> = {};
    const lastMoveAt: Record<string, number> = {};
    const moved: Record<string, boolean> = {};
    const stuckFixed: Record<string, boolean> = {};
    // Early starts (see PRESTART_WINDOW), per clock entry label.
    const prestartTimers: Record<string, ReturnType<typeof setTimeout>> = {};
    const prestarted: Record<string, boolean> = {};
    // For measuring how long a player takes to start after play().
    // `resynced`: it was seeked right before play() (a late early start),
    // so its start-up time includes the seek and isn't learned from.
    const prestartCall: Record<
      string,
      { at: number; pos: number; resynced: boolean }
    > = {};

    // Players currently catching up faster (see CATCH_UP), by clip label.
    const catchUp: Record<
      string,
      { t: ClockTrack; rate: number; timer: ReturnType<typeof setTimeout> }
    > = {};
    const endCatchUp = (label: string, why: string) => {
      const c = catchUp[label];
      if (!c) return;
      clearTimeout(c.timer);
      delete catchUp[label];
      c.t.setRate?.(c.t.speed);
      if (__DEV__) {
        console.log(
          `[timelineClock] ${label} catch-up done (${why}) — back to x${c.t.speed}`,
        );
      }
    };

    // Start-up time is learned per track KIND ("video", "audio"): both
    // players of a track behave the same.
    const kindOf = (trackKey: string) => trackKey.split("#")[0];
    const startLatency = (trackKey: string) =>
      startLatencyRef.current[kindOf(trackKey)] ??
      DEFAULT_START_LATENCY[kindOf(trackKey)] ??
      DEFAULT_START_LATENCY.other;

    // Does another clip on the same track start right where this one ends
    // (a split point)? Then its player keeps going.
    const continuesOnSameTrack = (t: ClockTrack) =>
      tracksRef.current.some(
        (o) =>
          o.trackKey === t.trackKey &&
          o.label !== t.label &&
          Math.abs(o.clipStart - t.clipEnd) < CONTINUOUS_EPSILON,
      );

    const pauseAtClipEnd = (t: ClockTrack, how: string) => {
      if (endPaused[t.label]) return;
      endPaused[t.label] = true;
      t.pause();
      if (__DEV__) {
        console.log(
          `[timelineClock] ${t.label} reached its end (${t.clipEnd.toFixed(2)}s) — player paused by ${how} @ ${timeRef.current.toFixed(2)}s`,
        );
      }
    };

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
      let followed: ClockTrack | null = null;

      // Read every clip under the playhead once.
      const readings = active.map((t) => {
        const decoderTime = t.getCurrentTime();
        if (firstSeenPos[t.label] === undefined) {
          firstSeenPos[t.label] = decoderTime;
          firstSeenAt[t.label] = now;
        }
        if (!moved[t.label] && decoderTime !== firstSeenPos[t.label]) {
          moved[t.label] = true;
        }
        if (lastPos[t.label] !== decoderTime) {
          lastPos[t.label] = decoderTime;
          lastMoveAt[t.label] = now;
        }
        const candidate = decoderToTimeline(t, decoderTime);
        return { t, decoderTime, candidate, gap: candidate - prev };
      });
      // A catching-up player is back in step: normal speed again. Checked
      // against the time NOW (last frame's time + time since — on a slow
      // dev frame `prev` alone is up to 0.25s old, which ended catch-ups
      // too late), and whether or not its clip has begun yet (before, a
      // player started just before its clip kept running fast until the
      // clip began and ended up ~0.3–0.45s AHEAD).
      const estNow = prev + Math.min(rawDt, MAX_REAL_STEP);
      for (const label of Object.keys(catchUp)) {
        if (prestartCall[label]) continue; // not running yet
        const c = catchUp[label];
        const gap = decoderToTimeline(c.t, c.t.getCurrentTime()) - estNow;
        if (gap >= -CATCH_UP_DONE) {
          endCatchUp(
            label,
            `in step, ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}s`,
          );
        }
      }
      // (A player still catching up isn't followed: the playhead would
      // run at its faster speed.)
      const stalled = (r: (typeof readings)[number]) =>
        hasMoved && now - (lastMoveAt[r.t.label] ?? now) >= STALL_MS;
      const followable = (r: (typeof readings)[number]) =>
        moved[r.t.label] &&
        !catchUp[r.t.label] &&
        !stalled(r) &&
        r.gap >= -FOLLOW_BEHIND &&
        r.gap <= MAX_FOLLOW_AHEAD;

      // Which player does the playhead follow? The highest-priority clip
      // (video first) whose player is moving and in step. At the very start
      // of playback it must be the top one (everything starts together, and
      // the picture leads). After that, NEVER hold: if the top clip's player
      // is still starting (a clip that just began), follow another moving
      // player, or the wall clock, and switch over once it's running.
      const pick = hasMoved
        ? readings.find(followable)
        : readings.length > 0 && followable(readings[0])
          ? readings[0]
          : undefined;

      if (pick) {
        if (holdingSince !== null && __DEV__) {
          console.log(
            `[timelineClock] ${pick.t.label} started after ${now - holdingSince}ms — following @ ${pick.candidate.toFixed(2)}s`,
          );
        }
        releaseOthers(Math.max(prev, pick.candidate));
        // A player slightly behind the playhead (≤ FOLLOW_BEHIND) is still
        // followed, but the playhead never goes back for it.
        next = Math.max(prev, pick.candidate);
        source = pick.t.label;
        followed = pick.t;
        holdingSince = null;
        nudged = false;
        if (__DEV__ && pick.decoderTime !== lastDecoderValue) {
          perfDecoderChanges += 1;
          lastDecoderValue = pick.decoderTime;
        }
      } else if (readings.length > 0 && !hasMoved) {
        // Start of playback: hold until the top clip's player is running.
        const gt = readings[0];
        next = prev;
        source = `holding for ${gt.t.label}`;
        if (holdingSince === null) {
          holdingSince = now;
          if (__DEV__) {
            console.log(
              `[timelineClock] start — waiting for ${gt.t.label} @ ${prev.toFixed(2)}s (player at ${gt.candidate.toFixed(2)}s)`,
            );
          }
        } else if (now - holdingSince >= MAX_HOLD_MS) {
          if (!nudged) {
            const target = timelineToDecoder(gt.t, prev);
            if (__DEV__) {
              console.log(
                `[timelineClock] ${gt.t.label} not started after ${MAX_HOLD_MS}ms — pulling player to playhead (source ${target.toFixed(2)}s)`,
              );
            }
            gt.t.resyncTo(target);
            nudged = true;
            holdingSince = now;
          } else {
            if (__DEV__) {
              console.log(
                `[timelineClock] ${gt.t.label} still not in step after pull — following it (${gt.candidate.toFixed(2)}s)`,
              );
            }
            next = Math.max(prev, gt.candidate);
            source = gt.t.label;
            followed = gt.t;
            moved[gt.t.label] = true;
            holdingSince = null;
            nudged = false;
            releaseOthers(next);
          }
        }
        // The picture is slow to start: pause the others until it does.
        if (
          !othersHeld &&
          holdingSince !== null &&
          now - holdingSince >= HOLD_OTHERS_AFTER_MS
        ) {
          othersHeld = true;
          for (const r of readings.slice(1)) {
            if (r.t.trackKey === gt.t.trackKey) continue;
            r.t.pause();
            heldOthers[r.t.label] = r.t;
            if (__DEV__) {
              console.log(
                `[timelineClock] ${gt.t.label} slow to start — pausing ${r.t.label} until it does`,
              );
            }
          }
        }
      } else if (readings.length > 0) {
        // Mid-playback and no player is in step yet (a clip is starting):
        // keep going on the wall clock instead of freezing the playhead.
        source = `wall-clock (waiting for ${readings[0].t.label})`;
      } else {
        holdingSince = null;
        nudged = false;
      }

      if (!source.startsWith("holding") && next > prev + 0.0001) {
        hasMoved = true;
      }

      // Measure how long early-started players took to get going, and use
      // it for the next early start on that track.
      for (const label of Object.keys(prestartCall)) {
        const t = tracksRef.current.find((o) => o.label === label);
        if (!t) {
          delete prestartCall[label];
          continue;
        }
        // Moving FORWARD past where it was started from. (Not just "a
        // different value": right after a seek, Android reports the old
        // position for a moment, which looked like an instant start.)
        if (t.getCurrentTime() > prestartCall[label].pos + 0.005) {
          // When did it actually start? Work back from how far it has
          // played since (more exact than "half a frame ago": dev frames are
          // slow and uneven, which gave samples like 0ms).
          const cu = catchUp[label];
          const sinceCall = (now - prestartCall[label].at) / 1000;
          const played =
            (t.getCurrentTime() - prestartCall[label].pos) /
            ((t.speed > 0 ? t.speed : 1) * (cu ? cu.rate : 1));
          const sample = Math.max(0, Math.min(sinceCall, sinceCall - played));
          const nowEst = prev + Math.min(rawDt, MAX_REAL_STEP);
          const runGap = decoderToTimeline(t, t.getCurrentTime()) - nowEst;
          const cfg = CATCH_UP[kindOf(t.trackKey)] ?? CATCH_UP.other;
          // Started much later than planned (its seek was slow, the JS
          // thread stalled): too far behind to catch up by speed — move it
          // to the right spot NOW, instead of letting the drift fix do it
          // a second later (a visible jump mid-clip).
          if (runGap < -cfg.max && nowEst >= t.clipStart - CLIP_EPSILON) {
            if (cu) endCatchUp(label, "too far behind — seeking instead");
            const lead = SEEK_LEAD[kindOf(t.trackKey)] ?? SEEK_LEAD.other;
            const target = timelineToDecoder(t, nowEst + lead);
            if (__DEV__) {
              console.log(
                `[timelineClock] ${label} started ${(-runGap).toFixed(2)}s behind — resync now to source ${target.toFixed(2)}s`,
              );
            }
            t.resyncTo(target);
            lastDriftFix[label] = now;
          } else if (cu) {
            // Catching up: now that it's running, it's known exactly how
            // far behind it is — end the catch-up right when it's made up.
            const gap = runGap;
            if (gap >= -CATCH_UP_DONE) {
              endCatchUp(
                label,
                `already in step once running, ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}s`,
              );
            } else {
              clearTimeout(cu.timer);
              const ms = (-gap / (cu.rate - 1)) * 1000;
              cu.timer = setTimeout(
                () => endCatchUp(label, "made up the gap (timer)"),
                ms,
              );
              if (__DEV__) {
                console.log(
                  `[timelineClock] ${label} running ${(-gap).toFixed(2)}s behind — catch-up for ${Math.round(ms)}ms`,
                );
              }
            }
          }
          const old = startLatency(t.trackKey);
          const resynced = prestartCall[label].resynced;
          const implausible = sample < MIN_PLAUSIBLE_START;
          const updated =
            resynced || implausible
              ? old
              : Math.min(
                  LATENCY_MAX,
                  Math.max(
                    LATENCY_MIN,
                    old * (1 - LATENCY_LEARN_WEIGHT) +
                      sample * LATENCY_LEARN_WEIGHT,
                  ),
                );
          startLatencyRef.current[kindOf(t.trackKey)] = updated;
          delete prestartCall[label];
          // It's running: once its clip begins, the playhead may follow it
          // right away. Before, the clock first had to see it move again
          // after the clip began (1–2 slow dev frames), and ran on the wall
          // clock meanwhile, then jumped forward to the player.
          moved[label] = true;
          firstSeenAt[label] = now;
          if (__DEV__) {
            console.log(
              `[timelineClock] ${label} player (${t.trackKey}) started ${Math.round(sample * 1000)}ms after play() — ${resynced ? `seeked first, not learned from; ${kindOf(t.trackKey)} start lead stays` : implausible ? `too fast to be real, not learned from; ${kindOf(t.trackKey)} start lead stays` : `${kindOf(t.trackKey)} start lead now`} ${Math.round(updated * 1000)}ms`,
            );
          }
        }
      }

      // Keep the OTHER players in step with the playhead. A player that
      // never started (stuck) is kicked once after MAX_HOLD_MS.
      for (const r of readings) {
        const t = r.t;
        if (t === followed || endPaused[t.label] || catchUp[t.label]) continue;
        if (!moved[t.label]) {
          if (
            !stuckFixed[t.label] &&
            now - firstSeenAt[t.label] >= MAX_HOLD_MS
          ) {
            stuckFixed[t.label] = true;
            const target = timelineToDecoder(t, next);
            if (__DEV__) {
              console.log(
                `[timelineClock] ${t.label} player hasn't started after ${MAX_HOLD_MS}ms — seek to ${target.toFixed(2)}s and play`,
              );
            }
            t.resyncTo(target);
            t.play();
          }
          continue;
        }
        const err = r.candidate - next;
        if (Math.abs(err) <= DRIFT_MAX) {
          delete driftSince[t.label];
          continue;
        }
        if (driftSince[t.label] === undefined) {
          driftSince[t.label] = now;
          continue;
        }
        const offFor = now - driftSince[t.label];
        const sinceFix = now - (lastDriftFix[t.label] ?? 0);
        if (offFor >= DRIFT_GRACE_MS && sinceFix >= DRIFT_COOLDOWN_MS) {
          // Ahead of the playhead by the seek's own delay (SEEK_LEAD).
          const target = timelineToDecoder(
            t,
            next + (SEEK_LEAD[kindOf(t.trackKey)] ?? SEEK_LEAD.other),
          );
          if (__DEV__) {
            console.log(
              `[timelineClock] ${t.label} drifted ${err > 0 ? "ahead" : "behind"} by ${Math.abs(err).toFixed(2)}s for ${offFor}ms — resync to source ${target.toFixed(2)}s`,
            );
          }
          t.resyncTo(target);
          lastDriftFix[t.label] = now;
          delete driftSince[t.label];
        }
      }

      // Start the player of an upcoming clip EARLY — by its measured
      // start-up time — so it's already running when the playhead reaches
      // the clip, and playback carries straight on. The track sync has
      // parked the player on the clip's first frame; the early frames are
      // hidden (the preview is black in the gap). Only when the player is
      // free (no clip of its track under the playhead).
      for (const t of tracksRef.current) {
        if (prestarted[t.label]) continue;
        // Not while the clock is still holding for the picture at the start
        // of playback: the timer counts real time, but the playhead isn't
        // moving yet — it fired ~1s early and the next clip started far
        // ahead of the playhead.
        if (!hasMoved) continue;
        const until = t.clipStart - next;
        if (until <= 0 || until > PRESTART_WINDOW) continue;
        const busy = tracksRef.current.some(
          (o) =>
            o.trackKey === t.trackKey &&
            o.label !== t.label &&
            next >= o.clipStart - CLIP_EPSILON &&
            next < o.clipEnd &&
            !endPaused[o.label],
        );
        if (busy) continue;
        prestarted[t.label] = true;
        const lead = startLatency(t.trackKey);
        // A little extra, for the JS thread being busy when the timer is due.
        const delayMs = Math.max(0, (until - lead - PRESTART_MARGIN) * 1000);
        prestartTimers[t.label] = setTimeout(() => {
          delete prestartTimers[t.label];
          if (haltedRef.current) return;
          // Fired late (the JS thread was busy)? Then the clip is about to
          // start sooner than `lead` — or already has. Start the player
          // from where the clip will be once it's running, instead of from
          // its first frame (that left it behind the playhead).
          // timeRef is from the last frame; on a busy JS thread that can be
          // 0.1–0.2s old, so add the time since.
          const nowTime =
            timeRef.current +
            Math.min((Date.now() - lastTs) / 1000, MAX_REAL_STEP);
          const runningAt = nowTime + lead;
          let startPos = t.getCurrentTime();
          const lateBy = runningAt - t.clipStart;
          const catchUpCfg = CATCH_UP[kindOf(t.trackKey)] ?? CATCH_UP.other;
          const canCatchUp =
            lateBy > 0.02 && lateBy <= catchUpCfg.max && !!t.setRate;
          const late = lateBy > 0.02 && !canCatchUp;
          if (canCatchUp) {
            // Start from the parked frame, a bit faster; the clock sets it
            // back to normal once it's in step (or after the time it
            // should take, plus some slack, as a fallback).
            const catchUpSec = lateBy / (catchUpCfg.rate - 1);
            t.setRate?.(t.speed * catchUpCfg.rate);
            catchUp[t.label] = {
              t,
              rate: catchUpCfg.rate,
              timer: setTimeout(
                function timesUp() {
                  // Not running yet (a slow start): don't give up — once it
                  // starts, the start check above decides (catch up / seek).
                  const c = catchUp[t.label];
                  if (c && prestartCall[t.label]) {
                    c.timer = setTimeout(timesUp, 250);
                    return;
                  }
                  endCatchUp(t.label, "time's up");
                },
                (lead + catchUpSec + 0.3) * 1000,
              ),
            };
            if (__DEV__) {
              console.log(
                `[timelineClock] early start ${t.label} is late by ${lateBy.toFixed(2)}s — no seek, catching up at x${catchUpCfg.rate} for ~${Math.round(catchUpSec * 1000)}ms`,
              );
            }
          }
          if (late) {
            const target = timelineToDecoder(t, runningAt);
            startPos = target;
            if (__DEV__) {
              console.log(
                `[timelineClock] early start ${t.label} is late by ${(runningAt - t.clipStart).toFixed(2)}s — starting it from source ${target.toFixed(2)}s`,
              );
            }
            t.resyncTo(target);
          }
          prestartCall[t.label] = {
            at: Date.now(),
            pos: startPos,
            resynced: late,
          };
          t.silence?.();
          t.play();
          if (__DEV__) {
            console.log(
              `[timelineClock] early start ${t.label} — ${t.clipStart >= nowTime ? `${Math.round((t.clipStart - nowTime) * 1000)}ms before` : `${Math.round((nowTime - t.clipStart) * 1000)}ms AFTER`} its clip @ ${t.clipStart.toFixed(2)}s (start-up lead ${Math.round(lead * 1000)}ms)`,
            );
          }
        }, delayMs);
      }

      // A clip begins: make its player the one you see / hear on its track,
      // at the exact moment (not when React re-renders).
      for (const t of tracksRef.current) {
        if (prev < t.clipStart && next >= t.clipStart) {
          t.activate?.();
          if (__DEV__) {
            console.log(
              `[timelineClock] ${t.label} begins @ ${t.clipStart.toFixed(2)}s — ${t.trackKey} now shown/heard`,
            );
          }
        }
      }

      // Pause each clip's player right at its end, without waiting for a
      // React re-render: a timer when the end is close, and a direct pause
      // if this frame already went past it.
      for (const t of tracksRef.current) {
        if (endPaused[t.label]) continue;
        const crossed = prev < t.clipEnd && next >= t.clipEnd;
        const inside = next >= t.clipStart - CLIP_EPSILON && next < t.clipEnd;
        if (!crossed && !inside) continue;
        if (continuesOnSameTrack(t)) continue;
        if (crossed) {
          if (endTimers[t.label] !== undefined) {
            clearTimeout(endTimers[t.label]);
            delete endTimers[t.label];
          }
          pauseAtClipEnd(t, "clock frame");
          continue;
        }
        // Time left until the end, from the player's own position when it's
        // plausible (a drifted player reaches its end sooner or later than
        // the playhead), otherwise from the playhead.
        const playerPos = decoderToTimeline(t, t.getCurrentTime());
        const from = Math.abs(playerPos - next) < 1 ? playerPos : next;
        const remaining = Math.max(0, t.clipEnd - from);
        if (
          remaining <= END_PAUSE_LOOKAHEAD &&
          endTimers[t.label] === undefined
        ) {
          endTimers[t.label] = setTimeout(() => {
            delete endTimers[t.label];
            if (haltedRef.current) return;
            pauseAtClipEnd(t, "end timer");
          }, remaining * 1000);
        }
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
      for (const label of Object.keys(endTimers))
        clearTimeout(endTimers[label]);
      for (const label of Object.keys(prestartTimers))
        clearTimeout(prestartTimers[label]);
      // Never leave a player running fast after playback stops.
      for (const label of Object.keys(catchUp))
        endCatchUp(label, "playback stopped");
      // An early-started player whose clip hasn't begun yet isn't known to
      // the track sync as playing — pause it here, or it would keep playing
      // hidden after playback stops.
      for (const t of tracksRef.current) {
        if (prestarted[t.label] && t.clipStart > timeRef.current) t.pause();
      }
      // rafId is only null here if the loop already stopped by itself (end
      // of the timeline, or halted by a gesture) — then there's nothing to
      // align: the end position is exact, and after a halt the gesture
      // (e.g. the scrub's seekTo) owns the playhead.
      const halted = haltedRef.current;
      const pausedMidway = rafId !== null && !halted;
      if (rafId !== null) cancelAnimationFrame(rafId);
      playingSV.value = false;
      rateSV.value = 0;

      // Where did playback really stop? Pause the players under the
      // playhead right now and read the picture's own position: that frame
      // is what stays on screen, so the playhead goes there and nothing is
      // seeked. (Before, the players were seeked to the drawn playhead —
      // the picture jumped a little on every pause.) The drawn playhead is
      // usually within a few hundredths of it, so the timeline barely moves.
      const clockTime = timeRef.current;
      const drawnTime = uiTimeSV.value;
      let stopMode: "player" | "drawn" | "clock" = "clock";
      let leadLabel = "";
      if (pausedMidway) {
        const underPlayhead = tracksRef.current
          .filter(
            (o) =>
              drawnTime >= o.clipStart - CLIP_EPSILON &&
              drawnTime < o.clipEnd &&
              !endPaused[o.label],
          )
          .sort((a, b) => a.priority - b.priority);
        for (const o of underPlayhead) o.pause();
        const lead = underPlayhead[0];
        const playerTime = lead
          ? decoderToTimeline(lead, lead.getCurrentTime())
          : NaN;
        if (
          Number.isFinite(playerTime) &&
          Math.abs(playerTime - drawnTime) <= PAUSE_ALIGN_MAX_AHEAD &&
          playerTime < durationRef.current - END_EPSILON
        ) {
          timeRef.current = Math.max(0, playerTime);
          stopMode = "player";
          leadLabel = lead.label;
        } else {
          // No plausible player position: keep the drawn playhead (see
          // PAUSE_ALIGN_MAX_AHEAD) and move the players there.
          const ahead = drawnTime - clockTime;
          if (
            ahead > 0.001 &&
            ahead <= PAUSE_ALIGN_MAX_AHEAD &&
            drawnTime < durationRef.current - END_EPSILON
          ) {
            timeRef.current = drawnTime;
            stopMode = "drawn";
          }
        }
      }

      targetSV.value = timeRef.current;
      // Commit the exact final position (the last few ticks may not have
      // been committed because of the reduced commit rate).
      setTimelineTime(timeRef.current);
      if (stopMode === "drawn") setSeekVersion((v) => v + 1);
      if (__DEV__) {
        console.log(
          stopMode === "player"
            ? `[timelineClock] loop stop @ ${timeRef.current.toFixed(2)}s (where ${leadLabel}'s picture stopped; drawn playhead ${drawnTime.toFixed(2)}s, clock ${clockTime.toFixed(2)}s — no seek)`
            : stopMode === "drawn"
              ? `[timelineClock] loop stop @ ${timeRef.current.toFixed(2)}s (kept drawn playhead; clock was ${clockTime.toFixed(2)}s)`
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
