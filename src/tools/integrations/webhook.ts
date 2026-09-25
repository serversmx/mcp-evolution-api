/**
 * Webhook integration — /webhook/*  (nested body format)
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../../types.js";
import { instanceField, eventsField } from "../../schemas/common.js";
import { compact } from "../helpers.js";

const tools: ToolDef[] = [
  {
    name: "evolution_webhook_set",
    description:
      "Configure the HTTP webhook for an instance. There is exactly ONE webhook per instance: this " +
      "replaces the previous configuration. Tip: headers.jwt_key makes the server send " +
      "'Authorization: Bearer <HS256 JWT>' signed with that secret.",
    inputSchema: z.object({
      instance: instanceField,
      enabled: z.boolean().describe("Enable or disable the webhook."),
      url: z.string().describe("Webhook URL (deliveries only happen for http:// or https:// URLs)."),
      headers: z.record(z.string()).optional().describe("Extra HTTP headers sent on every delivery."),
      byEvents: z.boolean().optional().describe("Append /<event-name> to the URL path."),
      base64: z.boolean().optional().describe("Include media base64 in message event payloads."),
      events: eventsField,
    }),
    handler: async (client, args) => {
      const { instance, ...webhook } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      // `events` is always sent ([] = all): omitting it makes the server fail with HTTP 500.
      return client.post(`/webhook/set/${inst}`, {
        body: { webhook: { ...compact(webhook), events: webhook.events ?? [] } },
      });
    },
  },
  {
    name: "evolution_webhook_find",
    description:
      "Get the webhook configuration for an instance (null when none). Headers, including jwt_key, are returned in clear.",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/webhook/find/${inst}`);
    },
  },
];

export const webhookGroup: ToolGroup = {
  group: "webhook",
  core: true,
  label: "Webhook",
  tools,
};
