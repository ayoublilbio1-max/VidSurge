import { StyleSheet, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import Skeleton from "./Skeleton";

export default function EditScreenSkeleton() {
  const colors = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Skeleton
        width={110}
        height={32}
        borderRadius={20}
        style={styles.badge}
      />

      <View style={styles.cardsRow}>
        <Skeleton width="31%" height={100} borderRadius={20} />
        <Skeleton width="31%" height={100} borderRadius={20} />
        <Skeleton width="31%" height={100} borderRadius={20} />
      </View>

      <View style={styles.projectsHeader}>
        <Skeleton width={140} height={22} borderRadius={6} />
        <Skeleton width={20} height={20} borderRadius={10} />
      </View>

      <View style={styles.projectsList}>
        <Skeleton
          width="100%"
          height={72}
          borderRadius={16}
          style={styles.listItem}
        />
        <Skeleton
          width="100%"
          height={72}
          borderRadius={16}
          style={styles.listItem}
        />
        <Skeleton
          width="100%"
          height={72}
          borderRadius={16}
          style={styles.listItem}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, paddingTop: 56 },
  badge: { marginBottom: 16, alignSelf: "flex-start" },
  cardsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  projectsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  projectsList: { gap: 12 },
  listItem: {},
});
