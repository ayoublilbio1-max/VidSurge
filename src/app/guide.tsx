// The "?" guide: a visual tour of every tool in the app.
//
// Opened from the editor's "?" button (top left). Built only from views and
// icons (no images), so it always matches the app's colours and the light /
// dark theme. Sections: the editor screen (a labelled map), the timeline (a
// labelled mini timeline), clip tools, project tools, texts / stickers /
// PIP on the preview, multi-select, and export. Chips at the top jump to a
// section.

import { Ionicons } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppText from "../components/AppText";
import { useTheme } from "../hooks/useTheme";

type IconName = ComponentProps<typeof Ionicons>["name"];
type Colors = ReturnType<typeof useTheme>;

// Timeline colours, the same as the real timeline.
const TEXT_CLIP_COLOR = "#8A5516";
const STICKER_CLIP_COLOR = "#5A3A8A";

/** One tool: icon, name, what it does, how to use it. */
type Tool = {
  icon: IconName;
  name: string;
  what: string;
  how: string[];
  /** Not in the demo yet (shown with a "Soon" badge). */
  soon?: boolean;
};

// ---- Content -------------------------------------------------------------

const CLIP_TOOLS: Tool[] = [
  {
    icon: "lock-closed-outline",
    name: "Lock",
    what: "A video and its own sound start locked together: they move, cut and change speed as one.",
    how: [
      "Select the video or its sound — both light up.",
      "Tap Locked to unlock them. After that each one moves on its own.",
    ],
  },
  {
    icon: "cut-outline",
    name: "Split",
    what: "Cuts the selected clip in two at the white playhead line.",
    how: [
      "Move the timeline so the line is where you want the cut.",
      "Select the clip, tap Split.",
      "The rest of the file is kept: drag a piece's edge to get it back.",
    ],
  },
  {
    icon: "trash-outline",
    name: "Delete",
    what: "Removes the selected clip (and its locked partner). The space it leaves stays empty.",
    how: ["Select the clip, tap Delete.", "Changed your mind? Tap Undo."],
  },
  {
    icon: "speedometer-outline",
    name: "Speed",
    what: "Plays the clip faster or slower, from 0.1× to 10×. The clip gets shorter or longer on the timeline.",
    how: ["Select the clip, tap Speed.", "Pick a speed and tap ✓."],
  },
  {
    icon: "volume-high-outline",
    name: "Volume",
    what: "How loud a sound clip is, from 0% to 200%. Above 100% is louder in the exported video.",
    how: ["Select a sound clip, tap Volume, move the slider."],
  },
  {
    icon: "refresh-outline",
    name: "Rotate",
    what: "Turns the picture by 90° steps or any angle, and flips it like a mirror.",
    how: [
      "Select a video clip, tap Rotate.",
      "Use ↺ / ↻, the slider, or Flip. Reset puts it back.",
    ],
  },
  {
    icon: "contrast-outline",
    name: "Opacity",
    what: "Makes a video or PIP see-through, so the canvas colour shows through it.",
    how: ["Select the clip, tap Opacity, move the slider."],
  },
  {
    icon: "color-filter-outline",
    name: "Filter",
    what: "Colour looks for your video.",
    how: ["Coming in the full version."],
    soon: true,
  },
  {
    icon: "play-back-outline",
    name: "Reverse",
    what: "Plays a clip backwards.",
    how: ["Coming in the full version."],
    soon: true,
  },
];

