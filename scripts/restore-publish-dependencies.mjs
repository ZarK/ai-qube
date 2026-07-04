import { access, copyFile, unlink } from "node:fs/promises";
import path from "node:path";

const packageJsonPath = path.resolve(process.argv[2] ?? "package.json");
const backupPath = `${packageJsonPath}.publish-backup`;

try {
  await access(backupPath);
  await copyFile(backupPath, packageJsonPath);
  await unlink(backupPath);
  process.stdout.write(`${JSON.stringify({ ok: true, restored: true, packageJsonPath })}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({ ok: true, restored: false, packageJsonPath })}\n`);
}