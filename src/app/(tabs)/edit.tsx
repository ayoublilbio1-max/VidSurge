import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Image,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import AppText from "../../components/AppText";
import ComingSoonModal from "../../components/ComingSoonModal";
import EditScreenSkeleton from "../../components/EditScreenSkeleton";
import GradientActionCard from "../../components/GradientActionCard";
import ProjectOptionsModal from "../../components/ProjectOptionsModal";
import ProjectSortModal from "../../components/ProjectSortModal";
import { useTheme } from "../../hooks/useTheme";
import {
  loadHomePrefs,
  PROJECT_SORTS,
  saveHomePrefs,
  type ProjectSort,
} from "../../lib/homePrefs";
import {
  deleteProject,
  loadProjects,
  renameProject,
  subscribeProjects,
  type ProjectItem,
} from "../../lib/projectsStorage";

/** 75.3 → "1:15" */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// The search field shows from this many projects on.
const SEARCH_FROM = 4;

function sortProjects(list: ProjectItem[], sort: ProjectSort): ProjectItem[] {
  const out = [...list];
  switch (sort) {
    case "edited":
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    case "newest":
      return out.sort((a, b) => b.createdAt - a.createdAt);
    case "oldest":
      return out.sort((a, b) => a.createdAt - b.createdAt);
    case "longest":
      return out.sort((a, b) => b.duration - a.duration);
    case "shortest":
      return out.sort((a, b) => a.duration - b.duration);
    case "name":
      return out.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
          numeric: true,
        }),
      );
  }
}

