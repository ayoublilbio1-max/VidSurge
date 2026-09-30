import { Ionicons } from "@expo/vector-icons";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";

/** Shape presets of the Crop tool. */
export type CropPreset = "free" | "9:16" | "16:9" | "1:1" | "4:5" | "3:4";

export const CROP_PRESETS: CropPreset[] = [
  "free",
  "9:16",
  "16:9",
  "1:1",
  "4:5",
  "3:4",
];

const SHAPE_BOX = 26;

/**
 * Bottom sheet for the Crop tool (whole video, nothing selected). The crop
 * box itself is on the preview (CropOverlay); this sheet has the shape
 * presets — Free and fixed ratios — and Reset (whole picture). On ✓ the
 * video's frame becomes the box. A draft until ✓ — one undo step.
 */
export default function CropSheet({
  preset,
  presetAspect,
  onPreset,
  onReset,
  onCancel,
  onDone,
}: {
  preset: CropPreset;
  /** Width ÷ height of each preset (for the little shape drawings). */
  presetAspect: (p: CropPreset) => number | null;
  onPreset: (p: CropPreset) => void;
  onReset: () => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const colors = useTheme();
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
          Crop
        </AppText>
        <TouchableOpacity
          onPress={onDone}
          hitSlop={10}
          accessibilityLabel="Apply"
        >
          <Ionicons name="checkmark" size={28} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <AppText style={[styles.note, { color: colors.textMuted }]}>
        The whole video is cut to the box — drag it to move, drag a corner to
        resize
      </AppText>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        <TouchableOpacity
          onPress={onReset}
          style={[styles.preset, { backgroundColor: colors.surface }]}
          accessibilityLabel="Reset crop"
        >
          <View style={styles.shapeBox}>
            <Ionicons
              name="refresh-outline"
              size={20}
              color={colors.textPrimary}
            />
          </View>
          <AppText style={[styles.label, { color: colors.textPrimary }]}>
            Reset
          </AppText>
        </TouchableOpacity>
        {CROP_PRESETS.map((p) => {
          const active = p === preset;
          const aspect = presetAspect(p);
          const fg = active ? "#FFFFFF" : colors.textPrimary;
          return (
            <TouchableOpacity
              key={p}
              onPress={() => {
                if (__DEV__) console.log(`[CropSheet] preset → ${p}`);
                onPreset(p);
              }}
              style={[
                styles.preset,
                {
                  backgroundColor: active
                    ? colors.accentPurple
                    : colors.surface,
                },
              ]}
              accessibilityLabel={`Crop ${p}`}
            >
              <View style={styles.shapeBox}>
                {aspect ? (
                  <View
                    style={[
                      styles.shape,
                      {
                        width: aspect >= 1 ? SHAPE_BOX : SHAPE_BOX * aspect,
                        height: aspect >= 1 ? SHAPE_BOX / aspect : SHAPE_BOX,
                        borderColor: fg,
                      },
                    ]}
                  />
                ) : (
                  <Ionicons name="crop-outline" size={20} color={fg} />
                )}
              </View>
              <AppText style={[styles.label, { color: fg }]}>
                {p === "free" ? "Free" : p}
              </AppText>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
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
  note: { fontSize: 12, textAlign: "center" },
  row: { gap: 10, paddingHorizontal: 14, alignItems: "center" },
  preset: {
    width: 66,
    height: 74,
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
  label: { fontSize: 12, fontWeight: "600" },
});
