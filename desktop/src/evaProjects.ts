import { groupEvaTasks, EvaRow, EvaStatusGroup } from "./evaStatus";

export type ProjectRow = Record<string, unknown>;
export type SectionGroup = { key: string; label: string; statusGroups: EvaStatusGroup[]; count: number };
export type ProjectTreeNode = {
  id: string; name: string; path: string; sections: SectionGroup[];
  children: ProjectTreeNode[]; ownCount: number; count: number;
};

const txt = (x: unknown): string => typeof x === "string" ? x.trim() : "";
const reference = (x: unknown): string => {
  if (typeof x === "string") return x.trim();
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const obj = x as ProjectRow;
    return txt(obj.id) || txt(obj.code);
  }
  return "";
};
const canonical = (x: string) => x.replace(/^(?:CmfProject|Project):/, "");
const sectionOf = (task: EvaRow): {key: string; label: string} => {
  // EvaTeam tasks can belong to more than one sprint/list. To avoid displaying
  // the same task multiple times, use the first membership as primary section.
  const raw = task.lists;
  if (Array.isArray(raw) && raw.length) {
    const value = raw[0];
    const obj = value && typeof value === "object" ? value as ProjectRow : null;
    const id = obj ? reference(obj) : txt(value);
    const label = obj ? txt(obj.name) || txt(obj.code) || id : id;
    if (id) return {key: "list:" + id, label: label || "Раздел"};
  }
  return {key: "unsectioned", label: "Без раздела"};
};

export function buildProjectTree(tasks: EvaRow[], projects: ProjectRow[]): ProjectTreeNode[] {
  const lookup = new Map<string, string>();
  for (const p of projects) {
    const id = reference(p.id) || reference(p.code);
    if (id) {
      lookup.set(canonical(id), id);
      if (txt(p.code)) lookup.set(canonical(txt(p.code)), id);
    }
  }
  const nodes = new Map<string, ProjectTreeNode>();
  function getNode(id: string, label?: string): ProjectTreeNode {
    let node = nodes.get(id);
    if (!node) {
      node = {id, name: label || id, path: "", children: [], sections: [], ownCount: 0, count: 0};
      nodes.set(id, node);
    } else if (label) node.name = label;
    return node;
  }
  for (const p of projects) {
    const id = reference(p.id) || reference(p.code);
    if (id) getNode(id, txt(p.name) || txt(p.code) || id);
  }
  const bags = new Map<string, Map<string, {label: string; tasks: EvaRow[]}>>();
  for (const task of tasks) {
    const raw = reference(task.project_id) || reference(task.parent?.valueOf ? task.parent : task.parent_id);
    const id = raw ? lookup.get(canonical(raw)) || raw : "__unassigned__";
    getNode(id, id === "__unassigned__" ? "Без проекта" : undefined);
    if (!bags.has(id)) bags.set(id, new Map());
    const section = sectionOf(task);
    const sections = bags.get(id)!;
    if (!sections.has(section.key)) sections.set(section.key, {label:section.label, tasks:[]});
    sections.get(section.key)!.tasks.push(task);
  }
  for (const [id, sections] of bags) {
    const node = getNode(id);
    node.sections = [...sections.entries()].map(([key, entry]) => ({
      key, label: entry.label, count: entry.tasks.length, statusGroups: groupEvaTasks(entry.tasks),
    })).sort((a,b) => a.key === "unsectioned" ? 1 : b.key === "unsectioned" ? -1 :
      a.label.localeCompare(b.label, "ru", {sensitivity:"base"}));
    node.ownCount = [...sections.values()].reduce((sum, group) => sum + group.tasks.length, 0);
  }
  const roots: ProjectTreeNode[] = [];
  const parentIds = new Map<string, string>();
  for (const p of projects) {
    const id = reference(p.id) || reference(p.code);
    const parent = reference(p.parent_id);
    if (id && parent) {
      const parentId = lookup.get(canonical(parent)) || parent;
      if (parentId !== id) parentIds.set(id, parentId);
    }
  }
  // Ancestor cycles or malformed references are handled as roots.
  function isCyclic(id: string, parent: string): boolean {
    const seen = new Set([id]);
    let current = parent;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = parentIds.get(current) || "";
    }
    return false;
  }
  for (const node of nodes.values()) {
    const parent = parentIds.get(node.id);
    if (parent && nodes.has(parent) && !isCyclic(node.id, parent)) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  const sort = (items: ProjectTreeNode[], ancestry: string[] = []) => {
    items.sort((a,b) => a.name.localeCompare(b.name, "ru", {sensitivity:"base"}));
    for (const node of items) {
      node.path = [...ancestry,node.name].join(" / ");
      sort(node.children, [...ancestry,node.name]);
      node.count = node.ownCount + node.children.reduce((sum,ch) => sum + ch.count,0);
    }
  };
  sort(roots);
  // Do not show empty projects: the task view is user-scoped.
  const prune = (items: ProjectTreeNode[]): ProjectTreeNode[] =>
    items.filter(n => { n.children = prune(n.children); return n.count > 0; });
  return prune(roots);
}
