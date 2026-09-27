// Text fonts (step 5a.1).
//
// Built-in phone fonts plus 12 Google fonts that ship with the app: the
// font files come from the @expo-google-fonts npm packages (JS packages, no
// native rebuild) and are all loaded when the editor opens, so they're
// ready offline — nothing to download. Loading uses expo-font, whose native
// part is already in the app (the icons use it).

import * as Font from "expo-font";
import { useEffect, useState } from "react";

export type FontStyle = {
  fontFamily?: string;
  fontWeight?: "400" | "700";
};

export type FontDef =
  | { id: string; label: string; kind: "system"; style: FontStyle }
  | {
      id: string;
      label: string;
      kind: "google";
      family: string;
      asset: number;
    };

const google = (
  id: string,
  label: string,
  family: string,
  asset: number,
): FontDef => ({
  id,
  label,
  kind: "google",
  family: `VS-${family}`,
  asset,
});

/* eslint-disable @typescript-eslint/no-require-imports */
export const FONTS: FontDef[] = [
  {
    id: "normal",
    label: "System",
    kind: "system",
    style: { fontWeight: "400" },
  },
  {
    id: "bold",
    label: "System Bold",
    kind: "system",
    style: { fontWeight: "700" },
  },
  {
    id: "serif",
    label: "Serif",
    kind: "system",
    style: { fontFamily: "serif", fontWeight: "400" },
  },
  {
    id: "mono",
    label: "Mono",
    kind: "system",
    style: { fontFamily: "monospace", fontWeight: "400" },
  },
  google(
    "montserrat",
    "Montserrat",
    "Montserrat_700Bold",
    require("@expo-google-fonts/montserrat/700Bold/Montserrat_700Bold.ttf"),
  ),
  google(
    "oswald",
    "Oswald",
    "Oswald_600SemiBold",
    require("@expo-google-fonts/oswald/600SemiBold/Oswald_600SemiBold.ttf"),
  ),
  google(
    "bangers",
    "Bangers",
    "Bangers_400Regular",
    require("@expo-google-fonts/bangers/400Regular/Bangers_400Regular.ttf"),
  ),
  google(
    "playfair",
    "Playfair",
    "PlayfairDisplay_700Bold",
    require("@expo-google-fonts/playfair-display/700Bold/PlayfairDisplay_700Bold.ttf"),
  ),
  google(
    "pacifico",
    "Pacifico",
    "Pacifico_400Regular",
    require("@expo-google-fonts/pacifico/400Regular/Pacifico_400Regular.ttf"),
  ),
  google(
    "anton",
    "Anton",
    "Anton_400Regular",
    require("@expo-google-fonts/anton/400Regular/Anton_400Regular.ttf"),
  ),
  google(
    "lobster",
    "Lobster",
    "Lobster_400Regular",
    require("@expo-google-fonts/lobster/400Regular/Lobster_400Regular.ttf"),
  ),
  google(
    "dancing",
    "Dancing",
    "DancingScript_700Bold",
    require("@expo-google-fonts/dancing-script/700Bold/DancingScript_700Bold.ttf"),
  ),
  google(
    "bebas",
    "Bebas Neue",
    "BebasNeue_400Regular",
    require("@expo-google-fonts/bebas-neue/400Regular/BebasNeue_400Regular.ttf"),
  ),
  google(
    "poppins",
    "Poppins",
    "Poppins_700Bold",
    require("@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf"),
  ),
  google(
    "caveat",
    "Caveat",
    "Caveat_700Bold",
    require("@expo-google-fonts/caveat/700Bold/Caveat_700Bold.ttf"),
  ),
  google(
    "righteous",
    "Righteous",
    "Righteous_400Regular",
    require("@expo-google-fonts/righteous/400Regular/Righteous_400Regular.ttf"),
  ),
];
/* eslint-enable @typescript-eslint/no-require-imports */

export type FontStatus = "loaded" | "idle" | "loading" | "error";

const statusById: Record<string, FontStatus> = {};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function fontDef(id: string): FontDef {
  return FONTS.find((f) => f.id === id) ?? FONTS[1];
}

export function fontStatus(id: string): FontStatus {
  const def = fontDef(id);
  if (def.kind === "system") return "loaded";
  if (statusById[id] === "loaded") return "loaded";
  try {
    if (Font.isLoaded(def.family)) return "loaded";
  } catch {
    // expo-font not available: treated as not loaded
  }
  return statusById[id] ?? "idle";
}

/** Downloads a Google font (once). Resolves true when it's usable. */
export async function loadFont(id: string): Promise<boolean> {
  const def = fontDef(id);
  if (def.kind === "system") return true;
  const status = fontStatus(id);
  if (status === "loaded") return true;
  if (status === "loading") return false;
  statusById[id] = "loading";
  notify();
  const startedAt = Date.now();
  try {
    await Font.loadAsync({ [def.family]: def.asset });
    statusById[id] = "loaded";
    if (__DEV__)
      console.log(`[fonts] ${def.label} loaded in ${Date.now() - startedAt}ms`);
    notify();
    return true;
  } catch (error) {
    statusById[id] = "error";
    if (__DEV__) console.log(`[fonts] ${def.label} failed to load`, error);
    notify();
    return false;
  }
}

/** Loads every bundled font (call once when the editor opens). */
export function preloadAllFonts(): void {
  for (const f of FONTS) {
    if (f.kind === "google") void loadFont(f.id);
  }
}

/** Style for a font id (system bold until a Google font has loaded). */
export function fontStyleFor(id: string): FontStyle {
  const def = fontDef(id);
  if (def.kind === "system") return def.style;
  return fontStatus(id) === "loaded"
    ? { fontFamily: def.family }
    : { fontWeight: "700" };
}

/** Re-renders the caller whenever a font finishes (or fails) loading. */
export function useFontsVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return version;
}
