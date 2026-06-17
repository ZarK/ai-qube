# M8 Weather — Addendum: Dual-API Strategy & Extended Weather Data

## Overview

This addendum supersedes and extends portions of the original M8-Weather specification based on comprehensive API research. The key insight is that Open-Meteo provides **three distinct APIs** for historical weather data, each with different coverage, resolution, and variable availability.

**Changes in this addendum:**

1. **Tri-API Architecture** — Use Forecast API for recent (≤60 days), Historical Forecast API for 2022+ photos, Archive API for pre-2022
2. **Safe Variable Sets** — Define the largest common variable set for each API tier
3. **Model Selection Strategy** — Performant algorithm for routing requests with fallbacks
4. **Caching Optimization** — Geohash6 precision for better deduplication
5. **Enhanced UI** — Rich weather display in inspector, expanded facets
6. **Query Capabilities** — Temperature range filters, precipitation filters
7. **Rate Limiting** — Sustainable approach for large libraries
8. **Dependency Clarification** — M25, M27, M30 should reference this addendum (not the reverse)

---

## Integration Notes (M31/M32)

- This addendum is **future iteration guidance**; do not change implemented M8 behavior retroactively.
- M31 settings control weather enablement, cache TTL, and unit preferences.
- M32 UI patterns apply to any new weather facets or inspector upgrades (stable `data-testid`).

---

## Issue 8.1 — Tri-API Architecture

### The Three Open-Meteo APIs

| API | Host | Coverage | Resolution | Update Delay | Variables |
|-----|------|----------|------------|--------------|-----------|
| **Forecast** | `api.open-meteo.com` | Last 92 days via `past_days` | 1-25 km | Real-time | Full set |
| **Historical Forecast** | `historical-forecast-api.open-meteo.com` | 2021/2022 to present | 1-25 km | Daily | Full set |
| **Archive** | `archive-api.open-meteo.com` | 1940 to present | 9-25 km | 2-5 days | ERA5 set |

### Why Three APIs?

**Forecast API (recent photos ≤60 days):**
- Highest resolution local models (up to 1km in Europe)
- Most complete variable set including `visibility`, `precipitation_probability`
- Updated hourly — yesterday's weather available immediately
- Uses `past_days` parameter to look back up to 92 days

**Historical Forecast API (2022+ photos older than 60 days):**
- Same variable set as Forecast API
- Archived high-resolution forecast data
- Covers gap between Forecast API's 92-day limit and Archive API
- Available from 2021-2022 depending on model

**Archive API (pre-2022 photos):**
- ERA5 reanalysis data — consistent methodology back to 1940
- Lower resolution but complete global coverage
- Different variable set (no visibility, different soil depths)
- Best for climate consistency across decades

### Data Availability Timeline

```
                              Archive API           Historical Forecast      Forecast API
                                  ↓                       ↓                       ↓
    ←─────────────────────────────|───────────────────────|───────────────────────|─────→
    1940                        2022                 60 days ago              today
    
    [════════════════════════════════════════════════════════════════════════]
                        Archive: 1940 to (today - 5 days)
    
                                  [═══════════════════════════════════════════]
                                  Historical Forecast: 2022 to (today - 1 day)
    
                                                          [═══════════════════]
                                                          Forecast: last 92 days
    
    ROUTING STRATEGY (use highest-resolution available):
    • Photo ≤ 60 days old  → Forecast API (highest resolution, real-time)
    • Photo 60 days to 2022 → Historical Forecast API (high resolution)
    • Photo before 2022    → Archive API (ERA5 reanalysis)
```

### API Selection Threshold: Why 60 Days?

The Forecast API supports up to 92 `past_days`, but we use 60 days as the threshold because:

1. **Conservative margin** — Avoids edge cases at the 92-day boundary
2. **Typical import patterns** — Most "recent" imports are within 1-2 months
3. **Simpler date math** — Approximately 2 months, easier for users to understand
4. **Leaves headroom** — If API limits change, we have buffer

This threshold is configurable in settings (see Issue 8.6).

---

## Issue 8.2 — Variable Compatibility & Safe Sets

### Variable Availability Matrix

