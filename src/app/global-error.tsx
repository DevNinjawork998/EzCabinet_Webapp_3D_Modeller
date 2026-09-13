"use client";

import { useEffect } from "react";
import { captureError } from "@/lib/analytics";

/**
 * The root layout itself failed, so no dictionary, fonts or styles are
 * available — plain English and inline styles are all there is to render with.
 */
export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		captureError(error, { boundary: "global", digest: error.digest ?? null });
	}, [error]);

	return (
		<html lang="en">
			<body style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
				<h1 style={{ fontSize: 20 }}>Something went wrong</h1>
				<p>Please try again, or reload the page.</p>
				<button type="button" onClick={reset}>
					Try again
				</button>
			</body>
		</html>
	);
}
