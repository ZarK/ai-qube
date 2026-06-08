# Milestone 13 — Faces: Detection, Clustering, and People View

## Goal

Implement automated face recognition that:
- Detects faces in photos
- Computes embeddings for identity matching
- Clusters faces by person (without knowing who they are)
- Provides a **People view** for browsing face clusters
- Enables filtering library by person

This is **cluster-centric first** — naming and person details come in M17.

---

## Strategic Decisions

### Model Stack

| Component | Recommendation | Rationale |
|-----------|----------------|-----------|
| **Detection** | InsightFace (SCRFD) | Fast, accurate, includes landmarks |
| **Embedding** | ArcFace (512-d) | Industry standard, good accuracy |
| **Clustering** | HDBSCAN | Handles noise, variable cluster sizes |

### Embedding Storage

- 512-dimensional float vectors
- Store as BLOB in SQLite (2048 bytes per face)
- L2-normalize before storage for cosine similarity via dot product

### Face Quality Assessment

Not all faces are equal. Assess quality for:
- **Representative selection**: Best face becomes cluster thumbnail
- **Embedding reliability**: Low-quality faces may cluster incorrectly
- **User experience**: Show clear faces, hide blurry ones

Quality factors: sharpness (Laplacian variance), frontality (landmark geometry), lighting evenness, occlusion detection.

### Clustering Strategy

**Hybrid incremental + batch approach**:
1. New faces: Assign to nearest cluster if similarity > threshold (0.6)
2. Unassigned faces: Accumulate until count threshold (100)
3. Periodic re-clustering: Full HDBSCAN on all faces
4. User corrections: Merge/split preserved across re-clustering

### Privacy Considerations

Face data is biometric and sensitive:
- **Local only**: Embeddings never leave device
- **Opt-in**: Face detection disabled by default
- **Per-photo opt-out**: Mark photos as "no face detection"
- **Complete deletion**: User can delete all face data
- **Export exclusion**: Face data excluded from exports by default

---

## Dependencies and Gates (A1/A2/A3/M31/M32)

- Requires M12b (AI engine update) shared `memex_ai` runtime.
- A1 gate: embeddings stored as packed float32 BLOBs; incremental clustering by default; index audit + benchmark harness before release.
- A2 gate: bulk face/cluster payloads must stream with backpressure, bounded pending map, and correlation IDs.
- A3 gate: People view uses containment, no per-item layer promotion, lazy decode + placeholders, and virtualization.
- M32 gate: use breadcrumb/path search/selection summary patterns (no checkbox trees) and keep stable `data-testid` hooks.

### Settings (M31)

Use M31 `faces.*` keys:
- `faces.enabled`
- `faces.qualityPreset`
- `faces.minFaceSize`
- `faces.minConfidence`
- `faces.minQuality`
- `faces.clusteringThreshold`
- `faces.maxFacesPerImage`
- `faces.storeFaceCrops`
- `faces.autoProcessNewMedia`

### Stable Selectors (E2E)

- `data-testid="people-grid"`
- `data-testid="face-cluster-{id}"`
- `data-testid="assign-name-input"`
- `data-testid="face-merge-btn"`
- `data-testid="face-split-btn"`
- `data-testid="face-delete-btn"`

E2E scenarios must remain deterministic (fixtures, stubs, no sleep-based waits, disable animations).

---

## Issue 13.0 — Face Recognition Environment Setup

### Goal

Create **rerunnable, idempotent setup** for face detection and recognition that integrates with the shared `memex_ai` Python environment established in M12b.

### Why This Comes First

Face recognition requires InsightFace models and clustering libraries. Without automated setup, developers face inconsistent environments and users can't enable features without technical knowledge.

---

### Alignment with M12b Architecture

This issue MUST align with the design decisions made in the M12b AI Engine Update:

| M12b Decision | M13 Requirement |
|--------------|-----------------|
| Shared `memex_ai` Python venv | Extend existing venv, do NOT create separate environment |
| `huggingface_hub` for model management | Use HF where models are available, direct download only as fallback |
| `memex_ai.setup` CLI pattern | Add `faces` subcommand to existing CLI |
| Unix socket IPC with long-running worker | Same pattern — load models once, process via socket |
| `memex_ai/` package structure | Add `faces/` subpackage |

---

### Dev Tasks