| Variable | Forecast | Historical Forecast | Archive (ERA5) | Notes |
|----------|:--------:|:------------------:|:--------------:|-------|
| `temperature_2m` | ✓ | ✓ | ✓ | Core |
| `apparent_temperature` | ✓ | ✓ | ✓ | Feels-like |
| `relative_humidity_2m` | ✓ | ✓ | ✓ | Core |
| `dew_point_2m` | ✓ | ✓ | ✓ | Humidity indicator |
| `precipitation` | ✓ | ✓ | ✓ | Total precip |
| `rain` | ✓ | ✓ | ✓ | Liquid only |
| `snowfall` | ✓ | ✓ | ✓ | Snow amount |
| `showers` | ✓ | ✓ | ✗ | Convective precip |
| `snow_depth` | ✓ | ✓ | ✓* | *ERA5-Land only |
| `weather_code` | ✓ | ✓ | ✓ | WMO condition |
| `cloud_cover` | ✓ | ✓ | ✓ | Total coverage |
| `cloud_cover_low` | ✓ | ✓ | ✓ | Low clouds |
| `cloud_cover_mid` | ✓ | ✓ | ✓ | Mid clouds |
| `cloud_cover_high` | ✓ | ✓ | ✓ | High clouds |
| `wind_speed_10m` | ✓ | ✓ | ✓ | Surface wind |
| `wind_direction_10m` | ✓ | ✓ | ✓ | Wind direction |
| `wind_gusts_10m` | ✓ | ✓ | ✓* | *Not in ERA5 base |
| `surface_pressure` | ✓ | ✓ | ✓ | Barometric |
| `pressure_msl` | ✓ | ✓ | ✓ | Sea-level pressure |
| `visibility` | ✓ | ✓ | ✗ | **Forecast-only** |
| `precipitation_probability` | ✓ | ✓ | ✗ | **Forecast-only** |
| `is_day` | ✓ | ✓ | ✓ | Daylight flag |
| `sunshine_duration` | ✓ | ✓ | ✓ | Sunshine seconds |
| `shortwave_radiation` | ✓ | ✓ | ✓ | Solar radiation |
| `uv_index` | ✓ | ✓ | ✗ | **Forecast-only** |

### Defined Variable Sets

**FORECAST_VARIABLES (Forecast & Historical Forecast APIs):**
```
temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,
precipitation,rain,showers,snowfall,snow_depth,weather_code,
cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,
wind_speed_10m,wind_direction_10m,wind_gusts_10m,
surface_pressure,pressure_msl,visibility,is_day,sunshine_duration,
shortwave_radiation
```
(23 variables)

**ARCHIVE_VARIABLES (Archive API with ERA5):**
```
temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,
precipitation,rain,snowfall,weather_code,
cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,
wind_speed_10m,wind_direction_10m,wind_gusts_10m,
surface_pressure,pressure_msl,is_day,sunshine_duration,
shortwave_radiation
```
(20 variables — missing: `visibility`, `showers`, `snow_depth`)

**UNIVERSAL_VARIABLES (Works on ALL APIs):**
```
temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,
precipitation,rain,snowfall,weather_code,
cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,
wind_speed_10m,wind_direction_10m,
surface_pressure,is_day,sunshine_duration,shortwave_radiation
```
(18 variables — safest fallback set)

### Variable Set Selection Logic

```
FUNCTION GetVariableSet(api_type, fallback_mode):
  IF fallback_mode:
    RETURN UNIVERSAL_VARIABLES
  
  IF api_type IN ["forecast", "historical_forecast"]:
    RETURN FORECAST_VARIABLES
  ELSE:  # archive
    RETURN ARCHIVE_VARIABLES
```

---

## Issue 8.3 — API Routing Algorithm

### Primary Routing Algorithm

```
ALGORITHM: RouteWeatherRequest(photo_date)

INPUT: photo_date (datetime when photo was taken)
OUTPUT: { api_type, endpoint, parameters }

CONSTANTS:
  FORECAST_THRESHOLD = 60  # days
  HISTORICAL_FORECAST_START = 2022-01-01

1. today = current_date()
2. days_ago = (today - photo_date.date()).days

3. # Validate date
   IF days_ago < 0:
     # Future date — no weather data possible
     RETURN { api_type: null, error: "future_date" }

4. # Route based on age
   IF days_ago <= FORECAST_THRESHOLD:
     # Recent photo — use Forecast API with past_days
     RETURN {
       api_type: "forecast",
       endpoint: "https://api.open-meteo.com/v1/forecast",
       parameters: {
         latitude: <lat>,
         longitude: <lon>,
         timezone: "UTC",
         past_days: days_ago + 1,
         forecast_days: 0,
         hourly: FORECAST_VARIABLES
       }
     }

5. IF photo_date >= HISTORICAL_FORECAST_START:
     # Recent-ish photo — use Historical Forecast API
     RETURN {
       api_type: "historical_forecast",
       endpoint: "https://historical-forecast-api.open-meteo.com/v1/forecast",
       parameters: {
         latitude: <lat>,
         longitude: <lon>,
         timezone: "UTC",
         start_date: photo_date.date(),
         end_date: photo_date.date(),
         hourly: FORECAST_VARIABLES
       }
     }

6. # Old photo — use Archive API
   RETURN {
     api_type: "archive",
     endpoint: "https://archive-api.open-meteo.com/v1/archive",
     parameters: {
       latitude: <lat>,
       longitude: <lon>,
       timezone: "UTC",
       start_date: photo_date.date(),
       end_date: photo_date.date(),
       models: SelectArchiveModel(photo_date),
       hourly: ARCHIVE_VARIABLES
     }
   }
```

