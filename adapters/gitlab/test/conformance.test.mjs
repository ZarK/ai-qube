import { runAdapterConformance } from "@tjalve/qube-testkit";

import { gitlabHarness } from "./gitlab.harness.mjs";

runAdapterConformance(gitlabHarness);
