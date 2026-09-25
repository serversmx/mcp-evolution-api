/**
 * Websocket integration — /websocket/*  (nested body format)
 */

import { makeEventTransportGroup } from "./eventTransport.js";

export const websocketGroup = makeEventTransportGroup({
  base: "websocket",
  label: "Websocket",
  envFlag: "WEBSOCKET_ENABLED",
});
