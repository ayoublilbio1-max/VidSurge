import { Ionicons } from "@expo/vector-icons";
import {
  Canvas,
  Circle,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  vec,
} from "@shopify/react-native-skia";
import { useState } from "react";
import {
  LayoutChangeEvent,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useTheme } from "../hooks/useTheme";
import AppText from "./AppText";

interface GradientActionCardProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}

export default function GradientActionCard({
  icon,
  label,
  onPress,
}: GradientActionCardProps) {
  const colors = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  };

  const { width: w, height: h } = size;
  const swooshPath =
    w > 0 && h > 0
      ? `M0,${h * 0.78} C${w * 0.32},${h * 0.5} ${w * 0.55},${h * 1.0} ${w},${h * 0.42} L${w},${h} L0,${h} Z`
      : "";

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.accentPurpleDeep }]}
      onPress={onPress}
      onLayout={onLayout}
      activeOpacity={0.85}
    >
      {w > 0 && h > 0 && (
        <Canvas style={StyleSheet.absoluteFill}>
          <Rect x={0} y={0} width={w} height={h}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(w, h)}
              colors={[colors.gradientStart, colors.gradientEnd]}
            />
          </Rect>

          <Path path={swooshPath} color="white" opacity={0.08} />

          <Circle cx={w * 0.18} cy={h * 0.15} r={w * 0.55}>
            <RadialGradient
              c={vec(w * 0.18, h * 0.15)}
              r={w * 0.55}
              colors={["rgba(255,255,255,0.22)", "rgba(255,255,255,0)"]}
            />
          </Circle>
        </Canvas>
      )}

      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <Ionicons name={icon} size={18} color={colors.accentPurpleDeep} />
        </View>
        <AppText style={styles.label}>{label}</AppText>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 20,
    overflow: "hidden",
    paddingVertical: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    color: "#FFFFFF",
    fontFamily: "Poppins-Bold",
    fontSize: 12,
    textAlign: "center",
  },
});
