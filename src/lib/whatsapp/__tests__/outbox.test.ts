import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	status: string;
	attempts: number;
	lastError: string | null;
	to: string;
	template: string;
	locale: string;
	vars: { body: string[]; button: string };
	queuedAt: Date;
};

// Just enough of the Notification table for `flush`: the claim, the read and
// the write-back, over rows held in memory.
const rows: Row[] = [];
vi.mock("@/lib/catalogue/db", () => ({
	prisma: {
		notification: {
			updateMany: async ({
				where,
			}: {
				where: { id?: string; attempts?: number };
			}) => {
				const row = rows.find(
					(r) =>
						r.id === where.id &&
						r.status === "PENDING" &&
						r.attempts === where.attempts,
				);
				if (!row) return { count: 0 };
				row.attempts++;
				return { count: 1 };
			},
			// Copies, as Prisma returns: the claim must not reach into the snapshot.
			findMany: async () =>
				rows.filter((r) => r.status === "PENDING").map((r) => ({ ...r })),
			update: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Partial<Row>;
			}) => Object.assign(rows.find((r) => r.id === where.id) ?? {}, data),
		},
	},
}));

import { flush } from "../outbox";

const pending = (id: string): Row => ({
	id,
	status: "PENDING",
	attempts: 0,
	lastError: null,
	to: "+60123456789",
	template: "order_placed",
	locale: "en",
	vars: { body: ["Aisyah", "IC-20260926-001", "100.00"], button: "tok" },
	queuedAt: new Date(),
});

function metaAnswers(status: number, code: number) {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ error: { code, message: "no" } }), {
				status,
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const loggedTypes = (spy: ReturnType<typeof vi.spyOn>) =>
	spy.mock.calls.map((call: unknown[]) => {
		try {
			return JSON.parse(String(call[0])).type;
		} catch {
			return null;
		}
	});

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	rows.length = 0;
	process.env.WHATSAPP_TOKEN = "t0ken";
	process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	errorSpy.mockRestore();
	process.env.WHATSAPP_TOKEN = undefined;
	process.env.WHATSAPP_PHONE_NUMBER_ID = undefined;
});

describe("flush with a dead token", () => {
	it("keeps every order's acknowledgement pending and stops sending", async () => {
		rows.push(pending("a"), pending("b"));
		const fetchMock = metaAnswers(401, 190);

		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(rows.map((r) => [r.id, r.status, r.attempts])).toEqual([
			["a", "PENDING", 0],
			["b", "PENDING", 0],
		]);
		expect(loggedTypes(errorSpy)).toContain("WHATSAPP_TOKEN_INVALID");
	});
});

describe("flush with a template Meta rejects", () => {
	it("raises an alert naming the template problem", async () => {
		rows.push(pending("a"));
		metaAnswers(400, 132018);

		await flush();

		expect(rows[0].status).toBe("FAILED");
		expect(loggedTypes(errorSpy)).toContain("WHATSAPP_TEMPLATE_REJECTED");
	});
});
