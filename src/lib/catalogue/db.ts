import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * One Prisma client for the process, reused across hot reloads in dev — a
 * fresh one per module reload would otherwise exhaust the local Postgres
 * connection limit within a few edits.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Vercel's Prisma Postgres marketplace integration injects the connection
// string under its own prefix; DATABASE_URL is what .env and the Prisma CLI use.
const adapter = new PrismaPg({
	connectionString:
		process.env.DATABASE_URL ?? process.env.STORAGE_DATABASE_URL,
});

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
	globalForPrisma.prisma = prisma;
}
