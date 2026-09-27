import { Ionicons } from "@expo/vector-icons";
import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import type { TextClipData } from "../../editor/clipModel";
import TextVisual from "./TextVisual";

/** The video picture's rectangle inside the preview box (px). */
export type FrameRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type TextTransform = Pick<
  TextClipData,
  "x" | "y" | "scale" | "rotation"
>;

// Room around the selection frame for the ✕ and ↻ buttons (they must sit
// inside the touchable area on Android).
const BUTTON_ROOM = 16;
const BUTTON_SIZE = 28;
const MIN_SCALE = 0.2;
const MAX_SCALE = 6;
// Rotation snaps to 0 / 90 / 180 / 270° within this many degrees.
const ROTATION_SNAP = 5;

function clamp(v: number, min: number, max: number) {
  "worklet";
  return Math.max(min, Math.min(v, max));
}

function snapRotation(deg: number) {
  "worklet";
  const norm = ((deg % 360) + 360) % 360;
  for (const target of [0, 90, 180, 270, 360]) {
    if (Math.abs(norm - target) <= ROTATION_SNAP) return target % 360;
  }
  return norm;
}

/**
 * Texts over the video preview. Positions / sizes are fractions of the video
 * picture (TextClipData), so they match at any preview size and in the
 * export. Tap a text to select it; the selected one gets a frame with ✕
 * (delete) and ↻ (drag to rotate + resize), and can be dragged to move.
 * Tap the selected text again to edit it. Moves are drawn on the UI thread
 * and reported once, when the finger lifts.
 */
export default function TextOverlay({
  texts,
  frame,
  selectedId,
  onSelect,
  onEditSelected,
  onDelete,
  onTransform,
  onGestureActive,
}: {
  texts: { id: string; data: TextClipData }[];
  frame: FrameRect | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEditSelected: (id: string) => void;
  onDelete: (id: string) => void;
  onTransform: (id: string, t: TextTransform) => void;
  /** A drag / rotate started (true) or ended (false) — e.g. stop scrolling. */
  onGestureActive?: (active: boolean) => void;
}) {
  if (!frame || frame.width <= 0 || frame.height <= 0) return null;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {texts.map(({ id, data }) =>
        data.text.trim() ? (
          <OverlayText
            key={id}
            id={id}
            data={data}
            frame={frame}
            selected={id === selectedId}
            onSelect={onSelect}
            onEditSelected={onEditSelected}
            onDelete={onDelete}
            onTransform={onTransform}
            onGestureActive={onGestureActive}
          />
        ) : null,
      )}
    </View>
  );
}