const PROJECT_TOOLS: Tool[] = [
  {
    icon: "musical-notes-outline",
    name: "Music",
    what: "Adds a song from your phone at the playhead. If another sound is in the way, the song is shortened to fit — nothing else moves.",
    how: [
      "Put the playhead where the music should start.",
      "Tap Music and pick a song.",
      "Drag its edges to make it longer or shorter.",
    ],
  },
  {
    icon: "tablet-portrait-outline",
    name: "Canvas",
    what: "The shape of your video (Original, 9:16, 16:9, 1:1, 4:5, 3:4) and the colour behind it.",
    how: ["Tap Canvas, pick a shape and a colour, tap ✓."],
  },
  {
    icon: "crop-outline",
    name: "Crop",
    what: "Keeps only part of the picture — the video takes that shape.",
    how: [
      "Tap Crop and drag the box corners, or pick a preset.",
      "Tap ✓. Reset shows the whole picture again.",
    ],
  },
  {
    icon: "text-outline",
    name: "Add text",
    what: "Writes text over the video, with fonts, colours, outline, glow, box and shadow.",
    how: [
      "Tap Add text, type, pick a style, tap ✓.",
      "Drag the text on the preview to move it.",
    ],
  },
  {
    icon: "happy-outline",
    name: "Stickers",
    what: "Puts an emoji sticker over the video.",
    how: [
      "Tap Stickers and pick one.",
      "Move, turn and resize it on the preview.",
    ],
  },
  {
    icon: "copy-outline",
    name: "PIP",
    what: "A second video or a photo over your video (picture-in-picture). PIP videos are silent.",
    how: [
      "Tap PIP and pick a video or photo.",
      "Move, turn and resize it on the preview.",
      "Select it on the timeline for Speed, Opacity, Split, Delete.",
    ],
  },
  {
    icon: "mic-outline",
    name: "Voice record",
    what: "Record your voice over the video.",
    how: ["Coming in the full version."],
    soon: true,
  },
  {
    icon: "sparkles-outline",
    name: "Effects",
    what: "Animated effects for your video.",
    how: ["Coming in the full version."],
    soon: true,
  },
];

