import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import * as VideoThumbnails from "expo-video-thumbnails";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import ComingSoonModal from "../components/ComingSoonModal";
import EditorScreenSkeleton from "../components/EditorScreenSkeleton";
import EditorTimeline from "../components/editor/EditorTimeline";
import EditorToolbar, {
  type LockMode,
  type SelectionKind,
} from "../components/editor/EditorToolbar";
import EditorTopBar from "../components/editor/EditorTopBar";
import {
  canSplitAt,
  clipEnd,
  describeClip,
  EMPTY_PROJECT,
  findClip,
  findLinkedPartner,
  projectEnd,
  type Clip,
  type ClipRange,
  type Project,
} from "../editor/clipModel";
import { probeDuration } from "../editor/mediaProbe";
import {
  addAudioClipAction,
  initSourceAction,
  projectReducer,
  splitClipAction,
  type ProjectAction,
} from "../editor/projectReducer";
import { useTheme } from "../hooks/useTheme";
import { useTimelineClock, type ClockTrack } from "../hooks/useTimelineClock";
import { useTrackTimelineSync } from "../hooks/useTrackTimelineSync";

const THUMBNAIL_COUNT = 20;
const THUMBNAIL_CONCURRENCY = 3;

function clampJS(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function summarizeProject(project: Project): string {
  const lines = (["video", "audio"] as const).map((track) => {
    const clips = project.tracks[track];
    return `  ${track}: ${clips.length === 0 ? "(empty)" : clips.map(describeClip).join(" | ")}`;
  });
  return `end ${projectEnd(project).toFixed(2)}s\n${lines.join("\n")}`;
}

export default function EditorScreen() {
  const colors = useTheme();
  const { videoUri } = useLocalSearchParams<{ videoUri: string }>();
  const [comingSoonVisible, setComingSoonVisible] = useState(false);
  // The phone's file picker is open / the picked file is being read.
  const addingAudioRef = useRef(false);
  // A picked song is being read (spinner on "Add audio" + the Music tool).
  const [addingAudio, setAddingAudio] = useState(false);
  // "It worked" flash on the clips an edit just made or changed.
  const [flash, setFlash] = useState<{ ids: string[]; token: number }>({
    ids: [],
    token: 0,
  });
  const flashClips = (ids: string[]) =>
    setFlash((f) => ({ ids, token: f.token + 1 }));
  const [isPlaying, setIsPlaying] = useState(false);
  // True while the user is dragging/flinging the timeline. The audio
  // player's seeks are held back during this (see useTrackTimelineSync's
  // `holdSeeks`) and done once, exactly, on release.
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
  const [thumbnailsReady, setThumbnailsReady] = useState(false);
  const thumbnailsGeneratedRef = useRef(false);

  // The whole edit: a list of clips per track (see src/editor/clipModel.ts).
  // Every change goes through projectReducer as one action.
  const [project, dispatchProject] = useReducer(projectReducer, EMPTY_PROJECT);
  // The selected clip's id (null = nothing selected).
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  // Lock is NOT editor state: it lives in the clips (a shared linkId =
  // locked). See `lockMode` below.

  // Runs an action: computes the result first (the reducer is pure, so this
  // is the same result dispatch will produce), logs it, dispatches it, and
  // returns the new project so callers can react to it in the same tick.
  const commitProject = (action: ProjectAction, reason: string): Project => {
    const next = projectReducer(project, action);
    if (__DEV__) {
      console.log(
        next === project
          ? `[project] ${action.type} (${reason}) — no change`
          : `[project] ${action.type} (${reason})`,
      );
    }
    if (next !== project) dispatchProject(action);
    return next;
  };

  // Full model dump whenever it changes.
  useEffect(() => {
    if (__DEV__) console.log(`[project] now: ${summarizeProject(project)}`);
  }, [project]);

  // ---- Players -------------------------------------------------------
  // Two players per track that take turns: consecutive clips on a track
  // alternate between player A and player B. While one plays the current
  // clip, the other is already parked on the next clip's first frame and
  // started early, so a cut (a split point, reordered parts) needs no seek
  // — we just switch which player you see / hear. With one player per
  // track, every cut to a different part of the source was a 0.2–0.5s seek
  // (a hitch, then drift corrections).
  //
  // Video players: their own embedded audio is muted permanently — sound
  // only ever comes from the audio players, which is what lets the audio
  // track sit at different timeline positions than the video.
  const videoPlayerA = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
    p.muted = true;
  });
  const videoPlayerB = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
    p.muted = true;
  });
  // Audio-only instances of the same file (no <VideoView> attached —
  // expo-video can decode/play just the audio).
  const audioPlayerA = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
  });
  const audioPlayerB = useVideoPlayer(videoUri ?? "", (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.2;
    p.muted = true;
  });
  const player = videoPlayerA;
  const audioPlayers = [audioPlayerA, audioPlayerB] as const;

  // Which video player is on screen (0 = A, 1 = B). Switched on the UI
  // thread at the exact cut (by the clock), so no React re-render sits
  // between the cut and the new picture.
  const visibleVideoSV = useSharedValue(0);
  const videoAStyle = useAnimatedStyle(() => ({
    opacity: visibleVideoSV.value === 0 ? 1 : 0,
  }));
  const videoBStyle = useAnimatedStyle(() => ({
    opacity: visibleVideoSV.value === 1 ? 1 : 0,
  }));

  // Note: there used to be two `useEvent(player, "timeUpdate")`
  // subscriptions here. Their values were never read (the timeline clock
  // reads `player.currentTime` directly every frame), but each event still
  // re-rendered this whole screen ~5x/s per player — 10 wasted full
  // re-renders per second during playback. Removed for smoother playback.

  useEffect(() => {
    const id = setInterval(() => {
      if (player.duration > 0) {
        setDuration(player.duration);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [player]);

  // First load: one linked video + audio clip covering the whole file.
  // (The reducer ignores this if the project already has clips.)
  useEffect(() => {
    if (duration > 0 && videoUri) {
      commitProject(initSourceAction(videoUri, duration), "source loaded");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, videoUri]);

  useEffect(() => {
    if (!videoUri || duration <= 0 || thumbnailsGeneratedRef.current) return;
    thumbnailsGeneratedRef.current = true;

    const generate = async () => {
      const results: (string | null)[] = new Array(THUMBNAIL_COUNT).fill(null);
      let nextIndex = 0;

      const worker = async () => {
        while (true) {
          const i = nextIndex++;
          if (i >= THUMBNAIL_COUNT) return;
          const segmentMidpoint = ((i + 0.5) * duration) / THUMBNAIL_COUNT;
          try {
            const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
              time: Math.floor(segmentMidpoint * 1000),
            });
            results[i] = uri;
          } catch {
            results[i] = null;
          }
        }
      };

      const workers = Array.from({ length: THUMBNAIL_CONCURRENCY }, () =>
        worker(),
      );
      await Promise.all(workers);

      setThumbnails(results);
      setThumbnailsReady(true);
    };

    generate();
  }, [videoUri, duration]);

  // ---- Clips on each track -------------------------------------------
  const videoClips = project.tracks.video;
  const audioClips = project.tracks.audio;

  // The timeline ends where the last clip ends (after trimming everything
  // shorter, playback stops there instead of running on through black to
  // the original video's length).
  const timelineDuration = projectEnd(project);

  const selectedClip = selectedClipId
    ? findClip(project, selectedClipId)
    : null;
  const selectedPartner = selectedClip
    ? findLinkedPartner(project, selectedClip)
    : null;

  // Lock button (clip tools only): usable when the selected clip is locked
  // to a partner (tap = unlock, one-way); greyed out if already unlocked.
  const lockMode: LockMode = !selectedClip
    ? "none"
    : selectedPartner
      ? "locked"
      : "unlocked";

  // Which clip tools the toolbar shows: a locked pair gets all of them
  // (each applies to the part it belongs to), an unlocked clip only its
  // own kind's (video: picture tools, no Volume; audio: Volume, no
  // picture tools).
  const selectionKind: SelectionKind = !selectedClip
    ? "none"
    : selectedPartner
      ? "locked"
      : selectedClip.track === "audio"
        ? "audio"
        : "video";

  // ---- Clips per player -------------------------------------------------
  // Consecutive clips on a track alternate between the track's two players
  // (clip 0 → A, clip 1 → B, clip 2 → A...). Tracks are kept sorted by
  // start, so the next clip is always on the other, free player.
  const videoClipsBySlot = useMemo(
    () => [
      videoClips.filter((_, i) => i % 2 === 0),
      videoClips.filter((_, i) => i % 2 === 1),
    ],
    [videoClips],
  );
  const audioClipsBySlot = useMemo(
    () => [
      audioClips.filter((_, i) => i % 2 === 0),
      audioClips.filter((_, i) => i % 2 === 1),
    ],
    [audioClips],
  );

  // Make a video player the one on screen.
  const showVideoSlot = (slot: number, why: string) => {
    if (visibleVideoSV.get() === slot) return;
    visibleVideoSV.set(slot);
    if (__DEV__)
      console.log(
        `[editor] showing video player ${slot === 0 ? "A" : "B"} (${why})`,
      );
  };
  // Make an audio player the one you hear (the other is muted).
  const hearAudioSlot = (slot: number, why: string) => {
    if (!audioPlayers[slot].muted && audioPlayers[1 - slot].muted) return;
    audioPlayers[slot].muted = false;
    audioPlayers[1 - slot].muted = true;
    if (__DEV__)
      console.log(
        `[editor] hearing audio player ${slot === 0 ? "A" : "B"} (${why})`,
      );
  };

  // ---- Shared clock + per-player sync -----------------------------------
  // One clock entry per clip, reading the player that clip plays on.
  const clockEntries = (
    clips: Clip[],
    p: typeof player,
    slot: number,
    priority: number,
  ): ClockTrack[] =>
    clips.map((clip) => ({
      label: clip.id,
      trackKey: `${clip.track}#${slot}`,
      clipStart: clip.start,
      clipEnd: clipEnd(clip),
      trimStart: clip.trimIn,
      speed: clip.speed,
      priority,
      getCurrentTime: () => p.currentTime,
      // Used when a player is stuck (ground truth, ~1.2s) or has drifted
      // away from the playhead (the other tracks).
      resyncTo: (sourceTime) => {
        if (__DEV__)
          console.log(
            `[editor] clock pulled ${clip.track} player ${slot === 0 ? "A" : "B"} (${clip.id}) to ${sourceTime.toFixed(2)}s`,
          );
        p.currentTime = sourceTime;
      },
      pause: () => p.pause(),
      play: () => p.play(),
      setRate: (rate) => {
        p.playbackRate = rate;
      },
      activate: () =>
        clip.track === "audio"
          ? hearAudioSlot(slot, `${clip.id} begins`)
          : showVideoSlot(slot, `${clip.id} begins`),
      silence:
        clip.track === "audio"
          ? () => {
              p.muted = true;
            }
          : undefined,
    }));
  // Video first (priority 0): the picture is what the playhead follows.
  const clockTracks: ClockTrack[] = [
    ...clockEntries(videoClipsBySlot[0], videoPlayerA, 0, 0),
    ...clockEntries(videoClipsBySlot[1], videoPlayerB, 1, 0),
    ...clockEntries(audioClipsBySlot[0], audioPlayerA, 0, 1),
    ...clockEntries(audioClipsBySlot[1], audioPlayerB, 1, 1),
  ];

  const { timelineTime, seekVersion, seekTo, playhead, halt } =
    useTimelineClock({
      isPlaying,
      timelineDuration,
      tracks: clockTracks,
      onReachEnd: () => {
        if (__DEV__)
          console.log("[editor] timeline reached end, stopping playback");
        setIsPlaying(false);
      },
    });

  // One sync per player, each with its own clips. Entering a clip (paused,
  // scrubbing or playing) makes that player the one you see / hear.
  useTrackTimelineSync({
    label: "video A",
    player: videoPlayerA,
    isPlaying,
    timelineTime,
    seekVersion,
    clips: videoClipsBySlot[0],
    initialUri: videoUri ?? "",
    onEnterClip: () => showVideoSlot(0, "playhead entered its clip"),
  });
  useTrackTimelineSync({
    label: "video B",
    player: videoPlayerB,
    isPlaying,
    timelineTime,
    seekVersion,
    clips: videoClipsBySlot[1],
    initialUri: videoUri ?? "",
    onEnterClip: () => showVideoSlot(1, "playhead entered its clip"),
  });
  useTrackTimelineSync({
    label: "audio A",
    player: audioPlayerA,
    isPlaying,
    timelineTime,
    seekVersion,
    clips: audioClipsBySlot[0],
    initialUri: videoUri ?? "",
    holdSeeks: isScrubbing,
    onEnterClip: () => hearAudioSlot(0, "playhead entered its clip"),
  });
  useTrackTimelineSync({
    label: "audio B",
    player: audioPlayerB,
    isPlaying,
    timelineTime,
    seekVersion,
    clips: audioClipsBySlot[1],
    initialUri: videoUri ?? "",
    holdSeeks: isScrubbing,
    onEnterClip: () => hearAudioSlot(1, "playhead entered its clip"),
  });

  // Black preview when no video clip is under the playhead. Clip ends count
  // as covered (inclusive), so pausing exactly on the last frame of the
  // timeline still shows it instead of going black.
  const isVoidNow = !videoClips.some(
    (clip) =>
      timelineTime >= clip.start - 0.001 &&
      timelineTime <= clipEnd(clip) + 0.001,
  );

  // Split is usable when the playhead is inside the selected clip (and its
  // locked partner), at least MIN_SPLIT_PART from either edge.
  const splitEnabled =
    selectedClip !== null &&
    canSplitAt(selectedClip, timelineTime) &&
    (selectedPartner === null || canSplitAt(selectedPartner, timelineTime));

  // Delete is usable on any selected clip, unless it (with its locked
  // partner) is everything left in the project: an empty project has no way
  // to add media back yet (that comes with an "add clip" tool).
  const clipCount = project.tracks.video.length + project.tracks.audio.length;
  const deleteEnabled =
    selectedClip !== null && clipCount - (selectedPartner ? 2 : 1) > 0;

  // ---- Transport handlers (thin — the hooks above react to the state
  // changes these make, so there's no manual player.play()/currentTime
  // wiring here anymore) --------------------------------------------------
  const togglePlayback = () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }

    if (timelineTime >= timelineDuration - 0.001) {
      seekTo(0);
    }

    // Safety net: if a scrub-end was somehow missed, never keep the audio
    // seek on hold once playback starts.
    if (isScrubbing) {
      if (__DEV__)
        console.log("[editor] play pressed while scrub flag set — clearing it");
      setIsScrubbing(false);
    }

    // Play = watching, not editing: drop the clip selection (the toolbar
    // goes back to the project tools, trim handles disappear).
    if (selectedClip) {
      if (__DEV__)
        console.log(
          `[editor] play pressed — deselecting ${selectedClip.track} (${selectedClip.id})`,
        );
      setSelectedClipId(null);
    }

    setIsPlaying(true);
  };

  const handleScrub = (time: number) => {
    const clamped = clampJS(time, 0, timelineDuration);
    seekTo(clamped);
  };

  // Any editing action (scrubbing, moving a clip, dragging a trim handle,
  // tapping zoom +/-, pinch-zooming, tapping a clip, toggling the audio
  // lock) pauses playback first, InShot-style. Playback stays paused
  // afterwards — the user presses play to continue. Without this, the play
  // clock and the gesture both tried to own the playhead/players at the
  // same time.
  const pauseForGesture = (reason: string) => {
    if (isPlaying) {
      if (__DEV__)
        console.log(`[editor] ${reason} started while playing — pausing`);
      // Freeze the playhead immediately (see the clock's `halt`), then let
      // React catch up with the paused state.
      halt();
      setIsPlaying(false);
    }
  };

  const handleScrubStart = () => {
    pauseForGesture("scrub");
    if (__DEV__) console.log("[editor] scrub start — holding audio seeks");
    setIsScrubbing(true);
  };

  const handleScrubEnd = () => {
    if (__DEV__) console.log("[editor] scrub end — releasing audio seek");
    setIsScrubbing(false);
  };

  const handleClipGestureStart = (kind: "move" | "trim") =>
    pauseForGesture(`clip ${kind}`);

  const handleZoomButtonPress = (direction: "in" | "out") =>
    pauseForGesture(`zoom ${direction}`);

  const handlePinchZoomStart = () => pauseForGesture("pinch zoom");

  // Tapping a clip: selects it, or deselects if it's already selected.
  // A locked pair acts as one, so tapping EITHER clip of a selected pair
  // deselects both. Otherwise tapping another clip switches the selection
  // to it. Either way, a tap on a clip means "I'm editing now", so playback
  // pauses first.
  const handleSelectClip = (clipId: string) => {
    const target = findClip(project, clipId);
    pauseForGesture(`${target?.track ?? "clip"} clip tap`);
    if (!target) return;
    const alreadySelected =
      selectedClipId === target.id || selectedPartner?.id === target.id;
    if (alreadySelected) {
      if (__DEV__)
        console.log(`[editor] ${target.track} tapped again — deselecting`);
      setSelectedClipId(null);
      return;
    }
    if (__DEV__) console.log(`[editor] select ${target.track} (${target.id})`);
    setSelectedClipId(target.id);
  };

  // Tap on empty space (empty timeline area, video preview, background).
  // Buttons (toolbar, play, zoom...) are touchables of their own, so they
  // take the tap first and never reach this — the selection survives them,
  // which tools like Split/Delete will need.
  const clearSelection = (reason: string) => {
    if (selectedClip === null) return;
    if (__DEV__)
      console.log(
        `[editor] ${reason} tapped — deselecting ${selectedClip.track} (${selectedClip.id})`,
      );
    setSelectedClipId(null);
  };

  // Unlock the selected clip from its partner — one-way, there is no
  // re-lock. The toolbar only enables the button when this can apply, but
  // it's checked again here. Also an editing action, so it pauses first.
  // The selected clip stays selected; its partner just stops being
  // highlighted with it.
  const handleUnlock = () => {
    if (!selectedClip || !selectedPartner) {
      if (__DEV__)
        console.log("[editor] lock button pressed — nothing to unlock");
      return;
    }
    pauseForGesture("unlock");
    if (__DEV__)
      console.log(
        `[editor] unlock ${selectedClip.id} from ${selectedPartner.id}`,
      );
    commitProject(
      { type: "UNLINK_CLIP", clipId: selectedClip.id },
      `unlock ${selectedClip.track}`,
    );
    // Both clips flash: they're now separate.
    flashClips([selectedClip.id, selectedPartner.id]);
  };

  // Split the selected clip at the playhead. Locked: its partner is cut at
  // the same moment (the reducer does both). Unlocked: only this clip. The
  // left half keeps the original id, so it stays selected.
  const handleSplit = () => {
    if (!selectedClip) return;
    // While playing, cut where the playhead is DRAWN (the throttled React
    // time can be ~0.2s behind), then pause there.
    const at = isPlaying ? playhead.uiTimeSV.get() : timelineTime;
    if (isPlaying) {
      pauseForGesture("split");
      seekTo(at);
    }
    if (!canSplitAt(selectedClip, at)) {
      if (__DEV__)
        console.log(
          `[editor] split @ ${at.toFixed(2)}s — playhead not inside ${selectedClip.id} (or too close to an edge)`,
        );
      return;
    }
    if (__DEV__)
      console.log(
        `[editor] split ${selectedClip.id}${selectedPartner ? ` + locked ${selectedPartner.id}` : " (unlocked, alone)"} @ ${at.toFixed(2)}s`,
      );
    const action = splitClipAction(selectedClip.id, at);
    const next = commitProject(
      action,
      `split ${selectedClip.track}${selectedPartner ? ", locked" : ""}`,
    );
    if (next !== project && action.type === "SPLIT_CLIP") {
      flashClips(
        selectedPartner
          ? [
              selectedClip.id,
              action.rightId,
              selectedPartner.id,
              action.partnerRightId,
            ]
          : [selectedClip.id, action.rightId],
      );
    }
  };

  // Delete the selected clip — and its locked partner (the reducer does
  // both). The gap stays; nothing else moves. Pauses first, like every
  // edit. Nothing is selected afterwards (project tools come back). The
  // playhead stays, unless the timeline got shorter than where it sits.
  const handleDelete = () => {
    if (!selectedClip || !deleteEnabled) return;
    pauseForGesture("delete");
    if (__DEV__)
      console.log(
        `[editor] delete ${selectedClip.id}${selectedPartner ? ` + locked ${selectedPartner.id}` : " (unlocked, alone)"}`,
      );
    const nextProject = commitProject(
      { type: "DELETE_CLIP", clipId: selectedClip.id },
      `delete ${selectedClip.track}${selectedPartner ? ", locked" : ""}`,
    );
    setSelectedClipId(null);
    const at = isPlaying ? playhead.uiTimeSV.get() : timelineTime;
    const end = projectEnd(nextProject);
    if (at > end) {
      if (__DEV__)
        console.log(
          `[editor] delete — timeline now ${end.toFixed(2)}s, playhead ${at.toFixed(2)}s was past the end → moved to end`,
        );
      seekTo(end);
    } else {
      if (isPlaying) seekTo(at);
      if (__DEV__)
        console.log(`[editor] delete — playhead stays @ ${at.toFixed(2)}s`);
    }
  };

  // Add music from the phone (the empty audio row's "Add audio", or the
  // Music tool): opens the phone's file picker for audio files, reads the
  // file's length, and adds it as a new unlinked audio clip at the playhead
  // — full length, even past the end of the video. If the playhead is inside
  // another audio clip, it goes to that clip's nearer edge and later clips
  // move right (clips never overlap on a track).
  const handleAddAudio = async (from: string) => {
    if (addingAudioRef.current) return;
    addingAudioRef.current = true;
    pauseForGesture("add audio");
    const at = isPlaying ? playhead.uiTimeSV.get() : timelineTime;
    if (isPlaying) seekTo(at);
    if (__DEV__)
      console.log(
        `[editor] add audio (${from}) @ ${at.toFixed(2)}s — opening the file picker`,
      );
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "audio/*",
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = result.canceled ? null : result.assets?.[0];
      if (!asset) {
        if (__DEV__) console.log("[editor] add audio — picker cancelled");
        return;
      }
      if (__DEV__)
        console.log(
          `[editor] add audio — picked ${asset.name} (${asset.mimeType ?? "unknown type"})`,
        );
      setAddingAudio(true);
      const duration = await probeDuration(asset.uri);
      if (duration <= 0) {
        Alert.alert(
          "Couldn't add audio",
          "This file couldn't be read. Try another audio file.",
        );
        return;
      }
      const title = asset.name.replace(/\.[^.]+$/, "") || "Music";
      const addAction = addAudioClipAction(asset.uri, duration, title, at);
      const next = commitProject(addAction, "add audio");
      if (addAction.type === "ADD_CLIP") flashClips([addAction.clip.id]);
      if (__DEV__) {
        const added = next.tracks.audio.find(
          (c) => c.sourceUri === asset.uri && !findClip(project, c.id),
        );
        console.log(
          `[editor] add audio — "${title}" (${duration.toFixed(2)}s) wanted @ ${at.toFixed(2)}s, placed @ ${added?.start.toFixed(2) ?? "?"}s`,
        );
      }
    } catch (error) {
      if (__DEV__) console.log("[editor] add audio failed", error);
      Alert.alert(
        "Couldn't add audio",
        "Something went wrong opening the file.",
      );
    } finally {
      addingAudioRef.current = false;
      setAddingAudio(false);
    }
  };

  // Tools that aren't built yet.
  const handleComingSoonTool = (key: string) => {
    if (key === "music") {
      void handleAddAudio("Music tool");
      return;
    }
    if (__DEV__)
      console.log(
        `[editor] ${key} on ${selectionKind === "none" ? "project" : `${selectionKind} selection`} — coming soon`,
      );
    setComingSoonVisible(true);
  };

  // Capture (camera next to play): will save the frame under the playhead.
  const handleCapture = () => {
    if (__DEV__)
      console.log(
        `[editor] capture pressed @ ${timelineTime.toFixed(2)}s — coming soon`,
      );
    setComingSoonVisible(true);
  };

  // A trim or move committed on the timeline (finger lifted).
  // Returns whether the project changed.
  const handleClipChange = (clipId: string, range: ClipRange): boolean => {
    const clip = findClip(project, clipId);
    if (!clip) return false;
    const trimChanged =
      range.trimIn !== clip.trimIn || range.trimOut !== clip.trimOut;
    const kind = `${clip.track} ${trimChanged ? "trim" : "move"}`;
    const locked = findLinkedPartner(project, clip) !== null;

    // A move: dropped at `range.start`; the reducer inserts it (nearer edge
    // of the clip it landed on, later clips pushed right — never overlaps).
    // A trim: the new range as-is; the timeline already stopped the handles
    // at the neighbours. Locked: the partner gets the same either way.
    const action: ProjectAction = trimChanged
      ? { type: "UPDATE_CLIP_RANGE", clipId, range }
      : { type: "MOVE_CLIP", clipId, start: range.start };
    const nextProject = commitProject(
      action,
      `${kind}${locked ? ", locked" : ""}`,
    );
    if (__DEV__ && !trimChanged) {
      const landed = findClip(nextProject, clipId);
      const partnerId = findLinkedPartner(project, clip)?.id ?? null;
      const pushed = (["video", "audio"] as const).flatMap((track) =>
        nextProject.tracks[track].filter((c) => {
          const before = findClip(project, c.id);
          return (
            before !== null &&
            c.id !== clipId &&
            c.id !== partnerId &&
            before.start !== c.start
          );
        }),
      );
      console.log(
        `[editor] ${kind} — dropped at ${range.start.toFixed(2)}s, landed at ${landed?.start.toFixed(2)}s${pushed.length > 0 ? `, pushed: ${pushed.map((c) => `${c.id} → ${c.start.toFixed(2)}s`).join(", ")}` : ""}`,
      );
    }

    // The playhead STAYS where it is after a trim or move. If the edit
    // leaves it over empty space, the preview just shows the gap, like any
    // other gap. The only time it has to move: the timeline got shorter
    // than where the playhead sits.
    const nextTimelineDuration = projectEnd(nextProject);
    if (timelineTime > nextTimelineDuration) {
      if (__DEV__)
        console.log(
          `[editor] ${kind} — timeline now ${nextTimelineDuration.toFixed(2)}s, playhead ${timelineTime.toFixed(2)}s was past the end → moved to end`,
        );
      seekTo(nextTimelineDuration);
    } else if (__DEV__) {
      console.log(
        `[editor] ${kind} — playhead stays @ ${timelineTime.toFixed(2)}s`,
      );
    }
    return nextProject !== project;
  };

  const clipLabel = videoUri
    ? (videoUri.split("/").pop() ?? "Video clip")
    : "Video clip";
  const isReady = duration > 0 && thumbnailsReady;

  if (!isReady) {
    return <EditorScreenSkeleton />;
  }

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
        <Pressable onPress={() => clearSelection("background")}>
          <View style={styles.previewArea}>
            <View
              style={[styles.previewBox, { backgroundColor: colors.surface }]}
            >
              {/* Two stacked video views, one per video player; only the
                  active one is visible. TextureView (not the default
                  SurfaceView) so they can be layered and faded on Android. */}
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, videoAStyle]}
              >
                <VideoView
                  player={videoPlayerA}
                  style={styles.video}
                  contentFit="contain"
                  nativeControls={false}
                  surfaceType="textureView"
                />
              </Animated.View>
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, videoBStyle]}
              >
                <VideoView
                  player={videoPlayerB}
                  style={styles.video}
                  contentFit="contain"
                  nativeControls={false}
                  surfaceType="textureView"
                />
              </Animated.View>
              {isVoidNow && (
                <View pointerEvents="none" style={styles.voidOverlay} />
              )}
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

            <TouchableOpacity
              onPress={togglePlayback}
              style={styles.playButton}
            >
              <Ionicons
                name={isPlaying ? "pause" : "play"}
                size={22}
                color={colors.textPrimary}
              />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleCapture}
              accessibilityRole="button"
              accessibilityLabel="Capture frame"
            >
              <Ionicons
                name="camera-outline"
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
        </Pressable>

        {/* The toolbar sits OUTSIDE the tap-to-deselect areas: inside one,
            the wrapper competed with the toolbar's own horizontal scroll
            for the same touch, so scrolling sometimes didn't start or felt
            sticky. Taps on the toolbar never deselect anyway. */}
        <EditorToolbar
          selectionKind={selectionKind}
          lockMode={lockMode}
          splitEnabled={splitEnabled}
          deleteEnabled={deleteEnabled}
          onUnlock={handleUnlock}
          onSplit={handleSplit}
          onDelete={handleDelete}
          busyToolKey={addingAudio ? "music" : null}
          onEditStart={(key) => {
            // Freeze playback at the tap; the edit lands there after the
            // button's short spinner.
            if (isPlaying) {
              const at = playhead.uiTimeSV.get();
              pauseForGesture(key);
              seekTo(at);
            }
          }}
          onToolPress={handleComingSoonTool}
        />

        <Pressable onPress={() => clearSelection("background")}>
          <View style={styles.timelineWrap}>
            <EditorTimeline
              clipLabel={clipLabel}
              currentTime={timelineTime}
              isPlaying={isPlaying}
              playhead={playhead}
              timelineDuration={timelineDuration}
              thumbnails={thumbnails}
              videoClips={videoClips}
              audioClips={audioClips}
              selectedClipId={selectedClip?.id ?? null}
              onMutePress={() => setComingSoonVisible(true)}
              onSelectClip={handleSelectClip}
              onAddTextPress={() => setComingSoonVisible(true)}
              onAddAudioPress={() => void handleAddAudio("empty audio row")}
              addingAudio={addingAudio}
              flash={flash}
              originalUri={videoUri ?? ""}
              onScrub={handleScrub}
              onScrubStart={handleScrubStart}
              onScrubEnd={handleScrubEnd}
              onClipGestureStart={handleClipGestureStart}
              onZoomButtonPress={handleZoomButtonPress}
              onPinchZoomStart={handlePinchZoomStart}
              onEmptyAreaPress={() => clearSelection("empty timeline area")}
              onClipChange={handleClipChange}
            />
          </View>
        </Pressable>
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
  voidOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000000",
  },
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
