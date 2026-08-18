import path from "node:path";
import { fileURLToPath } from "node:url";

import { finalizePublishPlan, readPublishedVersionsForPlan, resolvePublishTag } from "./publish-packages.mjs";
import { prepareRelease } from "./prepare-release.mjs";

export async function resolvePublishPlan(tag, options = {}) {
  const resolved = await resolvePublishTag(tag, options.root);
  const publishedByName = options.publishedByName ?? await readPublishedVersionsForPlan(resolved, options);
  if (resolved.mode === "set") {
    const preparation = await (options.prepareRelease ?? prepareRelease)({
      repoRoot: options.root,
      publishedByName,
      excludeBaselineTag: tag,
    });
    if (preparation.needsWrite) {
      throw Object.assign(new Error("The set tag contains an incomplete release preparation."), {
        reasonCode: "release-unprepared",
      });
    }
  }
  return finalizePublishPlan(resolved, publishedByName);
}

export async function main(tag = process.argv[2] ?? "") {
  const plan = await resolvePublishPlan(tag);
  const first = plan.packages[0];
  process.stdout.write(`${JSON.stringify({
    mode: plan.mode,
    setVersion: plan.setVersion,
    packageKey: first?.packageKey,
    packageName: first?.packageName,
    version: first?.version,
    filter: first?.filter,
    path: first?.path,
    prepare: plan.prepare,
    verify: plan.verify,
    packages: plan.packages,
    verifyPackages: plan.verifyPackages,
    skipped: plan.skipped,
  })}\n`);
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
