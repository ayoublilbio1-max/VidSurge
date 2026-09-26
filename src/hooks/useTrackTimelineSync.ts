import type { VideoPlayer } from "expo-video";
import { useEffect, useRef } from "react";
import { activeClipAt, timelineToSource, type Clip } from "../editor/clipModel";

// How far ahead (timeline seconds) a gap's NEXT clip gets pre-seeked. While
// the playhead crosses a gap, this track's player is idle, so it can be
// parked on the next clip's first frame in advance. Entering that clip then
// only needs play(), not a seek + play — the playhead waits much less for
// the player to start (that wait is what let the other track drift ahead).
const PREROLL_WINDOW = 1.5;
// On entering a prerolled clip, skip the seek if the player is within this
// of where it should be. The playhead reaches this code a little late
// (React re-renders ~100–200ms after the clock crosses the edge in the dev
// build), so the parked player is usually 0.1–0.2s "behind". Playing from
// the parked frame is still much faster than a seek; the clock simply
// holds the playhead until the picture catches up.
const PREROLL_TOLERANCE = 0.3;
// ...and how far AHEAD the player may be. While playing, `timelineTime`
// (React) lags the real playhead by up to ~0.2s (more when the JS thread is
// busy), and the clock starts an upcoming clip's player early — so on entry
// the running player normally looks ahead of the stale target. Seeking it
// back restarted the video and left it ~0.6s behind (then the drift fix
// yanked it forward again). Within this window it's left alone; the clock,
// which has the exact time, corrects any real difference.
const ENTER_AHEAD_TOLERANCE = 1.0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

type UseTrackTimelineSyncParams = {
  /** Just for debug logs, e.g. "video" / "audio". */
  label: string;
  player: VideoPlayer;
  isPlaying: boolean;
  /** The shared playhead position, from useTimelineClock. */
  timelineTime: number;
  /**
   * Bumped by useTimelineClock's `seekTo` on every EXPLICIT jump (scrub,
   * restart, trim-clamp). A change here means "force this track's player
   * to timelineTime right now", even if the playhead stayed in one clip.
   */
  seekVersion: number;
  /** This track's clips, sorted by start (from the project). */
  clips: Clip[];
  /**
   * While true, this track does NOT seek its player — it only remembers
   * that a seek is owed, and does it (once, to the exact position) as soon
   * as this goes back to false. Used for the audio track while the user
   * scrubs: seeking a second player on every scrub update was extra main
   * thread work that made fast timeline scrolling stutter, and nobody hears
   * a paused audio player anyway.
   */
  holdSeeks?: boolean;
  /**
   * Called when the playhead enters one of this player's clips (playing,
   * paused or scrubbing): makes this player the one you see / hear on its
   * track. While playing, the clock already did it at the exact moment;
   * calling it again is harmless.
   */
  onEnterClip?: () => void;
};

/**
 * Per-player playback reactor. Each track has two players that take turns
 * (consecutive clips alternate between them); call this once per player,
 * with that player's clips. It seeks/plays/pauses the player based on which
 * of its clips is under the playhead, and parks it on its next clip while
 * the other player is playing.
 *
 * The player gets force-seeked to the playhead when:
 *   1. the playhead entered a clip (from a gap, or from another clip —
 *      e.g. across a split point),
 *   2. `seekVersion` changed (an explicit scrub/jump),
 *   3. the active clip was moved, trimmed at the start, or changed speed —
 *      the same playhead now maps to a different spot in the source, or
 *   4. playback resumes (paused -> playing). A player keeps running for a
 *      moment after pause() is sent, so it's usually a bit ahead of the
 *      playhead by the time you press play again.
 *
 * Clip ends are detected from `timelineTime` (the playhead leaving the
 * clip), NOT from `player.currentTime`. Right after a seek, Android players
 * briefly report their OLD position, and reading that used to make a track
 * think it had "reached its trim end" the instant play was pressed.
 */
