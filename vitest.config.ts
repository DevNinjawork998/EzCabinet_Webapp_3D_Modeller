import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// A git worktree under .claude/worktrees is a second checkout of this
		// same repo, so its src/ looks exactly like a test directory and vitest
		// runs it. That means another branch's tests — and another branch's
		// date-sensitive fixtures — decide whether this branch is green.
		// Two stale worktrees were contributing 25 failures and 71 files here.
		exclude: [...defaultExclude, "**/.claude/worktrees/**"],
	},
	resolve: {
		alias: {
			"@": new URL("./src", import.meta.url).pathname,
			// `server-only` throws unless the bundler picks its "react-server"
			// condition, which vitest does not. Point it at the no-op that
			// condition would have resolved to, so a server module is testable.
			"server-only": new URL(
				"./node_modules/server-only/empty.js",
				import.meta.url,
			).pathname,
		},
	},
});
