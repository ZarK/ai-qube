# Milestone 6 — Search & Facets

## Strategic Goal

Build the **query-driven library** where every view is a saved search. Users can filter by date, location, camera, color, and text — with instant results and saveable views.

**Success looks like:** User types in search → results filter instantly → clicks date facet → further filters → saves as "Summer 2023" → view appears in sidebar → clicking restores exact query.

---

## Spec Requirements (from spec.md)

| Requirement | Spec Section | Notes |
|-------------|--------------|-------|
| Every screen is a query view | §2.8 | Filters, sort, layout, grouping |
| Save any view as named search | §2.8 | Reopen later |
| Filter changes < 100ms perceived | §3.1 | Instant feedback |
| Multiple layouts: Grid, Map, Timeline, Calendar, Table | §2.8 | Query persists across layouts |

---

## Why This Milestone Matters

Traditional photo apps have "albums" as the primary organization. But albums are:
- Manual effort to maintain
- Mutually exclusive (photo can only be in one album)
- Static (don't update when new photos match criteria)

Query-driven organization is better:
- Automatic (filters find matching photos)
- Overlapping (same photo matches multiple queries)
- Dynamic (new imports automatically appear)
- Flexible (any combination of criteria)

---

## Task 6.1: Query Model

### What We're Building

The **data structure** representing any library query.

### Query Structure

```typescript
interface LibraryQuery {
  // Text search
  text?: string;              // Full-text across all searchable fields
  
  // Date filters
  dateFrom?: string;          // ISO date (inclusive)
  dateTo?: string;            // ISO date (inclusive)
  datePreset?: 'today' | 'week' | 'month' | 'year' | 'all';
  
  // Location filters
  placeNames?: string[];      // Match any of these places
  hasLocation?: boolean;      // Has GPS coordinates
  boundingBox?: {             // Map viewport
    north: number;
    south: number;
    east: number;
    west: number;
  };
  
  // Camera filters
  cameraMakes?: string[];     // Match any of these makes
  cameraModels?: string[];    // Match any of these models
  
  // Media type
  mediaTypes?: ('image' | 'video')[];
  
  // Color filter
  dominantColors?: string[];  // Match any of these colors
  
  // Duplicate filter
  duplicateStatus?: 'all' | 'canonical' | 'duplicates';
  
  // Sort
  sortBy: 'capturedAt' | 'displayName' | 'createdAt' | 'fileSize';
  sortDirection: 'asc' | 'desc';
  
  // Pagination
  page: number;
  pageSize: number;
  
  // Grouping (optional)
  groupBy?: 'date' | 'month' | 'year' | 'place' | 'camera' | 'event';
}
```

### Default Query

When library opens with no saved view:

```typescript
const defaultQuery: LibraryQuery = {
  sortBy: 'capturedAt',
  sortDirection: 'desc',
  page: 1,
  pageSize: 200,
  duplicateStatus: 'canonical',  // Show only best versions
};
```

### Query Serialization

Queries serialize to URL-safe format for:
- Browser history (back/forward)
- Shareable links (future)
- Saved views storage

```
/library?text=paris&dateFrom=2023-01-01&sort=capturedAt:desc
```

---

## Task 6.2: Backend Query Engine

### What We're Building

The **SQLite query builder** that executes library queries efficiently.

### Query Translation

Each filter maps to SQL:

| Filter | SQL |
|--------|-----|
| `text: "paris"` | `WHERE display_name LIKE '%paris%' OR place_name LIKE '%paris%'` |
| `dateFrom: "2023-01-01"` | `WHERE captured_at >= '2023-01-01'` |
| `dateTo: "2023-12-31"` | `WHERE captured_at <= '2023-12-31T23:59:59'` |
| `placeNames: ["Oslo", "Bergen"]` | `WHERE place_name IN ('Oslo', 'Bergen')` |
| `hasLocation: true` | `WHERE latitude IS NOT NULL` |
| `cameraMakes: ["Apple"]` | `WHERE camera_make IN ('Apple')` |
| `mediaTypes: ["video"]` | `WHERE media_type = 'video'` |
| `dominantColors: ["#3B82F6"]` | `WHERE dominant_color IN ('#3B82F6')` |
| `duplicateStatus: "canonical"` | `(default - show VirtualMedia)` |

### Full-Text Search Strategy

**Option A: LIKE queries**
- Simple: `WHERE field LIKE '%term%'`
- No special setup
- Slow on large tables

**Option B: SQLite FTS5**
- Fast full-text search
- Requires separate FTS table
- More complex setup

**Decision: Start with LIKE, add FTS5 if needed.**

For typical libraries (< 100k items), LIKE with proper indexes is sufficient. Can add FTS5 later without API changes.

### Indexing Strategy

Critical indexes for query performance:

```sql
-- Date queries (most common)
CREATE INDEX idx_vm_captured_at ON virtual_media(captured_at);

-- Place queries
CREATE INDEX idx_vm_place_name ON virtual_media(place_name);

-- Camera queries
CREATE INDEX idx_vm_camera ON virtual_media(camera_make, camera_model);

-- Composite for common query patterns
CREATE INDEX idx_vm_date_place ON virtual_media(captured_at, place_name);
```

### Pagination

Use **cursor-based pagination** for consistency:

```sql
-- First page
SELECT * FROM virtual_media
WHERE ...
ORDER BY captured_at DESC, id DESC
LIMIT 200;

-- Next page (using last item's values as cursor)
SELECT * FROM virtual_media
WHERE ...
  AND (captured_at < :lastDate OR (captured_at = :lastDate AND id < :lastId))
ORDER BY captured_at DESC, id DESC
LIMIT 200;
```

Why cursor-based?
- Consistent during updates (offset skips items when new ones added)
- Works with streaming updates
- More efficient for deep pagination

---

## Task 6.3: Facet Aggregation

### What We're Building

The **facet counts** shown in filter chips.

### What Are Facets?

Facets show the distribution of values for quick filtering:

```
Date: Today (12) | This Week (45) | This Month (234) | All (5,432)
Location: Oslo (1,234) | Bergen (567) | Paris (89)
Camera: iPhone 14 Pro (2,345) | Sony A7 (1,234)
Color: 🔵 (456) | 🟢 (234) | 🔴 (123)
```

### Facet Types

| Facet | Aggregation | Display |
|-------|-------------|---------|
| Date | Presets (today/week/month/year) | Buttons with counts |
| Location | Top N places | Dropdown with counts |
| Camera | Top N make+model | Dropdown with counts |
| Color | Top N colors | Color swatches with counts |
| Type | Image/Video | Toggle with counts |

### Aggregation Queries

**Date facets:**
```sql
SELECT 
  SUM(CASE WHEN date(captured_at) = date('now') THEN 1 ELSE 0 END) as today,
  SUM(CASE WHEN captured_at >= date('now', '-7 days') THEN 1 ELSE 0 END) as week,
  SUM(CASE WHEN captured_at >= date('now', '-30 days') THEN 1 ELSE 0 END) as month,
  COUNT(*) as total
FROM virtual_media
WHERE ... (current filters except date)
```

**Place facets:**
```sql
SELECT place_name, COUNT(*) as count
FROM virtual_media
WHERE place_name IS NOT NULL
  AND ... (current filters except place)
GROUP BY place_name
ORDER BY count DESC
LIMIT 20
```

**Camera facets:**
```sql
SELECT camera_make, camera_model, COUNT(*) as count
FROM virtual_media
WHERE camera_make IS NOT NULL
  AND ... (current filters except camera)
GROUP BY camera_make, camera_model
ORDER BY count DESC
LIMIT 20
```

### Facet Caching

Aggregations are expensive. Cache strategy:
- Cache facets per query hash
- Invalidate on media changes
- Refresh in background after initial load
- Show stale counts while refreshing

---

## Task 6.4: Facet Chips UI

### What We're Building

The **filter UI** at the top of the library.

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ [🔍 Search...]                                                   │
├─────────────────────────────────────────────────────────────────┤
│ Date ▼ (234)  │  Location ▼ (5)  │  Camera ▼ (3)  │  Color ▼  │  [Clear All]
└─────────────────────────────────────────────────────────────────┘
```

### Chip States

| State | Appearance |
|-------|------------|
| Inactive | Gray outline, shows total count |
| Active | Blue fill, shows filtered count |
| Multiple selected | Blue fill, shows "2 selected" |

### Dropdown Behavior

Clicking chip opens dropdown:

```
┌─────────────────────────┐
│ 📍 Location             │
├─────────────────────────┤
│ ☐ Oslo          (1,234) │
│ ☐ Bergen          (567) │
│ ☐ Paris            (89) │
│ ☐ London           (45) │
│ ───────────────────────│
│ [Show all locations...] │
└─────────────────────────┘
```

### Selection Behavior

- **Single click**: Toggle filter on/off
- **Multiple selection**: Supported (OR within facet)
- **Clear button**: Remove all selections for this facet
- **Clear All**: Remove all filters

### Search Within Facet

For facets with many values (locations, cameras):
- Include search box in dropdown
- Filter options as user types
- "Show all" opens full list modal

---

## Task 6.5: Text Search

### What We're Building

The **search box** that filters across all text fields.

### Searchable Fields

| Field | Weight | Example Matches |
|-------|--------|-----------------|
| displayName | High | Filename patterns |
| placeName | High | Location names |
| placeHierarchy | Medium | Country, state, city |
| cameraMake/Model | Low | Camera names |
| (future) tags | High | User-added tags |
| (future) aiKeywords | Medium | AI-extracted keywords |

### Search UX

**Instant search**: Results update as user types (debounced 150ms)

**Search syntax** (future enhancement):
- `in:oslo` — Location filter
- `camera:iphone` — Camera filter
- `date:2023` — Date filter
- `type:video` — Type filter

For MVP: Simple text matching, no special syntax.

### Empty State

When search returns no results:
```
┌─────────────────────────────────────┐
│                                     │
│     No photos match "xyzabc"        │
│                                     │
│     Try:                            │
│     • Checking your spelling        │
│     • Using fewer filters           │
│     • Clearing some facets          │
│                                     │
│     [Clear All Filters]             │
│                                     │
└─────────────────────────────────────┘
```

---

## Task 6.6: Saved Views

### What We're Building

The ability to **save and restore** query configurations.

### What's Saved

```typescript
interface SavedView {
  id: string;
  name: string;
  query: LibraryQuery;
  layout: 'grid' | 'map' | 'timeline' | 'calendar' | 'table';
  gridSize?: number;            // Thumbnail size for grid
  createdAt: string;
  updatedAt: string;
  isPinned: boolean;            // Show in sidebar
  icon?: string;                // Custom icon
  color?: string;               // Accent color
}
```

### Built-in Views

Pre-created views that can't be deleted:

| View | Query | Notes |
|------|-------|-------|
| All Photos | `{}` (default) | Everything |
| Recent | `datePreset: 'month'` | Last 30 days |
| Videos | `mediaTypes: ['video']` | Only videos |
| Duplicates | `duplicateStatus: 'duplicates'` | Only non-canonical |
| No Date | `capturedAt: null` | Missing date metadata |
| No Location | `hasLocation: false` | Missing GPS |

### Save View Flow

```
1. User configures filters
2. User clicks "Save View" (or Cmd+S)
3. Modal asks for name
4. View saved to database
5. View appears in sidebar
6. Future visits restore exact state
```

### View Storage

```sql
CREATE TABLE saved_views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,        -- JSON serialized query
    layout TEXT NOT NULL,
    grid_size INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_pinned INTEGER DEFAULT 0,
    icon TEXT,
    color TEXT,
    sort_order INTEGER DEFAULT 0
);
```

### Sidebar Display

```
LIBRARY
────────────────
📷 All Photos
🕐 Recent
🎬 Videos

