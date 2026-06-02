import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildContextualTabTitle,
	buildShellCommand,
	openCommandInNewSplit,
	openCommandInNewTab,
	type SplitDirection,
} from "./cmux-core.ts";
import { onI18nLocaleChanged, t, type I18nKey } from "./i18n.ts";

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_SECTION_NAME = "pi-cmux";
const RESERVED_COMMAND_NAMES = new Set([
	"login",
	"logout",
	"model",
	"scoped-models",
	"settings",
	"resume",
	"new",
	"name",
	"session",
	"tree",
	"fork",
	"compact",
	"copy",
	"export",
	"share",
	"reload",
	"hotkeys",
	"changelog",
	"quit",
	"exit",
	"help",
	"cmv",
	"cmux-v",
	"cmh",
	"cmux-h",
	"cmo",
	"cmov",
	"cmoh",
	"cmt",
	"cmz",
	"cmzh",
	"z",
	"zh",
	"cmrv",
	"cmrh",
	"review-v",
	"review-h",
	"cmcv",
	"cmch",
]);

interface ConfiguredSplitCommandInput {
	run?: string;
	acceptArgs?: boolean;
	direction?: string;
	title?: string;
	description?: string;
	disabled?: boolean;
}

interface ConfiguredSplitCommand {
	run: string;
	acceptArgs: boolean;
	direction: SplitDirection;
	title?: string;
	description: string;
}

type TerminalPlacement = SplitDirection | "tab";

type OpenToolContext = Pick<ExtensionContext, "cwd">;

interface CmuxOpenTerminalParams {
	command: string;
	placement?: TerminalPlacement;
	title?: string;
	focus?: boolean;
}

const CMUX_OPEN_TERMINAL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["command"],
	properties: {
		command: {
			type: "string",
			description: "要运行的交互式终端命令，例如 k9s、htop、lazygit 或 npm run dev",
		},
		placement: {
			type: "string",
			enum: ["right", "down", "tab"],
			default: "tab",
			description: "命令打开的位置。使用 tab 表示新的 cmux 标签页/界面。",
		},
		title: {
			type: "string",
			description: "可选的 cmux 标签标题，默认使用命令本身。",
		},
		focus: {
			type: "boolean",
			default: true,
			description: "是否让 cmux 聚焦新终端，默认 true。",
		},
	},
} as const;

async function openToolInSplit(
	pi: ExtensionAPI,
	ctx: OpenToolContext,
	direction: SplitDirection,
	args: string,
	title?: string,
	focus?: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const command = args.trim();
	return openCommandInNewSplit(pi, direction, buildShellCommand(ctx.cwd, command), {
		tabTitle: await buildContextualTabTitle(pi, ctx.cwd, title ?? command, "Tool"),
		focus,
	});
}

async function openToolInTab(
	pi: ExtensionAPI,
	ctx: OpenToolContext,
	args: string,
	title?: string,
	focus?: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const command = args.trim();
	return openCommandInNewTab(pi, buildShellCommand(ctx.cwd, command), {
		tabTitle: await buildContextualTabTitle(pi, ctx.cwd, title ?? command, "Tool"),
		focus,
	});
}

function registerOpenCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	descriptionKey: I18nKey,
	successKey: I18nKey,
): void {
	pi.registerCommand(name, {
		description: t(descriptionKey),
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify(t("open.usage", { name }), "warning");
				return;
			}

			const result = await openToolInSplit(pi, ctx, direction, command);
			if (result.ok) {
				ctx.ui.notify(t(successKey), "info");
			} else {
				ctx.ui.notify(t("open.failed", { error: result.error }), "error");
			}
		},
	});
}

function registerTabOpenCommand(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description: t("open.tab.description"),
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify(t("open.usage", { name }), "warning");
				return;
			}

			const result = await openToolInTab(pi, ctx, command, command, true);
			if (result.ok) {
				ctx.ui.notify(t("open.success.tab"), "info");
			} else {
				ctx.ui.notify(t("open.failed.tab", { error: result.error }), "error");
			}
		},
	});
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			console.warn(`[pi-cmux] 忽略非对象格式的设置文件：${path}`);
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-cmux] 读取设置文件失败：${path}：${message}`);
		return undefined;
	}
}

function readPiCmuxCommands(settingsPath: string): Record<string, unknown> {
	const settings = readJsonFile(settingsPath);
	const section = settings?.[SETTINGS_SECTION_NAME];
	if (!section) {
		return {};
	}
	if (typeof section !== "object" || Array.isArray(section)) {
		console.warn(`[pi-cmux] 忽略 ${settingsPath} 中无效的 \"${SETTINGS_SECTION_NAME}\" 设置`);
		return {};
	}

	const commands = (section as { commands?: unknown }).commands;
	if (commands === undefined) {
		return {};
	}
	if (typeof commands !== "object" || Array.isArray(commands)) {
		console.warn(`[pi-cmux] 忽略 ${settingsPath} 中无效的 \"${SETTINGS_SECTION_NAME}.commands\" 设置`);
		return {};
	}

	return commands as Record<string, unknown>;
}

