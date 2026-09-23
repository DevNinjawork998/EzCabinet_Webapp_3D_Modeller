#!/usr/bin/env node
/**
 * Send one real WhatsApp message, without the app in the way.
 *
 * CI proves the payloads match what we believe Meta's API is; this proves the
 * token, the phone number id and Meta's API agree. It sends Meta's built-in
 * `hello_world` template, which every WhatsApp Business account has approved
 * from day one, so it works before any of our templates are approved.
 *
 *   pnpm whatsapp:ping +60123456789
 *
 * Not in CI: it needs live credentials and messages a real phone.
 */

const TOKEN = process.env.WHATSAPP_TOKEN ?? "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
const to = (process.argv[2] ?? "").replace(/\D/g, "");

if (TOKEN === "" || PHONE_NUMBER_ID === "") {
	console.error(
		"Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env.local.",
	);
	process.exit(1);
}
if (to === "") {
	console.error("Usage: pnpm whatsapp:ping +60123456789");
	process.exit(1);
}

const response = await fetch(
	`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,
	{
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to,
			type: "template",
			template: { name: "hello_world", language: { code: "en_US" } },
		}),
	},
);
console.log(response.status, await response.text());
process.exit(response.ok ? 0 : 1);
