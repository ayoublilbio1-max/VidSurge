import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import {
  GestureDetector,
  type GestureType,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import AppText from "../AppText";

const HOLD_FEEDBACK_DURATION_MS = 120;
const HOLD_OPACITY = 0.6;

// Presentational shell for a track's clip box: a fixed-height, normal-flow
// "slot" (so it still takes up space in the video/audio row stack) with an
// absolutely-positioned rounded box inside it that can sit anywhere on the
// timeline and be any length (via `lengthSeconds`) — used for both the video and
// the audio clip so trimming/moving one doesn't duplicate this markup.
// Purely presentational: EditorTimeline still owns all the trim/offset math
// and gesture wiring. The box's timeline position is read from `offsetSV`
// every frame (not a plain number prop) so that when EditorTimeline's move
// gesture writes to it directly on the UI thread, the box tracks the
// finger with no React re-renders in between — same idea as the trim
// handles. `movingSV` drives the "picked up" look (shrink + fade) while
// that's happening.
interface TimelineClipBoxProps {
  slotHeight: number;
  slotMarginTop: number;
  offsetSV: SharedValue<number>;
  pixelsPerSecondSV: SharedValue<number>;
  // Clip length in seconds. The on-screen width is length × zoom, computed
  // on the UI thread so it follows a pinch-zoom frame by frame (a plain
  // pixel-width prop only updated when React re-rendered, so the boxes
  // lagged behind the ruler while zooming).
  lengthSeconds: number;
  selected: boolean;
  backgroundColor: string;
  selectedBorderColor: string;
  inactiveBorderColor: string;
  labelIcon: keyof typeof Ionicons.glyphMap;
  labelText: string;
  onPress: () => void;
  // Optional press-and-hold-to-move gesture. When given, the whole box is
  // wrapped in a GestureDetector for it — a quick tap still falls through
  // to the label's TouchableOpacity below (selection), since the pan only
  // activates after the hold delay set on the gesture itself.
  moveGesture?: GestureType;
  // Whether the box is currently being held/moved. Optional since not
  // every box needs the hold feedback.
  movingSV?: SharedValue<boolean>;
  children?: ReactNode;
}

export default function TimelineClipBox({
  slotHeight,
  slotMarginTop,
  offsetSV,
  pixelsPerSecondSV,
  lengthSeconds,
  selected,
  backgroundColor,
  selectedBorderColor,
  inactiveBorderColor,
  labelIcon,
  labelText,
  onPress,
  moveGesture,
  movingSV,
  children,
}: TimelineClipBoxProps) {
  const positionStyle = useAnimatedStyle(() => ({
    left: offsetSV.value * pixelsPerSecondSV.value,
    width: Math.max(lengthSeconds * pixelsPerSecondSV.value, 2),
  }));

  // Held look is a plain dim/fade (like muting a track) — no scale change.
  const holdStyle = useAnimatedStyle(() => {
    const isMoving = movingSV?.value ?? false;
    return {
      opacity: withTiming(isMoving ? HOLD_OPACITY : 1, {
        duration: HOLD_FEEDBACK_DURATION_MS,
      }),
    };
  });

  const box = (
    <Animated.View
      style={[
        styles.box,
        positionStyle,
        holdStyle,
        {
          height: slotHeight,
          backgroundColor,
          borderColor: selected ? selectedBorderColor : inactiveBorderColor,
        },
      ]}
    >
      {children}

      <TouchableOpacity
        activeOpacity={0.8}
        style={styles.touchable}
        onPress={onPress}
      >
        <View style={styles.labelChip}>
          <Ionicons name={labelIcon} size={14} color="#FFFFFF" />
          <AppText style={styles.labelText} numberOfLines={1}>
            {labelText}
          </AppText>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );

  return (
    <View style={{ height: slotHeight, marginTop: slotMarginTop }}>
      {moveGesture ? (
        <GestureDetector gesture={moveGesture}>{box}</GestureDetector>
      ) : (
        box
      )}
    </View>
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
});
