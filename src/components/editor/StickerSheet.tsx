import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";

// The built-in stickers: emoji, by category. They're drawn by the phone's
// emoji font — nothing to download, and they stay sharp at any size.
const CATEGORIES: { key: string; label: string; emojis: string[] }[] = [
  {
    key: "smileys",
    label: "😀",
    emojis: [
      "😀",
      "😃",
      "😄",
      "😁",
      "😆",
      "😅",
      "😂",
      "🤣",
      "😊",
      "😇",
      "🙂",
      "😉",
      "😍",
      "🥰",
      "😘",
      "😋",
      "😜",
      "🤪",
      "😎",
      "🤩",
      "🥳",
      "😏",
      "😴",
      "🤯",
      "😱",
      "😭",
      "😡",
      "🤔",
      "🙄",
      "😬",
      "🤗",
      "🤫",
    ],
  },
  {
    key: "love",
    label: "❤️",
    emojis: [
      "❤️",
      "🧡",
      "💛",
      "💚",
      "💙",
      "💜",
      "🖤",
      "🤍",
      "💖",
      "💗",
      "💓",
      "💕",
      "💞",
      "💘",
      "💝",
      "💯",
      "💥",
      "✨",
      "⭐",
      "🌟",
      "💫",
      "🔥",
    ],
  },
  {
    key: "hands",
    label: "👍",
    emojis: [
      "👍",
      "👎",
      "👏",
      "🙌",
      "🙏",
      "👌",
      "✌️",
      "🤞",
      "🤟",
      "🤘",
      "👋",
      "💪",
      "👉",
      "👈",
      "👆",
      "👇",
      "✍️",
      "🫶",
    ],
  },
  {
    key: "party",
    label: "🎉",
    emojis: [
      "🎉",
      "🎊",
      "🎈",
      "🎁",
      "🎂",
      "🥂",
      "🍾",
      "🏆",
      "🥇",
      "🎵",
      "🎶",
      "🎤",
      "🎧",
      "📸",
      "🎬",
    ],
  },
  {
    key: "animals",
    label: "🐶",
    emojis: [
      "🐶",
      "🐱",
      "🦊",
      "🐻",
      "🐼",
      "🐨",
      "🦁",
      "🐯",
      "🐸",
      "🐵",
      "🐧",
      "🦄",
      "🐝",
      "🦋",
      "🐢",
      "🐬",
    ],
  },
  {
    key: "food",
    label: "🍕",
    emojis: [
      "🍕",
      "🍔",
      "🍟",
      "🌮",
      "🍩",
      "🍪",
      "🍦",
      "🍓",
      "🍉",
      "🍒",
      "☕",
      "🧋",
      "🍿",
    ],
  },
  {
    key: "nature",
    label: "🌈",
    emojis: [
      "☀️",
      "🌙",
      "⛅",
      "🌈",
      "❄️",
      "🌸",
      "🌺",
      "🌻",
      "🍀",
      "🌴",
      "🌊",
      "⚡",
    ],
  },
  {
    key: "symbols",
    label: "✅",
    emojis: [
      "✅",
      "❌",
      "❓",
      "❗",
      "💬",
      "💭",
      "🔔",
      "📍",
      "⏰",
      "🚀",
      "💡",
      "💎",
      "👑",
      "🎯",
    ],
  },
];

/**
 * Bottom sheet with the built-in stickers (Stickers tool). Tap one to add
 * it at the playhead — or, in "replace" mode, to swap the selected
 * sticker's emoji. ✕ / Android back closes it.
 */
export default function StickerSheet({
  mode,
  onPick,
  onClose,
}: {
  mode: "add" | "replace";
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const colors = useTheme();
  const [cat, setCat] = useState(CATEGORIES[0].key);
  const current = CATEGORIES.find((c) => c.key === cat) ?? CATEGORIES[0];

  return (
    <View style={[styles.sheet, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onClose}
          hitSlop={10}
          accessibilityLabel="Close"
        >
          <Ionicons name="close" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <AppText style={[styles.title, { color: colors.textPrimary }]}>
          {mode === "add" ? "Stickers" : "Replace sticker"}
        </AppText>
        <View style={{ width: 26 }} />
      </View>

      {/* flexGrow 0: in a fixed-height sheet a horizontal ScrollView
          otherwise stretches to share the free height with the grid —
          that was the empty gap above the stickers. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsScroll}
        contentContainerStyle={styles.tabs}
      >
        {CATEGORIES.map((c) => {
          const active = c.key === cat;
          return (
            <TouchableOpacity
              key={c.key}
              onPress={() => setCat(c.key)}
              style={[
                styles.tab,
                {
                  backgroundColor: active
                    ? colors.accentPurple
                    : colors.surface,
                },
              ]}
              accessibilityLabel={`Category ${c.key}`}
            >
              <Text style={styles.tabEmoji}>{c.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView style={styles.gridScroll} contentContainerStyle={styles.grid}>
        {current.emojis.map((e) => (
          <TouchableOpacity
            key={e}
            onPress={() => {
              if (__DEV__) console.log(`[StickerSheet] picked ${e} (${mode})`);
              onPick(e);
            }}
            style={[styles.cell, { backgroundColor: colors.surface }]}
            accessibilityLabel={`Sticker ${e}`}
          >
            <Text style={styles.cellEmoji}>{e}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 340,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 10,
    elevation: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  title: { fontSize: 16, fontWeight: "600" },
  tabsScroll: { flexGrow: 0, flexShrink: 0 },
  tabs: { gap: 8, paddingHorizontal: 14, alignItems: "center" },
  tab: {
    width: 44,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  tabEmoji: { fontSize: 20 },
  gridScroll: { flex: 1 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  cell: {
    width: 52,
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  cellEmoji: { fontSize: 30 },
});
