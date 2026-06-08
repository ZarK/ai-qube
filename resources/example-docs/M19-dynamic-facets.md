# Milestone 19 — Dynamic Facets

## Strategic Goal

Transform facets from **static, hardcoded filters** into **intelligent, context-aware drill-down tools** that always reflect the current view. Every facet should dynamically adapt to the filtered result set, showing only relevant options with accurate counts.

**Success looks like:** User browses a 2019 trip gallery → date facets show "June 2019" distribution (not "Today/This Week") → user selects "Paris" location → camera facet updates to show only cameras used in Paris → color facet hides completely (no color data for these photos) → weather facet shows "Sunny (23) | Cloudy (12)" based on actual weather in Paris photos.

---

## Spec Requirements (from spec.md)

| Requirement | Spec Section | Notes |
|-------------|--------------|-------|
| Every screen is a query view | §2.8 | Filters must reflect current query |
| Filter changes < 100ms perceived | §3.1 | Dynamic recalculation must be fast |
| Multiple layouts share query state | §2.8 | Facets work across Grid, Map, Timeline |
| Enrichment modules add searchable dimensions | §2.6 | Facets adapt to available metadata |

---

## The Problem with M6 Facets

### Issue 1: Hardcoded Date Presets

Current M6 implementation:
```sql
SELECT 
  SUM(CASE WHEN date(captured_at) = date('now') THEN 1 ELSE 0 END) as today,
  SUM(CASE WHEN captured_at >= date('now', '-7 days') THEN 1 ELSE 0 END) as week,
  SUM(CASE WHEN captured_at >= date('now', '-30 days') THEN 1 ELSE 0 END) as month
FROM virtual_media
```

**Problems:**
- Viewing a "Summer 2019 Trip" saved view shows "Today (0) | This Week (0) | This Month (0)"
- Date facets are useless for historical browsing
- No intelligent breakdown by actual date distribution

### Issue 2: Non-Cascading Facets

Current behavior:
1. User has 10,000 photos
2. User clicks Location facet → "Oslo (1,234) | Paris (567) | Tokyo (89)"
3. User selects "Oslo"
4. Camera facet **still shows** "iPhone (5,000) | Sony (2,000)"

**Expected behavior:**
- Camera facet should update to show only cameras used in Oslo
- "iPhone (800) | Sony A7 (234) | Nikon (200)"

### Issue 3: Irrelevant Facets Shown

Current behavior:
- Weather facet always visible, even when no photos have weather data
- People facet shown even when face detection wasn't run
- Color facet shown with "(0)" counts for all options

**Expected behavior:**
- Facets with zero total applicable items should hide
- Facets with single-value results should collapse to badge/chip

### Issue 4: Global vs. View-Scoped Counts

Current M6 computes facets against the **entire library**, then applies filters. This means:
- Counts don't represent what's actually in the current view
- Drill-down behavior feels disconnected from visible results

---

## M19 Solution: True Dynamic Facets

### Core Principle: Facets = Aggregation Over Current Result Set

Every facet query must:
1. Start from the **base query** (saved view, search, or default)
2. Apply **all active filters except the facet's own dimension**
3. Return values and counts from this **scoped result set**

### New Facet Computation Model

```typescript
interface DynamicFacetContext {
  // The base query defining the view
  baseQuery: LibraryQuery;
  
  // Currently active filters (may override baseQuery)
  activeFilters: LibraryQuery;
  
  // Which facet we're computing (excluded from filter application)
  excludeDimension: FacetDimension;
}

interface FacetResult {
  dimension: FacetDimension;
  available: boolean;           // Does this dimension have any data in context?
  totalInContext: number;       // Total items with this dimension populated
  values: FacetValue[];         // Available values with counts
  suggestedDisplay: 'chips' | 'dropdown' | 'range' | 'hidden';
}

interface FacetValue {
  value: string | number | DateRange;
  count: number;
  label: string;                // Human-readable label
  isSelected: boolean;          // Currently filtered on this value
}
```

---

## Task 19.1: Dynamic Date Facets

### What We're Building

Intelligent date facets that adapt to the actual date range in the current view.

### Algorithm: Adaptive Date Bucketing

Instead of "Today/Week/Month", compute buckets based on data distribution:

```typescript
interface DateFacetResult {
  range: {
    earliest: string;           // ISO date of oldest photo in view
    latest: string;             // ISO date of newest photo in view
  };
  
  // Smart buckets based on range span
  buckets: DateBucket[];
  
  // Granularity chosen automatically
  granularity: 'day' | 'week' | 'month' | 'quarter' | 'year';
}

interface DateBucket {
  label: string;                // "June 2019", "Q2 2019", "2019"
  dateFrom: string;
  dateTo: string;
  count: number;
}
```

### Bucketing Strategy

| Span of Data | Granularity | Example Buckets |
|--------------|-------------|-----------------|
| < 7 days | Day | "Mon Jun 3", "Tue Jun 4", "Wed Jun 5" |
| 7-30 days | Week | "Week 1", "Week 2", "Week 3" |
| 1-6 months | Week or Custom | "Jun 1-7", "Jun 8-14", "Jun 15-21" |
| 6-24 months | Month | "June 2019", "July 2019", "August 2019" |
| 2-5 years | Quarter | "Q1 2019", "Q2 2019", "Q3 2019" |
| > 5 years | Year | "2018", "2019", "2020", "2021" |

### SQL Implementation

```sql
-- Step 1: Determine date range of current view
WITH view_context AS (
  SELECT 
    MIN(captured_at) as earliest,
    MAX(captured_at) as latest,
    julianday(MAX(captured_at)) - julianday(MIN(captured_at)) as span_days
  FROM virtual_media
  WHERE {base_query_conditions}
    AND {active_filters_except_date}
)

-- Step 2: Generate appropriate buckets
SELECT 
  CASE 
    WHEN vc.span_days < 7 THEN strftime('%Y-%m-%d', vm.captured_at)
    WHEN vc.span_days < 60 THEN strftime('%Y-W%W', vm.captured_at)
    WHEN vc.span_days < 730 THEN strftime('%Y-%m', vm.captured_at)
    ELSE strftime('%Y', vm.captured_at)
  END as bucket,
  COUNT(*) as count
FROM virtual_media vm
CROSS JOIN view_context vc
WHERE {base_query_conditions}
  AND {active_filters_except_date}
GROUP BY bucket
ORDER BY bucket DESC
```

### UI: Date Range Selector + Distribution

```
┌─────────────────────────────────────────────────────────┐
│ 📅 Date                                     [Jun 2019 ▼] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ▁▂▅▇█▇▅▂▁▁▂▃▅▆▇█▇▅▃▂▁                                │
│  └──────────────────────────────────────────────────┘  │
│  Jun 1          Jun 15          Jun 30                 │
│                                                         │
│  Quick select:                                          │
│  [Jun 1-7 (45)] [Jun 8-14 (123)] [Jun 15-21 (89)] ...  │
│                                                         │
│  Or drag to select range                                │
└─────────────────────────────────────────────────────────┘
```

### Smart Presets (Context-Aware)

