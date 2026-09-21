import { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  Image,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useTheme } from "../hooks/useTheme";
import AppText from "./AppText";

interface CustomTabBarProps {
  state: any;
  navigation: any;
}

interface TabConfigItem {
  solid: any;
  stroke: any;
  label: string;
}

const TAB_CONFIG: { [key: string]: TabConfigItem } = {
  edit: {
    solid: require("../../assets/icons/edit_icon.webp"),
    stroke: require("../../assets/icons/edit_icon.webp"),
    label: "Edit",
  },
  exports: {
    solid: require("../../assets/icons/export_solid_icon.webp"),
    stroke: require("../../assets/icons/export_stroke_icon.webp"),
    label: "Exports",
  },
  settings: {
    solid: require("../../assets/icons/settings_solid_icon.webp"),
    stroke: require("../../assets/icons/setting_stroke_icon.webp"),
    label: "Settings",
  },
};

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const BAR_HORIZONTAL_MARGIN = 20;
const BAR_WIDTH = SCREEN_WIDTH - BAR_HORIZONTAL_MARGIN * 2;
const DOT_SIZE = 8;

export default function CustomTabBar({ state, navigation }: CustomTabBarProps) {
  const colors = useTheme();
  const slotWidth = BAR_WIDTH / state.routes.length;

  const dotPosition = useRef(new Animated.Value(state.index)).current;

  useEffect(() => {
    Animated.spring(dotPosition, {
      toValue: state.index,
      useNativeDriver: false,
      friction: 8,
      tension: 60,
    }).start();
  }, [state.index]);

  const dotLeft = dotPosition.interpolate({
    inputRange: state.routes.map((_: any, i: number) => i),
    outputRange: state.routes.map(
      (_: any, i: number) => i * slotWidth + slotWidth / 2 - DOT_SIZE / 2,
    ),
  });

  return (
    <View style={styles.wrapper} pointerEvents="box-none">
      <Animated.View
        style={[
          styles.dot,
          { left: dotLeft, backgroundColor: colors.accentPurple },
        ]}
      />

      <View
        style={[
          styles.bar,
          { backgroundColor: colors.surface, width: BAR_WIDTH },
        ]}
      >
        {state.routes.map((route: any, index: number) => {
          const isActive = index === state.index;
          const config = TAB_CONFIG[route.name];
          const tint = isActive ? colors.accentPurple : colors.textMuted;
          const source = isActive ? config.solid : config.stroke;

          const onPress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!isActive && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          return (
            <TouchableOpacity
              key={route.key}
              onPress={onPress}
              style={[styles.slot, { width: slotWidth }]}
              activeOpacity={0.8}
            >
              <Image
                source={source}
                style={[
                  styles.icon,
                  {
                    tintColor: tint,
                    width: isActive ? 26 : 28,
                    height: isActive ? 26 : 28,
                  },
                ]}
                resizeMode="contain"
              />
              {isActive && (
                <AppText
                  style={[
                    styles.label,
                    { color: tint, fontFamily: "Poppins-Bold" },
                  ]}
                >
                  {config.label}
                </AppText>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    bottom: 24,
    left: BAR_HORIZONTAL_MARGIN,
    alignItems: "center",
  },
  bar: {
    flexDirection: "row",
    paddingVertical: 12,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "space-around",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  slot: {
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  icon: {},
  label: {
    fontSize: 12,
  },
  dot: {
    position: "absolute",
    top: -4,
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    zIndex: 2,
  },
});
