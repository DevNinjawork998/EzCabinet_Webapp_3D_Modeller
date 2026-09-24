import "server-only";
import { citylinkAdapter } from "./adapters/citylink";
import { easyparcelAdapter } from "./adapters/easyparcel";
import { fedexAdapter } from "./adapters/fedex";
import { gdexAdapter } from "./adapters/gdex";
import { lalamoveAdapter } from "./adapters/lalamove";
import { manualAdapter } from "./adapters/manual";
import { CARRIERS } from "./carriers";
import { type CarrierAdapter, CarrierNotConfigured } from "./types";

/**
 * Which partner does what, and which of them we can actually reach right now.
 *
 * `server-only`: these modules hold booking credentials. The list of carrier
 * *names* is in `carriers.ts`, which the client may import; this file must
 * never be reachable from a bundle a customer downloads.
 */
const ADAPTERS: Record<string, CarrierAdapter> = {
	manual: manualAdapter,
	lalamove: lalamoveAdapter,
	gdex: gdexAdapter,
	citylink: citylinkAdapter,
	easyparcel: easyparcelAdapter,
	fedex: fedexAdapter,
};

/**
 * The adapter for an id, configured or not — null when the id is not one of
 * ours. The comparison screen needs this: a partner with no credentials has to
 * appear as a row saying so, and `getAdapter` throwing is the wrong shape for
 * a list it is building.
 */
export function findAdapter(carrierId: string): CarrierAdapter | null {
	return ADAPTERS[carrierId] ?? null;
}

/** Throws rather than returning null: every caller would only rethrow. */
export function getAdapter(carrierId: string): CarrierAdapter {
	const adapter = ADAPTERS[carrierId];
	if (!adapter) throw new CarrierNotConfigured(carrierId);
	return adapter;
}

/**
 * The partners with credentials present, in the order `carriers.ts` lists them.
 *
 * A carrier disappears from the comparison rather than appearing broken — an
 * admin cannot fix a missing environment variable from this page, so offering
 * the button would only produce a 502 they can do nothing about.
 */
export function enabledCarriers(): CarrierAdapter[] {
	return CARRIERS.map((c) => ADAPTERS[c.id]).filter(
		(a): a is CarrierAdapter => a?.isConfigured() === true,
	);
}
