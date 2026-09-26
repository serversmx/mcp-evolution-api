/**
 * Read-only smoke test against a live Evolution API instance.
 *
 * Runs only safe GET endpoints (no messages are sent, nothing is modified).
 * Usage: build, then `node dist/smoke.js` with env configured.
 */

import { loadConfig } from "./config.js";
import { EvolutionClient } from "./client.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new EvolutionClient(config);

  const checks: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: "fetchInstances", run: () => client.get("/instance/fetchInstances") },
  ];

  if (config.defaultInstance) {
    const inst = client.resolveInstance(); // URL-encoded default instance
    checks.push(
      { name: `connectionState/${inst}`, run: () => client.get(`/instance/connectionState/${inst}`) },
      { name: `settings/find/${inst}`, run: () => client.get(`/settings/find/${inst}`) },
      { name: `webhook/find/${inst}`, run: () => client.get(`/webhook/find/${inst}`) },
    );
  }

  let failures = 0;
  for (const check of checks) {
    try {
      const result = await check.run();
      const preview = JSON.stringify(result).slice(0, 200);
      console.log(`✅ ${check.name}: ${preview}`);
    } catch (err) {
      failures += 1;
      console.error(`❌ ${check.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${checks.length - failures}/${checks.length} checks passed.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("smoke test fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
