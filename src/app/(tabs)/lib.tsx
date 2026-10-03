// Lib tab: the user's own media to reuse in any edit — music and sounds,
// videos (intros, outros, clips), images (logos, overlays). Added once
// here, then offered in the editor whenever music, a video or a PIP is
// added ("From your Lib").

import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect } from "expo-router";
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type ComponentProps,
} from "react";
import {
    ActivityIndicator,
    Image,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    useWindowDimensions,
    View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppText from "../../components/AppText";
import ConfirmModal from "../../components/ConfirmModal";
import { probeDuration } from "../../editor/mediaProbe";
import { useTheme } from "../../hooks/useTheme";
import {
    addToLibrary,
    deleteLibraryItem,
    formatLibDuration,
    loadLibrary,
    renameLibraryItem,
    subscribeLibrary,
    type LibItem,
    type LibKind,
} from "../../lib/libraryStorage";

type IconName = ComponentProps<typeof Ionicons>["name"];
type Filter = "all" | LibKind;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "audio", label: "Audio" },
  { key: "video", label: "Videos" },
  { key: "image", label: "Images" },
];

const ADD_OPTIONS: {
  kind: LibKind;
  icon: IconName;
  title: string;
  hint: string;
}[] = [
  {
    kind: "audio",
    icon: "musical-notes-outline",
    title: "Audio",
    hint: "Your music, jingles, sound effects",
  },
  {
    kind: "video",
    icon: "film-outline",
    title: "Video",
    hint: "Your intro, outro or any clip you reuse",
  },
  {
    kind: "image",
    icon: "image-outline",
    title: "Image",
    hint: "Your logo, watermark or overlay",
  },
];

const KIND_LABEL: Record<LibKind, string> = {
  audio: "Audio",
  video: "Video",
  image: "Image",
};

const GAP = 12;
const SIDE = 20;

