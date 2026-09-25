import { Ionicons } from "@expo/vector-icons";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  runOnUI,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useTheme } from "../../hooks/useTheme";
import type { PlayheadSync } from "../../hooks/useTimelineClock";
import AppText from "../AppText";
import TimelineClipBox from "./TimelineClipBox";

const MIN_PIXELS_PER_SECOND = 20;
const MAX_PIXELS_PER_SECOND = 200;
// The editor opens fully zoomed out (the minimum zoom), so the user starts
// from the widest view and zooms in from there.
const INITIAL_PIXELS_PER_SECOND = MIN_PIXELS_PER_SECOND;

const TRACK_HEIGHT = 56;
const TRACK_GAP = 4;
const LEADING_WIDTH = 60;
const RULER_HEIGHT = 16;

const SUBDIVISION_THRESHOLD = 90;
const SUBDIVISIONS_PER_SECOND = 5;

const BUTTON_ZOOM_FACTOR = 1.25;
// The +/- buttons animate the zoom over this long instead of jumping.
const BUTTON_ZOOM_DURATION_MS = 220;

const MIN_RULER_LABEL_SPACING = 50;

const WAVEFORM_BAR_WIDTH = 2;
const WAVEFORM_BAR_GAP = 2;
const WAVEFORM_MIN_BARS = 20;

const TRIM_HANDLE_WIDTH = 14;
const MIN_TRIM_DURATION = 0.5;

// How long to wait after a drag release, with no fling, before treating the
// scrub as truly over. onEndDrag fires even for a still-finger release, and
// on its own that would immediately let the scroll-follow effect fight the
// scroll position back to the old playhead. If a fling/momentum actually
// starts within this window, onMomentumBegin cancels the timer and
// scrubbing continues until onMomentumEnd instead.
const SCRUB_END_GRACE_MS = 120;

// While the user scrubs (drags/flings the timeline), the new position is sent
// to the parent at most this often. The parent seeks the video player on
// each one, and on Android a player seek runs on the same main thread that
// draws the scroll — seeking on every scroll frame (~60x/s, on two players)
// is what made fast scrolling stutter and jump. ~12 updates/s is plenty for
// the preview picture to follow the finger. The exact final position is
// always sent when the scrub ends.
const SCRUB_DISPATCH_INTERVAL_MS = 80;

// Safety net for a fling whose onMomentumEnd never arrives (it can get lost
// on Android when a fling is interrupted). If a fling produces no scroll
// events for this long, it has stopped — end the scrub anyway, so
// `isScrubbing` can never get stuck on.
const MOMENTUM_IDLE_END_MS = 300;

// Right after a scrub ends, React can still deliver a re-render with an
// OLDER playhead time (a scrub update that was already on its way). The
// paused scroll-follow effect used to scroll the timeline back to that
// stale time — the "jump" after a fast fling. For this long after a scrub
// ends, the follow effect only accepts the exact final scrub position.
const POST_SCRUB_FOLLOW_GUARD_MS = 400;

// UI-thread playhead smoothing (see the frame callback in the component).
// If the UI-thread time drifts further than this from the clock's time, it
// jumps straight to it (a real jump, e.g. after a seek); below it, it eases
// back gently so the movement stays smooth.
const UI_SNAP_THRESHOLD = 0.3;
// Fraction of the remaining error corrected per frame.
const UI_CORRECTION = 0.08;

export type ClipSelection = "video" | "audio" | null;

export interface TrimRange {
  start: number;
  end: number;
}

interface EditorTimelineProps {
  clipLabel: string;
  // Timeline-space playhead position (seconds from timeline 0), not raw
  // source-video time — the parent screen owns the play/void clock and
  // passes this through during playback (throttled — the smooth per-frame
  // movement comes from `playhead` on the UI thread instead).
  currentTime: number;
  isPlaying: boolean;
  // Per-frame playhead info from useTimelineClock, read on the UI thread.
  playhead: PlayheadSync;
  duration: number;
  thumbnails: (string | null)[];
  selection: ClipSelection;
  audioLocked: boolean;
  videoTrim: TrimRange;
  audioTrim: TrimRange;
  videoOffset: number;
  audioOffset: number;
  onMutePress: () => void;
  onSelectClip: (clip: "video" | "audio") => void;
  onAddTextPress: () => void;
  onScrub: (time: number) => void;
  // Fired the moment the user touches the timeline to start dragging the
  // playhead — lets the parent pause playback (InShot-style) so the scrub
  // and the play clock aren't fighting over the same position.
  onScrubStart?: () => void;
  // Fired once the scrub is completely over (finger lifted with no fling,
  // or the fling settled) — right AFTER the exact final position was sent
  // through onScrub. The parent uses it to do the deferred audio seek.
  onScrubEnd?: () => void;
  // Fired when the user starts moving a clip (press-and-hold) or grabs a
  // trim handle — lets the parent pause playback, same as scrubbing.
  onClipGestureStart?: (kind: "move" | "trim") => void;
  // Fired when the user taps the zoom "+" / "-" buttons — lets the parent
  // pause playback, same as the other timeline interactions.
  onZoomButtonPress?: (direction: "in" | "out") => void;
  // Fired when a two-finger pinch-zoom actually starts — lets the parent
  // pause playback, same as the zoom buttons.
  onPinchZoomStart?: () => void;
  // Fired when the user taps an empty part of the timeline (the ruler, the
  // space before/after/between clips) — lets the parent clear the clip
  // selection, InShot-style.
  onEmptyAreaPress?: () => void;
  onClipChange: (
    which: "video" | "audio",
    update: { trim: TrimRange; offset: number },
  ) => void;
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatRulerLabel(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (safe < 60) {
    return `${safe}s`;
  }
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function clampWorklet(value: number, min: number, max: number): number {
  "worklet";
  return Math.max(min, Math.min(value, max));
}

function clampJS(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function clampToTrim(value: number, trim: TrimRange): number {
  return Math.max(trim.start, Math.min(value, trim.end));
}

const RulerMark = memo(function RulerMark({
  sec,
  pixelsPerSecondSV,
  showLabel,
  showSubdivisions,
  isLast,
  subdivisionOffsets,
  tickColor,
  labelColor,
}: {
  sec: number;
  pixelsPerSecondSV: SharedValue<number>;
  showLabel: boolean;
  showSubdivisions: boolean;
  isLast: boolean;
  subdivisionOffsets: number[];
  tickColor: string;
  labelColor: string;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    width: pixelsPerSecondSV.value,
  }));

  return (
    <Animated.View style={[styles.rulerMark, animatedStyle]}>
      {showLabel && (
        <AppText
          style={[styles.rulerLabel, { color: labelColor }]}
          numberOfLines={1}
        >
          {formatRulerLabel(sec)}
        </AppText>
      )}
      <View
        pointerEvents="none"
        style={[styles.secondTick, { backgroundColor: tickColor }]}
      />
      {showSubdivisions &&
        !isLast &&
        subdivisionOffsets.map((frac) => (
          <SubTick
            key={frac}
            frac={frac}
            pixelsPerSecondSV={pixelsPerSecondSV}
            color={tickColor}
          />
        ))}
    </Animated.View>
  );
});

function SubTick({
  frac,
  pixelsPerSecondSV,
  color,
}: {
  frac: number;
  pixelsPerSecondSV: SharedValue<number>;
  color: string;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    left: frac * pixelsPerSecondSV.value,
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.subTick, { backgroundColor: color }, animatedStyle]}
    />
  );
}

// Continuous pseudo-random amplitude as a function of TIME (seconds), not
// bar index — three blended sine frequencies so it looks like an audio
// envelope. The key property: the same moment in the clip always maps to
// the same amplitude regardless of zoom, and sampling it more densely (as
// you zoom in) reveals genuinely finer wiggle from the higher-frequency
// terms, instead of just appending generic bars at the edge.
function waveAmplitudeAtTime(t: number): number {
  const v =
    Math.sin(t * 2.7) * 0.5 +
    Math.sin(t * 5.3 + 1.7) * 0.3 +
    Math.sin(t * 11.9 + 0.4) * 0.2;
  return 0.08 + (v * 0.5 + 0.5) * 0.88;
}

// Bar count tracks the clip's actual pixel width (contentWidth, recomputed
// whenever zoom changes) at a fixed pitch — so each bar stays thin and the
// pattern gets denser as you zoom in. Each bar's height comes from sampling
// waveAmplitudeAtTime at that bar's real time position (derived from
// pixelsPerSecond), so zooming in reveals finer detail within the same
// waveform instead of just extending it.
// Wrapped in memo: during playback the timeline re-renders on every clock
// tick (currentTime changes), but the waveform only depends on zoom/width,
// so it can skip all of those re-renders instead of rebuilding hundreds of
// bar Views each time.
const WaveformBars = memo(function WaveformBars({
  color,
  contentWidth,
  pixelsPerSecond,
}: {
  color: string;
  contentWidth: number;
  pixelsPerSecond: number;
}) {
  const pitch = WAVEFORM_BAR_WIDTH + WAVEFORM_BAR_GAP;
  const count = Math.max(
    WAVEFORM_MIN_BARS,
    Math.ceil(contentWidth / pitch) + 4,
  );
  const secondsPerBar = pitch / pixelsPerSecond;

  const heights = useMemo(
    () =>
      Array.from({ length: count }, (_, i) =>
        waveAmplitudeAtTime(i * secondsPerBar),
      ),
    [count, secondsPerBar],
  );

  return (
    <View style={styles.waveformRow} pointerEvents="none">
      {heights.map((pct, i) => (
        <View
          key={i}
          style={[
            styles.waveformBar,
            { height: `${pct * 100}%`, backgroundColor: color },
          ]}
        />
      ))}
    </View>
  );
});