- [ ] 13.0.1 Extend `memex_ai` package with `faces` subpackage
- [ ] 13.0.2 Add face recognition dependencies to shared requirements.txt
- [ ] 13.0.3 Implement model registry for face models
- [ ] 13.0.4 Implement model downloader (HuggingFace with InsightFace fallback)
- [ ] 13.0.5 Implement ONNX Runtime variant selection (CPU vs GPU)
- [ ] 13.0.6 Create detection smoke test
- [ ] 13.0.7 Create embedding smoke test  
- [ ] 13.0.8 Create clustering smoke test (HDBSCAN)
- [ ] 13.0.9 Extend CLI with `faces` subcommand
- [ ] 13.0.10 Create long-running worker with Unix socket IPC
- [ ] 13.0.11 Document manual installation fallback

---

### Directory Structure
```
~/.memex/
├── ai-models/
│   ├── vision/                    # M12b (existing)
│   └── faces/                     # M13 (new)
│       ├── detection/
│       │   └── scrfd_10g_bnkps.onnx
│       ├── recognition/
│       │   └── arcface_r100.onnx
│       └── analysis/              # Optional
│           └── genderage.onnx
├── python-env/
│   └── memex_ai/                  # SHARED venv (M12b + M13)
└── logs/

# Package structure
memex_ai/
├── setup.py                       # Shared CLI (extended)
├── vision/                        # M12b (existing)
└── faces/                         # M13 (new)
    ├── models.py                  # Registry & download
    ├── worker.py                  # Unix socket worker
    └── test_assets/               # Bundled smoke test images
```

---

### Model Registry

#### Required Models

| Model | Purpose | Size | Source | Required |
|-------|---------|------|--------|----------|
| SCRFD-10G | Face detection | ~30MB | InsightFace GitHub | Yes |
| ArcFace-R100 | Face embeddings (512-d) | ~250MB | HuggingFace or InsightFace | Yes |
| GenderAge | Age/gender analysis | ~1MB | InsightFace GitHub | No (optional) |

#### Quality Presets

| Preset | Detection Model | Recognition Model | Use Case |
|--------|-----------------|-------------------|----------|
| high | scrfd_10g | arcface_r100 | Best accuracy |
| medium | scrfd_10g | arcface_r100 | Default |
| low | scrfd_2.5g | arcface_r50 | Faster, less accurate |

#### Model Source Strategy

1. Check if model available on HuggingFace → use `huggingface_hub`
2. If not on HF → direct download from InsightFace GitHub releases
3. Store metadata (checksum, version, download date) alongside model

---

### CLI Specification

Extend `memex_ai.setup` with `faces` subcommand:
```
memex_ai.setup faces list
  - Show all face models with installed/available status
  - Show disk space used/required

memex_ai.setup faces download [--quality <high|medium|low>] [--include-analysis] [--progress]
  - Download required models for specified quality preset
  - --include-analysis: also download optional age/gender model
  - --progress: show download progress with ETA

memex_ai.setup faces remove
  - Remove all downloaded face models
  - Prompt for confirmation

memex_ai.setup faces check
  - Verify all required models present and valid (checksums)
  - Verify ONNX Runtime available
  - Return structured status (JSON if --json flag)

memex_ai.setup faces test
  - Run smoke tests against bundled test images
  - Report pass/fail for detection, embedding, clustering
```

---

### Long-Running Worker Specification

#### Behavior

1. On startup: Load detection and recognition models into memory
2. Listen on Unix socket for requests
3. Process requests without reloading models
4. Handle graceful shutdown on SIGTERM

#### Request/Response Protocol

Request (JSON, newline-delimited):
```
{
  "image_path": "/path/to/image.jpg",
  "min_face_size": 50,           // optional, default 50px
  "confidence_threshold": 0.5    // optional, default 0.5
}
```

Response (JSON, newline-delimited):
```
{
  "faces": [
    {
      "bbox": [x, y, width, height],
      "confidence": 0.98,
      "landmarks": [[x1,y1], [x2,y2], ...],  // 5 points
      "embedding": [0.1, 0.2, ...],          // 512-d normalized
      "quality_score": 0.85
    }
  ],
  "count": 1,
  "inference_ms": 45
}
```

Error Response:
```
{
  "error": "image_not_found",
  "message": "File does not exist: /path/to/image.jpg"
}
```

#### Worker Startup

- Socket path: configurable via `--socket` argument
- Quality preset: configurable via `--quality` argument
- Timeout: Worker should be ready within 30 seconds of spawn
- Health check: Parent process should verify socket accepts connections

---

### Smoke Tests

#### Test 1: Detection
- Input: Bundled image with single clear frontal face
- Expected: Exactly 1 face detected, confidence > 0.9, valid bbox

#### Test 2: Embedding
- Input: Bundled aligned face crop (112x112)
- Expected: 512-dimensional vector, L2-normalized (norm ≈ 1.0)

