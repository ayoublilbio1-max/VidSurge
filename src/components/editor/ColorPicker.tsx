import { useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";
import SliderBar from "./SliderBar";

// ---- HSV ↔ hex --------------------------------------------------------------

export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const to = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(f(5))}${to(f(3))}${to(f(1))}`.toUpperCase();
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const c = hex.replace("#", "");
  const r = (parseInt(c.slice(0, 2), 16) || 0) / 255;
  const g = (parseInt(c.slice(2, 4), 16) || 0) / 255;
  const b = (parseInt(c.slice(4, 6), 16) || 0) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

const STEPS = 24;
const HUE_SEGMENTS = Array.from({ length: 36 }, (_, i) =>
  hsvToHex((i / 35) * 360, 1, 1),
);

/**
 * Any colour, shown in place of the Styles panel (no pop-up): Hue
 * (rainbow), Saturation and Brightness sliders. The text changes live while
 * you slide; Cancel puts the old colour back, Done keeps the new one.
 */
export default function ColorPicker({
  initial,
  onChange,
  onDone,
  onCancel,
}: {
  initial: string;
  onChange: (hex: string) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const colors = useTheme();
  const [hsv, setHsv] = useState(() => hexToHsv(initial));
  const hex = hsvToHex(hsv.h, hsv.s, hsv.v);

  const update = (next: { h: number; s: number; v: number }) => {
    setHsv(next);
    onChange(hsvToHex(next.h, next.s, next.v));
  };
  // Starting from white / grey / black, moving the hue alone changes
  // nothing (no saturation) — so the first hue move also turns the colour
  // on (full saturation, visible brightness).
  const setHue = (f: number) =>
    update({
      h: f * 360,
      s: hsv.s < 0.1 ? 1 : hsv.s,
      v: hsv.v < 0.2 ? 1 : hsv.v,
    });

  const satSegments = Array.from({ length: STEPS }, (_, i) =>
    hsvToHex(hsv.h, i / (STEPS - 1), Math.max(hsv.v, 0.15)),
  );
  const valSegments = Array.from({ length: STEPS }, (_, i) =>
    hsvToHex(hsv.h, hsv.s, i / (STEPS - 1)),
  );

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onCancel} hitSlop={8}>
          <AppText style={{ color: colors.textMuted }}>Cancel</AppText>
        </TouchableOpacity>
        <View style={styles.previewRow}>
          <View style={[styles.preview, { backgroundColor: hex }]} />
          <AppText style={[styles.hex, { color: colors.textPrimary }]}>
            {hex}
          </AppText>
        </View>
        <TouchableOpacity onPress={onDone} hitSlop={8}>
          <AppText style={{ color: colors.accentPurple, fontWeight: "600" }}>
            Done
          </AppText>
        </TouchableOpacity>
      </View>

      {[
        {
          label: "Hue",
          value: hsv.h / 360,
          set: setHue,
          segments: HUE_SEGMENTS,
        },
        {
          label: "Saturation",
          value: hsv.s,
          set: (f: number) => update({ ...hsv, s: f }),
          segments: satSegments,
        },
        {
          label: "Brightness",
          value: hsv.v,
          set: (f: number) => update({ ...hsv, v: f }),
          segments: valSegments,
        },
      ].map((row) => (
        <View key={row.label} style={styles.row}>
          <AppText style={[styles.label, { color: colors.textMuted }]}>
            {row.label}
          </AppText>
          <SliderBar
            value={row.value}
            onChange={row.set}
            trackColor={colors.surface}
            fillColor={colors.accentPurple}
            segments={row.segments}
            accessibilityLabel={row.label}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { paddingHorizontal: 14, paddingTop: 14, gap: 10 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  preview: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.6)",
  },
  hex: { fontSize: 16, fontWeight: "600", letterSpacing: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  label: { width: 76, fontSize: 13 },
});
