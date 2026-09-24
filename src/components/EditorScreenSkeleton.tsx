import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import Skeleton from "./Skeleton";

export default function EditorScreenSkeleton() {
  const colors = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
        <Skeleton width={32} height={32} borderRadius={16} />
        <View style={{ flex: 1 }} />
        <Skeleton
          width={90}
          height={32}
          borderRadius={16}
          style={styles.gap12}
        />
        <Skeleton width={100} height={40} borderRadius={20} />
      </View>

      <View style={styles.previewArea}>
        <Skeleton width="75%" height={PREVIEW_HEIGHT} borderRadius={16} />
      </View>

      <View style={styles.transportRow}>
        <Skeleton width={20} height={20} borderRadius={10} />
        <Skeleton width={20} height={20} borderRadius={10} />
        <Skeleton width={44} height={44} borderRadius={22} />
        <Skeleton width={20} height={20} borderRadius={10} />
        <Skeleton width={20} height={20} borderRadius={10} />
      </View>

      <View style={styles.toolbarRow}>
        {Array.from({ length: 5 }).map((_, i) => (
          <View key={i} style={styles.toolbarItem}>
            <Skeleton width={48} height={48} borderRadius={14} />
            <Skeleton
              width={36}
              height={8}
              borderRadius={4}
              style={styles.gap6}
            />
          </View>
        ))}
      </View>

      <View style={styles.timelineWrap}>
        <View style={styles.timelineTopRow}>
          <Skeleton width={80} height={14} borderRadius={4} />
          <View style={styles.zoomButtonsSkeleton}>
            <Skeleton width={28} height={28} borderRadius={8} />
            <Skeleton
              width={28}
              height={28}
              borderRadius={8}
              style={styles.gap6}
            />
          </View>
        </View>

        <Skeleton
          width="100%"
          height={16}
          borderRadius={4}
          style={styles.gap8}
        />
        <Skeleton
          width="100%"
          height={56}
          borderRadius={10}
          style={styles.gap4}
        />
        <Skeleton
          width="100%"
          height={56}
          borderRadius={10}
          style={styles.gap4}
        />
        <Skeleton
          width="100%"
          height={56}
          borderRadius={10}
          style={styles.gap4}
        />
      </View>
    </View>
  );
}

const PREVIEW_HEIGHT = 380;

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  topBar: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  gap4: { marginTop: 4 },
  gap6: { marginTop: 6 },
  gap8: { marginTop: 8 },
  gap12: { marginRight: 12 },
  previewArea: { alignItems: "center", paddingVertical: 8 },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
    paddingVertical: 12,
  },
  toolbarRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  toolbarItem: { alignItems: "center" },
  timelineWrap: { paddingTop: 12, paddingBottom: 24 },
  timelineTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: 34,
  },
  zoomButtonsSkeleton: { flexDirection: "row", alignItems: "center" },
});
