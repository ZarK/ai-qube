import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve("docs");
const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4173", 10);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

function resolvePath(url) {
  const parsed = new URL(url, `http://${host}:${port}`);
  const decoded = decodeURIComponent(parsed.pathname);
  const relative = normalize(decoded === "/" ? "/index.html" : decoded).replace(/^[/\\]+/, "");
  const filePath = resolve(join(root, relative));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return null;
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  if (stat.isDirectory()) return resolve(join(filePath, "index.html"));
  return filePath;
}

const server = createServer((request, response) => {
  const filePath = resolvePath(request.url ?? "/");
  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }
  response.writeHead(200, { "content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream" });
  createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`QUBE docs preview: http://${host}:${port}/`);
});
