import { Ionicons } from "@expo/vector-icons";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";

export interface EditorTool {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}

/**
 * State of the Lock button, from the current selection:
 *   none     — nothing selected: greyed out, closed lock, "Lock"
 *   locked   — the selected clip is locked to its partner: active, tap to
 *              unlock (one-way, there is no re-lock)
 *   unlocked — the selected clip was already unlocked: greyed out, open
 *              lock, "Unlocked"
 */
export type LockMode = "none" | "locked" | "unlocked";

const DISABLED_OPACITY = 0.4;

const TOOLS: EditorTool[] = [
  { key: "delete", icon: "trash-outline", label: "Delete" },
  { key: "crop", icon: "crop-outline", label: "Crop" },
  { key: "addText", icon: "text-outline", label: "Add text" },
  { key: "split", icon: "cut-outline", label: "Split" },
  { key: "voiceRecord", icon: "mic-outline", label: "Voice record" },
  { key: "rotate", icon: "refresh-outline", label: "Rotate" },
  { key: "more", icon: "ellipsis-horizontal", label: "More" },
];

interface EditorToolbarProps {
  lockMode: LockMode;
  onUnlock: () => void;
  onToolPress: (key: string) => void;
}

export default function EditorToolbar({
  lockMode,
  onUnlock,
  onToolPress,
}: EditorToolbarProps) {
  const colors = useTheme();
  const lockActive = lockMode === "locked";

  const handleLockPress = () => {
    if (__DEV__)
      console.log(
        `[EditorToolbar] lock button pressed (${lockMode}${lockActive ? " — unlocking" : " — disabled"})`,
      );
    if (lockActive) onUnlock();
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      <TouchableOpacity
        style={[styles.item, !lockActive && { opacity: DISABLED_OPACITY }]}
        onPress={handleLockPress}
        disabled={!lockActive}
        accessibilityRole="button"
        accessibilityState={{ disabled: !lockActive }}
        accessibilityLabel={
          lockActive ? "Unlock audio from video" : "Lock (select a locked clip)"
        }
      >
        <View
          style={[
            styles.iconWrap,
            {
              backgroundColor: lockActive
                ? colors.accentPurple
                : colors.surface,
            },
          ]}
        >
          <Ionicons
            name={
              lockMode === "unlocked"
                ? "lock-open-outline"
                : "lock-closed-outline"
            }
            size={20}
            color={lockActive ? "#FFFFFF" : colors.textPrimary}
          />
        </View>
        <AppText style={[styles.label, { color: colors.textMuted }]}>
          {lockMode === "locked"
            ? "Locked"
            : lockMode === "unlocked"
              ? "Unlocked"
              : "Lock"}
        </AppText>
      </TouchableOpacity>

      {TOOLS.map((tool) => (
        <TouchableOpacity
          key={tool.key}
          style={styles.item}
          onPress={() => onToolPress(tool.key)}
        >
          <View style={[styles.iconWrap, { backgroundColor: colors.surface }]}>
            <Ionicons name={tool.icon} size={20} color={colors.textPrimary} />
          </View>
          <AppText style={[styles.label, { color: colors.textMuted }]}>
            {tool.label}
          </AppText>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, gap: 15, paddingVertical: 4 },
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
