import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildContextualTabTitle, buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

async function openPiInSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	args: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const prompt = args.trim();
	return openCommandInNewSplit(
		pi,
		direction,
		buildPiCommand(ctx.cwd, { prompt: prompt.length > 0 ? prompt : undefined }),
		{ tabTitle: await buildContextualTabTitle(pi, ctx.cwd, prompt, "Pi") },
	);
}

function registerSplitCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			const result = await openPiInSplit(pi, ctx, direction, args);
			if (result.ok) {
				ctx.ui.notify(successMessage, "info");
			} else {
				ctx.ui.notify(`cmux 分屏打开失败：${result.error}`, "error");
			}
		},
	});
}

export default function cmuxSplitExtension(pi: ExtensionAPI) {
	registerSplitCommand(
		pi,
		"cmv",
		"right",
		"在右侧新开 cmux 分屏并启动新的 Pi 会话",
		"已在右侧打开新的 cmux 分屏",
	);
	registerSplitCommand(
		pi,
		"cmux-v",
		"right",
		"/cmv 的别名",
		"已在右侧打开新的 cmux 分屏",
	);

	registerSplitCommand(
		pi,
		"cmh",
		"down",
		"在下方新开 cmux 分屏并启动新的 Pi 会话",
		"已在下方打开新的 cmux 分屏",
	);
	registerSplitCommand(
		pi,
		"cmux-h",
		"down",
		"/cmh 的别名",
		"已在下方打开新的 cmux 分屏",
	);
}
