#!/usr/bin/env node
/**
 * Talk to FedEx without the app in the way.
 *
 *   node --env-file=.env.local scripts/fedex-ping.mjs
 *   pnpm fedex:ping
 *
 * CI runs `adapters/fedex.ts` against fixtures built from FedEx's documented
 * shapes — our belief about FedEx, not FedEx. This is what notices a renamed
 * field or a refused body. It only checks token, rate and track: a token, one
 * rate for a small parcel between two real Malaysian postcodes, and one
 * tracking lookup. It never creates a shipment, books a pickup, cancels
 * either, or fetches a label — those are first exercised by the first real
 * booking, so watch that one with FedEx Ship Manager open and cancel it
 * there if anything looks wrong.
 *
 * **Only meaningful against production.** The sandbox answers only its own
 * canned inputs: this rate request comes back SERVICE.PACKAGECOMBINATION.INVALID
 * there, and even the canned Malaysian rates are USD. What to look for live:
 *
 * - the token call succeeds (sandbox credentials are refused by production,
 *   and the other way round — switch FEDEX_API_URL and the key pair together);
 * - FEDEX_PRIORITY is offered for the lane, priced in MYR;
 * - the tracking reply parses (any real tracking number of ours will do:
 *   FEDEX_PING_TRACKING=794953535000 pnpm fedex:ping).
 */

const BASE = (process.env.FEDEX_API_URL || "https://apis-sandbox.fedex.com")
	.trim()
	.replace(/\/+$/, "");
const KEY = process.env.FEDEX_API_KEY ?? "";
const SECRET = process.env.FEDEX_API_PASSWORD ?? "";
const ACCOUNT = process.env.FEDEX_ACCOUNT_NUMBER ?? "";
const TRACKING = process.env.FEDEX_PING_TRACKING || "123456789012";

const fail = (message) => {
	console.error(`✗ ${message}`);
	process.exit(1);
};

if (!KEY || !SECRET) fail("FEDEX_API_KEY and FEDEX_API_PASSWORD must be set");
if (!ACCOUNT) fail("FEDEX_ACCOUNT_NUMBER must be set");
console.log(
	`→ ${BASE}${BASE.includes("sandbox") ? " (sandbox: rate will not be meaningful)" : ""}`,
);

const tokenResponse = await fetch(`${BASE}/oauth/token`, {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		grant_type: "client_credentials",
		client_id: KEY,
		client_secret: SECRET,
	}),
});
const token = await tokenResponse.json();
if (!tokenResponse.ok) fail(`token: ${JSON.stringify(token.errors ?? token)}`);
console.log(`✓ token, expires in ${token.expires_in}s`);

const call = async (path, body) => {
	const response = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token.access_token}`,
			"content-type": "application/json",
			"x-locale": "en_US",
		},
		body: JSON.stringify(body),
	});
	return {
		ok: response.ok,
		status: response.status,
		body: await response.json(),
	};
};

const rate = await call("/rate/v1/rates/quotes", {
	accountNumber: { value: ACCOUNT },
	requestedShipment: {
		shipper: {
			address: { postalCode: "43800", city: "Dengkil", countryCode: "MY" },
		},
		recipient: {
			address: { postalCode: "50450", city: "Kuala Lumpur", countryCode: "MY" },
		},
		pickupType: "CONTACT_FEDEX_TO_SCHEDULE",
		packagingType: "YOUR_PACKAGING",
		rateRequestType: ["ACCOUNT"],
		preferredCurrency: "MYR",
		requestedPackageLineItems: [
			{
				groupPackageCount: 2,
				weight: { units: "KG", value: 1.5 },
				dimensions: { length: 30, width: 10, height: 8, units: "CM" },
			},
		],
	},
});
if (!rate.ok || rate.body.errors) {
	console.log(
		`✗ rate ${rate.status}: ${JSON.stringify(rate.body.errors ?? rate.body)}`,
	);
} else {
	for (const row of rate.body.output.rateReplyDetails) {
		const detail = row.ratedShipmentDetails[0];
		console.log(
			`✓ rate ${row.serviceType}: ${detail.totalNetCharge} ${detail.currency}${row.serviceType === "FEDEX_PRIORITY" ? "  ← the one we book" : ""}`,
		);
	}
}

const track = await call("/track/v1/trackingnumbers", {
	includeDetailedScans: false,
	trackingInfo: [{ trackingNumberInfo: { trackingNumber: TRACKING } }],
});
const result = track.body.output?.completeTrackResults?.[0]?.trackResults?.[0];
if (!track.ok || !result) {
	console.log(
		`✗ track ${track.status}: ${JSON.stringify(track.body.errors ?? track.body)}`,
	);
} else if (result.error) {
	console.log(
		`✓ track ${TRACKING}: FedEx does not know it (${result.error.code})`,
	);
} else {
	console.log(
		`✓ track ${TRACKING}: ${result.latestStatusDetail?.derivedCode} — ${result.latestStatusDetail?.description}`,
	);
}
