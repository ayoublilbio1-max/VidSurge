// Settings screen (opened from the Account tab's gear).
//
// Real settings: the default export quality (used by every project that
// hasn't picked its own) and clearing the cache (temporary files only —
// projects and exports are kept). Language, rating and the legal pages are
// shown but not part of the demo.

import { Ionicons } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useEffect, useState, type ComponentProps } from "react";
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppText from "../components/AppText";
import DemoFeatureModal from "../components/editor/DemoFeatureModal";
import {
  EXPORT_FPS,
  EXPORT_RESOLUTIONS,
  resolutionLabel,
  type ExportFps,
  type ExportResolution,
} from "../editor/clipModel";
import { useTheme } from "../hooks/useTheme";
import {
  APP_VERSION,
  cacheSize,
  clearCache,
  defaultExport,
  FEEDBACK_EMAIL,
  formatBytes,
  setDefaultExport,
  subscribeAppPrefs,
} from "../lib/appPrefs";

type IconName = ComponentProps<typeof Ionicons>["name"];

/** Locked in the demo (same as the editor's export settings). */
const LOCKED_RESOLUTIONS: ExportResolution[] = [1440, 2160];

export default function AppSettingsScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [exportPref, setExportPref] = useState(defaultExport());
  const [qualityOpen, setQualityOpen] = useState(false);
  const [cache, setCache] = useState<number | null>(null);
  const [cacheNote, setCacheNote] = useState<string | null>(null);
  const [demoFeature, setDemoFeature] = useState<string | null>(null);

  useEffect(() => subscribeAppPrefs(() => setExportPref(defaultExport())), []);
  useEffect(() => {
    // Measured after the screen is shown (walks the cache folder).
    const t = setTimeout(() => {
      const size = cacheSize();
      setCache(size);
      if (__DEV__) console.log(`[settings] cache ${formatBytes(size)}`);
    }, 150);
    return () => clearTimeout(t);
  }, []);

  const onClearCache = () => {
    const freed = clearCache();
    setCache(cacheSize());
    setCacheNote(freed > 0 ? `${formatBytes(freed)} freed` : "Already clean");
  };

  const sendFeedback = () => {
    const url = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(`VidSurge feedback (${APP_VERSION})`)}`;
    void Linking.openURL(url).catch(() => setDemoFeature("Email feedback"));
  };

  const pickResolution = (r: ExportResolution) => {
    if (LOCKED_RESOLUTIONS.includes(r)) {
      setDemoFeature(`${resolutionLabel(r)} export`);
      return;
    }
    setDefaultExport({ ...exportPref, resolution: r });
  };
  const pickFps = (fps: ExportFps) => setDefaultExport({ ...exportPref, fps });

  const row = (
    label: string,
    onPress: (() => void) | null,
    right?: { text?: string; chevron?: boolean; icon?: IconName },
  ) => (
    <TouchableOpacity
      key={label}
      style={styles.row}
      onPress={onPress ?? undefined}
      disabled={!onPress}
      activeOpacity={0.7}
    >
      <AppText style={[styles.rowLabel, { color: colors.textPrimary }]}>
        {label}
      </AppText>
      {right?.text ? (
        <AppText style={[styles.rowValue, { color: colors.textMuted }]}>
          {right.text}
        </AppText>
      ) : null}
      {right?.icon ? (
        <Ionicons name={right.icon} size={18} color={colors.textMuted} />
      ) : null}
      {right?.chevron !== false && onPress ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      ) : null}
    </TouchableOpacity>
  );

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.background, paddingTop: insets.top },
      ]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={[styles.back, { backgroundColor: colors.surface }]}
          hitSlop={8}
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
        <AppText style={[styles.title, { color: colors.textPrimary }]}>
          Settings
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: 32 + insets.bottom },
        ]}
      >
        <AppText style={[styles.section, { color: colors.textPrimary }]}>
          Preferences
        </AppText>
        <View style={[styles.group, { backgroundColor: colors.surface }]}>
          {row("Default export quality", () => setQualityOpen(true), {
            text: `${resolutionLabel(exportPref.resolution)} · ${exportPref.fps}fps`,
          })}
          {row("App language", () => setDemoFeature("Changing the language"), {
            text: "English",
          })}
        </View>

        <AppText style={[styles.section, { color: colors.textPrimary }]}>
          Storage
        </AppText>
        <View style={[styles.group, { backgroundColor: colors.surface }]}>
          {row("Clear cache", onClearCache, {
            text: cacheNote ?? (cache === null ? "…" : formatBytes(cache)),
            chevron: false,
            icon: "trash-outline",
          })}
        </View>
        <AppText style={[styles.hint, { color: colors.textMuted }]}>
          Removes temporary files (thumbnails, text pictures). Your projects and
          exports are kept.
        </AppText>

        <AppText style={[styles.section, { color: colors.textPrimary }]}>
          Feedback & about
        </AppText>
        <View style={[styles.group, { backgroundColor: colors.surface }]}>
          {row("Send feedback", sendFeedback)}
          {row("Rate VidSurge", () => setDemoFeature("Rating"))}
          {row("Terms of use", () => setDemoFeature("Terms of use"))}
          {row("Privacy policy", () => setDemoFeature("Privacy policy"))}
          {row("Version", null, { text: APP_VERSION })}
        </View>

        <View style={styles.credit}>
          <AppText style={[styles.creditText, { color: colors.textMuted }]}>
            Developed with
          </AppText>
          <Ionicons name="heart" size={14} color="#FF5A5F" />
          <AppText style={[styles.creditText, { color: colors.textMuted }]}>
            by ayoubgharts
          </AppText>
        </View>
      </ScrollView>

      {/* Default export quality */}
      <Modal
        visible={qualityOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setQualityOpen(false)}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => setQualityOpen(false)}
        >
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.background }]}
          >
            <AppText style={[styles.sheetTitle, { color: colors.textPrimary }]}>
              Default export quality
            </AppText>
            <AppText
              style={[styles.hint, { color: colors.textMuted, marginTop: 0 }]}
            >
              Used by projects that haven't picked their own.
            </AppText>
            <AppText style={[styles.sheetLabel, { color: colors.textMuted }]}>
              Resolution
            </AppText>
            <View style={styles.options}>
              {EXPORT_RESOLUTIONS.map((r) => {
                const on = r === exportPref.resolution;
                const locked = LOCKED_RESOLUTIONS.includes(r);
                return (
                  <TouchableOpacity
                    key={r}
                    onPress={() => pickResolution(r)}
                    style={[
                      styles.option,
                      {
                        backgroundColor: on
                          ? colors.accentPurple
                          : colors.surface,
                      },
                    ]}
                  >
                    {locked ? (
                      <Ionicons
                        name="lock-closed"
                        size={12}
                        color={colors.accentPurple}
                      />
                    ) : null}
                    <AppText
                      style={[
                        styles.optionText,
                        { color: on ? "#FFFFFF" : colors.textPrimary },
                      ]}
                    >
                      {resolutionLabel(r)}
                    </AppText>
                  </TouchableOpacity>
                );
              })}
            </View>
            <AppText style={[styles.sheetLabel, { color: colors.textMuted }]}>
              Frame rate
            </AppText>
            <View style={styles.options}>
              {EXPORT_FPS.map((fps) => {
                const on = fps === exportPref.fps;
                return (
                  <TouchableOpacity
                    key={fps}
                    onPress={() => pickFps(fps)}
                    style={[
                      styles.option,
                      {
                        backgroundColor: on
                          ? colors.accentPurple
                          : colors.surface,
                      },
                    ]}
                  >
                    <AppText
                      style={[
                        styles.optionText,
                        { color: on ? "#FFFFFF" : colors.textPrimary },
                      ]}
                    >
                      {fps} fps
                    </AppText>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity
              onPress={() => setQualityOpen(false)}
              style={[styles.done, { backgroundColor: colors.accentPurple }]}
            >
              <AppText style={styles.doneText}>Done</AppText>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <DemoFeatureModal
        feature={demoFeature}
        onClose={() => setDemoFeature(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  back: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 18, fontFamily: "Poppins-Bold", lineHeight: 26 },
  content: { paddingHorizontal: 16, paddingTop: 8 },
  section: {
    fontSize: 16,
    fontFamily: "Poppins-Bold",
    marginTop: 18,
    marginBottom: 8,
    lineHeight: 22,
  },
  group: { borderRadius: 16, paddingHorizontal: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 54 },
  rowLabel: { flex: 1, fontSize: 15, lineHeight: 21 },
  rowValue: { fontSize: 13, lineHeight: 18 },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  credit: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    marginTop: 28,
  },
  creditText: { fontSize: 13, lineHeight: 18 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    paddingBottom: 28,
    gap: 6,
  },
  sheetTitle: { fontSize: 17, fontFamily: "Poppins-Bold", lineHeight: 24 },
  sheetLabel: {
    fontSize: 12,
    fontFamily: "Poppins-Medium",
    marginTop: 12,
    lineHeight: 16,
  },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  optionText: { fontSize: 14, fontFamily: "Poppins-Medium", lineHeight: 20 },
  done: {
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 18,
  },
  doneText: { color: "#FFFFFF", fontSize: 15, fontFamily: "Poppins-Bold" },
});
