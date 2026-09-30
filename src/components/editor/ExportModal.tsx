import { Ionicons } from "@expo/vector-icons";
import { File } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import {
  cancelExport,
  exportVideo,
  onExportProgress,
  type ExportPlan,
  type ExportResult,
} from "../../../modules/vidsurge-engine";
import { useTheme } from "../../hooks/useTheme";
import { allowSleep, keepScreenOn } from "../../lib/keepAwake";
import AppText from "../AppText";

type Phase =
  | { kind: "exporting" }
  | { kind: "saving" }
  | { kind: "done"; result: ExportResult; inGallery: boolean }
  | { kind: "error"; message: string };

function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb < 1 ? `${Math.round(bytes / 1000)} KB` : `${mb.toFixed(1)} MB`;
}

/** Deletes the texts / stickers pictures made for this export. */
function deleteOverlayFiles(plan: ExportPlan) {
  for (const o of plan.overlays) {
    try {
      const f = new File(o.uri);
      if (f.exists) f.delete();
    } catch (e) {
      if (__DEV__) console.log("[export] couldn't delete", o.uri, e);
    }
  }
}

/**
 * The export screen: "Preparing…" while the texts / stickers are drawn
 * (`preparing`), then progress (with Cancel) while the engine writes the
 * video, then it's saved to the gallery — Share / Done. The screen stays
 * on meanwhile. Opens when `preparing` or `plan` is set; `onClose` hides it.
 */
