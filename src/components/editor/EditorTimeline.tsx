import { Ionicons } from "@expo/vector-icons";
import type { VideoPlayer } from "expo-video";
import { useEffect, useRef, useState } from "react";
import {
  LayoutChangeEvent,
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

const DEFAULT_PIXELS_PER_SECOND = 60;
const MIN_PIXELS_PER_SECOND = 20;
const MAX_PIXELS_PER_SECOND = 200;

const TRACK_HEIGHT = 56;
const TRACK_GAP = 4;
const LEADING_WIDTH = 60;

const SUBDIVISION_THRESHOLD = 90;
const SUBDIVISIONS_PER_SECOND = 5;

const ZOOM_DISPATCH_INTERVAL_MS = 16;
const BUTTON_ZOOM_FACTOR = 1.25;

const MIN_RULER_LABEL_SPACING = 50;

interface EditorTimelineProps {
  clipLabel: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  player: VideoPlayer;
  onMutePress: () => void;
  onAddAudioPress: () => void;
  onAddTextPress: () => void;
  onScrub: (time: number) => void;
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

export default function EditorTimeline({
  clipLabel,
  currentTime,
  duration,
  isPlaying,
  player,
  onMutePress,
  onAddAudioPress,
  onAddTextPress,
  onScrub,
}: EditorTimelineProps) {
  const colors = useTheme();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();

  const [trackAreaWidth, setTrackAreaWidth] = useState(0);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(
    DEFAULT_PIXELS_PER_SECOND,
  );

  const isScrubbing = useRef(false);
  const isPinching = useRef(false);
  const rafRef = useRef<number | null>(null);

  const pixelsPerSecondSV = useSharedValue(DEFAULT_PIXELS_PER_SECOND);
  const gestureBasePPS = useSharedValue(DEFAULT_PIXELS_PER_SECOND);
  const lastDispatchTime = useSharedValue(0);
  const scrollX = useSharedValue(0);
  const durationSV = useSharedValue(0);
  const trackAreaWidthSV = useSharedValue(0);

  const contentWidthSV = useDerivedValue(() =>
    Math.max(durationSV.value * pixelsPerSecondSV.value, 200),
  );
  const totalScrollWidthSV = useDerivedValue(
    () => LEADING_WIDTH + contentWidthSV.value + trackAreaWidthSV.value,
  );

  const safeDuration = duration > 0 ? duration : 0;
  const contentWidth = Math.max(safeDuration * pixelsPerSecond, 200);
  const secondMarks = Array.from(
    { length: Math.ceil(safeDuration) + 1 },
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

  useEffect(() => {
    pixelsPerSecondSV.value = pixelsPerSecond;
  }, [pixelsPerSecond]);

  useEffect(() => {
    durationSV.value = safeDuration;
  }, [safeDuration]);

  useEffect(() => {
    trackAreaWidthSV.value = trackAreaWidth;
  }, [trackAreaWidth]);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const tick = () => {
      if (!isScrubbing.current && !isPinching.current && trackAreaWidth > 0) {
        const t = player.currentTime;
        const x = clampJS(t * pixelsPerSecond, 0, contentWidth);
        scrollRef.current?.scrollTo({ x, y: 0, animated: false });
        scrollX.value = x;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying, trackAreaWidth, pixelsPerSecond, contentWidth, player]);

  useEffect(() => {
    if (isPlaying) return;
    if (trackAreaWidth > 0 && !isScrubbing.current && !isPinching.current) {
      const x = clampJS(currentTime * pixelsPerSecond, 0, contentWidth);
      scrollRef.current?.scrollTo({ x, y: 0, animated: false });
      scrollX.value = x;
    }
  }, [currentTime, trackAreaWidth, pixelsPerSecond, isPlaying, contentWidth]);

  const onTrackAreaLayout = (e: LayoutChangeEvent) => {
    setTrackAreaWidth(e.nativeEvent.layout.width);
  };

  const setIsScrubbing = (value: boolean) => {
    isScrubbing.current = value;
  };

  const setIsPinching = (value: boolean) => {
    isPinching.current = value;
  };

  const handleScrollUpdate = (offsetX: number) => {
    if (!isScrubbing.current) return;
    const time = clampJS(offsetX / pixelsPerSecond, 0, safeDuration);
    onScrub(time);
  };

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollX.value = event.contentOffset.x;
      runOnJS(handleScrollUpdate)(event.contentOffset.x);
    },
    onBeginDrag: () => {
      runOnJS(setIsScrubbing)(true);
    },
    onMomentumEnd: () => {
      runOnJS(setIsScrubbing)(false);
    },
  });

  const commitZoom = (finalPPS: number) => {
    setPixelsPerSecond(finalPPS);
  };

  const pinchGesture = Gesture.Pinch()
    .onBegin(() => {
      gestureBasePPS.value = pixelsPerSecondSV.value;
      lastDispatchTime.value = 0;
      runOnJS(setIsPinching)(true);
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
      const anchorTime = clampWorklet(timelineX / basePPS, 0, durationSV.value);
      const newTimelineX = anchorTime * newPPS;
      const newScrollX = newTimelineX - event.focalX + LEADING_WIDTH;

      const newContentWidth = Math.max(durationSV.value * newPPS, 200);
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
    if (trackAreaWidth <= 0 || safeDuration <= 0) return;

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
    const newContentWidth = Math.max(safeDuration * newPPS, 200);
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

  const tracksBlockHeight = 16 + TRACK_HEIGHT * 3 + TRACK_GAP * 3;

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
          {formatTime(currentTime)} / {formatTime(duration)}
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
              <Animated.ScrollView
                ref={scrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                scrollEventThrottle={16}
                onScroll={scrollHandler}
              >
                <Animated.View style={[styles.outerRow, outerRowStyle]}>
                  <View style={{ width: LEADING_WIDTH }}>
                    <View style={{ height: 16 + TRACK_GAP }} />
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

                    <Animated.View
                      style={[
                        styles.trackRow,
                        trackWidthStyle,
                        {
                          backgroundColor: colors.surface,
                          borderColor: colors.accentPurple,
                        },
                      ]}
                    >
                      <View style={styles.trackRowTouchable}>
                        <Ionicons
                          name="film-outline"
                          size={16}
                          color={colors.textPrimary}
                        />
                        <AppText
                          style={[
                            styles.trackLabel,
                            { color: colors.textPrimary },
                          ]}
                          numberOfLines={1}
                        >
                          {clipLabel}
                        </AppText>
                      </View>
                    </Animated.View>

                    <Animated.View
                      style={[
                        styles.trackRow,
                        trackWidthStyle,
                        {
                          backgroundColor: colors.surface,
                          borderColor: colors.iconInactive,
                        },
                      ]}
                    >
                      <TouchableOpacity
                        style={styles.trackRowTouchable}
                        onPress={onAddAudioPress}
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
                          Add audio
                        </AppText>
                      </TouchableOpacity>
                    </Animated.View>

                    <Animated.View
                      style={[
                        styles.trackRow,
                        trackWidthStyle,
                        {
                          backgroundColor: colors.surface,
                          borderColor: colors.iconInactive,
                        },
                      ]}
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
                </Animated.View>
              </Animated.ScrollView>

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
  rulerRow: { flexDirection: "row", height: 16, overflow: "visible" },
  rulerMark: { position: "relative", overflow: "visible" },
  rulerLabel: { fontSize: 10 },
  secondTick: { position: "absolute", left: 0, bottom: 0, width: 1, height: 7 },
  subTick: { position: "absolute", bottom: 0, width: 1, height: 5 },
  trackRow: {
    height: TRACK_HEIGHT,
    marginTop: TRACK_GAP,
    borderRadius: 10,
    borderWidth: 2,
    overflow: "hidden",
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
