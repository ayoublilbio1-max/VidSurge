import { NavigationBar } from "expo-navigation-bar";
import { Stack } from "expo-router";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { Platform, useColorScheme } from "react-native";
import { darkColors, lightColors } from "../constants/colors";

export default function RootLayout() {
  const scheme = useColorScheme();

  useEffect(() => {
    const colors = scheme === "light" ? lightColors : darkColors;

    SystemUI.setBackgroundColorAsync(colors.background);

    if (Platform.OS === "android") {
      NavigationBar.setStyle(scheme === "light" ? "dark" : "light");
    }
  }, [scheme]);

  return <Stack screenOptions={{ headerShown: false }} />;
}
