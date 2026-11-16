/**
 * `switchboard mcp`: the thin stdio shim a harness launches. It holds no permissions and reads no
 * data; it sends one hello line naming the client, then pipes MCP bytes between stdio and the daemon.
 */
import { connect } from "node:net";
import { paths } from "../config.ts";

export function runShim(client: string): void {
  const p = paths();
  const sock = connect(p.socket);
  sock.on("connect", () => {
    sock.write(`${JSON.stringify({ client })}\n`);
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });
  sock.on("error", (e) => {
    console.error(
      `switchboard: can't reach the daemon at ${p.socket} (${(e as NodeJS.ErrnoException).code ?? e.message}). ` +
        "Is it installed and running? Try `switchboard doctor`.",
    );
    process.exit(1);
  });
  sock.on("close", () => process.exit(0));
  process.stdin.on("end", () => sock.end());
}
