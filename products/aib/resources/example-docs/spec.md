Memex

Internal Specification: Functional Requirements, Architecture, UI/UX, Technology Spec, and Developer Guide

Revision: Electron-native shell (cross-platform) + fully automated interactive E2E testing (hard requirement).

	
Target platforms	macOS (arm64/x64), Windows (x64), Linux (x64)
Frontend	React 19.2 + TypeScript + Tailwind CSS 4
Desktop shell	Electron
Backend	.NET 10 (C# 14) sidecar process
Local database	SQLite
External tooling	czkawka_cli (duplicates/similar), ffmpeg (video keyframes), ImageMagick (optional), exiftool (metadata read)
Build tooling	Node 24 LTS + Bun
Testing	xUnit + Moq (C#), Jest (React), Playwright (Electron E2E) with OS stubs

1. Product Overview

Memex is a local-first desktop application for building a searchable personal media library without modifying the original files on disk. Memex continuously imports folders, detects duplicates and similar items using czkawka_cli, selects the best canonical representation per group, and builds a virtual library view. Users can browse and search the virtual library immediately while background processing continues, with first-class support for cancellation, restart, cleanup, and rerun with new parameters.

Primary outcomes:
	•	A fast, query-driven library UI supporting multiple views (grid, map, timeline, calendar heatmap, table).
	•	Non-destructive defaults: no file moves/renames or edits to source media; all library organization and metadata changes are virtual and stored in SQLite.
	•	Streaming, robust pipelines: every processing stage streams progress events and can be cancelled, paused, cleaned, or rerun with different parameters.
	•	Optional enrichments (local recognition and external context) add searchable dimensions (e.g. people, objects, weather, events) to photos and videos without requiring cloud services.

Non-goals (v1):
	•	Automatic on-disk reorganization of source files (physical moving/renaming). Memex is virtual-only by default; an explicit Export feature is a planned future addition.
	•	NAS or server-mode operation. A CLI exists for local development and diagnostics only, but Memex is not intended to run as a continual server or on remote storage in v1.

2. Functional Requirements

2.1 Import and Background Indexing
	•	Source selection: The user selects one or more source folders on disk to include in the library.
	•	Configurable profiles: Before starting, the user can accept defaults or adjust an advanced import profile (toggling modules and tuning parameters per module).
	•	Progressive indexing: Import runs in the background. Content appears in the library incrementally as soon as it is indexed (no need to wait for the entire import to finish to see results).
	•	Resumable and restartable: Imports are resumable. The user can cancel an ongoing import, and Memex can reset intermediate outputs and rerun the pipeline with new settings if needed.

2.2 Duplicate and Similar Detection (czkawka_cli)
	•	Local duplicate scan: Memex runs czkawka_cli locally to detect exact duplicate files and visually similar images.
	•	Incremental grouping: Memex parses czkawka’s JSON results incrementally, creating and updating duplicate groups in the SQLite database as data streams in.
	•	Content-quality scoring: For each group, Memex computes a numeric content-quality score based on factors like image resolution, format preference (e.g. RAW vs JPEG), and bitrate or file size as tie-breakers. This yields a consistent ranking of items by visual/audio quality.
	•	Canonical asset selection: Memex chooses a canonical “best” asset per group for the virtual library view, while retaining all sources and their details in the group record. The canonical selection is based purely on content quality metrics (ensuring the highest fidelity version is chosen). Metadata from non-canonical duplicates is still preserved and will be merged in a later step so that the best metadata (e.g. timestamps, tags) can be applied even if it comes from a different file than the best image.

Example: If two photos are duplicates but one is a high-resolution image with no EXIF data and the other is lower resolution with correct timestamps, Memex will choose the high-resolution photo as canonical for display, and later merge the timestamp from the other photo into the canonical record.

To illustrate the scoring, here is a simplified pseudocode for how a content-quality score might be computed for images:

// Example scoring function for image quality
double ScoreImage(Asset asset) {
    double score = 0;
    // Prefer raw formats slightly over processed formats
    if (asset.Format == ImageFormat.RAW) score += 5;
    else if (asset.Format == ImageFormat.JPEG) score += 4;
    // Higher resolution increases score
    score += asset.PixelWidth * asset.PixelHeight / 1_000_000.0; // megapixels
    // Larger file size (less compression) increases score slightly
    score += asset.FileSizeBytes / (1024.0 * 1024.0 * 10.0); // per 10 MB
    return score;
}

// Example: pick the asset with max score as canonical
Asset canonical = group.Assets.MaxBy(a => ScoreImage(a));

(The actual implementation can refine these weights and include video bitrate for videos, etc.)

2.3 Video Handling
	•	Video metadata: Memex indexes video files alongside photos, extracting metadata such as duration, resolution, creation timestamps, and codec information.
	•	Near-duplicate video detection (optional): If enabled and within resource budget, Memex can extract keyframes using ffmpeg and compute perceptual hashes to detect near-duplicate or highly similar videos. This step is computationally heavy and will be gated by a user setting or “aggressive” profile.
	•	Video presentation: Videos appear in the library with poster frame thumbnails or animated previews. Full playback of the actual video content only occurs in a detail/viewer mode (not directly in the thumbnail grid) to avoid heavy resource usage in the main gallery.

2.4 Metadata Extraction and Merge (virtual, audited)
	•	Multi-source metadata extraction: For each file, Memex gathers metadata from multiple sources: embedded EXIF (for images) or QuickTime/MP4 atoms (for videos), XMP sidecar files, optional Google Takeout JSON or other sidecar metadata, filename/path pattern (e.g. timestamps in filenames or folder names), and filesystem attributes (create/modified timestamps).
	•	Conflict resolution: Memex resolves metadata conflicts using configurable precedence rules and smart heuristics. For example, a GPS timestamp might be preferred over a photo’s EXIF DateTime if they differ, or an EXIF DateTime is preferred over just a date with no time. Obvious placeholders or invalid dates (e.g. timestamps of 1970-01-01 or 0000-00-00) are ignored in favor of other sources. The precedence of sources is configurable (e.g. user could set EXIF > XMP > JSON > Filename > Filesystem by default), and filename/path metadata is treated as a first-class source – if a filename contains a plausible date or other info that other sources lack, it will be used and not merely regarded as a last-resort fallback.
	•	Merge audit trail: Memex stores an audit trail of how metadata was merged. For each virtual media item, it records which source contributed each field, any confidence or quality score for that field, and notes if any conflicts were resolved (and how). This audit trail (in a ChangeRecord log) allows users to trace back where each piece of displayed metadata came from.
	•	Non-destructive merge: By default, Memex does not write any metadata back to the source files. Merged metadata for the canonical library entry is stored in the database as proposed or virtual values. (Future versions might offer an explicit write-back or sidecar export, but in v1 all merges are virtual only and can be reverted.)

2.5 Name Cleanup (virtual naming)
	•	Canonical naming rules: Memex derives a human-friendly canonical display name for each item (e.g. a photo) using configurable rules. For example, a default rule might format a date-based name like YYYYMMDD_HHMMSS_IMG_1234 or similar, or preserve part of the original filename while removing noise.
	•	Noise removal: The naming rules can strip out common “noise” substrings from filenames, such as resolution suffixes (e.g. _1080p), camera model codes, location text that was appended by some importers, GUIDs or hashes, etc. This yields cleaner names for display.
	•	No on-disk renaming: Canonical names are stored in the SQLite database and used in the virtual library UI and exports. The original files on disk are never renamed or moved by default. The name normalization is purely for virtual presentation and organization.

2.6 Thumbnails, Placeholders, and Color
	•	Thumbnail generation: Memex generates and caches thumbnails for images and videos to enable fast rendering in the UI. Thumbnails are stored in an application-managed cache directory (not alongside the originals). Only canonical assets (one per duplicate group) have thumbnails generated by default, avoiding duplicate work for multiple copies of the same image.
	•	Visual placeholders: Memex can compute a dominant color and/or a blurred tiny image as a placeholder for each item. These placeholders are stored (e.g. as a single color or low-res data URI) and allow the UI to instantly display a colored background or blur while the detailed thumbnail is loading, improving perceived performance.
	•	On-demand prioritization: Thumbnail generation is prioritized for items likely to be seen soon. For example, when the user is scrolling, Memex will prioritize generating thumbnails for items in or near the current viewport. This “viewport-first scheduling” ensures smooth scrolling. Items out of view will have their thumbnails generated later or on-demand.

2.7 Optional Modules (toggle at import)
	•	Face recognition (local): Detect faces in photos, compute face embeddings, and cluster similar faces to identify individuals. The user can review and label these clusters (e.g. assign names to people). The system supports cluster management operations such as merging clusters that refer to the same person or splitting a cluster if it grouped different people erroneously.
	•	Object recognition (local): Detect objects in images (pets, cars, landmarks, etc.) using local ML models. Compute embeddings and cluster similar objects together (e.g. all photos containing the same pet or type of object). As with faces, clusters can be labeled and managed by the user.
	•	AI image analysis (local): Use local AI models to extract descriptive keywords and scene information from images (e.g. “beach”, “sunset”, “birthday party”). These automatically generated tags become filterable facets in the library (marked as AI-generated so users know the source).
	•	External enrichment (plugin-based): Integrate external contextual data to enrich media (all external calls are opt-in). This can include:
	•	Reverse geocoding: Convert GPS coordinates to human-readable locations (e.g. city, landmark names). This is enabled by default if location data is present, using a local offline database if available (to avoid network calls). If an online service is used, it must be explicitly enabled by the user.
	•	Weather lookup: Retrieve historical weather information for the date/time and location of a photo (e.g. temperature, conditions). This uses a low-cost external API or dataset and caches results to avoid repeated calls. (For example, if many photos are taken on the same day in the same city, the weather info is fetched once and reused.) The module is optional and focuses on lightweight, cheap calls.
	•	Event context (GLEP): A “Global/Local Event Provider” plugin can provide context such as local holidays, global news events, or “on this day in history” facts relevant to the media’s timestamp and location. This is also optional and should rank results by relevance to avoid cluttering the UI with trivial events.
	•	Other providers: The framework can support other plugins (e.g. pulling nearby landmark info, translation of foreign text in images, etc.) which can be toggled by the user. All external enrichments are off unless explicitly enabled (except reverse geocode which is on-by-default using offline data).

(All optional modules are selected at import time via toggles. If a user does a “safe” import with no optional modules, Memex will skip these steps. If using the standard profile, some modules like deduplication, metadata normalization, color analysis, and event detection are enabled by default as they run locally and enhance the library without external dependencies.)

2.8 Virtual Library Presentation (no destructive writes)
	•	Canonical virtual entries: Memex represents each logical item in the library as a VirtualMedia entry in the database. A virtual media entry links to the chosen canonical asset’s ID (the file on disk), and includes the merged metadata and canonical display name for that item. In effect, for each group of duplicates or each standalone file, there is one VirtualMedia record that the UI will treat as an item in the library.
	•	Original files untouched: The UI presents these virtual items as if they are a consolidated, cleaned-up library, but the actual source files remain untouched on disk in their original locations. Any organizational structure (albums, events, etc.) is virtual. The user’s files are not moved, renamed, or altered by Memex during import or organization.
	•	Inspector & provenance: The application provides an Inspector view (details panel) for each virtual item where the user can see the full provenance of that item. This includes all duplicate sources that were grouped (with their original filenames, paths, and file-specific details), per-source metadata (what each file’s metadata was), and which source was used as the donor for each field in the merged result. This transparency lets the user verify and trust the merge process and, if needed, override decisions (e.g. pick a different photo as the canonical representative or manually edit a field).

2.9 Export (future)
	•	Virtual export (copy-out): Memex will support exporting a set of selected items (for example, all items in a saved view, or the entire library) to a user-specified folder structure on disk. This export operation will copy the files (using the canonical versions and optionally renaming them to the canonical names or organizing by date/album) into the new structure. The original source files remain unmodified; export is non-destructive.
	•	Preview and confirmation: Because export is the one operation that writes files to disk (outside of Memex’s own cache), the app will provide a detailed preview of what will happen. The user should be able to see the proposed folder structure and file naming for the export and confirm it before proceeding.
	•	Reversible and audited: The export is designed to be reversible/separable from the original library. For instance, exported files could have sidecar metadata files or a manifest to allow re-import or verification. Memex will log an export report detailing which virtual items were exported to which new filenames, so users have an audit trail. No changes will ever be made to the original source locations as part of export.

3. Non-functional Requirements

3.1 UX Responsiveness
	•	Smooth performance: The UI must remain snappy and smooth even with large libraries. Scrolling through a grid of tens of thousands of photos should maintain ~60fps via UI virtualization and efficient rendering. Applying or changing a filter should feel immediate (under ~100ms for feedback) by utilizing incremental querying and preview results.
	•	Non-blocking interaction: There is no point in the UX where the user must “wait for everything to finish.” As soon as any results are available (even partially), they should be displayed. The user can start browsing and interacting with imported items while other items are still being processed in the background.
	•	Streaming updates: All long-running operations (imports, analysis tasks, etc.) emit progress events continuously. The UI updates progressively (e.g. showing new photos as they get indexed, updating progress bars) rather than freezing or only showing completion at the end.
	•	Concurrent browsing: Library browsing and interactions remain responsive even during heavy background processing. The indexing and enrichment pipeline runs outside the UI thread (in a separate backend process), and the frontend is designed to handle updates asynchronously. The user should be able to scroll, open detail views, or adjust filters with minimal lag while background tasks are running.

3.2 Restartability and Idempotence
	•	Reset and rerun: Every step of the pipeline is designed to be restartable. The system can safely clear a step’s outputs (e.g. thumbnails, or duplicate groups) and recompute them with new parameters without corrupting the overall database. This supports scenarios like the user changing a setting and re-running the dedup step.
	•	Checkpointing: Intermediate outputs and state are checkpointed in the database or cache. Partial completion of the pipeline should not leave the system in an inconsistent state. For example, if an import is canceled during the enrichment step, all completed steps up to that point remain valid, and the enrichment step can be resumed or restarted later.
	•	Cooperative cancellation: Long-running steps regularly check for cancellation signals (e.g. a CancellationToken in the backend). If the user requests a cancel, the step will stop at a safe point and clean up if necessary (closing files, rolling back any incomplete operations). Cancellation never leaves the database in a corrupt state.
	•	Idempotent operations: Pipeline operations produce consistent results given the same inputs. Running the same step twice (with the same parameters) yields the same outcome, and intermediate data can be re-used if it hasn’t changed. This prevents duplicates in the database if a step is accidentally triggered multiple times.

3.3 Safety and Privacy
	•	Local-first by default: By default, all processing is done locally. The application does not require internet access to function. External enrichment features are opt-in per provider. A fresh install of Memex will not make any network requests unless the user specifically enables a feature that needs it (and even then, only for that feature).
	•	No destructive actions on sources: Memex will not modify or delete user’s source files as part of its normal operations. There are no surprise side-effects on the filesystem. Even deletion of duplicates is treated virtually (users might “mark” one as redundant in the UI, but Memex will just record that choice and hide it; it won’t actually delete the file from disk without explicit user action).
	•	Isolated cache and data: All caches, thumbnails, databases, and derived data are stored in a dedicated application data directory (separate from the source folders). The user can delete the Memex cache/data directory at any time to essentially “reset” the app (though they would lose the indexed data and have to re-import). This isolation ensures that original media folders are not cluttered with application files and that a full clean-up of Memex is straightforward.
	•	Privacy of data: No personal media or metadata is uploaded to any cloud or external service by default. If the user enables an external enrichment (e.g. reverse geocoding via an online API), that specific data (like GPS coordinates) will be sent to that service, but only for the intended lookup. Memex should make these behaviors clear and allow opting out. Additionally, any telemetry or update checks the app performs will be minimal and disclosed (for an internal tool, likely none or optional).

3.4 Architecture Gates (A1/A2/A3/M31/M32)
	•	A1 DB scalability: use binary embeddings (no JSON), GPS multi-resolution + simplification, facet cache with coherent invalidation, index audits, and benchmark harnesses for large datasets.
	•	A2 RPC scalability: stream bulk responses, implement backpressure and bounded pending maps, use correlation IDs/structured tracing, and make framing/channel decisions explicit.
	•	A3 UI performance: containment boundaries, no per-item layer promotion, lazy decode + placeholders, map hover throttling, GPU diagnostics behind opt-in settings, and WebGL only as a gated spike with a11y parity.
	•	M31 settings schema: all user-facing knobs are defined in a single settings schema; no ad-hoc persistence.
	•	M32 UI modernization: hierarchy patterns use breadcrumb/path search/selection summaries, and `data-testid` hooks remain stable across redesigns.

4. Architecture (Electron-native Shell)

4.1 High-level Components

The Memex application is structured into several components, each with clear responsibilities and technology choices:

Component	Responsibilities	Tech Stack
Renderer (UI)	Runs the React-based frontend: handles navigation, renders query results (virtualized grids, maps, timelines, etc.), provides inspectors and configuration dialogs, and updates the UI in response to state changes. Basically, the entire user interface lives here.	React 19.2, TypeScript, Tailwind CSS 4
Main process	Manages the desktop application lifecycle and OS integration. Responsible for creating BrowserWindows, handling menus, tray, native dialogs, file system access (via Node), and spawning or communicating with the backend sidecar process. Also enforces security boundaries between the UI and backend.	Electron (Node.js)
Preload/bridge	A small isolated context that loads before the renderer. Exposes a typed, minimal API surface to the renderer for allowed operations (via contextBridge). It mediates communication between the Renderer and Main process using IPC, ensuring the Renderer stays sandboxed with no direct Node access.	Electron preload scripts + IPC (Inter-Process Communication)
Backend sidecar	A separate process (spawned by the main process) that executes the indexing and enrichment pipeline, handles database operations, and serves queries. This is where heavy lifting happens: duplicate detection coordination, metadata parsing, image processing, etc. It exposes a controlled interface (e.g., RPC or IPC handlers) for the main process to invoke pipeline actions or fetch query results.	.NET 10 (C# 14)
External tools	External CLI tools that are invoked by the backend for specific tasks: finding duplicates, extracting metadata, generating thumbnails, etc. These run as child processes when needed, and their outputs are parsed.	czkawka_cli (Rust) for duplicates, exiftool for metadata, ffmpeg for video processing, ImageMagick for any image transformations if needed
Local storage	Files and databases that Memex maintains on the local disk to store its processed data. This includes the main SQLite database (media index, metadata, logs), a thumbnails cache directory, and any intermediate files or logs.	SQLite database files, plus cache directories on disk for things like thumbnails and AI model data

4.2 Process Model and IPC

Memex is a multi-process application by design, leveraging Electron’s architecture:
	•	Renderer Process (UI): Runs the React app inside a Chromium renderer. It does not have direct access to Node.js or the filesystem (for security, nodeIntegration is off). It interacts with the rest of the system through a controlled preload bridge.
	•	Main Process: Runs in Node.js, starting when the application launches. It opens the application windows (renderer processes) and handles OS-level interactions. Critically, it spawns the .NET backend sidecar process and manages its lifecycle (start on app open, restart if needed, kill on app close). The main process also mediates all communication between the renderer and the sidecar.
	•	Backend Sidecar Process: A .NET 10 process that runs in the background. The heavy pipeline and database operations run here, isolated from the UI. The sidecar could be a console application or service that listens for commands (like “index this folder” or “execute query”) and sends back results/events.
	•	IPC Communication:
	•	Renderer ↔ Preload: The renderer calls exposed functions (e.g. window.MemexAPI.selectFolder()), which the preload script defines. The preload forwards these to the main process via Electron’s IPC. The renderer never directly uses Node APIs.
	•	Preload/Main IPC: The bridge between Renderer and Main uses IPC invoke/handle or send/on channels. For example, the renderer might invoke ipcRenderer.invoke('import:start', params) which the main process handles, then main might call into the sidecar.
	•	Main ↔ Sidecar: The main process communicates with the .NET sidecar via a platform-appropriate mechanism. Preferred is a lightweight RPC over stdio (the sidecar could read JSON commands from stdin and write results to stdout). Alternatives are a local named pipe or domain socket, or hosting a local HTTP/gRPC server. In any case, the contract is well-defined and secured (only accessible by the app).
	•	Sidecar → Main (Events): The sidecar pushes real-time events (progress, completion, etc.) back to the main process, which forwards them to the renderer via IPC. This way, the UI can react to pipeline progress.
	•	Security defaults: The following Electron security practices are required:
	•	contextIsolation: true and nodeIntegration: false for renderer windows. The renderer cannot directly execute arbitrary Node code.
	•	Use a minimal, capability-based preload API. Only expose specific whitelisted actions (like selecting a folder, or initiating an import). Do not expose general eval or filesystem primitives directly to the renderer.
	•	Sandbox renderer processes where possible and disable any remote module or deprecated IPC that might open vulnerabilities. The renderer should not be able to launch new windows or do anything outside its allowed API.
	•	Validate all IPC messages and inputs in the main and sidecar. The IPC command set should be versioned or have strict schemas; unknown or malformed messages are rejected. This prevents a compromised renderer from sending unexpected commands to the backend.
	•	Keep the sidecar interface narrow. Only allow specific operations (scans, queries, etc.), and include authentication or handshake as needed to ensure it’s really the Electron app talking and not an external process.

(In summary, the architecture ensures the UI is decoupled from heavy processing and that all interactions go through controlled channels. The renderer is kept as a pure view layer with no direct file or network access.)

4.3 Streaming Pipeline Design

The media processing pipeline is broken into distinct steps, each of which runs in the sidecar and streams out progress events. All steps are designed to be streaming, cancelable, and restartable. The pipeline steps execute roughly in the following sequence for an import:
	1.	Discover: Enumerate files in the selected source folders. Respect include/exclude patterns or allowed file extensions set by the user. As files are discovered, create initial Asset entries in the database for each file path (with minimal info like path and perhaps a quick hash or size).
	2.	Fingerprint: Compute hashes and basic media properties. This may include a content hash (for exact duplicate detection), file size, dimensions for images, and video codec info. Store these in the Asset record. Mark the asset as fingerprinted when done. Emit progress as each file is processed.
	3.	Duplicate detect: Invoke czkawka_cli to identify duplicates and similar images across the dataset. Memex will likely call czkawka in batches or on the entire set depending on size. Parse czkawka’s JSON output incrementally (line by line or chunk by chunk) as it arrives. As duplicate groups are identified, create DuplicateGroup entries in the database and GroupMember mappings linking Asset IDs to groups. Emit events for progress (e.g. how many files analyzed vs total).
	4.	Metadata extract: Run exiftool (in batch mode if possible) on new files to extract embedded metadata. In parallel or afterward, parse any sidecar files (XMP, JSON) and apply regexes to filenames for date/time. Each source yields a set of MetadataCandidate records (e.g. one for EXIF data, one for filename-derived date, etc.) linked to the Asset. This step is streaming – for example, process a file or a batch, then send progress events and move on.
	5.	Merge & score: For each Asset (or rather each duplicate group), resolve the multiple metadata candidates into a single merged metadata record. Also compute the content score for each member in a duplicate group (as described in 2.2) and decide the canonical asset. Update the DuplicateGroup with the chosen canonical AssetId and store the quality score breakdown for reference. Create a VirtualMedia entry representing the group’s consolidated item, including the chosen asset and the merged metadata (and a generated canonical name). Log a ChangeRecord for the merge decisions so that the audit trail is preserved.
	6.	Thumbnails & placeholders: For each VirtualMedia (each canonical item), generate a thumbnail image for quick viewing. For images, this might involve resizing; for videos, grabbing a frame via ffmpeg. Store the thumbnail in the cache and note its path in a ThumbCache table or similar. Also compute the dominant color and blur hash for the image and store those (to show as placeholders). This step should prioritize items that are currently visible or recently added, and can defer others. Emit progress as thumbs are completed.
	7.	Facet index: Update the search index and facets. This means computing any aggregated data needed for fast querying: time buckets (for timeline or calendar views), geographic clustering (for map view), camera model lists, people and object labels (if those modules ran), colors, etc. Update the corresponding facet tables or index structures. Emit an event when new facets or counts are available so the UI can update filters.
	8.	Optional enrichments: If external or heavy enrichment modules were enabled, fan out those tasks now (or concurrently where possible). For example, send GPS coordinates to a reverse geocoder service (or local database) to get place names, query the weather service for dates, run face recognition on images, etc. Each enrichment might run as its own mini-pipeline or batch. Each should cache its results (so we don’t call the same API repeatedly for the same coordinate or date). As enrichments complete, attach the resulting data to the relevant VirtualMedia records (e.g. attach “Paris, France” as the city for that photo, or tag a photo with “sunny” weather). Emit progress events and possibly intermediate results (like “50/200 faces recognized”).

Throughout the pipeline, every step emits task.progress events (with context about what file or group is being processed) and can be cancelled by the user. Additionally, the state of each step’s completion is recorded, so if an import is resumed, Memex knows which steps have finished for which files and can pick up where it left off (or re-run a particular stage if the user changed a setting).

4.4 SQLite Data Model (core tables)

Memex uses a SQLite database to store both the library index and the pipeline state. Key tables (and their roles) include:
	•	Asset – Represents each physical media file discovered. Contains fields like file path, file size, format, basic properties (dimensions, duration), hash values (for duplicates), and status flags for each processing step (fingerprinted, metadata extracted, etc.).
	•	DuplicateGroup and GroupMember – Represents groups of duplicate or similar items. A DuplicateGroup has an ID and may store an overall representative (canonical Asset ID) and perhaps a representative score. GroupMember maps each Asset to a DuplicateGroup and can store that asset’s content score breakdown or any other per-member info (e.g. difference percentage for similar images).
	•	VirtualMedia – Represents a canonical library item (the thing shown to the user). For each DuplicateGroup (or for each standalone asset that had no duplicates), there is one VirtualMedia entry. It links to the chosen Asset (by assetId) as the content source. It also stores the merged metadata (date, location, etc.), the canonical display name, and any flags (e.g. marked as favorite, hidden, etc.). Think of this as the “virtual file” that the user interacts with.
	•	MetadataCandidate – Stores metadata extracted from various sources for each asset. For example, for one photo asset, you might have one row for EXIF data, one for an XMP sidecar, one for “filename parse result.” Each row would indicate the source type and have the fields that were extracted (possibly in a JSON blob or a separate related table for values). This is used in the merge step.
	•	ChangeRecord – An audit log of merges and user edits. Every time Memex decides a field value (especially if there were multiple candidates or a conflict), it can record a ChangeRecord noting which sources contributed and how the conflict was resolved. Also, any time a user manually overrides something (e.g. manually edits a date or marks a different photo as canonical in a group), a ChangeRecord is logged. This allows undo/redo and traceability.
	•	ThumbCache – Records for thumbnails and placeholders. At minimum it might map an Asset or VirtualMedia ID to a thumbnail file path or binary blob, and store the associated dominant color or blur hash string for that item. This makes it quick to retrieve a thumbnail or placeholder by item ID when rendering the UI.
	•	Job / JobStep / JobLog – Tracks pipeline runs (imports, tasks). A Job entry might store an import session with its start time, parameters (which folders, which modules), etc. JobStep could detail each pipeline step’s state (completed, error, etc., with timestamps or checkpoints). JobLog could store detailed log messages or events for that job (alternatively, logs might just go to a file, but having them in DB allows showing them in UI). This helps in resuming jobs and providing the user with a detailed report of what happened.

(The actual schema will have more tables for things like face embeddings, object tags, etc., corresponding to optional modules, but the above are the core for basic operation.)

4.5 Event Streaming Contract

The main process and renderer communicate with the backend via events (in addition to request-response calls for queries). The sidecar emits structured events that describe task progress and library updates. These events include:
	•	task.started – Indicates a background job has started. Payload: { taskId, type, startedAt, parametersSummary } (e.g. taskId is a GUID or number, type might be “import” or “face_recognition”, and a short summary of what’s being processed).
	•	task.progress – Reports progress on an ongoing task. Payload: { taskId, step, current, total, percent, message, context }. Here, step might be an identifier like “fingerprint” or “thumbs”, current/total gives numeric progress, percent is an overall percentage (0-100), message is a human-readable status (e.g. “Hashing 1234.jpg”), and context could include additional info like the name of the file or group currently being processed. This event should be emitted frequently to update UI progress bars. (Throughput or ETA can be included in the message or context if available – e.g. “50 files/min, ~2m remaining”.)
	•	task.warning – Reports a non-fatal issue. Payload: { taskId, step, code, message, context }. Example: a photo’s EXIF is corrupted, or a network lookup failed but will retry. The code might be an internal code for the type of warning, message is a user-readable description, and context might contain specifics like the file path or the provider that failed. Warnings don’t stop the task but are logged for user awareness.
	•	task.error – Reports a fatal error in a task (which may abort that task or that step). Payload: { taskId, step, code, message, context, isRetriable }. For example, if the database disk is full or an unexpected exception occurs. isRetriable indicates if the operation can be retried (maybe not if it’s disk full, but yes if it’s a network timeout, for instance). The UI will surface these prominently.
	•	task.completed – Indicates a background job has finished. Payload: { taskId, finishedAt, summary }. The summary might include counts of items processed, number of duplicates found, any errors/warnings count, etc. This lets the UI know to finalize progress bars and perhaps show a toast that import X is done.
	•	index.media.upserted – Sent when new media items (VirtualMedia) have been added or updated in the index. This happens during import as new files are processed, or if an item’s metadata is later enriched/changed. The payload might include an array of item IDs or the full records that were added/changed. The UI listens to this to immediately reflect new items in the library view.
	•	index.media.removed – Sent if media items were removed from the index (e.g. if a source folder is removed from Memex or an item is explicitly deleted from the library). Payload might include item IDs removed. (Removal is rare in v1, since we don’t auto-delete missing files except on explicit user action).
	•	index.facets.updated – Emitted when the availability of facet values (like people, places, dates) changes, for instance after an enrichment step completes. Payload could be which facet or a set of facet counts. The UI can use this to update filter options (e.g. new people detected, or a location name added).

These events allow the UI to stay in sync with the backend’s progress and state. The design is such that if the user starts an import, they will see events for each stage starting and progressing, new photos populating in real time, and can even cancel if needed and see the cancellation confirmed via task.completed or an error event.

5. UI/UX Specification

5.1 Import-First User Experience
	•	Immediate usability: Memex emphasizes that users can start exploring their library immediately upon import. After the user initiates an import, the application does not block the UI; instead, it begins showing newly discovered media right away. For example, as soon as the first batch of files is scanned and thumbnailed, they appear in the library view for browsing.
	•	Background operation: Deduplication and cleanup happen in the background without requiring user intervention at the moment of import. The user is not forced into a dedicated “wizard” to fix duplicates or fill metadata; those improvements simply happen and the library view updates as better data (like merged metadata or identified duplicates) becomes available. It’s an “always-on” benefit rather than a modal workflow.
	•	Cancel and adjust: The user can cancel an ongoing import from the UI at any time (e.g. if they realize they pointed to the wrong folder or want to change settings). After cancellation, any partially processed results can be kept or discarded based on user choice (Memex will offer to clean up intermediate data if desired).
	•	Empty state onboarding: When Memex is first opened with no folders imported yet (or the library is empty), the UI should present a friendly onboarding state. For example, a prompt like “No media imported yet – click here to add a folder” or an import button prominently in the interface. This guides the user to start an import. Once at least one source is added, the normal library UI is shown.

5.2 Import Wizard (Configuration & Modules)

When the user chooses to add/import folders, a multi-step wizard or dialog is presented to configure the import. The steps are:
	•	Step 1: Select Sources – The user picks one or more folders to import. This includes options for include/exclude patterns or file types (e.g. maybe the user can restrict to photos only, or exclude .tmp files, etc.). By default, common media extensions will be allowed (JPEG, PNG, HEIC, MP4, MOV, etc.). The UI should clearly show the folders chosen and total files found (if quick scanning is possible).
	•	Step 2: Select Modules – The user can toggle which optional processing modules to run during this import. This includes:
	•	Deduplication (exact & similar matches)
	•	Metadata cleanup (date reconciliation, etc.)
	•	Name cleanup (virtual renaming)
	•	Face recognition (local)
	•	Object recognition (local)
	•	AI analysis (keywords/scene)
	•	Thumbnails & placeholders
	•	Color analysis (dominant color extraction)
	•	Event detection (automatic grouping of photos into events/trips by time/location)
	•	Reverse geocoding (place names from GPS) – default on
	•	Weather enrichment – optional
	•	GLEP (Global/Local Event context) – optional
	•	Any other external plugin providers.
Each of these can have a brief description. By default, the “Standard” profile will have a safe set of modules pre-selected (for example: deduplication, metadata cleanup, name cleanup, thumbnails, color analysis, event detection, and reverse geocoding might be enabled by default because they are local or use local data, whereas face/object recognition and weather might be off by default due to performance or external calls). The user can customize as needed. All modules are optional in the sense that the user can disable ones they don’t want to run for that import.
	•	Step 3: Advanced Parameters – For each module or overall, allow tweaking advanced settings. This might include:
	•	Similarity threshold for image dedup (how similar is considered a match).
	•	Face recognition sensitivity or minimum face size.
	•	Object recognition model selection (if multiple models or toggling certain object categories).
	•	AI analysis depth or number of keywords to generate.
	•	Reverse geocode mode (offline DB vs online API).
	•	Weather provider selection, etc.
These will have sensible defaults. There should also be preset configurations or “profiles” such as Safe, Standard, Aggressive:
	•	Safe: minimal processing – perhaps no external calls at all, only deduplication and basic metadata. Fastest and least invasive (good for a quick import or very privacy-conscious run).
	•	Standard: a balanced default – includes deduplication, basic metadata merge, local enrichments like color/event detection, and maybe offline reverse geocoding. No heavy ML like face recognition unless explicitly turned on.
	•	Aggressive/Full: turns on all modules, including heavy local ML (face/object recognition) and external lookups (weather, online reverse geocode if needed). This yields the richest data but will consume more time and CPU, and possibly network.
The UI might let the user choose one of these presets and then tweak individual settings if they want.
	•	Step 4: Review & Start Import – The final step shows a summary of the chosen settings (e.g. “3 folders, 10,000 files. Modules: Dedup=On, Faces=Off, Objects=Off, Color=On, EventDetection=On, ReverseGeocode=On (offline), Weather=Off, …”). The user can review and confirm everything. Once they click Start, the import begins immediately. During the import, the UI should always display a Cancel button to abort. Additionally, an option to Reset outputs might be provided (especially if re-running an import) – this would clear previous results for the selected folders so the pipeline can start fresh.

Throughout the import wizard, the UI should make it clear that defaults are generally fine (so non-expert users can just hit go with the standard profile). Also, any potentially slow or privacy-affecting module (like face recognition or external calls) should be indicated as such (maybe with an icon or warning text, e.g. “📶 External service” or “💾 High CPU”).

5.3 Library Views and Layouts

Memex’s library can be viewed in multiple ways to suit different user needs. All views are essentially different presentations of the same underlying query/filter mechanism.
	•	Grid view: A typical photo grid with thumbnails. It should be highly optimized: use windowing/virtualization so that only the images in view are actually rendered. Thumbnails appear quickly, and before they load, a placeholder (dominant color or blur) is shown to indicate something is there. The grid supports infinite scroll. Users can select items (for batch actions in the future) and possibly adjust thumbnail size with a slider.
	•	Map view: A world or map view plotting photos by location (for photos with GPS or located via reverse geocoding). Clustering is used when zoomed out (showing, e.g. “123 photos in New York” as a cluster marker). Users can zoom in to see individual photos or small clusters. There may be tools like lasso-select or region select to filter by area. If enabled, home/work locations can be inferred by clusters and possibly marked (this is an enrichment that could be added, not core v1).
	•	Timeline view: A chronological view of photos grouped by time periods. This could be a vertical timeline or horizontal. The timeline might group events (e.g. a weekend trip, a day’s photos) into collapsible sections with representative images. Zoom levels could allow grouping by decade/year/month/day. Event detection (from the pipeline) would feed into this, so the UI might highlight probable “events” (clusters of photos in time and space) on the timeline with a label (like “Weekend in London” if location data is present).
	•	Calendar heatmap: A calendar or heatmap view that shows a calendar (or timeline heatmap) with days colored by number of photos. For instance, a year view with 365 squares, or a month view. The user can see activity over time at a glance (e.g. which days/months have lots of photos). Clicking on a day would filter the library to that day’s photos (opening a grid or timeline of that day).
	•	Table view: A more textual, spreadsheet-like view for power users. Each row is a media item (virtual media). Columns might include Date, File Name (original vs canonical), Camera Model, Resolution, File Size, etc. The user can sort by any column, group by certain fields (maybe group by camera or by location to see counts), and perform multi-select. This view is useful for data cleanup or bulk operations. It could also allow the user to export the data (e.g. export a CSV of metadata, or quickly copy a path).
	•	Search & filter UI: Not a separate view, but across all these views there is a common filtering interface (e.g. a search bar and a filters sidebar or menu). The user can filter by text (matching filenames, tags, etc.), by date range (timeline or date picker), by people, by location, by camera, by file type, etc. The UI should update the view in real-time as filters are applied. The state of these filters constitutes the current query.

(All views should allow toggling to another view without losing the current filter. For example, a user filters to “2019, tagged with Mom” and is in grid view; they should be able to switch to map view or timeline and see the same filtered set presented spatially or chronologically.)

5.4 Inspector (Provenance-Focused Details)

When a user selects a specific item (virtual media entry) – for instance, clicking on a photo in the grid or pressing an “info” button – the Inspector panel or dialog shows detailed information and controls for that item. Key sections in the Inspector:
	•	Details tab: Shows the consolidated metadata and properties of the item. This includes the canonical filename (virtual name), date/time, location (with place names if available), camera model, dimensions, file size, any tags or AI keywords, etc. It also indicates confidence or any warnings (e.g. “Date estimated from filename” or “Location approximated from nearest known point”). This tab is basically “what Memex knows about this item.”
	•	Duplicates tab: (If the item has duplicates/similars) Lists all other files in the same duplicate group. Each entry shows the file name and path, maybe a small thumbnail or icon, file size, resolution, and the content score that was computed. The currently chosen canonical file is highlighted. There could be a button to “Make this one canonical instead” on each alternate, allowing the user to override Memex’s automatic choice if they prefer a different file (maybe a slightly lower resolution one that has edits or a watermark they want to keep – up to them).
	•	Metadata donors tab: This view breaks down each metadata field (date taken, location, camera, etc.) and shows which file contributed that field in the merged result. For example, it might show a table: Date – from IMG_1234.JPG (EXIF), Location – from GPS sidecar file, Title – from filename, etc. If there were conflicts, it can show what was in the other files too (perhaps with options to choose a different value if the user disagrees with the automated choice).
	•	Actions (and audit): The Inspector provides controls for user-driven corrections. Actions include:
	•	Override canonical: as mentioned, user can select a different duplicate in the group to be the primary representative.
	•	Edit metadata: user can manually edit fields of the merged metadata (e.g. correct the date or location). These edits are saved as ChangeRecords (so they are undoable and logged).
	•	Accept/reject enrichment suggestions: if enrichments (like an AI keyword “sunset” or a detected face “Alice”) are attached but maybe low confidence or awaiting user confirmation, the inspector can list them with accept/reject toggles.
	•	Exclude/Hide an item: perhaps the user can mark a particular duplicate as “not to be shown” (if, say, it’s a low-quality dup they want to effectively remove from view without deleting).
Every such action creates appropriate records (updating VirtualMedia or ChangeRecord) and results in UI updates (and possibly triggers reindexing if needed, e.g. if a date was changed, the item might move in the timeline view).

The Inspector is all about transparency and control: the user can see exactly what Memex did automatically and intervene if needed.

5.5 Tasks Center

Memex includes a Tasks or Jobs center UI where background tasks are listed and can be managed. This is typically a section of the UI (maybe accessible via a “Tasks” tab or an icon that shows running tasks count). It includes:
	•	Live job list: A list of active and recent jobs. For example, an “Import from C:\Photos” might be running, showing which step it’s on and a progress bar. Another entry might be a face recognition job that the user started after import, etc. Each job entry shows the job type, the source or parameters (e.g. folder name), and a status/progress indicator (percent complete or “Paused” or “Cancelled”, etc.).
	•	Progress details: When expanding or selecting a job, the UI can show step-by-step progress within that job. For instance:
	•	Import Job “Holiday 2025 Import” – Steps: Discover (complete ✅ 5000/5000 files), Fingerprint (complete ✅), Duplicate Detect (running… 60%), Metadata Extract (queued), etc. The currently running step shows a sub-progress if available, and possibly an item being processed (“Processing IMG0001.JPG…”).
	•	Throughput or speed can be indicated (e.g. “50 files/min”).
	•	Recent warnings or errors are displayed in context (e.g. a small log area: “Warning: File IMG0999.JPG EXIF data unreadable”).
	•	A live log stream could be shown for advanced users toggling a “verbose” view, where each event or important operation is listed as it happens (this essentially streams the JobLog or events for that job).
	•	Controls: For each job, the user has control buttons if applicable:
	•	Cancel – immediately stop the job (if the pipeline supports cancellation at that stage).
	•	Pause/Resume – if supported, pause the job (the pipeline would checkpoint and halt after the current file) and later resume from where it left off.
	•	Retry failed – if a job completed with errors (say some enrichments failed due to network issues), a “Retry” could rerun just the failed parts.
	•	Reset and re-run – a more drastic option that wipes the job’s outputs (those data related to that import or task) and starts over (perhaps after changing settings). For example, “Reset face recognition and run again with new sensitivity.”
	•	Completed jobs and reports: Completed tasks can be listed below active ones (or in a separate “History” tab). The user can click a completed job to see a summary report. This report would include statistics (e.g. “Imported 10,000 files, found 2,000 duplicates in 800 groups, 5 warnings, 0 errors”), and offer an option to view the detailed log or export it. The log can be saved to a text file for debugging if needed.
	•	Isolation of tasks: The tasks center should clearly separate different tasks to avoid confusion. For instance, if an import and a face recognition are running concurrently, they’ll be two entries. They might both be updating the library, but the user can manage them independently.

The Tasks Center ensures the user is aware of background processing and can supervise or intervene as needed, maintaining trust that the app is doing work on their behalf transparently.

5.6 Saved Searches and Views

Every combination of filters and view settings in Memex represents a query into the library. The application allows users to save these queries for quick access later, effectively creating dynamic albums or smart collections:
	•	Saving a view: If a user has applied a set of filters (e.g. Date range = 2010-2015, Person = “Alice”, Camera = “Nikon D90”) and perhaps selected a particular sort order or layout (say, map view), they can save this as a Saved Search. They provide a name (e.g. “Alice - DSLR Photos 2010-15”) and Memex stores the query criteria under that name.
	•	Opening saved views: Saved searches appear in a list (perhaps in a sidebar or a “Saved Views” section). Clicking one will reapply all the filters and present the view exactly as it was configured. The content is always up-to-date – it’s not a static album copy; it’s a live query. For instance, if new photos of Alice from 2014 are imported later, they will automatically appear in the saved view results.
	•	Managing saved searches: Users can rename or delete saved searches. They might also edit them (e.g. adjust a filter and re-save). Internally, the criteria might be stored as a query object in the database or a JSON blob.
	•	Default views: The app might ship with a couple of example saved views or quick filters (like “This Day Last Year” or “Recent Imports”) to showcase the capability, though the user can remove or modify these.

Saved views empower users to curate and quickly access subsets of their library without duplicating images or manually maintaining albums. Since everything is query-driven, saved views are essentially shortcuts to applying filters.

6. Technology Specification

6.1 Electron App Configuration (Required Defaults)

Memex uses Electron as the desktop shell, and the following configuration and best practices are enforced:
	•	Main/Sidecar orchestration: The Electron main process is responsible for launching the .NET sidecar. On app startup, before or just after opening the main window, it spawns the backend process (using something like child_process.spawn for the .NET executable). It ensures the sidecar is running for any indexing or query operations. If the sidecar crashes or exits unexpectedly, the main process can detect that (child process exit event) and optionally attempt to restart it or at least alert the user.
	•	Lifecycle management: The main process manages shutting down the sidecar on app exit (sending a polite kill or using an IPC message to tell it to close). If the user restarts an import or does something that requires a fresh state, the main process might restart the sidecar (for instance, if we want to clear all state, though typically we wouldn’t restart it unless necessary).
	•	Preload scripts and context isolation: The renderer is launched with contextIsolation: true. A preload script is specified which runs in an isolated context and sets up a controlled API. For example, contextBridge.exposeInMainWorld('MemexAPI', { selectFolder: () => ipcRenderer.invoke('dialog:openFolder'), ... }). The renderer can only call those methods. No direct Node requires or access to fs is allowed in the renderer.
	•	Custom protocols for media access: To efficiently display images and thumbnails without copying large binary data through IPC, Memex can register a custom protocol. For instance, memex://thumb/<assetId> could be handled by the main process to read a thumbnail from disk (or generate on the fly) and return it. The renderer can then set an <img src="memex://thumb/123" /> without needing fs access or base64 blobs. Alternatively, file URLs could be used if thumbnails are stored in a known location, but custom protocol gives more control and can be secured (only our app knows how to serve memex://).
	•	Efficient querying: For library queries, instead of pulling the entire dataset into the renderer, the sidecar (or main) will provide paginated responses. The renderer might ask for “give me the first 100 items sorted by date for this query” and then as the user scrolls, ask for the next page. This keeps memory usage low in the frontend. The renderer should ideally only keep a small cache of currently viewed items and maybe a bit ahead/behind, rather than the entire library list.
	•	Single instance & deep linking: (If relevant) The app should be single-instance (so double-clicking a file to open in Memex or launching the app twice just focuses the existing instance). Deep linking isn’t a big requirement for v1, but we could register a protocol to handle future actions.

6.2 Backend (.NET 10) Responsibilities

The .NET sidecar is the core of the application’s logic. Key responsibilities and technical points:
	•	Pipeline Orchestrator: The sidecar implements the pipeline described in section 4.3. This could be structured as a pipeline class or service that runs each step in order, updating job state, and sending progress events. It should make heavy use of async/await and support CancellationTokens on all long-running operations. Each pipeline step likely runs in its own method or even its own class, which the orchestrator calls in sequence. Checkpoints (writing to the DB that step X is done for an asset) should be taken so that if interrupted, we know where to resume.
	•	Database Access and Migrations: The sidecar manages the SQLite database via an ORM or direct SQL (e.g. using Dapper or EF Core). It should handle database migrations – versioning the schema so that future updates to Memex can alter the schema and migrate old data. All database reads/writes from the sidecar should ideally be through a single access layer or service for maintainability.
	•	CLI Tool Integration: The sidecar calls external CLI tools (czkawka_cli, exiftool, ffmpeg, etc.) as needed. This is done by spawning processes. To handle large outputs efficiently:
	•	czkawka_cli can output JSON; the sidecar should read from its stdout stream asynchronously and parse incrementally (e.g. using a streaming JSON parser or reading line by line if it outputs JSON lines).
	•	exiftool can output JSON for multiple files at once (with the -j flag). The sidecar could run one exiftool process for a batch of files (to amortize startup cost) and parse the JSON array result.
	•	ffmpeg can be used for grabbing a frame: the sidecar might call ffmpeg to output a JPEG thumbnail at a certain time code. The sidecar should handle the process stdout (which would be binary image data in this case) or have ffmpeg write directly to a file.
	•	These calls should be asynchronous and non-blocking to the main sidecar thread. The sidecar likely has a small thread pool or uses async subprocess handling.
	•	Query Engine: The sidecar exposes an interface for the renderer (via main) to query the library. This is likely implemented via a set of IPC commands like query.search with filters or a query language. The sidecar will translate that into SQL queries on SQLite, possibly using indices for performance. It should support:
	•	Pagination: e.g. return results 0-99 for query, then remember the query (with an ID or by repeating filters) for subsequent calls (100-199, etc.).
	•	Facet counts: the sidecar can also return facet counts (e.g. “you have 123 photos of Alice, 50 taken in 2020”) to populate filter UIs. These should be optimized with precomputed indexes when possible.
	•	Full-text search if applicable: If we support a search bar that matches text in filenames, tags, etc., we might use FTS (Full Text Search) in SQLite on certain columns.
	•	Networking (if any): The sidecar may handle network calls for enrichments (unless those are done in Node in main, but likely easier to do in .NET via HTTP client). If so, it should abide by the opt-in settings (i.e., only call external APIs if enabled). For testability, network calls should be abstracted (so they can be mocked or stubbed, see Testing section).
	•	Media Format Support: The backend must deal with a variety of media formats. .NET plus external tools will cover most:
	•	ImageSharp or SkiaSharp for image decoding/processing (though format support in ImageSharp might be limited for HEIC/AVIF; we can use ImageMagick or ffmpeg as fallback).
	•	For HEIC/HEIF/AVIF formats: if our libraries can’t decode them, consider using ffmpeg to convert to JPEG for thumbnails, or use OS-specific decoders (Windows 10 has HEIF support via OS, and macOS via native).
	•	For RAW images (DNG or proprietary like CR2/NEF): use exiftool for metadata (it handles many RAW formats) and use either embedded preview images or a tool like dcraw/RawSharp to get thumbnails. We ensure these formats are not skipped.
	•	Video formats: rely on ffmpeg for any actual decoding (thumbnails) and metadata reading can come from ffprobe or tag libraries.
Essentially, no common format should be left unsupported. If an external library is needed, the installer or documentation will include instructions (e.g. installing HEVC extension on Windows for HEIF, or bundling a codec).

6.3 Testing (Fully Automated Interactive E2E)

Memex is built with a strong emphasis on testability. We enforce a testing strategy spanning unit tests to full end-to-end tests, aiming for deterministic, automated validation of all features. The testing pyramid and policies:
	•	Unit Tests (Backend): Fine-grained tests of the .NET core logic using xUnit and Moq (or similar). This covers things like the duplicate scoring algorithm, metadata merge conflict resolver, date parsing regexes, database access functions (with an in-memory SQLite or test database), etc. These should run quickly and cover edge cases. For example, a unit test would ensure that if two sources have conflicting dates, the precedence rules yield the expected result, or that the content scoring picks the correct file in known scenarios.
	•	Unit/Component Tests (Frontend): The React app will use Jest and React Testing Library for components and state logic. We will write tests for reducers (if using Redux or similar), custom hooks, and util functions. For components, we can simulate user interaction at a DOM level (without launching a browser) to ensure, for instance, that toggling a filter checkbox updates the state correctly, or the import wizard steps flow as expected given some mock data.
	•	End-to-End (E2E) Tests: We use Playwright to automate the entire Electron application. This means launching the actual Electron app in a test mode and having Playwright control it: clicking on buttons, selecting folders (via stubbed dialog, see below), waiting for items to appear, etc. These tests run on all supported platforms (at least one on each: macOS, Windows, Linux in CI) to catch platform-specific issues. The goal is zero manual QA – even things like the import wizard UI and tasks progress are validated by these automated tests.

6.3.1 Playwright + Electron E2E Harness
	•	Playwright has a special ability to hook into Electron. Our tests will launch the Electron app using Playwright’s electron.launch() method with our app’s entry point. This gives us a handle to the Electron App and the first BrowserWindow (the main UI).
	•	Tests can then programmatically find elements in the UI and simulate user actions. For example, a test might click the “Add Folder” button, which normally opens a folder dialog. We’ll intercept that (explained next) to provide a test folder path. Then the test will wait for the import to start and perhaps verify that after completion, certain expected files are present in the library grid.
	•	We ensure these E2E tests run headless in CI: on macOS (both Apple Silicon and x64 if possible), on Windows, and on Linux. This way, any OS-specific issues (like path separators, permission dialogs, etc.) are caught. Locally, developers can also run them in headed mode (with the UI visible) for debugging.
	•	E2E tests use deterministic fixture data. We will have a small set of sample media files (photos/videos) that we include for testing (or generate during tests). For instance, a fixture library might have 20 images including some duplicates and known metadata. The tests know what results to expect (e.g. it knows there should be 2 duplicate groups, etc.). This ensures assertions are stable. We avoid using real user data or anything non-deterministic in tests.

6.3.2 OS/Dialog Automation via Stubs

One challenge in automating a desktop app is dealing with native OS dialogs (file pickers, alerts) and certain OS integrations (permissions, etc.), as they are outside the control of Playwright. To solve this, Memex includes hooks to replace or stub these in test mode:
	•	We implement our own DialogService interface in the app. In production, DialogService.selectFolder() will call Electron’s dialog.showOpenDialog({ properties: ['openDirectory'] }) to open the OS folder picker. But in test mode, we swap this out for a stub implementation that instantly returns a predefined path.
	•	How to toggle this: We can detect an environment variable or command-line flag (like MEMEX_TEST_FIXTURE_DIR) when launching the app in tests. If present, the app knows it’s under test conditions.
	•	For example, in test mode, DialogService.selectFolder() might read MEMEX_TEST_FIXTURE_DIR from the environment and directly return that path string instead of showing a dialog.
	•	The Playwright test would set that environment variable to point to the location of the test media fixtures before launching the app. Thus, when the test clicks “Import Folder” in the UI, behind the scenes the app calls the stub and immediately proceeds as if the user selected the given fixture folder.
	•	This approach ensures the E2E test is not blocked by a manual dialog and is consistent across OSes.
	•	We apply similar strategy for any other OS interactions:
	•	If the app ever shows a native message box or permission prompt, in test mode it should auto-respond or bypass it.
	•	The test’s assertions then focus on outcomes, e.g., after selecting the folder, ensure an Import job started and photos began appearing.

6.3.3 Other Stubbable OS/External Integrations

We strive for determinism in tests, so any external dependency is stubbed or controllable:
	•	Time/Clock: For features that depend on the current time (e.g. grouping recent photos “today” vs “yesterday”, or an “on this day” feature), we provide a time abstraction. In test mode, we can freeze the time to a specific date/time so that outputs are predictable. For example, event detection grouping might depend on current time for deciding if something is “today”; with a fixed test time, the grouping is stable.
	•	Network calls: All network-based enrichments (reverse geocode, weather, etc.) must be controllable in tests. We do not want tests relying on actual external services (which could be flaky or require API keys). Options:
	•	Provide a “offline mode” for enrichments where instead of calling the API, the sidecar looks up canned responses (perhaps stored in test fixtures).
	•	For instance, if the test fixture photos have known GPS coordinates, we include a small offline database or map (just for tests) that maps that coordinate to a known place name. The reverse geocode module in test mode can use that to return “Testville” consistently.
	•	For weather, similarly, return a fixed weather string like “Sunny 25°C” if enabled, or just skip.
	•	Alternatively, use a record/replay approach: run once with actual API and record the responses to file, then have tests use those recordings. But since this is internal, probably easier to just stub out the call.
	•	Filesystem permissions: If part of the app handles lack of permission (say user points to a folder they can’t read), writing a deterministic test for that is tricky since it depends on OS state. Instead, we can simulate it: provide a fake filesystem provider in test mode that can be instructed to throw permission errors for certain paths (if we want to test that UI flow). Generally though, we assume test fixture directories are accessible, so we won’t often hit permission issues in tests. We just need to ensure if such issues arise, they’re handled gracefully (which unit tests can cover by simulating exceptions).
	•	External tool outputs: Running the actual czkawka_cli or ffmpeg on every test run might be slow and not deterministic if thread scheduling differs. We can shortcut these in tests:
	•	For E2E, we can have a mode where, instead of spawning the real czkawka process, the sidecar loads a “golden” JSON output from a file (that we captured earlier for the test files) and pretends that’s the result of the duplicate scan. This would instantly give deterministic output for duplicates without actually hashing files.
	•	Similarly for exiftool: have stored metadata outputs for the test images.
	•	This can be implemented by checking an env flag like MEMEX_USE_FIXTURE_OUTPUTS. If set, the sidecar, when asked to run these tools, will read static files from a fixtures/ directory. We would maintain those fixture outputs as part of the test suite.
	•	We will still have at least one nightly run where we allow the real tools to run on the test data to ensure the code paths remain functional, but for CI on each commit, using recorded outputs speeds things up and avoids flakiness.

In summary, test mode is a first-class consideration: the app has conditional branches or interfaces that swap in stub behaviors so that the entire system can run in a hermetic environment with no external dependencies. This allows reliable E2E tests that simulate things like user selecting a folder, network being present or not, etc., without actual external intervention.

6.4 Build and Deployment
	•	Node & Bun for frontend tooling: The development uses Node 24 LTS and the Bun toolkit to manage frontend dependencies and build tasks. All package scripts and bundling (likely using Vite for React) will run via Bun (which is much faster). We avoid using npm/Yarn directly; instead bun install and bun x ... are used for scripts. This requires developers to have Bun installed (which we note in docs).
	•	Electron Builder for packaging: For distribution, we use Electron Builder (or a similar packaging tool) to create installers or app bundles for macOS (.app or .dmg), Windows (.exe or installer), and Linux (AppImage or package). The builder will be configured to include the .NET sidecar and all necessary tools.
	•	Self-contained .NET runtime: We will publish the .NET sidecar as a self-contained single folder for each platform (so users don’t need to install .NET). This means our build pipeline will create, for example, a Memex.Backend.exe with all .NET runtime libraries included for Windows, and similarly for macOS and Linux binaries.
	•	External tools bundling: We need to handle the external binaries:
	•	czkawka_cli: On Windows and macOS, we may bundle the binary if licensing permits (czkawka is MIT, so that should be fine). On Linux, we might assume the user can install it or we bundle an AppImage. We’ll decide whether to ship these tools inside our installer or instruct users to install them. Ideally, for a seamless experience, we bundle them.
	•	exiftool: It’s Perl-based but often shipped as a standalone package. We might bundle it as well (there are standalone Windows executables and on macOS we can include it).
	•	ffmpeg: It’s large, but we might include a minimal build (or instruct installation for heavy users). Possibly include for convenience.
	•	ImageMagick: Optional; if we only use it for certain transforms, we might not include by default to save size, or include a subset. Alternatively, we rely on .NET image libraries and ffmpeg to cover needed functionality.
	•	For any bundled tools, ensure we comply with their licenses (provide attributions, etc. in our About or docs).
	•	Environment setup for development: (This overlaps with Dev Guide, but from a tech perspective) we encourage using asdf version manager to install the exact Node and .NET versions specified (ensuring devs and CI use the same versions). Similarly, on macOS, use Homebrew to install dev dependencies like ffmpeg, exiftool, and czkawka for a dev environment. The app at runtime will prefer its bundled tools, but in development it might use system ones for convenience.
	•	Update mechanism: Not necessarily in v1, but if we do, we’d use Electron’s autoUpdater with packages on GitHub Releases or similar. This needs code signing on Windows and notarization on macOS, which are deployment details the team will handle.

With build tooling in place, a developer should be able to clone the repo, run one command to install all JS/CSS deps (via Bun) and then start the app in dev mode. CI will produce installers for distribution after tests pass.

6.5 Instrumentation and Future AI Integration

Although not a feature exposed to users in v1, the system is designed with hooks for future integration of AI/LLM-based assistants or analysis. Key design points to enable this:
	•	Event Bus / PubSub: The application (particularly the sidecar and the main process) emits structured events for everything from task progress (as described) to user actions (like “user opened inspector for item X” or “user searched for Y”). We ensure these events are accessible internally so that an external module or plugin could subscribe to them. For example, a future AI assistant could listen to task.completed events to know when an import is done and maybe generate a summary of “You imported 100 photos from Paris.”
	•	State exposure: All core UI state (current filters, selected item, etc.) is managed in a way that could be exposed via an API. For instance, if we have a Redux store or similar, we could allow read-only access to certain parts of it for plugins. This means an LLM agent could query the current state (“what is the user looking at right now?”) if we build an API around it later.
	•	APIs for AI actions: We plan where an AI might hook in:
	•	At the UI level: e.g. a chatbot that can answer “Do I have photos of Alice in London?” by translating that to a query. This would require an API to perform queries (which we have via the sidecar query engine). We can in future expose a natural language query interface that leverages the existing search capabilities.
	•	At the pipeline level: e.g. in the enrichment step, perhaps integrating an LLM to generate captions or stories about an album. Our pipeline is modular, so adding an extra step that calls out to an AI (local or cloud) is straightforward. The key is that our pipeline and event model can handle additional steps seamlessly.
	•	Instrumentation and Logging: We instrument the code with logs at all major decision points (dedupe decisions, metadata merges, etc.). These logs are structured (key-value, JSON) and can be stored or streamed. In the future, an AI could be given access to these logs to analyze user behavior or to explain the system’s decisions in a user-friendly way (“I chose this photo because it has higher resolution” – an explanation that could be surfaced via an AI agent).
	•	Plugin architecture: Although not in v1, we anticipate possibly loading extension modules. The system’s architecture (Electron main -> sidecar RPC) could be extended to allow additional IPC channels or modules. For example, an AI module could run as another process or thread that listens to events or database changes. We keep this in mind by not hard-coding assumptions that only our sidecar will connect; instead, it could be feasible to add a second background process for AI if needed.
	•	Privacy and Control: Any future AI integration (especially if using cloud-based LLMs) will respect the privacy stance. Instrumentation is primarily for local use or optional services. For instance, we might log events locally that an AI (running locally or with user permission remotely) can read. We won’t silently send user content to an AI service without explicit consent.

In short, our design includes comprehensive instrumentation (events, logs, state tracking) which not only helps debugging and observability but also lays the groundwork for advanced AI features down the road. When the time comes, the development team should find integration points readily available throughout the codebase.

7. Developer Guide

(This section guides developers on the project structure, development workflow, and how to extend the system. It assumes an internal development team audience.)

7.1 Repository Layout

The codebase is organized for clarity between frontend, backend, and cross-cutting concerns. A recommended layout (which we follow) is:
	•	apps/ – Top-level application directories.
	•	memex-ui/ – The React frontend project (likely using Vite or CRA). Contains all React components, styles (Tailwind), and frontend-specific logic.
	•	memex-electron/ – The Electron main process code and preload scripts. This holds main.js (or .ts) which creates the BrowserWindow, IPC handlers, and code to spawn the .NET sidecar. Also includes packaging config (for electron-builder).
	•	src/ – .NET source code (organized into projects):
	•	Memex.Core/ – The pure backend logic library. This could be a .NET class library containing core functionality that is independent of Electron or IPC. Things like the data models, scoring algorithms, metadata merge logic, etc., live here. It should have no knowledge of Electron; it’s just the brains.
	•	Memex.Backend/ – The sidecar executable project. This references Memex.Core and adds the infrastructure: e.g. the command-line interface, IPC server (JSON-RPC or gRPC server implementation), pipeline orchestration, and database management. It’s the entry point that the Electron main will launch. It could be a console app or service.
	•	Memex.Contracts/ – (If used) Defines the data transfer objects (DTOs) and IPC message schemas between the Electron side (Node/TS) and the .NET side. For example, definitions of the JSON structures for queries and events. We might keep these in a separate project and possibly auto-generate TypeScript interfaces from them for use in the preload. This ensures both sides agree on message formats.
	•	tests/ – All test projects and test-related data.
	•	Memex.Core.Tests/ – xUnit tests for the Memex.Core logic.
	•	Memex.Backend.Tests/ – xUnit tests that might spin up a test database, run parts of the pipeline on sample data, etc.
	•	memex-ui/src/ (within the frontend project) – could contain Jest tests alongside components or in a tests directory.
	•	e2e/ or tests/e2e/ – Playwright test scripts. Possibly structured by scenarios (e.g. Import.e2e.ts, Deduplication.e2e.ts, etc.). Also include any test fixture media in a subfolder like tests/fixtures/media/ and any recorded outputs (like czkawka sample JSON) in tests/fixtures/outputs/.
	•	scripts/ – Utility scripts for building, packaging, etc. (could also just be in package.json using Bun).
	•	.github/ or CI config – for CI pipelines (GitHub Actions, etc., if used).

This structure ensures clear separation: e.g., UI developers can mostly live in memex-ui, backend devs in Memex.Backend/Memex.Core, with well-defined boundaries between.

7.2 Local Development Workflow

To set up a development environment for Memex, follow these steps (assuming a Unix-like environment for illustration; adapt for Windows as needed):
	1.	Install core tooling:
	•	Install Node.js 24 LTS and Bun. We recommend using asdf to manage versions: for example, asdf install nodejs 24.0.0 and asdf global nodejs 24.0.0, and asdf install bun latest. This ensures you use the exact Node version and have Bun available for package management.
	•	Install the .NET 10 SDK (which includes C# 14 compiler). On macOS, you could use Homebrew (brew install --cask dotnet-sdk or similar) or download from Microsoft. Again, asdf can manage .NET versions (asdf install dotnet-core 10.0.x).
	•	Install required external tools on your system for development convenience:
	•	On macOS: brew install ffmpeg exiftool imagemagick czkawka (Homebrew has a formula for czkawka). This allows running these tools during dev if needed. On Windows, you might use choco install or manually install these and ensure they’re in PATH.
	•	These are optional for dev because we will bundle them, but having them installed can help (e.g., you can run czkawka_cli manually to test, or the app can find them if not bundled in dev mode).
	2.	Restore frontend dependencies: In apps/memex-ui, run bun install (Bun will install all npm packages faster than npm). Likewise, if the Electron project has a package.json (for dev dependencies or build tools), run bun install there as well.
	3.	Build/Restore backend: Open the Memex.sln or run dotnet restore to fetch NuGet packages. Ensure the solution builds (dotnet build). This will also ensure any Entity Framework migrations or such are configured.
	4.	Running in development:
	•	Start the backend sidecar in watch mode: e.g. dotnet watch run -p src/Memex.Backend/Memex.Backend.csproj -- --dev. The --dev flag (or environment variable) could tell it to use a separate dev database path and perhaps enable verbose logging. This will compile and run the sidecar, waiting for commands (likely it will start an IPC listener and idle).
	•	Start the frontend UI dev server: navigate to apps/memex-ui and run bun x vite (assuming Vite). This starts the React app in development mode (on say http://localhost:3000).
	•	Start Electron pointing to the dev UI: We can either run bun x electron . in apps/memex-electron, configured such that it loads http://localhost:3000 in the BrowserWindow (in dev mode). Or we have a script, e.g. npm run electron-dev that launches Electron with an environment variable that causes it to load external URL instead of a packaged file.
	•	With these running, you have live-reload: changes in React code will refresh the UI, changes in backend code will restart the sidecar (via dotnet watch), and Electron can be reloaded as needed.
	5.	Run tests:
	•	Unit tests: dotnet test will run all backend tests. bun x jest will run frontend tests. You can run these continuously in watch mode during development.
	•	E2E tests: You can run bun x playwright test (or via a script) to execute the Playwright test suite. For debugging, run in headed mode: bun x playwright test --headed --project=electron to see the UI while tests run. You can target a single test via its title or file if working on a specific feature. Ensure the app is built or running in a test mode as needed (our tests will typically spawn the app themselves).
	•	The E2E tests will automatically use the stubbed dialogs and fixture data as described. Make sure you have the test media fixtures in the expected location (MEMEX_TEST_FIXTURE_DIR or similar environment is set by the test runner config).
	•	All tests should be run (and pass) before you push commits.

7.3 Adding a New Pipeline Step

Suppose we want to add a new pipeline step in a future version (for example, a hypothetical “Photo Quality Scoring” step that rates image aesthetic quality, or simpler, a step to generate photo histograms). Developers should follow this general process to integrate it end-to-end:
	1.	Define the step’s purpose, inputs, outputs: Write down what the step does (e.g. takes an Asset, produces a numeric quality score and saves it). Decide where to store outputs (perhaps add a column in an existing table or a new table if complex).
	2.	Update Data Model: If needed, add new fields or tables. For example, add a QualityScore column to Asset or a new PhotoQuality table keyed by assetId. Write a new database migration if the DB is versioned. Update any relevant ORMs or data access code.
	3.	Implement the step logic: In Memex.Core (if pure logic) or directly in Memex.Backend pipeline code, create a class or function for the step. It should be able to run for a given asset or batch. Implement as pure as possible (for testability). For example, PhotoQualityAnalyzer.Analyze(asset) -> score.
	4.	Integrate with Pipeline Orchestrator: In the orchestrator code (which likely has a sequence of steps defined), insert your step at the appropriate position. Also include conditions if it’s optional. E.g., only run if the user enabled “Quality scoring” module in the import settings.
	5.	Emit progress events: Make sure within this step you call the event emitter periodically. If processing file by file, each file could emit a task.progress with step="quality" etc. Use the same taskId as the import job. Include context like file name.
	6.	Cancellation support: Check for CancellationToken or equivalent at reasonable intervals so that if a cancel is requested, your step can abort promptly. If your step spawns external processes or long loops, ensure those can be terminated or will end soon after cancel.
	7.	Checkpointing: If the step is lengthy, consider writing intermediate results incrementally to the DB so that if it stops midway, already processed items are saved. That way, resuming the job can pick up where left off.
	8.	Unit Tests for logic: Write xUnit tests in Memex.Core.Tests for any new algorithms (e.g., if your quality scoring involves image analysis, maybe test with known input values). If it involves external tools, you might mock those or use small sample files.
	9.	Integration tests: Write a test that runs the pipeline (or that step) on a small set of data to ensure it writes expected DB entries. Possibly in Memex.Backend.Tests you can simulate running just that step.
	10.	UI changes (if any): If this new step surfaces data to the UI (e.g. showing a “quality score” in Inspector or using it to sort photos), update the front-end:
	•	Extend the IPC contract/DTOs if the UI needs to request this data or receive it in query results. E.g., include QualityScore in the VirtualMedia query results.
	•	Update React components to display or use this new field.
	•	If there is a toggle in the import UI for this module, add it in the wizard (and ensure it passes a flag to the backend when starting import).
	•	If needed, add a facet or filter (maybe not in this case).
	11.	E2E test coverage: Add or extend Playwright tests to cover the new feature. For example, if you add quality scoring, perhaps add an assertion in an import test that after import, each item has a quality score in the database (the test could call a debug endpoint or open inspector to see it). Or if it affects UI sorting, write a test to sort by quality and verify order.
	12.	Documentation: Update any relevant documentation (like this spec or README) about the new feature, and note any impact on performance or disk usage.

By following this pattern, new features are introduced with full consideration of their impact across the system (database, backend logic, UI, and tests). Each new step or module should maintain the system principles: streamable (don’t block the entire pipeline waiting for all to finish, if possible), cancelable, and with results stored for future use.

7.4 Adding an Electron-Exposed Capability

If the app needs a new capability that involves OS integration or something that the backend or UI can’t do alone (for example, showing a native notification, or selecting a file, or writing to a certain folder), you’ll likely need to add a method that goes through the Electron main process and possibly to the OS. To do this cleanly and testably:
	1.	Extend the OS Service interface: If we have an abstraction like DialogService or a more general OSService in the main process (covering things like dialogs, notifications, clipboard, etc.), add a new method there for the desired capability. For example, OSService.showNotification(title, body).
	2.	Implement in main process (production): In the real (production) environment, implement that using Electron/Node APIs. E.g., for a notification, use Electron’s Notification API or Node’s ability to trigger a notification. For a file operation, use Node’s fs module, etc. Keep it minimal and focused.
	3.	Expose through preload: Decide how the renderer will call this. Update the preload script’s API to include a function for this new capability. For example, MemexAPI.notify(title, body) that internally does ipcRenderer.invoke('os:notify', {title, body}).
	4.	IPC handling: In the main process, register an IPC handler for 'os:notify' (or whatever channel). The handler calls the OSService implementation created in step 2. Ensure to validate inputs (e.g. the title/body are strings and not overly long, etc.) to avoid abuse from renderer.
	5.	Return values or errors: If the capability returns a value (like a file path, or success/failure), design the IPC response accordingly (could resolve to a value or throw an error that the renderer can catch). Use structured error objects – do not let low-level exceptions propagate uncaught; instead, catch in main and send an error code/message back to renderer.
	6.	E2E Test stub: As with dialogs, consider if this new capability needs stubbing in tests. For notifications, perhaps in test mode we don’t actually fire a system notification (which could be hard to detect); instead, we might log it or keep it in an array accessible to tests. If it’s a file write, in test mode you might redirect it to a temp directory. Design a way to inject a stubbed OSService in tests.
	7.	Unit Tests: If applicable, test the main process logic (maybe via a small integration test using Spectron or by calling the function directly in a simulated environment).
	8.	UI usage: Now use the new API in the renderer. Perhaps call MemexAPI.notify("Import Complete", "100 photos imported") on task completion, etc. Ensure to handle promises if it’s async.
	9.	UI Unit Test: If the UI logic around it is testable (e.g. a reducer that triggers a notification action), simulate it in a Jest test by mocking MemexAPI.
	10.	E2E Test: Add a Playwright test scenario if possible. For notifications, we might not easily verify a system notification, but we could expose a hook in test mode like window.lastNotification that test can read. Or simply trust unit tests for that. For a file operation, we can verify the result on disk in the test.

Following this procedure ensures new OS interactions are added in a way that doesn’t break the cross-platform nature or the test automation. We always provide a fallback or stub in tests to keep them deterministic.

7.5 End-to-End Testing Design Rules

When writing or updating E2E tests (and the app to facilitate them), keep these rules in mind:
	•	No real OS dialogs in tests: Every place the app would invoke a native file picker or message box must go through a stub-able interface (like DialogService). In test runs, we replace it so the test can proceed without human intervention. If you introduce a new dialog, make sure to provide a test mode bypass.
	•	No external network calls in tests: All external enrichment features should be disabled or stubbed by default in the test environment. Tests should not depend on actual network connectivity or third-party API responses. Use recorded data or skip those actions. (Our CI will not have API keys for Google etc., and even if it did, we want offline repeatability.)
	•	Focus on user-visible outcomes: E2E tests simulate a user. They should assert things that a user can observe in the UI or in resulting files, not internal states. For example, instead of checking a database entry directly via the test, have the test query the UI (or use a debug command exposed for tests) to get the needed info. The idea is to ensure the app is doing the right thing from the user’s perspective. Internal verification is mostly for unit tests.
	•	Isolation and cleanup: Each test (or at least each test suite) should run on a fresh state. The Electron app should be launched with a fresh user data directory for the test (Playwright can do this by specifying a userDataDir per test context, or we make the app able to use a temp directory via env var). This ensures tests don’t bleed into each other with leftover state. For example, one test’s import shouldn’t leave the database such that another test sees that data. We either wipe the DB between tests or use separate dirs. We include teardown logic to delete any files written (like the test output directory).
	•	Deterministic timing: Avoid using arbitrary sleeps in tests. Instead, wait for specific events or UI elements. Our app emits events; the frontend could show a status like “Import complete” that the test waits for. Always prefer await expect(...).toHaveText("Complete") rather than wait(5000). This makes tests faster and more reliable.
	•	Cross-platform considerations: Write tests in a way that doesn’t assume OS-specific behavior unless explicitly intended. E.g., path separators in UI might always be forward slashes regardless of OS (if we show Unix-like paths internally) – account for that. If a test needs to provide a file path, use path.join or similar in the test code to make it OS-independent.
	•	No actual user data: This bears repeating – tests should never touch or require real user data or environment. Always use the provided fixtures. For example, a test should not scan the user’s Pictures folder; it should scan the test’s fixture folder. This is achieved via the dialog stub mechanism and controlled env variables. Also, tests should not write to arbitrary locations; they should stick to temp or within the test’s sandbox.

By adhering to these rules, we maintain a test suite that is reliable (no flickering tests), fast (no unnecessary waits or external calls), and safe (doesn’t modify the developer’s or CI runner’s machine in unexpected ways).

7.6 Export Feature (Future Implementation Guidance)

(Though export is slated for a future version, we document the design to guide development when it’s tackled.)
	•	User-driven only: Export will be a user-initiated action, likely from a UI dialog where the user chooses an output location and what to export. It’s separate from import; an export could be for a subset of library or whole library.
	•	No source modifications: The export writes copies of files to the destination. Under no circumstances does it move or remove the originals.
	•	Export structure options: We may allow the user some options like “Preserve original folder structure vs organize by date vs organize by tag/album” etc. This will be done by templates or patterns (similar to how many photo tools export). Keep it flexible but with safe defaults (like by Year/Month).
	•	Preview: Before executing, show a preview listing of e.g. first few files and their target paths, how many files will be copied, total size, etc. This might require a dry-run mode where we simulate the file naming without actually writing.
	•	Execution and progress: The export will run as a pipeline job (it could reuse the pipeline/task system). It will likely simply iterate over the selected VirtualMedia items, copy their source file from the original location to the new location (using the canonical name and folder structure), and optionally write out sidecars (if we choose to export metadata to XMP or JSON). Each file copy is a unit of work with progress events. We must handle errors (e.g. if a file can’t be read or if disk is full in destination).
	•	Logging: Like imports, export will produce a log/report. Key data: any files that failed to copy, any naming conflicts (if two items would result in the same output name, perhaps we append a counter or log a warning), total bytes copied, time taken.
	•	Testing exports: In E2E, we will stub the folder selection dialog for destination (just like import). We’ll likely point it to a temp dir, run the export, then have the test verify that files appear in that temp dir with expected names. We will include this in our automation to ensure export does what we expect.

Since export touches the filesystem extensively, testing and careful implementation is needed (especially on Windows regarding paths and permission). But following a similar design to import (with streaming events, cancel support, etc.) will keep it consistent.

7.7 Continuous Integration and Quality

Our CI pipeline is configured to ensure high code quality and prevent regressions:
	•	Automated test suite: Every pull request and commit triggers the full test suite. This includes:
	•	Backend unit tests on at least one platform (e.g. Ubuntu for speed).
	•	Frontend unit tests (headless).
	•	Playwright E2E tests on multiple platforms: we set up runners for Windows and macOS (and possibly Linux) to run the Electron E2E suite. We ensure that any OS-specific code is executed in CI (for example, a code path that only runs on Windows will be covered by the Windows CI run).
	•	Build verification: CI also attempts a full build/package to catch any compilation or packaging issues. This means producing the Electron app bundles for each platform (without publishing them) to verify our installer/packaging scripts.
	•	Static analysis: We may include linters (ESLint for JS/TS, StyleCop or similar for C#) and formatters. CI will run these and fail if code doesn’t meet style guidelines. This keeps the codebase consistent.
	•	Coverage (if enforced): We aim for a high percentage of code coverage by tests. CI can generate code coverage reports. While we might not strictly fail under a threshold initially, developers are expected to include tests for new code. Over time, we may ratchet up the coverage requirement.
	•	Nightly full test with real tools: As noted, perhaps nightly or periodically, we run the E2E tests in a mode that doesn’t stub external tools (so it uses actual czkawka, exiftool, etc.). This is scheduled separately from PRs due to it being slower or requiring those binaries. The results will alert us if, say, an update to czkawka changed output format unexpectedly.
	•	No regressions allowed: Pull requests should not be merged if any test fails on any platform. We use required status checks in our repo (e.g. GitHub branch protection) to enforce this.
	•	Deployment pipeline: After tests pass on main branch, we might have a workflow to build release artifacts. While not directly developer-facing, it’s good to note: the CI will produce versioned installers that can be tested by the team or automatically drafted in a release.

By adhering to CI feedback, the dev team can confidently add features without breaking existing ones. New features must include appropriate tests (unit and possibly E2E) in the same PR. The expectation is that a developer can implement a feature, run the test suite locally (perhaps via bun run test:all) and see green across the board, then open a PR which should ideally also run clean in CI the first time.

In conclusion, Memex’s specification and guidelines ensure that the development team can build a robust, high-quality application. The system design favors modularity, transparency, and testability, which allows us to add advanced capabilities (like AI integration or new enrichment modules) with confidence. All critical decisions have been captured here, so the team can proceed with implementation with minimal ambiguity, focusing on delivering each aspect according to spec and covered by tests. Good luck and happy coding!
