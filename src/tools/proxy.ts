/**
 * Proxy — /proxy/*
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { instanceField } from "../schemas/common.js";
import { compact } from "./helpers.js";

const tools: ToolDef[] = [
  {
    name: "evolution_proxy_set",
    description:
      "Set or disable the outbound proxy of an instance. When enabled the proxy is tested (the egress IP " +
      "must change) and an unusable proxy fails with 400 'Invalid proxy'. The response echoes the password.",
    inputSchema: z.object({
      instance: instanceField,
      enabled: z.boolean().describe("true to use the proxy; false disables it (clears host/port/credentials)."),
      host: z
        .string()
        .min(1)
        .describe("Proxy host. Required by the API even when disabling (send the current value or any placeholder)."),
      port: z.union([z.string(), z.number()]).describe("Proxy port."),
      protocol: z.enum(["http", "https", "socks4", "socks5"]).describe("Proxy protocol."),
      username: z.string().optional().describe("Proxy user."),
      password: z.string().optional().describe("Proxy password."),
    }),
    handler: async (client, args) => {
      const { instance, port, ...rest } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      // The API expects the port as a string.
      return client.post(`/proxy/set/${inst}`, { body: compact({ ...rest, port: String(port) }) });
    },
  },
  {
    name: "evolution_proxy_find",
    description: "Get the proxy configuration of an instance (includes the proxy password; null when none).",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/proxy/find/${inst}`);
    },
  },
];

export const proxyGroup: ToolGroup = {
  group: "proxy",
  core: false,
  label: "Proxy",
  tools,
};
