/**
 * Shared factory for the event transports that take `{<name>: {enabled, events}}`
 * (websocket, rabbitmq, sqs, nats, kafka). Connection details (URI, queues,
 * region, ...) are server env settings, not per instance.
 */

import { z } from "zod";
import type { ToolGroup } from "../../types.js";
import { instanceField, eventsField } from "../../schemas/common.js";

export interface EventTransportOptions {
  /** Group key and URL base, e.g. "rabbitmq". */
  base: string;
  /** Human label, e.g. "RabbitMQ". */
  label: string;
  /** Server env flag that must be true, e.g. "RABBITMQ_ENABLED". */
  envFlag: string;
}

export function makeEventTransportGroup({ base, label, envFlag }: EventTransportOptions): ToolGroup {
  return {
    group: base,
    core: false,
    label,
    tools: [
      {
        name: `evolution_${base}_set`,
        description:
          `Configure ${label} event publishing for an instance. Requires ${envFlag}=true on the server ` +
          "(otherwise the call is a silent no-op with an empty response).",
        inputSchema: z.object({
          instance: instanceField,
          enabled: z.boolean().describe(`Enable or disable ${label} events.`),
          events: eventsField,
        }),
        handler: async (client, args) => {
          const inst = client.resolveInstance(args.instance as string | undefined);
          // `events` is always sent ([] = all): omitting it makes the server fail with HTTP 500.
          return client.post(`/${base}/set/${inst}`, {
            body: { [base]: { enabled: args.enabled, events: args.events ?? [] } },
          });
        },
      },
      {
        name: `evolution_${base}_find`,
        description: `Get the ${label} configuration for an instance (empty when ${envFlag} is off).`,
        inputSchema: z.object({ instance: instanceField }),
        handler: async (client, args) => {
          const inst = client.resolveInstance(args.instance as string | undefined);
          return client.get(`/${base}/find/${inst}`);
        },
      },
    ],
  };
}