### Archive Model Selection

```
ALGORITHM: SelectArchiveModel(photo_date)

INPUT: photo_date (datetime)
OUTPUT: model name string

1. year = photo_date.year

2. # IFS has highest resolution, available from 2017
   IF year >= 2017:
     RETURN "ecmwf_ifs"

3. # ERA5-seamless merges ERA5 + ERA5-Land
   IF year >= 1950:
     RETURN "era5_seamless"

4. # Pre-1950: only base ERA5 available
   RETURN "era5"
```

### Fallback Strategy

```
ALGORITHM: FetchWeatherWithFallback(lat, lon, photo_date, cache_key)

INPUT:
  lat, lon: coordinates
  photo_date: datetime
  cache_key: for caching result

OUTPUT: weather_data or null

1. # Check cache first
   cached = GetFromCache(cache_key)
   IF cached IS NOT NULL:
     RETURN cached

2. # Route to appropriate API
   route = RouteWeatherRequest(photo_date)
   IF route.error:
     RETURN null

3. # Primary attempt
   TRY:
     response = HttpGet(route.endpoint, route.parameters)
     IF response.status == 200:
       weather = ParseWeatherResponse(response, photo_date)
       StoreInCache(cache_key, weather)
       RETURN weather

4. # Handle errors with fallback chain
   CATCH error:
     RETURN HandleWeatherError(error, route, lat, lon, photo_date, cache_key)


ALGORITHM: HandleWeatherError(error, original_route, lat, lon, photo_date, cache_key)

1. # Rate limited — queue for retry
   IF error.status == 429:
     QueueForRetry(lat, lon, photo_date, delay: EXPONENTIAL_BACKOFF)
     RETURN null

2. # Variable not available — retry with safe set
   IF error.status == 400 AND "invalid" in error.message:
     route = original_route
     route.parameters.hourly = UNIVERSAL_VARIABLES
     TRY:
       response = HttpGet(route.endpoint, route.parameters)
       IF response.status == 200:
         weather = ParseWeatherResponse(response, photo_date)
         weather.partial = true  # Mark as reduced variable set
         StoreInCache(cache_key, weather)
         RETURN weather
     CATCH:
       pass  # Continue to next fallback

3. # Forecast API failed — try Historical Forecast
   IF original_route.api_type == "forecast":
     TRY:
       route = {
         api_type: "historical_forecast",
         endpoint: "https://historical-forecast-api.open-meteo.com/v1/forecast",
         parameters: {
           ...original_route.parameters,
           start_date: photo_date.date(),
           end_date: photo_date.date()
         }
       }
       # Remove past_days/forecast_days, use start_date/end_date
       DELETE route.parameters.past_days
       DELETE route.parameters.forecast_days
       
       response = HttpGet(route.endpoint, route.parameters)
       IF response.status == 200:
         weather = ParseWeatherResponse(response, photo_date)
         StoreInCache(cache_key, weather)
         RETURN weather
     CATCH:
       pass  # Continue to next fallback

4. # Historical Forecast failed — try Archive
   IF original_route.api_type IN ["forecast", "historical_forecast"]:
     TRY:
       route = {
         api_type: "archive",
         endpoint: "https://archive-api.open-meteo.com/v1/archive",
         parameters: {
           latitude: lat,
           longitude: lon,
           timezone: "UTC",
           start_date: photo_date.date(),
           end_date: photo_date.date(),
           models: SelectArchiveModel(photo_date),
           hourly: ARCHIVE_VARIABLES
         }
       }
       response = HttpGet(route.endpoint, route.parameters)
       IF response.status == 200:
         weather = ParseWeatherResponse(response, photo_date)
         weather.fallback = "archive"  # Mark fallback used
         StoreInCache(cache_key, weather)
         RETURN weather
     CATCH:
       pass

5. # All attempts failed
   LogWarning("Weather fetch failed", lat, lon, photo_date, error)
   RETURN null
```

### Performant Batch Processing

For large imports, we need to efficiently batch weather requests:

