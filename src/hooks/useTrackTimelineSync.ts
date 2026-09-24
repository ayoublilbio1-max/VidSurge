import type { VideoPlayer } from "expo-video";
import { useEffect, useRef } from "react";

const CLIP_EPSILON = 0.001;

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
   * to timelineTime right now", even if the playhead never left this
   * clip's bounds during the jump.
   */
  seekVersion: number;
  /** Where this track's clip starts/ends on the shared timeline (seconds). */
  clipStart: number;
  clipEnd: number;
  /** This track's trim-in/out points inside the *source* file. */
  trimStart: number;
  trimEnd: number;
};

/**
 * Per-track playback reactor. Call once per track (video, audio). It
 * seeks/plays/pauses THAT track's player based only on the shared
 * playhead vs THAT track's own clip bounds, so video and audio can sit at
 * different timeline positions.
 *
 * The player gets force-seeked to the playhead when:
 *   1. the playhead just crossed INTO this clip,
 *   2. `seekVersion` changed (an explicit scrub/jump),
 *   3. the clip was moved or its start was trimmed (clipStart/trimStart
 *      changed) — the same playhead now maps to a different spot in the
 *      source file, so the player has to jump there, or
 *   4. playback resumes (paused -> playing). A player keeps running for a
 *      moment after pause() is sent, so it's usually a bit ahead of the
 *      playhead by the time you press play again.
 *
 * The clip end is detected from `timelineTime` (the playhead leaving
 * clipEnd), NOT from `player.currentTime`. Right after a seek, Android
 * players briefly report their OLD position, and reading that used to make
 * a track think it had "reached its trim end" the instant play was pressed.
 */
export function useTrackTimelineSync({
  label,
  player,
  isPlaying,
  timelineTime,
  seekVersion,
  clipStart,
  clipEnd,
  trimStart,
  trimEnd,
}: UseTrackTimelineSyncParams) {
  // Whether the playhead is currently inside this track's clip bounds.
  const insideRef = useRef(false);
  // Whether we've told this player to play, to avoid redundant native calls.
  const playingRef = useRef(false);
  // Last seekVersion already applied, so each explicit jump reseeks once.
  const lastSeekVersionRef = useRef(seekVersion);
  // Last timeline->source mapping applied to the player.
  const lastClipStartRef = useRef(clipStart);
  const lastTrimStartRef = useRef(trimStart);

  useEffect(() => {
    if (!player) return;

    const insideClip =
      timelineTime >= clipStart - CLIP_EPSILON && timelineTime < clipEnd;

    if (!insideClip) {
      if (insideRef.current) {
        player.pause();
        playingRef.current = false;
        if (__DEV__) {
          console.log(
            `[trackSync:${label}] exit clip @ ${timelineTime.toFixed(2)}s`,
          );
        }
      }
      insideRef.current = false;
      lastSeekVersionRef.current = seekVersion;
      lastClipStartRef.current = clipStart;
      lastTrimStartRef.current = trimStart;
      return;
    }

    const justEntered = !insideRef.current;
    insideRef.current = true;

    const explicitSeek = seekVersion !== lastSeekVersionRef.current;
    lastSeekVersionRef.current = seekVersion;

    const mappingChanged =
      clipStart !== lastClipStartRef.current ||
      trimStart !== lastTrimStartRef.current;
    lastClipStartRef.current = clipStart;
    lastTrimStartRef.current = trimStart;

    const resuming = isPlaying && !playingRef.current;

    const targetTime = clamp(
      trimStart + (timelineTime - clipStart),
      trimStart,
      trimEnd,
    );

    if (justEntered || explicitSeek || mappingChanged || resuming) {
      player.currentTime = targetTime;
      if (__DEV__) {
        const reason = justEntered
          ? "enter clip"
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
  }, [
    timelineTime,
    seekVersion,
    isPlaying,
    clipStart,
    clipEnd,
    trimStart,
    trimEnd,
    player,
    label,
  ]);
}
