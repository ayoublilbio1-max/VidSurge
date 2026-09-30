import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  DEFAULT_TEXT_DATA,
  type TextAlign,
  type TextClipData,
} from "../../editor/clipModel";
import {
  FONTS,
  fontStatus,
  fontStyleFor,
  loadFont,
  useFontsVersion,
} from "../../editor/fonts";
import { useTheme } from "../../hooks/useTheme";
import AppText from "../AppText";
import ColorPicker from "./ColorPicker";
import SliderBar from "./SliderBar";
import TextVisual from "./TextVisual";

// Smallest height of the tab panel (Fonts / Styles...). Normally it's as
// tall as the keyboard was, so the panel takes the keyboard's place exactly
// and nothing jumps when the keyboard closes (CapCut does the same).
export const MIN_PANEL_HEIGHT = 260;

type TabKey =
  | "templates"
  | "fonts"
  | "styles"
  | "effects"
  | "animations"
  | "bubbles";
const TABS: { key: TabKey; label: string; ready: boolean }[] = [
  { key: "templates", label: "Templates", ready: false },
  { key: "fonts", label: "Fonts", ready: true },
  { key: "styles", label: "Styles", ready: true },
  { key: "effects", label: "Effects", ready: false },
  { key: "animations", label: "Animations", ready: false },
  { key: "bubbles", label: "Bubbles", ready: false },
];

type SubKey = "text" | "stroke" | "glow" | "background" | "shadow";
type ColorField =
  | "color"
  | "strokeColor"
  | "glowColor"
  | "bgColor"
  | "shadowColor";
type NumberField =
  | "size"
  | "opacity"
  | "strokeWidth"
  | "glowRadius"
  | "bgOpacity"
  | "bgRadius"
  | "shadowDistance"
  | "shadowBlur";

// Styles sub-tabs: which colour they set, and their sliders (min–max are
// the real values the 0–1 slider maps to).
const SUBS: {
  key: SubKey;
  label: string;
  color: ColorField;
  sliders: { label: string; field: NumberField; min: number; max: number }[];
}[] = [
  {
    key: "text",
    label: "Text",
    color: "color",
    sliders: [
      { label: "Size", field: "size", min: 0.025, max: 0.14 },
      { label: "Opacity", field: "opacity", min: 0.1, max: 1 },
    ],
  },
  {
    key: "stroke",
    label: "Stroke",
    color: "strokeColor",
    sliders: [
      { label: "Thickness", field: "strokeWidth", min: 0.02, max: 0.25 },
    ],
  },
  {
    key: "glow",
    label: "Glow",
    color: "glowColor",
    sliders: [{ label: "Intensity", field: "glowRadius", min: 0.1, max: 1.5 }],
  },
  {
    key: "background",
    label: "Background",
    color: "bgColor",
    sliders: [
      { label: "Opacity", field: "bgOpacity", min: 0.1, max: 1 },
      { label: "Roundness", field: "bgRadius", min: 0, max: 0.8 },
    ],
  },
  {
    key: "shadow",
    label: "Shadow",
    color: "shadowColor",
    sliders: [
      { label: "Distance", field: "shadowDistance", min: 0, max: 0.3 },
      { label: "Blur", field: "shadowBlur", min: 0, max: 0.6 },
    ],
  },
];

const SWATCHES = [
  "#FFFFFF",
  "#BDBDBD",
  "#7A7A7A",
  "#3A3A3A",
  "#000000",
  "#FFE600",
  "#FF9500",
  "#FF3B30",
  "#FF2D92",
  "#AF52DE",
  "#0A84FF",
  "#0AF5FF",
  "#34C759",
];

// Style presets (the "Aa" row). ⊘ = back to plain text.
const STYLE_RESET: Partial<TextClipData> = {
  color: DEFAULT_TEXT_DATA.color,
  opacity: 1,
  strokeColor: null,
  strokeWidth: DEFAULT_TEXT_DATA.strokeWidth,
  glowColor: null,
  glowRadius: DEFAULT_TEXT_DATA.glowRadius,
  bgColor: null,
  bgOpacity: DEFAULT_TEXT_DATA.bgOpacity,
  bgRadius: DEFAULT_TEXT_DATA.bgRadius,
  shadowColor: null,
  shadowDistance: DEFAULT_TEXT_DATA.shadowDistance,
  shadowBlur: DEFAULT_TEXT_DATA.shadowBlur,
};
const PRESETS: Partial<TextClipData>[] = [
  { color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 0.1 },
  { color: "#000000", strokeColor: "#FFFFFF", strokeWidth: 0.1 },
  {
    color: "#FFFFFF",
    shadowColor: "#000000",
    shadowDistance: 0.08,
    shadowBlur: 0.1,
  },
  { color: "#FFE600", strokeColor: "#000000", strokeWidth: 0.1 },
  { color: "#FF3B30", strokeColor: "#FFFFFF", strokeWidth: 0.1 },
  { color: "#FF9500", strokeColor: "#FFFFFF", strokeWidth: 0.1 },
  { color: "#0A84FF", strokeColor: "#FFFFFF", strokeWidth: 0.1 },
  { color: "#FFFFFF", bgColor: "#000000", bgOpacity: 0.75, bgRadius: 0.25 },
  { color: "#000000", bgColor: "#FFFFFF", bgOpacity: 0.9, bgRadius: 0.25 },
  { color: "#FFFFFF", glowColor: "#FF2D92", glowRadius: 0.6 },
  { color: "#FFFFFF", glowColor: "#0AF5FF", glowRadius: 0.6 },
];

