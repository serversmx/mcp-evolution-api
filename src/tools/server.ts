/**
 * Server-level routes — /verify-creds
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";

const tools: ToolDef[] = [
  {
    name: "evolution_server_verify_creds",
    description:
      "Check that the configured API key is the server's GLOBAL key (instance tokens get 401). " +
      "Returns only the status; the Facebook app values the server echoes back are withheld.",
    inputSchema: z.object({}),
    handler: async (client) => {
      const res = await client.post<Record<string, unknown> | null>(`/verify-creds`);
      // The response leaks FACEBOOK_* env values (incl. the user token): never surface them.
      const r = res && typeof res === "object" ? res : {};
      return {
        status: r.status ?? 200,
        message: r.message ?? "Credentials are valid",
        facebookAppConfigured: Boolean(r.facebookAppId),
      };
    },
  },
];

export const serverGroup: ToolGroup = {
  group: "server",
  core: true,
  label: "Server credentials check",
  tools,
};
