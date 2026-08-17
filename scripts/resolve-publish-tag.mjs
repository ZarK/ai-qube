import { finalizePublishPlan, readPublishedVersionsForPlan, resolvePublishTag } from "./publish-packages.mjs";

const tag = process.argv[2] ?? "";

try {
  const resolved = await resolvePublishTag(tag);
  const publishedByName = await readPublishedVersionsForPlan(resolved);
  const plan = finalizePublishPlan(resolved, publishedByName);
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
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
