export type Status = "new" | "in_progress" | "review" | "done";
export type User = { id: string; name: string; is_admin: boolean };
export type Project = { id: string; name: string };
export type Task = {
  id: string; title: string; description: string; status: Status;
  project_id: string | null; parent_id: string | null;
  priority: number; assignee_id: string | null; created_by: string | null;
  created_at: string; updated_at: string;
};
export type Comment = { id: string; task_id: string; author_id: string; body: string; created_at: string };
export type Activity = { id: string; actor_id: string | null; kind: string; detail: Record<string, unknown>; created_at: string };

export class Api {
  constructor(public baseUrl: string, private token = "") {}
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
      method,
      headers: { ...(this.token ? { Authorization: "Bearer " + this.token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let detail = response.statusText;
      try { const data = await response.json(); detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail); } catch { /* no json */ }
      throw new Error(response.status + ": " + detail);
    }
    if (response.status === 204) return undefined as T;
    return response.json();
  }
  openSession() { return this.request<{user: User; expires_in: number}>("/auth/session", "POST"); }
  closeSession() { return this.request<void>("/auth/session", "DELETE"); }
  pinStatus() { return this.request<{installed: boolean; hostname?: string; sha256?: string; expires_at?: string; warning?: string}>("/admin/eva/pin"); }
  inspectPin(pem: string) { return this.request<{hostname: string; sha256: string; expires_at: string}>("/admin/eva/pin/inspect", "POST", {pem}); }
  installPin(pem: string, sha256: string) { return this.request<{installed: boolean; hostname: string; sha256: string}>("/admin/eva/pin", "PUT", {pem, sha256}); }
  removePin() { return this.request<void>("/admin/eva/pin", "DELETE"); }
  caStatus() { return this.request<{installed: boolean; certificates: number | null; warning?: string}>("/admin/eva/ca"); }
  installCa(pem: string) { return this.request<{installed: boolean; certificates: number}>("/admin/eva/ca", "PUT", {pem}); }
  removeCa() { return this.request<void>("/admin/eva/ca", "DELETE"); }
  evaConnection() { return this.request<{connected: boolean; configured: boolean; endpoint_configured: boolean; updated_at: string | null}>("/integrations/eva"); }
  setEvaToken(token: string) { return this.request<{connected: boolean}>("/integrations/eva", "PUT", { token }); }
  testEvaConnection() { return this.request<{ok: boolean; method: string}>("/integrations/eva/test", "POST"); }
  removeEvaToken() { return this.request<void>("/integrations/eva", "DELETE"); }
  serverVersion() { return this.request<{version: string; commit: string}>("/version"); }
  me() { return this.request<User>("/me"); }
  users() { return this.request<User[]>("/users"); }
  projects() { return this.request<Project[]>("/projects"); }
  tasks() { return this.request<Task[]>("/tasks?limit=500"); }
  createTask(task: { title: string; parent_id?: string | null; project_id?: string | null }) { return this.request<Task>("/tasks", "POST", task); }
  updateTask(id: string, patch: Partial<Task>) { return this.request<Task>("/tasks/" + id, "PATCH", patch); }
  comments(id: string) { return this.request<Comment[]>("/tasks/" + id + "/comments"); }
  addComment(id: string, body: string) { return this.request<Comment>("/tasks/" + id + "/comments", "POST", { body }); }
  activity(id: string) { return this.request<Activity[]>("/tasks/" + id + "/activity"); }
}
