/**
 * Where a captured shipping label lives, and which carriers have one.
 *
 * Isomorphic on purpose: the admin page reads `LABEL_FALLBACK` to word its
 * warning, and the label route reads it to decide what it will serve. Nothing
 * secret belongs here.
 */

/**
 * Carriers whose label we fetch at booking time and serve from
 * `/api/admin/deliveries/[id]/label`, mapped to where an admin prints it when
 * that capture failed. EasyParcel is absent on purpose: it hands back its own
 * AWB link, which goes straight into `labelUrl`.
 */
export const LABEL_FALLBACK: Record<string, string> = {
	gdex: "Print it from the GDEX portal — GDEX only serves the PDF while the shipment is pending.",
	fedex: "Print it from FedEx Ship Manager.",
};

/**
 * The private blob path of a carrier's label.
 *
 * Derived from the tracking number already on the row as `carrierOrderId`, so
 * no column stores it. Private because the label carries the customer's name,
 * phone and home address, and a tracking number is guessable enough that a
 * public object would be a disclosure waiting to happen.
 */
export function labelPathname(
	carrierId: string,
	trackingNumber: string,
): string {
	return `logistics/${carrierId}/${trackingNumber}.pdf`;
}
