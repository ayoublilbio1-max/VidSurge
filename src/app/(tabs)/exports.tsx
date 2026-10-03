import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import * as Sharing from "expo-sharing";
import { useVideoPlayer, VideoView } from "expo-video";
import { useCallback, useEffect, useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppText from "../../components/AppText";
import ConfirmModal from "../../components/ConfirmModal";
import { useTheme } from "../../hooks/useTheme";
import {
  deleteExport,
  loadExports,
  markInGallery,
  subscribeExports,
  type ExportItem,
} from "../../lib/exportsStorage";

type IconName = ComponentProps<typeof Ionicons>["name"];

/** 75.3 → "1:15" */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb < 1 ? `${Math.round(bytes / 1000)} KB` : `${mb.toFixed(1)} MB`;
}

/** Short side → "720P", "1080P", "2K", "4K". */
function qualityLabel(width: number, height: number): string {
  const short = Math.min(width, height);
  if (short >= 2100) return "4K";
  if (short >= 1400) return "2K";
  return `${short}P`;
}

/** "Today, 03:12" / "Yesterday, 21:40" / "28 Sep, 14:05". */
function formatDate(time: number): string {
  const d = new Date(time);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(d, today)) return `Today, ${hh}:${mm}`;
  if (same(d, yesterday)) return `Yesterday, ${hh}:${mm}`;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const year =
    d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${d.getDate()} ${months[d.getMonth()]}${year}, ${hh}:${mm}`;
}

function titleOf(item: ExportItem): string {
  return item.projectName?.trim() || "Exported video";
}

async function shareExport(item: ExportItem) {
  if (__DEV__) console.log(`[exports] share ${item.id}`);
  try {
    await Sharing.shareAsync(item.uri, {
      mimeType: "video/mp4",
      dialogTitle: "Share video",
    });
  } catch (e) {
    if (__DEV__) console.log("[exports] share failed", e);
  }
}

async function saveToGallery(item: ExportItem): Promise<boolean> {
  if (__DEV__) console.log(`[exports] save ${item.id} to the gallery`);
  try {
    const MediaLibrary = await import("expo-media-library/legacy");
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) {
      Alert.alert(
        "No permission",
        "Allow access to your photos to save videos to the gallery.",
      );
      return false;
    }
    await MediaLibrary.saveToLibraryAsync(item.uri);
    await markInGallery(item.id);
    return true;
  } catch (e) {
    if (__DEV__) console.log("[exports] saving to the gallery failed", e);
    Alert.alert("Not saved", "The video couldn't be saved to the gallery.");
    return false;
  }
}

// Delete asks first, in the app's own modal (ConfirmModal, shown by the
// Exports screen). The viewer and the ⋮ menu call confirmDelete.
type DeleteRequest = { item: ExportItem; onDeleted?: () => void };
let showDeleteConfirm: ((req: DeleteRequest) => void) | null = null;

function confirmDelete(item: ExportItem, onDeleted?: () => void) {
  showDeleteConfirm?.({ item, onDeleted });
}

export default function ExportsScreen() {
  const colors = useTheme();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ExportItem[]>([]);
  // The export playing in the viewer / whose menu is open.
  const [playing, setPlaying] = useState<ExportItem | null>(null);
  const [optionsFor, setOptionsFor] = useState<ExportItem | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(
    null,
  );
  useEffect(() => {
    showDeleteConfirm = setDeleteRequest;
    return () => {
      showDeleteConfirm = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    const list = await loadExports();
    setItems(list);
    setLoading(false);
    if (__DEV__) console.log(`[exports] screen shows ${list.length} export(s)`);
  }, []);

  // Reload when the tab is opened, and whenever an export is added / removed.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  useEffect(() => subscribeExports(() => void refresh()), [refresh]);

  const totalBytes = items.reduce((sum, it) => sum + it.sizeBytes, 0);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <AppText style={[styles.title, { color: colors.textPrimary }]}>
          Exports
        </AppText>
        {items.length > 0 && (
          <AppText style={[styles.subtitle, { color: colors.textMuted }]}>
            {items.length} video{items.length > 1 ? "s" : ""} ·{" "}
            {formatBytes(totalBytes)}
          </AppText>
        )}

        {loading ? (
          <View style={styles.emptyState}>
            <ActivityIndicator color={colors.accentPurple} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.emptyState}>
            <View
              style={[styles.emptyIcon, { backgroundColor: colors.surface }]}
            >
              <Ionicons
                name="cloud-download-outline"
                size={34}
                color={colors.iconInactive}
              />
            </View>
            <AppText style={[styles.emptyTitle, { color: colors.textPrimary }]}>
              No exports yet
            </AppText>
            <AppText style={[styles.emptyText, { color: colors.textMuted }]}>
              Videos you export from the editor{"\n"}show up here.
            </AppText>
          </View>
        ) : (
          <View style={styles.list}>
            {items.map((item) => (
              <TouchableOpacity
                key={item.id}
                activeOpacity={0.8}
                onPress={() => setPlaying(item)}
                onLongPress={() => setOptionsFor(item)}
                style={[styles.row, { backgroundColor: colors.surface }]}
              >
                <View
                  style={[
                    styles.thumbWrap,
                    { backgroundColor: colors.badgeBackground },
                  ]}
                >
                  {item.thumbnailUri ? (
                    <Image
                      source={{ uri: item.thumbnailUri }}
                      style={styles.thumb}
                    />
                  ) : (
                    <Ionicons
                      name="film-outline"
                      size={22}
                      color={colors.iconInactive}
                    />
                  )}
                  <View style={styles.playBadge}>
                    <Ionicons name="play" size={14} color="#FFFFFF" />
                  </View>
                  <View style={styles.durationBadge}>
                    <AppText style={styles.durationText}>
                      {formatDuration(item.duration)}
                    </AppText>
                  </View>
                </View>

                <View style={styles.info}>
                  <AppText
                    numberOfLines={1}
                    style={[styles.name, { color: colors.textPrimary }]}
                  >
                    {titleOf(item)}
                  </AppText>
                  <View style={styles.chips}>
                    <View
                      style={[
                        styles.chip,
                        { backgroundColor: colors.accentPurple + "22" },
                      ]}
                    >
                      <AppText
                        style={[
                          styles.chipText,
                          { color: colors.accentPurpleBright },
                        ]}
                      >
                        {qualityLabel(item.width, item.height)} · {item.fps}fps
                      </AppText>
                    </View>
                    <AppText style={[styles.meta, { color: colors.textMuted }]}>
                      {formatBytes(item.sizeBytes)}
                    </AppText>
                  </View>
                  <View style={styles.dateRow}>
                    <AppText style={[styles.meta, { color: colors.textMuted }]}>
                      {formatDate(item.createdAt)}
                    </AppText>
                    {item.inGallery && (
                      <Ionicons
                        name="images-outline"
                        size={12}
                        color={colors.accentGreen}
                      />
                    )}
                  </View>
                </View>

                <TouchableOpacity
                  onPress={() => void shareExport(item)}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  accessibilityLabel="Share"
                  style={styles.iconButton}
                >
                  <Ionicons
                    name="share-social-outline"
                    size={19}
                    color={colors.textPrimary}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setOptionsFor(item)}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }}
                  accessibilityLabel="Export options"
                  style={styles.iconButton}
                >
                  <Ionicons
                    name="ellipsis-vertical"
                    size={18}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      {playing && (
        <ExportViewer
          key={playing.id}
          item={items.find((it) => it.id === playing.id) ?? playing}
          onClose={() => setPlaying(null)}
        />
      )}

      <ExportOptions item={optionsFor} onClose={() => setOptionsFor(null)} />

      <ConfirmModal
        visible={deleteRequest !== null}
        title="Delete this export?"
        message={
          deleteRequest?.item.inGallery
            ? "It's removed from Exports. The copy in your gallery stays."
            : "It's removed from the app. It isn't in your gallery, so it will be gone."
        }
        onCancel={() => setDeleteRequest(null)}
        onConfirm={() => {
          const req = deleteRequest;
          setDeleteRequest(null);
          if (!req) return;
          if (__DEV__)
            console.log(`[exports] delete ${req.item.id} (confirmed)`);
          void deleteExport(req.item.id).then(() => req.onDeleted?.());
        }}
      />
    </View>
  );
}

/** Full-screen player for one export, with Share / Save / Delete. */
function ExportViewer({
  item,
  onClose,
}: {
  item: ExportItem;
  onClose: () => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  const player = useVideoPlayer(item.uri, (p) => {
    p.loop = true;
    p.play();
  });

  useEffect(() => {
    if (__DEV__) console.log(`[exports] viewer open ${item.id}`);
    return () => {
      if (__DEV__) console.log(`[exports] viewer closed ${item.id}`);
    };
  }, [item.id]);

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.viewer,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.viewerTop}>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={12}
            accessibilityLabel="Close"
          >
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </TouchableOpacity>
          <AppText numberOfLines={1} style={styles.viewerTitle}>
            {titleOf(item)}
          </AppText>
          <View style={{ width: 26 }} />
        </View>

        <View style={styles.viewerVideo}>
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            nativeControls
          />
        </View>

        <AppText style={styles.viewerMeta}>
          {qualityLabel(item.width, item.height)} · {item.fps}fps ·{" "}
          {formatDuration(item.duration)} · {formatBytes(item.sizeBytes)}
        </AppText>

        <View style={styles.viewerActions}>
          <TouchableOpacity
            style={styles.viewerAction}
            onPress={() => void shareExport(item)}
          >
            <Ionicons name="share-social-outline" size={22} color="#FFFFFF" />
            <AppText style={styles.viewerActionText}>Share</AppText>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.viewerAction}
            disabled={item.inGallery || saving}
            onPress={async () => {
              setSaving(true);
              await saveToGallery(item);
              setSaving(false);
            }}
          >
            {saving ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Ionicons
                name={item.inGallery ? "checkmark-circle" : "download-outline"}
                size={22}
                color={item.inGallery ? colors.accentGreen : "#FFFFFF"}
              />
            )}
            <AppText style={styles.viewerActionText}>
              {item.inGallery ? "In gallery" : "Save"}
            </AppText>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.viewerAction}
            onPress={() => confirmDelete(item, onClose)}
          >
            <Ionicons name="trash-outline" size={22} color="#FF5A5F" />
            <AppText style={[styles.viewerActionText, { color: "#FF5A5F" }]}>
              Delete
            </AppText>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/** The "⋮" menu: Share / Save to gallery / Delete. */
function ExportOptions({
  item,
  onClose,
}: {
  item: ExportItem | null;
  onClose: () => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  if (!item) return null;
  const row = (
    icon: IconName,
    label: string,
    onPress: () => void,
    color = colors.textPrimary,
  ) => (
    <TouchableOpacity style={styles.optionRow} onPress={onPress}>
      <Ionicons name={icon} size={20} color={color} />
      <AppText style={[styles.optionText, { color }]}>{label}</AppText>
    </TouchableOpacity>
  );
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              paddingBottom: 16 + insets.bottom,
            },
          ]}
          onPress={() => undefined}
        >
          <AppText
            numberOfLines={1}
            style={[styles.sheetTitle, { color: colors.textPrimary }]}
          >
            {titleOf(item)}
          </AppText>
          {row("share-social-outline", "Share", () => {
            onClose();
            void shareExport(item);
          })}
          {!item.inGallery &&
            row("download-outline", "Save to gallery", () => {
              onClose();
              void saveToGallery(item);
            })}
          {row(
            "trash-outline",
            "Delete",
            () => {
              onClose();
              confirmDelete(item);
            },
            "#FF5A5F",
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 56, paddingBottom: 32 },
  title: { fontSize: 24, fontFamily: "Poppins-Bold" },
  subtitle: { fontSize: 13, marginTop: 2, marginBottom: 18 },
  emptyState: { alignItems: "center", paddingTop: 80, gap: 12 },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 17, fontFamily: "Poppins-Medium" },
  emptyText: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  list: { gap: 12, marginTop: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 16,
    padding: 10,
    paddingRight: 12,
  },
  thumbWrap: {
    width: 72,
    height: 72,
    borderRadius: 12,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  thumb: { width: "100%", height: "100%" },
  playBadge: {
    position: "absolute",
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  durationBadge: {
    position: "absolute",
    right: 4,
    bottom: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  durationText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontFamily: "Poppins-Medium",
  },
  info: { flex: 1, gap: 4 },
  name: { fontSize: 15, fontFamily: "Poppins-Medium" },
  chips: { flexDirection: "row", alignItems: "center", gap: 8 },
  chip: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
  chipText: { fontSize: 11, fontFamily: "Poppins-Medium" },
  meta: { fontSize: 12 },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconButton: { padding: 4 },
  viewer: { flex: 1, backgroundColor: "#000000" },
  viewerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    height: 52,
    gap: 12,
  },
  viewerTitle: {
    flex: 1,
    textAlign: "center",
    color: "#FFFFFF",
    fontSize: 15,
    fontFamily: "Poppins-Medium",
  },
  viewerVideo: { flex: 1 },
  viewerMeta: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 12,
    textAlign: "center",
    marginTop: 10,
  },
  viewerActions: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 16,
  },
  viewerAction: { alignItems: "center", gap: 4, minWidth: 80 },
  viewerActionText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontFamily: "Poppins-Medium",
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 18,
    paddingHorizontal: 20,
    gap: 4,
  },
  sheetTitle: { fontSize: 16, fontFamily: "Poppins-Bold", marginBottom: 8 },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
  },
  optionText: { fontSize: 15, fontFamily: "Poppins-Medium" },
});