/**
 * CapCut-style text sheet: the text field + ✓ on top, the tabs row, and
 * under it either the keyboard (while typing) or the chosen tab's panel.
 * Tapping a tab (or the keyboard key) closes the keyboard and shows the
 * panel; tapping the text field brings the keyboard back. Every change is
 * sent as a patch and drawn live on the preview by the editor.
 */
export default function TextEditorSheet({
  mode,
  value,
  keyboardOpen,
  bottomOffset,
  panelHeight,
  onPatch,
  onDone,
  onCancel,
  onHeight,
}: {
  mode: "add" | "edit";
  value: TextClipData;
  keyboardOpen: boolean;
  /** Keyboard height still to lift the sheet by (see editor). */
  bottomOffset: number;
  /** Height of the tab panel: the keyboard's last height (see editor). */
  panelHeight: number;
  onPatch: (patch: Partial<TextClipData>) => void;
  onDone: () => void;
  /** ✕ at the start of the input row: close without saving. */
  onCancel: () => void;
  /**
   * The sheet's height WITHOUT its panel / the keyboard below it (input
   * row, tabs, paddings). The editor adds the panel height itself, which is
   * the same with or without the keyboard — so the preview size doesn't
   * change when the keyboard opens or closes.
   */
  onHeight: (height: number) => void;
}) {
  const colors = useTheme();
  useFontsVersion(); // re-render when a font finishes loading
  const [tab, setTab] = useState<TabKey>("styles");
  const [sub, setSub] = useState<SubKey>("text");
  const [pickerOpen, setPickerOpen] = useState(false);
  const subDef = SUBS.find((s) => s.key === sub)!;
  const currentColor = value[subDef.color];

  const chooseTab = (key: TabKey) => {
    Keyboard.dismiss();
    setPickerOpen(false);
    setTab(key);
    if (__DEV__) console.log(`[TextEditorSheet] tab → ${key}`);
  };

  const chooseFont = (id: string) => {
    if (fontStatus(id) === "loaded") {
      onPatch({ font: id });
      return;
    }
    if (__DEV__)
      console.log(`[TextEditorSheet] font ${id} not loaded yet — loading`);
    void loadFont(id).then((ok) => {
      if (ok) onPatch({ font: id });
    });
  };

  const renderFonts = () => (
    <ScrollView contentContainerStyle={styles.fontGrid}>
      {FONTS.map((f) => {
        const status = fontStatus(f.id);
        const active = value.font === f.id;
        return (
          <TouchableOpacity
            key={f.id}
            onPress={() => chooseFont(f.id)}
            disabled={status === "loading"}
            style={[
              styles.fontTile,
              {
                backgroundColor: colors.surface,
                borderColor: active ? colors.textPrimary : "transparent",
              },
            ]}
          >
            {/* Fonts ship with the app and load when the editor opens; a
                spinner only shows for the moment they're still loading. */}
            {f.kind === "google" &&
              (status === "loading" || status === "error") && (
                <View style={styles.fontBadge}>
                  {status === "loading" ? (
                    <ActivityIndicator size="small" color={colors.textMuted} />
                  ) : (
                    <Ionicons
                      name="alert-circle-outline"
                      size={14}
                      color={colors.textMuted}
                    />
                  )}
                </View>
              )}
            <Text
              numberOfLines={1}
              style={[
                fontStyleFor(f.id),
                styles.fontLabel,
                { color: colors.textPrimary },
              ]}
            >
              {f.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );

  // The colour picker replaces the Styles panel while open. `pickerStart`
  // is the colour before it opened (Cancel puts it back).
  const [pickerStart, setPickerStart] = useState<string | null>(null);
  const openPicker = () => {
    setPickerStart(currentColor);
    setPickerOpen(true);
    if (__DEV__) console.log(`[TextEditorSheet] colour picker open (${sub})`);
  };

  const renderStyles = () =>
    pickerOpen ? (
      <ColorPicker
        initial={currentColor ?? "#FFFFFF"}
        onChange={(hex) => onPatch({ [subDef.color]: hex })}
        onDone={() => {
          setPickerOpen(false);
          if (__DEV__)
            console.log(
              `[TextEditorSheet] ${sub} colour → ${value[subDef.color]} (picker)`,
            );
        }}
        onCancel={() => {
          setPickerOpen(false);
          onPatch({ [subDef.color]: pickerStart });
        }}
      />
    ) : (
      <View style={styles.stylesPanel}>
        {/* Presets */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.row}
        >
          <TouchableOpacity
            onPress={() => onPatch(STYLE_RESET)}
            style={[styles.presetTile, { backgroundColor: colors.surface }]}
            accessibilityLabel="No style"
          >
            <Ionicons name="ban-outline" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          {PRESETS.map((p, i) => (
            <TouchableOpacity
              key={i}
              onPress={() => onPatch({ ...STYLE_RESET, ...p })}
              style={[styles.presetTile, { backgroundColor: colors.surface }]}
            >
              <TextVisual
                data={{
                  ...DEFAULT_TEXT_DATA,
                  ...STYLE_RESET,
                  ...p,
                  font: "bold",
                  text: "Aa",
                }}
                fontSize={18}
              />
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Sub-tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.subRow}
        >
          {SUBS.map((s) => (
            <TouchableOpacity key={s.key} onPress={() => setSub(s.key)}>
              <AppText
                style={[
                  styles.subLabel,
                  {
                    color:
                      sub === s.key ? colors.textPrimary : colors.textMuted,
                  },
                ]}
              >
                {s.label}
              </AppText>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Colours: rainbow = any colour; ⊘ = none (not for the text colour) */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
        >
          <TouchableOpacity
            onPress={openPicker}
            style={styles.rainbow}
            accessibilityLabel="Pick any colour"
          >
            {[
              "#FF3B30",
              "#FF9500",
              "#FFE600",
              "#34C759",
              "#0A84FF",
              "#AF52DE",
            ].map((c) => (
              <View key={c} style={{ flex: 1, backgroundColor: c }} />
            ))}
          </TouchableOpacity>
          {sub !== "text" && (
            <TouchableOpacity
              onPress={() => onPatch({ [subDef.color]: null })}
              style={[
                styles.swatch,
                styles.noneSwatch,
                {
                  borderColor:
                    currentColor === null
                      ? colors.textPrimary
                      : colors.iconInactive,
                  borderWidth: currentColor === null ? 3 : 1,
                },
              ]}
              accessibilityLabel="None"
            >
              <Ionicons
                name="ban-outline"
                size={18}
                color={colors.textPrimary}
              />
            </TouchableOpacity>
          )}
          {SWATCHES.map((c) => {
            const active = currentColor?.toUpperCase() === c;
            return (
              <TouchableOpacity
                key={c}
                onPress={() => onPatch({ [subDef.color]: c })}
                style={[
                  styles.swatch,
                  {
                    backgroundColor: c,
                    borderColor: active
                      ? colors.textPrimary
                      : "rgba(255,255,255,0.15)",
                    borderWidth: active ? 3 : 1,
                  },
                ]}
                accessibilityLabel={`Colour ${c}`}
              />
            );
          })}
        </ScrollView>

        {/* Sliders */}
        {subDef.sliders.map((sl) => {
          const disabled = sub !== "text" && currentColor === null;
          const f = (value[sl.field] - sl.min) / (sl.max - sl.min);
          return (
            <View key={sl.field} style={styles.sliderRow}>
              <AppText
                style={[styles.sliderLabel, { color: colors.textMuted }]}
              >
                {sl.label}
              </AppText>
              <SliderBar
                value={f}
                onChange={(v) =>
                  onPatch({ [sl.field]: sl.min + v * (sl.max - sl.min) })
                }
                trackColor={colors.surface}
                fillColor={colors.accentPurple}
                disabled={disabled}
                accessibilityLabel={sl.label}
              />
            </View>
          );
        })}

        {/* Alignment (Text only) — below the sliders */}
        {sub === "text" && (
          <View style={styles.alignRow}>
            {(["left", "center", "right"] as TextAlign[]).map((a) => (
              <TouchableOpacity
                key={a}
                onPress={() => onPatch({ align: a })}
                style={[
                  styles.alignButton,
                  {
                    backgroundColor:
                      value.align === a ? colors.accentPurple : colors.surface,
                  },
                ]}
                accessibilityLabel={`Align ${a}`}
              >
                <AlignIcon
                  align={a}
                  color={value.align === a ? "#FFFFFF" : colors.textPrimary}
                />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    );

  const tabDef = TABS.find((t) => t.key === tab)!;

  return (
    <View
      style={[
        styles.sheet,
        { bottom: bottomOffset, backgroundColor: colors.background },
      ]}
      onLayout={(e: { nativeEvent: { layout: { height: number } } }) =>
        onHeight(
          e.nativeEvent.layout.height -
            (keyboardOpen ? 0 : Math.max(MIN_PANEL_HEIGHT, panelHeight)),
        )
      }
    >
      <View style={styles.inputRow}>
        {/* ✕ closes without saving (a new text is dropped, an edited one
            keeps its old words and style). */}
        <TouchableOpacity
          onPress={() => {
            Keyboard.dismiss();
            if (__DEV__) console.log("[TextEditorSheet] ✕ pressed — cancel");
            onCancel();
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Ionicons name="close" size={28} color={colors.textPrimary} />
        </TouchableOpacity>
        <TextInput
          value={value.text}
          onChangeText={(text: string) => onPatch({ text })}
          placeholder="Enter text"
          placeholderTextColor={colors.textMuted}
          autoFocus={mode === "add"}
          multiline
          maxLength={200}
          style={[
            styles.input,
            { backgroundColor: colors.surface, color: colors.textPrimary },
          ]}
        />
        {/* ✓ is always there — also while typing — and saves + closes.
            To style the text instead, tap a tab (the keyboard closes). */}
        <TouchableOpacity
          onPress={() => {
            Keyboard.dismiss();
            onDone();
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Done"
        >
          <Ionicons name="checkmark" size={30} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <View
        style={[styles.grabber, { backgroundColor: colors.iconInactive }]}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.tabRow}
      >
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <TouchableOpacity
              key={t.key}
              onPress={() => chooseTab(t.key)}
              style={styles.tab}
            >
              <AppText
                style={[
                  styles.tabLabel,
                  { color: active ? colors.textPrimary : colors.textMuted },
                ]}
              >
                {t.label}
              </AppText>
              <View
                style={[
                  styles.tabUnderline,
                  {
                    backgroundColor: active
                      ? colors.accentPurple
                      : "transparent",
                  },
                ]}
              />
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {!keyboardOpen && (
        <View
          style={[
            styles.panel,
            {
              height: Math.max(MIN_PANEL_HEIGHT, panelHeight),
              borderTopColor: colors.surface,
            },
          ]}
        >
          {tabDef.ready ? (
            tab === "fonts" ? (
              renderFonts()
            ) : (
              renderStyles()
            )
          ) : (
            <View style={styles.soon}>
              <Ionicons
                name="time-outline"
                size={28}
                color={colors.textMuted}
              />
              <AppText style={{ color: colors.textMuted }}>
                {tabDef.label} — coming soon
              </AppText>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

/** Three bars lined up left / centre / right. */
function AlignIcon({ align, color }: { align: TextAlign; color: string }) {
  const alignItems =
    align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
  return (
    <View style={{ width: 20, gap: 3, alignItems }}>
      {[20, 12, 16].map((w, i) => (
        <View
          key={i}
          style={{
            width: w,
            height: 2,
            backgroundColor: color,
            borderRadius: 1,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 12,
    paddingBottom: 22,
    elevation: 12,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 90,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 16,
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginTop: 10,
  },
  tabRow: { paddingHorizontal: 14, gap: 22, paddingTop: 10 },
  tab: { alignItems: "center", gap: 6 },
  tabLabel: { fontSize: 15, fontWeight: "600" },
  tabUnderline: { width: 28, height: 3, borderRadius: 2 },
  panel: { borderTopWidth: 1 },
  soon: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  fontGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    padding: 14,
  },
  fontTile: {
    width: "31.5%",
    height: 46,
    borderRadius: 8,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  fontBadge: { position: "absolute", top: 3, left: 4 },
  fontLabel: { fontSize: 16 },
  stylesPanel: { paddingTop: 12, gap: 10 },
  row: { paddingHorizontal: 14, gap: 10, alignItems: "center" },
  presetTile: {
    width: 48,
    height: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  subRow: { paddingHorizontal: 14, gap: 22 },
  subLabel: { fontSize: 14, fontWeight: "600" },
  rainbow: {
    width: 34,
    height: 34,
    borderRadius: 17,
    overflow: "hidden",
    flexDirection: "row",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  swatch: { width: 34, height: 34, borderRadius: 17 },
  noneSwatch: { alignItems: "center", justifyContent: "center" },
  alignRow: { flexDirection: "row", gap: 10, paddingHorizontal: 14 },
  alignButton: {
    width: 44,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  sliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
  },
  sliderLabel: { width: 76, fontSize: 13 },
});