#### Test 3: Clustering
- Input: Bundled numpy file with 10 embeddings from 2 known people
- Expected: HDBSCAN produces exactly 2 clusters

---

### Dependencies (additions to shared requirements.txt)

| Package | Version | Purpose |
|---------|---------|---------|
| insightface | ≥0.7.3 | Face detection and recognition |
| onnxruntime | ≥1.16.0 | Model inference (CPU) |
| onnxruntime-gpu | ≥1.16.0 | Model inference (GPU, alternative) |
| hdbscan | ≥0.8.33 | Face clustering |
| faiss-cpu | ≥1.7.4 | Fast similarity search |
| opencv-python | ≥4.8.0 | Image processing |

Note: Only ONE of onnxruntime/onnxruntime-gpu should be installed.

---

### Error Handling

| Error | Detection | Recovery | User Feedback |
|-------|-----------|----------|---------------|
| Model download fails | HTTP error, timeout | Retry 3x with backoff, then fail | "Download failed, check connection" |
| Checksum mismatch | Post-download verification | Re-download | "Model corrupted, re-downloading" |
| ONNX Runtime missing | Import error | Prompt to run setup | "Run setup to install dependencies" |
| GPU ONNX on CPU-only system | Runtime error | Fall back to CPU variant | "GPU not available, using CPU" |
| Model file missing | File not found on load | Prompt to download | "Models not installed" |
| Insufficient disk space | Check before download | Abort with clear message | "Need X MB free, have Y MB" |
| Worker socket timeout | Connection timeout | Restart worker | "AI service restarting..." |
| OOM during inference | ONNX Runtime error | Skip image, log | Silent (logged) |

---

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Re-running setup on configured system | Skip already-downloaded models, complete in <5s |
| Partial download (interrupted) | Detect incomplete files, resume or restart download |
| Multiple Memex instances | Socket path includes PID or uses exclusive lock |
| Model version upgrade | Compare versions, prompt user to re-download |
| Apple Silicon (M1/M2) | Use onnxruntime (CPU), no GPU variant available |
| No internet after initial setup | Works fully offline |
| User has existing InsightFace in system Python | Ignore, use isolated venv |

---

### Platform Considerations

| Platform | Notes |
|----------|-------|
| macOS (Intel) | Standard onnxruntime, no GPU |
| macOS (Apple Silicon) | onnxruntime via Rosetta or native ARM build |
| Linux | onnxruntime-gpu if CUDA available, else CPU |
| Windows | May require Visual C++ Redistributable |

---

### Integration with Memex

#### .NET Sidecar

- Use `MemexAiEnvironment.GetPythonPath()` (shared with M12b)
- Spawn worker process with socket path
- Implement `FaceDetectionService` with same patterns as M12b's `AiExtractionService`
- Share Unix socket client utilities

#### Settings UI

- "Face Recognition" section in AI settings
- Shows: installed status, model quality, disk usage
- Actions: Download, Remove, Test
- Progress indicator during download

---

### Acceptance Criteria

- [ ] Uses shared `memex_ai` Python environment (NOT separate venv)
- [ ] Extends existing `memex_ai.setup` CLI with `faces` subcommand
- [ ] Models download via `huggingface_hub` where available
- [ ] Fallback to direct download for InsightFace-only models
- [ ] Long-running worker uses Unix socket IPC (same as M12b)
- [ ] Worker loads models once at startup
- [ ] Re-running setup on configured system completes in <5s
- [ ] `--check` verifies installation without side effects
- [ ] All three smoke tests pass after installation
- [ ] Works offline after initial setup
- [ ] Integrates with Memex settings UI

---

### Test Assets (Bundled)

| File | Purpose | Specification |
|------|---------|---------------|
| face_test.jpg | Detection smoke test | Single person, frontal, good lighting |
| face_crop.jpg | Embedding smoke test | Pre-aligned 112x112 face |
| no_face.jpg | Negative test | Landscape photo, no people |
| multi_face.jpg | Multi-face test | 3 people, various angles |
| test_embeddings.npy | Clustering smoke test | 10 vectors, 2 known clusters |

---

## Issue 13.1 — Face Detection + Embedding

### Goal

Detect faces and compute embeddings for clustering.

### Dev Tasks

