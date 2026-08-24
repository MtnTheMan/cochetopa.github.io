import { SITE_INTERPOLATION_CONTRACT, createReferenceWorld } from "../src/sim/index.mjs";

export const REAL_VIEW_SCHEMA = "STAND-ONEIDA-VERTICAL-RUNTIME-VIEW@2";
export const TEST_VIEW_SCHEMA = "STAND-ONEIDA-SUGAR-MAPLE-RUNTIME-DIAGNOSTIC@1";

const EXPECTED_MANIFEST_SHA256 = "23a6c914a5fcff6b7eb831dafbfc37d78b89bafc97c7f31a100504ea3fedb1e0";
const EXPECTED_TABLE_SHA256 = "eb135fa6fe3c8287e14f1a34f6d6eeded9781ebf37fe8feb140cdc45d2cc4f8b";

export function validateWorldView(candidate, { testMode = false } = {}) {
  if (testMode) return validateDiagnostic(candidate);
  if (candidate?.schemaVersion !== REAL_VIEW_SCHEMA) throw new Error("Real Oneida runtime view is required outside explicit test mode.");
  if (candidate.status !== "working_real_oneida_site_fields_no_fitted_suitability") throw new Error("Oneida runtime view has an unsafe readiness claim.");
  if (candidate.geography?.name !== "Oneida County, Wisconsin" || candidate.geography?.fips !== "55085") throw new Error("Oneida runtime view geography mismatch.");
  if (candidate.sourcePackage?.manifestSha256 !== EXPECTED_MANIFEST_SHA256) throw new Error("Oneida package manifest identity mismatch.");
  if (candidate.sourcePackage?.siteStateSha256 !== EXPECTED_TABLE_SHA256) throw new Error("Oneida package table identity mismatch.");
  if (candidate.sourcePackage?.rowCount !== 458182 || candidate.sourcePackage?.fieldCount !== 51) throw new Error("Oneida package dimensions mismatch.");
  if (candidate.siteFactor?.decisionStatus !== "Working_reversible_not_MaxEnt_or_calibration") throw new Error("Working site factor was silently promoted.");
  if (!Array.isArray(candidate.sitePreview) || candidate.sitePreview.length !== 19) throw new Error("Oneida local stand must bind the complete radius-two neighborhood.");
  if (!Array.isArray(candidate.kernelSiteIds) || candidate.kernelSiteIds.length !== 19) throw new Error("Founder-detail view must bind exactly nineteen contiguous local sites.");
  if (candidate.localStand?.schema !== "stand.oneida.local-hex-neighborhood@1" || candidate.localStand?.hexRadius !== 2 || candidate.localStand?.countyBoundaryRendered !== true) throw new Error("Oneida local-stand scale contract mismatch.");
  if (candidate.countyPreview?.status !== "working_real_county_context_navigable_not_fitted_suitability") throw new Error("Oneida county context readiness mismatch.");
  if (!Array.isArray(candidate.countyPreview?.boundary?.points) || candidate.countyPreview.boundary.points.length < 32) throw new Error("Oneida county boundary context is incomplete.");
  if (!Array.isArray(candidate.countyPreview?.siteSamples) || candidate.countyPreview.siteSamples.length !== candidate.countyPreview.siteCount || candidate.countyPreview.siteSamples.length < 64) throw new Error("Oneida county site context is incomplete.");
  if (candidate.ambientArtAuthority?.otherFamilies !== "presentation_only_no_commands_ecology_MaxEnt_suitability_or_save_authority") throw new Error("Ambient Art authority boundary mismatch.");
  const sites = new Map(candidate.sitePreview.map((site) => [site.hex_id, site]));
  if (!sites.has(candidate.selectedFounderSiteId) || candidate.kernelSiteIds.some((id) => !sites.has(id))) throw new Error("Oneida selected/kernel site identity mismatch.");
  for (const site of candidate.sitePreview) {
    if (![site.kernelX, site.kernelY, site.viewX, site.viewY].every(Number.isFinite)) throw new Error("Oneida local site coordinates are incomplete.");
  }
  return structuredClone(candidate);
}

