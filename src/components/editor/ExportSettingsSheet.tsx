import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import {
    EXPORT_FPS,
    EXPORT_RESOLUTIONS,
    estimateExportBytes,
    exportFrameSize,
    resolutionLabel,
    type ExportFps,
    type ExportResolution,
    type ExportSettings,
} from "../../editor/clipModel";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";

/** 14_600_000 → "~15 MB", 820_000 → "~0.8 MB". */
function formatSize(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb < 1) return `~${Math.max(0.1, Math.round(mb * 10) / 10)} MB`;
  if (mb < 1000) return `~${Math.round(mb)} MB`;
  return `~${(mb / 1000).toFixed(1)} GB`;
}

/**
 * The "1080P" button's sheet: export resolution and frame rate, with the
 * output size in pixels and a rough file size. A draft until ✓ (one undo
 * step); ✕ / Android back leaves it as it was.
 */
export default function ExportSettingsSheet({
  value,
  frameAspect,
  duration,
  sourceShortSide,
  lockedResolutions,
  onLockedPress,
  onChange,
  onCancel,
  onDone,
}: {
  value: ExportSettings;
  /** Width ÷ height of the project's frame (canvas / crop). */
  frameAspect: number;
  /** Length of the edit (seconds), for the size estimate. */
  duration: number;
  /** The main video's short side in pixels (null = unknown). */
  sourceShortSide: number | null;
  /** Resolutions not in this demo build: shown with a lock, not selectable. */
  lockedResolutions: ExportResolution[];
  /** A locked resolution was tapped (the editor shows "not in the demo"). */
  onLockedPress: (label: string) => void;
  onChange: (next: ExportSettings) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const colors = useTheme();
  const { width, height } = exportFrameSize(value, frameAspect);
  const bytes = estimateExportBytes(value, frameAspect, duration);
  const upscaled =
    sourceShortSide !== null && value.resolution > sourceShortSide + 8;

  const chip = (active: boolean) => [
    styles.chip,
    { backgroundColor: active ? colors.accentPurple : colors.surface },
  ];
  const chipText = (active: boolean) => [
    styles.chipText,
    { color: active ? "#FFFFFF" : colors.textPrimary },
  ];

  return (
    <View style={[styles.sheet, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onCancel}
          hitSlop={10}
          accessibilityLabel="Cancel"
        >
          <Ionicons name="close" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <AppText style={[styles.title, { color: colors.textPrimary }]}>
          Export quality
        </AppText>
        <TouchableOpacity
          onPress={onDone}
          hitSlop={10}
          accessibilityLabel="Apply"
        >
          <Ionicons name="checkmark" size={28} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <AppText style={[styles.sectionLabel, { color: colors.textMuted }]}>
        Resolution
      </AppText>
      <View style={styles.row}>
        {EXPORT_RESOLUTIONS.map((r: ExportResolution) => {
          const active = r === value.resolution;
          const locked = lockedResolutions.includes(r);
          return (
            <TouchableOpacity
              key={r}
              onPress={() => {
                if (locked) {
                  if (__DEV__)
                    console.log(
                      `[ExportSettingsSheet] ${resolutionLabel(r)} — not in the demo`,
                    );
                  onLockedPress(`Export in ${resolutionLabel(r)}`);
                  return;
                }
                if (__DEV__)
                  console.log(
                    `[ExportSettingsSheet] resolution → ${resolutionLabel(r)}`,
                  );
                onChange({ ...value, resolution: r });
              }}
              style={chip(active)}
              accessibilityLabel={`Resolution ${resolutionLabel(r)}${locked ? " (not in the demo)" : ""}`}
            >
              <AppText style={chipText(active)}>{resolutionLabel(r)}</AppText>
              {locked && (
                <View
                  style={[
                    styles.lockBadge,
                    { backgroundColor: colors.accentPurple },
                  ]}
                >
                  <Ionicons name="lock-closed" size={9} color="#FFFFFF" />
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      <AppText style={[styles.sectionLabel, { color: colors.textMuted }]}>
        Frame rate
      </AppText>
      <View style={styles.row}>
        {EXPORT_FPS.map((f: ExportFps) => {
          const active = f === value.fps;
          return (
            <TouchableOpacity
              key={f}
              onPress={() => {
                if (__DEV__)
                  console.log(`[ExportSettingsSheet] frame rate → ${f}`);
                onChange({ ...value, fps: f });
              }}
              style={chip(active)}
              accessibilityLabel={`${f} frames per second`}
            >
              <AppText style={chipText(active)}>{f} fps</AppText>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={[styles.infoBox, { backgroundColor: colors.surface }]}>
        <View style={styles.infoRow}>
          <AppText style={[styles.infoLabel, { color: colors.textMuted }]}>
            Video size
          </AppText>
          <AppText style={[styles.infoValue, { color: colors.textPrimary }]}>
            {width} × {height}
          </AppText>
        </View>
        <View style={styles.infoRow}>
          <AppText style={[styles.infoLabel, { color: colors.textMuted }]}>
            File size
          </AppText>
          <AppText style={[styles.infoValue, { color: colors.textPrimary }]}>
            {formatSize(bytes)}
          </AppText>
        </View>
      </View>

      {upscaled && (
        <AppText style={[styles.note, { color: colors.textMuted }]}>
          Your video is {sourceShortSide}p — a higher resolution makes the file
          bigger, not sharper.
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 12,
    paddingBottom: 28,
    paddingHorizontal: 16,
    gap: 10,
    elevation: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 16, fontWeight: "600" },
  sectionLabel: { fontSize: 13, marginTop: 4 },
  row: { flexDirection: "row", gap: 8 },
  chip: {
    flex: 1,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: { fontSize: 14, fontWeight: "600" },
  // Same little purple lock as the demo-locked tools in the toolbar.
  lockBadge: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 15,
    height: 15,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  infoBox: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 6,
    marginTop: 4,
  },
  infoRow: { flexDirection: "row", justifyContent: "space-between" },
  infoLabel: { fontSize: 13 },
  infoValue: { fontSize: 13, fontWeight: "600" },
  note: { fontSize: 12, textAlign: "center", lineHeight: 17 },
});
