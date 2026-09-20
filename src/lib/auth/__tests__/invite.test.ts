import { describe, expect, it } from "vitest";
import { inviteSchema, roleChangeAllowed } from "@/lib/auth/invite";

describe("inviteSchema", () => {
	it("accepts a staff role", () => {
		const result = inviteSchema.safeParse({
			email: "a@ezcabinet.com",
			name: "Ali",
			role: "ADMIN",
			password: "a-long-enough-password",
		});
		expect(result.success).toBe(true);
	});

	it("refuses CUSTOMER — an invite creates staff", () => {
		const result = inviteSchema.safeParse({
			email: "a@ezcabinet.com",
			name: "Ali",
			role: "CUSTOMER",
			password: "a-long-enough-password",
		});
		expect(result.success).toBe(false);
	});

	it("refuses a short password", () => {
		const result = inviteSchema.safeParse({
			email: "a@ezcabinet.com",
			name: "Ali",
			role: "ADMIN",
			password: "short",
		});
		expect(result.success).toBe(false);
	});
});

describe("roleChangeAllowed", () => {
	it("refuses to demote the last superadmin", () => {
		expect(
			roleChangeAllowed({
				superadminCount: 1,
				isSelf: false,
				wasSuperadmin: true,
				next: "ADMIN",
			}),
		).toBe(false);
	});

	it("allows demoting a superadmin when another remains", () => {
		expect(
			roleChangeAllowed({
				superadminCount: 2,
				isSelf: false,
				wasSuperadmin: true,
				next: "ADMIN",
			}),
		).toBe(true);
	});

	it("refuses to change your own role at all", () => {
		expect(
			roleChangeAllowed({
				superadminCount: 3,
				isSelf: true,
				wasSuperadmin: true,
				next: "ADMIN",
			}),
		).toBe(false);
	});

	it("allows any change to someone who was not a superadmin", () => {
		expect(
			roleChangeAllowed({
				superadminCount: 1,
				isSelf: false,
				wasSuperadmin: false,
				next: "SUPERADMIN",
			}),
		).toBe(true);
	});
});