export function useTrackTimelineSync({
  label,
  player,
  isPlaying,
  timelineTime,
  seekVersion,
  clips,
  holdSeeks = false,
  onEnterClip,
}: UseTrackTimelineSyncParams) {
  const onEnterClipRef = useRef(onEnterClip);
  onEnterClipRef.current = onEnterClip;
  // The clip currently under the playhead (id), or null in a gap.
  const activeIdRef = useRef<string | null>(null);
  // Whether we've told this player to play, to avoid redundant native calls.
  const playingRef = useRef(false);
  // Last seekVersion already applied, so each explicit jump reseeks once.
  const lastSeekVersionRef = useRef(seekVersion);
  // Last timeline->source mapping applied to the player (active clip).
  const lastStartRef = useRef(0);
  const lastTrimInRef = useRef(0);
  const lastSpeedRef = useRef(1);
  // A seek that was skipped because of `holdSeeks`, still to be done.
  const pendingSeekRef = useRef(false);
  // The clip the player was parked on during a gap (see PREROLL_WINDOW).
  const prerolledIdRef = useRef<string | null>(null);
  // The clip speed last applied to the player (see the rate code below).
  const appliedSpeedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!player) return;

    const active = activeClipAt(clips, timelineTime);

    if (!active) {
      if (activeIdRef.current !== null) {
        player.pause();
        playingRef.current = false;
        if (__DEV__) {
          console.log(
            `[trackSync:${label}] exit clip ${activeIdRef.current} @ ${timelineTime.toFixed(2)}s`,
          );
        }
      }
      activeIdRef.current = null;
      lastSeekVersionRef.current = seekVersion;
      // No clip of this player under the playhead: a seek held back during
      // a scrub no longer applies. Left set, it used to fire much later —
      // when playback reached this player's next clip — and throw the
      // already-running player back (audio lag, then drift corrections).
      if (pendingSeekRef.current && __DEV__) {
        console.log(
          `[trackSync:${label}] held scrub seek dropped (no clip under the playhead)`,
        );
      }
      pendingSeekRef.current = false;

      // In a gap while playing: park the player on the next clip's start.
      if (isPlaying && !holdSeeks) {
        const nextClip = clips.find((c) => c.start > timelineTime);
        if (
          nextClip &&
          nextClip.start - timelineTime <= PREROLL_WINDOW &&
          prerolledIdRef.current !== nextClip.id
        ) {
          prerolledIdRef.current = nextClip.id;
          player.currentTime = nextClip.trimIn;
          if (__DEV__) {
            console.log(
              `[trackSync:${label}] preroll — next clip ${nextClip.id} starts in ${(nextClip.start - timelineTime).toFixed(2)}s, parked at source ${nextClip.trimIn.toFixed(2)}s`,
            );
          }
        }
      }
      return;
    }

    const justEntered = activeIdRef.current !== active.id;
    // Came straight from another clip of this track (no gap in between),
    // e.g. across a split point.
    const fromClip = justEntered && activeIdRef.current !== null;
    activeIdRef.current = active.id;
    // Entering a clip always (re)starts the player below: the clock may
    // have paused it at the previous clip's end (useTimelineClock pauses
    // players right at their clip end, before React re-renders), and
    // play() on a player that's already playing is harmless.
    if (justEntered) {
      playingRef.current = false;
      onEnterClipRef.current?.();
    }

    const explicitSeek = seekVersion !== lastSeekVersionRef.current;
    lastSeekVersionRef.current = seekVersion;

    const mappingChanged =
      !justEntered &&
      (active.start !== lastStartRef.current ||
        active.trimIn !== lastTrimInRef.current ||
        active.speed !== lastSpeedRef.current);
    lastStartRef.current = active.start;
    lastTrimInRef.current = active.trimIn;
    lastSpeedRef.current = active.speed;

    const resuming = isPlaying && !playingRef.current;

    const targetTime = clamp(
      timelineToSource(active, timelineTime),
      active.trimIn,
      active.trimOut,
    );

    let wantsSeek = justEntered || explicitSeek || mappingChanged || resuming;

    // Entering a clip the player is already at: no seek needed. Either it
    // was parked there during a gap (preroll), or playback just crossed a
    // split point and the same player carries straight on into the next
    // part of the source (seeking there would cause a hitch at every cut).
    const prerolled = prerolledIdRef.current === active.id;
    const continuing = fromClip && isPlaying;
    const offset = player.currentTime - targetTime;
    if (
      wantsSeek &&
      justEntered &&
      !explicitSeek &&
      (prerolled || continuing) &&
      offset >= -PREROLL_TOLERANCE &&
      offset <= (isPlaying ? ENTER_AHEAD_TOLERANCE : PREROLL_TOLERANCE)
    ) {
      wantsSeek = false;
      if (__DEV__) {
        console.log(
          `[trackSync:${label}] enter ${prerolled ? "prerolled" : "next (continuous)"} clip ${active.id} — no seek (player @ ${player.currentTime.toFixed(2)}s, ${offset >= 0 ? "+" : ""}${offset.toFixed(2)}s vs React time)`,
        );
      }
    }
    if (justEntered) prerolledIdRef.current = null;

    if (holdSeeks && !isPlaying) {
      // Scrubbing always pauses playback first — make sure this player is
      // actually paused too (the pause and the hold arrive in the same
      // render, and we return early below).
      if (playingRef.current) {
        player.pause();
        playingRef.current = false;
        if (__DEV__)
          console.log(
            `[trackSync:${label}] pause @ ${timelineTime.toFixed(2)}s`,
          );
      }
      if (wantsSeek && !pendingSeekRef.current) {
        pendingSeekRef.current = true;
        if (__DEV__) {
          console.log(
            `[trackSync:${label}] scrubbing — seek deferred until release`,
          );
        }
      }
      return;
    }

    // A held scrub seek is only for the scrub release itself (paused). Once
    // playing, the entry/resume logic above owns the player's position.
    if (pendingSeekRef.current && isPlaying) {
      pendingSeekRef.current = false;
      if (__DEV__)
        console.log(
          `[trackSync:${label}] held scrub seek dropped (already playing)`,
        );
    }
    if (pendingSeekRef.current && !wantsSeek) {
      pendingSeekRef.current = false;
      player.currentTime = targetTime;
      if (__DEV__) {
        console.log(
          `[trackSync:${label}] deferred seek (scrub released), seek to ${targetTime.toFixed(2)}s`,
        );
      }
    }

    if (wantsSeek) {
      pendingSeekRef.current = false;
      player.currentTime = targetTime;
      if (__DEV__) {
        const reason = justEntered
          ? `enter clip ${active.id}`
          : explicitSeek
            ? "explicit seek"
            : mappingChanged
              ? "clip moved/trimmed"
              : "resume";
        console.log(
          `[trackSync:${label}] ${reason}, seek to ${targetTime.toFixed(2)}s`,
        );
      }
    }

    // Speed: the player plays at the clip's rate. Only set when the clip
    // speed changes (or while paused): while playing, the clock may be
    // running this player a bit faster to catch up after a late start
    // (useTimelineClock CATCH_UP), and resetting it here cut that short.
    if (
      active.speed !== appliedSpeedRef.current ||
      (!isPlaying && player.playbackRate !== active.speed)
    ) {
      appliedSpeedRef.current = active.speed;
      if (player.playbackRate !== active.speed) {
        player.playbackRate = active.speed;
        if (__DEV__)
          console.log(`[trackSync:${label}] playback rate → x${active.speed}`);
      }
    }

    if (!isPlaying) {
      if (playingRef.current) {
        player.pause();
        playingRef.current = false;
        if (__DEV__)
          console.log(
            `[trackSync:${label}] pause @ ${timelineTime.toFixed(2)}s`,
          );
      }
      return;
    }

    if (!playingRef.current) {
      player.play();
      playingRef.current = true;
      if (__DEV__)
        console.log(`[trackSync:${label}] play @ ${timelineTime.toFixed(2)}s`);
    }
  }, [timelineTime, seekVersion, isPlaying, clips, player, label, holdSeeks]);
}
