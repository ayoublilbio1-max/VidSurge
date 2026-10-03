// Engine test (developer tool): finds WHICH part of an export makes the
// engine fail, without a new app build.
//
// It exports the same project several times, each time with only one
// feature added to a plain video — texts/stickers, canvas colour, opacity,
// PIP — then everything together, and reports which ones fail. The test
// videos are deleted right away.
//
// Started by a long press on the editor's Export button (dev builds only).

import { File, Paths } from "expo-file-system";
import { exportVideo, type ExportPlan } from "../../modules/vidsurge-engine";

export type EngineTestResult = {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
};

/** The project's plan without texts, PIP, opacity or canvas colour. */
function plainOf(full: ExportPlan): ExportPlan {
  return {
    ...full,
    overlays: [],
    pip: [],
    background: "#000000",
    video: full.video.map((v) =>
      v.type === "clip" ? { ...v, opacity: 1 } : v,
    ),
  };
}

/** Each test: a name and the plan it exports (null = not in this project). */
function testsFor(
  full: ExportPlan,
): { name: string; plan: ExportPlan | null }[] {
  const plain = plainOf(full);
  const firstClip = plain.video.findIndex((v) => v.type === "clip");
  return [
    { name: "1 plain video", plan: plain },
    {
      name: "2 + texts/stickers only",
      plan:
        full.overlays.length > 0 ? { ...plain, overlays: full.overlays } : null,
    },
    {
      name: "3 + canvas colour only",
      plan: { ...plain, background: "#FF0000" },
    },
    {
      name: "4 + opacity only",
      plan:
        firstClip >= 0
          ? {
              ...plain,
              video: plain.video.map((v, i) =>
                i === firstClip && v.type === "clip"
                  ? { ...v, opacity: 0.5 }
                  : v,
              ),
            }
          : null,
    },
    {
      name: "5 + PIP only",
      plan: full.pip.length > 0 ? { ...plain, pip: full.pip } : null,
    },
    {
      name: "6 + PIP photo only",
      plan: full.pip.some((p) => p.kind === "image")
        ? { ...plain, pip: full.pip.filter((p) => p.kind === "image") }
        : null,
    },
    { name: "7 everything", plan: full },
  ];
}

export async function runEngineDiagnostics(
  full: ExportPlan,
  onStep?: (name: string, index: number, total: number) => void,
): Promise<EngineTestResult[]> {
  const tests = testsFor(full).filter((t) => t.plan !== null);
  const results: EngineTestResult[] = [];
  console.log(
    `[engine-test] ${tests.length} test export(s) of this project (${full.width}x${full.height} @${full.fps}fps, ${full.duration.toFixed(2)}s)`,
  );
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    onStep?.(t.name, i, tests.length);
    const out = new File(Paths.cache, `vidsurge-test-${Date.now()}-${i}.mp4`);
    const plan: ExportPlan = { ...(t.plan as ExportPlan), outputPath: out.uri };
    const startedAt = Date.now();
    try {
      const r = await exportVideo(plan);
      const ms = Date.now() - startedAt;
      results.push({ name: t.name, ok: true, ms });
      console.log(
        `[engine-test] ✓ ${t.name} — ${(ms / 1000).toFixed(1)}s, ${(r.sizeBytes / 1e6).toFixed(1)} MB, ${(r.durationMs / 1000).toFixed(2)}s long`,
      );
    } catch (e) {
      const ms = Date.now() - startedAt;
      const error = e instanceof Error ? e.message : String(e);
      results.push({ name: t.name, ok: false, ms, error });
      console.log(
        `[engine-test] ✗ ${t.name} — FAILED after ${(ms / 1000).toFixed(1)}s: ${error}`,
      );
    } finally {
      try {
        if (out.exists) out.delete();
      } catch {
        // a test file left in the cache goes away with the cache
      }
    }
  }
  console.log(
    `[engine-test] done — ${results.filter((r) => r.ok).length}/${results.length} passed: ${results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}`).join(" | ")}`,
  );
  return results;
}