function isValidCommandName(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

function getDefaultConfiguredCommandDescription(commandName: string, run: string): string {
	return `通过 /${commandName} 在 cmux 分屏中打开 ${run}`;
}

function normalizeSplitDirection(
	value: unknown,
	commandName: string,
	settingsPath: string,
): SplitDirection | undefined {
	if (value === undefined) {
		return "right";
	}
	if (value === "right" || value === "down") {
		return value;
	}

	console.warn(
		`[pi-cmux] 跳过 ${settingsPath} 中 direction 无效的自定义命令 /${commandName}；应为 \"right\" 或 \"down\"`,
	);
	return undefined;
}

function normalizeConfiguredSplitCommand(
	commandName: string,
	value: unknown,
	settingsPath: string,
): ConfiguredSplitCommand | null | undefined {
	if (!isValidCommandName(commandName)) {
		console.warn(`[pi-cmux] 跳过 ${settingsPath} 中名称无效的自定义命令 \"${commandName}\"`);
		return undefined;
	}

	if (typeof value === "string") {
		const run = value.trim();
		if (!run) {
			console.warn(`[pi-cmux] 跳过 ${settingsPath} 中内容为空的自定义命令 /${commandName}`);
			return undefined;
		}
		return {
			run,
			acceptArgs: false,
			direction: "right",
			description: getDefaultConfiguredCommandDescription(commandName, run),
		};
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		console.warn(`[pi-cmux] 跳过 ${settingsPath} 中配置无效的自定义命令 /${commandName}`);
		return undefined;
	}

	const config = value as ConfiguredSplitCommandInput;
	if (config.disabled) {
		return null;
	}

	const run = typeof config.run === "string" ? config.run.trim() : "";
	if (!run) {
		console.warn(`[pi-cmux] 跳过 ${settingsPath} 中缺少有效 \"run\" 值的自定义命令 /${commandName}`);
		return undefined;
	}

	const direction = normalizeSplitDirection(config.direction, commandName, settingsPath);
	if (!direction) {
		return undefined;
	}

	const title = typeof config.title === "string" && config.title.trim().length > 0 ? config.title.trim() : undefined;

	return {
		run,
		acceptArgs: config.acceptArgs === true,
		direction,
		title,
		description:
			typeof config.description === "string" && config.description.trim().length > 0
				? config.description.trim()
				: getDefaultConfiguredCommandDescription(commandName, run),
	};
}

function loadConfiguredSplitCommands(cwd: string): Map<string, ConfiguredSplitCommand> {
	const configuredCommands = new Map<string, ConfiguredSplitCommand>();
	const settingsPaths = [GLOBAL_SETTINGS_PATH, join(cwd, ".pi", "settings.json")];

	for (const settingsPath of settingsPaths) {
		const commands = readPiCmuxCommands(settingsPath);
		for (const [commandName, value] of Object.entries(commands)) {
			const normalized = normalizeConfiguredSplitCommand(commandName, value, settingsPath);
			if (normalized === null) {
				configuredCommands.delete(commandName);
				continue;
			}
			if (!normalized) {
				continue;
			}
			configuredCommands.set(commandName, normalized);
		}
	}

	return configuredCommands;
}

function registerConfiguredSplitCommand(
	pi: ExtensionAPI,
	commandName: string,
	config: ConfiguredSplitCommand,
): void {
	pi.registerCommand(commandName, {
		description: config.description,
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (trimmedArgs.length > 0 && !config.acceptArgs) {
				ctx.ui.notify(`用法：/${commandName}`, "warning");
				return;
			}

			const command = trimmedArgs.length > 0 ? `${config.run} ${trimmedArgs}` : config.run;
			const result = await openToolInSplit(pi, ctx, config.direction, command, config.title ?? config.run);
			if (result.ok) {
				const location = config.direction === "right" ? "右侧" : "下方";
				ctx.ui.notify(`已在${location}打开 /${commandName} 分屏`, "info");
			} else {
				ctx.ui.notify(`自定义命令执行失败：${result.error}`, "error");
			}
		},
	});
}

