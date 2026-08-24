const DATABASE_NAME = "stand-v0.0.2-browser";
const DATABASE_VERSION = 1;
const STORE_NAME = "generations";
const RETAINED_GENERATIONS = 2;
const ALLOWED_SLOTS = new Set(["main", "smoke"]);

export function createBrowserGenerationStorage(slotId, { indexedDB = globalThis.indexedDB } = {}) {
  if (!ALLOWED_SLOTS.has(slotId)) throw new Error("Unknown Stand browser save slot.");
  if (!indexedDB?.open) throw new Error("This browser does not provide persistent IndexedDB storage.");
  const database = openDatabase(indexedDB);

  return Object.freeze({
    kind: "browser-indexeddb",
    async save(canonicalPayload) {
      if (typeof canonicalPayload !== "string" || canonicalPayload.length === 0) {
        throw new Error("Stand browser saves require a nonempty canonical payload.");
      }
      const db = await database;
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.index("slotId").getAll(slotId);
        let receipt = null;
        request.onsuccess = () => {
          const prior = normalizeGenerations(request.result);
          const generation = (prior[0]?.generation ?? 0) + 1;
          const record = {
            key: generationKey(slotId, generation),
            slotId,
            generation,
            canonicalPayload,
          };
          const retained = planRetainedGenerations([...prior, record]);
          store.put(record);
          const retainedKeys = new Set(retained.map(({ key }) => key));
          for (const candidate of prior) if (!retainedKeys.has(candidate.key)) store.delete(candidate.key);
          receipt = { generation, bytes: new TextEncoder().encode(canonicalPayload).byteLength, persistence: "browser-indexeddb" };
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve(receipt);
        transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error("Stand browser save transaction was aborted."));
        transaction.onerror = () => reject(transaction.error ?? new Error("Stand browser save transaction failed."));
      });
    },
    async load() {
      const db = await database;
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).index("slotId").getAll(slotId);
        request.onsuccess = () => resolve(normalizeGenerations(request.result).map(({ generation, canonicalPayload }) => ({ generation, canonicalPayload })));
        request.onerror = () => reject(request.error ?? new Error("Stand browser saves could not be read."));
        transaction.onerror = () => reject(transaction.error ?? new Error("Stand browser load transaction failed."));
      });
    },
  });
}

export function planRetainedGenerations(records, retainedCount = RETAINED_GENERATIONS) {
  if (!Number.isSafeInteger(retainedCount) || retainedCount < 1) throw new Error("Retained browser generation count must be positive.");
  return normalizeGenerations(records).slice(0, retainedCount);
}

function normalizeGenerations(records) {
  return records
    .filter((record) => record && Number.isSafeInteger(record.generation) && record.generation > 0 && typeof record.canonicalPayload === "string")
    .map((record) => ({ ...record, key: record.key ?? generationKey(record.slotId, record.generation) }))
    .sort((left, right) => right.generation - left.generation);
}

function generationKey(slotId, generation) {
  return `${slotId}:g${String(generation).padStart(8, "0")}`;
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("slotId", "slotId", { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Stand browser storage could not be opened."));
    request.onblocked = () => reject(new Error("Stand browser storage upgrade is blocked by another open game tab."));
  });
}