function OverlayText({
  id,
  data,
  frame,
  selected,
  onSelect,
  onEditSelected,
  onDelete,
  onTransform,
  onGestureActive,
}: {
  id: string;
  data: TextClipData;
  frame: FrameRect;
  selected: boolean;
  onSelect: (id: string) => void;
  onEditSelected: (id: string) => void;
  onDelete: (id: string) => void;
  onTransform: (id: string, t: TextTransform) => void;
  onGestureActive?: (active: boolean) => void;
}) {
  const fontSize = Math.max(6, data.size * frame.height * data.scale);
  const cx = frame.left + data.x * frame.width;
  const cy = frame.top + data.y * frame.height;

  // Live gesture offsets (UI thread), reset whenever the committed values
  // arrive.
  const txSV = useSharedValue(0);
  const tySV = useSharedValue(0);
  const rotSV = useSharedValue(0);
  const scaleSV = useSharedValue(1);
  const boxWSV = useSharedValue(0);
  const boxHSV = useSharedValue(0);
  const v0xSV = useSharedValue(0);
  const v0ySV = useSharedValue(0);
  useEffect(() => {
    txSV.set(0);
    tySV.set(0);
    rotSV.set(0);
    scaleSV.set(1);
  }, [data.x, data.y, data.rotation, data.scale, txSV, tySV, rotSV, scaleSV]);

  const baseRotation = data.rotation;
  const baseScale = data.scale;
  const baseX = data.x;
  const baseY = data.y;
  const fw = frame.width;
  const fh = frame.height;

  const commit = (t: TextTransform) => {
    if (__DEV__)
      console.log(
        `[TextOverlay] ${id} → x ${t.x.toFixed(2)}, y ${t.y.toFixed(2)}, scale ${t.scale.toFixed(2)}, rotation ${t.rotation.toFixed(0)}°`,
      );
    onTransform(id, t);
  };
  const setActive = (active: boolean) => onGestureActive?.(active);

  const tap = Gesture.Tap().onEnd((_e, success) => {
    if (!success) return;
    if (selected) runOnJS(onEditSelected)(id);
    else runOnJS(onSelect)(id);
  });

  // Drag to move (only the selected text; others just take taps).
  const pan = Gesture.Pan()
    .enabled(selected)
    .minDistance(4)
    .onStart(() => {
      runOnJS(setActive)(true);
    })
    .onUpdate((e) => {
      txSV.value = e.translationX;
      tySV.value = e.translationY;
    })
    .onEnd((e) => {
      runOnJS(commit)({
        x: clamp(baseX + e.translationX / fw, 0, 1),
        y: clamp(baseY + e.translationY / fh, 0, 1),
        scale: baseScale,
        rotation: baseRotation,
      });
    })
    .onFinalize(() => {
      runOnJS(setActive)(false);
    });

  // ↻ handle: the vector from the text's centre to the handle, rotated
  // and stretched by the finger → rotation and scale.
  const handle = Gesture.Pan()
    .minDistance(1)
    .onStart(() => {
      const rad = (baseRotation * Math.PI) / 180;
      const hx = boxWSV.value / 2;
      const hy = boxHSV.value / 2;
      v0xSV.value = hx * Math.cos(rad) - hy * Math.sin(rad);
      v0ySV.value = hx * Math.sin(rad) + hy * Math.cos(rad);
      runOnJS(setActive)(true);
    })
    .onUpdate((e) => {
      const vx = v0xSV.value + e.translationX;
      const vy = v0ySV.value + e.translationY;
      const a0 = Math.atan2(v0ySV.value, v0xSV.value);
      const a1 = Math.atan2(vy, vx);
      rotSV.value = ((a1 - a0) * 180) / Math.PI;
      const l0 = Math.hypot(v0xSV.value, v0ySV.value) || 1;
      scaleSV.value = clamp(
        Math.hypot(vx, vy) / l0,
        MIN_SCALE / baseScale,
        MAX_SCALE / baseScale,
      );
    })
    .onEnd(() => {
      runOnJS(commit)({
        x: baseX,
        y: baseY,
        scale: clamp(baseScale * scaleSV.value, MIN_SCALE, MAX_SCALE),
        rotation: snapRotation(baseRotation + rotSV.value),
      });
    })
    .onFinalize(() => {
      runOnJS(setActive)(false);
    });

  const liveStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: txSV.value },
      { translateY: tySV.value },
      { rotate: `${baseRotation + rotSV.value}deg` },
      { scale: scaleSV.value },
    ],
  }));

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.anchor,
        {
          left: cx - frame.width,
          top: cy - frame.height,
          width: frame.width * 2,
          height: frame.height * 2,
        },
      ]}
    >
      <Animated.View style={[styles.wrapper, liveStyle]}>
        <GestureDetector gesture={Gesture.Race(pan, tap)}>
          <View
            style={[styles.box, selected && styles.boxSelected]}
            onLayout={(e: {
              nativeEvent: { layout: { width: number; height: number } };
            }) => {
              boxWSV.value = e.nativeEvent.layout.width;
              boxHSV.value = e.nativeEvent.layout.height;
            }}
          >
            <TextVisual
              data={data}
              fontSize={fontSize}
              maxWidth={frame.width * 0.92}
            />
          </View>
        </GestureDetector>

        {selected && (
          <>
            <Pressable
              onPress={() => onDelete(id)}
              style={[styles.button, styles.deleteButton]}
              hitSlop={8}
              accessibilityLabel="Delete text"
            >
              <Ionicons name="close" size={16} color="#FFFFFF" />
            </Pressable>
            <GestureDetector gesture={handle}>
              <View
                style={[styles.button, styles.handleButton]}
                accessibilityLabel="Rotate and resize"
              >
                <Ionicons name="sync-outline" size={15} color="#FFFFFF" />
              </View>
            </GestureDetector>
          </>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  wrapper: { padding: BUTTON_ROOM },
  box: { borderWidth: 1, borderColor: "transparent" },
  boxSelected: { borderColor: "#FFFFFF" },
  button: {
    position: "absolute",
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: "rgba(20,20,20,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  deleteButton: {
    left: BUTTON_ROOM - BUTTON_SIZE / 2,
    top: BUTTON_ROOM - BUTTON_SIZE / 2,
  },
  handleButton: {
    right: BUTTON_ROOM - BUTTON_SIZE / 2,
    bottom: BUTTON_ROOM - BUTTON_SIZE / 2,
  },
});
