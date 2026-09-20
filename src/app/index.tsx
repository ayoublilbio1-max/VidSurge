import { router } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { hasCompletedOnboarding } from "../lib/onboardingStorage";

export default function Index() {
  const colors = useTheme();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      const completed = await hasCompletedOnboarding();
      if (!completed) {
        router.replace("/onboarding");
      } else {
        setChecking(false);
      }
    })();
  }, []);

  if (checking) {
    return (
      <View
        style={[styles.container, { backgroundColor: colors.background }]}
      />
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.text, { color: colors.textPrimary }]}>VidSurge</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { fontSize: 24, fontWeight: "600" },
});
