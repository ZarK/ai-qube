# Model routing

`policy.modelRouting` tells Executor how to delegate coding-cycle work that is
not a review lane. Review lanes keep using `policy.reviews.models`.

## Catalog and routes

```json
{
  "policy": {
    "modelRouting": {
      "primary": "claude-code:default",
      "catalog": [
        {
          "id": "claude-code:default",
          "host": "claude-code",
          "transport": "host",
          "costRank": 3,
          "notes": "Primary host model. Fallback target for every delegated route class."
        },
        {
          "id": "grok:grok-4.5",
          "host": "grok",
          "transport": "cli",
          "costRank": 1,
          "notes": "Preferred model for mechanical implementation."
        }
      ],
      "routes": {
        "mechanical-implementation": {
          "preferred": "grok:grok-4.5",
          "fallback": ["grok:grok-4.5", "claude-code:default"]
        },
        "exploration-investigation": {
          "preferred": "claude-code:default",
          "fallback": ["claude-code:default"]
        },
        "independent-review": {
          "reviewTier": "economy"
        },
        "synthesis-judgment": {
          "preferred": "claude-code:default",
          "fallback": ["claude-code:default"]
        }
      }
    }
  }
}
```

- Catalog hosts are `codex`, `claude-code`, `opencode`, and `grok`.
- Every delegated fallback chain must end at `primary`.
- `independent-review` references a `reviewModels` tier. It must not pick a
  catalog model.

## Init

`qube init` and `aie init` accept the same non-TTY flags:

- `--primary-host`
- `--primary-model`
- `--route-mechanical-implementation host:model`
- `--route-exploration-investigation host:model`
- `--route-synthesis-judgment host:model`
- `--route-independent-review review|economy|synthesis`

Only installed host CLIs are offered. An uninstalled host fails loudly.

## Host assets

Init writes a Model routing instruction section. Wrapper runner agents are
written only for non-primary hosts that appear on a delegated route.

## JSON

`aie init --json` and `qube doctor --json` report the resolved routes and any
substitutions. A fallback is never reported as the originally requested model.
