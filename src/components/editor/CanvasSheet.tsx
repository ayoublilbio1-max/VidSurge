import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import {
  CANVAS_RATIOS,
  canvasAspect,
  type CanvasRatio,
  type CanvasSettings,
} from "../../editor/clipModel";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";
import ColorPicker from "./ColorPicker";

type Tab = "ratio" | "background";

const SWATCHES = [
  "#000000",
  "#FFFFFF",
  "#3A3A3A",
  "#7A7A7A",
  "#BDBDBD",
  "#FFE600",
  "#FF9500",
  "#FF3B30",
  "#FF2D92",
  "#AF52DE",
  "#0A84FF",
  "#0AF5FF",
  "#34C759",
];

// Size of the little frame-shape drawing on each ratio button.
const SHAPE_BOX = 30;

/**
 * Bottom sheet for the Canvas tool (nothing selected): the shape of the
 * whole video (Ratio tab) and the colour behind the pictures (Background
 * tab, swatches + any colour). Every clip is shown whole inside the frame
 * ("fit"); Crop will let a clip zoom in to fill it. A draft until ✓ — one
 * undo step.
 */
export default function CanvasSheet({
  value,
  videoAspect,
  onChange,
  onCancel,
  onDone,
}: {
  value: CanvasSettings;
  /** The video's own width ÷ height, for drawing the "Original" shape. */
  videoAspect: number | null;
  onChange: (c: CanvasSettings) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const colors = useTheme();
  const [tab, setTab] = useState<Tab>("ratio");
  // The colour before the picker opened (its Cancel puts it back).
  const [pickerStart, setPickerStart] = useState<string | null>(null);
  const pickerOpen = pickerStart !== null;

  // Picking a ratio removes the Crop tool's crop (whole picture again, in
  // that shape).
  const setRatio = (ratio: CanvasRatio) => {
    if (__DEV__)
      console.log(
        `[CanvasSheet] ratio → ${ratio}${value.crop ? " (crop removed)" : ""}`,
      );
    onChange({ ...value, ratio, crop: null });
  };
  const setBackground = (background: string) =>
    onChange({ ...value, background });

  const renderRatio = () => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {value.crop && (
        // The video is cropped: its frame is the crop's shape.
        <View
          style={[styles.ratioButton, { backgroundColor: colors.accentPurple }]}
          accessibilityLabel="Frame from Crop"
        >
          <View style={styles.shapeBox}>
            <Ionicons name="crop-outline" size={22} color="#FFFFFF" />
          </View>
          <AppText style={[styles.ratioLabel, { color: "#FFFFFF" }]}>
            Crop
          </AppText>
        </View>
      )}
      {CANVAS_RATIOS.map((r) => {
        const active = !value.crop && r === value.ratio;
        const aspect = canvasAspect(r, videoAspect);
        const w = aspect >= 1 ? SHAPE_BOX : SHAPE_BOX * aspect;
        const h = aspect >= 1 ? SHAPE_BOX / aspect : SHAPE_BOX;
        return (
          <TouchableOpacity
            key={r}
            onPress={() => setRatio(r)}
            style={[
              styles.ratioButton,
              {
                backgroundColor: active ? colors.accentPurple : colors.surface,
              },
            ]}
            accessibilityLabel={`Frame ${r}`}
          >
            <View style={styles.shapeBox}>
              <View
                style={[
                  styles.shape,
                  {
                    width: w,
                    height: h,
                    borderColor: active ? "#FFFFFF" : colors.textPrimary,
                  },
                ]}
              />
            </View>
            <AppText
              style={[
                styles.ratioLabel,
                { color: active ? "#FFFFFF" : colors.textPrimary },
              ]}
            >
              {r === "original" ? "Original" : r}
            </AppText>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );

  const renderBackground = () =>
    pickerOpen ? (
      <ColorPicker
        initial={value.background}
        onChange={setBackground}
        onDone={() => {
          if (__DEV__)
            console.log(
              `[CanvasSheet] background → ${value.background} (picker)`,
            );
          setPickerStart(null);
        }}
        onCancel={() => {
          setBackground(pickerStart ?? value.background);
          setPickerStart(null);
        }}
      />
    ) : (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        <TouchableOpacity
          onPress={() => {
            if (__DEV__) console.log("[CanvasSheet] colour picker open");
            setPickerStart(value.background);
          }}
          style={styles.rainbow}
          accessibilityLabel="Pick any colour"
        >
          {[
            "#FF3B30",
            "#FF9500",
            "#FFE600",
            "#34C759",
            "#0A84FF",
            "#AF52DE",
          ].map((c) => (
            <View key={c} style={{ flex: 1, backgroundColor: c }} />
          ))}
        </TouchableOpacity>
        {SWATCHES.map((c) => {
          const active = value.background.toUpperCase() === c;
          return (
            <TouchableOpacity
              key={c}
              onPress={() => {
                if (__DEV__) console.log(`[CanvasSheet] background → ${c}`);
                setBackground(c);
              }}
              style={[
                styles.swatch,
                {
                  backgroundColor: c,
                  borderColor: active
                    ? colors.textPrimary
                    : "rgba(255,255,255,0.15)",
                  borderWidth: active ? 3 : 1,
                },
              ]}
              accessibilityLabel={`Background ${c}`}
            />
          );
        })}
      </ScrollView>
    );

  return (
    <View style={[styles.sheet, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onCancel}
          hitSlop={10}
          accessibilityLabel="Cancel"
        >
          <Ionicons name="close" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <AppText style={[styles.title, { color: colors.textPrimary }]}>
          Canvas
        </AppText>
        <TouchableOpacity
          onPress={onDone}
          hitSlop={10}
          accessibilityLabel="Apply"
        >
          <Ionicons name="checkmark" size={28} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabs}>
        {(["ratio", "background"] as Tab[]).map((t) => {
          const active = t === tab;
          return (
            <TouchableOpacity
              key={t}
              onPress={() => {
                setTab(t);
                setPickerStart(null);
              }}
              style={styles.tab}
            >
              <AppText
                style={[
                  styles.tabLabel,
                  { color: active ? colors.textPrimary : colors.textMuted },
                ]}
              >
                {t === "ratio" ? "Ratio" : "Background"}
              </AppText>
              <View
                style={[
                  styles.tabUnderline,
                  {
                    backgroundColor: active
                      ? colors.accentPurple
                      : "transparent",
                  },
                ]}
              />
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.body}>
        {tab === "ratio" ? renderRatio() : renderBackground()}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 12,
    paddingBottom: 28,
    gap: 10,
    elevation: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  title: { fontSize: 16, fontWeight: "600" },
  tabs: { flexDirection: "row", justifyContent: "center", gap: 28 },
  tab: { alignItems: "center", gap: 6 },
  tabLabel: { fontSize: 15, fontWeight: "600" },
  tabUnderline: { width: 28, height: 3, borderRadius: 2 },
  body: { minHeight: 90, justifyContent: "center" },
  row: { gap: 10, paddingHorizontal: 14, alignItems: "center" },
  ratioButton: {
    width: 72,
    height: 78,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  shapeBox: {
    width: SHAPE_BOX,
    height: SHAPE_BOX,
    alignItems: "center",
    justifyContent: "center",
  },
  shape: { borderWidth: 2, borderRadius: 3 },
  ratioLabel: { fontSize: 12, fontWeight: "600" },
  rainbow: {
    width: 34,
    height: 34,
    borderRadius: 17,
    overflow: "hidden",
    flexDirection: "row",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  swatch: { width: 34, height: 34, borderRadius: 17 },
});
