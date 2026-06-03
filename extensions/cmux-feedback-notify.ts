import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const DEFAULT_BLOCKING_TOOLS = ["ask_user_question"];
const NOTIFY_TIMEOUT_MS = 3000;
const BODY_MAX_LENGTH = 700;
const SUBAGENT_SESSION_DIR = join(getAgentDir(), "subagents", "sessions");

// 判断当前扩展是否启用，便于临时通过环境变量关闭补丁通知。
function isEnabled(): boolean {
	const value = process.env.PI_CMUX_FEEDBACK_NOTIFY?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "off" && value !== "disabled";
}

// 读取需要触发反馈通知的工具名列表，默认只监听 ask_user_question。
function readBlockingTools(): ReadonlySet<string> {
	const configured = process.env.PI_CMUX_FEEDBACK_TOOLS;
	const tools = configured ? configured.split(",") : DEFAULT_BLOCKING_TOOLS;
	return new Set(tools.map((tool) => tool.trim()).filter((tool) => tool.length > 0));
}

// 判断当前进程是否运行在 cmux workspace/surface 中。
function isCmuxEnvironment(): boolean {
	return Boolean(process.env.CMUX_WORKSPACE_ID && process.env.CMUX_SURFACE_ID);
}

// 默认抑制 subagent 的反馈通知，避免后台子代理打扰主工作流。
function shouldSuppressSubagent(ctx: ExtensionContext): boolean {
	const suppress = process.env.CMUX_SUPPRESS_SUBAGENT_NOTIFICATIONS !== "0";
	if (!suppress) return false;
	const sessionFile = ctx.sessionManager.getSessionFile();
	return Boolean(sessionFile && sessionFile.startsWith(SUBAGENT_SESSION_DIR));
}

// 将未知值安全收窄成普通对象，方便提取问题文本。
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

// 从对象字段中读取字符串，避免把复杂结构直接塞进通知。
function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// 截断通知正文，避免 cmux 通知里出现过长内容。
function truncateText(text: string, maxLength = BODY_MAX_LENGTH): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

// 从 ask_user_question 的结构化入参中提取问题摘要。
function summarizeQuestions(input: unknown): string | undefined {
	const record = asRecord(input);
	const questions = Array.isArray(record?.questions) ? record.questions : undefined;
	if (!questions) return readString(record, "question");

	const summaries = questions
		.map((question, index) => {
			const item = asRecord(question);
			const header = readString(item, "header");
			const text = readString(item, "question");
			if (!header && !text) return undefined;
			const prefix = header ? `[${header}]` : `Question ${index + 1}`;
			return text ? `${prefix} ${text}` : prefix;
		})
		.filter((summary): summary is string => Boolean(summary));

	return summaries.length > 0 ? summaries.join("\n") : undefined;
}

// 构造反馈通知正文，让用户知道 Pi 正在等答案。
function buildNotificationBody(toolName: string, input: unknown): string {
	const summary = summarizeQuestions(input);
	if (summary) return truncateText(summary);
	return `Pi is waiting for your answer via ${toolName}.`;
}

// 调用 cmux notify；失败时静默忽略，避免影响原本的提问工具。
function notifyCmux(pi: ExtensionAPI, body: string, signal?: AbortSignal): void {
	const title = process.env.PI_CMUX_FEEDBACK_TITLE || "Pi needs feedback";
	const subtitle = process.env.PI_CMUX_FEEDBACK_SUBTITLE || "Action required";
	void pi.exec("cmux", ["notify", "--title", title, "--subtitle", subtitle, "--body", body], {
		timeout: NOTIFY_TIMEOUT_MS,
		signal,
	}).catch(() => undefined);
}

// 注册反馈通知扩展，在阻塞式提问出现前主动提醒用户。
export default function cmuxFeedbackNotify(pi: ExtensionAPI): void {
	const blockingTools = readBlockingTools();
	const seenToolCalls = new Set<string>();

	// 每次 agent 开始时清空去重状态，避免历史 toolCallId 干扰当前轮次。
	pi.on("agent_start", async () => {
		seenToolCalls.clear();
	});

	// 在阻塞式提问工具真正弹出前通知 cmux，补齐 pi-cmux 没有覆盖的反馈提醒。
	pi.on("tool_call", async (event, ctx) => {
		if (!isEnabled() || !isCmuxEnvironment() || shouldSuppressSubagent(ctx)) return;
		if (!blockingTools.has(event.toolName)) return;
		if (seenToolCalls.has(event.toolCallId)) return;
		seenToolCalls.add(event.toolCallId);
		notifyCmux(pi, buildNotificationBody(event.toolName, event.input), ctx.signal);
	});

	// 会话结束时清理内存状态，避免 reload/new session 后残留。
	pi.on("session_shutdown", async () => {
		seenToolCalls.clear();
	});
}
