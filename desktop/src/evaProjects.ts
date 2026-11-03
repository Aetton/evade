import { groupEvaTasks, EvaRow } from "./evaStatus";

export type ProjectRow = Record<string, unknown>;
export type TaskTreeNode = { key: string; task: EvaRow; children: TaskTreeNode[]; count: number };
export type SectionGroup = { key: string; label: string; roots: TaskTreeNode[]; count: number };
export type ProjectTreeNode = {
  id: string; name: string; path: string; sections: SectionGroup[];
  children: ProjectTreeNode[]; ownCount: number; count: number;
};

const txt = (x: unknown): string => typeof x === "string" ? x.trim() : "";
const ref = (x: unknown): string => {
  if (typeof x === "string") return x.trim();
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o = x as ProjectRow;
    return txt(o.id) || txt(o.code);
  }
  return "";
};
const canonical = (x: string): string => x.replace(/^(?:CmfProject|Project|CmfTask|Task):/, "");
const taskKey = (t: EvaRow): string => canonical(ref(t.id) || txt(t.code));
const taskParent = (t: EvaRow): string => canonical(ref(t.parent_task_id) || ref(t.parent_task));
// parent_id can be either a project or a task. Resolve task refs only when
// they are known in the current task set; project refs remain project nodes.

function rootsOfTasks(items: EvaRow[]): TaskTreeNode[] {
  const nodes = new Map<string, TaskTreeNode>();
  const aliases = new Map<string, string>();
  for (const task of items) {
    const key = taskKey(task);
    if (!key) continue;
    if (!nodes.has(key)) nodes.set(key, {key, task, children: [], count: 1});
    for (const alias of [ref(task.id), txt(task.code)]) {
      if (alias) aliases.set(canonical(alias), key);
    }
  }
  const parents = new Map<string, string>();
  for (const node of nodes.values()) {
    let candidate = taskParent(node.task);
    if (!candidate) {
      const indirect = canonical(ref(node.task.parent_id));
      if (aliases.has(indirect)) candidate = indirect;
    }
    const parent = aliases.get(candidate);
    if (parent && parent !== node.key) parents.set(node.key, parent);
  }
  const cyclic = (key: string, parent: string): boolean => {
    const seen = new Set([key]);
    let current = parent;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = parents.get(current) || "";
    }
    return false;
  };
  const roots: TaskTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = parents.get(node.key);
    if (parent && !cyclic(node.key, parent)) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  function sortTree(items: TaskTreeNode[]): void {
    // EvaTeam's workflow order also applies to siblings, not descendants.
    const ranked = groupEvaTasks(items.map(item => item.task));
    const order = new Map<string, number>();
    let i = 0;
    for (const group of ranked) for (const row of group.rows) order.set(taskKey(row), i++);
    items.sort((a, b) => (order.get(a.key) ?? 999999) - (order.get(b.key) ?? 999999));
    for (const node of items) {
      sortTree(node.children);
      node.count = 1 + node.children.reduce((acc, child) => acc + child.count, 0);
    }
  }
  sortTree(roots);
  return roots;
}

export function buildProjectTree(tasks: EvaRow[], projects: ProjectRow[]): ProjectTreeNode[] {
  const projectAliases = new Map<string, string>();
  for (const project of projects) {
    const id = ref(project.id) || txt(project.code);
    if (id) {
      projectAliases.set(canonical(id), id);
      if (txt(project.code)) projectAliases.set(canonical(txt(project.code)), id);
    }
  }
  const nodes = new Map<string, ProjectTreeNode>();
  const getNode = (id: string, name?: string): ProjectTreeNode => {
    let node = nodes.get(id);
    if (!node) {
      node = {id, name: name || id, path: "", sections: [], children: [], ownCount: 0, count: 0};
      nodes.set(id, node);
    } else if (name) node.name = name;
    return node;
  };
  for (const project of projects) {
    const id = ref(project.id) || txt(project.code);
    if (id) getNode(id, txt(project.name) || txt(project.code) || id);
  }

  const byTask = new Map<string, EvaRow>();
  for (const task of tasks) for (const alias of [ref(task.id), txt(task.code)]) {
    if (alias) byTask.set(canonical(alias), task);
  }
  const projectForTask = (task: EvaRow, visiting: Set<string>): string => {
    const immediate = [ref(task.parent_id), ref(task.parent)];
    for (const candidate of immediate) {
      const project = projectAliases.get(canonical(candidate));
      if (project) return project;
    }
    // A nested task can have its direct parent in parent_id, instead of
    // parent_task_id. Follow the task parent until we reach its project.
    for (const candidate of [taskParent(task), ...immediate]) {
      const key = canonical(candidate);
      if (!key || visiting.has(key)) continue;
      const ancestor = byTask.get(key);
      if (ancestor) return projectForTask(ancestor, new Set([...visiting, key]));
    }
    const root = ref(task.project_id);
    return projectAliases.get(canonical(root)) || root || "__unassigned__";
  };

  const buckets = new Map<string, EvaRow[]>();
  for (const task of tasks) {
    const id = projectForTask(task, new Set([taskKey(task)]));
    getNode(id, id === "__unassigned__" ? "Без проекта" : undefined);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id)!.push(task);
  }
  for (const [id, items] of buckets) {
    const node = getNode(id);
    const roots = rootsOfTasks(items);
    node.sections = [{key: "tasks", label: "Задачи", roots, count: items.length}];
    node.ownCount = items.length;
  }

  const parentIds = new Map<string, string>();
  for (const project of projects) {
    const id = ref(project.id) || txt(project.code);
    const parent = ref(project.parent_id);
    if (id && parent) {
      const parentId = projectAliases.get(canonical(parent)) || parent;
      if (parentId !== id) parentIds.set(id, parentId);
    }
  }
  const cyclic = (id: string, parent: string): boolean => {
    const seen = new Set([id]);
    let current = parent;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = parentIds.get(current) || "";
    }
    return false;
  };
  const roots: ProjectTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentIds.get(node.id);
    if (parent && nodes.has(parent) && !cyclic(node.id, parent)) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  function sort(items: ProjectTreeNode[], path: string[] = []): void {
    items.sort((a, b) => a.name.localeCompare(b.name, "ru", {sensitivity: "base"}));
    for (const node of items) {
      node.path = [...path, node.name].join(" / ");
      sort(node.children, [...path, node.name]);
      node.count = node.ownCount + node.children.reduce((sum, child) => sum + child.count, 0);
    }
  }
  sort(roots);
  return roots;
}
