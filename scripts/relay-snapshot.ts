#!/usr/bin/env bun
/**
 * Writes src/relay/snapshot.json: this version's tool list and instructions, which the relay serves when the
 * Mac has never answered it. tests/relay.test.ts fails if the snapshot drifts from src/mcp/tools.ts.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pkg from "../package.json" with { type: "json" };
import { buildServer, type Service } from "../src/mcp/tools.ts";

const server = buildServer({} as Service, { label: "snapshot", elicitation: false });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "snapshot", version: "0" });
await client.connect(b);
const { tools } = await client.listTools();
const out = { version: pkg.version, instructions: client.getInstructions() ?? "", tools };
writeFileSync(join(import.meta.dir, "../src/relay/snapshot.json"), `${JSON.stringify(out, null, 2)}\n`);
await client.close();
console.log(`snapshot: ${tools.length} tools, version ${pkg.version}`);
