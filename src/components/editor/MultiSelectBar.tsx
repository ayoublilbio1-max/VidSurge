import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";

const DISABLED_OPACITY = 0.4;

/**
 * The toolbar while multi-select is on (the timeline's ☑ button): how many
 * clips are picked, and what can be done to all of them — Duplicate,
 * Delete — plus Done (leave multi-select). Moving is done on the timeline:
 * press and hold a picked clip, then drag.
 */
export default function MultiSelectBar({
  count,
  onDuplicate,
  onDelete,
  onDone,
}: {
  count: number;
  onDuplicate: () => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const colors = useTheme();
  const none = count === 0;

  const item = (
    icon: keyof typeof Ionicons.glyphMap,
    label: string,
    onPress: () => void,
    disabled: boolean,
    tint?: string,
  ) => (
    <TouchableOpacity
      style={[styles.item, disabled && { opacity: DISABLED_OPACITY }]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
    >
      <View
        style={[styles.iconWrap, { backgroundColor: tint ?? colors.surface }]}
      >
        <Ionicons
          name={icon}
          size={20}
          color={tint ? "#FFFFFF" : colors.textPrimary}
        />
      </View>
      <AppText style={[styles.label, { color: colors.textMuted }]}>
        {label}
      </AppText>
    </TouchableOpacity>
  );

  return (
    <View style={styles.row}>
      <View style={styles.info}>
        <AppText style={[styles.count, { color: colors.textPrimary }]}>
          {none ? "Tap clips" : `${count} selected`}
        </AppText>
        <AppText
          style={[styles.hint, { color: colors.textMuted }]}
          numberOfLines={2}
        >
          {none ? "to pick them" : "Hold one and drag to move all"}
        </AppText>
      </View>
      {item("copy-outline", "Duplicate", onDuplicate, none)}
      {item("trash-outline", "Delete", onDelete, none)}
      {item("checkmark", "Done", onDone, false, colors.accentPurple)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 4,
    gap: 15,
  },
  info: { flex: 1, gap: 2 },
  count: { fontSize: 15, fontFamily: "Poppins-Medium" },
  hint: { fontSize: 11 },
  item: { alignItems: "center", gap: 6, width: 60 },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { fontSize: 10, textAlign: "center" },
});
