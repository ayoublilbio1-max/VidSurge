import { useEffect, useRef } from "react";
import { Animated, Dimensions, Image, StyleSheet } from "react-native";
import { useTheme } from "../hooks/useTheme";

const LOGO = require("../../assets/images/logo.png");
const { width: screenWidth } = Dimensions.get("window");

const logoSource = Image.resolveAssetSource(LOGO);
const logoWidth = screenWidth * 0.55;
const logoHeight = logoWidth * (logoSource.height / logoSource.width);

export default function AppSplashOverlay({
  onFinish,
}: {
  onFinish: () => void;
}) {
  const colors = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start(() => {
        onFinish();
      });
    }, 900);

    return () => clearTimeout(timer);
  }, []);

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        styles.overlay,
        { backgroundColor: colors.background, opacity },
      ]}
      pointerEvents="none"
    >
      <Image
        source={LOGO}
        resizeMode="contain"
        style={{ width: logoWidth, height: logoHeight }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    alignItems: "center",
    justifyContent: "center",
    zIndex: 999,
  },
});
