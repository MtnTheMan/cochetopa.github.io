const ASSET_URLS = Object.freeze({
  foliage: new URL("../assets/sugar-maple-foliage.svg", import.meta.url),
  samara: new URL("../assets/sugar-maple-samara.svg", import.meta.url),
  ambient: new URL("../assets/unknown-ambient-crown.svg", import.meta.url),
});
const AMBIENT_BINDING_URL = new URL("../assets/ambient-art-bindings.json", import.meta.url);

export async function loadRenderAssets(ImageConstructor = globalThis.Image, fetchImpl = globalThis.fetch) {
  if (typeof ImageConstructor !== "function") return Object.freeze({});
  const entries = await Promise.all(
    Object.entries(ASSET_URLS).map(async ([key, url]) => [key, await loadImage(url, ImageConstructor)]),
  );
  const core = Object.fromEntries(entries);
  const ambientArt = await loadAmbientArt(core.foliage, ImageConstructor, fetchImpl);
  return Object.freeze({ ...core, ambientArt });
}

async function loadAmbientArt(sugarMapleImage, ImageConstructor, fetchImpl) {
  if (typeof fetchImpl !== "function") return emptyAmbientArt();
  try {
    const response = await fetchImpl(AMBIENT_BINDING_URL);
    if (!response.ok) return emptyAmbientArt();
    const manifest = await response.json();
    const loaded = await Promise.all(manifest.bindings.map(async (binding) => {
      if (binding.familyId === "acer-saccharum") return [binding.familyId, sugarMapleImage];
      try { return [binding.familyId, await loadImage(new URL(binding.runtimePath, AMBIENT_BINDING_URL), ImageConstructor)]; }
      catch { return [binding.familyId, null]; }
    }));
    const images = Object.freeze(Object.fromEntries(loaded.filter(([, image]) => image)));
    return Object.freeze({ manifest, images, loadedFamilyIds: Object.freeze(Object.keys(images)) });
  } catch { return emptyAmbientArt(); }
}

function emptyAmbientArt() { return Object.freeze({ manifest: null, images: Object.freeze({}), loadedFamilyIds: Object.freeze([]) }); }

function loadImage(url, ImageConstructor) {
  return new Promise((resolve, reject) => {
    const image = new ImageConstructor();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load renderer asset: ${url}`));
    image.src = String(url);
  });
}
