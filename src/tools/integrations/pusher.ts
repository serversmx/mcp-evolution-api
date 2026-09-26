/**
 * Pusher integration — /pusher/*  (nested body format with per-instance credentials)
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../../types.js";
import { instanceField, eventsField } from "../../schemas/common.js";

const tools: ToolDef[] = [
  {
    name: "evolution_pusher_set",
    description:
      "Configure Pusher event publishing for an instance. Requires PUSHER_ENABLED=true on the server.",
    inputSchema: z.object({
      instance: instanceField,
      enabled: z.boolean().describe("Enable or disable Pusher events."),
      appId: z.string().min(1).describe("Pusher app id."),
      key: z.string().describe("Pusher key."),
      secret: z.string().describe("Pusher secret."),
      cluster: z.string().describe("Pusher cluster, e.g. us2."),
      useTLS: z.boolean().describe("Use TLS."),
      events: eventsField,
    }),
    handler: async (client, args) => {
      const { instance, ...pusher } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      // `events` is always sent ([] = all): omitting it makes the server crash.
      return client.post(`/pusher/set/${inst}`, {
        body: { pusher: { ...pusher, events: pusher.events ?? [] } },
      });
    },
  },
  {
    name: "evolution_pusher_find",
    description: "Get the Pusher configuration for an instance (includes the secret).",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/pusher/find/${inst}`);
    },
  },
];

export const pusherGroup: ToolGroup = {
  group: "pusher",
  core: false,
  label: "Pusher",
  tools,
};
