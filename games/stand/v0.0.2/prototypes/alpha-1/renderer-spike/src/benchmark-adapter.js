import { CAMERA_CYCLE, DENSITY_BANDS, ONEIDA_FIXTURE, cameraAtCycleSample, createDensitySnapshot } from "./fixture.js";
import { createAmbientVisualLayer } from "./ambient-visual-layer.js";
import { createRenderer } from "./renderer.js";

export const PERF_RENDER_CONTRACT = Object.freeze({
  id: "PERF-RENDER@1",
  fixtureId: ONEIDA_FIXTURE.id,
  densityBands: Object.freeze(Object.keys(DENSITY_BANDS)),
  cameraCycleId: CAMERA_CYCLE.id,
  metrics: Object.freeze(["p50_frame_ms", "p95_frame_ms", "p99_frame_ms", "long_tasks", "draw_calls", "visible_counts", "lod_transitions", "memory_if_available"]),
  invariant: "Each camera cycle reuses one immutable ecological snapshot; only presentation camera and time change.",
});

export function createBenchmarkRunner({ canvas, assets = {}, densityBand = "stand-cohorts", seed = 0x51a7d, now } = {}) {
  const snapshot = createDensitySnapshot(densityBand, seed);
  const ambientVisualLayer = createAmbientVisualLayer({
    extent: ONEIDA_FIXTURE.extent,
    artBindings: assets.ambientArt?.manifest?.bindings || [],
    loadedFamilyIds: assets.ambientArt?.loadedFamilyIds || [],
  });
  const renderer = createRenderer(canvas, ONEIDA_FIXTURE, { assets, now, ambientVisualLayer });
  const samples = [];
  let priorBand = null;
  let lodTransitions = 0;

  function step(sampleIndex) {
    const camera = cameraAtCycleSample(sampleIndex);
    const frame = renderer.render(snapshot, camera, sampleIndex * (CAMERA_CYCLE.durationMs / (CAMERA_CYCLE.sampleCount - 1)));
    if (priorBand && frame.band !== priorBand) lodTransitions += 1;
    priorBand = frame.band;
    samples.push(frame.durationMs);
    return { camera, frame };
  }
  function report() {
    const sorted = [...samples].sort((a, b) => a - b);
    return Object.freeze({
      schema: "stand-perf-render-report@1", contract: PERF_RENDER_CONTRACT.id, densityBand,
      snapshotRevision: snapshot.revision, snapshotCounts: snapshot.benchmark.counts,
      frameCount: samples.length, p50FrameMs: percentile(sorted, 0.5), p95FrameMs: percentile(sorted, 0.95), p99FrameMs: percentile(sorted, 0.99),
      lodTransitions, lastFrame: renderer.getLastFrame(), ecologicalStateChanged: false,
      ambientVisualReplay: {
        seed: ambientVisualLayer.seed,
        digest: ambientVisualLayer.replayDigest,
        targetFamilyCount: ambientVisualLayer.targetFamilyCount,
        acceptedArtAssetCoverage: ambientVisualLayer.acceptedArtAssetCoverage,
        loadedRuntimeAssetCoverage: ambientVisualLayer.loadedRuntimeAssetCoverage,
        assetBindingStatus: ambientVisualLayer.assetBindingStatus,
      },
    });
  }
  return Object.freeze({ snapshot, renderer, step, report, destroy: renderer.destroy });
}

function percentile(values, quantile) { if (!values.length) return 0; return values[Math.min(values.length - 1, Math.floor((values.length - 1) * quantile))]; }
