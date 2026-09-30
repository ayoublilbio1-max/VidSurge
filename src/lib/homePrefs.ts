// Small home-screen preferences (how Recent Projects are sorted), kept in
// the app's storage so the choice survives closing the app.

import type { Ionicons } from "@expo/vector-icons";
import { File, Paths } from "expo-file-system";
import type { ComponentProps } from "react";

/** A valid Ionicons icon name. */
type IconName = ComponentProps<typeof Ionicons>["name"];

export type ProjectSort =
  | "edited" // last edited first (default)
  | "newest" // created, newest first
  | "oldest" // created, oldest first
  | "longest"
  | "shortest"
  | "name"; // A → Z

export const PROJECT_SORTS: {
  key: ProjectSort;
  label: string;
  icon: IconName;
}[] = [
  { key: "edited", label: "Last edited", icon: "time-outline" },
  { key: "newest", label: "Newest first", icon: "arrow-down-outline" },
  { key: "oldest", label: "Oldest first", icon: "arrow-up-outline" },
  { key: "longest", label: "Longest first", icon: "hourglass-outline" },
  { key: "shortest", label: "Shortest first", icon: "stopwatch-outline" },
  { key: "name", label: "Name (A–Z)", icon: "text-outline" },
];

type HomePrefs = { projectSort: ProjectSort };

const DEFAULTS: HomePrefs = { projectSort: "edited" };

function prefsFile() {
  return new File(Paths.document, "home-prefs.json");
}

export async function loadHomePrefs(): Promise<HomePrefs> {
  try {
    const file = prefsFile();
    if (!file.exists) return DEFAULTS;
    const data = JSON.parse(await file.text()) as Partial<HomePrefs>;
    const sort = PROJECT_SORTS.some((s) => s.key === data.projectSort)
      ? (data.projectSort as ProjectSort)
      : DEFAULTS.projectSort;
    return { projectSort: sort };
  } catch {
    return DEFAULTS;
  }
}

export function saveHomePrefs(prefs: HomePrefs): void {
  try {
    const file = prefsFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify(prefs));
  } catch (e) {
    if (__DEV__) console.log("[homePrefs] save failed", e);
  }
}
