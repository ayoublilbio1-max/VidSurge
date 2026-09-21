import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import AppText from "../../components/AppText";
import ComingSoonModal from "../../components/ComingSoonModal";
import GradientActionCard from "../../components/GradientActionCard";
import { useTheme } from "../../hooks/useTheme";

export default function EditScreen() {
  const colors = useTheme();
  const [comingSoonVisible, setComingSoonVisible] = useState(false);

  const handleNewVideo = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      allowsEditing: false,
      quality: 1,
    });

    if (!result.canceled && result.assets?.[0]?.uri) {
      router.push({
        pathname: "/editor",
        params: { videoUri: result.assets[0].uri },
      });
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <TouchableOpacity
        style={[styles.badge, { backgroundColor: colors.badgeBackground }]}
        onPress={() => router.push("/upgrade")}
      >
        <Ionicons name="diamond-outline" size={14} color={colors.accentGreen} />
        <AppText style={[styles.badgeText, { color: colors.textPrimary }]}>
          Standard
        </AppText>
      </TouchableOpacity>

      <View style={styles.cardsRow}>
        <GradientActionCard
          icon="add"
          label="New video"
          onPress={handleNewVideo}
        />
        <GradientActionCard
          icon="image-outline"
          label="Edit photo"
          onPress={() => setComingSoonVisible(true)}
        />
        <GradientActionCard
          icon="grid-outline"
          label="Collage"
          onPress={() => setComingSoonVisible(true)}
        />
      </View>

      <View style={styles.projectsHeader}>
        <AppText style={[styles.projectsTitle, { color: colors.textMuted }]}>
          Recent Projects
        </AppText>
        <TouchableOpacity
          onPress={() => setComingSoonVisible(true)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="filter-outline" size={20} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      <View style={styles.emptyState}>
        <Ionicons name="film-outline" size={40} color={colors.iconInactive} />
        <AppText style={[styles.emptyText, { color: colors.textMuted }]}>
          Your projects will appear here.{"\n"}Start creating now.
        </AppText>
      </View>

      <ComingSoonModal
        visible={comingSoonVisible}
        onClose={() => setComingSoonVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, paddingTop: 56 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    marginBottom: 16,
  },
  badgeText: { fontSize: 13, fontFamily: "Poppins-Medium" },
  cardsRow: { flexDirection: "row", gap: 10, marginBottom: 32 },
  projectsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  projectsTitle: { fontSize: 20, fontFamily: "Poppins-Bold" },
  emptyState: { alignItems: "center", paddingTop: 40, gap: 16 },
  emptyText: { fontSize: 14, textAlign: "center", lineHeight: 20 },
});
