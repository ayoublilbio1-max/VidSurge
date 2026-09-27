import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

// While dragging, the value is sent to the parent at most this often. The
// thumb itself moves on the UI thread every frame, so the slider always
// feels instant; the text on the preview catches up in these steps (every
// update re-renders the editor, which the dev build does only ~5–10×/s).
const SEND_EVERY_MS = 70;
const THUMB = 22;

function clamp01(v: number) {
  "worklet";
  return Math.max(0, Math.min(1, v));
}

/**
 * A horizontal slider: touch anywhere on it and drag along. `value` is 0–1.
 * With `segments`, the track is those colours side by side (a gradient,
 * e.g. the hue rainbow) instead of track + fill. Runs on the UI thread
 * (gesture-handler + Reanimated), no native slider package / rebuild.
 */
export default function SliderBar({
  value,
  onChange,
  trackColor,
  fillColor,
  segments,
  disabled = false,
  accessibilityLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  trackColor: string;
  fillColor: string;
  segments?: string[];
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const widthSV = useSharedValue(0);
  const posSV = useSharedValue(clamp01(value));
  const draggingSV = useSharedValue(false);
  const lastSentSV = useSharedValue(0);

  // Follow the parent's value when it changes from elsewhere (not while the
  // finger is on it — then the thumb leads).
  useEffect(() => {
    if (!draggingSV.get()) posSV.set(clamp01(value));
  }, [value, posSV, draggingSV]);

  const send = (v: number) => onChange(v);

  const moveTo = (x: number, force: boolean) => {
    "worklet";
    const w = widthSV.value;
    if (w <= 0) return;
    const v = clamp01(x / w);
    posSV.value = v;
    const now = Date.now();
    if (force || now - lastSentSV.value >= SEND_EVERY_MS) {
      lastSentSV.value = now;
      runOnJS(send)(v);
    }
  };

  const pan = Gesture.Pan()
    .enabled(!disabled)
    .minDistance(0)
    .onBegin((e) => {
      draggingSV.value = true;
      moveTo(e.x, true);
    })
    .onUpdate((e) => {
      moveTo(e.x, false);
    })
    .onFinalize((e) => {
      // The exact final value, always.
      moveTo(e.x, true);
      draggingSV.value = false;
    });

  const thumbStyle = useAnimatedStyle(() => ({
    left: Math.max(0, posSV.value * widthSV.value - THUMB / 2),
  }));
  const fillStyle = useAnimatedStyle(() => ({
    width: posSV.value * widthSV.value,
  }));

  const thickness = segments ? 12 : 4;
  return (
    <GestureDetector gesture={pan}>
      <View
        style={[styles.slider, disabled && styles.disabled]}
        onLayout={(e: { nativeEvent: { layout: { width: number } } }) => {
          widthSV.value = e.nativeEvent.layout.width;
        }}
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
      >
        <View
          pointerEvents="none"
          style={[
            styles.track,
            { height: thickness, borderRadius: thickness / 2 },
            !segments && { backgroundColor: trackColor },
          ]}
        >
          {segments ? (
            <View style={styles.segments}>
              {segments.map((c, i) => (
                <View key={i} style={{ flex: 1, backgroundColor: c }} />
              ))}
            </View>
          ) : (
            <Animated.View
              style={[
                { height: thickness, backgroundColor: fillColor },
                fillStyle,
              ]}
            />
          )}
        </View>
        <Animated.View
          pointerEvents="none"
          style={[styles.thumb, segments && styles.thumbOnGradient, thumbStyle]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  slider: { flex: 1, height: 34, justifyContent: "center" },
  disabled: { opacity: 0.35 },
  track: { overflow: "hidden" },
  segments: { flex: 1, flexDirection: "row" },
  thumb: {
    position: "absolute",
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    top: 6,
    backgroundColor: "#FFFFFF",
    elevation: 3,
  },
  thumbOnGradient: { borderWidth: 2, borderColor: "#222222" },
});