// memo for the same reason as WaveformBars — thumbnails never change during
// playback.
const ThumbnailTile = memo(function ThumbnailTile({
  uri,
  count,
  durationSV,
  pixelsPerSecondSV,
  placeholderColor,
}: {
  uri: string | null;
  count: number;
  durationSV: SharedValue<number>;
  pixelsPerSecondSV: SharedValue<number>;
  placeholderColor: string;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    width: (durationSV.value / count) * pixelsPerSecondSV.value,
  }));

  return (
    <Animated.View
      style={[
        styles.thumbTile,
        animatedStyle,
        { backgroundColor: placeholderColor },
      ]}
    >
      {uri && (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      )}
    </Animated.View>
  );
});

export default function EditorTimeline({
  clipLabel,
  currentTime,
  isPlaying,
  playhead,
  duration,
  thumbnails,
  selection,
  audioLocked,
  videoTrim,
  audioTrim,
  videoOffset,
  audioOffset,
  onMutePress,
  onSelectClip,
  onAddTextPress,
  onScrub,
  onScrubStart,
  onScrubEnd,
  onClipGestureStart,
  onZoomButtonPress,
  onPinchZoomStart,
  onEmptyAreaPress,
  onClipChange,
}: EditorTimelineProps) {
  const colors = useTheme();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();

  useEffect(() => {
    if (__DEV__) {
      console.log(
        `[EditorTimeline] mounted — starting fully zoomed out (${INITIAL_PIXELS_PER_SECOND}px/s)`,
      );
    }
  }, []);

  // Some events fire on every frame (scroll-follow during playback, raw
  // scroll events while scrubbing). Logging each one floods Metro and was
  // itself slowing the JS thread down (making playback look choppy in the
  // dev build), so those go through this: at most one log per `intervalMs`
  // per key.
  const logThrottleRef = useRef<Record<string, number>>({});
  const throttledLog = (
    key: string,
    intervalMs: number,
    ...args: unknown[]
  ) => {
    if (!__DEV__) return;
    const now = Date.now();
    const last = logThrottleRef.current[key] ?? 0;
    if (now - last < intervalMs) return;
    logThrottleRef.current[key] = now;
    console.log(...args);
  };

  const [trackAreaWidth, setTrackAreaWidth] = useState(0);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(
    INITIAL_PIXELS_PER_SECOND,
  );
  const [trimDragging, setTrimDragging] = useState(false);
  const [moveDragging, setMoveDragging] = useState(false);
  // True while a two-finger pinch-zoom is active. Turns the ScrollView's
  // own scrolling off so the fingers can't drag the timeline around while
  // the pinch is zooming it (the two fought each other every frame).
  const [pinchZooming, setPinchZooming] = useState(false);

  useEffect(() => {
    if (__DEV__) {
      console.log(
        `[EditorTimeline] timeline scrolling ${trimDragging || moveDragging || pinchZooming ? "LOCKED" : "enabled"} (trimDragging=${trimDragging}, moveDragging=${moveDragging}, pinchZooming=${pinchZooming})`,
      );
    }
  }, [trimDragging, moveDragging, pinchZooming]);

  const isScrubbing = useRef(false);
  const isPinching = useRef(false);
  // Tracks finger contact on a trim handle. A plain tap on a handle (no
  // drag) never activates its pan gesture, so the tap would otherwise fall
  // through to the "empty area" press below and deselect the clip you were
  // about to trim.
  const trimTouchRef = useRef({ active: false, lastEnd: 0 });
  const scrubEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True between onMomentumBegin and the fling settling. While true, a
  // finger-lift / onEndDrag must NOT end the scrub: on Android the
  // "finger lifted" signal often arrives AFTER the fling already started,
  // and ending the scrub there made the rest of the fling ignored and the
  // timeline snap back to an old position.
  const inMomentumRef = useRef(false);
  const momentumIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // When the last scrub ended, and the exact time it ended on — used to
  // ignore stale playhead values in the scroll-follow effect right after.
  const scrubEndedAtRef = useRef(0);
  const lastScrubSentTimeRef = useRef<number | null>(null);

  const pixelsPerSecondSV = useSharedValue(INITIAL_PIXELS_PER_SECOND);
  const gestureBasePPS = useSharedValue(INITIAL_PIXELS_PER_SECOND);
  // Pinch-zoom state, all on the UI thread:
  //   pinchActiveSV   — a real two-finger pinch is running (set in onStart;
  //                     onBegin can fire for a plain one-finger touch)
  //   pinchAnchorSV   — the playhead time when the pinch started; the zoom
  //                     is centred on it, so it stays under the playhead
  //   pinchTargetXSV  — the scroll position the pinch wants this frame; any
  //                     other scroll during the pinch is forced back to it
  const pinchActiveSV = useSharedValue(false);
  const pinchAnchorSV = useSharedValue(0);
  const pinchTargetXSV = useSharedValue(0);
  const pinchStartMsSV = useSharedValue(0);
  const pinchUpdatesSV = useSharedValue(0);
  // +/- button zoom, animated on the UI thread:
  //   zoomAnimatingSV — a button zoom animation is running; like a pinch,
  //                     it owns the scroll position while it runs
  //   zoomTargetPPSSV — where the running animation is heading, so quick
  //                     repeated taps stack (3 taps = 3 steps)
  //   zoomAnchorSV    — the playhead time the zoom is centred on
  const zoomAnimatingSV = useSharedValue(false);
  const zoomTargetPPSSV = useSharedValue(INITIAL_PIXELS_PER_SECOND);
  const zoomAnchorSV = useSharedValue(0);
  const playheadTimeSV = useSharedValue(0);
  const scrollX = useSharedValue(0);
  const durationSV = useSharedValue(0);
  const trackAreaWidthSV = useSharedValue(0);
  const trimStartSV = useSharedValue(0);
  const trimEndSV = useSharedValue(0);
  const trimDragBaseSV = useSharedValue(0);
  const offsetSV = useSharedValue(0);
  const offsetDragBaseSV = useSharedValue(0);
  const timelineDurationSV = useSharedValue(0);
  // Per-track timeline position, kept in sync with the committed
  // videoOffset/audioOffset props at rest (effects below), and written to
  // directly (UI thread, no React involved) while that track's clip box is
  // being press-and-held-moved — this is what makes the move as smooth as
  // the trim handles, which already work this way.
  const videoOffsetSV = useSharedValue(0);
  const audioOffsetSV = useSharedValue(0);
  // True while that track's clip box is currently held/being moved, purely
  // for the box's own "picked up" visual feedback (fade).
  const videoMovingSV = useSharedValue(false);
  const audioMovingSV = useSharedValue(false);
  // Guards against the ScrollView "stealing" a bit of horizontal drag in
  // the moment right before a press-and-hold move gesture activates (both
  // are reading the same finger motion, so without this the timeline can
  // visibly creep along with the clip you're dragging — a "magnet" feel).
  // While a move is active, any scroll event is immediately forced back to
  // the position captured the instant the hold began, on the UI thread, so
  // nothing the ScrollView does can sneak the timeline out from under you.
  const isMovingSV = useSharedValue(false);
  const scrollLockXSV = useSharedValue(0);
  // UI-thread mirrors of isScrubbing / isPinching, so the per-frame
  // playhead callback (and onScroll) can check them without touching JS.
  const isScrubbingSV = useSharedValue(false);
  const isPinchingSV = useSharedValue(false);
  // The playhead time as drawn by the UI thread while playing (owned by
  // the clock, so it can keep this exact position on pause), plus
  // bookkeeping for snaps and the once-per-second debug log.
  const uiTimeSV = playhead.uiTimeSV;
  const lastSnapSV = useSharedValue(-1);
  // Last clock value seen, and how long ago (seconds) it last changed. The
  // clock's time can arrive in steps (the video decoder reports its
  // position a few times per second), so the UI thread predicts where the
  // clock "really" is now (last value + time since it changed) instead of
  // pulling back toward a stale value between steps.
  const lastTargetSV = useSharedValue(0);
  const targetAgeSV = useSharedValue(0);
  const uiPerfWindowStartSV = useSharedValue(0);
  const uiPerfFramesSV = useSharedValue(0);

  const contentWidthSV = useDerivedValue(() =>
    Math.max(timelineDurationSV.value * pixelsPerSecondSV.value, 200),
  );
  const totalScrollWidthSV = useDerivedValue(
    () => LEADING_WIDTH + contentWidthSV.value + trackAreaWidthSV.value,
  );

  const safeDuration = duration > 0 ? duration : 0;
  // The video/audio clips can sit anywhere on the timeline (moved away from
  // 0, or trimmed shorter), which may make the overall project longer than
  // the source video itself — the ruler, scroll range and zoom all need to
  // span that full extent, not just the source video's own length. Source
  // duration (`safeDuration`/`durationSV`) is kept separately below, purely
  // to cap how far the trim handles can go (you can't trim past what the
  // video actually has).
  const timelineDuration = Math.max(
    safeDuration,
    videoOffset + (videoTrim.end - videoTrim.start),
    audioOffset + (audioTrim.end - audioTrim.start),
  );
  const contentWidth = Math.max(safeDuration * pixelsPerSecond, 200);
  const secondMarks = Array.from(
    { length: Math.ceil(timelineDuration) + 1 },
    (_, i) => i,
  );
  const showSubdivisions = pixelsPerSecond >= SUBDIVISION_THRESHOLD;
  // Stable array (same reference every render) so the memoized RulerMarks
  // don't re-render just because this got rebuilt.
  const subdivisionOffsets = useMemo(
    () =>
      Array.from(
        { length: SUBDIVISIONS_PER_SECOND - 1 },
        (_, i) => (i + 1) / SUBDIVISIONS_PER_SECOND,
      ),
    [],
  );
  const rulerLabelInterval = Math.max(
    1,
    Math.ceil(MIN_RULER_LABEL_SPACING / pixelsPerSecond),
  );

  // When audio is locked to the video (default), selecting either one
  // highlights both, since they move/trim together. Once a lock/unlock
  // button exists, flipping `audioLocked` to false makes these independent
  // with no other change needed here.
  const isVideoSelected =
    selection === "video" || (selection === "audio" && audioLocked);
  const isAudioSelected =
    selection === "audio" || (selection === "video" && audioLocked);

  // NOTE: the zoom's source of truth is pixelsPerSecondSV (UI thread);
  // `pixelsPerSecond` state is only its mirror for rendering, updated via
  // commitZoom when a pinch/zoom ends. There used to be an effect here
  // copying the state back into the shared value — with quick +/- taps, a
  // late commit from an earlier tap overwrote the running zoom animation
  // with an old zoom level (the timeline jumped and the playhead drifted).

  // The playhead's committed time, mirrored to the UI thread (a JS write,
  // so it's always current there). Zoom centres on this.
  useEffect(() => {
    playheadTimeSV.value = currentTime;
  }, [currentTime]);

  useEffect(() => {
    durationSV.value = safeDuration;
  }, [safeDuration]);

  useEffect(() => {
    timelineDurationSV.value = timelineDuration;
  }, [timelineDuration]);

  useEffect(() => {
    trackAreaWidthSV.value = trackAreaWidth;
  }, [trackAreaWidth]);

  useEffect(() => {
    videoOffsetSV.value = videoOffset;
  }, [videoOffset]);

  useEffect(() => {
    audioOffsetSV.value = audioOffset;
  }, [audioOffset]);

  // Follows the playhead (`currentTime`, in timeline space) whenever it
  // changes. During playback, editor.tsx re-renders this prop every frame
  // (it owns the play/void clock now, since a moved/trimmed clip can leave
  // gaps the video player itself has no concept of), so a single effect
  // here is enough to keep the scroll position in sync whether playing,
  // paused, or scrubbed — skipped only while the user's own gesture
  // (scrub drag or pinch) is actively driving the scroll instead.
  //
  // While PLAYING this effect does nothing: the UI-thread frame callback
  // below moves the timeline every frame instead (smooth, no React). This
  // effect handles everything else: paused, after a seek/scrub, zoom, and
  // the final position when playback stops.
  const logFollow = (time: number, x: number) => {
    throttledLog(
      "scroll-follow",
      1000,
      "[EditorTimeline] scroll-follow (paused, max 1 log/s)",
      {
        currentTime: time,
        x,
      },
    );
  };

  const followPlayhead = (time: number) => {
    "worklet";
    // A zoom owns the scroll position while it runs.
    if (zoomAnimatingSV.value || pinchActiveSV.value) return;
    const x = clampWorklet(
      time * pixelsPerSecondSV.value,
      0,
      contentWidthSV.value,
    );
    // Already there (the normal case right after a scrub or zoom) — don't
    // issue a redundant native scroll.
    if (Math.abs(scrollX.value - x) < 0.5) return;
    scrollTo(scrollRef, x, 0, false);
    scrollX.value = x;
    runOnJS(logFollow)(time, x);
  };

  // Was playback running on the previous run of the effect below? Used to
  // spot the exact render where playback stops.
  const wasPlayingRef = useRef(false);

  useEffect(() => {
    const justStopped = wasPlayingRef.current && !isPlaying;
    wasPlayingRef.current = isPlaying;
    if (isPlaying) return;
    // The render where playback stops still carries the last THROTTLED
    // playhead time (React only gets it every ~50ms, more when the JS
    // thread is busy), which can be ~0.2s behind where the timeline really
    // stopped. Scrolling to it made the timeline jump back and then forward
    // again on every pause. The clock has already written the exact stop
    // position to targetSV (its cleanup runs before this effect), and the
    // timeline is already sitting there — so skip this stale value; the
    // next render carries the exact time.
    if (justStopped) {
      const stopTime = playhead.targetSV.value;
      if (Math.abs(currentTime - stopTime) > 0.01) {
        if (__DEV__) {
          console.log(
            `[EditorTimeline] scroll-follow skipped — stale time ${currentTime.toFixed(2)}s on pause (stopped at ${stopTime.toFixed(2)}s)`,
          );
        }
        return;
      }
    }
    if (
      trackAreaWidth > 0 &&
      !isScrubbing.current &&
      !inMomentumRef.current &&
      !isPinching.current
    ) {
      // Just after a scrub: the scroll position the finger/fling left is
      // the truth. Ignore any playhead value that isn't the final scrub
      // position (it's a stale update still arriving from React).
      const sinceScrubEnd = Date.now() - scrubEndedAtRef.current;
      const finalScrubTime = lastScrubSentTimeRef.current;
      if (
        sinceScrubEnd < POST_SCRUB_FOLLOW_GUARD_MS &&
        finalScrubTime !== null &&
        Math.abs(currentTime - finalScrubTime) > 0.01
      ) {
        if (__DEV__) {
          console.log(
            `[EditorTimeline] scroll-follow skipped — stale time ${currentTime.toFixed(2)}s right after scrub (final ${finalScrubTime.toFixed(2)}s)`,
          );
        }
        return;
      }
      // Done on the UI thread, with the LIVE zoom level: the JS copy of the
      // zoom lags behind during/after a zoom animation, and scrolling with
      // it used to throw the timeline to the wrong place mid-zoom.
      runOnUI(followPlayhead)(currentTime);
    }
  }, [currentTime, isPlaying, trackAreaWidth]);

  const logUiPerf = (
    frames: number,
    windowMs: number,
    uiTime: number,
    target: number,
  ) => {
    if (__DEV__) {
      console.log(
        `[EditorTimeline] UI playhead (last ${Math.round(windowMs)}ms): ${frames} frames, ui ${uiTime.toFixed(2)}s vs clock ${target.toFixed(2)}s (diff ${(uiTime - target).toFixed(3)}s)`,
      );
    }
  };

  // Moves the timeline under the playhead on the UI thread, every screen
  // frame, while playing. It advances its own time by the frame duration
  // (when the clock says time is moving, rateSV = 1) and gently eases
  // toward the clock's authoritative time, so the motion is smooth even
  // when the JS thread or the video decoder only report time in steps.
  // Skipped while the user is scrubbing, pinching, or moving a clip.
  useFrameCallback((frame) => {
    "worklet";
    if (!playhead.playingSV.value) return;
    if (isScrubbingSV.value || isPinchingSV.value || isMovingSV.value) return;
    if (zoomAnimatingSV.value || pinchActiveSV.value) return;

    const target = playhead.targetSV.value;
    const rate = playhead.rateSV.value;
    const dtMs = frame.timeSincePreviousFrame ?? 16;
    const dt = Math.min(dtMs, 100) / 1000;
    let t = uiTimeSV.value;

    if (target !== lastTargetSV.value) {
      lastTargetSV.value = target;
      targetAgeSV.value = 0;
    } else {
      targetAgeSV.value = Math.min(targetAgeSV.value + dt, 0.5);
    }

    if (playhead.snapSV.value !== lastSnapSV.value) {
      lastSnapSV.value = playhead.snapSV.value;
      t = target;
      targetAgeSV.value = 0;
    } else {
      t += dt * rate;
      // Where the clock most likely is right now.
      const predicted = target + targetAgeSV.value * rate;
      const err = predicted - t;
      if (Math.abs(err) > UI_SNAP_THRESHOLD) {
        t = predicted;
      } else {
        t += err * UI_CORRECTION;
      }
    }
    if (t < 0) t = 0;
    uiTimeSV.value = t;

    const x = clampWorklet(
      t * pixelsPerSecondSV.value,
      0,
      contentWidthSV.value,
    );
    scrollTo(scrollRef, x, 0, false);
    scrollX.value = x;

    if (__DEV__) {
      // Start a fresh 1s window after an idle period (first play, or
      // resuming after a pause) so the log doesn't report a bogus
      // multi-second window with only a few frames.
      if (frame.timestamp - uiPerfWindowStartSV.value > 2000) {
        uiPerfWindowStartSV.value = frame.timestamp;
        uiPerfFramesSV.value = 0;
      }
      uiPerfFramesSV.value += 1;
      const elapsed = frame.timestamp - uiPerfWindowStartSV.value;
      if (elapsed >= 1000) {
        runOnJS(logUiPerf)(uiPerfFramesSV.value, elapsed, t, target);
        uiPerfWindowStartSV.value = frame.timestamp;
        uiPerfFramesSV.value = 0;
      }
    }
  });

  const onTrackAreaLayout = (e: LayoutChangeEvent) => {
    setTrackAreaWidth(e.nativeEvent.layout.width);
  };

  const clearScrubEndTimeout = () => {
    if (scrubEndTimeoutRef.current !== null) {
      clearTimeout(scrubEndTimeoutRef.current);
      scrubEndTimeoutRef.current = null;
    }
  };

  const clearMomentumIdleTimer = () => {
    if (momentumIdleTimerRef.current !== null) {
      clearTimeout(momentumIdleTimerRef.current);
      momentumIdleTimerRef.current = null;
    }
  };

  // The ONE place a scrub ends. Safe to call from any path (release timer,
  // fling settled, fling watchdog): it only does anything if a scrub is
  // actually active, so `finishScrub` (final seek + onScrubEnd) runs exactly
  // once per scrub. Before, a fling could end the scrub twice — once too
  // early (mid-fling) and again when it settled.
  const endScrub = (reason: string) => {
    clearScrubEndTimeout();
    clearMomentumIdleTimer();
    inMomentumRef.current = false;
    if (!isScrubbing.current) {
      if (__DEV__)
        console.log(
          `[EditorTimeline] scrub end ignored (${reason}) — no scrub active`,
        );
      return;
    }
    isScrubbing.current = false;
    isScrubbingSV.value = false;
    if (__DEV__) console.log(`[EditorTimeline] scrub end (${reason})`);
    finishScrub();
  };

  // Touch-down on the timeline: start scrubbing and tell the parent to
  // pause, so the play clock stops fighting the finger for the playhead
  // position (this is what "scrub to 0 then it snaps back" was — the
  // clock was still running and kept overwriting the scrub).
  // Touching the timeline during a fling stops the fling, so any momentum
  // state is cleared here too — a late onMomentumEnd from that interrupted
  // fling must not end this new drag.
  const beginScrubbing = () => {
    clearScrubEndTimeout();
    clearMomentumIdleTimer();
    inMomentumRef.current = false;
    const wasScrubbing = isScrubbing.current;
    isScrubbing.current = true;
    isScrubbingSV.value = true;
    if (__DEV__)
      console.log(
        `[EditorTimeline] scrub begin (pausing playback)${wasScrubbing ? " — caught a running fling" : ""}`,
      );
    if (!wasScrubbing) onScrubStart?.();
  };

  // Finger lifted with no fling — onEndDrag fires for this case, but so
  // does a release that DOES turn into a fling, and onMomentumBegin only
  // arrives a beat later. Wait a short grace period before actually ending
  // the scrub; onMomentumBegin cancels this if a fling shows up in time.
  // Without this, a still-finger release used to leave `isScrubbing` stuck
  // true forever (onMomentumEnd, the only other place it was cleared,
  // never fires without momentum) — that's the "playhead stops following
  // during playback" bug: the scroll-follow effect above skips every frame
  // while isScrubbing is true.
  //
  // If a fling is ALREADY running, do nothing: the fling ends the scrub
  // itself when it settles.
  const scheduleScrubEnd = () => {
    if (inMomentumRef.current) {
      if (__DEV__)
        console.log(
          "[EditorTimeline] release during fling — scrub keeps going",
        );
      return;
    }
    clearScrubEndTimeout();
    scrubEndTimeoutRef.current = setTimeout(() => {
      scrubEndTimeoutRef.current = null;
      if (inMomentumRef.current) return;
      endScrub("release, no fling");
    }, SCRUB_END_GRACE_MS);
  };

  // Restarts the fling watchdog (see MOMENTUM_IDLE_END_MS).
  const armMomentumIdleTimer = () => {
    clearMomentumIdleTimer();
    momentumIdleTimerRef.current = setTimeout(() => {
      momentumIdleTimerRef.current = null;
      if (inMomentumRef.current) endScrub("fling went quiet — watchdog");
    }, MOMENTUM_IDLE_END_MS);
  };

  // A fling started. Scrubbing must be ON for the fling's scroll events to
  // move the playhead — even if the release grace timer above already
  // fired (momentum can arrive a little late on some devices).
  const continueScrubbingIntoMomentum = () => {
    clearScrubEndTimeout();
    inMomentumRef.current = true;
    armMomentumIdleTimer();
    const wasScrubbing = isScrubbing.current;
    isScrubbing.current = true;
    isScrubbingSV.value = true;
    if (__DEV__) console.log("[EditorTimeline] scrub continues into fling");
    // The release grace timer already ended the scrub (late fling) — tell
    // the parent a scrub is active again.
    if (!wasScrubbing) onScrubStart?.();
  };

  // Finger lifted, reported by the gesture handler wrapping the ScrollView.
  // This is the reliable release signal: in the logs, the ScrollView's own
  // onEndDrag never fired once (the gesture handler wrapper swallows it),
  // so a drag released without a fling left `isScrubbing` stuck on and
  // the playhead would stop following the next time you pressed play.
  const handleFingerLifted = () => {
    if (__DEV__)
      console.log(
        `[EditorTimeline] finger lifted${inMomentumRef.current ? " (fling running — ignored)" : ""}`,
      );
    if (inMomentumRef.current) return;
    if (isScrubbing.current) scheduleScrubEnd();
  };

  const endScrubbingAfterMomentum = () => {
    if (!inMomentumRef.current) {
      // Stale momentum-end from a fling that a new touch already stopped —
      // the new drag owns the scrub now.
      if (__DEV__)
        console.log("[EditorTimeline] fling end ignored — not in a fling");
      return;
    }
    endScrub("fling settled");
  };

  useEffect(() => {
    return () => {
      clearScrubEndTimeout();
      clearMomentumIdleTimer();
    };
  }, []);

  const setIsPinching = (value: boolean) => {
    isPinching.current = value;
  };

  // Scrub positions are throttled to one every SCRUB_DISPATCH_INTERVAL_MS
  // (see that constant for why). The latest position always wins: anything
  // held back is sent by the pending timer, and `finishScrub` sends the
  // exact final position the moment the scrub ends.
  const pendingScrubTimeRef = useRef<number | null>(null);
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrubDispatchRef = useRef(0);

  const flushScrub = () => {
    if (scrubTimerRef.current !== null) {
      clearTimeout(scrubTimerRef.current);
      scrubTimerRef.current = null;
    }
    const time = pendingScrubTimeRef.current;
    pendingScrubTimeRef.current = null;
    if (time === null) return;
    lastScrubDispatchRef.current = Date.now();
    lastScrubSentTimeRef.current = time;
    throttledLog(
      "scrub-flush",
      250,
      "[EditorTimeline] onScrub (sent, max 4 logs/s)",
      {
        time,
      },
    );
    onScrub(time);
  };

  // Scrub fully over: send the exact final position right now (no
  // throttle), then tell the parent.
  function finishScrub() {
    const pending = pendingScrubTimeRef.current;
    flushScrub();
    // Start the post-scrub guard for the scroll-follow effect.
    scrubEndedAtRef.current = Date.now();
    if (__DEV__) {
      console.log(
        `[EditorTimeline] scrub finished${pending !== null ? ` — final position ${pending.toFixed(2)}s` : ""}`,
      );
    }
    onScrubEnd?.();
  }

  useEffect(() => {
    return () => {
      if (scrubTimerRef.current !== null) {
        clearTimeout(scrubTimerRef.current);
      }
    };
  }, []);

  const handleScrollUpdate = (offsetX: number, pps: number) => {
    if (!isScrubbing.current) return;
    // Every scroll event during a fling proves it's still moving.
    if (inMomentumRef.current) armMomentumIdleTimer();
    const time = clampJS(offsetX / pps, 0, timelineDuration);
    throttledLog(
      "scrub-raw",
      250,
      "[EditorTimeline] scroll (raw, max 4 logs/s)",
      {
        offsetX,
        time,
      },
    );
    pendingScrubTimeRef.current = time;
    const since = Date.now() - lastScrubDispatchRef.current;
    if (since >= SCRUB_DISPATCH_INTERVAL_MS) {
      flushScrub();
    } else if (scrubTimerRef.current === null) {
      scrubTimerRef.current = setTimeout(
        flushScrub,
        SCRUB_DISPATCH_INTERVAL_MS - since,
      );
    }
  };

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      if (isMovingSV.value) {
        // A clip move is in progress — pin the scroll position and ignore
        // whatever just moved it, so the timeline can never drift along
        // with the clip being dragged.
        scrollTo(scrollRef, scrollLockXSV.value, 0, false);
        scrollX.value = scrollLockXSV.value;
        return;
      }
      if (pinchActiveSV.value || zoomAnimatingSV.value) {
        // A zoom (pinch or +/- button) owns the scroll position: undo any
        // drag the fingers add, and never treat it as a scrub (no seeking
        // while zooming).
        if (Math.abs(event.contentOffset.x - pinchTargetXSV.value) > 0.5) {
          scrollTo(scrollRef, pinchTargetXSV.value, 0, false);
        }
        scrollX.value = pinchTargetXSV.value;
        return;
      }
      scrollX.value = event.contentOffset.x;
      // Only bother the JS thread when the user is actually scrubbing.
      // During playback the UI-thread callback scrolls every frame, and
      // each of those scrolls fires onScroll too — forwarding them all to
      // JS would just add work.
      if (!isScrubbingSV.value) return;
      // The zoom level goes along with the offset: the JS copy of the zoom
      // can lag behind the UI thread right after a pinch.
      runOnJS(handleScrollUpdate)(
        event.contentOffset.x,
        pixelsPerSecondSV.value,
      );
    },
    onBeginDrag: () => {
      // Set on the UI thread right away so the playhead callback stops
      // moving the timeline under the finger on this very frame.
      isScrubbingSV.value = true;
      runOnJS(beginScrubbing)();
    },
    onEndDrag: () => {
      runOnJS(scheduleScrubEnd)();
    },
    onMomentumBegin: () => {
      isScrubbingSV.value = true;
      runOnJS(continueScrubbingIntoMomentum)();
    },
    onMomentumEnd: () => {
      runOnJS(endScrubbingAfterMomentum)();
    },
  });

  const commitZoom = (finalPPS: number) => {
    setPixelsPerSecond(finalPPS);
  };

  const handlePinchZoomStart = () => {
    if (__DEV__)
      console.log("[EditorTimeline] pinch zoom started (pausing playback)");
    onPinchZoomStart?.();
  };

  // The moment the zoom should stay centred on: the playhead itself.
  //   - mid-scrub: where the finger has the timeline right now
  //   - playing:   where the playhead is drawn
  //   - paused:    the committed playhead time (NOT scrollX / zoom — the
  //                scroll position is rounded to whole pixels, and deriving
  //                the time from it drifted a little with every zoom step)
  const currentAnchorTime = () => {
    "worklet";
    let t: number;
    if (isScrubbingSV.value) {
      t = scrollX.value / pixelsPerSecondSV.value;
    } else if (playhead.playingSV.value) {
      t = uiTimeSV.value;
    } else {
      t = playheadTimeSV.value;
    }
    return clampWorklet(t, 0, timelineDurationSV.value);
  };

  const logPinch = (
    phase: "start" | "end",
    anchor: number,
    fromPPS: number,
    toPPS: number,
    updates: number,
    ms: number,
  ) => {
    if (!__DEV__) return;
    if (phase === "start") {
      console.log(
        `[EditorTimeline] pinch zoom start — centred on playhead @ ${anchor.toFixed(2)}s, ${fromPPS.toFixed(0)}px/s`,
      );
    } else {
      const fps = ms > 0 ? (updates * 1000) / ms : 0;
      console.log(
        `[EditorTimeline] pinch zoom end — ${fromPPS.toFixed(0)} → ${toPPS.toFixed(0)}px/s, ${updates} updates in ${Math.round(ms)}ms (~${fps.toFixed(0)}/s), playhead still @ ${anchor.toFixed(2)}s`,
      );
    }
  };

  // Pinch-zoom, CapCut/InShot-style: the timeline stretches around the
  // PLAYHEAD, which stays on the same moment the whole time — so nothing is
  // seeked during a pinch. Everything runs on the UI thread: the zoom level
  // (pixelsPerSecondSV) drives the ruler, clip boxes, thumbnails, waveform
  // and handles directly, and React is told the new zoom only ONCE, when
  // the fingers lift. Before, React re-rendered the whole timeline ~60x/s
  // during a pinch (and clip widths lagged behind the ruler), which is what
  // made it drop frames and jump.
  const pinchGesture = Gesture.Pinch()
    .onBegin(() => {
      isPinchingSV.value = true;
      runOnJS(setIsPinching)(true);
    })
    .onStart(() => {
      // onStart = two fingers really started pinching (onBegin above can
      // fire on a plain one-finger touch before the pinch is recognized,
      // and we don't want a normal tap/scroll to pause playback).
      // A pinch takes over from a running +/- animation (writing the zoom
      // below cancels it; its end callback then does nothing).
      zoomAnimatingSV.value = false;
      const basePPS = pixelsPerSecondSV.value;
      gestureBasePPS.value = basePPS;
      const anchor = currentAnchorTime();
      pinchAnchorSV.value = anchor;
      pinchTargetXSV.value = scrollX.value;
      pinchActiveSV.value = true;
      pinchStartMsSV.value = Date.now();
      pinchUpdatesSV.value = 0;
      runOnJS(setPinchZooming)(true);
      runOnJS(handlePinchZoomStart)();
      runOnJS(logPinch)("start", anchor, basePPS, basePPS, 0, 0);
    })
    .onUpdate((event) => {
      if (!pinchActiveSV.value) return;
      const newPPS = clampWorklet(
        gestureBasePPS.value * event.scale,
        MIN_PIXELS_PER_SECOND,
        MAX_PIXELS_PER_SECOND,
      );
      pixelsPerSecondSV.value = newPPS;

      const contentWidthNew = Math.max(timelineDurationSV.value * newPPS, 200);
      const x = clampWorklet(pinchAnchorSV.value * newPPS, 0, contentWidthNew);
      pinchTargetXSV.value = x;
      scrollTo(scrollRef, x, 0, false);
      scrollX.value = x;
      pinchUpdatesSV.value += 1;
    })
    .onFinalize(() => {
      // Runs for a finished pinch AND for a touch that never became one.
      if (pinchActiveSV.value) {
        pinchActiveSV.value = false;
        const finalPPS = pixelsPerSecondSV.value;
        runOnJS(commitZoom)(finalPPS);
        runOnJS(setPinchZooming)(false);
        runOnJS(logPinch)(
          "end",
          pinchAnchorSV.value,
          gestureBasePPS.value,
          finalPPS,
          pinchUpdatesSV.value,
          Date.now() - pinchStartMsSV.value,
        );
      }
      isPinchingSV.value = false;
      runOnJS(setIsPinching)(false);
    });

  const logButtonZoom = (
    phase: "start" | "done",
    fromPPS: number,
    toPPS: number,
    anchor: number,
  ) => {
    if (!__DEV__) return;
    console.log(
      phase === "start"
        ? `[EditorTimeline] zoom button — animating ${fromPPS.toFixed(0)} → ${toPPS.toFixed(0)}px/s around playhead @ ${anchor.toFixed(2)}s`
        : `[EditorTimeline] zoom button — done @ ${toPPS.toFixed(0)}px/s`,
    );
  };

  // While a +/- zoom animates, keep the playhead's moment exactly under
  // the playhead: every animation frame, scroll to anchor × current zoom.
  // Runs on the UI thread, in the same frame as the zoom change itself.
  useAnimatedReaction(
    () => pixelsPerSecondSV.value,
    (pps) => {
      if (!zoomAnimatingSV.value) return;
      const contentWidthNew = Math.max(timelineDurationSV.value * pps, 200);
      const x = clampWorklet(zoomAnchorSV.value * pps, 0, contentWidthNew);
      pinchTargetXSV.value = x;
      scrollTo(scrollRef, x, 0, false);
      scrollX.value = x;
    },
  );

  // +/- buttons: a short, eased zoom animation centred on the playhead,
  // same as a pinch — instead of jumping straight to the new zoom (React
  // re-render first, scroll correction a frame later, which is what looked
  // choppy). React is told the new zoom once, when the animation ends.
  // Quick repeated taps stack: each tap zooms one more step from where the
  // running animation is heading.
  const zoomWithButton = (direction: "in" | "out") => {
    if (__DEV__)
      console.log(
        `[EditorTimeline] zoom ${direction} button pressed (pausing playback)`,
      );
    // Pause first, even if the zoom itself turns out to be a no-op (already
    // at min/max zoom) — the tap still means "I'm editing now".
    onZoomButtonPress?.(direction);

    if (trackAreaWidth <= 0 || timelineDuration <= 0) return;

    const factor =
      direction === "in" ? BUTTON_ZOOM_FACTOR : 1 / BUTTON_ZOOM_FACTOR;
    // Everything below runs on the UI thread. It has to: the scroll
    // position (and so the playhead's moment) is written there by the
    // scroll handler, and reading it from JS returned an OLD value — the
    // first "+" after a scrub used to zoom around 0s instead of the
    // playhead, then snap back.
    runOnUI(startButtonZoom)(factor, direction);
  };

  const logZoomLimit = (direction: "in" | "out") => {
    if (__DEV__)
      console.log(
        `[EditorTimeline] zoom button — already at ${direction === "in" ? "max" : "min"} zoom`,
      );
  };

  const startButtonZoom = (factor: number, direction: "in" | "out") => {
    "worklet";
    const animating = zoomAnimatingSV.value;
    const fromPPS = animating ? zoomTargetPPSSV.value : pixelsPerSecondSV.value;
    const toPPS = clampWorklet(
      fromPPS * factor,
      MIN_PIXELS_PER_SECOND,
      MAX_PIXELS_PER_SECOND,
    );
    if (Math.abs(toPPS - fromPPS) < 0.001) {
      runOnJS(logZoomLimit)(direction);
      return;
    }

    if (!animating) {
      // The moment under the playhead right now; it stays there.
      zoomAnchorSV.value = currentAnchorTime();
      pinchTargetXSV.value = scrollX.value;
    }
    zoomTargetPPSSV.value = toPPS;
    zoomAnimatingSV.value = true;
    runOnJS(logButtonZoom)("start", fromPPS, toPPS, zoomAnchorSV.value);

    pixelsPerSecondSV.value = withTiming(
      toPPS,
      {
        duration: BUTTON_ZOOM_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      },
      (finished) => {
        // `finished` is false when a newer tap (or a pinch) took over —
        // that one will commit instead.
        if (!finished) return;
        zoomAnimatingSV.value = false;
        runOnJS(commitZoom)(toPPS);
        runOnJS(logButtonZoom)("done", toPPS, toPPS, zoomAnchorSV.value);
      },
    );
  };

  const tracksBlockHeight = RULER_HEIGHT + TRACK_HEIGHT * 3 + TRACK_GAP * 3;

  // One panel top offset per track row (video, audio, text) — rows are
  // stacked vertically with a TRACK_GAP margin above each one, so row i's
  // top is RULER_HEIGHT + i*TRACK_HEIGHT + (i+1)*TRACK_GAP.
  const trackPanelTops = [0, 1, 2].map(
    (i) => RULER_HEIGHT + i * TRACK_HEIGHT + (i + 1) * TRACK_GAP,
  );

  // Trim handle geometry. Locked: one shared handle pair spanning from the
  // top of the video row to the bottom of the audio row, using the video
  // clip's trim range (and writing back to both video+audio, since they cut
  // together). Unlocked: handles appear only on whichever single track is
  // selected, using — and writing back to — that track's own trim range.
  const showHandles = selection === "video" || selection === "audio";
  let handleTop = 0;
  let handleHeight = 0;
  let handleTrim: TrimRange = videoTrim;
  let handleOffset = videoOffset;
  let trimTargetKind: "video" | "audio" = "video";

  if (showHandles) {
    if (audioLocked) {
      handleTop = trackPanelTops[0];
      handleHeight = trackPanelTops[1] + TRACK_HEIGHT - trackPanelTops[0];
      handleTrim = videoTrim;
      handleOffset = videoOffset;
      trimTargetKind = "video";
    } else if (selection === "video") {
      handleTop = trackPanelTops[0];
      handleHeight = TRACK_HEIGHT;
      handleTrim = videoTrim;
      handleOffset = videoOffset;
      trimTargetKind = "video";
    } else {
      handleTop = trackPanelTops[1];
      handleHeight = TRACK_HEIGHT;
      handleTrim = audioTrim;
      handleOffset = audioOffset;
      trimTargetKind = "audio";
    }
  }

  // Keep the shared values (which drive the handles every frame while
  // dragging) synced to the latest committed trim range + timeline
  // position. This also fires right after our own onEnd commit below, but
  // with the same value, so it never causes a visible jump.
  useEffect(() => {
    trimStartSV.value = handleTrim.start;
    trimEndSV.value = handleTrim.end;
    offsetSV.value = handleOffset;
  }, [handleTrim.start, handleTrim.end, handleOffset]);

  // A clip move (after the long-press) or a trim-handle drag just started.
  // Tell the parent so it can pause playback — editing a clip while the
  // preview keeps playing underneath it made the players fight the edit.
  const handleClipGestureStart = (kind: "move" | "trim") => {
    if (__DEV__)
      console.log(`[EditorTimeline] clip ${kind} started (pausing playback)`);
    onClipGestureStart?.(kind);
  };

  const markTrimTouch = (active: boolean) => {
    trimTouchRef.current.active = active;
    if (!active) trimTouchRef.current.lastEnd = Date.now();
  };

  // Tap on an empty part of the timeline (ruler, space before/after/between
  // clips). Taps on a clip hit the clip's own touchable first, and scrolls
  // cancel the press, so this only fires for a real tap on empty space.
  const handleEmptyAreaPress = () => {
    const touch = trimTouchRef.current;
    if (touch.active || Date.now() - touch.lastEnd < 300) {
      if (__DEV__)
        console.log(
          "[EditorTimeline] tap was on a trim handle — keeping selection",
        );
      return;
    }
    if (__DEV__) console.log("[EditorTimeline] empty timeline area tapped");
    onEmptyAreaPress?.();
  };

  const commitClip = (
    target: "video" | "audio",
    start: number,
    end: number,
    offset: number,
  ) => {
    if (__DEV__) {
      console.log("[EditorTimeline] commitClip", {
        target,
        start,
        end,
        offset,
      });
    }
    onClipChange(target, { trim: { start, end }, offset });
  };

  // Dragging the left handle shortens the clip from the front — the clip's
  // timeline position (offset) shifts by the same amount as trim.start, so
  // the clip's far/right edge stays put and only the near/left edge slides
  // in, like a normal trim rather than the whole clip jumping around.
  const leftHandlePan = Gesture.Pan()
    // Lopsided on purpose: generous to the left (outside the clip, easy to
    // grab the handle) but barely any padding to the right (into the clip
    // body), so pressing the clip itself near this edge to start a move
    // reliably goes to the clip's own move gesture instead of getting
    // stolen by the handle.
    .hitSlop({ left: 16, right: 3, top: 12, bottom: 12 })
    .onBegin(() => {
      trimDragBaseSV.value = trimStartSV.value;
      offsetDragBaseSV.value = offsetSV.value;
      runOnJS(markTrimTouch)(true);
      runOnJS(handleClipGestureStart)("trim");
    })
    .onStart(() => {
      // Only lock the ScrollView once the handle is really being dragged
      // (same reason as the clip move gesture's onStart).
      runOnJS(setTrimDragging)(true);
    })
    .onUpdate((event) => {
      const next = clampWorklet(
        trimDragBaseSV.value + event.translationX / pixelsPerSecondSV.value,
        0,
        trimEndSV.value - MIN_TRIM_DURATION,
      );
      const delta = next - trimDragBaseSV.value;
      trimStartSV.value = next;
      offsetSV.value = offsetDragBaseSV.value + delta;
    })
    .onEnd(() => {
      runOnJS(commitClip)(
        trimTargetKind,
        trimStartSV.value,
        trimEndSV.value,
        offsetSV.value,
      );
    })
    .onFinalize(() => {
      runOnJS(setTrimDragging)(false);
      runOnJS(markTrimTouch)(false);
    });

  const rightHandlePan = Gesture.Pan()
    // Mirror of the left handle's lopsided hitSlop above.
    .hitSlop({ left: 3, right: 16, top: 12, bottom: 12 })
    .onBegin(() => {
      trimDragBaseSV.value = trimEndSV.value;
      runOnJS(markTrimTouch)(true);
      runOnJS(handleClipGestureStart)("trim");
    })
    .onStart(() => {
      runOnJS(setTrimDragging)(true);
    })
    .onUpdate((event) => {
      const next = clampWorklet(
        trimDragBaseSV.value + event.translationX / pixelsPerSecondSV.value,
        trimStartSV.value + MIN_TRIM_DURATION,
        durationSV.value,
      );
      trimEndSV.value = next;
    })
    .onEnd(() => {
      runOnJS(commitClip)(
        trimTargetKind,
        trimStartSV.value,
        trimEndSV.value,
        offsetSV.value,
      );
    })
    .onFinalize(() => {
      runOnJS(setTrimDragging)(false);
      runOnJS(markTrimTouch)(false);
    });

  // Press-and-hold on a clip body to move it along the timeline (changes
  // only `offset`, not the trim range). While the finger is down, the box
  // is repositioned purely on the UI thread (videoOffsetSV/audioOffsetSV,
  // written straight from the worklet below) — exactly like the trim
  // handles already do — so it tracks the finger smoothly with no React
  // re-renders in between. The committed `offset` state (what the rest of
  // the app — playhead mapping, void detection, etc. — actually reads)
  // only updates once, on release. Locked: moving either clip moves both
  // together, mirrored live during the drag and committed together too. A
  // short hold delay (activateAfterLongPress) means a quick tap still
  // falls through to the label's TouchableOpacity for selection instead of
  // starting a move.
  const commitMove = (kind: "video" | "audio", offset: number) => {
    const trim = kind === "video" ? videoTrim : audioTrim;
    if (__DEV__) {
      console.log("[EditorTimeline] commitMove", { kind, offset, trim });
    }
    onClipChange(kind, { trim, offset: Math.max(0, offset) });
  };

  const logMoveCancelled = (kind: "video" | "audio") => {
    if (__DEV__)
      console.log(
        `[EditorTimeline] clip move cancelled (${kind}) — restored position`,
      );
  };

  const makeMoveGesture = (kind: "video" | "audio") => {
    const trackOffsetSV = kind === "video" ? videoOffsetSV : audioOffsetSV;
    const trackMovingSV = kind === "video" ? videoMovingSV : audioMovingSV;
    const mirrorOffsetSV = kind === "video" ? audioOffsetSV : videoOffsetSV;
    const startOffset = kind === "video" ? videoOffset : audioOffset;
    const mirrorStartOffset = kind === "video" ? audioOffset : videoOffset;
    const locked = audioLocked;
    // Do the trim handles sit on the clip being moved (or on its locked
    // mirror)? If so they have to slide along with it during the drag.
    // `handlesOnThisClip` = handles belong to the dragged clip itself;
    // `handlesOnMirror` = locked mode, handles belong to the OTHER clip,
    // which is being moved along with this one.
    const handlesOnThisClip = showHandles && trimTargetKind === kind;
    const handlesOnMirror = showHandles && locked && trimTargetKind !== kind;
    const handleStartOffset = handleOffset;

    return Gesture.Pan()
      .activateAfterLongPress(180)
      .onBegin(() => {
        trackMovingSV.value = true;
        // Lock the scroll to wherever it happens to be right now, before
        // the drag can nudge it at all.
        isMovingSV.value = true;
        scrollLockXSV.value = scrollX.value;
        // NOTE: `moveDragging` (which turns the ScrollView's scrolling OFF)
        // is NOT set here any more. onBegin fires on every touch-down on a
        // clip — including the start of a normal timeline scroll — and
        // disabling the ScrollView there made it drop the scroll the user
        // had just started ("stuck, doesn't move"). It's set in onStart
        // below, once the long-press has really turned into a move.
      })
      .onStart(() => {
        // onStart = the long-press actually activated the move (onBegin
        // above fires on touch-down, even for a quick tap to select).
        runOnJS(setMoveDragging)(true);
        runOnJS(handleClipGestureStart)("move");
      })
      .onUpdate((event) => {
        const next = Math.max(
          0,
          startOffset + event.translationX / pixelsPerSecondSV.value,
        );
        trackOffsetSV.value = next;
        let mirrorNext = mirrorStartOffset;
        if (locked) {
          mirrorNext = Math.max(
            0,
            mirrorStartOffset + event.translationX / pixelsPerSecondSV.value,
          );
          mirrorOffsetSV.value = mirrorNext;
        }
        // Keep the trim handles glued to the clip while it's being dragged
        // (before, they only jumped to the new spot after the finger lifted,
        // because they read `offsetSV`, which only updated on commit).
        if (handlesOnThisClip) {
          offsetSV.value = next;
        } else if (handlesOnMirror) {
          offsetSV.value = mirrorNext;
        }
      })
      .onEnd((event) => {
        const next = Math.max(
          0,
          startOffset + event.translationX / pixelsPerSecondSV.value,
        );
        runOnJS(commitMove)(kind, next);
      })
      .onFinalize((_event, success) => {
        trackMovingSV.value = false;
        isMovingSV.value = false;
        // `success` is also false for a quick tap that never became a move
        // (that's how the tap falls through to "select clip"), so only
        // restore if the clip actually got dragged somewhere.
        if (!success && trackOffsetSV.value !== startOffset) {
          // The move was cancelled (e.g. interrupted by the system) — no
          // commit will happen, so put the clip(s) and the trim handles
          // back where they were instead of leaving them half-dragged.
          trackOffsetSV.value = startOffset;
          if (locked) mirrorOffsetSV.value = mirrorStartOffset;
          if (handlesOnThisClip || handlesOnMirror) {
            offsetSV.value = handleStartOffset;
          }
          runOnJS(logMoveCancelled)(kind);
        }
        runOnJS(setMoveDragging)(false);
      });
  };

  const videoMoveGesture = makeMoveGesture("video");
  const audioMoveGesture = makeMoveGesture("audio");

  // The ScrollView's own built-in pan-to-scroll normally races the clip
  // move/trim gestures for the same touch — both are free to start
  // recognizing off the exact same finger-down event. That race is the
  // real cause of the timeline "stealing" part of a move/trim (scrolling,
  // or worse, feeding the raw scroll offset into the scrub/seek path and
  // dragging the playhead along with it) — not anything in the trim/offset
  // logic itself, and not something a post-hoc lock (isMovingSV below) can
  // fully close, since a few scroll/scrub events can still land in the
  // gap before that lock engages. Wrapping the ScrollView's native pan as
  // its own gesture and making it explicitly wait for all four
  // move/trim gestures to fail first means it genuinely cannot start
  // scrolling — so it cannot scrub the playhead either — until we're sure
  // the touch wasn't one of those. A normal scroll fling still works
  // exactly as before, since those gestures fail out almost immediately
  // for a touch that isn't held on a clip or a handle.
  const scrollNativeGesture = Gesture.Native()
    .requireExternalGestureToFail(
      videoMoveGesture,
      audioMoveGesture,
      leftHandlePan,
      rightHandlePan,
    )
    .onFinalize(() => {
      runOnJS(handleFingerLifted)();
    });

  // Handles sit at the clip box's actual left/right edges — left edge is
  // always the offset (timeline position), right edge is offset + the
  // clip's (trimmed) length.
  const leftHandleStyle = useAnimatedStyle(() => ({
    left:
      LEADING_WIDTH +
      offsetSV.value * pixelsPerSecondSV.value -
      TRIM_HANDLE_WIDTH / 2,
    top: handleTop,
    height: handleHeight,
  }));

  const rightHandleStyle = useAnimatedStyle(() => ({
    left:
      LEADING_WIDTH +
      (offsetSV.value + (trimEndSV.value - trimStartSV.value)) *
        pixelsPerSecondSV.value -
      TRIM_HANDLE_WIDTH / 2,
    top: handleTop,
    height: handleHeight,
  }));

  // The full source video laid out behind each clip box (thumbnails /
  // waveform), shifted left by the trim-in point. Driven by the UI-thread
  // zoom so it keeps up with a pinch frame by frame.
  const videoTrimStart = videoTrim.start;
  const audioTrimStart = audioTrim.start;
  const videoSourceWindowStyle = useAnimatedStyle(() => ({
    left: -videoTrimStart * pixelsPerSecondSV.value,
    width: Math.max(safeDuration * pixelsPerSecondSV.value, 200),
  }));
  const audioSourceWindowStyle = useAnimatedStyle(() => ({
    left: -audioTrimStart * pixelsPerSecondSV.value,
    width: Math.max(safeDuration * pixelsPerSecondSV.value, 200),
  }));
  // The waveform bars are built for the last zoom React knows about; during
  // a pinch they're stretched to the live zoom (and rebuilt crisp once the
  // fingers lift), instead of rebuilding hundreds of bars every frame.
  const committedPPS = pixelsPerSecond;
  const waveformStretchStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: pixelsPerSecondSV.value / committedPPS }],
  }));

  const outerRowStyle = useAnimatedStyle(() => ({
    width: totalScrollWidthSV.value,
  }));
  const contentBlockStyle = useAnimatedStyle(() => ({
    width: contentWidthSV.value,
  }));
  const trackWidthStyle = useAnimatedStyle(() => ({
    width: contentWidthSV.value,
  }));

  return (
    <View style={styles.root}>
      <View
        style={[styles.topControlRow, { backgroundColor: colors.background }]}
      >
        <AppText style={[styles.counterText, { color: colors.textPrimary }]}>
          {formatTime(currentTime)} / {formatTime(timelineDuration)}
        </AppText>

        <View style={styles.zoomButtons}>
          <TouchableOpacity
            activeOpacity={0.7}
            style={[
              styles.zoomButton,
              {
                backgroundColor: colors.surface,
                borderColor: colors.iconInactive,
              },
            ]}
            onPress={() => zoomWithButton("out")}
          >
            <Ionicons name="remove" size={18} color={colors.textPrimary} />
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.7}
            style={[
              styles.zoomButton,
              {
                backgroundColor: colors.surface,
                borderColor: colors.iconInactive,
              },
            ]}
            onPress={() => zoomWithButton("in")}
          >
            <Ionicons name="add" size={18} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
      </View>

      <View
        style={[styles.trackArea, { height: tracksBlockHeight }]}
        onLayout={onTrackAreaLayout}
      >
        {trackAreaWidth > 0 && (
          <GestureDetector gesture={pinchGesture}>
            <View>
              <GestureDetector gesture={scrollNativeGesture}>
                <Animated.ScrollView
                  ref={scrollRef}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  scrollEventThrottle={16}
                  onScroll={scrollHandler}
                  scrollEnabled={
                    !trimDragging && !moveDragging && !pinchZooming
                  }
                >
                  <Pressable onPress={handleEmptyAreaPress}>
                    <Animated.View style={[styles.outerRow, outerRowStyle]}>
                      {trackPanelTops.map((top, i) => (
                        <View
                          key={i}
                          pointerEvents="none"
                          style={[
                            styles.trackPanel,
                            {
                              top,
                              left: LEADING_WIDTH,
                              backgroundColor: colors.surface,
                            },
                          ]}
                        />
                      ))}

                      <View style={{ width: LEADING_WIDTH }}>
                        <View style={{ height: RULER_HEIGHT + TRACK_GAP }} />
                        <TouchableOpacity
                          style={[styles.muteButton, { height: TRACK_HEIGHT }]}
                          onPress={onMutePress}
                        >
                          <View
                            style={[
                              styles.sideIconWrap,
                              { backgroundColor: colors.surface },
                            ]}
                          >
                            <Ionicons
                              name="volume-mute-outline"
                              size={18}
                              color={colors.textPrimary}
                            />
                          </View>
                        </TouchableOpacity>
                      </View>

                      <Animated.View style={contentBlockStyle}>
                        <View style={styles.rulerRow}>
                          {secondMarks.map((sec) => (
                            <RulerMark
                              key={sec}
                              sec={sec}
                              pixelsPerSecondSV={pixelsPerSecondSV}
                              showLabel={sec % rulerLabelInterval === 0}
                              showSubdivisions={showSubdivisions}
                              isLast={sec === secondMarks.length - 1}
                              subdivisionOffsets={subdivisionOffsets}
                              tickColor={colors.iconInactive}
                              labelColor={colors.textMuted}
                            />
                          ))}
                        </View>

                        <TimelineClipBox
                          slotHeight={TRACK_HEIGHT}
                          slotMarginTop={TRACK_GAP}
                          offsetSV={videoOffsetSV}
                          pixelsPerSecondSV={pixelsPerSecondSV}
                          lengthSeconds={videoTrim.end - videoTrim.start}
                          selected={isVideoSelected}
                          backgroundColor={colors.background}
                          selectedBorderColor={colors.accentPurple}
                          inactiveBorderColor={colors.iconInactive}
                          labelIcon="film-outline"
                          labelText={clipLabel}
                          onPress={() => onSelectClip("video")}
                          moveGesture={videoMoveGesture}
                          movingSV={videoMovingSV}
                        >
                          {thumbnails.length > 0 && (
                            <Animated.View
                              style={[
                                styles.thumbLayer,
                                videoSourceWindowStyle,
                              ]}
                              pointerEvents="none"
                            >
                              {thumbnails.map((uri, i) => (
                                <ThumbnailTile
                                  key={i}
                                  uri={uri}
                                  count={thumbnails.length}
                                  durationSV={durationSV}
                                  pixelsPerSecondSV={pixelsPerSecondSV}
                                  placeholderColor={colors.background}
                                />
                              ))}
                            </Animated.View>
                          )}
                        </TimelineClipBox>

                        <TimelineClipBox
                          slotHeight={TRACK_HEIGHT}
                          slotMarginTop={TRACK_GAP}
                          offsetSV={audioOffsetSV}
                          pixelsPerSecondSV={pixelsPerSecondSV}
                          lengthSeconds={audioTrim.end - audioTrim.start}
                          selected={isAudioSelected}
                          backgroundColor={colors.background}
                          selectedBorderColor={colors.accentPurple}
                          inactiveBorderColor={colors.iconInactive}
                          labelIcon="musical-notes-outline"
                          labelText="Original audio"
                          onPress={() => onSelectClip("audio")}
                          moveGesture={audioMoveGesture}
                          movingSV={audioMovingSV}
                        >
                          <Animated.View
                            style={[
                              styles.waveformWindow,
                              audioSourceWindowStyle,
                            ]}
                            pointerEvents="none"
                          >
                            <Animated.View
                              style={[
                                styles.waveformStretch,
                                waveformStretchStyle,
                              ]}
                            >
                              <WaveformBars
                                color={colors.iconInactive}
                                contentWidth={contentWidth}
                                pixelsPerSecond={pixelsPerSecond}
                              />
                            </Animated.View>
                          </Animated.View>
                        </TimelineClipBox>

                        <Animated.View
                          style={[styles.emptyTrackRow, trackWidthStyle]}
                        >
                          <TouchableOpacity
                            style={styles.trackRowTouchable}
                            onPress={onAddTextPress}
                          >
                            <Ionicons
                              name="add"
                              size={16}
                              color={colors.textMuted}
                            />
                            <AppText
                              style={[
                                styles.trackLabel,
                                { color: colors.textMuted },
                              ]}
                            >
                              Add text
                            </AppText>
                          </TouchableOpacity>
                        </Animated.View>
                      </Animated.View>

                      {showHandles && (
                        <>
                          <GestureDetector gesture={leftHandlePan}>
                            <Animated.View
                              style={[
                                styles.trimHandle,
                                leftHandleStyle,
                                { backgroundColor: colors.accentPurple },
                              ]}
                            >
                              <View style={styles.trimHandleGrip} />
                            </Animated.View>
                          </GestureDetector>

                          <GestureDetector gesture={rightHandlePan}>
                            <Animated.View
                              style={[
                                styles.trimHandle,
                                rightHandleStyle,
                                { backgroundColor: colors.accentPurple },
                              ]}
                            >
                              <View style={styles.trimHandleGrip} />
                            </Animated.View>
                          </GestureDetector>
                        </>
                      )}
                    </Animated.View>
                  </Pressable>
                </Animated.ScrollView>
              </GestureDetector>

              <View
                pointerEvents="none"
                style={[
                  styles.playhead,
                  {
                    left: LEADING_WIDTH - 1,
                    height: tracksBlockHeight,
                    backgroundColor: colors.textPrimary,
                  },
                ]}
              />
            </View>
          </GestureDetector>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 16 },
  topControlRow: {
    height: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  counterText: { fontSize: 11, fontFamily: "Poppins-Medium" },
  zoomButtons: { flexDirection: "row", alignItems: "center", gap: 6 },
  zoomButton: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  trackArea: { width: "100%" },
  outerRow: { flexDirection: "row" },
  trackPanel: {
    position: "absolute",
    right: 0,
    height: TRACK_HEIGHT,
  },
  rulerRow: { flexDirection: "row", height: RULER_HEIGHT, overflow: "visible" },
  rulerMark: { position: "relative", overflow: "visible" },
  rulerLabel: { fontSize: 10 },
  secondTick: { position: "absolute", left: 0, bottom: 0, width: 1, height: 7 },
  subTick: { position: "absolute", bottom: 0, width: 1, height: 5 },
  trimHandle: {
    position: "absolute",
    width: TRIM_HANDLE_WIDTH,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  trimHandleGrip: {
    width: 3,
    height: 18,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.85)",
  },
  // Empty-state placeholder row (e.g. "Add text" before any text is
  // added) — flat, no border/box, so it doesn't read as an existing clip.
  emptyTrackRow: {
    height: TRACK_HEIGHT,
    marginTop: TRACK_GAP,
  },
  // Note: left and width are always set inline (windowed to the trim
  // range), so no default left/right/width here.
  thumbLayer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    flexDirection: "row",
  },
  thumbTile: {
    height: "100%",
    overflow: "hidden",
  },
  // Windowing wrapper for the waveform, positioned/sized inline the same
  // way as thumbLayer above.
  waveformWindow: {
    position: "absolute",
    top: 0,
    bottom: 0,
  },
  waveformStretch: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    transformOrigin: "left center",
  },
  waveformRow: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 6,
    gap: WAVEFORM_BAR_GAP,
    overflow: "hidden",
  },
  waveformBar: {
    width: WAVEFORM_BAR_WIDTH,
    minHeight: 2,
    borderRadius: 1,
    opacity: 0.9,
  },
  trackRowTouchable: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  trackLabel: { fontSize: 12, flex: 1 },
  playhead: { position: "absolute", top: 0, width: 2 },
  muteButton: { alignItems: "center", justifyContent: "center" },
  sideIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
});
