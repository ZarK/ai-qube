import { runAdapterConformance } from "@tjalve/qube-testkit";

import { jenkinsHarness } from "./jenkins.harness.mjs";

runAdapterConformance(jenkinsHarness);
