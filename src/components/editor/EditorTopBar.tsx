import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";

interface EditorTopBarProps {
  resolution: string;
  onBack: () => void;
  onHelp: () => void;
  onResolutionPress: () => void;
  onExportPress: () => void;
}

export default function EditorTopBar({
  resolution,
  onBack,
  onHelp,
  onResolutionPress,
  onExportPress,
}: EditorTopBarProps) {
  const colors = useTheme();

  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <TouchableOpacity
          onPress={onBack}
          style={[styles.iconButton, { backgroundColor: colors.surface }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onHelp}
          style={[styles.iconButton, { backgroundColor: colors.surface }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons
            name="help-circle-outline"
            size={20}
            color={colors.textPrimary}
          />
        </TouchableOpacity>
      </View>

      <View style={styles.right}>
        <TouchableOpacity
          onPress={onResolutionPress}
          style={[styles.resolutionButton, { backgroundColor: colors.surface }]}
        >
          <AppText
            style={[styles.resolutionText, { color: colors.textPrimary }]}
          >
            {resolution}
          </AppText>
          <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onExportPress}
          style={[
            styles.exportButton,
            { backgroundColor: colors.accentPurple },
          ]}
        >
          <Ionicons name="share-outline" size={16} color="#FFFFFF" />
          <AppText style={styles.exportText}>Export</AppText>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 8,
  },
  left: { flexDirection: "row", gap: 10 },
  right: { flexDirection: "row", alignItems: "center", gap: 10 },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  resolutionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  resolutionText: { fontSize: 13, fontFamily: "Poppins-Medium" },
  exportButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  exportText: { color: "#FFFFFF", fontSize: 14, fontFamily: "Poppins-Bold" },
});