```
ALGORITHM: BatchWeatherEnrichment(photos)

INPUT: photos (list of {id, lat, lon, date})
OUTPUT: enriched photos

CONSTANTS:
  REQUESTS_PER_SECOND = 2
  BATCH_SIZE = 100

1. # Group photos by cache key to deduplicate
   cache_groups = GroupByWeatherCacheKey(photos)
   # cache_key = geohash6(lat,lon) + "|" + date

2. # Filter out already-cached locations
   uncached = []
   FOR group IN cache_groups:
     IF NOT IsCached(group.cache_key):
       uncached.append(group)

3. # Sort by API type for efficient routing
   forecast_batch = []
   historical_batch = []
   archive_batch = []
   
   FOR group IN uncached:
     route = RouteWeatherRequest(group.date)
     IF route.api_type == "forecast":
       forecast_batch.append(group)
     ELSE IF route.api_type == "historical_forecast":
       historical_batch.append(group)
     ELSE:
       archive_batch.append(group)

4. # Process each batch with rate limiting
   # Process forecast first (most likely to succeed)
   ProcessBatchWithRateLimit(forecast_batch, REQUESTS_PER_SECOND)
   ProcessBatchWithRateLimit(historical_batch, REQUESTS_PER_SECOND)
   ProcessBatchWithRateLimit(archive_batch, REQUESTS_PER_SECOND)

5. # Apply cached weather to photos
   FOR photo IN photos:
     cache_key = GetWeatherCacheKey(photo.lat, photo.lon, photo.date)
     weather = GetFromCache(cache_key)
     IF weather:
       photo.weather = SelectHourlyWeather(weather, photo.date)

   RETURN photos


FUNCTION GroupByWeatherCacheKey(photos):
  # Group photos that share the same weather lookup
  groups = {}
  FOR photo IN photos:
    key = GetWeatherCacheKey(photo.lat, photo.lon, photo.date)
    IF key NOT IN groups:
      groups[key] = {
        cache_key: key,
        lat: GeohashCenter(key).lat,
        lon: GeohashCenter(key).lon,
        date: photo.date.date(),
        photos: []
      }
    groups[key].photos.append(photo)
  RETURN groups.values()


FUNCTION GetWeatherCacheKey(lat, lon, date):
  geohash = Geohash.encode(lat, lon, precision=6)  # ~1.2km cells
  date_str = date.strftime("%Y-%m-%d")
  RETURN f"{geohash}|{date_str}"
```

---

## Issue 8.4 — Caching Strategy

### Cache Key Design: Geohash6

The original spec uses geohash precision 7 (~150m). This is significantly finer than model resolution.

| Precision | Cell Size | vs ERA5-Land (~9km) | Cache Efficiency |
|-----------|-----------|---------------------|------------------|
| Geohash 7 | ~150m | 60× finer | Poor (many duplicates) |
| Geohash 6 | ~1.2km | 7× finer | Good |
| Geohash 5 | ~5km | ~2× finer | Acceptable |

**Decision:** Use geohash6 for cache keys.

```
cache_key = f"{geohash.encode(lat, lon, 6)}|{date_YYYY-MM-DD}"
```

### Cache Schema

```sql
CREATE TABLE weather_cache (
    -- Primary key
    cache_key TEXT PRIMARY KEY,  -- "u4pruyd|2023-07-15"
    
    -- Location
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    geohash TEXT NOT NULL,
    date TEXT NOT NULL,
    
    -- Core weather (extracted for fast queries)
    temperature_c REAL,
    apparent_temperature_c REAL,
    humidity_percent REAL,
    dew_point_c REAL,
    precipitation_mm REAL,
    rain_mm REAL,
    snowfall_cm REAL,
    cloud_cover_percent REAL,
    wind_speed_kmh REAL,
    wind_direction_deg REAL,
    wind_gusts_kmh REAL,
    pressure_hpa REAL,
    visibility_m REAL,              -- NULL for archive data
    weather_code INTEGER,
    is_day INTEGER,
    
    -- Derived fields
    condition TEXT,                  -- Clear | Cloudy | Rain | Snow | Fog | Thunder
    condition_detail TEXT,           -- Light Rain | Heavy Snow | etc
    comfort_level TEXT,              -- Hot | Warm | Comfortable | Cool | Cold | Freezing
    
    -- Full hourly data for precise hour selection
    hourly_json TEXT,                -- Complete 24-hour arrays
    
    -- Metadata
    api_type TEXT,                   -- forecast | historical_forecast | archive
    model TEXT,                      -- era5_seamless | ecmwf_ifs | etc
    variable_set TEXT,               -- full | archive | universal
    fetched_at TEXT DEFAULT (datetime('now')),
    schema_version INTEGER DEFAULT 1
);

CREATE INDEX idx_weather_date ON weather_cache(date);
CREATE INDEX idx_weather_geohash ON weather_cache(geohash);
CREATE INDEX idx_weather_condition ON weather_cache(condition);
CREATE INDEX idx_weather_temp ON weather_cache(temperature_c);
CREATE INDEX idx_weather_comfort ON weather_cache(comfort_level);
```

### Hour Selection Algorithm

```
ALGORITHM: SelectHourlyWeather(cache_entry, photo_datetime)

INPUT:
  cache_entry: cached weather data with hourly arrays
  photo_datetime: exact datetime of photo

OUTPUT: weather values for the closest hour

1. hourly = JSON.parse(cache_entry.hourly_json)
2. photo_hour = photo_datetime.hour
3. photo_minute = photo_datetime.minute

4. # Select closest hour
   IF photo_minute >= 30:
     target_hour = (photo_hour + 1) % 24
   ELSE:
     target_hour = photo_hour

5. # Extract values at target hour
   RETURN {
     temperature_c: hourly.temperature_2m[target_hour],
     apparent_temperature_c: hourly.apparent_temperature[target_hour],
     humidity_percent: hourly.relative_humidity_2m[target_hour],
     # ... etc for all variables
   }
```

