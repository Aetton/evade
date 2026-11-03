/** EvaTeam's six concrete statuses in operational workflow order.
 * The status code wins over cache_status_type: EvaTeam may mark DONE
 * and CANCEL both as CLOSED, or PAUSE as OPEN/IN_PROGRESS.
 */
export type EvaRow = Record<string, unknown>;
export type EvaStatusGroup = { key: string; label: string; rank: number; rows: EvaRow[] };

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const canonical = (value: string) => value.trim().toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

const ORDER = ["TO DO", "IN PROGRESS", "PAUSE", "IN REVIEW", "DONE", "CANCEL"] as const;

function statusDetail(row: EvaRow): { label: string; code: string } {
  const raw = row.status;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      label: text(obj.name) || text(obj.code) || text(row.status_id) || "Без статуса",
      code: text(obj.code) || text(obj.name),
    };
  }
  return { label: text(raw) || text(row.status_id) || "Без статуса", code: text(raw) };
}

function rank(row: EvaRow, label: string, code: string): number {
  for (const candidate of [code, label]) {
    const match = ORDER.indexOf(canonical(candidate) as typeof ORDER[number]);
    if (match >= 0) return match;
  }
  // An unknown/custom workflow state remains visible after known statuses.
  const stage = canonical(text(row.cache_status_type));
  if (stage === "OPEN") return 10;
  if (stage === "IN PROGRESS") return 11;
  if (stage === "CLOSED") return 12;
  return 13;
}

export function groupEvaTasks(items: EvaRow[]): EvaStatusGroup[] {
  const groups = new Map<string, EvaStatusGroup>();
  for (const row of items) {
    const detail = statusDetail(row);
    const order = rank(row, detail.label, detail.code);
    // Status identifiers, when available, distinguish project-specific states.
    const key = text(row.status_id) || canonical(detail.code || detail.label);
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(key, {key, label: detail.label, rank: order, rows: [row]});
    }
  }
  return [...groups.values()].sort((a, b) =>
    a.rank - b.rank || a.label.localeCompare(b.label, "ru-RU", {sensitivity: "base"})
  );
}
