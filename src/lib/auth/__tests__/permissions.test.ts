import { describe, expect, it } from "vitest";
import {
	can,
	type Permission,
	ROLE_PERMISSIONS,
	ROLES,
	STAFF_ROLES,
} from "@/lib/auth/permissions";

describe("can", () => {
	it("gives SUPERADMIN every permission", () => {
		const all = new Set<Permission>();
		for (const role of ROLES) {
			for (const permission of ROLE_PERMISSIONS[role]) all.add(permission);
		}
		for (const permission of all) {
			expect(can("SUPERADMIN", permission)).toBe(true);
		}
	});

	it("is the only role that manages users", () => {
		for (const role of ROLES) {
			expect(can(role, "users:manage")).toBe(role === "SUPERADMIN");
		}
	});

	it("gives ADMIN everything except users:manage", () => {
		expect(can("ADMIN", "users:manage")).toBe(false);
		for (const permission of ROLE_PERMISSIONS.SUPERADMIN) {
			if (permission === "users:manage") continue;
			expect(can("ADMIN", permission)).toBe(true);
		}
	});

	it("lets SALES move orders and deliveries but not the catalogue", () => {
		expect(can("SALES", "orders:markPaid")).toBe(true);
		expect(can("SALES", "logistics:book")).toBe(true);
		expect(can("SALES", "catalogue:read")).toBe(true);
		expect(can("SALES", "catalogue:write")).toBe(false);
		expect(can("SALES", "catalogue:publish")).toBe(false);
	});

	it("lets CATALOGUE maintain designs but never touch money", () => {
		expect(can("CATALOGUE", "catalogue:write")).toBe(true);
		expect(can("CATALOGUE", "catalogue:publish")).toBe(true);
		expect(can("CATALOGUE", "content:write")).toBe(true);
		expect(can("CATALOGUE", "orders:read")).toBe(false);
		expect(can("CATALOGUE", "orders:markPaid")).toBe(false);
		expect(can("CATALOGUE", "logistics:book")).toBe(false);
	});

	it("gives CUSTOMER no admin permission at all", () => {
		expect(ROLE_PERMISSIONS.CUSTOMER).toHaveLength(0);
	});

	it("counts every role but CUSTOMER as staff", () => {
		expect([...STAFF_ROLES].sort()).toEqual(
			["ADMIN", "CATALOGUE", "SALES", "SUPERADMIN"].sort(),
		);
	});
});
