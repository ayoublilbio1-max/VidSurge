import { useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import AppText from "../components/AppText";
import { useTheme } from "../hooks/useTheme";

export default function EditorScreen() {
  const colors = useTheme();
  const { videoUri } = useLocalSearchParams<{ videoUri: string }>();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <AppText style={[styles.text, { color: colors.textPrimary }]}>
        Editor — coming soon
      </AppText>
      <AppText
        style={[styles.uri, { color: colors.textMuted }]}
        numberOfLines={2}
      >
        {videoUri}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  text: { fontSize: 18, fontFamily: "Poppins-Bold" },
  uri: { fontSize: 11, textAlign: "center" },
});
