import { useEffect, useState } from "react";
import {
    Modal,
    Pressable,
    StyleSheet,
    TouchableOpacity,
    View,
} from "react-native";
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
 * Pick any colour: Hue (rainbow), Saturation and Brightness sliders, with a
 * live preview and the hex code. Opens from the rainbow circle in Styles.
 */
export default function ColorPickerModal({
  visible,
  initial,
  onCancel,
  onPick,
}: {
  visible: boolean;
  initial: string;
  onCancel: () => void;
  onPick: (hex: string) => void;
}) {
  const colors = useTheme();
  const [hsv, setHsv] = useState(() => hexToHsv(initial));
  useEffect(() => {
    if (visible) setHsv(hexToHsv(initial));
  }, [visible, initial]);
  const hex = hsvToHex(hsv.h, hsv.s, hsv.v);

  const satSegments = Array.from({ length: STEPS }, (_, i) =>
    hsvToHex(hsv.h, i / (STEPS - 1), Math.max(hsv.v, 0.15)),
  );
  const valSegments = Array.from({ length: STEPS }, (_, i) =>
    hsvToHex(hsv.h, hsv.s, i / (STEPS - 1)),
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable
          style={[styles.card, { backgroundColor: colors.background }]}
          onPress={() => {}}
        >
          <View style={styles.previewRow}>
            <View style={[styles.preview, { backgroundColor: hex }]} />
            <AppText style={[styles.hex, { color: colors.textPrimary }]}>
              {hex}
            </AppText>
          </View>

          <AppText style={[styles.label, { color: colors.textMuted }]}>
            Hue
          </AppText>
          <SliderBar
            value={hsv.h / 360}
            onChange={(f) => setHsv((c) => ({ ...c, h: f * 360 }))}
            trackColor={colors.surface}
            fillColor={colors.accentPurple}
            segments={HUE_SEGMENTS}
            accessibilityLabel="Hue"
          />
          <AppText style={[styles.label, { color: colors.textMuted }]}>
            Saturation
          </AppText>
          <SliderBar
            value={hsv.s}
            onChange={(f) => setHsv((c) => ({ ...c, s: f }))}
            trackColor={colors.surface}
            fillColor={colors.accentPurple}
            segments={satSegments}
            accessibilityLabel="Saturation"
          />
          <AppText style={[styles.label, { color: colors.textMuted }]}>
            Brightness
          </AppText>
          <SliderBar
            value={hsv.v}
            onChange={(f) => setHsv((c) => ({ ...c, v: f }))}
            trackColor={colors.surface}
            fillColor={colors.accentPurple}
            segments={valSegments}
            accessibilityLabel="Brightness"
          />

          <View style={styles.buttons}>
            <TouchableOpacity onPress={onCancel} style={styles.button}>
              <AppText style={{ color: colors.textMuted }}>Cancel</AppText>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onPick(hex)}
              style={[styles.button, { backgroundColor: colors.accentPurple }]}
            >
              <AppText style={styles.applyText}>Apply</AppText>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: 24,
  },
  card: { borderRadius: 18, padding: 18, gap: 6 },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 6,
  },
  preview: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.6)",
  },
  hex: { fontSize: 18, fontWeight: "600", letterSpacing: 1 },
  label: { fontSize: 12, marginTop: 4 },
  buttons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
    marginTop: 12,
  },
  button: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12 },
  applyText: { color: "#FFFFFF", fontWeight: "600" },
});