function normalizeTerminalPlacement(value: unknown): TerminalPlacement {
	return value === "right" || value === "down" || value === "tab" ? value : "tab";
}

function getPlacementLabel(placement: TerminalPlacement): string {
	if (placement === "right") {
		return "右侧分屏";
	}
	if (placement === "down") {
		return "下方分屏";
	}
	return "标签页";
}

async function openTerminalCommand(
	pi: ExtensionAPI,
	ctx: OpenToolContext,
	params: CmuxOpenTerminalParams,
): Promise<{ ok: true; placement: TerminalPlacement; command: string } | { ok: false; error: string }> {
	const command = typeof params.command === "string" ? params.command.trim() : "";
	if (!command) {
		return { ok: false, error: "请指定要打开的命令" };
	}

	const placement = normalizeTerminalPlacement(params.placement);
	const title = params.title?.trim() || command;
	const focus = params.focus ?? true;
	const result = placement === "tab"
		? await openToolInTab(pi, ctx, command, title, focus)
		: await openToolInSplit(pi, ctx, placement, command, title, focus);

	if (!result.ok) {
		return result;
	}

	return { ok: true, placement, command };
}

function registerAgentTerminalTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "cmux_open_terminal",
		label: "打开 cmux 终端",
		description:
			"在 cmux 中以右侧分屏、下方分屏或新标签页/界面打开交互式终端命令。适用于用户要求的 TUI、日志、开发服务器、watch 或长时间运行的终端视图。",
		promptSnippet:
			"当用户要求在其它面板、分屏、标签页或后台终端打开工具/视图时，在 cmux 中打开交互式终端命令。",
		promptGuidelines: [
			"仅当用户明确要求在 cmux、其它面板、分屏、标签页或后台终端打开命令时，才使用 cmux_open_terminal。",
			"用户说 tab/标签页时使用 placement='tab'；侧边面板用 placement='right'；下方/底部面板用 placement='down'。",
			"交互式 TUI（如 k9s、lazygit、htop、hunk）、日志 tail、开发服务器或 watch 应使用 cmux_open_terminal；除非用户想捕获输出，否则不要用 bash 打开这些命令。",
			"不要在用户未要求时主动使用 cmux_open_terminal 打开终端。",
		],
		parameters: CMUX_OPEN_TERMINAL_PARAMETERS as any,
		executionMode: "sequential",
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as CmuxOpenTerminalParams;
			const result = await openTerminalCommand(pi, ctx, params);
			if (!result.ok) {
				throw new Error(result.error);
			}

			const location = getPlacementLabel(result.placement);
			return {
				content: [{ type: "text", text: `已在 cmux ${location}中打开 ${result.command}。` }],
				details: {
					command: result.command,
					placement: result.placement,
					cwd: ctx.cwd,
				},
			};
		},
	});
}

function registerOpenCommands(pi: ExtensionAPI): void {
	registerOpenCommand(
		pi,
		"cmo",
		"right",
		"open.right.description",
		"open.success.right",
	);
	registerOpenCommand(
		pi,
		"cmov",
		"right",
		"open.alias.cmo",
		"open.success.right",
	);

	registerOpenCommand(
		pi,
		"cmoh",
		"down",
		"open.down.description",
		"open.success.down",
	);

	registerTabOpenCommand(pi, "cmt");
}

function registerConfiguredSplitCommands(pi: ExtensionAPI): void {
	const registeredConfiguredNames = new Set<string>();
	for (const [commandName, config] of loadConfiguredSplitCommands(process.cwd())) {
		const normalizedName = commandName.toLowerCase();
		if (RESERVED_COMMAND_NAMES.has(normalizedName) || registeredConfiguredNames.has(normalizedName)) {
			console.warn(`[pi-cmux] 跳过自定义命令 /${commandName}：命令已存在`);
			continue;
		}
		registerConfiguredSplitCommand(pi, commandName, config);
		registeredConfiguredNames.add(normalizedName);
	}
}

export default function cmuxOpenExtension(pi: ExtensionAPI) {
	registerOpenCommands(pi);
	registerConfiguredSplitCommands(pi);
	registerAgentTerminalTool(pi);
	onI18nLocaleChanged(pi, () => {
		registerOpenCommands(pi);
	});
}
