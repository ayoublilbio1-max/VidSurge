import { Ionicons } from "@expo/vector-icons";
import { useEffect, type ReactNode } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import {
  GestureDetector,
  type GestureType,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import AppText from "../AppText";

const HOLD_FEEDBACK_DURATION_MS = 120;
const HOLD_OPACITY = 0.6;
// When a clip's committed position changes (dropped, pushed aside by a
// drop, trimmed at the start), it slides to the new spot over this long.
const SETTLE_DURATION_MS = 160;
// "It worked" flash after an edit (split halves, added music, unlocked
// pair): the box lights up in the accent colour and fades out.
const FLASH_OPACITY = 0.45;
const FLASH_DURATION_MS = 500;

/**
 * Live move state shared by every clip box on the timeline. EditorTimeline
 * writes it from the move gesture (UI thread); each box reads it every
 * frame, so a dragged clip follows the finger with no React re-render.
 *
 *   basesSV  — the dragged clips' starting positions, by clip id (the
 *              clip itself + its locked partner). Empty = nothing dragged.
 *   deltaSV  — how far the finger has moved them, in timeline seconds.
 *   activeSV — the finger is still down (drives the dimmed "held" look).
 *
 * After a drop, the bases stay set until the committed positions arrive
 * as props (EditorTimeline clears them then), so the box never flashes
 * back to its old spot in between.
 */
export type ClipDragState = {
  basesSV: SharedValue<Record<string, number>>;
  deltaSV: SharedValue<number>;
  activeSV: SharedValue<boolean>;
};

// Presentational clip box: an absolutely-positioned rounded box inside its
// track row, placed at `start` and `lengthSeconds` long (both in timeline
// seconds; the pixel position/width is computed on the UI thread from the
// live zoom, so it follows a pinch frame by frame). EditorTimeline owns all
// the trim/move math and gesture wiring; one box is rendered per clip.
interface TimelineClipBoxProps {
  clipId: string;
  /** Committed timeline position of the clip's left edge (seconds). */
  start: number;
  /** Clip length on the timeline (seconds, speed included). */
  lengthSeconds: number;
  height: number;
  pixelsPerSecondSV: SharedValue<number>;
  drag: ClipDragState;
  selected: boolean;
  backgroundColor: string;
  selectedBorderColor: string;
  inactiveBorderColor: string;
  labelIcon: keyof typeof Ionicons.glyphMap;
  labelText: string;
  onPress: () => void;
  // Optional press-and-hold-to-move gesture. A quick tap still falls
  // through to the label's TouchableOpacity below (selection), since the
  // pan only activates after the hold delay set on the gesture itself.
  moveGesture?: GestureType;
  /**
   * Bump to flash this box once (see FLASH_DURATION_MS). 0 = never flashed.
   * The editor bumps it for the clips an edit just made or changed.
   */
  flashToken?: number;
  flashColor?: string;
  /**
   * The whole track is muted (audio row's mute button): the box is drawn
   * greyed out — dashed border, faded content, a mute icon on the label.
   */
  muted?: boolean;
  children?: ReactNode;
}

// Muted look: a soft grey, not black — the clip stays easy to see.
const MUTED_BACKGROUND = "#3A3A42";
const MUTED_BORDER = "#7A7A86";
const MUTED_CONTENT_OPACITY = 0.5;
const MUTED_TEXT = "#D0D0D8";

/**
 * A prop mirrored to the UI thread as a shared value. Animated styles read
 * the shared value instead of capturing the prop in their closure: with the
 * React Compiler a captured number could stay stale (redo "split" drew the
 * left half at its old full length), a shared value can't.
 */
export function useSyncedValue(value: number): SharedValue<number> {
  const sv = useSharedValue(value);
  useEffect(() => {
    sv.set(value);
  }, [value, sv]);
  return sv;
}

export default function TimelineClipBox({
  clipId,
  start,
  lengthSeconds,
  height,
  pixelsPerSecondSV,
  drag,
  selected,
  backgroundColor,
  selectedBorderColor,
  inactiveBorderColor,
  labelIcon,
  labelText,
  onPress,
  moveGesture,
  flashToken = 0,
  flashColor = "#FFFFFF",
  muted = false,
  children,
}: TimelineClipBoxProps) {
  const lengthSV = useSyncedValue(lengthSeconds);
  useEffect(() => {
    if (__DEV__)
      console.log(
        `[TimelineClipBox] ${clipId} length → ${lengthSeconds.toFixed(2)}s`,
      );
  }, [clipId, lengthSeconds]);
  const flashSV = useSharedValue(0);
  useEffect(() => {
    if (flashToken <= 0) return;
    flashSV.set(FLASH_OPACITY);
    flashSV.set(withTiming(0, { duration: FLASH_DURATION_MS }));
  }, [flashToken, flashSV]);
  const flashStyle = useAnimatedStyle(() => ({ opacity: flashSV.value }));

  // The committed start, mirrored to the UI thread, sliding to each new
  // value. This effect runs before EditorTimeline's (children first), so
  // when a dropped clip's new start arrives, the slide begins from where
  // the finger left it — the box never jumps back to its old spot.
  const startSV = useSharedValue(start);
  useEffect(() => {
    // .get()/.set() (not .value) outside worklets: with the React
    // Compiler, `.value` here was read during render (621 Reanimated
    // warnings per session).
    const base = drag.basesSV.get()[clipId];
    if (base !== undefined) {
      startSV.set(Math.max(0, base + drag.deltaSV.get()));
    }
    startSV.set(withTiming(start, { duration: SETTLE_DURATION_MS }));
  }, [start, startSV, clipId, drag]);

  const positionStyle = useAnimatedStyle(() => {
    const base = drag.basesSV.value[clipId];
    const t =
      base !== undefined
        ? Math.max(0, base + drag.deltaSV.value)
        : startSV.value;
    return {
      left: t * pixelsPerSecondSV.value,
      width: Math.max(lengthSV.value * pixelsPerSecondSV.value, 2),
    };
  });

  // Held look is a plain dim/fade (like muting a track) — no scale change.
  // The held clip is drawn above its neighbours: it may pass over them
  // while dragging (on drop it's inserted, never left overlapping).
  const holdStyle = useAnimatedStyle(() => {
    const isMoving =
      drag.activeSV.value && drag.basesSV.value[clipId] !== undefined;
    return {
      opacity: withTiming(isMoving ? HOLD_OPACITY : 1, {
        duration: HOLD_FEEDBACK_DURATION_MS,
      }),
      zIndex: isMoving ? 10 : 0,
    };
  });

  const box = (
    <Animated.View
      style={[
        styles.box,
        positionStyle,
        holdStyle,
        {
          height,
          backgroundColor: muted ? MUTED_BACKGROUND : backgroundColor,
          borderColor: selected
            ? selectedBorderColor
            : muted
              ? MUTED_BORDER
              : inactiveBorderColor,
          borderStyle: muted ? "dashed" : "solid",
        },
      ]}
    >
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          muted && { opacity: MUTED_CONTENT_OPACITY },
        ]}
      >
        {children}
      </View>

      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: flashColor },
          flashStyle,
        ]}
      />

      <TouchableOpacity
        activeOpacity={0.8}
        style={styles.touchable}
        onPress={onPress}
      >
        <View style={[styles.labelChip, muted && styles.labelChipMuted]}>
          <Ionicons
            name={muted ? "volume-mute" : labelIcon}
            size={14}
            color={muted ? MUTED_TEXT : "#FFFFFF"}
          />
          <AppText
            style={[styles.labelText, muted && styles.labelTextMuted]}
            numberOfLines={1}
          >
            {muted ? `${labelText} · Muted` : labelText}
          </AppText>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );

  return moveGesture ? (
    <GestureDetector gesture={moveGesture}>{box}</GestureDetector>
  ) : (
    box
  );
}

const styles = StyleSheet.create({
  box: {
    position: "absolute",
    top: 0,
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
  },
  touchable: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  labelChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.4)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: "90%",
  },
  labelText: {
    fontSize: 12,
    color: "#FFFFFF",
    flexShrink: 1,
  },
  labelChipMuted: { backgroundColor: "rgba(0,0,0,0.35)" },
  labelTextMuted: { color: MUTED_TEXT },
});