/** "Edited just now" / "5 min ago" / "3h ago" / "2 days ago" / a date. */
function formatEdited(time: number): string {
  const diff = Math.max(0, Date.now() - time) / 1000;
  if (diff < 60) return "Edited just now";
  if (diff < 3600) return `Edited ${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `Edited ${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  if (days < 7) return `Edited ${days} day${days > 1 ? "s" : ""} ago`;
  return `Edited ${new Date(time).toLocaleDateString()}`;
}

export default function EditScreen() {
  const colors = useTheme();
  const [comingSoonVisible, setComingSoonVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  // The project whose Rename / Delete menu is open.
  const [optionsFor, setOptionsFor] = useState<ProjectItem | null>(null);
  // Sorting (remembered) and search.
  const [sort, setSort] = useState<ProjectSort>("edited");
  const [sortOpen, setSortOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    loadHomePrefs().then((p) => setSort(p.projectSort));
  }, []);

  const pickSort = (next: ProjectSort) => {
    if (__DEV__) console.log(`[edit] sort projects → ${next}`);
    setSort(next);
    setSortOpen(false);
    saveHomePrefs({ projectSort: next });
  };

  const shownProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? projects.filter((p) => p.name.toLowerCase().includes(q))
      : projects;
    return sortProjects(filtered, sort);
  }, [projects, sort, query]);

  // Reload quietly (no skeleton) — only the first load shows it.
  const fetchProjects = useCallback(async () => {
    const result = await loadProjects();
    setProjects(result);
    setLoading(false);
  }, []);

  // Every time this screen comes back into view (e.g. back from the
  // editor)...
  useFocusEffect(
    useCallback(() => {
      fetchProjects();
    }, [fetchProjects]),
  );
  // ...and when a save finishes (leaving the editor saves in the
  // background; copying a big video can finish after this screen is back).
  useEffect(() => subscribeProjects(() => fetchProjects()), [fetchProjects]);

  const handleNewVideo = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      allowsEditing: false,
      quality: 1,
    });

    if (!result.canceled && result.assets?.[0]?.uri) {
      router.push({
        pathname: "/editor",
        params: { videoUri: result.assets[0].uri },
      });
    }
  };

  const openProject = (project: ProjectItem) => {
    if (__DEV__)
      console.log(`[edit] open project "${project.name}" (${project.id})`);
    router.push({
      pathname: "/editor",
      params: { videoUri: project.videoUri, projectId: project.id },
    });
  };

  const handleConvertToMp3 = () => {
    if (__DEV__) console.log("[edit] convert video to MP3 pressed");
    // TODO: pick a video, extract audio, save as MP3 (needs native module).
    setComingSoonVisible(true);
  };

  if (loading) {
    return <EditScreenSkeleton />;
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          style={[styles.badge, { backgroundColor: colors.badgeBackground }]}
          onPress={() => router.push("/upgrade")}
        >
          <Ionicons
            name="diamond-outline"
            size={14}
            color={colors.accentGreen}
          />
          <AppText style={[styles.badgeText, { color: colors.textPrimary }]}>
            Standard
          </AppText>
        </TouchableOpacity>

        <View style={styles.cardsRow}>
          <GradientActionCard
            icon="add"
            label="New video"
            onPress={handleNewVideo}
          />
          <GradientActionCard
            icon="image-outline"
            label="Edit photo"
            onPress={() => setComingSoonVisible(true)}
          />
          <GradientActionCard
            icon="grid-outline"
            label="Collage"
            onPress={() => setComingSoonVisible(true)}
          />
        </View>

        <TouchableOpacity
          activeOpacity={0.8}
          style={[styles.toolButton, { backgroundColor: colors.surface }]}
          onPress={handleConvertToMp3}
        >
          <View
            style={[
              styles.toolIconWrap,
              { backgroundColor: colors.accentPurple + "22" },
            ]}
          >
            <Ionicons
              name="musical-notes-outline"
              size={20}
              color={colors.accentPurpleBright}
            />
          </View>
          <AppText style={[styles.toolLabel, { color: colors.textPrimary }]}>
            Convert video to MP3
          </AppText>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        <View style={styles.projectsHeader}>
          <AppText style={[styles.projectsTitle, { color: colors.textMuted }]}>
            Recent Projects
          </AppText>
          <TouchableOpacity
            onPress={() => setSortOpen(true)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={styles.sortButton}
            accessibilityLabel="Sort projects"
          >
            {sort !== "edited" && (
              <AppText
                style={[styles.sortLabel, { color: colors.accentPurpleBright }]}
              >
                {PROJECT_SORTS.find((s) => s.key === sort)?.label}
              </AppText>
            )}
            <Ionicons
              name="filter-outline"
              size={20}
              color={
                sort !== "edited" ? colors.accentPurpleBright : colors.textMuted
              }
            />
          </TouchableOpacity>
        </View>

        {projects.length >= SEARCH_FROM && (
          <View style={[styles.searchBox, { backgroundColor: colors.surface }]}>
            <Ionicons name="search" size={17} color={colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search projects"
              placeholderTextColor={colors.textMuted}
              style={[styles.searchInput, { color: colors.textPrimary }]}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <TouchableOpacity
                onPress={() => setQuery("")}
                hitSlop={10}
                accessibilityLabel="Clear search"
              >
                <Ionicons
                  name="close-circle"
                  size={18}
                  color={colors.textMuted}
                />
              </TouchableOpacity>
            )}
          </View>
        )}

        {projects.length > 0 && shownProjects.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="search" size={34} color={colors.iconInactive} />
            <AppText style={[styles.emptyText, { color: colors.textMuted }]}>
              No project named "{query.trim()}"
            </AppText>
          </View>
        ) : projects.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons
              name="film-outline"
              size={40}
              color={colors.iconInactive}
            />
            <AppText style={[styles.emptyText, { color: colors.textMuted }]}>
              Your projects will appear here.{"\n"}Start creating now.
            </AppText>
          </View>
        ) : (
          <View style={styles.projectsList}>
            {shownProjects.map((project) => (
              <TouchableOpacity
                key={project.id}
                activeOpacity={0.8}
                onPress={() => openProject(project)}
                onLongPress={() => setOptionsFor(project)}
                style={[styles.projectRow, { backgroundColor: colors.surface }]}
              >
                <View
                  style={[
                    styles.thumbWrap,
                    { backgroundColor: colors.badgeBackground },
                  ]}
                >
                  {project.thumbnailUri ? (
                    <Image
                      source={{ uri: project.thumbnailUri }}
                      style={styles.thumb}
                    />
                  ) : (
                    <Ionicons
                      name="film-outline"
                      size={22}
                      color={colors.iconInactive}
                    />
                  )}
                  <View style={styles.durationBadge}>
                    <AppText style={styles.durationText}>
                      {formatDuration(project.duration)}
                    </AppText>
                  </View>
                </View>
                <View style={styles.projectInfo}>
                  <AppText
                    numberOfLines={1}
                    style={[styles.projectName, { color: colors.textPrimary }]}
                  >
                    {project.name}
                  </AppText>
                  <AppText
                    style={[styles.projectMeta, { color: colors.textMuted }]}
                  >
                    {formatEdited(project.updatedAt)}
                  </AppText>
                </View>
                <TouchableOpacity
                  onPress={() => setOptionsFor(project)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityLabel="Project options"
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

      <ProjectOptionsModal
        project={optionsFor}
        onClose={() => setOptionsFor(null)}
        onRename={async (id, name) => {
          setOptionsFor(null);
          await renameProject(id, name);
        }}
        onDelete={async (id) => {
          setOptionsFor(null);
          await deleteProject(id);
        }}
      />

      <ProjectSortModal
        visible={sortOpen}
        value={sort}
        onPick={pickSort}
        onClose={() => setSortOpen(false)}
      />

      <ComingSoonModal
        visible={comingSoonVisible}
        onClose={() => setComingSoonVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 56, paddingBottom: 32 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    marginBottom: 16,
  },
  badgeText: { fontSize: 13, fontFamily: "Poppins-Medium" },
  cardsRow: { flexDirection: "row", gap: 10, marginBottom: 12 },
  toolButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 32,
  },
  toolIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  toolLabel: { flex: 1, fontSize: 14, fontFamily: "Poppins-Medium" },
  projectsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  projectsTitle: { fontSize: 20, fontFamily: "Poppins-Bold" },
  sortButton: { flexDirection: "row", alignItems: "center", gap: 6 },
  sortLabel: { fontSize: 12, fontFamily: "Poppins-Medium" },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 42,
    marginBottom: 14,
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  emptyState: { alignItems: "center", paddingTop: 40, gap: 16 },
  emptyText: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  projectsList: { gap: 12 },
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderRadius: 16,
    padding: 10,
    paddingRight: 14,
  },
  thumbWrap: {
    width: 64,
    height: 64,
    borderRadius: 12,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  thumb: { width: "100%", height: "100%" },
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
  projectInfo: { flex: 1, gap: 3 },
  projectName: { fontSize: 15, fontFamily: "Poppins-Medium" },
  projectMeta: { fontSize: 12 },
});
