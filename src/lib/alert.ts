import { config } from "../config/index.js";
import { logger } from "./logger.js";

// Emits a critical alert: always logged, and posted to an external webhook when one is configured so
// on-call tooling sees fund-safety and data-integrity failures without scraping logs. Delivery is
// best-effort; a webhook failure is logged but never throws back into the caller's path.
export async function alert(message: string, context: Record<string, unknown>): Promise<void> {
  logger.error(context, message);
  if (!config.ALERT_WEBHOOK_URL) {
    return;
  }
  try {
    await fetch(config.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "cyphras-relayer", message, ...context }),
    });
  } catch (err) {
    logger.warn({ err }, "alert webhook delivery failed");
  }
}
