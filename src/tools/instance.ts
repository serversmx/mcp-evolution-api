/**
 * Instance Controller — /instance/*
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { instanceField, eventsField } from "../schemas/common.js";
import { compact } from "./helpers.js";

const tools: ToolDef[] = [
  {
    name: "evolution_instance_create",
    description:
      "Create a new WhatsApp instance (requires the GLOBAL api key). The response `hash` is the " +
      "instance token. Instance settings are flat top-level fields (rejectCall, msgCall, ...).",
    inputSchema: z.object({
      instanceName: z.string().describe("Name for the new instance (becomes the path segment)."),
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
    handler: async (client, args) =>
      client.get(`/instance/fetchInstances`, {
        query: {
          instanceName: args.instanceName as string | undefined,
          instanceId: args.instanceId as string | undefined,
          number: args.number as string | undefined,
        },
      }),
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