export function createKernelWorld(view) {
  const sites = new Map(view.sitePreview.map((site) => [site.hex_id, site]));
  const viewToKernel = createViewToKernelProjector(view.sitePreview);
  const localCells = view.kernelSiteIds.map((id) => {
    const site = sites.get(id);
    return {
      cellId: id,
      x: site.kernelX,
      y: site.kernelY,
      siteLight01: workingLight(site),
      suitability01: site.workingSiteFactor01,
      growingSpaceStems: 480,
    };
  });
  const countyCells = view.countyPreview.siteSamples.map((sample, index) => {
    const position = viewToKernel(sample);
    return {
      cellId: `oneida-working-county-sample-${String(index).padStart(3, "0")}`,
      x: position.x,
      y: position.y,
      siteLight01: workingCountyLight(sample),
      suitability01: sample.workingSiteFactor01,
      growingSpaceStems: 480,
    };
  });
  return createReferenceWorld({
    worldId: `oneida-working-county-view-${view.sourcePackage.manifestSha256.slice(0, 12)}`,
    packageIdentity: view.sourcePackage.manifestSha256,
    cells: [...localCells, ...countyCells],
    minimumSupportRadius: countySupportRadius(countyCells),
  });
}

export function createRenderFixture(view) {
  const county = view.countyPreview;
  const elevations = county.siteSamples.map(({ elevationM }) => Number(elevationM)).filter(Number.isFinite);
  return Object.freeze({
    schema: "stand-render-fixture@1",
    id: `oneida-real-site-view-${view.sourcePackage.manifestSha256.slice(0, 12)}`,
    disposition: "working_real_site_fields_no_fitted_suitability",
    geography: Object.freeze({
      name: "Oneida County, Wisconsin",
      fips: "55085",
      role: "v0.0.2 external candidate runtime view",
      containsRealCountyValues: true,
      ecologicalBoundary: false,
    }),
    spatialBasis: Object.freeze({
      coordinateFrame: "bounded-presentation-projection-from-EPSG-3071",
      horizontalUnit: "presentation-unit",
      selectedCrs: "Working candidate EPSG:3071",
      selectedAnalysisGrid: "Working candidate 30 m source alignment",
      selectedRuntimeLattice: "Working candidate hidden nominal one-hectare hex",
    }),
    extent: Object.freeze({ width: county.extent.width, height: county.extent.height }),
    boundary: Object.freeze({
      role: "real Oneida County context boundary; no ecological or territorial authority",
      sourceSha256: county.boundary.sourceSha256,
      points: Object.freeze(county.boundary.points.map((point) => Object.freeze([...point]))),
    }),
    terrain: Object.freeze({
      elevationRangeM: Object.freeze([Math.min(...elevations), Math.max(...elevations)]),
      samples: Object.freeze(county.siteSamples.map((site) => Object.freeze([site.viewX, site.viewY, site.elevationM]))),
    }),
    siteFactor: Object.freeze({
      id: view.siteFactor.id,
      label: view.siteFactor.label,
      decisionStatus: view.siteFactor.decisionStatus,
      ecologyInterpolation: SITE_INTERPOLATION_CONTRACT,
      presentationBlend: "overlapping-watercolor-site-wash@1",
      fittedSuitability: false,
      samples: Object.freeze(county.siteSamples.map((site) =>
        Object.freeze([site.viewX, site.viewY, site.workingSiteFactor01]),
      )),
    }),
    water: Object.freeze({ role: "real site-field wash; no visible hidden-grid geometry", bodies: Object.freeze([]), streams: Object.freeze([]) }),
    sourceCopy: Object.freeze({
      compact: "Oneida County · county-spanning sugar-maple play · Working factor",
      detail: "The managed sugar-maple population can spread progressively across a downsampled Working Oneida site field. The field and Kernel parameters are not fitted suitability or calibrated production ecology.",
    }),
  });
}

