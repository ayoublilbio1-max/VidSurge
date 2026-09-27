import { StyleSheet, Text, View } from "react-native";
import type { TextClipData } from "../../editor/clipModel";
import { fontStyleFor } from "../../editor/fonts";

/** "#RRGGBB" + alpha (0–1) → "rgba(...)". */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

// Outline directions (unit steps). React Native can't stroke text, so the
// outline is the text drawn again in the stroke colour, shifted around it.
const RING_8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.707, 0.707],
  [-0.707, 0.707],
  [0.707, -0.707],
  [-0.707, -0.707],
];
const RING_16 = [
  ...RING_8,
  [0.924, 0.383],
  [-0.924, 0.383],
  [0.924, -0.383],
  [-0.924, -0.383],
  [0.383, 0.924],
  [-0.383, 0.924],
  [0.383, -0.924],
  [-0.383, -0.924],
];

/**
 * One styled text: shadow, outline, glow, box, opacity — the same drawing
 * for the preview, the style presets and (later) the export. Sizes in the
 * data are relative to the font size, so it looks the same at any size.
 */
export default function TextVisual({
  data,
  fontSize,
  maxWidth,
}: {
  data: TextClipData;
  fontSize: number;
  maxWidth?: number;
}) {
  const font = fontStyleFor(data.font);
  // No fixed lineHeight and Android's font padding kept ON: script fonts
  // (Pacifico, Dancing...) reach above/below the normal line, and a fixed
  // line height cut their tails off. Each font now gets its own natural
  // line height.
  const base = [font, { fontSize, textAlign: data.align }];
  // Room around the letters (script letters lean out sideways too).
  const padH = data.bgColor ? fontSize * 0.35 : fontSize * 0.2;
  const padV = data.bgColor ? fontSize * 0.12 : fontSize * 0.08;
  const stroke = data.strokeColor
    ? Math.max(1, data.strokeWidth * fontSize)
    : 0;
  const ring = stroke > 3 ? RING_16 : RING_8;
  const layer = (dx: number, dy: number) => ({
    position: "absolute" as const,
    left: padH + dx,
    right: padH - dx,
    top: padV + dy,
  });

  return (
    <View
      style={{
        opacity: data.opacity,
        maxWidth,
        paddingHorizontal: padH,
        paddingVertical: padV,
        backgroundColor: data.bgColor
          ? withAlpha(data.bgColor, data.bgOpacity)
          : "transparent",
        borderRadius: data.bgColor ? data.bgRadius * fontSize : 0,
      }}
    >
      {data.shadowColor && (
        <Text
          style={[
            base,
            layer(
              data.shadowDistance * fontSize,
              data.shadowDistance * fontSize,
            ),
            {
              color: data.shadowColor,
              textShadowColor: data.shadowColor,
              textShadowRadius: Math.max(0.1, data.shadowBlur * fontSize),
              textShadowOffset: { width: 0, height: 0 },
            },
          ]}
        >
          {data.text}
        </Text>
      )}
      {stroke > 0 &&
        ring.map(([ux, uy], i) => (
          <Text
            key={i}
            style={[
              base,
              layer(ux * stroke, uy * stroke),
              { color: data.strokeColor! },
            ]}
          >
            {data.text}
          </Text>
        ))}
      <Text
        style={[
          base,
          { color: data.color },
          data.glowColor
            ? {
                textShadowColor: data.glowColor,
                textShadowRadius: Math.max(1, data.glowRadius * fontSize),
                textShadowOffset: { width: 0, height: 0 },
              }
            : !data.bgColor && !data.strokeColor && !data.shadowColor
              ? styles.readable
              : null,
        ]}
      >
        {data.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Plain text with no style: a faint shadow keeps it readable on any
  // picture.
  readable: {
    textShadowColor: "rgba(0,0,0,0.45)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
