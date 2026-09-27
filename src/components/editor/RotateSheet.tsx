import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { normalizeRotation } from "../../editor/clipModel";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";
import SliderBar from "./SliderBar";

// The free slider snaps to 0 / ±90 / 180° within this many degrees, so the
// straight angles are easy to hit.
const SNAP_DEGREES = 3;

export type RotateDraft = { angle: number; flip: boolean };

function snapAngle(deg: number): number {
  for (const target of [-180, -90, 0, 90, 180]) {
    if (Math.abs(deg - target) <= SNAP_DEGREES) return target;
  }
  return Math.round(deg);
}

/**
 * Bottom sheet for the Rotate tool (video clips): ↺ / ↻ turn the picture
 * by 90°, Flip mirrors it left↔right, and the slider sets any angle from
 * −180° to 180°. The picture always stays whole inside the frame (it is
 * shrunk to fit when turned). A draft until ✓ — one undo step.
 */
export default function RotateSheet({
  angle,
  flip,
  onChange,
  onCancel,
  onDone,
}: {
  angle: number;
  flip: boolean;
  onChange: (d: RotateDraft) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const colors = useTheme();

  const turn = (by: number) => {
    const next = normalizeRotation(angle + by);
    if (__DEV__)
      console.log(`[RotateSheet] turn ${by > 0 ? "+" : ""}${by}° → ${next}°`);
    onChange({ angle: next, flip });
  };

  const buttons: {
    key: string;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    active?: boolean;
    onPress: () => void;
  }[] = [
    {
      key: "left",
      icon: "arrow-undo-outline",
      label: "−90°",
      onPress: () => turn(-90),
    },
    {
      key: "right",
      icon: "arrow-redo-outline",
      label: "+90°",
      onPress: () => turn(90),
    },
    {
      key: "flip",
      icon: "swap-horizontal-outline",
      label: "Flip",
      active: flip,
      onPress: () => {
        if (__DEV__)
          console.log(`[RotateSheet] flip → ${!flip ? "on" : "off"}`);
        onChange({ angle, flip: !flip });
      },
    },
    {
      key: "reset",
      icon: "refresh-outline",
      label: "Reset",
      onPress: () => {
        if (__DEV__) console.log("[RotateSheet] reset");
        onChange({ angle: 0, flip: false });
      },
    },
  ];

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
          Rotate
        </AppText>
        <TouchableOpacity
          onPress={onDone}
          hitSlop={10}
          accessibilityLabel="Apply"
        >
          <Ionicons name="checkmark" size={28} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <AppText style={[styles.value, { color: colors.textPrimary }]}>
        {angle}°
      </AppText>
      <AppText style={[styles.note, { color: colors.textMuted }]}>
        {flip ? "Flipped left ↔ right" : " "}
      </AppText>

      <View style={styles.buttons}>
        {buttons.map((b) => (
          <TouchableOpacity
            key={b.key}
            onPress={b.onPress}
            style={styles.button}
            accessibilityLabel={b.label}
          >
            <View
              style={[
                styles.buttonIcon,
                {
                  backgroundColor: b.active
                    ? colors.accentPurple
                    : colors.surface,
                },
              ]}
            >
              <Ionicons
                name={b.icon}
                size={22}
                color={b.active ? "#FFFFFF" : colors.textPrimary}
              />
            </View>
            <AppText style={[styles.buttonLabel, { color: colors.textMuted }]}>
              {b.label}
            </AppText>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.sliderRow}>
        <AppText style={[styles.edge, { color: colors.textMuted }]}>
          −180°
        </AppText>
        <SliderBar
          value={(angle + 180) / 360}
          onChange={(f) =>
            onChange({
              angle: normalizeRotation(snapAngle(f * 360 - 180)),
              flip,
            })
          }
          trackColor={colors.surface}
          fillColor={colors.accentPurple}
          accessibilityLabel="Angle"
        />
        <AppText style={[styles.edge, { color: colors.textMuted }]}>
          180°
        </AppText>
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
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 28,
    gap: 8,
    elevation: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 16, fontWeight: "600" },
  value: { fontSize: 30, fontWeight: "700", textAlign: "center", marginTop: 4 },
  note: { fontSize: 12, textAlign: "center" },
  buttons: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 4,
  },
  button: { alignItems: "center", gap: 4, minWidth: 64 },
  buttonIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonLabel: { fontSize: 12 },
  sliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
  },
  edge: { fontSize: 11, width: 40, textAlign: "center" },
});
