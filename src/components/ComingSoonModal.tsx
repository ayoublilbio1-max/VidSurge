import { Modal, StyleSheet, TouchableOpacity, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import AppText from "./AppText";

interface ComingSoonModalProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
}

export default function ComingSoonModal({
  visible,
  onClose,
  title = "Coming soon",
  message = "This feature isn't ready yet. We're working on it!",
}: ComingSoonModalProps) {
  const colors = useTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <AppText style={[styles.title, { color: colors.textPrimary }]}>
            {title}
          </AppText>
          <AppText style={[styles.message, { color: colors.textMuted }]}>
            {message}
          </AppText>

          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.accentPurple }]}
            onPress={onClose}
          >
            <AppText style={styles.buttonText}>Got it</AppText>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  card: { width: "100%", borderRadius: 20, padding: 24, alignItems: "center" },
  title: { fontSize: 18, fontFamily: "Poppins-Bold", marginBottom: 8 },
  message: {
    fontSize: 14,
    textAlign: "center",
    marginBottom: 20,
    lineHeight: 20,
  },
  button: { paddingVertical: 12, paddingHorizontal: 32, borderRadius: 14 },
  buttonText: { color: "#FFFFFF", fontFamily: "Poppins-Bold", fontSize: 15 },
});