SAVED VIEWS
────────────────
☀️ Summer 2023
🏔️ Mountain Trips  
👨‍👩‍👧 Family Photos

SMART VIEWS
────────────────
⚠️ No Date (234)
📍 No Location (567)
📋 Duplicates (89)
```

---

## Task 6.7: Query Performance

### What We're Building

Optimizations to ensure **< 100ms query response**.

### Performance Budget

| Operation | Budget |
|-----------|--------|
| Initial query (cold) | < 500ms |
| Filter change | < 100ms |
| Facet counts | < 200ms |
| Text search | < 150ms |

### Optimization Strategies

#### 1. Query Planning

Analyze query to choose optimal execution:
- If date range small → scan by date index
- If place specific → scan by place index
- If text search → may need full scan (consider FTS)

#### 2. Result Caching

Cache recent query results:
- Key: hash of query
- TTL: 60 seconds (or until data changes)
- Invalidate on: import complete, media update, delete

#### 3. Facet Pre-computation

For common facets (date presets), pre-compute:
- On import completion, update facet counts
- Store in separate table for instant retrieval

#### 4. Pagination Optimization

- First page: priority loading
- Subsequent pages: load in background
- Show skeleton items during load

#### 5. Index Analysis

Regularly check query plans:
```sql
EXPLAIN QUERY PLAN SELECT ... FROM virtual_media WHERE ...
```

If showing "SCAN TABLE", add missing index.

---

## E2E Test: `cmdk_search_filters_grid`

### What We're Testing

Command bar search filters library results instantly.

### Test Steps

```
1. Import basic fixture
2. Wait for completion
3. Verify full count visible
4. Open command bar (Cmd+K)
5. Type search term that matches some items
6. Press Enter (or wait for debounce)
7. Assert grid count reduced
8. Assert visible items match search
9. Clear search
10. Assert full count restored
```

### Key Assertions

```typescript
// Full library
const fullCount = await gridItems.count();
expect(fullCount).toBe(15);

