import { resolvePublishTag } from "./publish-packages.mjs";

const tag = process.argv[2] ?? "";

try {
  const plan = await resolvePublishTag(tag);
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
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
