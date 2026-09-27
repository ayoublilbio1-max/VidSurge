import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { MAX_SPEED, MAX_VOLUME, MIN_SPEED } from "../../editor/projectReducer";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";
import SliderBar from "./SliderBar";

export type ClipSettingKind = "speed" | "volume" | "opacity";

// Speed has two separate sliders (two tabs): "Speed" 1×–10× and "Slow
// motion" 0.1×–1×. Both are logarithmic (each step feels the same), and
// snap to their presets so the round values are easy to hit.
type SpeedTab = "fast" | "slow";
const SPEED_RANGES: Record<
  SpeedTab,
  { label: string; min: number; max: number; presets: number[] }
> = {
  fast: {
    label: "Speed",
    min: 1,
    max: MAX_SPEED,
    presets: [1, 1.5, 2, 3, 5, 10],
  },
  slow: {
    label: "Slow motion",
    min: MIN_SPEED,
    max: 1,
    presets: [0.1, 0.2, 0.25, 0.5, 0.75, 1],
  },
};
const toSlider = (v: number, min: number, max: number) =>
  Math.log(Math.max(min, Math.min(max, v)) / min) / Math.log(max / min);
const fromSlider = (f: number, min: number, max: number, presets: number[]) => {
  const raw = min * Math.pow(max / min, f);
  for (const p of presets) {
    if (Math.abs(raw - p) / p < 0.04) return p;
  }
  return Math.round(raw * 100) / 100;
};

const VOLUME_PRESETS = [0, 0.5, 1, 1.5, 2];
const OPACITY_PRESETS = [0, 0.25, 0.5, 0.75, 1];

// Volume and Opacity: a plain linear 0…max slider shown in percent.
const PERCENT_SETTINGS = {
  volume: { title: "Volume", max: MAX_VOLUME, presets: VOLUME_PRESETS },
  opacity: { title: "Opacity", max: 1, presets: OPACITY_PRESETS },
} as const;

function noteFor(kind: ClipSettingKind, value: number, sourceLength: number) {
  if (kind === "speed")
    return `Duration ${sourceLength.toFixed(1)}s → ${(sourceLength / value).toFixed(1)}s`;
  if (kind === "volume")
    return value > 1
      ? "Above 100%: the boost is heard in the exported video"
      : value === 0
        ? "Muted"
        : " ";
  return value === 0 ? "Invisible — the black background shows" : " ";
}

/**
 * Bottom sheet for one clip setting (Speed, Volume or Opacity): a big value, a
 * slider, quick presets, ✓ to apply and ✕ to cancel. The value is a draft
 * until ✓ — one undo step per change.
 */
export default function ClipSettingsSheet({
  kind,
  value,
  sourceLength,
  onChange,
  onCancel,
  onDone,
}: {
  kind: ClipSettingKind;
  value: number;
  /** Speed only: the clip's length in its source (s), to show the result. */
  sourceLength: number;
  onChange: (v: number) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const colors = useTheme();
  const isSpeed = kind === "speed";
  // Which speed slider shows: slow motion if the clip is already slowed.
  const [tab, setTab] = useState<SpeedTab>(value < 1 ? "slow" : "fast");
  const range = SPEED_RANGES[tab];
  const percent = kind === "speed" ? null : PERCENT_SETTINGS[kind];
  const presets: readonly number[] = percent ? percent.presets : range.presets;
  const maxValue = percent ? percent.max : range.max;
  const label = isSpeed ? `${value}×` : `${Math.round(value * 100)}%`;

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
          {percent ? percent.title : "Speed"}
        </AppText>
        <TouchableOpacity
          onPress={onDone}
          hitSlop={10}
          accessibilityLabel="Apply"
        >
          <Ionicons name="checkmark" size={28} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {isSpeed && (
        <View style={styles.tabs}>
          {(["fast", "slow"] as SpeedTab[]).map((t) => {
            const active = t === tab;
            return (
              <TouchableOpacity
                key={t}
                onPress={() => {
                  setTab(t);
                  // Switching slider: bring the value into its range.
                  const r = SPEED_RANGES[t];
                  if (value < r.min || value > r.max) onChange(1);
                }}
                style={styles.tab}
              >
                <AppText
                  style={[
                    styles.tabLabel,
                    { color: active ? colors.textPrimary : colors.textMuted },
                  ]}
                >
                  {SPEED_RANGES[t].label}
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
      )}

      <AppText style={[styles.value, { color: colors.textPrimary }]}>
        {label}
      </AppText>
      <AppText style={[styles.note, { color: colors.textMuted }]}>
        {noteFor(kind, value, sourceLength)}
      </AppText>

      <View style={styles.sliderRow}>
        <AppText style={[styles.edge, { color: colors.textMuted }]}>
          {isSpeed ? `${range.min}×` : "0%"}
        </AppText>
        <SliderBar
          value={
            isSpeed ? toSlider(value, range.min, range.max) : value / maxValue
          }
          onChange={(f) =>
            onChange(
              isSpeed
                ? fromSlider(f, range.min, range.max, range.presets)
                : Math.round(f * maxValue * 100) / 100,
            )
          }
          trackColor={colors.surface}
          fillColor={colors.accentPurple}
          accessibilityLabel={percent ? percent.title : range.label}
        />
        <AppText style={[styles.edge, { color: colors.textMuted }]}>
          {isSpeed ? `${range.max}×` : `${Math.round(maxValue * 100)}%`}
        </AppText>
      </View>

      <View style={styles.presets}>
        {presets.map((p) => {
          const active = Math.abs(p - value) < 1e-6;
          return (
            <TouchableOpacity
              key={p}
              onPress={() => onChange(p)}
              style={[
                styles.preset,
                {
                  backgroundColor: active
                    ? colors.accentPurple
                    : colors.surface,
                },
              ]}
            >
              <AppText
                style={{
                  color: active ? "#FFFFFF" : colors.textPrimary,
                  fontSize: 13,
                }}
              >
                {isSpeed ? `${p}×` : `${Math.round(p * 100)}%`}
              </AppText>
            </TouchableOpacity>
          );
        })}
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
  sliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
  },
  edge: { fontSize: 11, width: 36, textAlign: "center" },
  presets: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 6,
  },
  tabs: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 28,
    marginTop: 4,
  },
  tab: { alignItems: "center", gap: 6 },
  tabLabel: { fontSize: 15, fontWeight: "600" },
  tabUnderline: { width: 28, height: 3, borderRadius: 2 },
  preset: {
    paddingHorizontal: 14,
    height: 32,
    borderRadius: 16,
    justifyContent: "center",
  },
});
