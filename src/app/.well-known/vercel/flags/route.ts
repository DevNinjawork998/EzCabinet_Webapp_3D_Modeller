import { getProviderData } from "@flags-sdk/vercel";
import { createFlagsDiscoveryEndpoint } from "flags/next";
import * as flags from "@/flags";

/** Flags Explorer's discovery endpoint. Answers only requests signed with `FLAGS_SECRET`. */
export const GET = createFlagsDiscoveryEndpoint(async () =>
	getProviderData(flags),
);
