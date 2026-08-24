export async function runScriptedPlay(assembly) {
  const trace = [];
  await assembly.startNew();
  trace.push(step("founder-landed", assembly));
  await assembly.tick(24, 24_000);
  trace.push(step("founder-mature", assembly));

  const founder = assembly.inspect({ type: "state" }).livingTrees.find(({ founder: value }) => value);
  if (!founder) throw new Error("Scripted play could not find the living founder.");
  const hit = {
    entityId: founder.id,
    entityType: "tree",
    speciesId: "acer-saccharum",
    managed: true,
    living: true,
    locationRef: { cellId: founder.cellId },
    localSun: 0.72,
    localWater: 0.64,
  };
  await assembly.dispatch({ type: "pointer/down", pointerId: 1, pointerCount: 1, device: "mouse", at: 25_000, position: { x: 50, y: 50 }, hit });
  await assembly.dispatch({ type: "pointer/up", pointerId: 1, device: "mouse", at: 25_020, position: { x: 50, y: 50 } });
  trace.push(step("nurture", assembly));

  await assembly.dispatch({ type: "mode/set", mode: "seeding" });
  const standPosition = { contract: "STAND-POSITION@1", frameId: "stand-local-unitless", unit: "micrometre", x: 0, y: 0 };
  const direction = { contract: "STAND-DIRECTION@1", frameId: "stand-local-unitless", unit: "unit-vector", x: 1, y: 0 };
  await assembly.dispatch({ type: "pointer/down", pointerId: 2, pointerCount: 1, device: "mouse", at: 26_000, sourceTreeId: founder.id, domainPosition: standPosition, domainDirection: direction });
  await assembly.dispatch({ type: "input/service", at: 26_260 });
  await assembly.dispatch({ type: "input/service", at: 26_520 });
  await assembly.dispatch({ type: "pointer/up", pointerId: 2, device: "mouse", at: 26_600 });
  trace.push(step("held-seeding-three-pulses", assembly));

  await assembly.tick(8, 34_000);
  trace.push(step("growth-recruitment-ticks", assembly));
  return trace;
}

function step(id, assembly) {
  const state = assembly.inspect({ type: "state" });
  return {
    id,
    forestStep: state.clock.step,
    rp: state.rp.balance,
    livingTrees: state.livingTrees.length,
    recruits: state.recruits.length,
    propagules: state.propagules.length,
    snags: state.snags.length,
    deadwood: state.deadwood.length,
    checksum: assembly.checksum(),
  };
}
