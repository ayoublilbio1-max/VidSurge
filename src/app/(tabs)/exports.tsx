import { StyleSheet, View } from "react-native";
import AppText from "../../components/AppText";
import { useTheme } from "../../hooks/useTheme";

export default function ExportsScreen() {
  const colors = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <AppText style={[styles.text, { color: colors.textMuted }]}>
        Your exported videos will show up here.
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
  },
  text: { fontSize: 14, textAlign: "center" },
});