function validateDiagnostic(candidate) {
  if (candidate?.manifest_schema !== TEST_VIEW_SCHEMA || candidate.status !== "synthetic_loader_contract_fixture_not_real_Oneida_data") {
    throw new Error("Explicit test mode requires the checked-in synthetic World diagnostic.");
  }
  if (!candidate.claim_limits?.includes("test_only")) throw new Error("Synthetic World diagnostic lost its test-only label.");
  const sourceSites = candidate.sites.map((site, index) => ({
    ...structuredClone(site),
    kernelX: index * 2,
    kernelY: 0,
    viewX: 42 + index * 28,
    viewY: 46,
    workingSiteFactor01: index === 0 ? 0.83 : 0.24,
  }));
  return {
    schemaVersion: "STAND-ONEIDA-VERTICAL-TEST-VIEW@1",
    status: candidate.status,
    geography: { name: "Synthetic Oneida loader fixture", fips: "55085", containsRealSiteFields: false },
    sourcePackage: {
      manifestSha256: "synthetic-test-fixture",
      siteStateSha256: "synthetic-test-fixture",
      rowCount: sourceSites.length,
      fieldCount: Object.keys(sourceSites[0]).length,
    },
    siteFactor: {
      id: "stand-working-site-factor-test-fixture@1",
      decisionStatus: "Working_reversible_not_MaxEnt_or_calibration",
      label: "Synthetic test site factor — not real Oneida or fitted suitability",
    },
    selectedFounderSiteId: sourceSites[0].hex_id,
    sitePreview: sourceSites,
    kernelSiteIds: sourceSites.map(({ hex_id }) => hex_id),
    ambientArtAuthority: { otherFamilies: "presentation_only_no_commands_ecology_MaxEnt_suitability_or_save_authority" },
    claimLimits: candidate.claim_limits,
  };
}

function workingLight(site) {
  const forest = Number(site.forest_mask_area_fraction);
  const developed = Number(site.developed_mask_area_fraction);
  return Math.max(0.35, Math.min(0.95, 0.35 + 0.55 * (1 - forest) + 0.10 * (1 - developed)));
}

function workingCountyLight(sample) {
  const forest = Number(sample.forestFraction);
  return Math.max(0.35, Math.min(0.95, 0.4 + 0.45 * (1 - forest)));
}

function createViewToKernelProjector(sourceSites) {
  const sites = sourceSites.filter((site) =>
    [site.kernelX, site.kernelY, site.viewX, site.viewY].every(Number.isFinite),
  );
  let basis = null;
  for (let first = 0; first < sites.length - 2; first += 1) {
    for (let second = first + 1; second < sites.length - 1; second += 1) {
      for (let third = second + 1; third < sites.length; third += 1) {
        const candidate = [sites[first], sites[second], sites[third]];
        const determinant =
          (candidate[1].viewX - candidate[0].viewX) * (candidate[2].viewY - candidate[0].viewY) -
          (candidate[1].viewY - candidate[0].viewY) * (candidate[2].viewX - candidate[0].viewX);
        if (!basis || Math.abs(determinant) > Math.abs(basis.determinant)) basis = { sites: candidate, determinant };
      }
    }
  }
  if (!basis || Math.abs(basis.determinant) <= 1e-12) throw new Error("Oneida local view cannot project county samples into Kernel space.");
  const [origin, xBasis, yBasis] = basis.sites;
  return (point) => {
    const px = point.viewX - origin.viewX;
    const py = point.viewY - origin.viewY;
    const bx = xBasis.viewX - origin.viewX;
    const by = xBasis.viewY - origin.viewY;
    const cx = yBasis.viewX - origin.viewX;
    const cy = yBasis.viewY - origin.viewY;
    const u = (px * cy - py * cx) / basis.determinant;
    const v = (bx * py - by * px) / basis.determinant;
    return {
      x: origin.kernelX + u * (xBasis.kernelX - origin.kernelX) + v * (yBasis.kernelX - origin.kernelX),
      y: origin.kernelY + u * (xBasis.kernelY - origin.kernelY) + v * (yBasis.kernelY - origin.kernelY),
    };
  };
}

function countySupportRadius(cells) {
  const nearest = cells.map((cell) => Math.min(...cells
    .filter((candidate) => candidate !== cell)
    .map((candidate) => Math.hypot(candidate.x - cell.x, candidate.y - cell.y))
    .filter((distance) => distance > 1e-9)));
  nearest.sort((left, right) => left - right);
  const median = nearest[Math.floor(nearest.length / 2)];
  if (!(median > 0) || !Number.isFinite(median)) throw new Error("Oneida county samples cannot define continuous Kernel support.");
  return median * 0.56;
}