const SECTIONS = [
  { key: "editor", label: "Editor" },
  { key: "timeline", label: "Timeline" },
  { key: "clip", label: "Clip tools" },
  { key: "project", label: "Add & project" },
  { key: "preview", label: "On the preview" },
  { key: "multi", label: "Multi-select" },
  { key: "export", label: "Export" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

// ---- Screen ----------------------------------------------------------------

export default function GuideScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const sectionY = useRef<Partial<Record<SectionKey, number>>>({});
  const [active, setActive] = useState<SectionKey>("editor");
  // The guide's many drawings are built after the screen has slid in: a
  // skeleton shows meanwhile, so opening it never stutters.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const openedAt = Date.now();
    const t = setTimeout(() => {
      setReady(true);
      if (__DEV__)
        console.log(
          `[guide] content shown after ${Date.now() - openedAt}ms (skeleton before)`,
        );
    }, 280);
    return () => clearTimeout(t);
  }, []);

  const jumpTo = (key: SectionKey) => {
    const y = sectionY.current[key];
    if (__DEV__)
      console.log(
        `[guide] jump to ${key}${y === undefined ? " (not laid out yet)" : ` @${Math.round(y)}`}`,
      );
    setActive(key);
    if (y !== undefined)
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
  };

  const section = (
    key: SectionKey,
    title: string,
    intro: string,
    children: ReactNode,
  ) => (
    <View
      key={key}
      onLayout={(e: { nativeEvent: { layout: { y: number } } }) => {
        sectionY.current[key] = e.nativeEvent.layout.y;
      }}
      style={styles.section}
    >
      <AppText style={[styles.sectionTitle, { color: colors.textPrimary }]}>
        {title}
      </AppText>
      <AppText style={[styles.sectionIntro, { color: colors.textMuted }]}>
        {intro}
      </AppText>
      {children}
    </View>
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
          style={[styles.backButton, { backgroundColor: colors.surface }]}
          hitSlop={8}
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <AppText style={[styles.title, { color: colors.textPrimary }]}>
            Guide
          </AppText>
          <AppText style={[styles.subtitle, { color: colors.textMuted }]}>
            Every tool, step by step
          </AppText>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        style={styles.chipsBar}
      >
        {SECTIONS.map((s) => {
          const on = s.key === active;
          return (
            <TouchableOpacity
              key={s.key}
              onPress={() => jumpTo(s.key)}
              style={[
                styles.chip,
                { backgroundColor: on ? colors.accentPurple : colors.surface },
              ]}
            >
              <AppText
                style={[
                  styles.chipText,
                  { color: on ? "#FFFFFF" : colors.textPrimary },
                ]}
              >
                {s.label}
              </AppText>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {!ready ? (
        <GuideSkeleton colors={colors} bottomInset={insets.bottom} />
      ) : (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: 32 + insets.bottom },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {section(
            "editor",
            "The editor screen",
            "Five areas, from top to bottom. The numbers match the picture.",
            <>
              <EditorMap colors={colors} />
              <Legend
                colors={colors}
                items={[
                  {
                    badge: "1",
                    icon: "arrow-back",
                    title: "Top bar",
                    text: "Back · ? (this guide) · quality (1080P) · Save · Export.",
                  },
                  {
                    badge: "2",
                    icon: "tv-outline",
                    title: "Preview",
                    text: "Your video as it will be exported. Texts, stickers and PIP are moved here.",
                  },
                  {
                    badge: "3",
                    icon: "play",
                    title: "Play row",
                    text: "Undo · Redo · Play / Pause · Capture (saves this frame as a photo) · Fullscreen.",
                  },
                  {
                    badge: "4",
                    icon: "apps-outline",
                    title: "Toolbar",
                    text: "Nothing selected: tools that ADD (music, text…). A clip selected: tools for THAT clip.",
                  },
                  {
                    badge: "5",
                    icon: "film-outline",
                    title: "Timeline",
                    text: "All your clips in rows. The white line is the playhead: what the preview shows now.",
                  },
                ]}
              />
              <Tip colors={colors} icon="save-outline">
                Your edit is saved by itself when you leave the editor or the
                app. The Save button saves right now.
              </Tip>
            </>,
          )}

          {section(
            "timeline",
            "The timeline",
            "Each row holds one kind of clip. Scroll it with your finger to move the playhead.",
            <>
              <TimelineDiagram colors={colors} />
              <Legend
                colors={colors}
                items={[
                  {
                    badge: "A",
                    icon: "add",
                    title: "+ (left)",
                    text: "Adds a video from your phone at the very start. Everything else moves right.",
                  },
                  {
                    badge: "B",
                    icon: "volume-high-outline",
                    title: "Mute",
                    text: "Silences all the sound clips (for the preview and the export).",
                  },
                  {
                    badge: "C",
                    icon: "checkbox-outline",
                    title: "Multi-select",
                    text: "Pick several clips to move, copy or delete them together.",
                  },
                  {
                    badge: "D",
                    icon: "add",
                    title: "+ (end)",
                    text: "Adds a video right after the last video clip. Nothing moves.",
                  },
                  {
                    badge: "E",
                    icon: "remove-outline",
                    title: "Playhead",
                    text: "The white line. Scroll the timeline to move it; Split cuts here.",
                  },
                ]}
              />
              <AppText
                style={[styles.subheading, { color: colors.textPrimary }]}
              >
                Gestures
              </AppText>
              <View style={styles.gestureGrid}>
                <Gesture
                  colors={colors}
                  icon="hand-left-outline"
                  title="Tap a clip"
                  text="Selects it (tap again to unselect)."
                />
                <Gesture
                  colors={colors}
                  icon="move-outline"
                  title="Hold & drag"
                  text="Moves the clip. Near the screen edge the timeline scrolls."
                />
                <Gesture
                  colors={colors}
                  icon="resize-outline"
                  title="Drag an edge"
                  text="On a selected clip: makes it shorter or longer (trim)."
                />
                <Gesture
                  colors={colors}
                  icon="expand-outline"
                  title="Pinch"
                  text="Zooms the timeline in and out (or use − / +)."
                />
              </View>
            </>,
          )}

          {section(
            "clip",
            "Clip tools",
            "Select a clip on the timeline — these tools appear in the toolbar.",
            CLIP_TOOLS.map((t) => (
              <ToolCard key={t.name} tool={t} colors={colors} />
            )),
          )}

          {section(
            "project",
            "Add & project tools",
            "With nothing selected, the toolbar shows these.",
            PROJECT_TOOLS.map((t) => (
              <ToolCard key={t.name} tool={t} colors={colors} />
            )),
          )}

          {section(
            "preview",
            "Texts, stickers & PIP on the preview",
            "Tap one on the preview to select it. A frame appears with two buttons.",
            <>
              <PreviewDiagram colors={colors} />
              <Legend
                colors={colors}
                items={[
                  {
                    badge: "1",
                    icon: "move-outline",
                    title: "Drag",
                    text: "Moves it. It always stays inside the video.",
                  },
                  {
                    badge: "2",
                    icon: "close",
                    title: "✕",
                    text: "Deletes it.",
                  },
                  {
                    badge: "3",
                    icon: "sync-outline",
                    title: "↻ (drag)",
                    text: "Turns and resizes it. It snaps straight near 0°, 90°, 180°.",
                  },
                  {
                    badge: "4",
                    icon: "create-outline",
                    title: "Tap again",
                    text: "Opens the text editor (texts) to change words and style.",
                  },
                ]}
              />
              <ToolCard
                colors={colors}
                tool={{
                  icon: "duplicate-outline",
                  name: "Duplicate (texts & stickers)",
                  what: "Makes a copy that starts right after the original.",
                  how: [
                    "Select the text or sticker on the timeline, tap Duplicate.",
                  ],
                }}
              />
              <ToolCard
                colors={colors}
                tool={{
                  icon: "swap-horizontal-outline",
                  name: "Replace (stickers)",
                  what: "Swaps the emoji, keeping its place, size and time.",
                  how: ["Select the sticker, tap Replace, pick another."],
                }}
              />
            </>,
          )}

          {section(
            "multi",
            "Multi-select",
            "Move, copy or delete several clips at once — they keep their spacing.",
            <>
              <Steps
                colors={colors}
                steps={[
                  "Tap ☑ under the mute button (it turns purple).",
                  "Tap the clips you want — each gets a ✓.",
                  "Hold one picked clip and drag: all of them move.",
                  "Or tap Duplicate / Delete in the bar.",
                  "Tap Done when you're finished.",
                ]}
              />
            </>,
          )}

          {section(
            "export",
            "Export",
            "Makes the final video file — everything you see in the preview.",
            <>
              <ToolCard
                colors={colors}
                tool={{
                  icon: "options-outline",
                  name: "Quality (1080P)",
                  what: "Size of the exported video (480P, 720P, 1080P) and smoothness (24, 30, 60 fps). 2K and 4K come with the full version.",
                  how: ["Tap 1080P at the top, pick, tap ✓."],
                }}
              />
              <ToolCard
                colors={colors}
                tool={{
                  icon: "share-outline",
                  name: "Export",
                  what: "Writes the video, saves it to your gallery and to the Exports tab.",
                  how: [
                    "Tap Export and keep the app open until 100%.",
                    "Then Share it, or tap Done.",
                  ],
                }}
              />
              <ToolCard
                colors={colors}
                tool={{
                  icon: "cloud-download-outline",
                  name: "Exports tab",
                  what: "All your exported videos: watch, share, save to the gallery again, or delete.",
                  how: [
                    "Open the Exports tab at the bottom of the home screen.",
                    "Tap a video to play it; ⋮ for more.",
                  ],
                }}
              />
            </>,
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ---- Pieces ----------------------------------------------------------------

function ToolCard({ tool, colors }: { tool: Tool; colors: Colors }) {
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface },
        tool.soon && styles.soonCard,
      ]}
    >
      <View style={styles.cardHead}>
        <View
          style={[
            styles.cardIcon,
            { backgroundColor: colors.accentPurple + "22" },
          ]}
        >
          <Ionicons
            name={tool.icon}
            size={20}
            color={colors.accentPurpleBright}
          />
        </View>
        <AppText style={[styles.cardName, { color: colors.textPrimary }]}>
          {tool.name}
        </AppText>
        {tool.soon && (
          <View
            style={[styles.soonBadge, { backgroundColor: colors.accentPurple }]}
          >
            <Ionicons name="lock-closed" size={10} color="#FFFFFF" />
            <AppText style={styles.soonText}>Soon</AppText>
          </View>
        )}
      </View>
      <AppText style={[styles.cardWhat, { color: colors.textMuted }]}>
        {tool.what}
      </AppText>
      {!tool.soon && <Steps colors={colors} steps={tool.how} />}
    </View>
  );
}

function Steps({ steps, colors }: { steps: string[]; colors: Colors }) {
  return (
    <View style={styles.steps}>
      {steps.map((s, i) => (
        <View key={i} style={styles.stepRow}>
          <View style={[styles.stepNum, { borderColor: colors.accentPurple }]}>
            <AppText
              style={[styles.stepNumText, { color: colors.accentPurpleBright }]}
            >
              {i + 1}
            </AppText>
          </View>
          <AppText style={[styles.stepText, { color: colors.textPrimary }]}>
            {s}
          </AppText>
        </View>
      ))}
    </View>
  );
}

function Tip({
  children,
  icon,
  colors,
}: {
  children: ReactNode;
  icon: IconName;
  colors: Colors;
}) {
  return (
    <View style={[styles.tip, { backgroundColor: colors.badgeBackground }]}>
      <Ionicons name={icon} size={18} color={colors.accentGreen} />
      <AppText style={[styles.tipText, { color: colors.textPrimary }]}>
        {children}
      </AppText>
    </View>
  );
}

function Badge({
  label,
  colors,
  style,
}: {
  label: string;
  colors: Colors;
  style?: object;
}) {
  return (
    <View
      style={[styles.badge, { backgroundColor: colors.accentPurple }, style]}
    >
      <AppText style={styles.badgeText}>{label}</AppText>
    </View>
  );
}

function Legend({
  items,
  colors,
}: {
  items: { badge: string; icon: IconName; title: string; text: string }[];
  colors: Colors;
}) {
  return (
    <View style={styles.legend}>
      {items.map((it) => (
        <View
          key={it.badge}
          style={[styles.legendRow, { backgroundColor: colors.surface }]}
        >
          <Badge label={it.badge} colors={colors} />
          <Ionicons name={it.icon} size={18} color={colors.textPrimary} />
          <View style={{ flex: 1 }}>
            <AppText
              style={[styles.legendTitle, { color: colors.textPrimary }]}
            >
              {it.title}
            </AppText>
            <AppText style={[styles.legendText, { color: colors.textMuted }]}>
              {it.text}
            </AppText>
          </View>
        </View>
      ))}
    </View>
  );
}

function Gesture({
  icon,
  title,
  text,
  colors,
}: {
  icon: IconName;
  title: string;
  text: string;
  colors: Colors;
}) {
  return (
    <View style={[styles.gesture, { backgroundColor: colors.surface }]}>
      <View
        style={[
          styles.gestureIcon,
          { backgroundColor: colors.accentPurple + "22" },
        ]}
      >
        <Ionicons name={icon} size={22} color={colors.accentPurpleBright} />
      </View>
      <AppText style={[styles.gestureTitle, { color: colors.textPrimary }]}>
        {title}
      </AppText>
      <AppText style={[styles.gestureText, { color: colors.textMuted }]}>
        {text}
      </AppText>
    </View>
  );
}

/** A small drawing of the editor screen, areas numbered 1–5. */
function EditorMap({ colors }: { colors: Colors }) {
  const block = (
    h: number,
    children: ReactNode,
    badge: string,
    extra?: object,
  ) => (
    <View
      style={[
        styles.mapBlock,
        { height: h, backgroundColor: colors.surface },
        extra,
      ]}
    >
      {children}
      <Badge label={badge} colors={colors} style={styles.mapBadge} />
    </View>
  );
  return (
    <View
      style={[
        styles.phone,
        {
          borderColor: colors.iconInactive,
          backgroundColor: colors.background,
        },
      ]}
    >
      {block(
        28,
        <View style={styles.mapRow}>
          <Ionicons name="arrow-back" size={12} color={colors.textMuted} />
          <Ionicons
            name="help-circle-outline"
            size={12}
            color={colors.textMuted}
          />
          <View style={{ flex: 1 }} />
          <View
            style={[
              styles.mapPill,
              { backgroundColor: colors.badgeBackground },
            ]}
          />
          <View
            style={[
              styles.mapPill,
              { backgroundColor: colors.accentPurple, width: 34 },
            ]}
          />
        </View>,
        "1",
      )}
      {block(
        110,
        <View style={styles.mapPreview}>
          <View
            style={[
              styles.mapVideo,
              { backgroundColor: colors.badgeBackground },
            ]}
          >
            <Ionicons name="image-outline" size={26} color={colors.textMuted} />
            <View style={[styles.mapTextChip, { borderColor: "#FFFFFF" }]}>
              <AppText style={styles.mapTextChipText}>Text</AppText>
            </View>
          </View>
        </View>,
        "2",
        { backgroundColor: "#000000" },
      )}
      {block(
        26,
        <View style={[styles.mapRow, { justifyContent: "center", gap: 16 }]}>
          <Ionicons
            name="arrow-undo-outline"
            size={12}
            color={colors.textMuted}
          />
          <Ionicons
            name="arrow-redo-outline"
            size={12}
            color={colors.textMuted}
          />
          <Ionicons name="play" size={14} color={colors.textPrimary} />
          <Ionicons name="camera-outline" size={12} color={colors.textMuted} />
          <Ionicons name="expand-outline" size={12} color={colors.textMuted} />
        </View>,
        "3",
      )}
      {block(
        34,
        <View style={[styles.mapRow, { gap: 8 }]}>
          {(
            [
              "musical-notes-outline",
              "tablet-portrait-outline",
              "crop-outline",
              "text-outline",
              "happy-outline",
            ] as IconName[]
          ).map((ic) => (
            <View
              key={ic}
              style={[
                styles.mapTool,
                { backgroundColor: colors.badgeBackground },
              ]}
            >
              <Ionicons name={ic} size={11} color={colors.textPrimary} />
            </View>
          ))}
        </View>,
        "4",
      )}
      {block(
        58,
        <View style={styles.mapTimeline}>
          <View
            style={[
              styles.mapClip,
              { backgroundColor: colors.badgeBackground, width: "70%" },
            ]}
          />
          <View
            style={[
              styles.mapClip,
              { backgroundColor: colors.accentPurple + "55", width: "60%" },
            ]}
          />
          <View style={[styles.mapPlayhead, { backgroundColor: "#FFFFFF" }]} />
        </View>,
        "5",
      )}
    </View>
  );
}

/** A small drawing of the timeline: side buttons, rows, playhead, end +. */
function TimelineDiagram({ colors }: { colors: Colors }) {
  const sideBtn = (icon: IconName, badge: string, purple?: boolean) => (
    <View style={styles.tlSideItem}>
      <View
        style={[
          styles.tlSideBtn,
          { backgroundColor: purple ? colors.accentPurple : colors.surface },
        ]}
      >
        <Ionicons
          name={icon}
          size={13}
          color={purple ? "#FFFFFF" : colors.textPrimary}
        />
      </View>
      <Badge label={badge} colors={colors} style={styles.tlSideBadge} />
    </View>
  );
  const row = (label: string, icon: IconName, children: ReactNode) => (
    <View style={styles.tlRow}>
      <View style={styles.tlRowLabel}>
        <Ionicons name={icon} size={11} color={colors.textMuted} />
        <AppText style={[styles.tlRowLabelText, { color: colors.textMuted }]}>
          {label}
        </AppText>
      </View>
      <View style={[styles.tlLane, { backgroundColor: colors.surface }]}>
        {children}
      </View>
    </View>
  );
  return (
    <View style={[styles.tlBox, { backgroundColor: colors.badgeBackground }]}>
      <View style={styles.tlSide}>
        {sideBtn("add", "A", true)}
        {sideBtn("volume-high-outline", "B")}
        {sideBtn("checkbox-outline", "C")}
      </View>
      <View style={{ flex: 1 }}>
        {row(
          "Video",
          "film-outline",
          <>
            <View
              style={[
                styles.tlClip,
                {
                  left: "0%",
                  width: "38%",
                  backgroundColor: colors.background,
                  borderColor: colors.iconInactive,
                },
              ]}
            />
            <View
              style={[
                styles.tlClip,
                {
                  left: "39%",
                  width: "30%",
                  backgroundColor: colors.background,
                  borderColor: colors.iconInactive,
                },
              ]}
            />
            <View
              style={[
                styles.tlEndAdd,
                { left: "71%", backgroundColor: colors.accentPurple },
              ]}
            >
              <Ionicons name="add" size={12} color="#FFFFFF" />
            </View>
            <Badge
              label="D"
              colors={colors}
              style={[styles.tlInlineBadge, { left: "84%" }]}
            />
          </>,
        )}
        {row(
          "Sound",
          "musical-notes-outline",
          <>
            <View
              style={[
                styles.tlClip,
                {
                  left: "0%",
                  width: "38%",
                  backgroundColor: colors.accentPurple + "55",
                  borderColor: colors.accentPurple,
                },
              ]}
            />
            <View
              style={[
                styles.tlClip,
                {
                  left: "42%",
                  width: "45%",
                  backgroundColor: colors.accentPurple + "33",
                  borderColor: colors.accentPurple,
                },
              ]}
            />
          </>,
        )}
        {row(
          "Text / stickers",
          "text-outline",
          <>
            <View
              style={[
                styles.tlClip,
                {
                  left: "10%",
                  width: "30%",
                  backgroundColor: TEXT_CLIP_COLOR,
                  borderColor: TEXT_CLIP_COLOR,
                },
              ]}
            />
            <View
              style={[
                styles.tlClip,
                {
                  left: "50%",
                  width: "18%",
                  backgroundColor: STICKER_CLIP_COLOR,
                  borderColor: STICKER_CLIP_COLOR,
                },
              ]}
            />
          </>,
        )}
        {row(
          "PIP",
          "copy-outline",
          <View
            style={[
              styles.tlClip,
              {
                left: "30%",
                width: "35%",
                backgroundColor: colors.background,
                borderColor: colors.accentGreen,
              },
            ]}
          />,
        )}
        <View
          pointerEvents="none"
          style={[styles.tlPlayhead, { left: "45%" }]}
        />
        <Badge
          label="E"
          colors={colors}
          style={[styles.tlInlineBadge, { left: "42%", top: -10 }]}
        />
      </View>
    </View>
  );
}

/** A small drawing of a selected text on the preview (frame, ✕, ↻). */
function PreviewDiagram({ colors }: { colors: Colors }) {
  return (
    <View style={styles.pvBox}>
      <View
        style={[styles.pvVideo, { backgroundColor: colors.badgeBackground }]}
      >
        <View style={styles.pvSelected}>
          <AppText style={styles.pvText}>Hello!</AppText>
          <View style={[styles.pvBtn, styles.pvDelete]}>
            <Ionicons name="close" size={11} color="#FFFFFF" />
          </View>
          <View style={[styles.pvBtn, styles.pvHandle]}>
            <Ionicons name="sync-outline" size={10} color="#FFFFFF" />
          </View>
          <Badge label="1" colors={colors} style={styles.pvBadge1} />
          <Badge label="2" colors={colors} style={styles.pvBadge2} />
          <Badge label="3" colors={colors} style={styles.pvBadge3} />
        </View>
        <View style={styles.pvSticker}>
          <AppText style={{ fontSize: 26 }}>😄</AppText>
        </View>
      </View>
    </View>
  );
}

/** Placeholder while the guide's drawings are built: soft pulsing blocks. */
function GuideSkeleton({
  colors,
  bottomInset,
}: {
  colors: ReturnType<typeof useTheme>;
  bottomInset: number;
}) {
  const pulse = useSharedValue(0.45);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 750 }), -1, true);
  }, [pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  const bar = (width: number | `${number}%`, height: number) => (
    <View
      style={[
        styles.skeletonBar,
        { width, height, backgroundColor: colors.surface },
      ]}
    />
  );
  return (
    <Animated.View
      style={[
        styles.skeletonWrap,
        { paddingBottom: 32 + bottomInset },
        pulseStyle,
      ]}
    >
      {bar("45%", 22)}
      {bar("85%", 12)}
      <View
        style={[
          styles.skeletonCard,
          { backgroundColor: colors.surface, height: 210 },
        ]}
      />
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={[
            styles.skeletonCard,
            { borderWidth: 1, borderColor: colors.surface },
          ]}
        >
          <View style={styles.skeletonRow}>
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                backgroundColor: colors.surface,
              }}
            />
            {bar("50%", 14)}
          </View>
          {bar("92%", 10)}
          {bar("70%", 10)}
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 22, fontFamily: "Poppins-Bold" },
  subtitle: { fontSize: 13 },
  // Fixed heights: the chip row was measured a little short on Android
  // (Poppins' tall line box), cutting the chips' bottoms.
  chipsBar: { flexGrow: 0, flexShrink: 0, height: 54 },
  chips: { paddingHorizontal: 16, gap: 8, alignItems: "center" },
  chip: {
    height: 36,
    paddingHorizontal: 15,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: { fontSize: 13, lineHeight: 18, fontFamily: "Poppins-Medium" },
  skeletonWrap: { paddingHorizontal: 16, paddingTop: 8, gap: 12 },
  skeletonBar: { borderRadius: 8 },
  skeletonCard: { borderRadius: 16, padding: 14, gap: 10 },
  skeletonRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  content: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  section: { gap: 10, marginBottom: 22 },
  sectionTitle: { fontSize: 19, fontFamily: "Poppins-Bold" },
  sectionIntro: { fontSize: 13, lineHeight: 19, marginTop: -4 },
  subheading: { fontSize: 15, fontFamily: "Poppins-Medium", marginTop: 6 },
  card: { borderRadius: 16, padding: 14, gap: 8 },
  soonCard: { opacity: 0.75 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  cardName: { flex: 1, fontSize: 15, fontFamily: "Poppins-Medium" },
  cardWhat: { fontSize: 13, lineHeight: 19 },
  soonBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  soonText: { color: "#FFFFFF", fontSize: 11, fontFamily: "Poppins-Medium" },
  steps: { gap: 6 },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  stepNum: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  stepNumText: { fontSize: 11, fontFamily: "Poppins-Medium" },
  stepText: { flex: 1, fontSize: 13, lineHeight: 19 },
  tip: {
    flexDirection: "row",
    gap: 10,
    borderRadius: 14,
    padding: 12,
    alignItems: "center",
  },
  tipText: { flex: 1, fontSize: 13, lineHeight: 19 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#FFFFFF", fontSize: 11, fontFamily: "Poppins-Bold" },
  legend: { gap: 8 },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 14,
    padding: 12,
  },
  legendTitle: { fontSize: 14, fontFamily: "Poppins-Medium" },
  legendText: { fontSize: 12, lineHeight: 17 },
  gestureGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  gesture: { width: "48.5%", borderRadius: 14, padding: 12, gap: 6 },
  gestureIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  gestureTitle: { fontSize: 14, fontFamily: "Poppins-Medium" },
  gestureText: { fontSize: 12, lineHeight: 17 },
  // Editor map
  phone: {
    alignSelf: "center",
    width: 220,
    borderRadius: 22,
    borderWidth: 2,
    padding: 8,
    gap: 6,
  },
  mapBlock: { borderRadius: 8, justifyContent: "center", paddingHorizontal: 8 },
  mapBadge: { position: "absolute", right: -12, top: "50%", marginTop: -10 },
  mapRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  mapPill: { width: 26, height: 12, borderRadius: 6 },
  mapPreview: { flex: 1, alignItems: "center", justifyContent: "center" },
  mapVideo: {
    width: 60,
    height: 96,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  mapTextChip: {
    position: "absolute",
    bottom: 14,
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 4,
  },
  mapTextChipText: {
    color: "#FFFFFF",
    fontSize: 8,
    fontFamily: "Poppins-Bold",
  },
  mapTool: {
    width: 20,
    height: 20,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  mapTimeline: { gap: 6, paddingVertical: 6 },
  mapClip: { height: 14, borderRadius: 4 },
  mapPlayhead: {
    position: "absolute",
    left: "45%",
    top: 2,
    bottom: 2,
    width: 2,
    borderRadius: 1,
  },
  // Timeline diagram
  tlBox: { flexDirection: "row", borderRadius: 16, padding: 10, gap: 8 },
  tlSide: { justifyContent: "flex-start", gap: 10, paddingTop: 14 },
  tlSideItem: { alignItems: "center" },
  tlSideBtn: {
    width: 26,
    height: 26,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  tlSideBadge: {
    position: "absolute",
    left: -8,
    top: -8,
    transform: [{ scale: 0.8 }],
  },
  tlRow: { marginBottom: 6 },
  tlRowLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 2,
  },
  tlRowLabelText: { fontSize: 10 },
  tlLane: { height: 26, borderRadius: 6 },
  tlClip: {
    position: "absolute",
    top: 3,
    bottom: 3,
    borderRadius: 5,
    borderWidth: 1,
  },
  tlEndAdd: {
    position: "absolute",
    top: 4,
    width: 18,
    height: 18,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  tlInlineBadge: { position: "absolute", top: 3, transform: [{ scale: 0.8 }] },
  tlPlayhead: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: "#FFFFFF",
    borderRadius: 1,
  },
  // Preview diagram
  pvBox: { alignItems: "center" },
  pvVideo: {
    width: 200,
    height: 260,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  pvSelected: {
    borderWidth: 1,
    borderColor: "#FFFFFF",
    paddingHorizontal: 14,
    paddingVertical: 6,
    transform: [{ rotate: "-8deg" }],
  },
  pvText: { color: "#FFFFFF", fontSize: 22, fontFamily: "Poppins-Bold" },
  pvBtn: {
    position: "absolute",
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(20,20,20,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  pvDelete: { left: -10, top: -10 },
  pvHandle: { right: -10, bottom: -10 },
  pvBadge1: { position: "absolute", left: "45%", top: -28 },
  pvBadge2: { position: "absolute", left: -34, top: -14 },
  pvBadge3: { position: "absolute", right: -36, bottom: -14 },
  pvSticker: { position: "absolute", left: 24, bottom: 26 },
});
