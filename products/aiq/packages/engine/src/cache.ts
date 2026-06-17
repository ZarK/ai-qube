import type { CacheService } from "./contracts.js";

type CacheEntry = {
  expiry: number | null;
  value: Promise<unknown>;
};

class MemoryCacheService implements CacheService {
  private cache = new Map<string, CacheEntry>();

  async deleteByPrefix(prefix: string, exceptKeys: readonly string[] = []): Promise<void> {
    const exclusions = new Set(exceptKeys);

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix) && !exclusions.has(key)) {
        this.cache.delete(key);
      }
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.readEntry(key);
    if (entry === undefined) {
      return undefined;
    }

    return (await entry.value) as T;
  }

  async getOrCreate<T>(
    key: string,
    createValue: () => Promise<T>,
  ): Promise<{ cacheHit: boolean; value: T }> {
    const entry = this.readEntry(key);
    if (entry !== undefined) {
      return {
        cacheHit: true,
        value: (await entry.value) as T,
      };
    }

    const pending = Promise.resolve()
      .then(createValue)
      .catch((error) => {
        const currentEntry = this.cache.get(key);
        if (currentEntry?.value === pending) {
          this.cache.delete(key);
        }
        throw error;
      });

    this.cache.set(key, {
      expiry: null,
      value: pending,
    });

    return {
      cacheHit: false,
      value: await pending,
    };
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const expiry = ttl === undefined ? null : Date.now() + ttl;
    this.cache.set(key, {
      expiry,
      value: Promise.resolve(value),
    });
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  generateKey(parts: string[]): string {
    return parts.join("\u0000");
  }

  private readEntry(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiry !== null && entry.expiry <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }

    return entry;
  }
}

export function createCacheService(): CacheService {
  return new MemoryCacheService();
}