- [ ] 13.1.1 Create FaceDetector interface
- [ ] 13.1.2 Implement InsightFace Python script for detection + embedding
- [ ] 13.1.3 Add face quality assessment (sharpness, frontality, lighting)
- [ ] 13.1.4 Extract aligned face crops with padding
- [ ] 13.1.5 Store embeddings as normalized BLOBs
- [ ] 13.1.6 Add minimum face size filter (default 50px)
- [ ] 13.1.7 Add confidence threshold filter (default 0.5)
- [ ] 13.1.8 Add quality threshold filter (default 0.3)
- [ ] 13.1.9 Implement fixture mode for E2E
- [ ] 13.1.10 Add per-photo opt-out support

### Database Schema

**face_detection_settings** (singleton): enabled, process_existing, min_face_size, min_confidence, min_quality, store_crops, updated_at

**face_instance**: id, virtual_media_id, bbox_json, confidence, landmarks_json, embedding_blob, embedding_model, embedding_version, quality_json, quality_overall (denormalized), crop_path, face_cluster_id, is_dismissed, created_at

### Acceptance Criteria

- [ ] Faces detected with bounding boxes and landmarks
- [ ] Embeddings computed and L2-normalized
- [ ] Quality assessed per face
- [ ] Small/low-confidence/low-quality faces filtered
- [ ] Per-photo opt-out respected
- [ ] Processing cancellable

### Edge Cases

- **No faces in photo**: Store empty result, don't reprocess
- **Many faces (>20)**: Process all, but warn user about performance
- **Partially visible faces**: Include if confidence above threshold
- **Sunglasses/masks**: Lower quality score, still include
- **Photos with opt-out**: Skip entirely, log skip

### Error Handling

| Error | Response |
|-------|----------|
| Model unavailable | Skip detection, show setup prompt |
| Single photo fails | Log, continue to next |
| Out of memory | Skip large photos, log |

---

## Issue 13.2 — Face Clustering

### Goal

Cluster face embeddings into groups representing same person.

### Dev Tasks

- [ ] 13.2.1 Implement HDBSCAN clustering via Python
- [ ] 13.2.2 Implement incremental cluster assignment for new faces
- [ ] 13.2.3 Select representative face (highest quality in cluster)
- [ ] 13.2.4 Track merge history for user corrections
- [ ] 13.2.5 Implement re-clustering trigger (every N new faces)
- [ ] 13.2.6 Update denormalized counts on cluster changes
- [ ] 13.2.7 Preserve person_id links across re-clustering

### Database Schema

**face_cluster**: id, representative_face_id, face_count, photo_count, person_id (nullable, from M17), is_hidden, merge_source_ids (JSON), created_at, updated_at

**clustering_run**: id, algorithm, face_count, cluster_count, parameters_json, duration_ms, created_at

### Clustering Algorithm

1. Load all non-dismissed face embeddings
2. If < min_cluster_size faces, create singleton clusters
3. Run HDBSCAN with configured parameters
4. Noise points (-1 label) become singleton clusters
5. For each cluster: select highest-quality face as representative
6. Match new clusters to existing by overlap (preserve person_id links)
7. Update face_instance.face_cluster_id assignments
8. Update cluster counts

### Incremental Assignment

For each new face:
1. Compute cosine similarity to all cluster representatives
2. If best match > threshold (0.6): assign to that cluster
3. Otherwise: add to pending queue
4. When pending queue reaches threshold: trigger re-clustering

### Acceptance Criteria

- [ ] HDBSCAN produces meaningful clusters
- [ ] Incremental assignment works for new faces
- [ ] Representative is highest-quality face
- [ ] Re-clustering triggers after N new faces
- [ ] User corrections (person_id) preserved
- [ ] Cluster counts accurate

### Edge Cases

- **Single face per person**: Create singleton cluster
- **Very similar people (twins)**: May cluster together, user can split
- **Person changes appearance**: May create multiple clusters, user can merge
- **Noise points**: Become singleton clusters, reviewable separately

---

## Issue 13.3 — People View

### Goal

Create People view showing face clusters.

### Dev Tasks

- [ ] 13.3.1 Create PeopleView route and navigation
- [ ] 13.3.2 Implement FaceClusterCard component
- [ ] 13.3.3 Add virtualized grid for performance
- [ ] 13.3.4 Load face crop thumbnails
- [ ] 13.3.5 Implement sort options (photo count, recent, name)
- [ ] 13.3.6 Add filter tabs: All / Named / Unknown
- [ ] 13.3.7 Show empty state when no faces
- [ ] 13.3.8 Show loading state during fetch

### UI Layout

```
👥 People                              [Sort: Most photos ▼]
[All] [Named] [Unknown]

┌─────────┐ ┌─────────┐ ┌─────────┐
│ (face)  │ │ (face)  │ │ (face)  │
│ Alice   │ │ Bob     │ │ Unknown │
│ 156     │ │ 98      │ │ 45      │
└─────────┘ └─────────┘ └─────────┘
```

