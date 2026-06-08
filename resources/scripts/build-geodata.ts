#!/usr/bin/env bun
/**
 * Build script for geodata.db - offline reverse geocoding database
 *
 * Data sources:
 * - GeoNames (global): cities500.zip, admin1CodesASCII.txt, countryInfo.txt
 * - Kartverket SSR (Norway only): Natural feature names
 *
 * Usage:
 *   bun run scripts/build-geodata.ts [--output path] [--skip-ssr] [--test-only]
 *
 * Options:
 *   --output <path>  Output path for geodata.db (default: ~/Library/Application Support/Memex/geodata.db)
 *   --skip-ssr       Skip Kartverket SSR download (Norway natural features)
 *   --test-only      Only build test database (e2e/fixtures/geodata.test.db)
 *   --cache-dir      Directory to cache downloaded files (default: .geodata-cache)
 */

import { Database } from "bun:sqlite"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Readable } from "stream"
import AdmZip from "adm-zip"

const args = process.argv.slice(2)
const skipSsr = args.includes("--skip-ssr")
const testOnly = args.includes("--test-only")
const outputIndex = args.indexOf("--output")
const cacheIndex = args.indexOf("--cache-dir")

const defaultOutputDir =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Memex")
    : process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming", "Memex")
      : path.join(os.homedir(), ".local", "share", "memex")

const outputPath =
  outputIndex >= 0 && args[outputIndex + 1]
    ? args[outputIndex + 1]
    : testOnly
      ? path.join(__dirname, "..", "e2e", "fixtures", "geodata.test.db")
      : path.join(defaultOutputDir, "geodata.db")

const cacheDir = cacheIndex >= 0 && args[cacheIndex + 1] ? args[cacheIndex + 1] : path.join(__dirname, "..", ".geodata-cache")

const GEONAMES_BASE = "https://download.geonames.org/export/dump"
const GEONAMES_FILES = {
  cities500: `${GEONAMES_BASE}/cities500.zip`,
  admin1: `${GEONAMES_BASE}/admin1CodesASCII.txt`,
  countryInfo: `${GEONAMES_BASE}/countryInfo.txt`,
}

const SSR_API_BASE = "https://ws.geonorge.no/stedsnavn/v1"
const SSR_THEMES = ["fjell", "bre", "vatn", "dal", "eid", "nes", "fjord", "elv", "foss", "myr", "skog", "strand", "øy", "vik", "bukt"]

interface Admin1Entry {
  code: string
  name: string
}

interface GeonamesRow {
  geonameId: number
  name: string
  asciiName: string
  alternatenames: string
  latitude: number
  longitude: number
  featureClass: string
  featureCode: string
  countryCode: string
  cc2: string
  admin1Code: string
  admin2Code: string
  admin3Code: string
  admin4Code: string
  population: number
  elevation: number
  dem: number
  timezone: string
  modificationDate: string
}

interface SsrFeature {
  id: number
  name: string
  nameType: string
  municipality: string
  county: string
  themeCode: string
  themeName: string
  lat: number
  lon: number
  altitude: number | null
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  if (fs.existsSync(destPath)) {
    console.log(`  Using cached: ${path.basename(destPath)}`)
    return
  }