---

## Issue 8.5 — Derived Fields & Condition Mapping

### Weather Code to Condition Mapping

```
FUNCTION MapWeatherCode(wmo_code):
  # WMO Weather interpretation codes
  MATCH wmo_code:
    0:       RETURN { condition: "Clear", detail: "Clear Sky" }
    1:       RETURN { condition: "Clear", detail: "Mainly Clear" }
    2:       RETURN { condition: "Cloudy", detail: "Partly Cloudy" }
    3:       RETURN { condition: "Cloudy", detail: "Overcast" }
    45, 48:  RETURN { condition: "Fog", detail: "Fog" }
    51:      RETURN { condition: "Rain", detail: "Light Drizzle" }
    53:      RETURN { condition: "Rain", detail: "Drizzle" }
    55:      RETURN { condition: "Rain", detail: "Dense Drizzle" }
    56, 57:  RETURN { condition: "Rain", detail: "Freezing Drizzle" }
    61:      RETURN { condition: "Rain", detail: "Light Rain" }
    63:      RETURN { condition: "Rain", detail: "Moderate Rain" }
    65:      RETURN { condition: "Rain", detail: "Heavy Rain" }
    66, 67:  RETURN { condition: "Rain", detail: "Freezing Rain" }
    71:      RETURN { condition: "Snow", detail: "Light Snow" }
    73:      RETURN { condition: "Snow", detail: "Moderate Snow" }
    75:      RETURN { condition: "Snow", detail: "Heavy Snow" }
    77:      RETURN { condition: "Snow", detail: "Snow Grains" }
    80:      RETURN { condition: "Rain", detail: "Light Showers" }
    81:      RETURN { condition: "Rain", detail: "Showers" }
    82:      RETURN { condition: "Rain", detail: "Violent Showers" }
    85:      RETURN { condition: "Snow", detail: "Light Snow Showers" }
    86:      RETURN { condition: "Snow", detail: "Heavy Snow Showers" }
    95:      RETURN { condition: "Thunder", detail: "Thunderstorm" }
    96, 99:  RETURN { condition: "Thunder", detail: "Thunderstorm with Hail" }
    DEFAULT: RETURN { condition: "Unknown", detail: "Unknown" }
```

### Comfort Level Calculation

```
FUNCTION CalculateComfortLevel(apparent_temp_c):
  # Based on apparent (feels-like) temperature
  IF apparent_temp_c >= 35:     RETURN "Hot"        # 🥵
  IF apparent_temp_c >= 25:     RETURN "Warm"       # ☀️
  IF apparent_temp_c >= 15:     RETURN "Comfortable" # 😊
  IF apparent_temp_c >= 5:      RETURN "Cool"       # 🧥
  IF apparent_temp_c >= -5:     RETURN "Cold"       # ❄️
  RETURN "Freezing"                                 # 🥶
```

---

## Issue 8.6 — Configuration & Settings

### Weather Settings Schema

```typescript
interface WeatherSettings {
  // API routing
  forecastThresholdDays: number;      // Default: 60
  historicalForecastStart: string;    // Default: "2022-01-01"
  
  // Units
  temperatureUnit: 'celsius' | 'fahrenheit';
  windSpeedUnit: 'kmh' | 'ms' | 'mph' | 'knots';
  precipitationUnit: 'mm' | 'inch';
  
  // Rate limiting
  requestsPerSecond: number;          // Default: 2
  maxDailyRequests: number;           // Default: 5000
  
  // Feature toggles
  enableWeatherEnrichment: boolean;   // Default: true
  enableWeatherFacets: boolean;       // Default: true
}
```

### Settings UI

```
┌─ Weather Settings ─────────────────────────────────────┐
│                                                        │
│ ☑ Enable weather enrichment                           │
│                                                        │
│ Units                                                  │
│ ┌──────────────────────────────────────────────────┐  │
│ │ Temperature: [Celsius ▼]  Wind: [km/h ▼]        │  │
│ │ Precipitation: [mm ▼]                            │  │
│ └──────────────────────────────────────────────────┘  │
│                                                        │
│ API Configuration                                      │
│ ┌──────────────────────────────────────────────────┐  │
│ │ Recent photo threshold: [60] days               │  │
│ │ Rate limit: [2] requests/second                  │  │
│ └──────────────────────────────────────────────────┘  │
│                                                        │
│ Cache Status                                           │
│ ┌──────────────────────────────────────────────────┐  │
│ │ Cached locations: 12,847                         │  │
│ │ Cache size: 45.2 MB                              │  │
│ │ [Clear Cache] [Export] [Import]                  │  │
│ └──────────────────────────────────────────────────┘  │
│                                                        │
└────────────────────────────────────────────────────────┘
```

---

