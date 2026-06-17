type RegistryEntry = {
  id: string;
};

export type Registry<T extends RegistryEntry> = {
  byId: ReadonlyMap<string, T>;
  entries: readonly T[];
};

function cloneRegistryEntry<T extends RegistryEntry>(entry: T): T {
  return Object.assign({}, entry);
}

export function createRegistry<T extends RegistryEntry>(entries: readonly T[]): Registry<T> {
  const registeredEntries = entries.map(cloneRegistryEntry);
  const byId = new Map<string, T>();

  for (const entry of registeredEntries) {
    if (byId.has(entry.id)) {
      throw new Error(`Duplicate registry entry '${entry.id}'.`);
    }

    byId.set(entry.id, entry);
  }

  return {
    byId,
    entries: registeredEntries,
  };
}
