import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
} from "react-native-reanimated";
import { MIN_CROP, type CropRect } from "../../editor/clipModel";
import type { FrameRect } from "./TextOverlay";

// Touch area of a corner handle (px), and the visible corner mark.
const HANDLE_TOUCH = 36;
const HANDLE_MARK = 18;
const HANDLE_THICK = 3;
const DIM = "rgba(0,0,0,0.55)";

function clamp(v: number, min: number, max: number) {
  "worklet";
  return Math.max(min, Math.min(v, max));
}

type Corner = { key: string; sx: 1 | -1; sy: 1 | -1 };
const CORNERS: Corner[] = [
  { key: "tl", sx: -1, sy: -1 },
  { key: "tr", sx: 1, sy: -1 },
  { key: "bl", sx: -1, sy: 1 },
  { key: "br", sx: 1, sy: 1 },
];

/**
 * The crop box over the (uncropped) picture in the preview: drag inside it
 * to move it, drag a corner to resize it. Everything outside is dimmed.
 * `rect` is normalized to the picture (0–1). `lock` = height ÷ width in
 * those normalized units when a shape preset is on (null = free). Drawn on
 * the UI thread; `onChange` gets the result when the finger lifts.
 */
export default function CropOverlay({
  rect,
  picture,
  lock,
  onChange,
}: {
  rect: CropRect;
  picture: FrameRect;
  lock: number | null;
  onChange: (r: CropRect) => void;
}) {
  const xSV = useSharedValue(rect.x);
  const ySV = useSharedValue(rect.y);
  const wSV = useSharedValue(rect.w);
  const hSV = useSharedValue(rect.h);
  const startSV = useSharedValue({ x: 0, y: 0, w: 1, h: 1 });
  const lockSV = useSharedValue(lock ?? 0);

  useEffect(() => {
    xSV.set(rect.x);
    ySV.set(rect.y);
    wSV.set(rect.w);
    hSV.set(rect.h);
  }, [rect.x, rect.y, rect.w, rect.h, xSV, ySV, wSV, hSV]);
  useEffect(() => {
    lockSV.set(lock ?? 0);
  }, [lock, lockSV]);

  const pw = picture.width;
  const ph = picture.height;

  const commit = (r: CropRect) => {
    if (__DEV__)
      console.log(
        `[CropOverlay] crop → ${r.x.toFixed(3)},${r.y.toFixed(3)} ${r.w.toFixed(3)}×${r.h.toFixed(3)}`,
      );
    onChange(r);
  };

  const begin = () => {
    "worklet";
    startSV.value = { x: xSV.value, y: ySV.value, w: wSV.value, h: hSV.value };
  };
  const end = () => {
    "worklet";
    runOnJS(commit)({ x: xSV.value, y: ySV.value, w: wSV.value, h: hSV.value });
  };

  const move = Gesture.Pan()
    .minDistance(2)
    .onStart(begin)
    .onUpdate((e) => {
      const s = startSV.value;
      xSV.value = clamp(s.x + e.translationX / pw, 0, 1 - s.w);
      ySV.value = clamp(s.y + e.translationY / ph, 0, 1 - s.h);
    })
    .onEnd(end);

  const cornerGesture = (sx: 1 | -1, sy: 1 | -1) =>
    Gesture.Pan()
      .minDistance(1)
      .onStart(begin)
      .onUpdate((e) => {
        const s = startSV.value;
        // The opposite corner stays put.
        const anchorX = sx > 0 ? s.x : s.x + s.w;
        const anchorY = sy > 0 ? s.y : s.y + s.h;
        const availW = sx > 0 ? 1 - s.x : s.x + s.w;
        const availH = sy > 0 ? 1 - s.y : s.y + s.h;
        let w = clamp(s.w + (sx * e.translationX) / pw, MIN_CROP, availW);
        let h: number;
        const k = lockSV.value;
        if (k > 0) {
          // Shape preset: height follows width.
          h = w * k;
          if (h > availH) {
            h = availH;
            w = h / k;
          }
          if (h < MIN_CROP) {
            h = MIN_CROP;
            w = Math.min(availW, h / k);
          }
        } else {
          h = clamp(s.h + (sy * e.translationY) / ph, MIN_CROP, availH);
        }
        wSV.value = w;
        hSV.value = h;
        xSV.value = sx > 0 ? anchorX : anchorX - w;
        ySV.value = sy > 0 ? anchorY : anchorY - h;
      })
      .onEnd(end);

  const boxStyle = useAnimatedStyle(() => ({
    left: picture.left + xSV.value * pw,
    top: picture.top + ySV.value * ph,
    width: wSV.value * pw,
    height: hSV.value * ph,
  }));
  // Dimmed bands around the box: top, bottom, left, right.
  const dimTop = useAnimatedStyle(() => ({
    left: picture.left,
    top: picture.top,
    width: pw,
    height: ySV.value * ph,
  }));
  const dimBottom = useAnimatedStyle(() => ({
    left: picture.left,
    top: picture.top + (ySV.value + hSV.value) * ph,
    width: pw,
    height: (1 - ySV.value - hSV.value) * ph,
  }));
  const dimLeft = useAnimatedStyle(() => ({
    left: picture.left,
    top: picture.top + ySV.value * ph,
    width: xSV.value * pw,
    height: hSV.value * ph,
  }));
  const dimRight = useAnimatedStyle(() => ({
    left: picture.left + (xSV.value + wSV.value) * pw,
    top: picture.top + ySV.value * ph,
    width: (1 - xSV.value - wSV.value) * pw,
    height: hSV.value * ph,
  }));

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {[dimTop, dimBottom, dimLeft, dimRight].map((st, i) => (
        <Animated.View key={i} pointerEvents="none" style={[styles.dim, st]} />
      ))}
      <GestureDetector gesture={move}>
        <Animated.View style={[styles.box, boxStyle]}>
          {/* Rule-of-thirds grid */}
          <View
            pointerEvents="none"
            style={[styles.gridV, { left: "33.33%" }]}
          />
          <View
            pointerEvents="none"
            style={[styles.gridV, { left: "66.66%" }]}
          />
          <View
            pointerEvents="none"
            style={[styles.gridH, { top: "33.33%" }]}
          />
          <View
            pointerEvents="none"
            style={[styles.gridH, { top: "66.66%" }]}
          />
          {CORNERS.map((c) => (
            <GestureDetector key={c.key} gesture={cornerGesture(c.sx, c.sy)}>
              <View
                style={[
                  styles.handle,
                  // Inside the box: on Android a touch outside the parent
                  // view never reaches its children.
                  c.sx < 0 ? { left: 0 } : { right: 0 },
                  c.sy < 0 ? { top: 0 } : { bottom: 0 },
                ]}
              >
                <View
                  style={[
                    styles.mark,
                    c.sx < 0 ? { left: -1 } : { right: -1 },
                    c.sy < 0 ? { top: -1 } : { bottom: -1 },
                    {
                      borderLeftWidth: c.sx < 0 ? HANDLE_THICK : 0,
                      borderRightWidth: c.sx > 0 ? HANDLE_THICK : 0,
                      borderTopWidth: c.sy < 0 ? HANDLE_THICK : 0,
                      borderBottomWidth: c.sy > 0 ? HANDLE_THICK : 0,
                    },
                  ]}
                />
              </View>
            </GestureDetector>
          ))}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  dim: { position: "absolute", backgroundColor: DIM },
  box: {
    position: "absolute",
    borderWidth: 1,
    borderColor: "#FFFFFF",
  },
  gridV: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.5)",
  },
  gridH: {
    position: "absolute",
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.5)",
  },
  handle: {
    position: "absolute",
    width: HANDLE_TOUCH,
    height: HANDLE_TOUCH,
  },
  mark: {
    position: "absolute",
    width: HANDLE_MARK,
    height: HANDLE_MARK,
    borderColor: "#FFFFFF",
  },
});