## Issue 8.7 — Enhanced UI

### Inspector Weather Panel

**Compact View (default):**
```
┌─ 🌤️ Weather ──────────────────────────────────────────┐
│ 22°C (feels 24°C) • Partly Cloudy                     │
│ 💧 45% humidity • 💨 12 km/h NW                       │
│                                        [Show more ▼] │
└────────────────────────────────────────────────────────┘
```

**Expanded View:**
```
┌─ 🌤️ Weather ──────────────────────────────────────────┐
│                                                        │
│ Temperature                                            │
│   Actual: 22°C                                         │
│   Feels like: 24°C                                     │
│   Comfort: 😊 Comfortable                              │
│                                                        │
│ Conditions                                             │
│   Weather: ⛅ Partly Cloudy                            │
│   Cloud cover: 45%                                     │
│   Visibility: 20 km                                    │
│                                                        │
│ Atmosphere                                             │
│   Humidity: 45%                                        │
│   Dew point: 10°C                                      │
│   Pressure: 1013 hPa                                   │
│                                                        │
│ Wind                                                   │
│   Speed: 12 km/h NW (315°)                            │
│   Gusts: 18 km/h                                      │
│                                                        │
│ Precipitation                                          │
│   Total: 0.0 mm                                        │
│   Rain: 0.0 mm                                         │
│   Snow: 0.0 cm                                         │
│                                                        │
│ ─────────────────────────────────────────────────────  │
│ 📡 Open-Meteo Historical Forecast • Hour: 14:00 UTC   │
│                                         [Show less ▲] │
└────────────────────────────────────────────────────────┘
```

**Archive Data (no visibility):**
```
┌─ 🌤️ Weather ──────────────────────────────────────────┐
│ 18°C (feels 17°C) • Overcast                          │
│ 💧 72% humidity • 💨 8 km/h W                         │
│ 📡 Open-Meteo ERA5 Archive           [Show more ▼]   │
└────────────────────────────────────────────────────────┘
```

### Weather Facets

Following M19 Dynamic Facets principles:

**Temperature Range:**
```
🌡️ Temperature
  🥵 Hot (≥30°C)           [  12]
  ☀️ Warm (20-29°C)        [ 847]
  😊 Comfortable (10-19°C) [2,341]
  🧥 Cool (0-9°C)          [ 523]
  ❄️ Cold (-10 to -1°C)    [  89]
  🥶 Freezing (<-10°C)     [   5]
```

**Weather Conditions:**
```
🌤️ Weather
  ☀️ Clear                 [1,892]
  ⛅ Cloudy                [1,456]
  🌧️ Rain                  [ 423]
  🌨️ Snow                  [  87]
  🌫️ Fog                   [  34]
  ⛈️ Thunder               [   9]
```

**Precipitation:**
```
💧 Precipitation
  ☀️ Dry (0 mm)            [3,412]
  🌧️ Light (<2.5 mm)       [ 234]
  🌧️ Moderate (2.5-7.5 mm) [  89]
  🌧️ Heavy (>7.5 mm)       [  23]
```

### Facet Hiding Rules

Per M19 dynamic facets:
- Hide facet group when no photos have weather data
- Hide individual options when count is 0
- Show counts that reflect current filter state
- Cascade with other active filters (location, date, etc.)

---

## Issue 8.8 — Query Model Extensions

### LibraryQuery Interface Extensions

```typescript
interface LibraryQuery {
  // ... existing fields ...
  
  // Weather filters
  hasWeather?: boolean;
  
  // Condition filters
  weatherConditions?: ('Clear' | 'Cloudy' | 'Rain' | 'Snow' | 'Fog' | 'Thunder')[];
  
  // Temperature filters
  weatherTempMin?: number;           // In user's preferred unit
  weatherTempMax?: number;
  weatherComfortLevels?: ('Hot' | 'Warm' | 'Comfortable' | 'Cool' | 'Cold' | 'Freezing')[];
  
  // Precipitation filters
  weatherPrecipitationMin?: number;  // mm
  weatherPrecipitationMax?: number;
  weatherHasRain?: boolean;
  weatherHasSnow?: boolean;
  
  // Cloud cover
  weatherCloudCoverMin?: number;     // 0-100%
  weatherCloudCoverMax?: number;
  
  // Time of day
  weatherIsDay?: boolean;
}
```

### Example Queries

| Query Description | Filter Parameters |
|------------------|-------------------|
| "Sunny summer days" | `weatherConditions: ['Clear'], weatherTempMin: 20, weatherTempMax: 35` |
| "Rainy photos in Paris" | `places: ['Paris'], weatherConditions: ['Rain']` |
| "Snowy winter memories" | `weatherHasSnow: true, weatherTempMax: 5` |
| "Comfortable outdoor photos" | `weatherComfortLevels: ['Comfortable'], weatherIsDay: true` |
| "Foggy mornings" | `weatherConditions: ['Fog']` |

---

