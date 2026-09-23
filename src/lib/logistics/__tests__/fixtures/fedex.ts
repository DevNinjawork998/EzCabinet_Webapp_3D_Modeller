/**
 * FedEx replies, trimmed to the fields the adapter reads.
 *
 * The *structure* is FedEx's own: the rate and track shapes were captured
 * from the sandbox on 2026-09-23, the ship, pickup and cancel shapes come
 * from the OpenAPI files the developer portal serves. The *values* are ours —
 * the sandbox answers only canned inputs, in USD, so its numbers prove
 * nothing about a Malaysian lane.
 */

export const tokenReply = {
	access_token: "tok_test",
	token_type: "bearer",
	expires_in: 3599,
	scope: "CXS-TP",
};

const rated = (serviceType: string, amount: number, currency = "MYR") => ({
	serviceType,
	serviceName: serviceType.replaceAll("_", " "),
	packagingType: "YOUR_PACKAGING",
	ratedShipmentDetails: [
		{
			rateType: "ACCOUNT",
			ratedWeightMethod: "ACTUAL",
			totalBaseCharge: amount,
			totalNetCharge: amount,
			totalNetFedExCharge: amount,
			currency,
		},
	],
});

export const rateReply = {
	transactionId: "5d885ab5-9506-4949-8299-ef5e7e4f9c41",
	output: {
		rateReplyDetails: [
			rated("FEDEX_PRIORITY_EXPRESS_FREIGHT", 410.5),
			rated("FEDEX_PRIORITY", 38.4),
		],
	},
};

export const rateReplyWithoutPriority = {
	output: {
		rateReplyDetails: [
			rated("FEDEX_INTERNATIONAL_PRIORITY", 251.98),
			rated("INTERNATIONAL_ECONOMY", 247.13),
		],
	},
};

export const rateReplyInUsd = {
	output: { rateReplyDetails: [rated("FEDEX_PRIORITY", 9.1, "USD")] },
};

export const rateReplyEmpty = { output: { rateReplyDetails: [] } };

export const shipReply = {
	transactionId: "t-ship",
	output: {
		transactionShipments: [
			{
				serviceType: "FEDEX_PRIORITY",
				masterTrackingNumber: "794953535000",
				shipmentDocuments: [
					{
						contentType: "MERGED_LABELS_ONLY",
						url: "https://wwwtest.fedex.com/document/v1/cache/merged.pdf",
					},
				],
				pieceResponses: [
					{
						trackingNumber: "794953535000",
						packageDocuments: [
							{
								contentType: "LABEL",
								url: "https://wwwtest.fedex.com/document/v1/cache/piece1.pdf",
							},
						],
					},
				],
			},
		],
	},
};

export const pickupReply = {
	transactionId: "t-pickup",
	output: { pickupConfirmationCode: "3001", location: "KULA" },
};

export const cancelShipmentReply = {
	transactionId: "t-cancel",
	output: { cancelledShipment: true, cancelledHistory: true },
};

export const cancelPickupReply = {
	transactionId: "t-cancel-pickup",
	output: {
		pickupConfirmationCode: "3001",
		cancelConfirmationMessage:
			"Requested pickup has been cancelled Successfully.",
	},
};

const tracked = (
	trackingNumber: string,
	latest: { code: string; derivedCode: string; description: string } | null,
	error?: { code: string; message: string },
) => ({
	trackingNumber,
	trackResults: [
		{
			trackingNumberInfo: { trackingNumber },
			latestStatusDetail: latest,
			...(error ? { error } : {}),
		},
	],
});

export const trackReply = (
	trackingNumber: string,
	code: string,
	description = code,
) => ({
	transactionId: "t-track",
	output: {
		completeTrackResults: [
			tracked(trackingNumber, { code, derivedCode: code, description }),
		],
	},
});

export const trackReplyNotFound = (trackingNumber: string) => ({
	transactionId: "t-track",
	output: {
		completeTrackResults: [
			tracked(trackingNumber, null, {
				code: "TRACKING.TRACKINGNUMBER.NOTFOUND",
				message: "Tracking number cannot be found.",
			}),
		],
	},
});

export const unauthorised = {
	transactionId: "t-401",
	errors: [{ code: "NOT.AUTHORIZED.ERROR", message: "Access token expired." }],
};
