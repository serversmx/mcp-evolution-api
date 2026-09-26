/**
 * RabbitMQ integration — /rabbitmq/*  (nested body format)
 */

import { makeEventTransportGroup } from "./eventTransport.js";

export const rabbitmqGroup = makeEventTransportGroup({
  base: "rabbitmq",
  label: "RabbitMQ",
  envFlag: "RABBITMQ_ENABLED",
});