When viewing a saved view with a fixed date range, show:
- "First half" / "Second half" (of the view's range)
- Weekday/Weekend breakdown
- Peak activity days

When viewing full library:
- "Recent" = last 10% of photos by date
- "Peak activity months" = months with above-average photo counts

---

## Task 19.2: Cascading Facet Updates

### What We're Building

When one facet changes, all other facets must recalculate based on the new filtered set.

### Update Flow

```
User clicks "Paris" in Location facet
           │
           ▼
┌─────────────────────────────────────────────┐
│  1. Update activeFilters.placeNames = ["Paris"]    │
│  2. Re-query grid with new filter                  │
│  3. Trigger facet recalculation for ALL facets     │
│     except Location (which keeps its state)        │
└─────────────────────────────────────────────┴──────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Date facet recalculates:                         │
│    - Only photos in Paris                         │
│    - New buckets based on Paris trip dates        │
│                                                   │
│  Camera facet recalculates:                       │
│    - Only cameras used in Paris                   │
│    - Counts reflect Paris photos only             │
│                                                   │
│  Weather facet recalculates:                      │
│    - Weather conditions in Paris photos           │
│    - May show different distribution              │
│                                                   │
│  People facet recalculates:                       │
│    - People detected in Paris photos              │
│    - New set of faces visible                     │
└─────────────────────────────────────────────┘
```

### Implementation: Parallel Facet Queries

```typescript
async function computeDynamicFacets(
  baseQuery: LibraryQuery,
  activeFilters: LibraryQuery,
  enabledFacets: FacetDimension[]
): Promise<Map<FacetDimension, FacetResult>> {
  
  // Build base WHERE clause
  const baseWhere = buildWhereClause(baseQuery, activeFilters);
  
  // Compute each facet in parallel, excluding its own dimension
  const facetPromises = enabledFacets.map(async (dimension) => {
    const excludeWhere = buildWhereClause(baseQuery, activeFilters, { exclude: dimension });
    const result = await computeFacet(dimension, excludeWhere);
    return [dimension, result] as const;
  });
  
  const results = await Promise.all(facetPromises);
  return new Map(results);
}
```

### Debouncing & Batching

```typescript
// Avoid hammering DB on rapid filter changes
const debouncedFacetUpdate = useMemo(
  () => debounce(async (filters: LibraryQuery) => {
    const facets = await computeDynamicFacets(baseQuery, filters, enabledFacets);
    setFacetResults(facets);
  }, 150),
  [baseQuery, enabledFacets]
);

// Trigger on filter changes
useEffect(() => {
  debouncedFacetUpdate(activeFilters);
}, [activeFilters, debouncedFacetUpdate]);
```

---

## Task 19.3: Facet Visibility & Relevance

### What We're Building

Intelligent showing/hiding of facets based on available data.

### Visibility Rules

| Condition | Facet Behavior |
|-----------|----------------|
| No items have this dimension | **Hide** facet completely |
| < 5% of items have dimension | Show with **"Limited data"** indicator |
| All items have same value | **Collapse** to static badge |
| Single value, many items | Show as **info chip** (not filterable) |
| Normal distribution | Show as **full facet dropdown** |

### Implementation

```typescript
interface FacetVisibility {
  visible: boolean;
  reason: 'full' | 'limited' | 'collapsed' | 'hidden';
  coverage: number;             // 0-1, percentage of items with this dimension
  uniqueValues: number;
}

function determineFacetVisibility(
  facetResult: FacetResult,
  totalItemsInView: number
): FacetVisibility {
  const coverage = facetResult.totalInContext / totalItemsInView;
  const uniqueValues = facetResult.values.length;
  
  if (facetResult.totalInContext === 0) {
    return { visible: false, reason: 'hidden', coverage: 0, uniqueValues: 0 };
  }
  
  if (uniqueValues === 1) {
    return { visible: true, reason: 'collapsed', coverage, uniqueValues };
  }
  
  if (coverage < 0.05) {
    return { visible: true, reason: 'limited', coverage, uniqueValues };
  }
  
  return { visible: true, reason: 'full', coverage, uniqueValues };
}
```

### UI States

**Hidden facet** (0 items have data):
```
┌─────────────────────────────────────────────┐
│ [Date ▼] [Location ▼] [Camera ▼]           │
│                                             │
│ (Weather facet not shown - no weather data) │
└─────────────────────────────────────────────┘
```

**Collapsed facet** (all items have same value):
```
┌─────────────────────────────────────────────┐
│ [Date ▼] [Location ▼] 📷 iPhone 14 Pro      │
│                                             │
│ (Camera shown as badge - all photos same)   │
└─────────────────────────────────────────────┘
```

**Limited data indicator**:
```
┌─────────────────────────────────────────────┐
│ [Date ▼] [Location ▼] [Weather ▼ ⚠️]        │
│                                             │
│ ⚠️ = Only 12% of photos have weather data   │
└─────────────────────────────────────────────┘
```

---

## Task 19.4: Unified Facet Schema

### What We're Building

A single, extensible schema for all facet types that supports dynamic behavior.

### Facet Dimension Registry

```typescript
interface FacetDimensionConfig {
  id: string;                           // 'date', 'location', 'camera', etc.
  label: string;                        // Human-readable name
  icon: string;                         // Icon identifier
  
  // Database configuration
  dbColumn: string | string[];          // Column(s) to aggregate
  dbTable: 'virtual_media' | 'keyword' | 'face_cluster' | 'event';
  joinRequired?: JoinConfig;
  
  // Aggregation configuration
  aggregationType: 'distinct' | 'range' | 'bucket' | 'hierarchy';
  hierarchical: boolean;                // If true, render as tree-select
  maxValues: number;                    // Limit dropdown length
  sortBy: 'count' | 'value' | 'alpha';
  
  // Display configuration
  displayType: 'tree-select' | 'dropdown' | 'chips' | 'range-slider' | 'color-swatch';
  multiSelect: boolean;
  searchable: boolean;                  // Include search box in dropdown
  
  // Dependencies
  requiresEnrichment?: string[];        // e.g., ['weather', 'faces']
  dependsOn?: string[];                 // e.g., weather depends on location
}
```

### Built-in Facet Configurations

```typescript
const FACET_REGISTRY: FacetDimensionConfig[] = [
  {
    id: 'date',
    label: 'Date',
    icon: 'calendar',
    dbColumn: 'captured_at',
    dbTable: 'virtual_media',
    aggregationType: 'bucket',          // Dynamic bucketing
    hierarchical: true,                 // Year → Month → Week tree
    maxValues: 20,
    sortBy: 'value',
    displayType: 'tree-select',         // Hierarchical tree selector
    multiSelect: true,
    searchable: false,
  },
  {
    id: 'location',
    label: 'Location',
    icon: 'map-pin',
    dbColumn: ['place_country', 'place_region', 'place_city', 'place_locality'],
    dbTable: 'virtual_media',
    aggregationType: 'hierarchy',       // Country → Region → City
    hierarchical: true,                 // Enable tree-select
    maxValues: 50,
    sortBy: 'count',
    displayType: 'tree-select',         // Hierarchical tree selector
    multiSelect: true,
    searchable: true,
  },
  {
    id: 'camera',
    label: 'Camera',
    icon: 'camera',
    dbColumn: ['camera_make', 'camera_model'],
    dbTable: 'virtual_media',
    aggregationType: 'hierarchy',       // Make → Model
    hierarchical: true,                 // Enable tree-select
    maxValues: 30,
    sortBy: 'count',
    displayType: 'tree-select',         // Hierarchical tree selector
    multiSelect: true,
    searchable: true,
  },
  {
    id: 'weather',
    label: 'Weather',
    icon: 'cloud-sun',
    dbColumn: 'weather_condition',
    dbTable: 'virtual_media',
    aggregationType: 'distinct',
    hierarchical: false,                // Flat list
    maxValues: 10,
    sortBy: 'count',
    displayType: 'chips',
    multiSelect: true,
    searchable: false,
    requiresEnrichment: ['weather'],
  },
  {
    id: 'color',
    label: 'Color',
    icon: 'palette',
    dbColumn: 'dominant_color_category',
    dbTable: 'virtual_media',
    aggregationType: 'distinct',
    hierarchical: false,                // Flat list of colors
    maxValues: 12,
    sortBy: 'count',
    displayType: 'color-swatch',
    multiSelect: true,
    searchable: false,
    requiresEnrichment: ['color'],
  },
  {
    id: 'mediaType',
    label: 'Type',
    icon: 'film',
    dbColumn: 'media_type',
    dbTable: 'virtual_media',
    aggregationType: 'distinct',
    hierarchical: false,                // Just Image/Video
    maxValues: 2,
    sortBy: 'count',
    displayType: 'chips',
    multiSelect: true,
    searchable: false,
  },
  {
    id: 'people',
    label: 'People',
    icon: 'users',
    dbColumn: 'person_name',
    dbTable: 'face_cluster',
    joinRequired: {
      table: 'detected_face',
      on: 'detected_face.cluster_id = face_cluster.id',
      via: 'detected_face.virtual_media_id = virtual_media.id'
    },
    aggregationType: 'distinct',
    hierarchical: false,                // Flat list of people (could be grouped by family later)
    maxValues: 50,
    sortBy: 'count',
    displayType: 'dropdown',
    multiSelect: true,
    searchable: true,
    requiresEnrichment: ['faces'],
  },
  {
    id: 'keywords',
    label: 'Keywords',
    icon: 'tag',
    dbColumn: 'keyword',
    dbTable: 'keyword',
    joinRequired: {
      table: 'virtual_media_keyword',
      on: 'virtual_media_keyword.keyword_id = keyword.id',
      via: 'virtual_media_keyword.virtual_media_id = virtual_media.id'
    },
    aggregationType: 'distinct',
    hierarchical: false,                // Flat keyword list (could be categorized later)
    maxValues: 50,
    sortBy: 'count',
    displayType: 'dropdown',
    multiSelect: true,
    searchable: true,
    requiresEnrichment: ['keywords'],
  },
  {
    id: 'event',
    label: 'Event',
    icon: 'calendar-days',
    dbColumn: 'event_id',
    dbTable: 'virtual_media',
    aggregationType: 'hierarchy',       // Year → Event
    hierarchical: true,                 // Group events by year
    maxValues: 50,
    sortBy: 'value',                    // By date
    displayType: 'tree-select',
    multiSelect: true,
    searchable: true,
    requiresEnrichment: ['events'],
  },
];
```

### Facet Display Type Summary

| Display Type | Hierarchical | Use Case | Example Facets |
|--------------|--------------|----------|----------------|
| `tree-select` | Yes | Multi-level expandable tree | Date, Location, Camera, Event |
| `dropdown` | No | Flat searchable list | People, Keywords |
| `chips` | No | Small set of toggles | Weather, Media Type |
| `color-swatch` | No | Visual color picker | Color |
| `range-slider` | No | Continuous range | (future: file size, rating) |

---

## Task 19.5: Hierarchical Tree-Select Facets

### What We're Building

A **tree-select** UI pattern for hierarchical facets where users can:
- See the full hierarchy inline (expandable/collapsible)
- Select at any level (selecting parent = select all children)
- Multi-select across different branches and levels
- Quickly select all / none within a subtree

This applies to multiple facet types:
- **Location**: Country → Region → City → Locality
- **Date**: Year → Quarter/Month → Week → Day
- **Camera**: Make → Model
- **Events**: Year → Event
- **Keywords**: Category → Keyword (if categorized)

### Hierarchical Facet Data Model

```typescript
interface HierarchicalFacetNode {
  id: string;                       // Unique identifier
  value: string;                    // The actual value for filtering
  label: string;                    // Display label
  count: number;                    // Items matching this node
  level: number;                    // Depth in hierarchy (0 = root)
  parentId: string | null;          // Parent node ID
  children?: HierarchicalFacetNode[];
  
  // UI state
  expanded: boolean;
  selected: 'none' | 'some' | 'all'; // Tri-state for partial selection
  
  // Metadata (varies by facet type)
  metadata?: {
    // For dates
    dateFrom?: string;
    dateTo?: string;
    // For locations
    coordinates?: { lat: number; lon: number };
    // For colors
    hexCode?: string;
  };
}

interface HierarchicalFacetResult extends FacetResult {
  tree: HierarchicalFacetNode[];    // Root nodes
  maxDepth: number;                 // Deepest level in this result
  totalNodes: number;               // Total nodes across all levels
}
```

### Database Schema for Hierarchies

```sql
-- Location hierarchy (denormalized for performance)
ALTER TABLE virtual_media ADD COLUMN place_country TEXT;
ALTER TABLE virtual_media ADD COLUMN place_region TEXT;
ALTER TABLE virtual_media ADD COLUMN place_city TEXT;
ALTER TABLE virtual_media ADD COLUMN place_locality TEXT;

-- Indexes for each level
CREATE INDEX idx_vm_place_country ON virtual_media(place_country);
CREATE INDEX idx_vm_place_region ON virtual_media(place_country, place_region);
CREATE INDEX idx_vm_place_city ON virtual_media(place_country, place_region, place_city);

-- Composite for full hierarchy queries
CREATE INDEX idx_vm_place_full ON virtual_media(
  place_country, place_region, place_city, place_locality
);
```

### Hierarchical Tree Query (Location Example)

```sql
-- Build full tree in single query using recursive CTE
WITH RECURSIVE 
-- First, get all unique paths with counts
place_paths AS (
  SELECT 
    place_country,
    place_region,
    place_city,
    place_locality,
    COUNT(*) as count
  FROM virtual_media
  WHERE place_country IS NOT NULL
    AND {active_filters_except_location}
  GROUP BY place_country, place_region, place_city, place_locality
),
-- Aggregate at each level
country_level AS (
  SELECT 
    place_country as value,
    NULL as parent,
    0 as level,
    SUM(count) as count
  FROM place_paths
  GROUP BY place_country
),
region_level AS (
  SELECT 
    place_country || '>' || place_region as value,
    place_country as parent,
    1 as level,
    SUM(count) as count
  FROM place_paths
  WHERE place_region IS NOT NULL
  GROUP BY place_country, place_region
),
city_level AS (
  SELECT 
    place_country || '>' || place_region || '>' || place_city as value,
    place_country || '>' || place_region as parent,
    2 as level,
    SUM(count) as count
  FROM place_paths
  WHERE place_city IS NOT NULL
  GROUP BY place_country, place_region, place_city
)
-- Combine all levels
SELECT value, parent, level, count FROM country_level
UNION ALL
SELECT value, parent, level, count FROM region_level
UNION ALL
SELECT value, parent, level, count FROM city_level
ORDER BY level, count DESC;
```

### Date Hierarchy Query

```sql
-- Build date tree: Year → Month → Week/Day
WITH date_stats AS (
  SELECT 
    MIN(captured_at) as earliest,
    MAX(captured_at) as latest,
    julianday(MAX(captured_at)) - julianday(MIN(captured_at)) as span_days
  FROM virtual_media
  WHERE {active_filters_except_date}
),
-- Year level
year_level AS (
  SELECT 
    strftime('%Y', captured_at) as value,
    NULL as parent,
    0 as level,
    strftime('%Y', captured_at) as label,
    MIN(captured_at) as date_from,
    MAX(captured_at) as date_to,
    COUNT(*) as count
  FROM virtual_media
  WHERE captured_at IS NOT NULL
    AND {active_filters_except_date}
  GROUP BY strftime('%Y', captured_at)
),
-- Month level
month_level AS (
  SELECT 
    strftime('%Y-%m', captured_at) as value,
    strftime('%Y', captured_at) as parent,
    1 as level,
    strftime('%B %Y', captured_at) as label,  -- "June 2019"
    MIN(captured_at) as date_from,
    MAX(captured_at) as date_to,
    COUNT(*) as count
  FROM virtual_media
  WHERE captured_at IS NOT NULL
    AND {active_filters_except_date}
  GROUP BY strftime('%Y-%m', captured_at)
),
-- Week level (only if span < 6 months for performance)
week_level AS (
  SELECT 
    strftime('%Y-W%W', captured_at) as value,
    strftime('%Y-%m', captured_at) as parent,
    2 as level,
    'Week ' || strftime('%W', captured_at) as label,
    MIN(captured_at) as date_from,
    MAX(captured_at) as date_to,
    COUNT(*) as count
  FROM virtual_media, date_stats
  WHERE captured_at IS NOT NULL
    AND date_stats.span_days < 180
    AND {active_filters_except_date}
  GROUP BY strftime('%Y-W%W', captured_at)
)
SELECT * FROM year_level
UNION ALL SELECT * FROM month_level
UNION ALL SELECT * FROM week_level
ORDER BY level, value DESC;
```

### UI: Tree-Select Component

```
┌─────────────────────────────────────────────────────────┐
│ 📍 Location                           [Select All] [×]  │
├─────────────────────────────────────────────────────────┤
│ 🔍 Search locations...                                  │
├─────────────────────────────────────────────────────────┤
│ ▼ ☑ Norway                                       (150)  │
│   │ ▼ ☑ Oslo                                      (80)  │
│   │   │  ☑ Grünerløkka                            (30)  │
│   │   │  ☑ Frogner                                (50)  │
│   │ ▶ ☐ Bergen                                    (70)  │
│   │                                                     │
│ ▶ ☐ France                                       (100)  │
│ ▶ ☐ Japan                                         (50)  │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Selected: Norway (150 photos)              [Clear All]  │
└─────────────────────────────────────────────────────────┘

Legend:
▼ = expanded, ▶ = collapsed
☑ = selected, ☐ = not selected, ☒ = partially selected (some children)
```

### Date Hierarchy UI

```
┌─────────────────────────────────────────────────────────┐
│ 📅 Date                               [Select All] [×]  │
├─────────────────────────────────────────────────────────┤
│ ▼ ☒ 2019                                         (500)  │
│   │ ▶ ☐ January                                   (45)  │
│   │ ▶ ☐ February                                  (38)  │
│   │ ▼ ☑ June                                     (150)  │
│   │   │  ☑ Week 23 (Jun 3-9)                      (45)  │
│   │   │  ☑ Week 24 (Jun 10-16)                    (62)  │
│   │   │  ☑ Week 25 (Jun 17-23)                    (43)  │
│   │ ▶ ☐ July                                      (89)  │
│   │ ...                                                 │
│ ▶ ☐ 2020                                         (320)  │
│ ▶ ☐ 2021                                         (180)  │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Selected: June 2019 (150 photos)           [Clear All]  │
└─────────────────────────────────────────────────────────┘
```

### Camera Hierarchy UI

```
┌─────────────────────────────────────────────────────────┐
│ 📷 Camera                             [Select All] [×]  │
├─────────────────────────────────────────────────────────┤
│ ▼ ☑ Apple                                        (800)  │
│   │  ☑ iPhone 14 Pro                             (500)  │
│   │  ☑ iPhone 12                                 (300)  │
│ ▼ ☐ Sony                                         (200)  │
│   │  ☐ A7 III                                    (150)  │
│   │  ☐ A6400                                      (50)  │
│ ▶ ☐ Canon                                        (100)  │
└─────────────────────────────────────────────────────────┘
```

### Selection Logic

```typescript
interface TreeSelectionState {
  // Selected node IDs at each level
  // Parent selection implies all children selected
  selectedIds: Set<string>;
  
  // Explicitly deselected (when parent selected but child excluded)
  excludedIds: Set<string>;
}

function getNodeSelectionState(
  node: HierarchicalFacetNode,
  selection: TreeSelectionState
): 'none' | 'some' | 'all' {
  const isSelected = selection.selectedIds.has(node.id);
  const isExcluded = selection.excludedIds.has(node.id);
  
  // Check if any ancestor is selected
  const ancestorSelected = isAncestorSelected(node, selection);
  
  if (isExcluded) return 'none';
  if (isSelected) return 'all';
  if (ancestorSelected && !isExcluded) return 'all';
  
  // Check children for partial selection
  if (node.children?.length) {
    const childStates = node.children.map(c => 
      getNodeSelectionState(c, selection)
    );
    const allSelected = childStates.every(s => s === 'all');
    const someSelected = childStates.some(s => s !== 'none');
    
    if (allSelected) return 'all';
    if (someSelected) return 'some';
  }
  
  return 'none';
}

function toggleNode(
  node: HierarchicalFacetNode,
  selection: TreeSelectionState,
  currentState: 'none' | 'some' | 'all'
): TreeSelectionState {
  const newSelection = { ...selection };
  
  if (currentState === 'none') {
    // Select this node and all descendants
    newSelection.selectedIds.add(node.id);
    newSelection.excludedIds.delete(node.id);
    // Remove any descendant-specific selections (parent covers them)
    removeDescendantsFromSelection(node, newSelection);
  } else {
    // Deselect this node and all descendants
    newSelection.selectedIds.delete(node.id);
    newSelection.excludedIds.add(node.id);
    // If parent was selected, we need to exclude this branch
    if (isAncestorSelected(node, selection)) {
      newSelection.excludedIds.add(node.id);
    }
  }
  
  return newSelection;
}
```

### Query Generation from Tree Selection

```typescript
function buildFilterFromTreeSelection(
  facetId: string,
  selection: TreeSelectionState,
  tree: HierarchicalFacetNode[]
): Partial<LibraryQuery> {
  // Collect all effectively selected leaf values
  const selectedValues: string[] = [];
  
  function collectSelected(nodes: HierarchicalFacetNode[], parentSelected: boolean) {
    for (const node of nodes) {
      const isSelected = selection.selectedIds.has(node.id) || parentSelected;
      const isExcluded = selection.excludedIds.has(node.id);
      
      if (isExcluded) continue;
      
      if (isSelected) {
        if (!node.children?.length) {
          // Leaf node - add its value
          selectedValues.push(node.value);
        } else {
          // Non-leaf - recurse
          collectSelected(node.children, true);
        }
      } else if (node.children?.length) {
        collectSelected(node.children, false);
      }
    }
  }
  
  collectSelected(tree, false);
  
  // Build appropriate filter based on facet type
  switch (facetId) {
    case 'location':
      return { placeNames: selectedValues };
    case 'date':
      // Convert to date ranges
      return buildDateRangeFilter(selectedValues);
    case 'camera':
      return { cameraModels: selectedValues };
    default:
      return {};
  }
}
```

### Expand/Collapse State Management

```typescript
interface TreeExpandState {
  // Set of expanded node IDs
  expandedIds: Set<string>;
  
  // Auto-expand behavior
  autoExpandSelected: boolean;    // Expand path to selected nodes
  autoExpandOnSearch: boolean;    // Expand matching nodes when searching
  defaultExpandLevel: number;     // Initially expand to this depth (0 = all collapsed)
}

function toggleExpand(
  nodeId: string, 
  state: TreeExpandState
): TreeExpandState {
  const newExpanded = new Set(state.expandedIds);
  if (newExpanded.has(nodeId)) {
    newExpanded.delete(nodeId);
  } else {
    newExpanded.add(nodeId);
  }
  return { ...state, expandedIds: newExpanded };
}

function expandToNode(
  nodeId: string,
  tree: HierarchicalFacetNode[],
  state: TreeExpandState
): TreeExpandState {
  // Find path from root to node and expand all ancestors
  const path = findPathToNode(nodeId, tree);
  const newExpanded = new Set(state.expandedIds);
  path.forEach(id => newExpanded.add(id));
  return { ...state, expandedIds: newExpanded };
}

function expandAll(state: TreeExpandState): TreeExpandState {
  // Handled by setting a flag, actual expansion computed in render
  return { ...state, expandedIds: new Set(['__ALL__']) };
}

function collapseAll(state: TreeExpandState): TreeExpandState {
  return { ...state, expandedIds: new Set() };
}
```

### Search Within Hierarchical Facet

```typescript
function filterTree(
  tree: HierarchicalFacetNode[],
  searchTerm: string
): { 
  filteredTree: HierarchicalFacetNode[]; 
  matchingIds: Set<string>;
  expandIds: Set<string>;  // Nodes to expand to show matches
} {
  const matchingIds = new Set<string>();
  const expandIds = new Set<string>();
  const term = searchTerm.toLowerCase();
  
  function filterNode(node: HierarchicalFacetNode): HierarchicalFacetNode | null {
    const labelMatches = node.label.toLowerCase().includes(term);
    
    // Recursively filter children
    const filteredChildren = node.children
      ?.map(filterNode)
      .filter((n): n is HierarchicalFacetNode => n !== null);
    
    const hasMatchingChildren = filteredChildren && filteredChildren.length > 0;
    
    if (labelMatches || hasMatchingChildren) {
      if (labelMatches) matchingIds.add(node.id);
      if (hasMatchingChildren) expandIds.add(node.id);
      
      return {
        ...node,
        children: filteredChildren,
      };
    }
    
    return null;
  }
  
  const filteredTree = tree
    .map(filterNode)
    .filter((n): n is HierarchicalFacetNode => n !== null);
  
  return { filteredTree, matchingIds, expandIds };
}
```

---

## Task 19.6: Backend Facet Aggregation Service

### What We're Building

Optimized backend service for computing all facets efficiently.

### Service Interface

```csharp
public interface IFacetAggregationService
{
    Task<FacetResultSet> ComputeFacetsAsync(
        LibraryQuery baseQuery,
        LibraryQuery activeFilters,
        IEnumerable<string> requestedFacets,
        CancellationToken ct = default
    );
}

public record FacetResultSet(
    Dictionary<string, FacetResult> Facets,
    int TotalItemsInView,
    TimeSpan ComputationTime
);

public record FacetResult(
    string DimensionId,
    bool Available,
    int TotalInContext,
    List<FacetValue> Values,
    string SuggestedDisplay,
    FacetVisibility Visibility
);

public record FacetValue(
    string Value,
    string Label,
    int Count,
    bool IsSelected,
    Dictionary<string, object>? Metadata  // For colors: hex code, for dates: ISO range
);

public record FacetVisibility(
    bool Visible,
    string Reason,
    double Coverage,
    int UniqueValues
);
```

### Optimized Multi-Facet Query

Instead of N separate queries, use a single query with conditional aggregation where possible:

```sql
WITH filtered_set AS (
  SELECT *
  FROM virtual_media
  WHERE {base_query_conditions}
    AND {active_filters}
),
stats AS (
  SELECT 
    COUNT(*) as total,
    MIN(captured_at) as date_min,
    MAX(captured_at) as date_max,
    julianday(MAX(captured_at)) - julianday(MIN(captured_at)) as date_span
  FROM filtered_set
)
SELECT
  -- Total
  s.total,
  s.date_min,
  s.date_max,
  s.date_span,
  
  -- Location facet (top 20)
  (SELECT json_group_array(json_object('value', place_name, 'count', cnt))
   FROM (
     SELECT place_name, COUNT(*) as cnt
     FROM filtered_set
     WHERE place_name IS NOT NULL
     GROUP BY place_name
     ORDER BY cnt DESC
     LIMIT 20
   )) as location_facet,
   
  -- Camera facet (top 20)
  (SELECT json_group_array(json_object('value', camera_make || ' ' || camera_model, 'count', cnt))
   FROM (
     SELECT camera_make, camera_model, COUNT(*) as cnt
     FROM filtered_set
     WHERE camera_make IS NOT NULL
     GROUP BY camera_make, camera_model
     ORDER BY cnt DESC
     LIMIT 20
   )) as camera_facet,
   
  -- Weather facet
  (SELECT json_group_array(json_object('value', weather_condition, 'count', cnt))
   FROM (
     SELECT weather_condition, COUNT(*) as cnt
     FROM filtered_set
     WHERE weather_condition IS NOT NULL
     GROUP BY weather_condition
     ORDER BY cnt DESC
   )) as weather_facet,
   
  -- Color facet
  (SELECT json_group_array(json_object('value', dominant_color_category, 'count', cnt))
   FROM (
     SELECT dominant_color_category, COUNT(*) as cnt
     FROM filtered_set
     WHERE dominant_color_category IS NOT NULL
     GROUP BY dominant_color_category
     ORDER BY cnt DESC
   )) as color_facet,
   
  -- Media type facet
  (SELECT json_group_array(json_object('value', media_type, 'count', cnt))
   FROM (
     SELECT media_type, COUNT(*) as cnt
     FROM filtered_set
     GROUP BY media_type
   )) as media_type_facet

FROM stats s;
```

### Caching Strategy

```typescript
interface FacetCacheKey {
  queryHash: string;            // Hash of base query + active filters
  facetDimension: string;
  timestamp: number;
}

interface FacetCache {
  // Short TTL for rapidly changing views
  set(key: FacetCacheKey, result: FacetResult, ttlMs: number): void;
  get(key: FacetCacheKey): FacetResult | null;
  
  // Invalidate on data changes
  invalidateAll(): void;
  invalidateForQuery(queryHash: string): void;
}

// Cache configuration
const FACET_CACHE_CONFIG = {
  defaultTtlMs: 30_000,         // 30 seconds
  maxEntries: 100,
  invalidateOnImport: true,
  invalidateOnEdit: true,
};
```

---

## Task 19.7: Frontend Facet Components

### What We're Building

New React components that support dynamic facets.

### FacetBar Component

```tsx
interface FacetBarProps {
  baseQuery: LibraryQuery;
  activeFilters: LibraryQuery;
  onFilterChange: (filters: LibraryQuery) => void;
  enabledFacets?: string[];     // Override default facets
}

function FacetBar({ baseQuery, activeFilters, onFilterChange, enabledFacets }: FacetBarProps) {
  const [facetResults, setFacetResults] = useState<Map<string, FacetResult>>(new Map());
  const [loading, setLoading] = useState(true);
  
  // Fetch facets when filters change
  useEffect(() => {
    const controller = new AbortController();
    
    async function fetchFacets() {
      setLoading(true);
      try {
        const results = await api.computeFacets({
          baseQuery,
          activeFilters,
          facets: enabledFacets ?? DEFAULT_FACETS,
        });
        setFacetResults(results);
      } finally {
        setLoading(false);
      }
    }
    
    // Debounce rapid changes
    const timeout = setTimeout(fetchFacets, 100);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [baseQuery, activeFilters, enabledFacets]);
  
  // Determine which facets to show
  const visibleFacets = useMemo(() => {
    return Array.from(facetResults.entries())
      .filter(([_, result]) => result.visibility.visible)
      .sort((a, b) => {
        // Sort: active first, then by coverage
        const aActive = hasActiveFilter(activeFilters, a[0]);
        const bActive = hasActiveFilter(activeFilters, b[0]);
        if (aActive !== bActive) return bActive ? 1 : -1;
        return b[1].visibility.coverage - a[1].visibility.coverage;
      });
  }, [facetResults, activeFilters]);
  
  return (
    <div className="facet-bar" data-testid="facet-bar">
      {/* Active filters summary */}
      <ActiveFiltersSummary 
        filters={activeFilters} 
        onClear={(dimension) => clearFilter(dimension)}
        onClearAll={() => onFilterChange({})}
      />
      
      {/* Facet chips */}
      <div className="facet-chips">
        {visibleFacets.map(([dimension, result]) => (
          <DynamicFacetChip
            key={dimension}
            dimension={dimension}
            result={result}
            activeFilters={activeFilters}
            onChange={(value) => updateFilter(dimension, value)}
            loading={loading}
          />
        ))}
      </div>
      
      {/* More facets dropdown (hidden ones) */}
      {hiddenFacets.length > 0 && (
        <MoreFacetsDropdown facets={hiddenFacets} />
      )}
    </div>
  );
}
```

### DynamicFacetChip Component

```tsx
interface DynamicFacetChipProps {
  dimension: string;
  result: FacetResult;
  activeFilters: LibraryQuery;
  onChange: (value: string | string[] | DateRange | null) => void;
  loading: boolean;
}

function DynamicFacetChip({ dimension, result, activeFilters, onChange, loading }: DynamicFacetChipProps) {
  const config = FACET_REGISTRY.find(f => f.id === dimension)!;
  const isActive = hasActiveFilter(activeFilters, dimension);
  const selectedCount = getSelectedCount(activeFilters, dimension);
  
  // Collapsed state (single value)
  if (result.visibility.reason === 'collapsed') {
    return (
      <div 
        className="facet-badge"
        data-testid={`facet-badge-${dimension}`}
      >
        <span className="facet-icon">{config.icon}</span>
        <span className="facet-value">{result.values[0].label}</span>
      </div>
    );
  }
  
  // Limited data warning
  const showWarning = result.visibility.reason === 'limited';
  
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "facet-chip",
            isActive && "facet-chip-active",
            showWarning && "facet-chip-limited"
          )}
          data-testid={`facet-chip-${dimension}`}
          data-active={isActive}
        >
          <span className="facet-icon">{config.icon}</span>
          <span className="facet-label">{config.label}</span>
          {isActive && selectedCount > 0 && (
            <span className="facet-count">({selectedCount})</span>
          )}
          {showWarning && <WarningIcon className="facet-warning" />}
          <ChevronDown className="facet-chevron" />
        </button>
      </PopoverTrigger>
      
      <PopoverContent className="facet-dropdown">
        <FacetDropdownContent
          dimension={dimension}
          config={config}
          result={result}
          activeFilters={activeFilters}
          onChange={onChange}
          loading={loading}
        />
      </PopoverContent>
    </Popover>
  );
}
```

### DateFacetContent Component (Special handling for dates)

```tsx
function DateFacetContent({ result, activeFilters, onChange }: DateFacetContentProps) {
  const dateResult = result as DateFacetResult;
  
  return (
    <div className="date-facet-content" data-testid="date-facet-content">
      {/* Distribution histogram */}
      <div className="date-histogram">
        <DateHistogram 
          buckets={dateResult.buckets}
          selectedRange={getDateRange(activeFilters)}
          onRangeSelect={onChange}
        />
      </div>
      
      {/* Quick select chips */}
      <div className="date-quick-select">
        {dateResult.buckets.slice(0, 6).map(bucket => (
          <button
            key={bucket.dateFrom}
            className={cn(
              "date-bucket-chip",
              isSelected(bucket, activeFilters) && "selected"
            )}
            data-testid={`date-bucket-${bucket.label}`}
            onClick={() => onChange({ from: bucket.dateFrom, to: bucket.dateTo })}
          >
            {bucket.label} ({bucket.count})
          </button>
        ))}
      </div>
      
      {/* Custom range picker */}
      <div className="date-range-picker">
        <DateRangePicker
          min={dateResult.range.earliest}
          max={dateResult.range.latest}
          value={getDateRange(activeFilters)}
          onChange={onChange}
        />
      </div>
      
      {/* Clear button */}
      {hasDateFilter(activeFilters) && (
        <button 
          className="date-clear"
          onClick={() => onChange(null)}
        >
          Clear date filter
        </button>
      )}
    </div>
  );
}
```

### HierarchicalTreeSelect Component

```tsx
interface TreeSelectProps {
  facetId: string;
  tree: HierarchicalFacetNode[];
  selection: TreeSelectionState;
  expandState: TreeExpandState;
  searchTerm: string;
  onSelectionChange: (selection: TreeSelectionState) => void;
  onExpandChange: (expand: TreeExpandState) => void;
  onSearchChange: (term: string) => void;
}

function HierarchicalTreeSelect({
  facetId,
  tree,
  selection,
  expandState,
  searchTerm,
  onSelectionChange,
  onExpandChange,
  onSearchChange,
}: TreeSelectProps) {
  // Filter tree when searching
  const { filteredTree, matchingIds, expandIds } = useMemo(() => {
    if (!searchTerm) return { filteredTree: tree, matchingIds: new Set(), expandIds: new Set() };
    return filterTree(tree, searchTerm);
  }, [tree, searchTerm]);
  
  // Auto-expand to show search matches
  useEffect(() => {
    if (searchTerm && expandIds.size > 0) {
      onExpandChange({
        ...expandState,
        expandedIds: new Set([...expandState.expandedIds, ...expandIds]),
      });
    }
  }, [expandIds]);
  
  return (
    <div className="tree-select" data-testid={`tree-select-${facetId}`}>
      {/* Search input */}
      <div className="tree-search">
        <input
          type="text"
          placeholder="Search..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          data-testid={`tree-search-${facetId}`}
        />
      </div>
      
      {/* Action buttons */}
      <div className="tree-actions">
        <button 
          onClick={() => selectAll(tree, onSelectionChange)}
          data-testid={`tree-select-all-${facetId}`}
        >
          Select All
        </button>
        <button 
          onClick={() => onSelectionChange({ selectedIds: new Set(), excludedIds: new Set() })}
          data-testid={`facet-clear-all-${facetId}`}
        >
          Clear All
        </button>
        <button onClick={() => onExpandChange(expandAll(expandState))}>
          Expand All
        </button>
        <button onClick={() => onExpandChange(collapseAll(expandState))}>
          Collapse All
        </button>
      </div>
      
      {/* Tree nodes */}
      <div className="tree-nodes" role="tree">
        {filteredTree.map(node => (
          <TreeNode
            key={node.id}
            node={node}
            facetId={facetId}
            selection={selection}
            expandState={expandState}
            matchingIds={matchingIds}
            depth={0}
            onToggleSelect={(nodeId) => {
              const state = getNodeSelectionState(
                findNode(nodeId, tree)!, 
                selection
              );
              onSelectionChange(toggleNode(findNode(nodeId, tree)!, selection, state));
            }}
            onToggleExpand={(nodeId) => {
              onExpandChange(toggleExpand(nodeId, expandState));
            }}
          />
        ))}
      </div>
      
      {/* Selection summary */}
      <div className="tree-summary" data-testid={`tree-summary-${facetId}`}>
        {getSelectionSummary(selection, tree)}
      </div>
    </div>
  );
}

interface TreeNodeProps {
  node: HierarchicalFacetNode;
  facetId: string;
  selection: TreeSelectionState;
  expandState: TreeExpandState;
  matchingIds: Set<string>;
  depth: number;
  onToggleSelect: (nodeId: string) => void;
  onToggleExpand: (nodeId: string) => void;
}

function TreeNode({
  node,
  facetId,
  selection,
  expandState,
  matchingIds,
  depth,
  onToggleSelect,
  onToggleExpand,
}: TreeNodeProps) {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandState.expandedIds.has(node.id) || 
                     expandState.expandedIds.has('__ALL__');
  const selectionState = getNodeSelectionState(node, selection);
  const isMatch = matchingIds.has(node.id);
  
  return (
    <div 
      className="tree-node"
      role="treeitem"
      aria-expanded={hasChildren ? isExpanded : undefined}
      style={{ paddingLeft: `${depth * 20}px` }}
      data-testid={`tree-node-${node.id}`}
    >
      <div className="tree-node-row">
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            className="tree-expand-toggle"
            onClick={() => onToggleExpand(node.id)}
            data-testid={`tree-expand-${node.id}`}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? '▼' : '▶'}
          </button>
        ) : (
          <span className="tree-expand-spacer" />
        )}
        
        {/* Tri-state checkbox */}
        <button
          className={cn(
            "tree-checkbox",
            selectionState === 'all' && "checked",
            selectionState === 'some' && "partial",
          )}
          onClick={() => onToggleSelect(node.id)}
          data-testid={`tree-checkbox-${node.id}`}
          data-state={selectionState === 'all' ? 'checked' : 
                      selectionState === 'some' ? 'partial' : 'unchecked'}
          role="checkbox"
          aria-checked={selectionState === 'some' ? 'mixed' : selectionState === 'all'}
        >
          {selectionState === 'all' && '☑'}
          {selectionState === 'some' && '☒'}
          {selectionState === 'none' && '☐'}
        </button>
        
        {/* Label */}
        <span 
          className={cn("tree-label", isMatch && "tree-label-match")}
          onClick={() => onToggleSelect(node.id)}
        >
          {node.label}
        </span>
        
        {/* Count */}
        <span className="tree-count">({node.count})</span>
      </div>
      
      {/* Children (if expanded) */}
      {hasChildren && isExpanded && (
        <div className="tree-children" role="group">
          {node.children!.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              facetId={facetId}
              selection={selection}
              expandState={expandState}
              matchingIds={matchingIds}
              depth={depth + 1}
              onToggleSelect={onToggleSelect}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

### Stable Selectors for Tree Components

| Selector | Element | Notes |
|----------|---------|-------|
| `tree-select-{facetId}` | Tree container | e.g., `tree-select-location` |
| `tree-search-{facetId}` | Search input | |
| `tree-select-all-{facetId}` | Select all button | |
| `facet-clear-all-{facetId}` | Clear all button | |
| `tree-node-{nodeId}` | Tree node row | e.g., `tree-node-norway` |
| `tree-expand-{nodeId}` | Expand/collapse button | |
| `tree-checkbox-{nodeId}` | Selection checkbox | Has `data-state` attr |
| `tree-summary-{facetId}` | Selection summary | |

---

## Task 19.8: Query Model Updates

### What We're Building

Updates to `LibraryQuery` to support dynamic facets properly.

### Enhanced Query Model

```typescript
interface LibraryQuery {
  // === Existing from M6 ===
  text?: string;
  dateFrom?: string;
  dateTo?: string;
  placeNames?: string[];
  hasLocation?: boolean;
  boundingBox?: BoundingBox;
  cameraMakes?: string[];
  cameraModels?: string[];
  mediaTypes?: MediaType[];
  dominantColors?: string[];
  duplicateStatus?: DuplicateStatus;
  sortBy: SortField;
  sortDirection: SortDirection;
  page: number;
  pageSize: number;
  groupBy?: GroupField;
  
  // === NEW for M19: Deprecate datePreset ===
  // datePreset is REMOVED - was 'today' | 'week' | 'month' | 'year' | 'all'
  // Replaced by explicit dateFrom/dateTo
  
  // === NEW for M19: Additional filter dimensions ===
  
  // Hierarchical location
  placeCountries?: string[];
  placeRegions?: string[];
  placeCities?: string[];
  
  // Weather (from M8)
  weatherConditions?: string[];
  
  // People (from M13)
  personIds?: string[];
  hasFaces?: boolean;
  
  // Keywords (from M12)
  keywords?: string[];
  
  // Events (from M11)
  eventIds?: string[];
  
  // Objects (from M14)
  objectTypes?: string[];
  
  // === NEW for M19: Query metadata ===
  
  // Source context (for saved views)
  sourceViewId?: string;
  
  // Facet hints (what facets to compute)
  requestFacets?: string[];
  
  // Skip certain facets for performance
  skipFacets?: string[];
}
```

### Migration from datePreset

```typescript
// Convert legacy datePreset to explicit range
function migrateDatePreset(query: LegacyQuery): LibraryQuery {
  if (!query.datePreset || query.datePreset === 'all') {
    // No date filter
    const { datePreset, ...rest } = query;
    return rest;
  }
  
  // These presets are CONTEXT-DEPENDENT now
  // If viewing a saved view, compute relative to view's date range
  // If viewing full library, compute relative to today
  // This is handled by the facet computation, not query model
  
  console.warn('datePreset is deprecated. Use explicit dateFrom/dateTo.');
  
  const now = new Date();
  let dateFrom: string;
  
  switch (query.datePreset) {
    case 'today':
      dateFrom = startOfDay(now).toISOString();
      break;
    case 'week':
      dateFrom = subDays(now, 7).toISOString();
      break;
    case 'month':
      dateFrom = subDays(now, 30).toISOString();
      break;
    case 'year':
      dateFrom = subDays(now, 365).toISOString();
      break;
  }
  
  const { datePreset, ...rest } = query;
  return { ...rest, dateFrom, dateTo: now.toISOString() };
}
```

---

## Task 19.9: Saved Views Compatibility

### What We're Building

Ensure saved views work correctly with dynamic facets.

### Saved View Query Storage

```typescript
interface SavedView {
  id: string;
  name: string;
  
  // The base query that defines this view
  query: LibraryQuery;
  
  // === NEW for M19 ===
  
  // Snapshot of date range when view was created
  // Used for "relative" queries like "recent in this context"
  dateContext?: {
    createdAt: string;          // When view was saved
    dataRangeAtCreation?: {
      earliest: string;
      latest: string;
    };
  };
  
  // Which facets to show by default in this view
  defaultFacets?: string[];
  
  // Facets to always hide in this view
  hiddenFacets?: string[];
  
  // Layout preferences
  layout: ViewLayout;
  gridSize?: number;
  
  // Metadata
  createdAt: string;
  updatedAt: string;
  isPinned: boolean;
  icon?: string;
  color?: string;
  sortOrder: number;
}
```

### View-Aware Date Facets

When computing date facets for a saved view:

```typescript
async function computeDateFacetsForView(
  view: SavedView,
  activeFilters: LibraryQuery
): Promise<DateFacetResult> {
  // Get the actual date range of items in this view
  const viewDateRange = await queryViewDateRange(view.query, activeFilters);
  
  // Compute smart buckets based on this range (not "today")
  const buckets = computeSmartBuckets(
    viewDateRange.earliest,
    viewDateRange.latest
  );
  
  return {
    range: viewDateRange,
    buckets,
    granularity: determineGranularity(viewDateRange),
  };
}
```

---

## E2E Test: `dynamic_facets_cascade_on_filter`

### What We're Testing

Facets update dynamically when filters are applied.

### Test Steps

```
1. Import fixture with:
   - 100 photos in Paris (iPhone)
   - 50 photos in Oslo (Sony)
   - 20 photos in Tokyo (Canon)
2. Open library, verify initial facet counts
3. Click Location facet → verify "Paris (100) | Oslo (50) | Tokyo (20)"
4. Select "Paris"
5. Assert Camera facet updates to show only "iPhone (100)"
6. Assert Date facet updates to show Paris trip dates
7. Clear Paris filter
8. Assert all facets return to initial state
```

### Key Assertions

```typescript
// Initial state
await expect(page.getByTestId('facet-chip-location')).toContainText('Location');
await page.getByTestId('facet-chip-location').click();
await expect(page.getByTestId('facet-option-paris')).toContainText('(100)');
await expect(page.getByTestId('facet-option-oslo')).toContainText('(50)');
await expect(page.getByTestId('facet-option-tokyo')).toContainText('(20)');

// Select Paris
await page.getByTestId('facet-option-paris').click();

// Camera facet should update
await page.getByTestId('facet-chip-camera').click();
await expect(page.getByTestId('facet-option-iphone')).toContainText('(100)');
await expect(page.getByTestId('facet-option-sony')).not.toBeVisible();
await expect(page.getByTestId('facet-option-canon')).not.toBeVisible();

// Clear and verify restoration
await page.getByTestId('facet-clear-all').click();
await page.getByTestId('facet-chip-camera').click();
await expect(page.getByTestId('facet-option-iphone')).toContainText('(100)');
await expect(page.getByTestId('facet-option-sony')).toContainText('(50)');
```

---

## E2E Test: `dynamic_date_facets_adapt_to_view`

### What We're Testing

Date facets show intelligent buckets based on view content, not "today/week/month".

### Fixture

```
e2e/fixtures/historical-trip/
├── photos/
│   ├── trip_2019_06_01_001.jpg   # June 1, 2019
│   ├── trip_2019_06_01_002.jpg
│   ├── trip_2019_06_05_001.jpg   # June 5, 2019
│   ├── trip_2019_06_10_001.jpg   # June 10, 2019
│   ├── trip_2019_06_15_001.jpg   # June 15, 2019
│   └── ... (50 total photos)
└── expected.json
```

### Test Steps

```
1. Import historical-trip fixture (June 2019 photos)
2. Create saved view "June 2019 Trip"
3. Open saved view
4. Click Date facet
5. Assert facet shows "Jun 1-7 (X) | Jun 8-14 (Y) | Jun 15-21 (Z)"
6. Assert NO "Today" / "This Week" / "This Month" options
7. Select "Jun 1-7"
8. Assert grid shows only photos from that week
```

### Key Assertions

```typescript
// Open saved view
await page.getByTestId('saved-view-june-2019-trip').click();
await expect(page.getByTestId('library-grid')).toBeVisible();

// Open date facet
await page.getByTestId('facet-chip-date').click();

// Should show contextual buckets, NOT hardcoded presets
await expect(page.getByTestId('date-facet-content')).toBeVisible();
await expect(page.getByText('Today')).not.toBeVisible();
await expect(page.getByText('This Week')).not.toBeVisible();
await expect(page.getByText('This Month')).not.toBeVisible();

// Should show intelligent June 2019 buckets
await expect(page.getByTestId('date-bucket-jun-1-7')).toBeVisible();
await expect(page.getByTestId('date-bucket-jun-8-14')).toBeVisible();
```

---

## E2E Test: `facets_hide_when_no_data`

### What We're Testing

Facets with no applicable data are hidden automatically.

### Fixture

```
e2e/fixtures/minimal-metadata/
├── photos/
│   ├── no_weather_001.jpg        # Has location, no weather
│   ├── no_weather_002.jpg
│   ├── no_faces_001.jpg          # No detected faces
│   └── no_color_001.jpg          # No color extraction run
└── expected.json
```

### Test Steps

```
1. Import minimal-metadata fixture (no weather, faces, or color data)
2. Open library
3. Assert Weather facet is hidden
4. Assert People facet is hidden
5. Assert Color facet is hidden
6. Assert Location and Camera facets ARE visible
```

### Key Assertions

```typescript
// Facets with no data should be hidden
await expect(page.getByTestId('facet-chip-weather')).not.toBeVisible();
await expect(page.getByTestId('facet-chip-people')).not.toBeVisible();
await expect(page.getByTestId('facet-chip-color')).not.toBeVisible();

// Facets with data should be visible
await expect(page.getByTestId('facet-chip-location')).toBeVisible();
await expect(page.getByTestId('facet-chip-camera')).toBeVisible();
await expect(page.getByTestId('facet-chip-date')).toBeVisible();
```

---

## E2E Test: `hierarchical_facet_tree_select`

### What We're Testing

Hierarchical facets support expand/collapse and multi-level selection.

### Fixture

```
e2e/fixtures/multi-location/
├── photos/
│   ├── norway_oslo_grunerlokka_001.jpg    # Norway > Oslo > Grünerløkka
│   ├── norway_oslo_frogner_001.jpg        # Norway > Oslo > Frogner
│   ├── norway_bergen_bryggen_001.jpg      # Norway > Vestland > Bergen
│   ├── france_paris_marais_001.jpg        # France > Île-de-France > Paris
│   ├── france_lyon_001.jpg                # France > Auvergne-Rhône-Alpes > Lyon
│   └── japan_tokyo_shibuya_001.jpg        # Japan > Tokyo > Shibuya
└── expected.json
```

### Test Steps

```
1. Import multi-location fixture
2. Open Location facet
3. Assert tree shows collapsed countries: "Norway | France | Japan"
4. Expand "Norway" → see regions/cities
5. Check "Oslo" checkbox → assert partial check on "Norway"
6. Assert grid filters to Oslo photos only
7. Check "Norway" parent → assert all Norwegian children selected
8. Assert grid shows all Norway photos
9. Expand "France", check "Paris"
10. Assert grid shows Norway + Paris photos
11. Use "Select All" → all locations selected
12. Use "Clear All" → no filters active
```

### Key Assertions

```typescript
// Open location facet
await page.getByTestId('facet-chip-location').click();

// Should show collapsed tree with countries
await expect(page.getByTestId('tree-node-norway')).toBeVisible();
await expect(page.getByTestId('tree-node-france')).toBeVisible();
await expect(page.getByTestId('tree-node-japan')).toBeVisible();

// Norway should be collapsed initially (Oslo not visible)
await expect(page.getByTestId('tree-node-oslo')).not.toBeVisible();

// Expand Norway
await page.getByTestId('tree-expand-norway').click();
await expect(page.getByTestId('tree-node-oslo')).toBeVisible();
await expect(page.getByTestId('tree-node-bergen')).toBeVisible();

// Select Oslo (child) - parent should show partial state
await page.getByTestId('tree-checkbox-oslo').click();
await expect(page.getByTestId('tree-checkbox-norway')).toHaveAttribute('data-state', 'partial');

// Grid should filter to Oslo only
const osloCount = await page.getByTestId('library-grid').locator('[data-testid^="grid-item-"]').count();
expect(osloCount).toBe(2); // oslo_grunerlokka + oslo_frogner

// Now select parent (Norway) - all children should be selected
await page.getByTestId('tree-checkbox-norway').click();
await expect(page.getByTestId('tree-checkbox-norway')).toHaveAttribute('data-state', 'checked');
await expect(page.getByTestId('tree-checkbox-oslo')).toHaveAttribute('data-state', 'checked');
await expect(page.getByTestId('tree-checkbox-bergen')).toHaveAttribute('data-state', 'checked');

// Grid should show all Norway photos
const norwayCount = await page.getByTestId('library-grid').locator('[data-testid^="grid-item-"]').count();
expect(norwayCount).toBe(3); // all norwegian photos

// Add France > Paris to selection
await page.getByTestId('tree-expand-france').click();
await page.getByTestId('tree-checkbox-paris').click();

// Grid should show Norway + Paris
const combinedCount = await page.getByTestId('library-grid').locator('[data-testid^="grid-item-"]').count();
expect(combinedCount).toBe(4); // 3 norway + 1 paris

// Clear all
await page.getByTestId('facet-clear-all-location').click();
const allCount = await page.getByTestId('library-grid').locator('[data-testid^="grid-item-"]').count();
expect(allCount).toBe(6); // all photos
```

---

## E2E Test: `date_hierarchy_tree_select`

### What We're Testing

Date facets show Year → Month → Week hierarchy with tree selection.

### Fixture

```
e2e/fixtures/multi-year/
├── photos/
│   ├── 2019_01_15_001.jpg    # January 2019
│   ├── 2019_06_10_001.jpg    # June 2019
│   ├── 2019_06_15_001.jpg    # June 2019
│   ├── 2020_03_20_001.jpg    # March 2020
│   ├── 2020_07_04_001.jpg    # July 2020
│   └── 2021_12_25_001.jpg    # December 2021
└── expected.json
```

### Test Steps

```
1. Import multi-year fixture
2. Open Date facet
3. Assert tree shows years: "2021 | 2020 | 2019"
4. Expand "2019" → see months
5. Check "June 2019" → grid filters to June photos
6. Check entire "2019" year → all 2019 photos shown
7. Verify counts at each level are accurate
```

### Key Assertions

```typescript
// Open date facet
await page.getByTestId('facet-chip-date').click();

// Should show year nodes
await expect(page.getByTestId('tree-node-2019')).toBeVisible();
await expect(page.getByTestId('tree-node-2019')).toContainText('(3)'); // 3 photos in 2019

// Expand 2019
await page.getByTestId('tree-expand-2019').click();
await expect(page.getByTestId('tree-node-2019-01')).toBeVisible(); // January
await expect(page.getByTestId('tree-node-2019-06')).toBeVisible(); // June
await expect(page.getByTestId('tree-node-2019-06')).toContainText('(2)'); // 2 June photos

// Select June 2019
await page.getByTestId('tree-checkbox-2019-06').click();
const juneCount = await page.getByTestId('library-grid').locator('[data-testid^="grid-item-"]').count();
expect(juneCount).toBe(2);

// Select all of 2019
await page.getByTestId('tree-checkbox-2019').click();
const year2019Count = await page.getByTestId('library-grid').locator('[data-testid^="grid-item-"]').count();
expect(year2019Count).toBe(3);
```

---

## Acceptance Criteria

### Task 19.1: Dynamic Date Facets
- [ ] Date buckets computed from actual data range
- [ ] Smart granularity (day/week/month/year) based on span
- [ ] No hardcoded "Today/Week/Month" presets
- [ ] Date histogram visualization works
- [ ] Range picker respects data bounds

### Task 19.2: Cascading Facet Updates
- [ ] Changing one facet updates all others
- [ ] Updates happen within 200ms
- [ ] Selected values persist across updates
- [ ] Counts reflect filtered result set

### Task 19.3: Facet Visibility
- [ ] Facets with 0 items hidden
- [ ] Single-value facets collapsed to badge
- [ ] Limited coverage shows warning indicator
- [ ] "More facets" dropdown for hidden facets

### Task 19.4: Unified Facet Schema
- [ ] All facet types use common schema
- [ ] Registry supports new facet additions
- [ ] Join configurations work for related tables
- [ ] Enrichment dependencies respected

### Task 19.5: Hierarchical Tree-Select Facets
- [ ] Tree structure renders with expand/collapse
- [ ] Tri-state checkboxes (none/some/all)
- [ ] Parent selection selects all children
- [ ] Child selection shows partial state on parent
- [ ] Multi-select across branches works
- [ ] Search within tree filters and auto-expands
- [ ] "Select All" / "Clear All" buttons work
- [ ] Works for location, date, and camera facets

### Task 19.6: Backend Service
- [ ] Single optimized query for multiple facets
- [ ] < 200ms response time for 100k items
- [ ] Caching reduces repeated queries
- [ ] Parallel computation where beneficial

### Task 19.7: Frontend Components
- [ ] FacetBar renders dynamically
- [ ] Loading states shown
- [ ] Accessibility (keyboard navigation)
- [ ] Mobile-responsive layout

### Task 19.8: Query Model Updates
- [ ] datePreset deprecated
- [ ] New filter dimensions added
- [ ] Backward compatibility maintained
- [ ] URL serialization works

### Task 19.9: Saved Views Compatibility
- [ ] Existing saved views still work
- [ ] Date context stored for relative queries
- [ ] View-specific facet preferences
- [ ] Migration path for legacy views

### E2E Tests
- [ ] `dynamic_facets_cascade_on_filter` passes
- [ ] `dynamic_date_facets_adapt_to_view` passes
- [ ] `facets_hide_when_no_data` passes
- [ ] `hierarchical_facet_tree_select` passes
- [ ] `date_hierarchy_tree_select` passes

---

## Dependencies on Other Milestones

- **M6 (Search/Facets)**: Foundation being enhanced
- **M7 (Places)**: Hierarchical location data
- **M8 (Weather)**: Weather facet data source
- **M10 (Color)**: Color facet data source
- **M11 (Events)**: Event facet data source
- **M12 (Keywords)**: Keywords facet data source
- **M13 (Faces)**: People facet data source
- **M14 (Objects)**: Object facet data source

## What This Milestone Enables

After M19:
- True drill-down filtering across any dimension
- Context-aware date navigation
- Intelligent facet visibility
- Faster, more relevant search refinement
- Foundation for advanced analytics views
- Better UX for historical photo browsing
- Scalable facet system for future dimensions

---

## Performance Considerations

### Query Optimization

| Metric | Target | Strategy |
|--------|--------|----------|
| Facet computation | < 200ms | Combined query, indexing |
| UI update | < 100ms | React 19 transitions |
| Cache hit rate | > 80% | Smart cache key design |
| Memory usage | < 50MB | Streaming, pagination |

### Indexing Requirements

```sql
-- New indexes for M19
CREATE INDEX idx_vm_place_hierarchy ON virtual_media(
  place_country, place_region, place_city
);

CREATE INDEX idx_vm_weather ON virtual_media(weather_condition)
WHERE weather_condition IS NOT NULL;

CREATE INDEX idx_vm_color ON virtual_media(dominant_color_category)
WHERE dominant_color_category IS NOT NULL;

-- Composite for common facet combos
CREATE INDEX idx_vm_loc_date ON virtual_media(place_name, captured_at);
CREATE INDEX idx_vm_camera_date ON virtual_media(camera_make, captured_at);
```

### Benchmark Targets

| Library Size | Facet Computation | Total Query |
|--------------|-------------------|-------------|
| 10k items | < 50ms | < 100ms |
| 100k items | < 200ms | < 300ms |
| 1M items | < 500ms | < 700ms |