## Issue 8.9 — Rate Limiting & Progress Reporting

### Rate Limit Strategy

```
CONSTANTS:
  BASE_REQUESTS_PER_SECOND = 2
  MAX_BURST = 10
  BACKOFF_MULTIPLIER = 2
  MAX_BACKOFF_SECONDS = 60
  DAILY_LIMIT = 5000

STATE:
  token_bucket = MAX_BURST
  last_refill = now()
  current_backoff = 0
  daily_count = 0

ALGORITHM: RateLimitedRequest(request)

1. # Check daily limit
   IF daily_count >= DAILY_LIMIT:
     RETURN { error: "daily_limit_exceeded" }

2. # Token bucket refill
   elapsed = (now() - last_refill).seconds
   tokens_to_add = elapsed * BASE_REQUESTS_PER_SECOND
   token_bucket = min(MAX_BURST, token_bucket + tokens_to_add)
   last_refill = now()

3. # Wait for token
   IF token_bucket < 1:
     wait_time = (1 - token_bucket) / BASE_REQUESTS_PER_SECOND
     sleep(wait_time)
     token_bucket = 0

4. # Apply backoff if in backoff state
   IF current_backoff > 0:
     sleep(current_backoff)

5. # Make request
   token_bucket -= 1
   daily_count += 1
   
   TRY:
     response = HttpRequest(request)
     IF response.status == 429:
       # Rate limited — increase backoff
       current_backoff = min(MAX_BACKOFF_SECONDS, 
                            max(1, current_backoff * BACKOFF_MULTIPLIER))
       RETURN RateLimitedRequest(request)  # Retry
     ELSE:
       # Success — reset backoff
       current_backoff = 0
       RETURN response
   CATCH error:
     RETURN { error: error.message }
```

### Progress Reporting

```
┌─ Weather Enrichment ───────────────────────────────────┐
│                                                        │
│ Progress: ████████████░░░░░░░░ 60%                    │
│                                                        │
│ Locations: 2,847 / 4,745                              │
│ API calls: 1,423 (cache hit rate: 52%)                │
│ Rate: ~2.0 req/s                                       │
│ ETA: ~12 minutes                                       │
│                                                        │
│ API Distribution:                                      │
│   Forecast:           423 (recent photos)              │
│   Historical Forecast: 1,892 (2022+ photos)            │
│   Archive:            532 (older photos)               │
│                                                        │
│ [Pause] [Cancel]                                       │
└────────────────────────────────────────────────────────┘
```

---

## Issue 8.10 — Acceptance Criteria

### API Routing (8.1)
- [ ] Photos ≤60 days old route to Forecast API
- [ ] Photos 61 days to 2022-01-01 route to Historical Forecast API
- [ ] Photos before 2022-01-01 route to Archive API
- [ ] `past_days` correctly calculated for Forecast API
- [ ] `start_date`/`end_date` correctly set for other APIs
- [ ] Threshold (60 days) is configurable in settings

### Variable Sets (8.2)
- [ ] FORECAST_VARIABLES used for Forecast and Historical Forecast APIs
- [ ] ARCHIVE_VARIABLES used for Archive API
- [ ] Fallback to UNIVERSAL_VARIABLES on variable errors
- [ ] `visibility` only present for Forecast/Historical Forecast data
- [ ] Missing variables gracefully handled (null, not error)

### Fallback Chain (8.3)
- [ ] Forecast → Historical Forecast → Archive fallback works
- [ ] Variable set reduction fallback works
- [ ] Rate limit (429) triggers exponential backoff
- [ ] All failures logged with context
- [ ] Fallback source tracked in cache metadata

### Caching (8.4)
- [ ] Geohash6 precision used for cache keys
- [ ] Cache schema includes all specified fields
- [ ] Hour selection algorithm selects closest hour
- [ ] Cache hit rate tracked and reported
- [ ] Cache can be cleared/exported/imported

### Derived Fields (8.5)
- [ ] Weather code correctly mapped to condition
- [ ] Comfort level calculated from apparent temperature
- [ ] All WMO codes handled (0-99)

### UI (8.7)
- [ ] Compact weather panel displays in inspector
- [ ] Expanded view shows all available metrics
- [ ] Archive data clearly indicated (no visibility)
- [ ] Data source attribution displayed
- [ ] Weather facets display and filter correctly

### Query Model (8.8)
- [ ] All weather query fields implemented
- [ ] Temperature filters respect unit settings
- [ ] Combined queries work (location + weather)
- [ ] Empty results handled gracefully

### Rate Limiting (8.9)
- [ ] Token bucket limits requests to ~2/sec
- [ ] Exponential backoff on 429 responses
- [ ] Daily limit enforced
- [ ] Progress accurately reported
- [ ] Pause/resume functionality works

---

## Issue 8.11 — Dependencies & Integration

### This Milestone Depends On

