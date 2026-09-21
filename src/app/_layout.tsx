import { useFonts } from "expo-font";
import { NavigationBar } from "expo-navigation-bar";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useState } from "react";
import { Platform, useColorScheme } from "react-native";
import AppSplashOverlay from "../components/AppSplashOverlay";
import { darkColors, lightColors } from "../constants/colors";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const scheme = useColorScheme();
  const [showOverlay, setShowOverlay] = useState(true);

  const [fontsLoaded] = useFonts({
    "Poppins-Light": require("../../assets/fonts/Poppins-Light.ttf"),
    "Poppins-Regular": require("../../assets/fonts/Poppins-Regular.ttf"),
    "Poppins-Medium": require("../../assets/fonts/Poppins-Medium.ttf"),
    "Poppins-Bold": require("../../assets/fonts/Poppins-Bold.ttf"),
  });

  useEffect(() => {
    const colors = scheme === "light" ? lightColors : darkColors;
    SystemUI.setBackgroundColorAsync(colors.background);
    if (Platform.OS === "android") {
      NavigationBar.setStyle(scheme === "light" ? "dark" : "light");
    }
  }, [scheme]);

  useEffect(() => {
    if (Platform.OS === "android") {
      NavigationBar.setHidden(true);
    }
  }, []);

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <>
      <StatusBar style={scheme === "light" ? "dark" : "light"} />
      <Stack screenOptions={{ headerShown: false }} />
      {showOverlay && (
        <AppSplashOverlay onFinish={() => setShowOverlay(false)} />
      )}
    </>
  );
}