export default function LibScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const cardW = (screenW - SIDE * 2 - GAP) / 2;

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<LibItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState<LibKind | null>(null);
  const [optionsFor, setOptionsFor] = useState<LibItem | null>(null);
  const [renaming, setRenaming] = useState<LibItem | null>(null);
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<LibItem | null>(null);

  const refresh = useCallback(async () => {
    const list = await loadLibrary();
    setItems(list);
    setLoading(false);
    if (__DEV__) console.log(`[lib] screen shows ${list.length} item(s)`);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  useEffect(() => subscribeLibrary(() => void refresh()), [refresh]);

  const shown = useMemo(
    () => (filter === "all" ? items : items.filter((it) => it.kind === filter)),
    [items, filter],
  );
  const count = (f: Filter) =>
    f === "all" ? items.length : items.filter((it) => it.kind === f).length;

  // ---- Adding ---------------------------------------------------------------
  const add = async (kind: LibKind) => {
    setAddOpen(false);
    if (adding) return;
    if (__DEV__) console.log(`[lib] add ${kind} — opening the picker`);
    try {
      if (kind === "audio") {
        const result = await DocumentPicker.getDocumentAsync({
          type: "audio/*",
          copyToCacheDirectory: true,
          multiple: false,
        });
        const asset = result.canceled ? null : result.assets?.[0];
        if (!asset) return;
        setAdding(kind);
        const duration = await probeDuration(asset.uri);
        if (!(duration > 0)) throw new Error("unreadable audio");
        await addToLibrary({
          kind,
          sourceUri: asset.uri,
          name: asset.name.replace(/\.[^.]+$/, ""),
          duration,
          width: 0,
          height: 0,
        });
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: [kind === "video" ? "videos" : "images"],
          allowsEditing: false,
          quality: 1,
        });
        const asset = result.canceled ? null : result.assets?.[0];
        if (!asset) return;
        setAdding(kind);
        let duration = 0;
        if (kind === "video") {
          duration = asset.duration
            ? asset.duration / 1000
            : await probeDuration(asset.uri);
          if (!(duration > 0)) throw new Error("unreadable video");
        }
        await addToLibrary({
          kind,
          sourceUri: asset.uri,
          name: (
            asset.fileName ??
            asset.uri.split("/").pop() ??
            KIND_LABEL[kind]
          ).replace(/\.[^.]+$/, ""),
          duration,
          width: asset.width ?? 0,
          height: asset.height ?? 0,
        });
      }
      setFilter((f) => (f === "all" || f === kind ? f : kind));
    } catch (e) {
      if (__DEV__) console.log(`[lib] add ${kind} failed`, e);
    } finally {
      setAdding(null);
    }
  };

  // ---- Rename / delete ----------------------------------------------------------
  const startRename = (item: LibItem) => {
    setOptionsFor(null);
    setNewName(item.name);
    setRenaming(item);
  };
  const submitRename = () => {
    if (renaming && newName.trim())
      void renameLibraryItem(renaming.id, newName);
    setRenaming(null);
  };

  // ---- Pieces ------------------------------------------------------------------------
  const card = (item: LibItem) => (
    <View
      key={item.id}
      style={[styles.card, { width: cardW, backgroundColor: colors.surface }]}
    >
      {item.thumbnailUri ? (
        <Image
          source={{ uri: item.thumbnailUri }}
          style={[styles.thumb, { height: cardW * 0.62 }]}
          resizeMode="cover"
        />
      ) : (
        <View
          style={[
            styles.thumb,
            styles.audioThumb,
            { height: cardW * 0.62, backgroundColor: colors.badgeBackground },
          ]}
        >
          <View style={styles.wave}>
            {[10, 22, 16, 30, 20, 26, 12, 18, 24, 14].map((h, i) => (
              <View
                key={i}
                style={[
                  styles.waveBar,
                  { height: h, backgroundColor: colors.accentPurple },
                ]}
              />
            ))}
          </View>
          <Ionicons
            name="musical-notes"
            size={20}
            color={colors.accentPurpleBright}
            style={styles.audioIcon}
          />
        </View>
      )}
      {item.kind !== "image" && (
        <View style={styles.durationTag}>
          <AppText style={styles.durationText}>
            {formatLibDuration(item.duration)}
          </AppText>
        </View>
      )}
      <View style={styles.cardFoot}>
        <View style={{ flex: 1 }}>
          <AppText
            numberOfLines={1}
            style={[styles.cardName, { color: colors.textPrimary }]}
          >
            {item.name}
          </AppText>
          <AppText style={[styles.cardKind, { color: colors.textMuted }]}>
            {KIND_LABEL[item.kind]}
          </AppText>
        </View>
        <TouchableOpacity
          onPress={() => setOptionsFor(item)}
          hitSlop={10}
          accessibilityLabel="Options"
        >
          <Ionicons
            name="ellipsis-vertical"
            size={18}
            color={colors.textMuted}
          />
        </TouchableOpacity>
      </View>
    </View>
  );

  const empty = (
    <View style={styles.empty}>
      <AppText style={[styles.emptyTitle, { color: colors.textPrimary }]}>
        {filter === "all"
          ? "Your Lib is empty"
          : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} yet`}
      </AppText>
      <AppText style={[styles.emptyText, { color: colors.textMuted }]}>
        Save the things you use in every video once — they'll be one tap away
        when you edit.
      </AppText>
      <View style={styles.suggestions}>
        {ADD_OPTIONS.filter((o) => filter === "all" || o.kind === filter).map(
          (o) => (
            <TouchableOpacity
              key={o.kind}
              style={[styles.suggestion, { backgroundColor: colors.surface }]}
              onPress={() => void add(o.kind)}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.suggestionIcon,
                  { backgroundColor: colors.accentPurple + "22" },
                ]}
              >
                <Ionicons
                  name={o.icon}
                  size={20}
                  color={colors.accentPurpleBright}
                />
              </View>
              <View style={{ flex: 1 }}>
                <AppText
                  style={[
                    styles.suggestionTitle,
                    { color: colors.textPrimary },
                  ]}
                >
                  Add {o.title.toLowerCase()}
                </AppText>
                <AppText
                  style={[styles.suggestionHint, { color: colors.textMuted }]}
                >
                  {o.hint}
                </AppText>
              </View>
              <Ionicons name="add" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          ),
        )}
      </View>
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 16 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <AppText style={[styles.title, { color: colors.textPrimary }]}>
              Lib
            </AppText>
            <AppText style={[styles.subtitle, { color: colors.textMuted }]}>
              Your intros, music and logos — ready for any edit
            </AppText>
          </View>
          <TouchableOpacity
            style={[styles.addButton, { backgroundColor: colors.accentPurple }]}
            onPress={() => setAddOpen(true)}
            disabled={adding !== null}
            activeOpacity={0.85}
          >
            {adding ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Ionicons name="add" size={20} color="#FFFFFF" />
            )}
            <AppText style={styles.addText}>
              {adding ? "Adding…" : "Add"}
            </AppText>
          </TouchableOpacity>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filtersBar}
          contentContainerStyle={styles.filters}
        >
          {FILTERS.map((f) => {
            const on = f.key === filter;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={[
                  styles.filter,
                  {
                    backgroundColor: on ? colors.accentPurple : colors.surface,
                  },
                ]}
              >
                <AppText
                  style={[
                    styles.filterText,
                    { color: on ? "#FFFFFF" : colors.textPrimary },
                  ]}
                >
                  {f.label}
                  {count(f.key) > 0 ? ` · ${count(f.key)}` : ""}
                </AppText>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {loading ? (
          <View style={styles.grid}>
            {[0, 1, 2, 3].map((i) => (
              <View
                key={i}
                style={[
                  styles.card,
                  {
                    width: cardW,
                    height: cardW * 0.62 + 56,
                    backgroundColor: colors.surface,
                    opacity: 0.6,
                  },
                ]}
              />
            ))}
          </View>
        ) : shown.length === 0 ? (
          empty
        ) : (
          <View style={styles.grid}>{shown.map(card)}</View>
        )}
      </ScrollView>

      {/* Add: what kind */}
      <Modal
        visible={addOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setAddOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setAddOpen(false)}>
          <Pressable
            style={[
              styles.sheet,
              {
                backgroundColor: colors.background,
                paddingBottom: 16 + insets.bottom,
              },
            ]}
          >
            <View
              style={[styles.grabber, { backgroundColor: colors.surface }]}
            />
            <AppText style={[styles.sheetTitle, { color: colors.textPrimary }]}>
              Add to your Lib
            </AppText>
            {ADD_OPTIONS.map((o) => (
              <TouchableOpacity
                key={o.kind}
                style={[styles.suggestion, { backgroundColor: colors.surface }]}
                onPress={() => void add(o.kind)}
                activeOpacity={0.8}
              >
                <View
                  style={[
                    styles.suggestionIcon,
                    { backgroundColor: colors.accentPurple + "22" },
                  ]}
                >
                  <Ionicons
                    name={o.icon}
                    size={20}
                    color={colors.accentPurpleBright}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText
                    style={[
                      styles.suggestionTitle,
                      { color: colors.textPrimary },
                    ]}
                  >
                    {o.title}
                  </AppText>
                  <AppText
                    style={[styles.suggestionHint, { color: colors.textMuted }]}
                  >
                    {o.hint}
                  </AppText>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color={colors.textMuted}
                />
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ⋮ options */}
      <Modal
        visible={optionsFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setOptionsFor(null)}
      >
        <Pressable
          style={styles.centerBackdrop}
          onPress={() => setOptionsFor(null)}
        >
          <Pressable
            style={[styles.optionsCard, { backgroundColor: colors.background }]}
          >
            <AppText
              numberOfLines={1}
              style={[styles.sheetTitle, { color: colors.textPrimary }]}
            >
              {optionsFor?.name}
            </AppText>
            <TouchableOpacity
              style={[styles.option, { backgroundColor: colors.surface }]}
              onPress={() => optionsFor && startRename(optionsFor)}
            >
              <Ionicons
                name="create-outline"
                size={20}
                color={colors.textPrimary}
              />
              <AppText
                style={[styles.optionText, { color: colors.textPrimary }]}
              >
                Rename
              </AppText>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.option, { backgroundColor: colors.surface }]}
              onPress={() => {
                setDeleting(optionsFor);
                setOptionsFor(null);
              }}
            >
              <Ionicons name="trash-outline" size={20} color="#FF5A5F" />
              <AppText style={[styles.optionText, { color: "#FF5A5F" }]}>
                Delete
              </AppText>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Rename */}
      <Modal
        visible={renaming !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenaming(null)}
      >
        <Pressable
          style={styles.centerBackdrop}
          onPress={() => setRenaming(null)}
        >
          <Pressable
            style={[styles.optionsCard, { backgroundColor: colors.background }]}
          >
            <AppText style={[styles.sheetTitle, { color: colors.textPrimary }]}>
              Rename
            </AppText>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              autoFocus
              selectTextOnFocus
              maxLength={60}
              returnKeyType="done"
              onSubmitEditing={submitRename}
              placeholder="Name"
              placeholderTextColor={colors.textMuted}
              style={[
                styles.input,
                { backgroundColor: colors.surface, color: colors.textPrimary },
              ]}
            />
            <View style={styles.buttons}>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: colors.surface }]}
                onPress={() => setRenaming(null)}
              >
                <AppText
                  style={[styles.buttonText, { color: colors.textPrimary }]}
                >
                  Cancel
                </AppText>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.button,
                  {
                    backgroundColor: colors.accentPurple,
                    opacity: newName.trim() ? 1 : 0.5,
                  },
                ]}
                onPress={submitRename}
                disabled={!newName.trim()}
              >
                <AppText style={[styles.buttonText, { color: "#FFFFFF" }]}>
                  Save
                </AppText>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <ConfirmModal
        visible={deleting !== null}
        title="Delete from your Lib?"
        message={`"${deleting?.name ?? ""}" is removed from your Lib. Projects that already use it keep their copy.`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const item = deleting;
          setDeleting(null);
          if (item) void deleteLibraryItem(item.id);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: SIDE, paddingBottom: 40 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { fontSize: 26, fontFamily: "Poppins-Bold", lineHeight: 34 },
  subtitle: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  addButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  addText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontFamily: "Poppins-Medium",
    lineHeight: 20,
  },
  filtersBar: {
    flexGrow: 0,
    flexShrink: 0,
    height: 56,
    marginTop: 8,
    marginHorizontal: -SIDE,
  },
  filters: { paddingHorizontal: SIDE, gap: 8, alignItems: "center" },
  filter: {
    height: 36,
    paddingHorizontal: 15,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  filterText: { fontSize: 13, fontFamily: "Poppins-Medium", lineHeight: 18 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP, marginTop: 4 },
  card: { borderRadius: 16, overflow: "hidden" },
  thumb: { width: "100%" },
  audioThumb: { alignItems: "center", justifyContent: "center" },
  wave: { flexDirection: "row", alignItems: "center", gap: 4 },
  waveBar: { width: 4, borderRadius: 2, opacity: 0.8 },
  audioIcon: { position: "absolute", top: 8, left: 8 },
  durationTag: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 7,
    height: 20,
    borderRadius: 10,
    justifyContent: "center",
  },
  durationText: { color: "#FFFFFF", fontSize: 11, lineHeight: 15 },
  cardFoot: { flexDirection: "row", alignItems: "center", gap: 6, padding: 10 },
  cardName: { fontSize: 14, fontFamily: "Poppins-Medium", lineHeight: 20 },
  cardKind: { fontSize: 11, lineHeight: 15 },
  empty: { marginTop: 24, gap: 8 },
  emptyTitle: { fontSize: 18, fontFamily: "Poppins-Bold", lineHeight: 26 },
  emptyText: { fontSize: 13, lineHeight: 19, marginBottom: 8 },
  suggestions: { gap: 10 },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 16,
    padding: 12,
  },
  suggestionIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  suggestionTitle: {
    fontSize: 15,
    fontFamily: "Poppins-Medium",
    lineHeight: 21,
  },
  suggestionHint: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 8,
    gap: 10,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 4,
  },
  sheetTitle: { fontSize: 17, fontFamily: "Poppins-Bold", lineHeight: 24 },
  centerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
  },
  optionsCard: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 18,
    padding: 18,
    gap: 10,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  optionText: { fontSize: 15, fontFamily: "Poppins-Medium" },
  input: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
  },
  buttons: { flexDirection: "row", gap: 10, marginTop: 4 },
  button: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 15, fontFamily: "Poppins-Medium" },
});
