import { requirePage } from "@/lib/auth/page";
import { CabinetDesignsClient } from "./CabinetDesignsClient";

/**
 * The whole page is a client component (`useSearchParams`, live editing
 * state), so the permission check happens in this thin server wrapper rather
 * than inside it.
 */
export default async function CabinetDesignsPage() {
	await requirePage("catalogue:read");
	return <CabinetDesignsClient />;
}
