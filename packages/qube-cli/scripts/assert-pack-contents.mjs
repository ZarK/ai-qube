import { assertPackContents, assertPackSafety, runPackDryRun } from "../dist/testing/index.js";
import { expectedPackFiles } from "./expected-pack-files.mjs";

const packEntry = runPackDryRun({ cwd: new URL("..", import.meta.url) });
assertPackSafety(packEntry);
const { actualFiles } = assertPackContents(packEntry, expectedPackFiles);

console.log(`Pack contents verified: ${actualFiles.join(", ")}`);
