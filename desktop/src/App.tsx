import EvaTasks from "./EvaTasks";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Api, User } from "./api";
import { isTauri } from "@tauri-apps/api/core";
import { ArrowRight, ListTodo, LogOut, Settings2, X } from "lucide-react";

const API_URL = import.meta.env.VITE_API_URL ||
  (window.location.protocol.startsWith("http") && window.location.port !== "1420"
    ? window.location.origin : "http://127.0.0.1:8000");

function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
  const [server, setServer] = useState(API_URL);
  const [localLogin, setLocalLogin] = useState(false);
  const [token, setToken] = useState("");
  const [me, setMe] = useState<User | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [evaToken, setEvaToken] = useState("");
  const [caFile, setCaFile] = useState<File | null>(null);
  const [pinFile, setPinFile] = useState<File | null>(null);
  const [pinStatus, setPinStatus] = useState<{installed: boolean; hostname?: string; sha256?: string; expires_at?: string; warning?: string} | null>(null);
  const [caStatus, setCaStatus] = useState<{installed: boolean; certificates: number | null; warning?: string} | null>(null);
  const [caMessage, setCaMessage] = useState("");
  const [evaConnected, setEvaConnected] = useState(false);
  const [evaConfigured, setEvaConfigured] = useState(false);
  const [evaEndpointConfigured, setEvaEndpointConfigured] = useState(false);
  const [evaTestResult, setEvaTestResult] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [serverVersion, setServerVersion] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [desktopUpdate, setDesktopUpdate] = useState<string | null>(null);
  const [updaterBusy, setUpdaterBusy] = useState(false);

  const refreshSettings = useCallback(async (client: Api) => {
    const [connection, version] = await Promise.all([client.evaConnection(), client.serverVersion()]);
    setEvaConnected(connection.connected);
    setEvaConfigured(connection.configured);
    setEvaEndpointConfigured(connection.endpoint_configured);
    setServerVersion(`${version.version} · ${version.commit}`);
    if (me?.is_admin) {
      const [ca, pin] = await Promise.all([client.caStatus(), client.pinStatus()]);
      setCaStatus(ca); setPinStatus(pin);
    }
  }, [me?.is_admin]);
  useEffect(() => {
    if (!api || !showSettings) return;
    void refreshSettings(api).catch(e => setSettingsError(String(e)));
  }, [api, showSettings, refreshSettings]);
  async function savePin(e: FormEvent) {
    e.preventDefault();
    if (!api || !pinFile || !me?.is_admin) return;
    setSettingsBusy(true); setSettingsError(""); setCaMessage("");
    try {
      if (pinFile.size > 16384) throw new Error("Размер сертификата должен быть меньше 16 КиБ");
      const pem = await pinFile.text();
      const info = await api.inspectPin(pem);
      const confirmed = window.confirm(
        "Закрепить сертификат только для " + info.hostname + "?\\n\\n" +
        "SHA-256: " + info.sha256 + "\\n" +
        "Действителен до: " + new Date(info.expires_at).toLocaleString("ru-RU") + "\\n\\n" +
        "Сверь SHA-256 с доверенным источником: загрузка сертификата сама по себе не подтверждает его подлинность."
      );
      if (!confirmed) return;
      const installed = await api.installPin(pem, info.sha256);
      setPinStatus(installed); setPinFile(null);
      setCaMessage("Сертификат сервера закреплён. Новые соединения проверяют отпечаток до отправки API-токена.");
    } catch (err) { setSettingsError(String(err)); }
    finally { setSettingsBusy(false); }
  }
  async function deletePin() {
    if (!api || !me?.is_admin) return;
    if (!window.confirm("Удалить закреплённый сертификат? Подключение вернётся к обычной проверке CA.")) return;
    setSettingsBusy(true); setSettingsError(""); setCaMessage("");
    try {
      await api.removePin();
      setPinStatus({installed: false});
      setCaMessage("Закрепление сертификата удалено.");
    } catch (err) { setSettingsError(String(err)); }
    finally { setSettingsBusy(false); }
  }
  async function saveCa(e: FormEvent) {
    e.preventDefault();
    if (!api || !caFile || !me?.is_admin) return;
    setSettingsBusy(true); setSettingsError(""); setCaMessage("");
    try {
      if (caFile.size > 65536) throw new Error("CA-файл слишком большой (максимум 64 КиБ)");
      const result = await api.installCa(await caFile.text());
      setCaStatus(result); setCaFile(null);
      setCaMessage("CA установлен. Новые подключения к EvaTeam используют его сразу, без перезапуска.");
    } catch (err) { setSettingsError(String(err)); }
    finally { setSettingsBusy(false); }
  }
  async function deleteCa() {
    if (!api || !me?.is_admin) return;
    if (!window.confirm("Удалить установленный корпоративный CA? Связь с EvaTeam может перестать работать.")) return;
    setSettingsBusy(true); setSettingsError(""); setCaMessage("");
    try {
      await api.removeCa();
      setCaStatus({installed: false, certificates: 0});
      setCaMessage("Дополнительный CA удалён.");
    } catch (err) { setSettingsError(String(err)); }
    finally { setSettingsBusy(false); }
  }
  async function saveEvaToken(e: FormEvent) {
    e.preventDefault(); if (!api || !evaToken.trim()) return;
    setSettingsBusy(true); setSettingsError("");
    try { await api.setEvaToken(evaToken.trim()); setEvaToken(""); await refreshSettings(api); }
    catch (e) { setSettingsError(String(e)); }
    finally { setSettingsBusy(false); }
  }
  async function testEva() {
    if (!api) return;
    setSettingsBusy(true); setSettingsError(""); setEvaTestResult("");
    try { await api.testEvaConnection(); setEvaTestResult("EvaTeam ответила на запрос списка задач."); }
    catch (e) { setSettingsError(String(e)); }
    finally { setSettingsBusy(false); }
  }
  async function disconnectEva() {
    if (!api) return;
    setSettingsBusy(true); setSettingsError("");
    try { await api.removeEvaToken(); await refreshSettings(api); }
    catch (e) { setSettingsError(String(e)); }
    finally { setSettingsBusy(false); }
  }
  async function checkDesktopUpdate() {
    setUpdaterBusy(true); setSettingsError(""); setDesktopUpdate(null);
    try {
      const { isTauri } = await import("@tauri-apps/api/core");
      if (!isTauri()) { setSettingsError("Обновление доступно только в собранном десктопном приложении."); return; }
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) { setDesktopUpdate(update.version); await update.close(); }
      else setDesktopUpdate("Нет обновлений");
    } catch (e) { setSettingsError("Updater не настроен: " + String(e)); }
    finally { setUpdaterBusy(false); }
  }



  useEffect(() => {
    if (isTauri() || new URL(API_URL).origin !== window.location.origin) {
      setRestoringSession(false);
      return;
    }
    let cancelled = false;
    const client = new Api(API_URL);
    void client.me().then(user => {
      if (!cancelled) { setMe(user); setApi(client); }
    }).catch(() => { /* No session. */ })
      .finally(() => { if (!cancelled) setRestoringSession(false); });
    return () => { cancelled = true; };
  }, []);

  async function logout() {
    if (api && !isTauri() && new URL(api.baseUrl).origin === window.location.origin) {
      try { await api.closeSession(); } catch { /* Clear local state anyway. */ }
    }
    setApi(null); setMe(null); setShowSettings(false);
  }
  async function login(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const entered = new Api(server, token.trim());
      const result = localLogin ? null : await entered.request<{user: User; session: string}>("/auth/eva-login", "POST");
      const bearer = result ? new Api(server, result.session) : entered;
      const user = result?.user ?? await bearer.me();
      const sameOrigin = !isTauri() && new URL(server).origin === window.location.origin;
      if (sameOrigin) await bearer.openSession();
      setApi(sameOrigin ? new Api(server) : bearer);
      setMe(user); setToken("");
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }

  if (restoringSession) return <div className="login-wrap"><p className="muted">Восстанавливаем вход…</p></div>;
  if (!api) return <div className="login-wrap"><form className="login card" onSubmit={login}>
    <div className="brand brand-large"><span className="brand-icon"><img width="32" height="32" src="/favicon.svg" alt=""/></span><span>Eva<span className="brand-accent">DE</span></span></div>
    <p className="muted">Eva Desktop Edition. Из Рая выгнали. Зато задачи открываются.</p>
    <label>Адрес EvaDE<input type="url" required value={server} onChange={e => setServer(e.target.value)} placeholder="http://localhost:8000"/></label>
    <label>{localLogin ? "Персональный токен EvaDE" : "API-токен EvaTeam"}<input required type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Вставь свой токен"/></label>
    <label><input type="checkbox" checked={localLogin} onChange={e=>{setLocalLogin(e.target.checked);setToken("");}}/> Вход по локальному токену EvaDE</label>
    <button className="primary" disabled={busy}>{busy ? "Подключаемся…" : "Войти"} <ArrowRight size={16}/></button>
    {error && <p className="error">{error}</p>}
    <small className="muted">Веб-версия сохраняет вход на 30 дней. Для доступа по сети используй HTTPS.</small>
  </form></div>;

  return <div className="shell evade-unified">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><img width="32" height="32" src="/favicon.svg" alt=""/></span><span>Eva<span className="brand-accent">DE</span></span></div>
      <nav><div className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <button className="nav-active"><ListTodo size={17}/> Задачи</button>
      </nav>
      <div className="sidebar-bottom">
        <button onClick={() => setShowSettings(true)}><Settings2 size={16}/> Настройки</button>
        <div className="profile"><span className="avatar">{me?.name.slice(0, 1).toUpperCase()}</span><span className="profile-name">{me?.name}</span><button title="Выйти" onClick={() => void logout()}><LogOut size={16}/></button></div>
      </div>
    </aside>
    <main className="workspace"><EvaTasks api={api} userId={me?.id || ""} personId={me?.eva_person_id} personName={me?.name}/></main>
    {showSettings && <div className="settings-backdrop" onClick={() => setShowSettings(false)}><section className="settings-panel card" onClick={e => e.stopPropagation()}>
      <div className="section-title"><h2>Настройки EvaDE</h2><button onClick={() => setShowSettings(false)} aria-label="Закрыть"><X size={18}/></button></div>
      <div className="detail-section"><p className="muted">Учётная запись: {me?.name} · Роль: {me?.is_admin ? "Администратор" : "Пользователь"}</p></div>
      <div className="detail-section"><h3>Персональный доступ к EvaTeam</h3>
        <p className="muted">{evaConnected ? "Ключ привязан к вашей учётке. Сам ключ не показывается." : "Ключ EvaTeam ещё не привязан."}</p>
        <p className="muted">{evaConfigured ? "Хранилище ключей доступно." : "Администратор сервера пока не настроил хранилище ключей."}</p>
        <form className="settings-form" onSubmit={saveEvaToken}>
          <label>API-ключ EvaTeam<input type="password" autoComplete="off" value={evaToken} onChange={e => setEvaToken(e.target.value)} placeholder="Вставьте свой ключ" required minLength={8}/></label>
          <button className="primary" disabled={settingsBusy || !evaConfigured || !evaToken.trim()} type="submit">{evaConnected ? "Заменить ключ" : "Сохранить ключ"}</button>
        </form>
        {evaConnected && <div className="settings-actions"><button className="secondary-action" disabled={settingsBusy || !evaEndpointConfigured} onClick={() => void testEva()}>Проверить подключение</button><button className="secondary-action" disabled={settingsBusy} onClick={() => void disconnectEva()}>Удалить привязку</button></div>}
        {evaTestResult && <p className="muted">{evaTestResult}</p>}
        {!evaEndpointConfigured && <p className="muted">Администратор ещё не указал EVADE_EVA_URL.</p>}
        <p className="muted">Ключ хранится на сервере зашифрованным. Проверка выполняет безопасный запрос CmfTask.list. Это не проверка всех прав пользователя.</p>
      </div>
      {me?.is_admin && <div className="detail-section"><h3>Администратор · CA EvaTeam</h3>
        <p className="muted">Дополнительные доверенные CA применяются только при соединении EvaDE с EvaTeam. Проверка TLS остаётся включённой.</p>
        <p className="muted">{caStatus?.installed ? `Установлен CA (сертификатов: ${caStatus.certificates ?? "неизвестно"}).` : "Дополнительный CA не установлен."} {caStatus?.warning || ""}</p>
        <form className="settings-form" onSubmit={saveCa}>
          <label>Сертификат CA (.crt / .pem, PEM-формат)
            <input type="file" accept=".crt,.pem,application/x-pem-file" onChange={e => setCaFile(e.target.files?.[0] || null)} />
          </label>
          <button className="primary" type="submit" disabled={settingsBusy || !caFile}>{settingsBusy ? "Установка…" : "Установить CA"}</button>
        </form>
        {caStatus?.installed && <button className="secondary-action" disabled={settingsBusy} onClick={() => void deleteCa()}>Удалить CA</button>}
        {caMessage && <p className="muted">{caMessage}</p>}
        <p className="muted">Загружай публичный корневой или промежуточный CA, не серверный сертификат и не приватный ключ. Только администратор может менять доверенные сертификаты.</p>
      </div>}
      {me?.is_admin && <div className="detail-section"><h3>Администратор · Сертификат сервера EvaTeam</h3>
        <p className="muted">Если сертификат EvaTeam экспортирован из браузера, закрепи именно его. Проверяем SHA-256 в ходе TLS-соединения до передачи персонального API-токена.</p>
        <p className="muted">{pinStatus?.installed ? "Закреплён: " + pinStatus.hostname : "Сертификат сервера не закреплён."} {pinStatus?.warning || ""}</p>
        {pinStatus?.sha256 && <p className="muted" style={{overflowWrap:"anywhere"}}>SHA-256: {pinStatus.sha256}</p>}
        {pinStatus?.expires_at && <p className="muted">Действует до: {new Date(pinStatus.expires_at).toLocaleDateString("ru-RU")}</p>}
        <form className="settings-form" onSubmit={savePin}>
          <label>Сертификат сайта (.pem / .crt)
            <input type="file" accept=".pem,.crt" onChange={e => setPinFile(e.target.files?.[0] || null)} />
          </label>
          <button className="primary" disabled={settingsBusy || !pinFile} type="submit">Проверить и закрепить</button>
        </form>
        {pinStatus?.installed && <button className="secondary-action" disabled={settingsBusy} onClick={() => void deletePin()}>Удалить закрепление</button>}
        <p className="muted">Убедись, что отпечаток соответствует сертификату настоящей EvaTeam. При перевыпуске сертификата потребуется повторная установка.</p>
      </div>}
      <div className="detail-section"><h3>Обновления</h3>
        <p className="muted">Task Core: {serverVersion || "неизвестно"} · Desktop: 0.1.0</p>
        <button className="secondary-action" disabled={updaterBusy} onClick={() => void checkDesktopUpdate()}>{updaterBusy ? "Проверяю…" : "Проверить обновления клиента"}</button>
        {desktopUpdate && <p className="muted">Результат: {desktopUpdate}. Установка появится после настройки подписанных релизов.</p>}
        <p className="muted">Обновление сервера выполняет администратор, без перезапуска из пользовательского интерфейса.</p>
      </div>
      {settingsError && <p className="error">{settingsError}</p>}
    </section></div>}

  </div>;
}
export default App;
