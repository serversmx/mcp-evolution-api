/**
 * Instance Controller — /instance/*
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { EvolutionApiError } from "../client.js";
import { instanceField, eventsField } from "../schemas/common.js";
import { compact } from "./helpers.js";

interface InstanceFilters {
  instanceName?: string;
  instanceId?: string;
  number?: string;
}

/**
 * Re-apply 2.3.7's fetchInstances filter precedence (instanceId > number > instanceName) to the
 * response. Evolution develop (#2549) strips instanceName/instanceId from the query, so the global key
 * gets every instance with its secrets. A no-op when the server already filtered.
 */
function filterInstances(result: unknown, { instanceName, instanceId, number }: InstanceFilters): unknown {
  if (!Array.isArray(result)) return result;
  let field: "id" | "name";
  let value: string;
  if (instanceId) {
    [field, value] = ["id", instanceId];
  } else if (number) {
    return result;
  } else if (instanceName) {
    [field, value] = ["name", instanceName];
  } else {
    return result;
  }
  const matches = result.filter(
    (item) => item && typeof item === "object" && (item as Record<string, unknown>)[field] === value,
  );
  if (matches.length === 0) {
    throw new EvolutionApiError(404, `Instance "${value}" not found`, null);
  }
  return matches;
}

const tools: ToolDef[] = [
  {
    name: "evolution_instance_create",
    description:
      "Create a new WhatsApp instance (requires the GLOBAL api key). The response `hash` is the " +
      "instance token. Instance settings are flat top-level fields (rejectCall, msgCall, ...). Evolution " +
      "API develop builds with security fix #2549 (unreleased) reject every creation with HTTP 400 naming " +
      "an *_instanceId_fkey foreign key (upstream bug; 2.3.7 and 2.4.0-rc2 work).",
    inputSchema: z.object({
      instanceName: z.string().trim().min(1).describe("Name for the new instance (becomes the path segment)."),
      integration: z
        .enum(["WHATSAPP-BAILEYS", "WHATSAPP-BUSINESS", "EVOLUTION"])
        .default("WHATSAPP-BAILEYS")
        .describe("Channel. WHATSAPP-BUSINESS = Meta Cloud API (needs token + number; businessId is used by templates)."),
      token: z
        .string()
        .optional()
        .describe(
          "Instance API token (auto-generated when omitted). REQUIRED for WHATSAPP-BUSINESS: the Meta permanent access token.",
        ),
      number: z
        .string()
        .optional()
        .describe(
          "Baileys: phone digits (with qrcode:true returns a pairing code). WHATSAPP-BUSINESS: the Meta phone-number-id (required).",
        ),
      businessId: z
        .string()
        .optional()
        .describe("WHATSAPP-BUSINESS only: WABA id (used by the template tools)."),
      qrcode: z.boolean().optional().describe("Baileys only: connect immediately and return the QR code."),
      rejectCall: z.boolean().optional().describe("Setting: automatically reject incoming calls."),
      msgCall: z.string().optional().describe("Setting: message sent when rejecting a call."),
      groupsIgnore: z.boolean().optional().describe("Setting: ignore group messages."),
      alwaysOnline: z.boolean().optional().describe("Setting: keep the instance always online."),
      readMessages: z.boolean().optional().describe("Setting: mark received messages as read."),
      readStatus: z.boolean().optional().describe("Setting: mark status updates as read."),
      syncFullHistory: z.boolean().optional().describe("Setting: sync full chat history on first connection."),
      wavoipToken: z.string().optional().describe("Setting: WAVoIP token (voice calls)."),
      webhook: z
        .object({
          url: z.string().describe("Webhook URL (must start with http:// or https://)."),
          events: eventsField,
          headers: z.record(z.string()).optional().describe("Extra HTTP headers sent on every delivery."),
          byEvents: z.boolean().optional().describe("Append /<event-name> to the URL."),
          base64: z.boolean().optional().describe("Include media base64 in message events."),
        })
        .optional()
        .describe("Inline webhook for the new instance (enabled automatically)."),
    }),
    handler: async (client, args) => {
      const body = compact(args);
      if (body.webhook) {
        const webhook = body.webhook as Record<string, unknown>;
        // Inline webhooks go through the same events.length access as /webhook/set.
        body.webhook = { ...webhook, events: webhook.events ?? [] };
      }
      return client.post(`/instance/create`, { body });
    },
  },
  {
    name: "evolution_instance_fetch",
    description:
      "List instances (optionally filtered by name, id or stored number). The response contains secrets (token, Chatwoot token, proxy password).",
    inputSchema: z.object({
      instanceName: z.string().optional().describe("Filter by instance name."),
      instanceId: z.string().optional().describe("Filter by instance id."),
      number: z.string().optional().describe("Filter by stored number (global API key only)."),
    }),
    handler: async (client, args) => {
      const filters: InstanceFilters = {
        instanceName: args.instanceName as string | undefined,
        instanceId: args.instanceId as string | undefined,
        number: args.number as string | undefined,
      };
      const result = await client.get(`/instance/fetchInstances`, { query: { ...filters } });
      return filterInstances(result, filters);
    },
  },
  {
    name: "evolution_instance_connect",
    description: "Connect an instance and get the QR code (base64 PNG data URI) or a pairing code.",
    inputSchema: z.object({
      instance: instanceField,
      number: z.string().optional().describe("Phone digits for pairing-code login instead of QR."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/instance/connect/${inst}`, {
        query: { number: args.number as string | undefined },
      });
    },
  },
  {
    name: "evolution_instance_connection_state",
    description: "Get the connection state of an instance (open/connecting/close).",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/instance/connectionState/${inst}`);
    },
  },
  {
    name: "evolution_instance_restart",
    description:
      "Restart an instance. When the instance is closed the server answers 200 with {error:true}: " +
      "use evolution_instance_connect instead.",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/instance/restart/${inst}`);
    },
  },
  {
    name: "evolution_instance_set_presence",
    description: "Set the global presence of a WHATSAPP-BAILEYS instance.",
    inputSchema: z.object({
      instance: instanceField,
      presence: z.enum(["available", "unavailable", "composing", "recording", "paused"]).describe("Presence state."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/instance/setPresence/${inst}`, { body: { presence: args.presence } });
    },
  },
  {
    name: "evolution_instance_logout",
    description:
      "Log out (disconnect) an instance without deleting it. 2.3.7 answers 400 if it is already disconnected.",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.delete(`/instance/logout/${inst}`);
    },
  },
  {
    name: "evolution_instance_delete",
    description: "Delete an instance permanently (logs it out first).",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.delete(`/instance/delete/${inst}`);
    },
  },
];

export const instanceGroup: ToolGroup = {
  group: "instance",
  core: true,
  label: "Instance management",
  tools,
};