  console.log(`  Downloading: ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer))
  console.log(`  Downloaded: ${path.basename(destPath)}`)
}

function extractZip(zipPath: string, destDir: string): string[] {
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(destDir, true)
  return zip.getEntries().map((e) => e.entryName)
}

function parseGeonamesLine(line: string): GeonamesRow | null {
  const parts = line.split("\t")
  if (parts.length < 19) return null

  return {
    geonameId: parseInt(parts[0], 10),
    name: parts[1],
    asciiName: parts[2],
    alternatenames: parts[3],
    latitude: parseFloat(parts[4]),
    longitude: parseFloat(parts[5]),
    featureClass: parts[6],
    featureCode: parts[7],
    countryCode: parts[8],
    cc2: parts[9],
    admin1Code: parts[10],
    admin2Code: parts[11],
    admin3Code: parts[12],
    admin4Code: parts[13],
    population: parseInt(parts[14], 10) || 0,
    elevation: parseInt(parts[15], 10) || 0,
    dem: parseInt(parts[16], 10) || 0,
    timezone: parts[17],
    modificationDate: parts[18],
  }
}

function parseAdmin1Line(line: string): Admin1Entry | null {
  const parts = line.split("\t")
  if (parts.length < 2) return null
  return { code: parts[0], name: parts[1] }
}

function parseCountryLine(line: string): { code: string; name: string } | null {
  if (line.startsWith("#") || !line.trim()) return null
  const parts = line.split("\t")
  if (parts.length < 5) return null
  return { code: parts[0], name: parts[4] }
}

async function fetchSsrFeatures(
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  themes: string[]
): Promise<SsrFeature[]> {
  const results: SsrFeature[] = []

  for (const theme of themes) {
    try {
      const url = new URL(`${SSR_API_BASE}/sted`)
      url.searchParams.set("navneobjekttype", theme)
      url.searchParams.set("nord", bbox.maxLat.toString())
      url.searchParams.set("sor", bbox.minLat.toString())
      url.searchParams.set("ost", bbox.maxLon.toString())
      url.searchParams.set("vest", bbox.minLon.toString())
      url.searchParams.set("treffPerSide", "1000")

      const response = await fetch(url.toString())
      if (!response.ok) {
        console.warn(`  Warning: SSR API returned ${response.status} for theme ${theme}`)
        continue
      }

      const data = (await response.json()) as { navn?: Array<any> }
      if (!data.navn) continue

      for (const feature of data.navn) {
        if (!feature.representasjonspunkt) continue

        results.push({
          id: feature.stedsnummer || results.length + 1,
          name: feature.skrivemåte || feature.stedsnavn || "",
          nameType: feature.navnestatus || "official",
          municipality: feature.kommunenavn || "",
          county: feature.fylkesnavn || "",
          themeCode: theme,
          themeName: getThemeDisplayName(theme),
          lat: feature.representasjonspunkt.nord,
          lon: feature.representasjonspunkt.øst,
          altitude: feature.representasjonspunkt.høyde || null,
        })
      }
    } catch (error) {
      console.warn(`  Warning: Failed to fetch SSR data for theme ${theme}: ${error}`)
    }
  }

  return results
}

function getThemeDisplayName(code: string): string {
  const names: Record<string, string> = {
    fjell: "Fjell",
    bre: "Bre",
    vatn: "Vatn",
    dal: "Dal",
    eid: "Eid",
    nes: "Nes",
    fjord: "Fjord",
    elv: "Elv",
    foss: "Foss",
    myr: "Myr",
    skog: "Skog",
    strand: "Strand",
    øy: "Island",
    vik: "Vik",
    bukt: "Bukt",
  }
  return names[code] || code
}

function buildTestGeodata(): void {
  console.log("Building test geodata.db...")
  console.log(`  Output: ${outputPath}`)

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath)
  }

  const testPlaces = [
    { id: 2950159, name: "Berlin", ascii: "Berlin", cc: "DE", admin1: "16", admin1Name: "Berlin", lat: 52.52437, lon: 13.41053, pop: 3426354 },
    { id: 2988507, name: "Paris", ascii: "Paris", cc: "FR", admin1: "11", admin1Name: "Île-de-France", lat: 48.85341, lon: 2.3488, pop: 2138551 },
    { id: 3143244, name: "Oslo", ascii: "Oslo", cc: "NO", admin1: "12", admin1Name: "Oslo", lat: 59.91273, lon: 10.74609, pop: 580000 },
    { id: 3133880, name: "Trondheim", ascii: "Trondheim", cc: "NO", admin1: "16", admin1Name: "Trøndelag", lat: 63.43049, lon: 10.39506, pop: 190464 },
    { id: 3161732, name: "Bergen", ascii: "Bergen", cc: "NO", admin1: "12", admin1Name: "Vestland", lat: 60.39299, lon: 5.32415, pop: 213585 },
    { id: 5128581, name: "New York City", ascii: "New York City", cc: "US", admin1: "NY", admin1Name: "New York", lat: 40.71427, lon: -74.00597, pop: 8175133 },
    { id: 2643743, name: "London", ascii: "London", cc: "GB", admin1: "ENG", admin1Name: "England", lat: 51.50853, lon: -0.12574, pop: 7556900 },
    { id: 1850147, name: "Tokyo", ascii: "Tokyo", cc: "JP", admin1: "40", admin1Name: "Tokyo", lat: 35.6895, lon: 139.69171, pop: 8336599 },
  ]

  const testSsrPlaces = [
    { id: 1, name: "Galdhøpiggen", type: "official", muni: "Lom", county: "Innlandet", theme: "fjell", themeName: "Fjell", lat: 61.6364, lon: 8.3125, alt: 2469 },
    { id: 2, name: "Holmenkollen", type: "official", muni: "Oslo", county: "Oslo", theme: "ås", themeName: "Ås", lat: 59.9639, lon: 10.6677, alt: 371 },
    { id: 3, name: "Jostedalsbreen", type: "official", muni: "Stryn", county: "Vestland", theme: "bre", themeName: "Bre", lat: 61.6667, lon: 7.0, alt: 1957 },
  ]

  const countries: Record<string, string> = {
    DE: "Germany",
    FR: "France",
    NO: "Norway",
    US: "United States",
    GB: "United Kingdom",
    JP: "Japan",
  }

  const db = new Database(outputPath)

  db.exec(`
    CREATE TABLE geonames_place (
      geoname_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      ascii_name TEXT,
      country_code TEXT NOT NULL,
      admin1_code TEXT,
      admin1_name TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      feature_class TEXT,
      feature_code TEXT,
      population INTEGER,
      timezone TEXT
    );

    CREATE TABLE ssr_place (
      ssr_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_type TEXT,
      municipality TEXT,
      county TEXT,
      theme_code TEXT,
      theme_name TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      altitude_m REAL
    );

    CREATE TABLE countries (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE rtree_geonames USING rtree(id, lat_min, lat_max, lon_min, lon_max);
    CREATE VIRTUAL TABLE rtree_ssr USING rtree(id, lat_min, lat_max, lon_min, lon_max);

    CREATE INDEX idx_geonames_pop ON geonames_place(population DESC);
  `)

  const insertPlace = db.prepare(`
    INSERT INTO geonames_place (geoname_id, name, ascii_name, country_code, admin1_code, admin1_name, lat, lon, population)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertRtree = db.prepare(`INSERT INTO rtree_geonames (id, lat_min, lat_max, lon_min, lon_max) VALUES (?, ?, ?, ?, ?)`)

  for (const p of testPlaces) {
    insertPlace.run(p.id, p.name, p.ascii, p.cc, p.admin1, p.admin1Name, p.lat, p.lon, p.pop)
    insertRtree.run(p.id, p.lat, p.lat, p.lon, p.lon)
  }

  const insertSsr = db.prepare(`
    INSERT INTO ssr_place (ssr_id, name, name_type, municipality, county, theme_code, theme_name, lat, lon, altitude_m)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSsrRtree = db.prepare(`INSERT INTO rtree_ssr (id, lat_min, lat_max, lon_min, lon_max) VALUES (?, ?, ?, ?, ?)`)

  for (const s of testSsrPlaces) {
    insertSsr.run(s.id, s.name, s.type, s.muni, s.county, s.theme, s.themeName, s.lat, s.lon, s.alt)
    insertSsrRtree.run(s.id, s.lat, s.lat, s.lon, s.lon)
  }

  const insertCountry = db.prepare(`INSERT INTO countries (code, name) VALUES (?, ?)`)
  for (const [code, name] of Object.entries(countries)) {
    insertCountry.run(code, name)
  }

  db.close()

  const stats = fs.statSync(outputPath)
  const sizeKb = (stats.size / 1024).toFixed(2)
  console.log(`\nDone! Created ${outputPath}`)
  console.log(`  Size: ${sizeKb} KB`)
}

async function buildGeodata(): Promise<void> {
  if (testOnly) {
    buildTestGeodata()
    return
  }

  console.log("Building geodata.db...")
  console.log(`  Output: ${outputPath}`)
  console.log(`  Cache: ${cacheDir}`)
  console.log(`  Skip SSR: ${skipSsr}`)

  fs.mkdirSync(cacheDir, { recursive: true })
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath)
  }

  console.log("\n1. Downloading GeoNames data...")
  const cities500Zip = path.join(cacheDir, "cities500.zip")
  const admin1Path = path.join(cacheDir, "admin1CodesASCII.txt")
  const countryInfoPath = path.join(cacheDir, "countryInfo.txt")

  await downloadFile(GEONAMES_FILES.cities500, cities500Zip)
  await downloadFile(GEONAMES_FILES.admin1, admin1Path)
  await downloadFile(GEONAMES_FILES.countryInfo, countryInfoPath)

  console.log("\n2. Extracting cities500.zip...")
  const extractDir = path.join(cacheDir, "extracted")
  fs.mkdirSync(extractDir, { recursive: true })
  extractZip(cities500Zip, extractDir)
  const cities500Path = path.join(extractDir, "cities500.txt")

  console.log("\n3. Parsing admin1 codes...")
  const admin1Content = fs.readFileSync(admin1Path, "utf-8")
  const admin1Map = new Map<string, string>()
  for (const line of admin1Content.split("\n")) {
    const entry = parseAdmin1Line(line)
    if (entry) {
      admin1Map.set(entry.code, entry.name)
    }
  }
  console.log(`  Loaded ${admin1Map.size} admin1 codes`)

  console.log("\n4. Parsing country info...")
  const countryContent = fs.readFileSync(countryInfoPath, "utf-8")
  const countryMap = new Map<string, string>()
  for (const line of countryContent.split("\n")) {
    const entry = parseCountryLine(line)
    if (entry) {
      countryMap.set(entry.code, entry.name)
    }
  }
  console.log(`  Loaded ${countryMap.size} countries`)

  console.log("\n5. Creating SQLite database...")
  const db = new Database(outputPath)

  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA cache_size = 1000000;
    PRAGMA locking_mode = EXCLUSIVE;
    PRAGMA temp_store = MEMORY;

    CREATE TABLE geonames_place (
      geoname_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      ascii_name TEXT,
      country_code TEXT NOT NULL,
      admin1_code TEXT,
      admin1_name TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      feature_class TEXT,
      feature_code TEXT,
      population INTEGER,
      timezone TEXT
    );

    CREATE TABLE ssr_place (
      ssr_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_type TEXT,
      municipality TEXT,
      county TEXT,
      theme_code TEXT,
      theme_name TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      altitude_m REAL
    );

    CREATE TABLE countries (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE rtree_geonames USING rtree(id, lat_min, lat_max, lon_min, lon_max);
    CREATE VIRTUAL TABLE rtree_ssr USING rtree(id, lat_min, lat_max, lon_min, lon_max);
  `)

  console.log("\n6. Inserting countries...")
  const insertCountry = db.prepare("INSERT INTO countries (code, name) VALUES (?, ?)")
  db.transaction(() => {
    for (const [code, name] of countryMap.entries()) {
      insertCountry.run(code, name)
    }
  })()
  console.log(`  Inserted ${countryMap.size} countries`)

  console.log("\n7. Inserting cities (this may take a minute)...")
  const insertPlace = db.prepare(`
    INSERT INTO geonames_place (geoname_id, name, ascii_name, country_code, admin1_code, admin1_name, lat, lon, feature_class, feature_code, population, timezone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertRtree = db.prepare("INSERT INTO rtree_geonames (id, lat_min, lat_max, lon_min, lon_max) VALUES (?, ?, ?, ?, ?)")

  const citiesContent = fs.readFileSync(cities500Path, "utf-8")
  const lines = citiesContent.split("\n")
  let insertedCount = 0

  const BATCH_SIZE = 5000
  let batch: GeonamesRow[] = []

  const insertBatch = db.transaction((rows: GeonamesRow[]) => {
    for (const row of rows) {
      const admin1Key = `${row.countryCode}.${row.admin1Code}`
      const admin1Name = admin1Map.get(admin1Key) || null

      insertPlace.run(
        row.geonameId,
        row.name,
        row.asciiName || null,
        row.countryCode,
        row.admin1Code || null,
        admin1Name,
        row.latitude,
        row.longitude,
        row.featureClass || null,
        row.featureCode || null,
        row.population,
        row.timezone || null
      )
      insertRtree.run(row.geonameId, row.latitude, row.latitude, row.longitude, row.longitude)
      insertedCount++
    }
  })

  for (const line of lines) {
    if (!line.trim()) continue
    const row = parseGeonamesLine(line)
    if (!row) continue

    batch.push(row)

    if (batch.length >= BATCH_SIZE) {
      insertBatch(batch)
      batch = []
      process.stdout.write(`  Inserted ${insertedCount} cities...\r`)
    }
  }

  if (batch.length > 0) {
    insertBatch(batch)
  }

  console.log(`  Inserted ${insertedCount} cities`)

  if (!skipSsr) {
    console.log("\n8. Fetching Kartverket SSR features for Norway...")
    const norwayBbox = { minLat: 57.5, maxLat: 71.5, minLon: 4.0, maxLon: 31.0 }

    const latStep = 2.0
    const lonStep = 4.0
    let ssrCount = 0

    const insertSsr = db.prepare(`
      INSERT OR IGNORE INTO ssr_place (ssr_id, name, name_type, municipality, county, theme_code, theme_name, lat, lon, altitude_m)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertSsrRtree = db.prepare("INSERT INTO rtree_ssr (id, lat_min, lat_max, lon_min, lon_max) VALUES (?, ?, ?, ?, ?)")

    const insertSsrBatch = db.transaction((features: SsrFeature[]) => {
      for (const f of features) {
        insertSsr.run(f.id, f.name, f.nameType, f.municipality, f.county, f.themeCode, f.themeName, f.lat, f.lon, f.altitude)
        insertSsrRtree.run(f.id, f.lat, f.lat, f.lon, f.lon)
        ssrCount++
      }
    })

    for (let lat = norwayBbox.minLat; lat < norwayBbox.maxLat; lat += latStep) {
      for (let lon = norwayBbox.minLon; lon < norwayBbox.maxLon; lon += lonStep) {
        const tileBbox = {
          minLat: lat,
          maxLat: Math.min(lat + latStep, norwayBbox.maxLat),
          minLon: lon,
          maxLon: Math.min(lon + lonStep, norwayBbox.maxLon),
        }

        try {
          const features = await fetchSsrFeatures(tileBbox, SSR_THEMES)
          if (features.length > 0) {
            insertSsrBatch(features)
            process.stdout.write(`  Fetched ${ssrCount} SSR features...\r`)
          }
        } catch (error) {
          console.warn(`  Warning: Failed to fetch SSR for tile (${lat}, ${lon}): ${error}`)
        }

        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    console.log(`  Inserted ${ssrCount} SSR features`)
  } else {
    console.log("\n8. Skipping SSR features (--skip-ssr)")
  }

  console.log("\n9. Creating indexes...")
  db.exec("CREATE INDEX idx_geonames_pop ON geonames_place(population DESC)")
  db.exec("CREATE INDEX idx_geonames_country ON geonames_place(country_code)")

  console.log("\n10. Optimizing database...")
  db.exec("VACUUM")
  db.exec("ANALYZE")

  db.close()

  const stats = fs.statSync(outputPath)
  const sizeMb = (stats.size / 1024 / 1024).toFixed(2)
  console.log(`\nDone! Created ${outputPath}`)
  console.log(`  Size: ${sizeMb} MB`)
}

buildGeodata().catch((err) => {
  console.error("Build failed:", err)
  process.exit(1)
})