| Milestone | Dependency Type | Notes |
|-----------|-----------------|-------|
| M7 Places | Required | Provides coordinates from GPS; place context for land/sea |
| M6 Search/Facets | Required | Query model extension; facet infrastructure |
| M19 Dynamic Facets | Required | Facet hiding/cascading rules |
| M1 Import Flow | Required | Triggers weather enrichment after import |

### Future Milestones Must Reference This Addendum

| Milestone | Integration Point | Notes |
|-----------|------------------|-------|
| M25 Advanced Grid Navigation | Weather as scrubber dimension | Must support weather-based navigation |
| M27 Query API | Weather fields in API | Must include weather filter parameters |
| M30 Export Media | Weather tokens for templates | Must support `{weather.temperature}`, `{weather.condition}` etc |

**Note:** These are forward references. M25, M27, and M30 specifications should include weather integration based on this addendum, not the reverse.

---

## Issue 8.12 — E2E Test Scenarios

### Test Fixtures

**Recent Photo Fixture (Forecast API):**
```json
{
  "photo_date": "2026-01-15T14:30:00Z",
  "expected_api": "forecast",
  "expected_endpoint": "api.open-meteo.com",
  "mock_response": {
    "hourly": {
      "time": ["2026-01-15T00:00", "2026-01-15T01:00", ...],
      "temperature_2m": [2.1, 1.8, 1.5, ...],
      "visibility": [24000, 24000, 20000, ...]
    }
  }
}
```

**Historical Photo Fixture (Historical Forecast API):**
```json
{
  "photo_date": "2024-07-15T10:00:00Z",
  "expected_api": "historical_forecast",
  "expected_endpoint": "historical-forecast-api.open-meteo.com",
  "mock_response": { ... }
}
```

**Archive Photo Fixture (Archive API):**
```json
{
  "photo_date": "2018-08-20T16:00:00Z",
  "expected_api": "archive",
  "expected_endpoint": "archive-api.open-meteo.com",
  "expected_model": "ecmwf_ifs",
  "mock_response": {
    "hourly": {
      "time": [...],
      "temperature_2m": [28.5, 29.1, ...],
      "visibility": null  // Not available in archive
    }
  }
}
```

### Test Scenarios

| Scenario | Description |
|----------|-------------|
| `weather_recent_photo_uses_forecast` | Photo from yesterday routes to Forecast API |
| `weather_2024_photo_uses_historical` | Photo from 2024 routes to Historical Forecast API |
| `weather_2018_photo_uses_archive` | Photo from 2018 routes to Archive API |
| `weather_pre2017_uses_era5` | Photo from 2010 uses ERA5 model |
| `weather_fallback_on_error` | API error triggers fallback chain |
| `weather_visibility_null_for_archive` | Archive data has null visibility |
| `weather_cache_deduplication` | Nearby photos share cache entry |
| `weather_facet_filtering` | Temperature facet filters work |
| `weather_combined_query` | Location + weather query works |
| `weather_rate_limiting` | Batch import respects rate limits |

---

## Appendix A — Request Examples

### Forecast API Request (Recent Photo)

```bash
# Photo taken 5 days ago
curl -sG "https://api.open-meteo.com/v1/forecast" \
  --data-urlencode "latitude=59.91" \
  --data-urlencode "longitude=10.75" \
  --data-urlencode "timezone=UTC" \
  --data-urlencode "past_days=6" \
  --data-urlencode "forecast_days=0" \
  --data-urlencode "hourly=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,precipitation,rain,showers,snowfall,snow_depth,weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,pressure_msl,visibility,is_day,sunshine_duration,shortwave_radiation"
```

### Historical Forecast API Request

```bash
# Photo from July 2024
curl -sG "https://historical-forecast-api.open-meteo.com/v1/forecast" \
  --data-urlencode "latitude=48.86" \
  --data-urlencode "longitude=2.35" \
  --data-urlencode "timezone=UTC" \
  --data-urlencode "start_date=2024-07-15" \
  --data-urlencode "end_date=2024-07-15" \
  --data-urlencode "hourly=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,precipitation,rain,showers,snowfall,snow_depth,weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,pressure_msl,visibility,is_day,sunshine_duration,shortwave_radiation"
```

### Archive API Request

```bash
# Photo from 2018
curl -sG "https://archive-api.open-meteo.com/v1/archive" \
  --data-urlencode "latitude=40.71" \
  --data-urlencode "longitude=-74.01" \
  --data-urlencode "timezone=UTC" \
  --data-urlencode "start_date=2018-08-20" \
  --data-urlencode "end_date=2018-08-20" \
  --data-urlencode "models=ecmwf_ifs" \
  --data-urlencode "hourly=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,precipitation,rain,snowfall,weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,pressure_msl,is_day,sunshine_duration,shortwave_radiation"
```

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 2.0 | 2026-01-20 | Complete rewrite with tri-API architecture |
| 1.0 | 2026-01-19 | Initial addendum with API corrections |
