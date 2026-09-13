import { initBotId } from "botid/client/core";

/**
 * Bot protection for the one public endpoint that writes: checkout. The route
 * calls `checkBotId()` and refuses a script before it becomes an order row an
 * admin has to cancel.
 *
 * Only BotID lives here. Analytics deliberately does not — it loads on idle
 * from `lib/analytics.ts` so it never sits on the landing page's first paint.
 */
initBotId({
	protect: [{ path: "/api/orders", method: "POST" }],
});
