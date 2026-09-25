import { Ionicons } from "@expo/vector-icons";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";

export interface EditorTool {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}

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
  audioLocked: boolean;
  onToggleAudioLock: () => void;
  onToolPress: (key: string) => void;
}

export default function EditorToolbar({
  audioLocked,
  onToggleAudioLock,
  onToolPress,
}: EditorToolbarProps) {
  const colors = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      <TouchableOpacity style={styles.item} onPress={onToggleAudioLock}>
        <View
          style={[
            styles.iconWrap,
            {
              backgroundColor: audioLocked
                ? colors.accentPurple
                : colors.surface,
            },
          ]}
        >
          <Ionicons
            name={audioLocked ? "lock-closed-outline" : "lock-open-outline"}
            size={20}
            color={audioLocked ? "#FFFFFF" : colors.textPrimary}
          />
        </View>
        <AppText style={[styles.label, { color: colors.textMuted }]}>
          {audioLocked ? "Locked" : "Unlocked"}
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
