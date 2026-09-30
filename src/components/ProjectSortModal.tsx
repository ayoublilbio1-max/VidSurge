import { Ionicons } from "@expo/vector-icons";
import { Modal, Pressable, StyleSheet, TouchableOpacity } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { PROJECT_SORTS, type ProjectSort } from "../lib/homePrefs";
import AppText from "./AppText";

/** The filter button on Recent Projects: pick how the list is sorted. */
export default function ProjectSortModal({
  visible,
  value,
  onPick,
  onClose,
}: {
  visible: boolean;
  value: ProjectSort;
  onPick: (sort: ProjectSort) => void;
  onClose: () => void;
}) {
  const colors = useTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.card, { backgroundColor: colors.background }]}
        >
          <AppText style={[styles.title, { color: colors.textPrimary }]}>
            Sort projects
          </AppText>
          {PROJECT_SORTS.map((s) => {
            const active = s.key === value;
            return (
              <TouchableOpacity
                key={s.key}
                onPress={() => onPick(s.key)}
                style={[
                  styles.option,
                  {
                    backgroundColor: active
                      ? colors.accentPurple + "22"
                      : colors.surface,
                  },
                ]}
                accessibilityLabel={`Sort: ${s.label}`}
              >
                <Ionicons
                  name={s.icon}
                  size={19}
                  color={active ? colors.accentPurpleBright : colors.textMuted}
                />
                <AppText
                  style={[
                    styles.optionText,
                    {
                      color: active
                        ? colors.accentPurpleBright
                        : colors.textPrimary,
                    },
                  ]}
                >
                  {s.label}
                </AppText>
                {active && (
                  <Ionicons
                    name="checkmark"
                    size={20}
                    color={colors.accentPurpleBright}
                  />
                )}
              </TouchableOpacity>
            );
          })}
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
  card: { width: "100%", maxWidth: 360, borderRadius: 18, padding: 18, gap: 8 },
  title: { fontSize: 17, fontFamily: "Poppins-Bold", marginBottom: 6 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  optionText: { flex: 1, fontSize: 15, fontFamily: "Poppins-Medium" },
});
