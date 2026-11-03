/** EvaTeam status order: workflow stage first, project-specific state second.
 * OPEN -> IN_PROGRESS -> CLOSED, with a stable fallback for custom statuses.
 * Do not alphabetize groups before determining their workflow stage.
 */
export type EvaRow = Record<string, unknown>;
export type EvaStatusGroup = { key: string; label: string; rank: number; rows: EvaRow[] };

const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const normalized = (value: string) => value.toLocaleLowerCase("ru-RU").replace(/[_-]+/g, " ").trim();

function statusDetail(row: EvaRow): { label: string; code: string } {
  const raw = row.status;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      label: string(obj.name) || string(obj.code) || string(row.status_id) || "Без статуса",
      code: string(obj.code),
    };
  }
  return { label: string(raw) || string(row.status_id) || "Без статуса", code: string(raw) };
}

function stageRank(row: EvaRow): number | null {
  const stage = string(row.cache_status_type).toUpperCase();
  if (stage === "OPEN") return 0;
  if (stage === "IN_PROGRESS") return 1;
  if (stage === "CLOSED") return 2;
  return null;
}

// Substatus order is intentionally heuristic: projects can have custom workflows
// without exposing a numeric sort/order field. Keep unknown custom names visible.
function subRank(label: string, code: string): number {
  const value = normalized(label + " " + code);
  if (/(бэклог|backlog|очеред|заплан|planned|новая|новые|новый|new|создан|to do|todo)/i.test(value)) return 0;
  if (/(открыт|open|ожидани|waiting|pending|принят|accepted)/i.test(value)) return 1;
  if (/(в работ|in progress|progress|doing|разработ|исполнен|working)/i.test(value)) return 2;
  if (/(блок|blocked|block|приостанов|hold|завис)/i.test(value)) return 3;
  if (/(ревью|review|провер|testing|тестир|тестов|согласован|approval|qa)/i.test(value)) return 4;
  if (/(готов|готово|done|заверш|закрыт|closed|resolved|выполнен)/i.test(value)) return 5;
  if (/(отмен|cancel|reject|отклон|архив|archive)/i.test(value)) return 6;
  return 7;
}

export function groupEvaTasks(items: EvaRow[]): EvaStatusGroup[] {
  const groups = new Map<string, EvaStatusGroup & { subtype: number; stage: number }>();
  for (const row of items) {
    const status = statusDetail(row);
    const subtype = subRank(status.label, status.code);
    const stage = stageRank(row);
    // Without stage metadata, infer a broad workflow stage from substatus.
    const effectiveStage = stage ?? (subtype <= 1 ? 0 : subtype <= 4 ? 1 : subtype <= 6 ? 2 : 3);
    const key = effectiveStage + ":" + (string(row.status_id) || status.code || status.label);
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(key, { key, label: status.label, rank: effectiveStage * 10 + subtype,
        stage: effectiveStage, subtype, rows: [row] });
    }
  }
  return [...groups.values()].sort((a, b) =>
    a.rank - b.rank || a.label.localeCompare(b.label, "ru-RU", { sensitivity: "base" })
  );
}
