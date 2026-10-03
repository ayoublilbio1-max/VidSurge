import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runOnJS, runOnUI, useSharedValue } from "react-native-reanimated";
import type { PreviewHandle } from "../../modules/vidsurge-engine";
import type { PlayheadSync } from "./useTimelineClock";

// While playing, React state (`timelineTime`) is only committed this often
// — plus right away whenever the time crosses a clip edge (so texts,
// stickers and the PIP frame appear / go on time). The smooth movement of
// the timeline doesn't depend on React: it runs on the UI thread from
// `playhead` (see EditorTimeline's frame callback).
const JS_COMMIT_INTERVAL_MS = 200;
// On pause, the playhead the user SEES runs a little ahead of the last time
// report. If the picture stopped at most this far ahead of the drawn
// playhead, the timeline goes there (no seek); otherwise it keeps the drawn
// playhead and the picture is moved to it.
const PAUSE_ALIGN_MAX_AHEAD = 0.4;
const END_EPSILON = 0.001;

type Params = {
  /** The native preview view (null until it's on screen). */
  previewRef: { current: PreviewHandle | null };
  isPlaying: boolean;
  timelineDuration: number;
  /** Every clip start / end on every track (seconds). */
  edges: number[];
  /** Called once when playback reaches the end of the timeline. */
  onReachEnd: () => void;
};

/**
 * The editor's clock with the native preview (engine v3).
 *
 * The native player plays the whole edit with its own clock; this hook only
 * mirrors its time for the UI:
 *   - `playhead` (shared values) for the UI thread, which moves the
 *     timeline smoothly between time reports,
 *   - `timelineTime` (React state, throttled) for everything else,
 *   - play / pause follow `isPlaying`; `seekTo` jumps (scrub, trim clamp,
 *     restart); `halt` stops on the spot when a gesture takes over.
 *
 * Same interface as the old JavaScript clock (useTimelineClock), so the
 * timeline and the editor's tools work unchanged. The native view's events
 * go to `onTimeEvent`, `onPlaybackEvent` and `onEndedEvent`.
 */
