"use client";
import { createAuthClient } from "better-auth/react";

/** Same origin, so no baseURL: the handler is mounted at /api/auth. */
export const authClient = createAuthClient();
