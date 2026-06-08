---
trigger: always_on
---
Memex E2E-First Development Playbook

Non-negotiable rules

1) “No feature without an E2E”

A feature is not done until:
	•	it is reachable via the real UI
	•	it works end-to-end through Electron ↔ backend ↔ SQLite ↔ renderer
	•	it has an isolated Playwright test proving it

2) Feature vertical slices only

Developers must implement in this order for each feature:
	1.	UI affordance (button/flow)
	2.	Main-process + preload bridge
	3.	Backend endpoint/command + DB changes
	4.	UI rendering + streaming updates
	5.	Playwright E2E that drives the UI
	6.	Merge only when E2E is green

No “build all views first”.

3) Deterministic E2E environment

Every E2E run must:
	•	launch Memex with a fresh app data dir
	•	use a fixture media directory controlled by the test
	•	stub all OS dialogs
	•	disable blur/animations
	•	optionally stub heavy tool outputs (czkawka/exiftool/ffmpeg) via fixture JSON
	•	delete the test app data dir and temp outputs afterward

⸻

E2E-Ready App Contract

A) Test mode flags

Memex must support:
	•	MEMEX_E2E=1
Enables test-mode behavior and extra diagnostics.
	•	MEMEX_USER_DATA_DIR=/tmp/memex-e2e/<testId>
Forces Electron app.setPath('userData', ...) so every test gets an isolated SQLite + cache.
	•	MEMEX_FIXTURE_DIR=/path/to/fixtures/<scenario>
Dialog stubs return this path as the chosen import folder.
	•	MEMEX_DISABLE_EFFECTS=1
Disables blur, transitions, animations, and “fancy” timing.
	•	MEMEX_FIXTURE_TOOL_OUTPUTS=1 (optional but recommended early)
Backend sidecar loads known outputs:
	•	czkawka.json
	•	exiftool.json
	•	ffprobe.json
	•	thumbnail placeholders if you want
This makes tests fast and stable while the real tool integration is built behind a flag.

B) Stable selectors (mandatory)

All E2E-critical elements must have data-testid, for example:
	•	cmdk-open
	•	import-open
	•	import-start
	•	library-grid
	•	grid-item-{virtualMediaId}
	•	tasks-pill
	•	tasks-open
	•	task-row-{jobId}
	•	task-cancel
	•	task-pause
	•	inspector-open
	•	inspector-tab-sources
	•	inspector-tab-audit
	•	filter-chip-date, filter-chip-location, etc.

Also add state attributes where needed:
	•	data-state="loading|ready|error"
	•	data-job-state="running|paused|cancelled|completed|failed"

C) A single E2E “Test API” surface (safe + narrow)

Expose one preload API only in MEMEX_E2E=1:
	•	window.__memexTest.getAppState() → { buildVersion, dbPath, jobCounts }
	•	window.__memexTest.waitForIdle() → resolves when no running jobs
	•	window.__memexTest.getLastToast() → string
	•	window.__memexTest.dumpJobs() → for debugging failures (not for assertions unless needed)

Keep it read-only (or near read-only). Tests should still primarily verify via UI.

⸻

Feature-by-Feature Implementation Tasks (each ends with a Playwright test)

Each task below is a vertical slice: the end result is something a user can do in the UI, and we add a real E2E test for it.

Milestone 0 — E2E Harness (foundation, no product fluff)

Goal: Prove we can launch Electron under Playwright, click UI, and run isolated.

Task 0.1: E2E boot + deterministic mode
	•	Add env flags handling in main process (userData override, disable effects)
	•	Add dialog stub for folder selection when MEMEX_FIXTURE_DIR is set
	•	Add data-testid scaffolding for shell controls
	•	Add __memexTest minimal helpers (optional)

✅ E2E test: app_launches_and_shows_empty_state
	•	Launch with fresh userDataDir
	•	Assert empty state visible
	•	Assert Cmd+K opens command bar
	•	Close app

⸻

Milestone 1 — Import “Hello World” (fake pipeline, real UX)

Goal: User can import a folder and see items appear in the grid, even if we stub backend outputs initially.

Task 1.1: Import wizard flow + start job
	•	Import modal opens (Cmd+I + button)
	•	Stepper exists (Sources → Modules → Advanced → Review)
	•	Start Import creates Job row and closes modal
	•	Switch to Library view
	•	Tasks pill shows “running”

✅ E2E test: import_starts_and_job_visible
	•	Click import
	•	Start
	•	Verify toast “Indexing…”
	•	Verify tasks pill indicates running
	•	Verify tasks popover shows the job

Task 1.2: Streaming library population (stubbed)
	•	Backend creates VirtualMedia rows from fixture manifest (fast)
	•	UI grid subscribes to incremental updates (events or polling)
	•	Grid shows items with dominant color placeholders

✅ E2E test: import_streams_items_into_grid
	•	Start import
	•	Wait for at least N grid items visible
	•	Assert placeholders visible before thumb (if you support that state)
	•	Assert job completes

⸻

Milestone 2 — Jobs Control Surface (pause/cancel/resume/reset)

Goal: The restartability contract exists early, because everything depends on it.

Task 2.1: Tasks popover + Tasks full panel
	•	Popover: running jobs + pause/cancel
	•	Panel: step list + logs + reset outputs + rerun entrypoint

✅ E2E test: job_pause_resume_cancel
	•	Start import (use long-ish fake job)
	•	Pause → UI shows paused
	•	Resume → running
	•	Cancel → cancelled
	•	Confirm grid does not continue to grow after cancel

Task 2.2: Reset outputs (safe, isolated)
	•	“Reset outputs” clears derived data for that job only (thumbs, virtual media, groups) in test DB
	•	Confirm UI returns to empty (for that import)