// Search
await page.keyboard.press('Meta+k');
await page.getByTestId('cmdk-input').fill('IMG_0001');
await page.keyboard.press('Enter');

// Filtered
await expect(gridItems).toHaveCount(1);
await expect(gridItems.first()).toContainText('IMG_0001');

// Clear
await page.getByTestId('facet-clear-all').click();
await expect(gridItems).toHaveCount(15);
```

---

## E2E Test: `facet_filtering_works_and_is_reversible`

### What We're Testing

Facet chips filter correctly and can be cleared.

### Fixture Requirements

`metadata-merge` fixture with varied locations and dates.

### Test Steps

```
1. Import metadata-merge fixture
2. Note initial count
3. Click Location facet chip
4. Select specific location
5. Assert count reduced
6. Assert visible items have that location
7. Click same option to deselect
8. Assert count restored
9. Select two locations
10. Assert count is sum of both
```

### Key Assertions

```typescript
// Initial
const initialCount = await gridItems.count();

// Filter by location
await page.getByTestId('facet-chip-location').click();
await page.getByTestId('facet-option-oslo').click();
const osloCount = await gridItems.count();
expect(osloCount).toBeLessThan(initialCount);

// Deselect
await page.getByTestId('facet-option-oslo').click();
await expect(gridItems).toHaveCount(initialCount);

