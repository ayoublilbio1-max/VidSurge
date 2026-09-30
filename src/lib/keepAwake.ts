// Keeps the screen on during long jobs (the export) — expo-keep-awake.
//
// Loaded defensively: without the native module in the
// build, these do nothing.

type KeepAwakeModule = typeof import("expo-keep-awake");

let mod: KeepAwakeModule | null = null;
try {
  mod = require("expo-keep-awake") as unknown as KeepAwakeModule;
} catch {
  mod = null;
}

/** Screen stays on until `allowSleep(tag)`. `tag` names who asked. */
export function keepScreenOn(tag: string) {
  if (!mod) return;
  try {
    mod.activateKeepAwakeAsync(tag).catch(() => undefined);
  } catch {
    return;
  }
  if (__DEV__) console.log(`[keepAwake] screen kept on (${tag})`);
}

export function allowSleep(tag: string) {
  if (!mod) return;
  try {
    mod.deactivateKeepAwake(tag).catch(() => undefined);
  } catch {
    return;
  }
  if (__DEV__) console.log(`[keepAwake] screen may sleep (${tag})`);
}
