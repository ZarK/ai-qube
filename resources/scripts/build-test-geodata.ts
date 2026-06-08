import Database from "better-sqlite3"
import * as fs from "fs"
import * as path from "path"

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

function buildTestGeodata(outputPath: string) {
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath)
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
  console.log(`Created test geodata at: ${outputPath}`)
}

const outputPath = process.argv[2] || path.join(__dirname, "..", "e2e", "fixtures", "geodata.test.db")
buildTestGeodata(outputPath)