export default function ExportModal({
  plan,
  preparing,
  onClose,
}: {
  plan: ExportPlan | null;
  preparing: boolean;
  onClose: () => void;
}) {
  const colors = useTheme();
  const [phase, setPhase] = useState<Phase>({ kind: "exporting" });
  const [progress, setProgress] = useState(0);
  const cancelledRef = useRef(false);

  // A new export starts with a fresh screen (not the last one's result).
  useEffect(() => {
    if (!preparing) return;
    setPhase({ kind: "exporting" });
    setProgress(0);
  }, [preparing]);

  useEffect(() => {
    if (!plan) return;
    let alive = true;
    cancelledRef.current = false;
    setPhase({ kind: "exporting" });
    setProgress(0);
    keepScreenOn("export");
    const unsubscribe = onExportProgress((p) => {
      if (alive) setProgress(p);
    });
    const startedAt = Date.now();
    (async () => {
      try {
        const result = await exportVideo(plan);
        if (!alive) return;
        if (__DEV__)
          console.log(
            `[export] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${formatBytes(result.sizeBytes)}, ${(result.durationMs / 1000).toFixed(2)}s → ${result.uri}`,
          );
        setProgress(1);
        setPhase({ kind: "saving" });
        let inGallery = false;
        try {
          const MediaLibrary = await import("expo-media-library/legacy");
          const permission = await MediaLibrary.requestPermissionsAsync(true);
          if (permission.granted) {
            await MediaLibrary.saveToLibraryAsync(result.uri);
            inGallery = true;
          } else if (__DEV__) {
            console.log(
              "[export] gallery permission refused — kept in the app only",
            );
          }
        } catch (e) {
          if (__DEV__) console.log("[export] saving to the gallery failed", e);
        }
        if (alive) setPhase({ kind: "done", result, inGallery });
      } catch (e) {
        if (!alive) return;
        if (cancelledRef.current) {
          if (__DEV__) console.log("[export] cancelled");
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        if (__DEV__) console.log("[export] failed", message);
        setPhase({ kind: "error", message });
      } finally {
        allowSleep("export");
        deleteOverlayFiles(plan);
      }
    })();
    return () => {
      alive = false;
      unsubscribe();
      allowSleep("export");
    };
  }, [plan]);

  const handleCancel = () => {
    if (__DEV__) console.log("[export] cancel pressed");
    cancelledRef.current = true;
    void cancelExport();
    onClose();
  };

  const handleShare = async () => {
    if (phase.kind !== "done") return;
    try {
      await Sharing.shareAsync(phase.result.uri, {
        mimeType: "video/mp4",
        dialogTitle: "Share video",
      });
    } catch (e) {
      if (__DEV__) console.log("[export] share failed", e);
    }
  };

  const busy = !plan || phase.kind === "exporting" || phase.kind === "saving";
  const percent = Math.round(progress * 100);

  const handleCancelPrepare = () => {
    if (__DEV__) console.log("[export] cancel pressed while preparing");
    onClose();
  };

  return (
    <Modal
      visible={plan !== null || preparing}
      transparent
      animationType="fade"
      onRequestClose={() =>
        !plan ? handleCancelPrepare() : busy ? handleCancel() : onClose()
      }
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: colors.background }]}>
          {!plan && (
            <>
              <AppText style={[styles.title, { color: colors.textPrimary }]}>
                Preparing texts…
              </AppText>
              <ActivityIndicator color={colors.accentPurple} />
              <AppText style={[styles.hint, { color: colors.textMuted }]}>
                Keep the app open until it's done.
              </AppText>
              <TouchableOpacity
                onPress={handleCancelPrepare}
                style={[styles.button, { backgroundColor: colors.surface }]}
              >
                <AppText
                  style={[styles.buttonText, { color: colors.textPrimary }]}
                >
                  Cancel
                </AppText>
              </TouchableOpacity>
            </>
          )}

          {plan && busy && (
            <>
              <AppText style={[styles.title, { color: colors.textPrimary }]}>
                {phase.kind === "saving"
                  ? "Saving to gallery…"
                  : "Exporting video"}
              </AppText>
              <AppText style={[styles.percent, { color: colors.textPrimary }]}>
                {percent}%
              </AppText>
              <View
                style={[styles.barTrack, { backgroundColor: colors.surface }]}
              >
                <View
                  style={[
                    styles.barFill,
                    {
                      width: `${percent}%`,
                      backgroundColor: colors.accentPurple,
                    },
                  ]}
                />
              </View>
              <AppText style={[styles.hint, { color: colors.textMuted }]}>
                Keep the app open until it's done.
              </AppText>
              {phase.kind === "exporting" ? (
                <TouchableOpacity
                  onPress={handleCancel}
                  style={[styles.button, { backgroundColor: colors.surface }]}
                >
                  <AppText
                    style={[styles.buttonText, { color: colors.textPrimary }]}
                  >
                    Cancel
                  </AppText>
                </TouchableOpacity>
              ) : (
                <ActivityIndicator color={colors.accentPurple} />
              )}
            </>
          )}

          {plan && phase.kind === "done" && (
            <>
              <View style={[styles.icon, { backgroundColor: colors.surface }]}>
                <Ionicons
                  name="checkmark"
                  size={30}
                  color={colors.accentGreen}
                />
              </View>
              <AppText style={[styles.title, { color: colors.textPrimary }]}>
                Video exported
              </AppText>
              <AppText style={[styles.hint, { color: colors.textMuted }]}>
                {phase.inGallery
                  ? "Saved to your gallery"
                  : "Not saved to the gallery (no permission) — you can still share it"}
                {` · ${formatBytes(phase.result.sizeBytes)}`}
              </AppText>
              <View style={styles.row}>
                <TouchableOpacity
                  onPress={handleShare}
                  style={[
                    styles.button,
                    styles.rowButton,
                    { backgroundColor: colors.surface },
                  ]}
                >
                  <Ionicons
                    name="share-social-outline"
                    size={18}
                    color={colors.textPrimary}
                  />
                  <AppText
                    style={[styles.buttonText, { color: colors.textPrimary }]}
                  >
                    Share
                  </AppText>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={onClose}
                  style={[
                    styles.button,
                    styles.rowButton,
                    { backgroundColor: colors.accentPurple },
                  ]}
                >
                  <AppText style={[styles.buttonText, { color: "#FFFFFF" }]}>
                    Done
                  </AppText>
                </TouchableOpacity>
              </View>
            </>
          )}

          {plan && phase.kind === "error" && (
            <>
              <View style={[styles.icon, { backgroundColor: colors.surface }]}>
                <Ionicons name="alert" size={30} color="#FF5A5F" />
              </View>
              <AppText style={[styles.title, { color: colors.textPrimary }]}>
                Export failed
              </AppText>
              <AppText
                style={[styles.hint, { color: colors.textMuted }]}
                numberOfLines={6}
              >
                {phase.message}
              </AppText>
              <TouchableOpacity
                onPress={onClose}
                style={[
                  styles.button,
                  { backgroundColor: colors.accentPurple },
                ]}
              >
                <AppText style={[styles.buttonText, { color: "#FFFFFF" }]}>
                  Close
                </AppText>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 18,
    padding: 22,
    alignItems: "center",
    gap: 12,
  },
  title: { fontSize: 18, fontWeight: "700" },
  percent: { fontSize: 34, fontWeight: "700" },
  barTrack: { width: "100%", height: 8, borderRadius: 4, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4 },
  hint: { fontSize: 13, textAlign: "center", lineHeight: 19 },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  row: { flexDirection: "row", gap: 10, width: "100%" },
  rowButton: { flex: 1, flexDirection: "row", gap: 6 },
  button: {
    minWidth: 120,
    height: 44,
    paddingHorizontal: 24,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 15, fontWeight: "600" },
});
