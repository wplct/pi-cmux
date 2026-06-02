import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContextualTabTitle, buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

const ZOXIDE_TIMEOUT_MS = 5000;
const MAX_COMPLETIONS = 10;

function expandHome(value: string): string {
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function resolveDirectoryCandidate(value: string, baseDir: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	const expanded = expandHome(trimmed);
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
	if (!existsSync(resolved)) {
		return undefined;
	}
	return statSync(resolved).isDirectory() ? resolved : undefined;
}

function getZoxideMatches(prefix: string): string[] {
	const query = prefix.trim();
	if (!query) {
		return [];
	}
	try {
		const output = execFileSync("zoxide", ["query", "-l", ...query.split(/\s+/)], {
			encoding: "utf8",
			timeout: ZOXIDE_TIMEOUT_MS,
		});
		return output
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.slice(0, MAX_COMPLETIONS);
	} catch {
		return [];
	}
}

async function resolveZoxideTarget(
	pi: ExtensionAPI,
	query: string,
	baseDir: string,
	commandName: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const directDirectory = resolveDirectoryCandidate(query, baseDir);
	if (directDirectory) {
		return { ok: true, path: directDirectory };
	}

	const keywords = query.trim().split(/\s+/).filter((part) => part.length > 0);
	if (keywords.length === 0) {
		return { ok: false, error: `用法：/${commandName} <查询或路径>` };
	}

	const result = await pi.exec("zoxide", ["query", ...keywords], { timeout: ZOXIDE_TIMEOUT_MS });
	if (result.killed) {
		return { ok: false, error: "zoxide 查询超时" };
	}
	if (result.code !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || "没有找到匹配的 zoxide 目录";
		return { ok: false, error: message };
	}

	const targetPath = result.stdout.trim();
	if (!targetPath) {
		return { ok: false, error: "没有找到匹配的 zoxide 目录" };
	}

	return { ok: true, path: targetPath };
}

async function openPiInZoxideSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	query: string,
	direction: SplitDirection,
	commandName: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const targetResult = await resolveZoxideTarget(pi, query, ctx.cwd, commandName);
	if (!targetResult.ok) {
		return targetResult;
	}

	return openCommandInNewSplit(pi, direction, buildPiCommand(targetResult.path), {
		tabTitle: await buildContextualTabTitle(pi, targetResult.path, "Pi", "Pi"),
	});
}

function registerZoxideCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		getArgumentCompletions: (prefix) => {
			const matches = getZoxideMatches(prefix);
			return matches.length > 0 ? matches.map((match) => ({ value: match, label: match })) : null;
		},
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify(`用法：/${name} <查询或路径>`, "warning");
				return;
			}

			const result = await openPiInZoxideSplit(pi, ctx, query, direction, name);
			if (result.ok) {
				ctx.ui.notify(successMessage, "info");
			} else {
				ctx.ui.notify(`zoxide 打开失败：${result.error}`, "error");
			}
		},
	});
}

export default function cmuxZoxideExtension(pi: ExtensionAPI) {
	registerZoxideCommand(
		pi,
		"cmz",
		"right",
		"匹配 zoxide 目录并在右侧新开 Pi",
		"已在右侧打开 zoxide 分屏",
	);
	registerZoxideCommand(
		pi,
		"z",
		"right",
		"/cmz 的别名",
		"已在右侧打开 zoxide 分屏",
	);

	registerZoxideCommand(
		pi,
		"cmzh",
		"down",
		"匹配 zoxide 目录并在下方新开 Pi",
		"已在下方打开 zoxide 分屏",
	);
	registerZoxideCommand(
		pi,
		"zh",
		"down",
		"/cmzh 的别名",
		"已在下方打开 zoxide 分屏",
	);
}
