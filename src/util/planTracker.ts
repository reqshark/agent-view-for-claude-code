/**
 * An agent's own plan, rebuilt from its transcript one line at a time.
 *
 * Two tool families write plans. TodoWrite sends the whole list on every call.
 * The Task tools — which current models get instead (Claude Code only offers
 * either on newer models with CLAUDE_CODE_ENABLE_TODO_TOOLS=1) — create and
 * update one item per call, and only TaskCreate's *result* carries the new id:
 *   TaskCreate {subject, description, activeForm?} -> toolUseResult {task: {id, subject}}
 *   TaskUpdate {taskId, status?, subject?, activeForm?}   (status "deleted" removes it)
 * Whichever family wrote last is the plan. No `vscode` import.
 */

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  content: string;
  status: PlanItemStatus;
  /** Present-tense label for the in-progress item ("Running tests"). */
  activeForm?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function normStatus(v: unknown): PlanItemStatus {
  return v === "completed" || v === "in_progress" ? v : "pending";
}

export class PlanTracker {
  private todos?: PlanItem[];
  private readonly tasks = new Map<string, PlanItem>();
  /** TaskCreate calls awaiting their result (tool_use id -> item). */
  private readonly creating = new Map<string, PlanItem>();
  private source?: "todo" | "task";

  /** Feed one parsed JSONL line. Returns true when the plan changed. */
  feed(line: any): boolean {
    const content = line?.message?.content;
    if (!Array.isArray(content)) return false;
    let changed = false;
    if (line.type === "assistant") {
      for (const b of content) {
        if (b?.type !== "tool_use") continue;
        const input = b.input || {};
        if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
          this.todos = input.todos
            .filter((t: any) => str(t?.content))
            .map((t: any) => ({ content: t.content, status: normStatus(t.status), activeForm: str(t.activeForm) }));
          this.source = "todo";
          changed = true;
        } else if (b.name === "TaskCreate" && typeof b.id === "string") {
          const subject = str(input.subject) || str(input.description);
          if (subject) this.creating.set(b.id, { content: subject, status: "pending", activeForm: str(input.activeForm) });
        } else if (b.name === "TaskUpdate" && input.taskId !== undefined) {
          const id = String(input.taskId);
          if (input.status === "deleted") {
            changed = this.tasks.delete(id) || changed;
          } else {
            const item = this.tasks.get(id) || { content: str(input.subject) || `Task ${id}`, status: "pending" };
            if (input.status !== undefined) item.status = normStatus(input.status);
            if (str(input.subject)) item.content = input.subject;
            if (str(input.activeForm)) item.activeForm = input.activeForm;
            this.tasks.set(id, item);
            changed = true;
          }
          this.source = "task";
        }
      }
    } else if (line.type === "user" && this.creating.size > 0) {
      for (const b of content) {
        if (b?.type !== "tool_result" || !this.creating.has(b.tool_use_id)) continue;
        const pending = this.creating.get(b.tool_use_id)!;
        this.creating.delete(b.tool_use_id);
        if (b.is_error === true) continue;
        const text = typeof b.content === "string" ? b.content : "";
        const id = line.toolUseResult?.task?.id ?? /Task #(\d+)/.exec(text)?.[1];
        if (id === undefined) continue;
        this.tasks.set(String(id), pending);
        this.source = "task";
        changed = true;
      }
    }
    return changed;
  }

  /** The current plan, oldest item first; undefined when the agent has none. */
  items(): PlanItem[] | undefined {
    if (this.source === "task") {
      if (this.tasks.size === 0) return undefined;
      return [...this.tasks.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
        .map(([, item]) => ({ ...item }));
    }
    return this.todos && this.todos.length > 0 ? this.todos.map((t) => ({ ...t })) : undefined;
  }
}
