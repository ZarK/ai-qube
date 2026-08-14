import { access, copyFile, unlink } from "node:fs/promises";
import path from "node:path";

const packageJsonPath = path.resolve(process.argv[2] ?? "package.json");
const backupPath = `${packageJsonPath}.publish-backup`;

let backupPresent = false;
try {
  await access(backupPath);
  backupPresent = true;
} catch {
  process.stdout.write(`${JSON.stringify({ ok: true, restored: false, packageJsonPath })}\n`);
}

if (backupPresent) {
  try {
    await copyFile(backupPath, packageJsonPath);
    await unlink(backupPath);
    process.stdout.write(`${JSON.stringify({ ok: true, restored: true, packageJsonPath })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, restored: false, packageJsonPath })}\n`);
    process.exitCode = 1;
  }
}