### Acceptance Criteria

- [ ] Shows face clusters as cards
- [ ] Sorted by photo count by default
- [ ] Representative face as thumbnail
- [ ] Named vs Unknown tabs work
- [ ] Empty state when no faces detected
- [ ] Click navigates to filtered library

### Stable Selectors

`people-view`, `people-grid`, `face-cluster-{id}`, `face-cluster-name`, `people-sort`, `people-filter-all`, `people-filter-named`, `people-filter-unknown`

---

## Issue 13.4 — Filter Library by Person

### Goal

Clicking a cluster filters library to photos with that person.

### Dev Tasks

- [ ] 13.4.1 Add face filter to URL state
- [ ] 13.4.2 Implement face filter query join
- [ ] 13.4.3 Create filter banner with face thumbnail
- [ ] 13.4.4 Implement clear functionality
- [ ] 13.4.5 Combine with other facets (AND logic)

### Acceptance Criteria

- [ ] Click cluster → library shows matching photos
- [ ] Filter banner shows person thumbnail and name
- [ ] Clear removes filter
- [ ] Combines with date, keyword, location filters
- [ ] URL reflects filter state

### Stable Selectors

`face-filter-active`, `clear-face-filter`

---

## Issue 13.5 — Inspector Faces

### Goal

Show detected faces in photo inspector.

### Dev Tasks

- [ ] 13.5.1 Create InspectorFaces component
- [ ] 13.5.2 Display face crops with person names
- [ ] 13.5.3 Add click-to-filter by person
- [ ] 13.5.4 Add "Not a face" dismiss action
- [ ] 13.5.5 Handle many faces (collapse after 5)

### UI Layout

```
👥 People in this photo (3)
   ┌─────┐ ┌─────┐ ┌─────┐
   │     │ │     │ │     │
   └─────┘ └─────┘ └─────┘
   Alice   Bob     Unknown
```

### Acceptance Criteria

- [ ] Faces shown with crops
- [ ] Person name or "Unknown" label
- [ ] Click filters library
- [ ] Dismiss removes face from cluster
- [ ] Collapse for many faces

### Stable Selectors

`inspector-faces`, `inspector-face-{id}`, `dismiss-face-{id}`

---

## Issue 13.6 — Merge and Split Clusters

### Goal

Manual correction of clustering mistakes.

### Dev Tasks

- [ ] 13.6.1 Implement multi-select in People view
- [ ] 13.6.2 Create MergeClustersModal
- [ ] 13.6.3 Implement merge backend (combine faces, update counts)
- [ ] 13.6.4 Create SplitClusterModal with face selection
- [ ] 13.6.5 Implement split backend (create new cluster from selection)
- [ ] 13.6.6 Preserve merge/split history for re-clustering

### Merge Flow

1. User selects 2+ clusters
2. Confirms merge, optionally sets name
3. All faces move to target cluster
4. Best quality face becomes new representative
5. Source clusters deleted
6. Merge recorded in target cluster's merge_source_ids

### Split Flow

1. User opens cluster detail view
2. Selects faces that don't belong
3. Creates new cluster from selection
4. Original cluster's representative may change

### Acceptance Criteria

- [ ] Multi-select works in People view
- [ ] Merge combines all faces
- [ ] Person name preserved from any source
- [ ] Split creates new cluster
- [ ] History preserved for re-clustering

### Stable Selectors

`merge-clusters-modal`, `confirm-merge-button`, `split-cluster-modal`

---

## E2E Test Scenarios

1. **faces_detected_and_clustered**: Import photos with faces → People view shows clusters → count correct
2. **people_view_cluster_to_photos**: Click cluster → library filtered → face banner visible → clear works
3. **incremental_clustering**: Import more photos → new faces assigned to existing clusters
4. **merge_clusters**: Select two clusters → merge → single cluster with combined count
5. **dismiss_face**: Open inspector → dismiss face → removed from cluster
6. **face_detection_opt_out**: Mark photo opt-out → no faces detected for that photo

---

## Performance Targets

| Operation | Target |
|-----------|--------|
| Face detection (per image) | <500ms |
| Embedding computation (per face) | <100ms |
| Quality assessment (per face) | <50ms |
| HDBSCAN (1000 faces) | <2s |
| Incremental assignment | <100ms |
| People view load (50 clusters) | <200ms |

---

## Dependencies

- **M1**: Detection runs during import enrichment
- **M2**: Detection as background job
- **M12b**: Can skip photos labeled "no people"
- **M17**: Person naming and details
