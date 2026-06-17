/// <reference path="../../../types/opencode-plugin.d.ts" />

import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const PROTECTED_IDS = new Set([
	"branch-check",
	"ship",
	"pr-review-wait",
	"next",
])

const STATE_FILE = ".opencode/state/protected-todos.json"

type Todo = {
	id: string
	content: string
	status: string
	priority: string
}

type ProtectedTodoState = {
	sessions: Record<string, Todo[]>
}

type CompactingInput = {
	sessionID: string
}

type CompactingOutput = {
	context: string[]
}

async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T
	} catch {
		return null
	}
}

async function writeJson(filePath: string, data: unknown) {
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, JSON.stringify(data, null, 2))
}

function selectProtectedTodos(todos: Todo[]): Todo[] {
	return todos.filter((todo) => PROTECTED_IDS.has(todo.id))
}

function normalizeState(
	input: ProtectedTodoState | { todos?: Todo[] } | null,
): ProtectedTodoState {
	if (input && "sessions" in input && input.sessions) {
		return { sessions: input.sessions }
	}

	return { sessions: {} }
}

export const PreserveShippingTodosPlugin: Plugin = async ({ worktree }) => {
	const statePath = path.join(worktree, STATE_FILE)

	return {
		event: async ({ event }) => {
			if (event.type !== "todo.updated") {
				return
			}

			const todos = selectProtectedTodos(event.properties.todos as Todo[])
			const state = normalizeState(
				await readJson<ProtectedTodoState | { todos?: Todo[] }>(statePath),
			)
			if (todos.length === 0) {
				delete state.sessions[event.properties.sessionID]
			} else {
				state.sessions[event.properties.sessionID] = todos
			}
			await writeJson(statePath, state)
		},

		"experimental.session.compacting": async (
			input: CompactingInput,
			output: CompactingOutput,
		) => {
			const protectedState = normalizeState(
				await readJson<ProtectedTodoState | { todos?: Todo[] }>(statePath),
			)
			const todos = selectProtectedTodos(
				protectedState.sessions[input.sessionID] ?? [],
			)
			if (todos.length === 0) {
				return
			}

			output.context.push(`## Protected Workflow Todos
These todos are authoritative workflow state and must survive compaction with exact ids, content, and status unless the underlying action was actually completed.

Protected todos:
${JSON.stringify(todos, null, 2)}

Rules:
- Preserve these todos verbatim across compaction.
- Do not infer replacements for them.
- Do not reuse protected todos from another session or another issue.
- Do not drop shipping or continuation todos because implementation appears complete.
- If any protected todo is still pending or in progress, the session is not complete.
`)
		},
	}
}

export default PreserveShippingTodosPlugin
