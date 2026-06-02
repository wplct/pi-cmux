import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildContextualTabTitle, buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

type ReviewMode = "general" | "bugs" | "refactor" | "tests" | "diff";

interface ReviewRequest {
	mode: ReviewMode;
	targetOrFocus?: string;
}

function getReviewUsage(commandName: string): string {
	return `用法：/${commandName}（默认审查当前 diff） | /${commandName} [--bugs|--refactor|--tests] <目标> | /${commandName} --diff [关注点]`;
}

function parseReviewArgs(args: string): { ok: true; request: ReviewRequest } | { ok: false; error: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		return { ok: true, request: { mode: "diff" } };
	}

	const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
	let mode: ReviewMode = "general";
	let modeWasExplicit = false;
	let index = 0;

	while (index < tokens.length && tokens[index].startsWith("--")) {
		const token = tokens[index];
		let nextMode: ReviewMode | undefined;
		if (token === "--bugs") nextMode = "bugs";
		if (token === "--refactor") nextMode = "refactor";
		if (token === "--tests") nextMode = "tests";
		if (token === "--diff") nextMode = "diff";
		if (!nextMode) {
			return { ok: false, error: `未知 review 参数：${token}` };
		}
		if (modeWasExplicit) {
			return { ok: false, error: "一次只能使用一个 review 模式参数" };
		}
		mode = nextMode;
		modeWasExplicit = true;
		index += 1;
	}

	const targetOrFocus = tokens.slice(index).join(" ").trim() || undefined;
	if (mode !== "diff" && !targetOrFocus) {
		return { ok: false, error: "请指定要审查的文件或目录" };
	}

	return { ok: true, request: { mode, targetOrFocus } };
}

function getGitHubPullRequestUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/.test(trimmed) ? trimmed : undefined;
}

function buildReviewPrompt(request: ReviewRequest): string {
	const commonInstructions = [
		"Use the code-review skill if it is available.",
		"Start with a concise summary ordered by severity.",
		"Then list concrete findings with suggested fixes and any missing tests.",
		"Do not edit files unless asked.",
	].join(" ");
	const pullRequestUrl = getGitHubPullRequestUrl(request.targetOrFocus);
	const modeInstruction =
		request.mode === "bugs"
			? "Focus on correctness issues, runtime failures, bad assumptions, and edge cases."
			: request.mode === "refactor"
				? "Focus on simplifications, structure, naming, duplication, and maintainability while preserving behavior."
				: request.mode === "tests"
					? "Focus on missing coverage, brittle assertions, and untested edge cases."
					: "Focus on correctness, readability, maintainability, and missing tests.";

	if (pullRequestUrl) {
		return `Review GitHub pull request ${pullRequestUrl}. Use the gh CLI to inspect it, including gh pr view ${pullRequestUrl} and gh pr diff ${pullRequestUrl}. ${modeInstruction} Prioritize the changed code, likely regressions, and missing tests before adding lower-priority notes. ${commonInstructions}`;
	}

	if (request.mode === "diff") {
		const focus = request.targetOrFocus ? ` Extra focus: ${request.targetOrFocus}.` : "";
		return `Review the current git diff in this repository.${focus} Prioritize regressions, correctness issues, risky edge cases, and missing tests. ${commonInstructions}`;
	}

	return `Review ${request.targetOrFocus} from the current project. ${modeInstruction} If the target is a directory, review the most relevant files within that scope. ${commonInstructions}`;
}

async function openReviewSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	request: ReviewRequest,
): Promise<{ ok: true } | { ok: false; error: string }> {
	return openCommandInNewSplit(pi, direction, buildPiCommand(ctx.cwd, { prompt: buildReviewPrompt(request) }), {
		tabTitle: await buildContextualTabTitle(pi, ctx.cwd, "Review", "Review"),
	});
}

function registerReviewCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			const parsed = parseReviewArgs(args);
			if (!parsed.ok) {
				ctx.ui.notify(`${parsed.error}. ${getReviewUsage(name)}`, "warning");
				return;
			}

			const result = await openReviewSplit(pi, ctx, direction, parsed.request);
			if (result.ok) {
				ctx.ui.notify(successMessage, "info");
			} else {
				ctx.ui.notify(`review 分屏打开失败：${result.error}`, "error");
			}
		},
	});
}

export default function cmuxReviewExtension(pi: ExtensionAPI) {
	registerReviewCommand(
		pi,
		"cmrv",
		"right",
		"在右侧新开代码审查 Pi 会话",
		"已在右侧打开 review 分屏",
	);
	registerReviewCommand(
		pi,
		"review-v",
		"right",
		"/cmrv 的别名",
		"已在右侧打开 review 分屏",
	);

	registerReviewCommand(
		pi,
		"cmrh",
		"down",
		"在下方新开代码审查 Pi 会话",
		"已在下方打开 review 分屏",
	);
	registerReviewCommand(
		pi,
		"review-h",
		"down",
		"/cmrh 的别名",
		"已在下方打开 review 分屏",
	);
}
