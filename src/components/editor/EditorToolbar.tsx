import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
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
// Split / Delete: the tapped button shows a spinner for this long, then the
// edit is applied (the edit itself is instant — this is a short, deliberate
// "working" moment so the tap reads as an action). Tune here; 0 = off.
const EDIT_SPINNER_MS = 350;
// What a busy tool says under its spinner.
const BUSY_LABEL: Record<string, string> = {
  split: "Splitting…",
  delete: "Deleting…",
  music: "Adding…",
};

// Selection-based toolbar (CapCut style).
// Nothing selected → project tools (things you ADD to the project).
const PROJECT_TOOLS: EditorTool[] = [
  { key: "music", icon: "musical-notes-outline", label: "Music" },
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

// A text clip selected: Edit (words + style), Split, Delete, Duplicate.
const TEXT_TOOLS: EditorTool[] = [
  { key: "editText", icon: "create-outline", label: "Edit" },
  SPLIT,
  DELETE,
  { key: "duplicate", icon: "duplicate-outline", label: "Duplicate" },
];

/** What is selected, for choosing the tools. */
export type SelectionKind = "none" | "locked" | "video" | "audio" | "text";

const TOOLS_BY_SELECTION: Record<SelectionKind, EditorTool[]> = {
  none: PROJECT_TOOLS,
  locked: [SPLIT, DELETE, SPEED, VOLUME, ...PICTURE_TOOLS],
  video: [SPLIT, DELETE, SPEED, ...PICTURE_TOOLS],
  audio: [SPLIT, DELETE, SPEED, VOLUME],
  text: TEXT_TOOLS,
};

interface EditorToolbarProps {
  /** What is selected: nothing → project tools; a clip → its clip tools. */
  selectionKind: SelectionKind;
  lockMode: LockMode;
  /** Split can cut the selected clip at the playhead right now. */
  splitEnabled: boolean;
  /**
   * Delete can remove the selected clip (not when it would leave the
   * project with no clips at all — there's no way to add media back yet).
   */
  deleteEnabled: boolean;
  onUnlock: () => void;
  onSplit: () => void;
  onDelete: () => void;
  /**
   * A tool whose work is still running (e.g. "music" while a picked song is
   * being read): it shows a spinner and can't be tapped again.
   */
  busyToolKey?: string | null;
  /**
   * Split / Delete tapped (before the spinner): lets the editor pause right
   * away, so the edit happens where the playhead was at the tap.
   */
  onEditStart?: (key: string) => void;
  /** Any other tool (the ones not built yet). */
  onToolPress: (key: string) => void;
}

export default function EditorToolbar({
  selectionKind,
  lockMode,
  splitEnabled,
  deleteEnabled,
  onUnlock,
  onSplit,
  onDelete,
  onToolPress,
  busyToolKey = null,
  onEditStart,
}: EditorToolbarProps) {
  const colors = useTheme();
  const lockActive = lockMode === "locked";
  // The Lock button is for video/audio pairs only — not shown for text.
  const hasSelection = selectionKind !== "none" && selectionKind !== "text";
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

  // The Split / Delete button currently showing its spinner.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    },
    [],
  );
  // Spinner on `key` for EDIT_SPINNER_MS, then run the edit.
  const runWithSpinner = (key: string, edit: () => void) => {
    if (pendingKey) return; // one at a time
    onEditStart?.(key);
    setPendingKey(key);
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      if (__DEV__) console.log(`[EditorToolbar] ${key} — applying`);
      edit();
      setPendingKey(null);
    }, EDIT_SPINNER_MS);
  };

  const handleToolPress = (key: string) => {
    if (key === "split") {
      if (__DEV__)
        console.log(
          `[EditorToolbar] split pressed${splitEnabled ? "" : " — disabled (playhead not inside the selected clip)"}`,
        );
      if (splitEnabled) runWithSpinner("split", onSplit);
      return;
    }
    if (key === "delete") {
      if (__DEV__)
        console.log(
          `[EditorToolbar] delete pressed${deleteEnabled ? "" : " — disabled (it's the last clip in the project)"}`,
        );
      if (deleteEnabled) runWithSpinner("delete", onDelete);
      return;
    }
    if (__DEV__) console.log(`[EditorToolbar] ${key} pressed`);
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
        const busy = busyToolKey === tool.key || pendingKey === tool.key;
        const disabled =
          busy ||
          pendingKey !== null ||
          (tool.key === "split" && !splitEnabled) ||
          (tool.key === "delete" && !deleteEnabled);
        return (
          // Pressed look: the icon tile turns accent-coloured and shrinks a
          // little while the finger is down, so a tap always visibly
          // registers — edits themselves are instant (no spinner needed).
          <Pressable
            key={tool.key}
            style={[
              styles.item,
              disabled && !busy && { opacity: DISABLED_OPACITY },
            ]}
            onPress={() => handleToolPress(tool.key)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled, busy }}
            accessibilityLabel={busy ? `${tool.label} (working)` : tool.label}
          >
            {({ pressed }: { pressed: boolean }) => (
              <>
                <View
                  style={[
                    styles.iconWrap,
                    {
                      backgroundColor: pressed
                        ? colors.accentPurple
                        : colors.surface,
                    },
                    pressed && styles.iconWrapPressed,
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.accentPurple}
                    />
                  ) : (
                    <Ionicons
                      name={tool.icon}
                      size={20}
                      color={pressed ? "#FFFFFF" : colors.textPrimary}
                    />
                  )}
                </View>
                <AppText style={[styles.label, { color: colors.textMuted }]}>
                  {busy ? (BUSY_LABEL[tool.key] ?? tool.label) : tool.label}
                </AppText>
              </>
            )}
          </Pressable>
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
  iconWrapPressed: { transform: [{ scale: 0.92 }] },
  label: { fontSize: 10, textAlign: "center" },
});
