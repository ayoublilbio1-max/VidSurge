import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import {
    Modal,
    Pressable,
    StyleSheet,
    TouchableOpacity,
    View,
} from "react-native";
import { useTheme } from "../hooks/useTheme";
import AppText from "./AppText";

type IconName = ComponentProps<typeof Ionicons>["name"];

const DANGER = "#FF5A5F";

/**
 * "Are you sure?" in the app's own look (not the phone's alert): an icon, a
 * title, a message, Cancel + a confirm button (red when destructive).
 */
export default function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel = "Delete",
  destructive = true,
  icon = "trash-outline",
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  icon?: IconName;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const colors = useTheme();
  const tint = destructive ? DANGER : colors.accentPurple;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable
          style={[styles.card, { backgroundColor: colors.background }]}
        >
          <View
            style={[
              styles.icon,
              {
                backgroundColor: destructive
                  ? "rgba(255,90,95,0.14)"
                  : colors.surface,
              },
            ]}
          >
            <Ionicons name={icon} size={24} color={tint} />
          </View>
          <AppText style={[styles.title, { color: colors.textPrimary }]}>
            {title}
          </AppText>
          <AppText style={[styles.message, { color: colors.textMuted }]}>
            {message}
          </AppText>
          <View style={styles.buttons}>
            <TouchableOpacity
              onPress={onCancel}
              style={[styles.button, { backgroundColor: colors.surface }]}
            >
              <AppText
                style={[styles.buttonText, { color: colors.textPrimary }]}
              >
                Cancel
              </AppText>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onConfirm}
              style={[styles.button, { backgroundColor: tint }]}
            >
              <AppText style={[styles.buttonText, { color: "#FFFFFF" }]}>
                {confirmLabel}
              </AppText>
            </TouchableOpacity>
          </View>
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
    padding: 28,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 18,
    padding: 18,
    gap: 10,
  },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  title: {
    fontSize: 17,
    fontFamily: "Poppins-Bold",
    textAlign: "center",
    lineHeight: 24,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 4,
  },
  buttons: { flexDirection: "row", gap: 10, marginTop: 4 },
  button: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 15, fontFamily: "Poppins-Medium" },
});
