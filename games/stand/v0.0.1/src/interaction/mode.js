/**
 * The alpha treats dispersal as an explicitly armed action. Keeping this gate
 * pure makes the Observe/Nurture versus Seeding boundary independently
 * testable even though pointer interpretation belongs to the browser app.
 */
export function canDisperse({ phase, seedingMode } = {}) {
  return phase === "play" && seedingMode === true;
}
