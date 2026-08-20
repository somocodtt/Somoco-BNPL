import { resolve } from "node:path";
import { createServer } from "vite";

export default async function globalSetup() {
  const staffRoot = resolve(process.cwd(), "../staff-web");
  const server = await createServer({
    root: staffRoot,
    configFile: resolve(staffRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 4179, strictPort: true },
  });
  await server.listen();
  return async () => {
    await server.close();
  };
}
