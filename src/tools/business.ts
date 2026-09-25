/**
 * WhatsApp Business catalog — /business/*  (Baileys instances)
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { instanceField } from "../schemas/common.js";
import { postBody } from "./helpers.js";

const numberOpt = z
  .string()
  .optional()
  .describe("Business number or JID whose catalog to read (defaults to the instance's own number).");

const tools: ToolDef[] = [
  {
    name: "evolution_business_get_catalog",
    description: "Get the product catalog of a WhatsApp Business account. WHATSAPP-BAILEYS instances only.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberOpt,
      limit: z.number().int().positive().optional().describe("Page size (default 10; the server follows a few extra pages)."),
    }),
    handler: postBody("/business/getCatalog"),
  },
  {
    name: "evolution_business_get_collections",
    description: "Get the catalog collections of a WhatsApp Business account. WHATSAPP-BAILEYS instances only.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberOpt,
      limit: z.number().int().positive().max(20).optional().describe("Max collections (max 20)."),
    }),
    handler: postBody("/business/getCollections"),
  },
];

export const businessGroup: ToolGroup = {
  group: "business",
  core: false,
  label: "Business catalog",
  tools,
};
