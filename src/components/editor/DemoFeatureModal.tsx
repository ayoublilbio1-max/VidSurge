import { Ionicons } from "@expo/vector-icons";
import {
    Modal,
    Pressable,
    StyleSheet,
    TouchableOpacity,
    View,
} from "react-native";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";

/**
 * Shown for tools that are not part of this demo build (Voice record,
 * Effects, Filter): the feature exists in the full app — contact the
 * developer to get it.
 */
export default function DemoFeatureModal({
  feature,
  onClose,
}: {
  /** The tool's name, or null when hidden. */
  feature: string | null;
  onClose: () => void;
}) {
  const colors = useTheme();
  return (
    <Modal
      visible={feature !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.card, { backgroundColor: colors.background }]}
        >
          <View style={[styles.icon, { backgroundColor: colors.surface }]}>
            <Ionicons
              name="lock-closed-outline"
              size={26}
              color={colors.accentPurple}
            />
          </View>
          <AppText style={[styles.title, { color: colors.textPrimary }]}>
            Not in the demo
          </AppText>
          <AppText style={[styles.body, { color: colors.textMuted }]}>
            {feature ?? "This feature"} isn't included in this demo version. To
            get it, please contact the developer.
          </AppText>
          <TouchableOpacity
            onPress={onClose}
            style={[styles.button, { backgroundColor: colors.accentPurple }]}
            accessibilityRole="button"
          >
            <AppText style={styles.buttonText}>OK</AppText>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  card: {
    width: "100%",
    maxWidth: 340,
    borderRadius: 18,
    padding: 22,
    alignItems: "center",
    gap: 10,
  },
  icon: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 18, fontWeight: "700" },
  body: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  button: {
    marginTop: 6,
    paddingHorizontal: 32,
    height: 42,
    borderRadius: 21,
    justifyContent: "center",
  },
  buttonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
});