✅ E2E test: reset_outputs_clears_library_for_run
	•	Import → items appear
	•	Reset outputs
	•	Assert grid becomes empty
	•	Assert job state updated

⸻

Milestone 3 — Canonical vs Sources (dedupe UI contract)

Goal: Inspector shows provenance and sources even if dedupe results are fixture-driven at first.

Task 3.1: Inspector basics
	•	Click grid item opens inspector
	•	Tabs: Info / Sources / Audit / Context (Context gated)
	•	Info shows merged metadata fields + provenance tag

✅ E2E test: inspector_opens_and_shows_provenance

Task 3.2: Sources list and “Make Canonical”
	•	Sources tab lists duplicates in group
	•	Shows CANONICAL/DUPLICATE badges
	•	“Make Canonical” changes canonical selection (virtual-only)
	•	Change logged in Audit

✅ E2E test: make_canonical_updates_grid_and_audit
	•	Import fixture with a known dup group
	•	Open inspector → Sources
	•	Click Make Canonical
	•	Verify canonical badge changes
	•	Verify audit contains entry
	•	Verify grid item updates (e.g. thumb key changed or canonical marker)

⸻

Milestone 4 — Real czkawka_cli integration (behind a flag)

Goal: Swap fixture outputs with real tool outputs without rewriting UI/tests.

Task 4.1: Backend tool runner abstraction
	•	ToolRunner supports:
	•	fixture mode (loads JSON)
	•	real mode (spawns czkawka_cli)
	•	Parsing produces the same internal DTOs either way

✅ E2E test remains the same as Milestone 3, but we add:
	•	czkawka_real_mode_smoke (optional, nightly)
Runs real czkawka on small fixture set.

⸻

Milestone 5 — Metadata merge + edit (ChangeRecords)

Goal: Field-level provenance and manual edit must work and be auditable.

Task 5.1: Merged metadata display
	•	Info tab renders fields with provenance tags
	•	Hover highlights donor source (UI affordance)

✅ E2E test: info_tab_shows_merged_fields_with_provenance

Task 5.2: Inline edit -> ChangeRecord
	•	Click Date Taken, edit, save
	•	Provenance becomes (Manual)
	•	Audit tab contains diff

✅ E2E test: inline_edit_creates_change_record

⸻

Milestone 6 — Search + Facets (query-driven UI)

Goal: Filters change results instantly and are saved as views.

Task 6.1: Command bar search -> query
	•	Cmd+K search updates grid (useTransition)
	•	No blocking; dims old results while pending

✅ E2E test: cmdk_search_filters_grid

Task 6.2: Facet chips
	•	Chips open dropdown with counts
	•	Selecting facet filters grid
	•	Clear filters returns full set

✅ E2E test: facet_filtering_works_and_is_reversible

Task 6.3: Save view
	•	Save current filters as “Smart View”
	•	Appears in sidebar
	•	Clicking it restores query

✅ E2E test: saved_view_restores_query

⸻

Milestone 7 — Place basics (reverse geocode default on)

Goal: Reverse geocode is enabled by default (offline-first), results appear as facets and in inspector.

Task 7.1: Offline reverse geocode provider + caching
	•	Local downloadable geo DB integration (implementation detail)
	•	Cache lookups by coordinate bucket
	•	Attach place hierarchy to VirtualMedia

✅ E2E test: reverse_geocode_adds_location_facet
	•	Fixture includes GPS metadata
	•	After import, Location chip exists and filters work
	•	Inspector shows place string

⸻

Milestone 8 — Color analysis + event detection (defaults)

Goal: Always available, always tested.

Task 8.1: Color analysis facet
	•	Dominant color extraction stored and queryable
	•	Color facet filters results

✅ E2E test: color_facet_filters_results

Task 8.2: Event detection
	•	Cluster into events (time + location + similarity signals)
	•	Timeline view shows event cards (or at least groups)
	•	Clicking event filters grid

✅ E2E test: timeline_event_click_filters_library

⸻

Milestone 9 — Optional modules (faces/objects/AI keywords)

These are large; implement as gated modules with fixture-first tests, then real model integration.

Task 9.1: AI keyword extraction (local model hook)
	•	Pipeline step writes keywords
	•	Keywords become searchable facet + command bar target

✅ E2E test: ai_keywords_appear_and_filter

Task 9.2: Faces module shell (cluster UI)
	•	People view (feature-gated)
	•	Person cluster grid
	•	Click person → shows their photos

✅ E2E test: people_view_cluster_to_photos

(Then later real embeddings/inference behind a flag; E2E stays stable via fixtures.)

⸻

“One command to run” (dev + user)

Make sure the implementation supports:
	•	bun run dev → starts electron + renderer + backend sidecar (watch)
	•	bun run test:e2e → runs Playwright with MEMEX_E2E=1 and isolated dirs
	•	bun run test:e2e -- --project=electron --headed → debug mode

⸻

How developers should work day-to-day

Loop for each feature:
	1.	Add/extend fixture scenario (small media set + expected outcomes)
	2.	Write the Playwright test first (or at least the skeleton)
	3.	Implement the feature slice across UI/main/sidecar/DB
	4.	Ensure streaming events drive UI updates (no hacks)
	5.	Make the E2E green locally
	6.	Commit with:
	•	feature code
	•	E2E test
	•	fixture additions
	•	any new selectors
	7.	Only then start next feature

Code review bar:
	•	If the PR adds UI without new E2E coverage → request changes.
	•	If it adds backend behavior without any UI path → request changes.
	•	If E2E relies on sleeps instead of deterministic waiting → request changes.