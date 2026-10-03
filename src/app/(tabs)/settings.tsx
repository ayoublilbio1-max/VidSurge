// Account tab ("Me"): the user's corner of the app, like CapCut's.
//
// Demo: sign-in isn't part of this version (tapping it explains that); the
// plan card opens the Upgrade screen (visual). The numbers (projects,
// exports) are real. The gear opens Settings.

import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState, type ComponentProps } from "react";
import {
  Linking,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppText from "../../components/AppText";
import DemoFeatureModal from "../../components/editor/DemoFeatureModal";
import { useTheme } from "../../hooks/useTheme";
import { APP_VERSION, FEEDBACK_EMAIL } from "../../lib/appPrefs";
import { loadExports } from "../../lib/exportsStorage";
import { loadProjects } from "../../lib/projectsStorage";

type IconName = ComponentProps<typeof Ionicons>["name"];

const PLAN_PERKS: { icon: IconName; label: string }[] = [
  { icon: "film-outline", label: "2K export" },
  { icon: "water-outline", label: "No watermark" },
  { icon: "color-filter-outline", label: "Filters" },
  { icon: "mic-outline", label: "Voice" },
];

export default function AccountScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<number | null>(null);
  const [exports, setExports] = useState<number | null>(null);
  const [demoFeature, setDemoFeature] = useState<string | null>(null);

  // Fresh numbers every time the tab is shown.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        try {
          const [p, e] = await Promise.all([loadProjects(), loadExports()]);
          if (!alive) return;
          setProjects(p.length);
          setExports(e.length);
          if (__DEV__)
            console.log(
              `[account] ${p.length} project(s), ${e.length} export(s)`,
            );
        } catch (err) {
          if (__DEV__)
            console.log("[account] couldn't count projects / exports", err);
        }
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  const sendFeedback = () => {
    const url = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(`VidSurge feedback (${APP_VERSION})`)}`;
    if (__DEV__) console.log("[account] send feedback");
    void Linking.openURL(url).catch(() => setDemoFeature("Email feedback"));
  };

  const row = (
    icon: IconName,
    label: string,
    onPress: () => void,
    detail?: string,
  ) => (
    <TouchableOpacity
      key={label}
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.rowIcon, { backgroundColor: colors.surface }]}>
        <Ionicons name={icon} size={20} color={colors.textPrimary} />
      </View>
      <AppText style={[styles.rowLabel, { color: colors.textPrimary }]}>
        {label}
      </AppText>
      {detail ? (
        <AppText style={[styles.rowDetail, { color: colors.textMuted }]}>
          {detail}
        </AppText>
      ) : null}
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </TouchableOpacity>
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 12 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.topRow}>
          <TouchableOpacity
            style={[
              styles.offerPill,
              { backgroundColor: colors.badgeBackground },
            ]}
            onPress={() => router.push("/upgrade")}
            activeOpacity={0.8}
          >
            <Ionicons
              name="gift-outline"
              size={16}
              color={colors.accentPurpleBright}
            />
            <AppText style={[styles.offerText, { color: colors.textPrimary }]}>
              7 days of Standard free
            </AppText>
            <Ionicons
              name="chevron-forward"
              size={14}
              color={colors.textMuted}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push("/app-settings")}
            hitSlop={10}
            style={[styles.gear, { backgroundColor: colors.surface }]}
            accessibilityLabel="Settings"
          >
            <Ionicons
              name="settings-outline"
              size={22}
              color={colors.textPrimary}
            />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.profile}
          activeOpacity={0.8}
          onPress={() => setDemoFeature("Sign in")}
        >
          <View style={[styles.avatar, { backgroundColor: colors.surface }]}>
            <Ionicons name="person" size={40} color={colors.textMuted} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText style={[styles.signIn, { color: colors.textPrimary }]}>
              Tap to sign in
            </AppText>
            <View style={styles.signInSubRow}>
              <AppText style={[styles.signInSub, { color: colors.textMuted }]}>
                to sync your projects on all your devices
              </AppText>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        {/* Plan card */}
        <View
          style={[styles.planCard, { backgroundColor: colors.gradientEnd }]}
        >
          <View
            style={[styles.planBlob, { backgroundColor: colors.gradientStart }]}
          />
          <View
            style={[
              styles.planBlob2,
              { backgroundColor: "#22D3EE", opacity: 0.25 },
            ]}
          />
          <View style={styles.planHead}>
            <View style={{ flex: 1 }}>
              <View style={styles.planTitleRow}>
                <Ionicons name="diamond" size={18} color="#22D3EE" />
                <AppText style={styles.planTitle}>Standard</AppText>
              </View>
              <AppText style={styles.planSub}>You're on the free plan</AppText>
            </View>
            <TouchableOpacity
              style={styles.trialButton}
              onPress={() => router.push("/upgrade")}
              activeOpacity={0.85}
            >
              <AppText style={styles.trialButtonText}>Get free trial</AppText>
            </TouchableOpacity>
          </View>
          <View style={styles.perks}>
            {PLAN_PERKS.map((p) => (
              <TouchableOpacity
                key={p.label}
                style={styles.perk}
                onPress={() => router.push("/upgrade")}
                activeOpacity={0.8}
              >
                <Ionicons name={p.icon} size={24} color="#FFFFFF" />
                <AppText style={styles.perkText}>{p.label}</AppText>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Real numbers */}
        <View style={styles.stats}>
          <TouchableOpacity
            style={[styles.stat, { backgroundColor: colors.surface }]}
            onPress={() => router.push("/edit")}
            activeOpacity={0.8}
          >
            <AppText style={[styles.statNumber, { color: colors.textPrimary }]}>
              {projects ?? "–"}
            </AppText>
            <AppText style={[styles.statLabel, { color: colors.textMuted }]}>
              Projects
            </AppText>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.stat, { backgroundColor: colors.surface }]}
            onPress={() => router.push("/exports")}
            activeOpacity={0.8}
          >
            <AppText style={[styles.statNumber, { color: colors.textPrimary }]}>
              {exports ?? "–"}
            </AppText>
            <AppText style={[styles.statLabel, { color: colors.textMuted }]}>
              Exports
            </AppText>
          </TouchableOpacity>
        </View>

        <View style={styles.list}>
          {row("book-outline", "Guide", () => router.push("/guide"))}
          {row("chatbubble-ellipses-outline", "Send feedback", sendFeedback)}
          {row("star-outline", "Rate VidSurge", () => setDemoFeature("Rating"))}
          {row(
            "settings-outline",
            "Settings",
            () => router.push("/app-settings"),
            APP_VERSION,
          )}
        </View>
      </ScrollView>

      <DemoFeatureModal
        feature={demoFeature}
        onClose={() => setDemoFeature(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  offerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    flexShrink: 1,
  },
  offerText: { fontSize: 13, fontFamily: "Poppins-Medium", lineHeight: 18 },
  gear: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  profile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginTop: 22,
  },
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  signIn: { fontSize: 20, fontFamily: "Poppins-Bold", lineHeight: 28 },
  signInSubRow: { marginTop: 2 },
  signInSub: { fontSize: 13, lineHeight: 18 },
  planCard: {
    marginTop: 24,
    borderRadius: 22,
    padding: 18,
    overflow: "hidden",
  },
  planBlob: {
    position: "absolute",
    width: 240,
    height: 240,
    borderRadius: 120,
    top: -120,
    right: -70,
  },
  planBlob2: {
    position: "absolute",
    width: 160,
    height: 160,
    borderRadius: 80,
    bottom: -80,
    left: -40,
  },
  planHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  planTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  planTitle: {
    fontSize: 19,
    fontFamily: "Poppins-Bold",
    color: "#FFFFFF",
    lineHeight: 26,
  },
  planSub: { fontSize: 12, color: "#FFFFFFB0", marginTop: 2, lineHeight: 16 },
  trialButton: {
    backgroundColor: "#0C0D17",
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 12,
    justifyContent: "center",
  },
  trialButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontFamily: "Poppins-Bold",
    lineHeight: 20,
  },
  perks: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 20,
  },
  perk: { alignItems: "center", gap: 6, flex: 1 },
  perkText: { fontSize: 12, color: "#FFFFFFD0", lineHeight: 16 },
  stats: { flexDirection: "row", gap: 12, marginTop: 16 },
  stat: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
  },
  statNumber: { fontSize: 22, fontFamily: "Poppins-Bold", lineHeight: 30 },
  statLabel: { fontSize: 12, lineHeight: 16 },
  list: { marginTop: 22, gap: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Poppins-Medium",
    lineHeight: 22,
  },
  rowDetail: { fontSize: 12, lineHeight: 16 },
});