// Multiple selection
await page.getByTestId('facet-option-oslo').click();
await page.getByTestId('facet-option-bergen').click();
const combinedCount = await gridItems.count();
expect(combinedCount).toBeGreaterThan(osloCount);
```

---

## E2E Test: `saved_view_restores_query`

### What We're Testing

Saving and loading views preserves exact filter state.

### Test Steps

```
1. Import fixture
2. Apply filters (date + location)
3. Save view as "Test View"
4. Navigate away (e.g., to settings)
5. Click saved view in sidebar
6. Assert filters restored
7. Assert results match original
```

### Key Assertions

```typescript
// Apply filters
await page.getByTestId('facet-chip-date').click();
await page.getByTestId('facet-option-thismonth').click();
await page.getByTestId('facet-chip-location').click();
await page.getByTestId('facet-option-oslo').click();

const filteredCount = await gridItems.count();

// Save view
await page.getByTestId('save-view-btn').click();
await page.getByTestId('view-name-input').fill('Test View');
await page.getByTestId('save-view-confirm').click();

// Navigate away
await page.getByTestId('sidebar-item-settings').click();

// Restore view
await page.getByTestId('saved-view-test-view').click();

// Verify
await expect(page.getByTestId('facet-chip-date')).toHaveAttribute('data-active', 'true');
await expect(page.getByTestId('facet-chip-location')).toHaveAttribute('data-active', 'true');
await expect(gridItems).toHaveCount(filteredCount);
```

---

## Acceptance Criteria

### Task 6.1: Query Model
- [ ] Query structure defined
- [ ] All filter types supported
- [ ] Serialization to URL works
- [ ] Default query sensible

### Task 6.2: Query Engine
- [ ] SQL translation correct
- [ ] Indexes created
- [ ] Cursor pagination works
- [ ] < 100ms for typical queries

### Task 6.3: Facet Aggregation
- [ ] Date facets accurate
- [ ] Location facets show top N
- [ ] Camera facets show top N
- [ ] Counts update with filters

### Task 6.4: Facet Chips
- [ ] Chips display counts
- [ ] Dropdowns open/close
- [ ] Selection filters results
- [ ] Clear All works

### Task 6.5: Text Search
- [ ] Instant search works
- [ ] Searches all text fields
- [ ] Empty state shows
- [ ] Debounced appropriately

### Task 6.6: Saved Views
- [ ] Views can be saved
- [ ] Views appear in sidebar
- [ ] Clicking restores query
- [ ] Built-in views exist

### Task 6.7: Performance
- [ ] < 100ms filter response
- [ ] < 500ms initial load
- [ ] Caching works
- [ ] No visible lag

### E2E Tests
- [ ] `cmdk_search_filters_grid` passes
- [ ] `facet_filtering_works_and_is_reversible` passes
- [ ] `saved_view_restores_query` passes
