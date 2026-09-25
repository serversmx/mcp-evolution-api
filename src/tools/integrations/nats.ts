/**
 * NATS integration — /nats/*  (nested body format)
 */

import { makeEventTransportGroup } from "./eventTransport.js";

export const natsGroup = makeEventTransportGroup({
  base: "nats",
  label: "NATS",
  envFlag: "NATS_ENABLED",
});
