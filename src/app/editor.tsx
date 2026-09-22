import { Ionicons } from "@expo/vector-icons";
import { useEvent } from "expo";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import ComingSoonModal from "../components/ComingSoonModal";
import EditorTimeline from "../components/editor/EditorTimeline";
import EditorToolbar from "../components/editor/EditorToolbar";
import EditorTopBar from "../components/editor/EditorTopBar";
import { useTheme } from "../hooks/useTheme";

export default function EditorScreen() {
  const colors = useTheme();
  const { videoUri } = useLocalSearchParams<{ videoUri: string }>();
  const [comingSoonVisible, setComingSoonVisible] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);

  const player = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
  });

  const { currentTime } = useEvent(player, "timeUpdate", {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });

  useEffect(() => {
    const id = setInterval(() => {
      if (player.duration > 0) {
        setDuration(player.duration);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [player]);

  const togglePlayback = () => {
    if (isPlaying) {
      player.pause();
    } else {
      player.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleScrub = (time: number) => {
    player.currentTime = time;
  };

  const clipLabel = videoUri
    ? (videoUri.split("/").pop() ?? "Video clip")
    : "Video clip";

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <EditorTopBar
        resolution="1080P"
        onBack={() => router.back()}
        onHelp={() => setComingSoonVisible(true)}
        onResolutionPress={() => setComingSoonVisible(true)}
        onExportPress={() => setComingSoonVisible(true)}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.previewArea}>
          <View
            style={[styles.previewBox, { backgroundColor: colors.surface }]}
          >
            <VideoView
              player={player}
              style={styles.video}
              contentFit="contain"
              nativeControls={false}
            />
          </View>
        </View>

        <View style={styles.transportRow}>
          <TouchableOpacity onPress={() => setComingSoonVisible(true)}>
            <Ionicons
              name="arrow-undo-outline"
              size={20}
              color={colors.iconInactive}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setComingSoonVisible(true)}>
            <Ionicons
              name="arrow-redo-outline"
              size={20}
              color={colors.iconInactive}
            />
          </TouchableOpacity>

          <TouchableOpacity onPress={togglePlayback} style={styles.playButton}>
            <Ionicons
              name={isPlaying ? "pause" : "play"}
              size={22}
              color={colors.textPrimary}
            />
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setComingSoonVisible(true)}>
            <Ionicons
              name="options-outline"
              size={20}
              color={colors.iconInactive}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setComingSoonVisible(true)}>
            <Ionicons
              name="expand-outline"
              size={20}
              color={colors.iconInactive}
            />
          </TouchableOpacity>
        </View>

        <EditorToolbar onToolPress={() => setComingSoonVisible(true)} />

        <View style={styles.timelineWrap}>
          <EditorTimeline
            clipLabel={clipLabel}
            currentTime={currentTime}
            duration={duration}
            isPlaying={isPlaying}
            player={player}
            onMutePress={() => setComingSoonVisible(true)}
            onAddAudioPress={() => setComingSoonVisible(true)}
            onAddTextPress={() => setComingSoonVisible(true)}
            onScrub={handleScrub}
          />
        </View>
      </ScrollView>

      <ComingSoonModal
        visible={comingSoonVisible}
        onClose={() => setComingSoonVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  previewArea: {
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  previewBox: {
    width: "75%",
    aspectRatio: 9 / 16,
    borderRadius: 16,
    overflow: "hidden",
  },
  video: { width: "100%", height: "100%" },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
    paddingVertical: 5,
  },
  playButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  timelineWrap: { paddingVertical: 12, paddingBottom: 24 },
});
