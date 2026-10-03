import { Ionicons } from "@expo/vector-icons";
import {
    Image,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    TouchableOpacity,
    View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../hooks/useTheme";
import { formatLibDuration, type LibItem } from "../../lib/libraryStorage";
import AppText from "../AppText";

/**
 * "From your Lib or from the phone?" — shown when adding music / a video /
 * a PIP and the Lib has items of that kind. Tapping an item adds it; "From
 * your phone" opens the phone's picker as before.
 */
export default function LibPickerSheet({
  choice,
  onClose,
}: {
  choice: {
    title: string;
    items: LibItem[];
    fromDevice: () => void;
    fromLib: (item: LibItem) => void;
  } | null;
  onClose: () => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  if (!choice) return null;

  const pickDevice = () => {
    onClose();
    if (__DEV__)
      console.log(`[LibPickerSheet] ${choice.title} — from the phone`);
    choice.fromDevice();
  };
  const pickItem = (item: LibItem) => {
    onClose();
    if (__DEV__)
      console.log(`[LibPickerSheet] ${choice.title} — Lib item "${item.name}"`);
    choice.fromLib(item);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              paddingBottom: 16 + insets.bottom,
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.surface }]} />
          <AppText style={[styles.title, { color: colors.textPrimary }]}>
            {choice.title}
          </AppText>

          <TouchableOpacity
            style={[styles.device, { backgroundColor: colors.surface }]}
            onPress={pickDevice}
            activeOpacity={0.8}
          >
            <View
              style={[
                styles.deviceIcon,
                { backgroundColor: colors.accentPurple },
              ]}
            >
              <Ionicons
                name="phone-portrait-outline"
                size={18}
                color="#FFFFFF"
              />
            </View>
            <AppText style={[styles.deviceText, { color: colors.textPrimary }]}>
              From your phone
            </AppText>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={colors.textMuted}
            />
          </TouchableOpacity>

          <AppText style={[styles.section, { color: colors.textMuted }]}>
            From your Lib
          </AppText>
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
          >
            {choice.items.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.item, { backgroundColor: colors.surface }]}
                onPress={() => pickItem(item)}
                activeOpacity={0.8}
              >
                {item.thumbnailUri ? (
                  <Image
                    source={{ uri: item.thumbnailUri }}
                    style={styles.thumb}
                  />
                ) : (
                  <View
                    style={[
                      styles.thumb,
                      styles.audioThumb,
                      { backgroundColor: colors.badgeBackground },
                    ]}
                  >
                    <Ionicons
                      name="musical-notes"
                      size={20}
                      color={colors.accentPurpleBright}
                    />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <AppText
                    numberOfLines={1}
                    style={[styles.name, { color: colors.textPrimary }]}
                  >
                    {item.name}
                  </AppText>
                  <AppText style={[styles.meta, { color: colors.textMuted }]}>
                    {item.kind === "audio"
                      ? "Audio"
                      : item.kind === "video"
                        ? "Video"
                        : "Image"}
                    {item.kind !== "image"
                      ? ` · ${formatLibDuration(item.duration)}`
                      : ""}
                  </AppText>
                </View>
                <Ionicons
                  name="add-circle"
                  size={24}
                  color={colors.accentPurple}
                />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
    maxHeight: "75%",
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 10,
  },
  title: {
    fontSize: 17,
    fontFamily: "Poppins-Bold",
    lineHeight: 24,
    marginBottom: 10,
  },
  device: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 14,
    padding: 12,
  },
  deviceIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  deviceText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Poppins-Medium",
    lineHeight: 21,
  },
  section: {
    fontSize: 12,
    fontFamily: "Poppins-Medium",
    marginTop: 16,
    marginBottom: 8,
    lineHeight: 16,
  },
  list: { flexGrow: 0 },
  listContent: { gap: 8, paddingBottom: 4 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 14,
    padding: 10,
  },
  thumb: { width: 52, height: 52, borderRadius: 10 },
  audioThumb: { alignItems: "center", justifyContent: "center" },
  name: { fontSize: 14, fontFamily: "Poppins-Medium", lineHeight: 20 },
  meta: { fontSize: 12, lineHeight: 16, marginTop: 2 },
});
