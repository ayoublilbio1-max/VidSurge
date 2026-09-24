import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
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
  runOnJS,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useTheme } from "../../hooks/useTheme";
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

const ZOOM_DISPATCH_INTERVAL_MS = 16;
const BUTTON_ZOOM_FACTOR = 1.25;

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

export type ClipSelection = "video" | "audio" | null;

export interface TrimRange {
  start: number;
  end: number;
}

interface EditorTimelineProps {
  clipLabel: string;
  // Timeline-space playhead position (seconds from timeline 0), not raw
  // source-video time — the parent screen owns the play/void clock and
  // passes this through every frame during playback.
  currentTime: number;
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

function RulerMark({
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
}

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
function WaveformBars({
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
}

function ThumbnailTile({
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
}

export default function EditorTimeline({
  clipLabel,
  currentTime,
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

  const [trackAreaWidth, setTrackAreaWidth] = useState(0);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(
    INITIAL_PIXELS_PER_SECOND,
  );
  const [trimDragging, setTrimDragging] = useState(false);
  const [moveDragging, setMoveDragging] = useState(false);

  const isScrubbing = useRef(false);
  const isPinching = useRef(false);
  // Tracks finger contact on a trim handle. A plain tap on a handle (no
  // drag) never activates its pan gesture, so the tap would otherwise fall
  // through to the "empty area" press below and deselect the clip you were
  // about to trim.
  const trimTouchRef = useRef({ active: false, lastEnd: 0 });
  const scrubEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pixelsPerSecondSV = useSharedValue(INITIAL_PIXELS_PER_SECOND);
  const gestureBasePPS = useSharedValue(INITIAL_PIXELS_PER_SECOND);
  const lastDispatchTime = useSharedValue(0);
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
  // Same idea as contentWidthSV above, but as a plain JS number for the
  // scroll-follow effect below (which isn't a worklet).
  const timelineContentWidth = Math.max(
    timelineDuration * pixelsPerSecond,
    200,
  );
  const secondMarks = Array.from(
    { length: Math.ceil(timelineDuration) + 1 },
    (_, i) => i,
  );
  const showSubdivisions = pixelsPerSecond >= SUBDIVISION_THRESHOLD;
  const subdivisionOffsets = Array.from(
    { length: SUBDIVISIONS_PER_SECOND - 1 },
    (_, i) => (i + 1) / SUBDIVISIONS_PER_SECOND,
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

  useEffect(() => {
    pixelsPerSecondSV.value = pixelsPerSecond;
  }, [pixelsPerSecond]);

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
  useEffect(() => {
    if (trackAreaWidth > 0 && !isScrubbing.current && !isPinching.current) {
      const x = clampJS(currentTime * pixelsPerSecond, 0, timelineContentWidth);
      if (__DEV__) {
        console.log("[EditorTimeline] scroll-follow", {
          currentTime,
          x,
          isScrubbing: isScrubbing.current,
        });
      }
      scrollRef.current?.scrollTo({ x, y: 0, animated: false });
      scrollX.value = x;
    }
  }, [currentTime, trackAreaWidth, pixelsPerSecond, timelineContentWidth]);

  const onTrackAreaLayout = (e: LayoutChangeEvent) => {
    setTrackAreaWidth(e.nativeEvent.layout.width);
  };

  const clearScrubEndTimeout = () => {
    if (scrubEndTimeoutRef.current !== null) {
      clearTimeout(scrubEndTimeoutRef.current);
      scrubEndTimeoutRef.current = null;
    }
  };

  // Touch-down on the timeline: start scrubbing and tell the parent to
  // pause, so the play clock stops fighting the finger for the playhead
  // position (this is what "scrub to 0 then it snaps back" was — the
  // clock was still running and kept overwriting the scrub).
  const beginScrubbing = () => {
    clearScrubEndTimeout();
    isScrubbing.current = true;
    if (__DEV__) console.log("[EditorTimeline] scrub begin (pausing playback)");
    onScrubStart?.();
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
  const scheduleScrubEnd = () => {
    clearScrubEndTimeout();
    scrubEndTimeoutRef.current = setTimeout(() => {
      scrubEndTimeoutRef.current = null;
      isScrubbing.current = false;
      if (__DEV__)
        console.log("[EditorTimeline] scrub end (release, no fling)");
    }, SCRUB_END_GRACE_MS);
  };

  // A fling started. Scrubbing must be ON for the fling's scroll events to
  // move the playhead — even if the release grace timer above already
  // fired (momentum can arrive a little late on some devices).
  const continueScrubbingIntoMomentum = () => {
    clearScrubEndTimeout();
    isScrubbing.current = true;
    if (__DEV__) console.log("[EditorTimeline] scrub continues into fling");
  };

  // Finger lifted, reported by the gesture handler wrapping the ScrollView.
  // This is the reliable release signal: in the logs, the ScrollView's own
  // onEndDrag never fired once (the gesture handler wrapper swallows it),
  // so a drag released without a fling left `isScrubbing` stuck on and
  // the playhead would stop following the next time you pressed play.
  const handleFingerLifted = () => {
    if (__DEV__) console.log("[EditorTimeline] finger lifted");
    if (isScrubbing.current) scheduleScrubEnd();
  };

  const endScrubbingAfterMomentum = () => {
    clearScrubEndTimeout();
    isScrubbing.current = false;
    if (__DEV__) console.log("[EditorTimeline] scrub end (fling settled)");
  };

  useEffect(() => {
    return () => clearScrubEndTimeout();
  }, []);

  const setIsPinching = (value: boolean) => {
    isPinching.current = value;
  };

  // Scrubbing dispatches onScroll (and thus a potential onScrub call) far
  // more often than React can usefully keep up with — every native scroll
  // frame, which during a fast drag can mean many calls in quick
  // succession. Each onScrub ultimately fires TWO state updates in the
  // parent (timelineTime + a seek-version bump) and a full effect cascade
  // across the playback hooks, so firing one per raw scroll event let a
  // backlog of stale, superseded updates pile up. Coalescing to at most
  // one flush per animation frame keeps the parent's update rate sane no
  // matter how fast raw scroll events arrive, without dropping the drag's
  // final position (the latest value always wins).
  const pendingScrubTimeRef = useRef<number | null>(null);
  const scrubRafRef = useRef<number | null>(null);

  const flushScrub = () => {
    scrubRafRef.current = null;
    const time = pendingScrubTimeRef.current;
    pendingScrubTimeRef.current = null;
    if (time === null) return;
    if (__DEV__) {
      console.log("[EditorTimeline] onScrub (flushed)", { time });
    }
    onScrub(time);
  };

  useEffect(() => {
    return () => {
      if (scrubRafRef.current !== null) {
        cancelAnimationFrame(scrubRafRef.current);
      }
    };
  }, []);

  const handleScrollUpdate = (offsetX: number) => {
    if (!isScrubbing.current) return;
    const time = clampJS(offsetX / pixelsPerSecond, 0, timelineDuration);
    if (__DEV__) {
      console.log("[EditorTimeline] onScrub (raw)", { offsetX, time });
    }
    pendingScrubTimeRef.current = time;
    if (scrubRafRef.current === null) {
      scrubRafRef.current = requestAnimationFrame(flushScrub);
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
      scrollX.value = event.contentOffset.x;
      runOnJS(handleScrollUpdate)(event.contentOffset.x);
    },
    onBeginDrag: () => {
      runOnJS(beginScrubbing)();
    },
    onEndDrag: () => {
      runOnJS(scheduleScrubEnd)();
    },
    onMomentumBegin: () => {
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

  const pinchGesture = Gesture.Pinch()
    .onBegin(() => {
      gestureBasePPS.value = pixelsPerSecondSV.value;
      lastDispatchTime.value = 0;
      runOnJS(setIsPinching)(true);
    })
    .onStart(() => {
      // onStart = two fingers really started pinching (onBegin above can
      // fire on a plain one-finger touch before the pinch is recognized,
      // and we don't want a normal tap/scroll to pause playback).
      runOnJS(handlePinchZoomStart)();
    })
    .onUpdate((event) => {
      const basePPS = gestureBasePPS.value;
      const minScale = MIN_PIXELS_PER_SECOND / basePPS;
      const maxScale = MAX_PIXELS_PER_SECOND / basePPS;
      const scale = clampWorklet(event.scale, minScale, maxScale);
      const newPPS = clampWorklet(
        basePPS * scale,
        MIN_PIXELS_PER_SECOND,
        MAX_PIXELS_PER_SECOND,
      );

      pixelsPerSecondSV.value = newPPS;

      const timelineX = scrollX.value + event.focalX - LEADING_WIDTH;
      const anchorTime = clampWorklet(
        timelineX / basePPS,
        0,
        timelineDurationSV.value,
      );
      const newTimelineX = anchorTime * newPPS;
      const newScrollX = newTimelineX - event.focalX + LEADING_WIDTH;

      const newContentWidth = Math.max(timelineDurationSV.value * newPPS, 200);
      const newTotalScrollWidth =
        LEADING_WIDTH + newContentWidth + trackAreaWidthSV.value;
      const maxScrollX = Math.max(
        0,
        newTotalScrollWidth - trackAreaWidthSV.value,
      );
      const clampedScrollX = clampWorklet(newScrollX, 0, maxScrollX);

      scrollTo(scrollRef, clampedScrollX, 0, false);
      scrollX.value = clampedScrollX;

      const now = Date.now();
      if (now - lastDispatchTime.value >= ZOOM_DISPATCH_INTERVAL_MS) {
        lastDispatchTime.value = now;
        runOnJS(commitZoom)(newPPS);
      }
    })
    .onEnd((event) => {
      const basePPS = gestureBasePPS.value;
      const minScale = MIN_PIXELS_PER_SECOND / basePPS;
      const maxScale = MAX_PIXELS_PER_SECOND / basePPS;
      const scale = clampWorklet(event.scale, minScale, maxScale);
      const finalPPS = clampWorklet(
        basePPS * scale,
        MIN_PIXELS_PER_SECOND,
        MAX_PIXELS_PER_SECOND,
      );
      pixelsPerSecondSV.value = finalPPS;
      runOnJS(commitZoom)(finalPPS);
      runOnJS(setIsPinching)(false);
    })
    .onFinalize(() => {
      runOnJS(setIsPinching)(false);
    });

  const zoomWithButton = (direction: "in" | "out") => {
    if (__DEV__)
      console.log(
        `[EditorTimeline] zoom ${direction} button pressed (pausing playback)`,
      );
    // Pause first, even if the zoom itself turns out to be a no-op (already
    // at min/max zoom) — the tap still means "I'm editing now".
    onZoomButtonPress?.(direction);

    if (trackAreaWidth <= 0 || timelineDuration <= 0) return;

    const oldPPS = pixelsPerSecond;
    const factor =
      direction === "in" ? BUTTON_ZOOM_FACTOR : 1 / BUTTON_ZOOM_FACTOR;
    const newPPS = clampJS(
      oldPPS * factor,
      MIN_PIXELS_PER_SECOND,
      MAX_PIXELS_PER_SECOND,
    );
    if (newPPS === oldPPS) return;

    const newTimelineX = currentTime * newPPS;
    const newContentWidth = Math.max(timelineDuration * newPPS, 200);
    const newTotalScrollWidth =
      LEADING_WIDTH + newContentWidth + trackAreaWidth;
    const maxScrollX = Math.max(0, newTotalScrollWidth - trackAreaWidth);
    const targetScrollX = clampJS(newTimelineX, 0, maxScrollX);

    pixelsPerSecondSV.value = newPPS;
    setPixelsPerSecond(newPPS);

    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: targetScrollX, y: 0, animated: false });
      scrollX.value = targetScrollX;
    });
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
      runOnJS(setTrimDragging)(true);
      runOnJS(markTrimTouch)(true);
      runOnJS(handleClipGestureStart)("trim");
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
      runOnJS(setTrimDragging)(true);
      runOnJS(markTrimTouch)(true);
      runOnJS(handleClipGestureStart)("trim");
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
        runOnJS(setMoveDragging)(true);
      })
      .onStart(() => {
        // onStart = the long-press actually activated the move (onBegin
        // above fires on touch-down, even for a quick tap to select).
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
                  scrollEnabled={!trimDragging && !moveDragging}
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
                          width={
                            (videoTrim.end - videoTrim.start) * pixelsPerSecond
                          }
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
                            <View
                              style={[
                                styles.thumbLayer,
                                {
                                  left: -videoTrim.start * pixelsPerSecond,
                                  width: contentWidth,
                                },
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
                            </View>
                          )}
                        </TimelineClipBox>

                        <TimelineClipBox
                          slotHeight={TRACK_HEIGHT}
                          slotMarginTop={TRACK_GAP}
                          offsetSV={audioOffsetSV}
                          pixelsPerSecondSV={pixelsPerSecondSV}
                          width={
                            (audioTrim.end - audioTrim.start) * pixelsPerSecond
                          }
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
                          <View
                            style={[
                              styles.waveformWindow,
                              {
                                left: -audioTrim.start * pixelsPerSecond,
                                width: contentWidth,
                              },
                            ]}
                            pointerEvents="none"
                          >
                            <WaveformBars
                              color={colors.iconInactive}
                              contentWidth={contentWidth}
                              pixelsPerSecond={pixelsPerSecond}
                            />
                          </View>
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
