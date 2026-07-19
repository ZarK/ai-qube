import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCommandSurfacesDoc } from "../dist/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const target = path.join(repoRoot, "docs", "qube-command-surfaces.md");
writeFileSync(target, renderCommandSurfacesDoc(), "utf8");
process.stdout.write(`Wrote ${target}\n`);
