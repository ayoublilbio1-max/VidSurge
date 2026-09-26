import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import {
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";

export interface EditorTool {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}

/**
 * State of the Lock button, from the selected clip:
 *   locked   — the selected clip is locked to its partner: active, tap to
 *              unlock (one-way, there is no re-lock)
 *   unlocked — the selected clip was already unlocked: greyed out, open
 *              lock, "Unlocked"
 * ("none" = nothing selected: the Lock button isn't shown at all, since it
 * only lives in the clip tools.)
 */
export type LockMode = "none" | "locked" | "unlocked";

const DISABLED_OPACITY = 0.4;

// Selection-based toolbar (CapCut style).
// Nothing selected → project tools (things you ADD to the project).
const PROJECT_TOOLS: EditorTool[] = [
  { key: "canvas", icon: "tablet-portrait-outline", label: "Canvas" },
  { key: "addText", icon: "text-outline", label: "Add text" },
  { key: "stickers", icon: "happy-outline", label: "Stickers" },
  { key: "pip", icon: "copy-outline", label: "PIP" },
  { key: "voiceRecord", icon: "mic-outline", label: "Voice record" },
  { key: "effects", icon: "sparkles-outline", label: "Effects" },
];

// A clip selected → clip tools (things you do TO that clip). Lock comes
// first, before these. Which tools depend on what is selected:
//   - both clips of a locked pair (they act as one): everything. Split,
//     Delete and Speed apply to both clips, Volume to the audio, and the
//     picture tools (Crop, Rotate, Filter, Opacity, Reverse) to the video.
//   - an unlocked video clip: no Volume (its sound lives on the audio clip)
//   - an unlocked audio clip: no picture tools
const SPLIT: EditorTool = { key: "split", icon: "cut-outline", label: "Split" };
const DELETE: EditorTool = {
  key: "delete",
  icon: "trash-outline",
  label: "Delete",
};
const SPEED: EditorTool = {
  key: "speed",
  icon: "speedometer-outline",
  label: "Speed",
};
const VOLUME: EditorTool = {
  key: "volume",
  icon: "volume-high-outline",
  label: "Volume",
};
const PICTURE_TOOLS: EditorTool[] = [
  { key: "crop", icon: "crop-outline", label: "Crop" },
  { key: "rotate", icon: "refresh-outline", label: "Rotate" },
  { key: "filter", icon: "color-filter-outline", label: "Filter" },
  { key: "opacity", icon: "contrast-outline", label: "Opacity" },
  { key: "reverse", icon: "play-back-outline", label: "Reverse" },
];

/** What is selected, for choosing the tools. */
export type SelectionKind = "none" | "locked" | "video" | "audio";

const TOOLS_BY_SELECTION: Record<SelectionKind, EditorTool[]> = {
  none: PROJECT_TOOLS,
  locked: [SPLIT, DELETE, SPEED, VOLUME, ...PICTURE_TOOLS],
  video: [SPLIT, DELETE, SPEED, ...PICTURE_TOOLS],
  audio: [SPLIT, DELETE, SPEED, VOLUME],
};

interface EditorToolbarProps {
  /** What is selected: nothing → project tools; a clip → its clip tools. */
  selectionKind: SelectionKind;
  lockMode: LockMode;
  /** Split can cut the selected clip at the playhead right now. */
  splitEnabled: boolean;
  onUnlock: () => void;
  onSplit: () => void;
  /** Any other tool (the ones not built yet). */
  onToolPress: (key: string) => void;
}

export default function EditorToolbar({
  selectionKind,
  lockMode,
  splitEnabled,
  onUnlock,
  onSplit,
  onToolPress,
}: EditorToolbarProps) {
  const colors = useTheme();
  const lockActive = lockMode === "locked";
  const hasSelection = selectionKind !== "none";
  const scrollRef = useRef<ScrollView>(null);

  // A different tool set: start it from the first tool. Otherwise the old
  // scroll position carries over, and switching from a long list (locked
  // clip tools) to a short one (audio tools) left the row scrolled past its
  // end — it looked broken until you touched it.
  useEffect(() => {
    scrollRef.current?.scrollTo({ x: 0, animated: false });
    if (__DEV__)
      console.log(
        `[EditorToolbar] showing ${selectionKind === "none" ? "project tools" : `${selectionKind} clip tools`} (scrolled to start)`,
      );
  }, [selectionKind]);

  const handleLockPress = () => {
    if (__DEV__)
      console.log(
        `[EditorToolbar] lock button pressed (${lockMode}${lockActive ? " — unlocking" : " — disabled"})`,
      );
    if (lockActive) onUnlock();
  };

  const handleToolPress = (key: string) => {
    if (key === "split") {
      if (__DEV__)
        console.log(
          `[EditorToolbar] split pressed${splitEnabled ? "" : " — disabled (playhead not inside the selected clip)"}`,
        );
      if (splitEnabled) onSplit();
      return;
    }
    if (__DEV__) console.log(`[EditorToolbar] ${key} pressed (coming soon)`);
    onToolPress(key);
  };

  const tools = TOOLS_BY_SELECTION[selectionKind];

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      // Android: let this horizontal row scroll inside the screen's
      // vertical ScrollView instead of the page grabbing the swipe.
      nestedScrollEnabled
      // Taps on a tool work even right after a scroll/fling.
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.row}
      onScrollBeginDrag={() => {
        if (__DEV__) console.log("[EditorToolbar] scroll start");
      }}
      onMomentumScrollEnd={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (__DEV__)
          console.log(
            `[EditorToolbar] scroll end @ x=${Math.round(e.nativeEvent.contentOffset.x)}`,
          );
      }}
    >
      {hasSelection && (
        <TouchableOpacity
          style={[styles.item, !lockActive && { opacity: DISABLED_OPACITY }]}
          onPress={handleLockPress}
          disabled={!lockActive}
          accessibilityRole="button"
          accessibilityState={{ disabled: !lockActive }}
          accessibilityLabel={
            lockActive ? "Unlock audio from video" : "Clip is unlocked"
          }
        >
          <View
            style={[
              styles.iconWrap,
              {
                backgroundColor: lockActive
                  ? colors.accentPurple
                  : colors.surface,
              },
            ]}
          >
            <Ionicons
              name={lockActive ? "lock-closed-outline" : "lock-open-outline"}
              size={20}
              color={lockActive ? "#FFFFFF" : colors.textPrimary}
            />
          </View>
          <AppText style={[styles.label, { color: colors.textMuted }]}>
            {lockActive ? "Locked" : "Unlocked"}
          </AppText>
        </TouchableOpacity>
      )}

      {tools.map((tool) => {
        const disabled = tool.key === "split" && !splitEnabled;
        return (
          <TouchableOpacity
            key={tool.key}
            style={[styles.item, disabled && { opacity: DISABLED_OPACITY }]}
            onPress={() => handleToolPress(tool.key)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            accessibilityLabel={tool.label}
          >
            <View
              style={[styles.iconWrap, { backgroundColor: colors.surface }]}
            >
              <Ionicons name={tool.icon} size={20} color={colors.textPrimary} />
            </View>
            <AppText style={[styles.label, { color: colors.textMuted }]}>
              {tool.label}
            </AppText>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, gap: 15, paddingVertical: 4 },
  item: { alignItems: "center", gap: 6, width: 60 },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { fontSize: 10, textAlign: "center" },
});
