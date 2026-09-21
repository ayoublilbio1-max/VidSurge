import { router } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { hasCompletedOnboarding } from "../lib/onboardingStorage";

export default function Index() {
  const colors = useTheme();

  useEffect(() => {
    (async () => {
      const completed = await hasCompletedOnboarding();
      router.replace(completed ? "/(tabs)/edit" : "/onboarding");
    })();
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]} />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