export function useNativeClock({
  previewRef,
  isPlaying,
  timelineDuration,
  edges,
  onReachEnd,
}: Params) {
  const [timelineTime, setTimelineTime] = useState(0);
  const timeRef = useRef(0);
  const haltedRef = useRef(false);
  const playingRef = useRef(false);
  const endedRef = useRef(false);
  const lastCommitRef = useRef(0);
  const stopTimeRef = useRef(0);
  const stopSeqRef = useRef(0);

  const edgesRef = useRef(edges);
  const durationRef = useRef(timelineDuration);
  const onReachEndRef = useRef(onReachEnd);
  useEffect(() => {
    edgesRef.current = edges;
    durationRef.current = timelineDuration;
    onReachEndRef.current = onReachEnd;
  });

  const targetSV = useSharedValue(0);
  const rateSV = useSharedValue(0);
  const snapSV = useSharedValue(0);
  const playingSV = useSharedValue(false);
  const uiTimeSV = useSharedValue(0);
  const playhead = useMemo<PlayheadSync>(
    () => ({ targetSV, rateSV, snapSV, playingSV, uiTimeSV }),
    [targetSV, rateSV, snapSV, playingSV, uiTimeSV],
  );

  // ---- Play / pause --------------------------------------------------------
  useEffect(() => {
    if (!isPlaying) return;
    haltedRef.current = false;
    endedRef.current = false;
    playingRef.current = true;
    const seq = ++stopSeqRef.current;
    // The UI thread starts from here (snap), not moving until the picture runs.
    targetSV.value = timeRef.current;
    rateSV.value = 0;
    snapSV.value = snapSV.value + 1;
    playingSV.value = true;
    lastCommitRef.current = 0;
    void previewRef.current?.play();
    if (__DEV__)
      console.log(`[nativeClock] play @ ${timeRef.current.toFixed(2)}s`);

    return () => {
      playingRef.current = false;
      playingSV.value = false;
      rateSV.value = 0;
      const finish = (finalTime: number, how: string) => {
        // A new playback started before this arrived: it owns the time now.
        if (seq !== stopSeqRef.current) return;
        timeRef.current = finalTime;
        targetSV.value = finalTime;
        stopTimeRef.current = finalTime;
        setTimelineTime(finalTime);
        if (__DEV__)
          console.log(`[nativeClock] stop @ ${finalTime.toFixed(2)}s${how}`);
      };
      if (endedRef.current) {
        finish(durationRef.current, " (end of the timeline)");
        return;
      }
      if (haltedRef.current) {
        // A gesture took over: it owns the playhead now (its seekTo).
        finish(timeRef.current, " (halted by gesture)");
        return;
      }
      // Being decided (see EditorTimeline's pause follow).
      stopTimeRef.current = NaN;
      const view = previewRef.current;
      const decide = (pictureAt: number) => {
        if (seq !== stopSeqRef.current) return;
        const maxTime = durationRef.current - END_EPSILON;
        const onDecided = (
          finalTime: number,
          usedPicture: boolean,
          drawn: number,
        ) => {
          finish(
            finalTime,
            usedPicture
              ? ` (where the picture stopped; drawn ${drawn.toFixed(2)}s)`
              : ` (kept the drawn playhead; picture ${pictureAt.toFixed(2)}s)`,
          );
          if (!usedPicture && Math.abs(pictureAt - finalTime) >= 0.02) {
            void previewRef.current?.seekTo(finalTime * 1000);
          }
        };
        runOnUI((pt: number) => {
          "worklet";
          const drawn = uiTimeSV.value;
          const usable =
            pt === pt &&
            pt >= drawn &&
            pt - drawn <= PAUSE_ALIGN_MAX_AHEAD &&
            pt < maxTime;
          const finalTime = usable ? pt : Math.max(0, drawn);
          uiTimeSV.value = finalTime;
          targetSV.value = finalTime;
          runOnJS(onDecided)(finalTime, usable, drawn);
        })(pictureAt);
      };
      if (!view) {
        decide(NaN);
        return;
      }
      view
        .pause()
        .then((ms) => decide(ms / 1000))
        .catch(() => decide(NaN));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // ---- From the native view ------------------------------------------------------
  const commit = (prev: number, next: number) => {
    const now = Date.now();
    const crossed = edgesRef.current.some((e) => prev < e !== next < e);
    if (crossed || now - lastCommitRef.current >= JS_COMMIT_INTERVAL_MS) {
      lastCommitRef.current = now;
      setTimelineTime(next);
    }
  };

  const onTimeEvent = useCallback(
    (e: { nativeEvent: { time: number; playing: boolean } }) => {
      if (!playingRef.current || haltedRef.current) return;
      const { time, playing } = e.nativeEvent;
      const prev = timeRef.current;
      timeRef.current = time;
      targetSV.value = time;
      rateSV.value = playing ? 1 : 0;
      commit(prev, time);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetSV, rateSV],
  );

  const onPlaybackEvent = useCallback(
    (e: {
      nativeEvent: { playing: boolean; waiting: boolean; time: number };
    }) => {
      if (!playingRef.current || haltedRef.current) return;
      const { playing, waiting, time } = e.nativeEvent;
      rateSV.value = playing ? 1 : 0;
      if (playing) {
        timeRef.current = time;
        targetSV.value = time;
      }
      if (__DEV__)
        console.log(
          `[nativeClock] picture ${playing ? "running" : waiting ? "waiting (loading)" : "stopped"} @ ${time.toFixed(2)}s`,
        );
    },
    [rateSV, targetSV],
  );

  const onEndedEvent = useCallback(() => {
    if (!playingRef.current) return;
    const end = durationRef.current;
    endedRef.current = true;
    timeRef.current = end;
    targetSV.value = end;
    rateSV.value = 0;
    setTimelineTime(end);
    if (__DEV__)
      console.log(`[nativeClock] reached the end @ ${end.toFixed(2)}s`);
    onReachEndRef.current();
  }, [targetSV, rateSV]);

  // ---- Jumps / gestures -----------------------------------------------------------

  /** Explicit jump (scrub, restart from 0, clamp after a trim). */
  const seekTo = useCallback(
    (time: number) => {
      if (__DEV__) console.log(`[nativeClock] seekTo -> ${time.toFixed(2)}s`);
      timeRef.current = time;
      targetSV.value = time;
      snapSV.value = snapSV.value + 1;
      setTimelineTime(time);
      void previewRef.current?.seekTo(time * 1000);
    },
    [previewRef, targetSV, snapSV],
  );

  /**
   * Stop the playhead RIGHT NOW because a gesture took over (scrub, pinch,
   * clip move/trim...). Call it together with setIsPlaying(false).
   */
  const halt = useCallback(() => {
    if (haltedRef.current) return;
    haltedRef.current = true;
    playingSV.value = false;
    rateSV.value = 0;
    targetSV.value = timeRef.current;
    void previewRef.current?.pause();
    if (__DEV__)
      console.log(
        `[nativeClock] halted by gesture @ ${timeRef.current.toFixed(2)}s`,
      );
  }, [previewRef, playingSV, rateSV, targetSV]);

  /** The clock's exact time now (not throttled). */
  const getTime = useCallback(() => timeRef.current, []);

  return {
    timelineTime,
    seekTo,
    playhead,
    stopTimeRef,
    halt,
    getTime,
    onTimeEvent,
    onPlaybackEvent,
    onEndedEvent,
  };
}
