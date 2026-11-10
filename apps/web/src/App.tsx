import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { io, type Socket } from "socket.io-client";
import {
  Activity,
  BarChart3,
  Bot,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Code2,
  Coffee,
  Command,
  DoorOpen,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  PauseCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  WandSparkles,
  X,
  ListTodo,
  LoaderCircle,
  Power,
  AlertTriangle,
  CircleCheck,
  ArrowUpRight,
  Play,
  RotateCcw,
  Ban,
  Download,
  ChevronDown as ChevronDownIcon,
} from "lucide-react";
import OfficeScene from "./components/OfficeScene";
import {
  API_URL,
  api,
  clearToken,
  getToken,
  setToken,
  type Agent,
  type CurrentUser,
  type Department,
  type ManagerLaunchResponse,
  type ManagerFinalReviewResponse,
  type ManagerPlanResponse,
  type ManagerPlanTask,
  type QueueStatus,
  type SocketEvent,
  type Task,
  type TaskArtifact,
  type TaskRun,
  type WorkspaceEvent,
} from "./lib/api";

const statusTitles: Record<string, string> = {
  DRAFT: "Draft",
  QUEUED: "Antrian",
  PLANNING: "Merencanakan",
  RUNNING: "Dikerjakan",
  REVIEW_REQUIRED: "Menunggu review",
  COMPLETED: "Selesai",
  PAUSED: "Dijeda",
  FAILED: "Gagal",
  CANCELLED: "Dibatalkan",
  BLOCKED: "Terhambat",
};
const priorityTitles: Record<string, string> = {
  LOW: "Rendah",
  NORMAL: "Normal",
  HIGH: "Tinggi",
  URGENT: "Mendesak",
};
const allowedTransitions: Record<string, string[]> = {
  DRAFT: ["QUEUED", "CANCELLED"],
  QUEUED: ["PLANNING", "RUNNING", "PAUSED", "CANCELLED", "BLOCKED"],
  PLANNING: ["RUNNING", "BLOCKED", "FAILED", "CANCELLED"],
  RUNNING: [
    "REVIEW_REQUIRED",
    "COMPLETED",
    "BLOCKED",
    "FAILED",
    "PAUSED",
    "CANCELLED",
  ],
  REVIEW_REQUIRED: ["COMPLETED", "RUNNING", "CANCELLED"],
  COMPLETED: [],
  PAUSED: ["QUEUED", "RUNNING", "CANCELLED"],
  FAILED: ["QUEUED", "CANCELLED"],
  CANCELLED: [],
  BLOCKED: ["QUEUED", "CANCELLED"],
};
const statusClass = (status: string) =>
  `status-pill status-${status.toLowerCase()}`;

export default function App() {
  const [token, setTokenState] = useState<string | null>(getToken());
  const [user, setUser] = useState<CurrentUser["user"] | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workspaceEvents, setWorkspaceEvents] = useState<WorkspaceEvent[]>([]);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [taskRuns, setTaskRuns] = useState<Record<string, TaskRun[]>>({});
  const [taskRunsLoading, setTaskRunsLoading] = useState<
    Record<string, boolean>
  >({});
  const [expandedRunTask, setExpandedRunTask] = useState<string | null>(null);
  const [view, setView] = useState("office");
  const [loading, setLoading] = useState(false);
  const [apiOnline, setApiOnline] = useState(false);
  const [socketOnline, setSocketOnline] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [providerTestLoading, setProviderTestLoading] = useState(false);
  const [providerTestStatus, setProviderTestStatus] = useState<{
    good: boolean;
    message: string;
  } | null>(null);
  const [managerGoal, setManagerGoal] = useState("");
  const [managerMaxTasks, setManagerMaxTasks] = useState(3);
  const [managerPlan, setManagerPlan] = useState<ManagerPlanResponse | null>(null);
  const [managerPlanLoading, setManagerPlanLoading] = useState(false);
  const [managerLaunchLoading, setManagerLaunchLoading] = useState(false);
  const [managerLaunchKey, setManagerLaunchKey] = useState("");
  const managerLaunchInFlight = useRef(false);
  const [managerLaunchResult, setManagerLaunchResult] = useState<ManagerLaunchResponse | null>(null);
  const [managerFinalReviewLoading, setManagerFinalReviewLoading] = useState<string | null>(null);
  const [managerFinalReviewResult, setManagerFinalReviewResult] = useState<ManagerFinalReviewResponse | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [me, agentData, departmentData, taskData] = await Promise.all([
        api<CurrentUser>("/api/me"),
        api<Agent[]>("/api/agents"),
        api<Department[]>("/api/departments"),
        api<Task[]>("/api/tasks"),
      ]);
      setUser(me.user);
      setWorkspaceId(me.workspaceId);
      setAgents(agentData);
      setDepartments(departmentData);
      setTasks(taskData);
      const [queueResult, eventResult] = await Promise.allSettled([
        api<QueueStatus>("/api/queue/status"),
        api<WorkspaceEvent[]>("/api/events"),
      ]);
      setQueueStatus(
        queueResult.status === "fulfilled" ? queueResult.value : null,
      );
      setWorkspaceEvents(
        eventResult.status === "fulfilled" ? eventResult.value : [],
      );
      setApiOnline(true);
      setError("");
    } catch (err) {
      setApiOnline(false);
      const message =
        err instanceof Error ? err.message : "Tidak dapat terhubung ke API.";
      if (!getToken()) {
        setTokenState(null);
        setUser(null);
      } else setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshOperationalData = useCallback(async () => {
    const [taskResult, queueResult, eventResult] = await Promise.allSettled([
      api<Task[]>("/api/tasks"),
      api<QueueStatus>("/api/queue/status"),
      api<WorkspaceEvent[]>("/api/events"),
    ]);
    if (taskResult.status === "fulfilled") setTasks(taskResult.value);
    if (queueResult.status === "fulfilled") setQueueStatus(queueResult.value);
    if (eventResult.status === "fulfilled")
      setWorkspaceEvents(eventResult.value);
  }, []);

  useEffect(() => {
    if (!token) return;
    void loadData().catch(() => {});
  }, [token, loadData]);

  useEffect(() => {
    if (!token) return;
    const timer = window.setInterval(() => {
      void refreshOperationalData().catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
  }, [token, refreshOperationalData]);

  useEffect(() => {
    if (!token) return;
    let socket: Socket | null = null;
    const connect = () => {
      socket = io(API_URL, {
        auth: { token },
        transports: ["websocket", "polling"],
        reconnectionAttempts: 4,
        timeout: 4500,
      });
      socket.on("connect", () => setSocketOnline(true));
      socket.on("disconnect", () => setSocketOnline(false));
      socket.on("connect_error", () => setSocketOnline(false));
      socket.on("workspace:event", (event: SocketEvent) => {
        if (
          event.type.startsWith("agent.") ||
          event.type.startsWith("task.") ||
          event.type.startsWith("run.")
        ) {
          void Promise.all([
            api<Agent[]>("/api/agents").then(setAgents),
            refreshOperationalData(),
          ]).catch(() => {});
          if (event.type !== "task.run_progress")
            setNotice(event.type.replaceAll(".", " "));
        }
      });
    };
    connect();
    return () => {
      socket?.disconnect();
      setSocketOnline(false);
    };
  }, [token, refreshOperationalData]);

  const activeAgents = agents.filter((agent) => agent.enabled);
  const runningTasks = tasks.filter((task) =>
    ["PLANNING", "RUNNING"].includes(task.status),
  );
  const reviewTasks = tasks.filter((task) => task.status === "REVIEW_REQUIRED");
  const completedTasks = tasks.filter((task) => task.status === "COMPLETED");
  const selectedDepartment = useMemo(
    () =>
      departments.find((dept) => dept.code === selectedAgent?.department?.code),
    [departments, selectedAgent],
  );

  async function handleLogin(email: string, password: string) {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ accessToken: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(result.accessToken);
      setTokenState(result.accessToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login gagal.");
    } finally {
      setLoading(false);
    }
  }
  async function testOpenAIProvider() {
    setProviderTestLoading(true);
    setProviderTestStatus(null);
    setError("");
    try {
      const result = await api<{
        ok: boolean;
        provider: string;
        model: string;
        message: string;
      }>("/api/provider/test", { method: "POST", body: JSON.stringify({}) });
      setProviderTestStatus({
        good: true,
        message: `Koneksi berhasil · ${result.model}. Respons: ${result.message}`,
      });
      await refreshOperationalData();
    } catch (err) {
      setProviderTestStatus({
        good: false,
        message:
          err instanceof Error ? err.message : "Tes koneksi OpenAI gagal.",
      });
    } finally {
      setProviderTestLoading(false);
    }
  }
  async function generateManagerPlan() {
    const goal = managerGoal.trim();
    if (goal.length < 10) {
      setError("Jelaskan tujuan pekerjaan minimal 10 karakter.");
      return;
    }
    setManagerPlanLoading(true);
    setError("");
    setNotice("");
    try {
      const result = await api<ManagerPlanResponse>("/api/manager/plan", {
        method: "POST",
        body: JSON.stringify({ goal, maxTasks: managerMaxTasks }),
      });
      if (!result.tasks?.length) {
        throw new Error("Nara belum menghasilkan subtugas. Silakan buat rencana kembali.");
      }
      setManagerPlan(result);
      setManagerLaunchKey(crypto.randomUUID());
      setManagerLaunchResult(null);
      setManagerFinalReviewResult(null);
      setNotice(`Rencana “${result.planTitle}” siap diperiksa. Belum ada subtugas yang diluncurkan.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nara gagal menyusun rencana.");
    } finally {
      setManagerPlanLoading(false);
    }
  }

  function updateManagerPlanTask(index: number, patch: Partial<ManagerPlanTask>) {
    setManagerLaunchKey(crypto.randomUUID());
    setManagerPlan((current) => current ? {
      ...current,
      tasks: current.tasks.map((task, taskIndex) => taskIndex === index ? { ...task, ...patch } : task),
    } : current);
  }

  async function launchManagerPlan() {
    if (managerLaunchInFlight.current) return;
    if (!managerPlan) {
      setError("Buat dan periksa rencana Nara terlebih dahulu.");
      return;
    }
    if (managerLaunchResult) {
      setError("Rencana ini sudah diluncurkan. Buat rencana baru jika ingin pekerjaan lain.");
      return;
    }
    if (managerPlan.tasks.some((task) => !activeAgents.some((agent) => agent.id === task.assignedAgentId))) {
      setError("Pilih agent aktif untuk setiap subtugas sebelum meluncurkan rencana.");
      return;
    }
    const confirmed = window.confirm(
      `Setujui rencana “${managerPlan.planTitle}” dan buat ${managerPlan.tasks.length} subtugas? Setiap subtugas akan masuk antrean dan dapat menggunakan kredit OpenAI.`,
    );
    if (!confirmed) return;

    managerLaunchInFlight.current = true;
    setManagerLaunchLoading(true);
    setError("");
    setNotice("");
    try {
      const planPayload = {
        planTitle: managerPlan.planTitle,
        summary: managerPlan.summary,
        tasks: managerPlan.tasks.map((task) => ({
          title: task.title,
          instruction: task.instruction,
          assignedAgentId: task.assignedAgentId,
          priority: task.priority,
          rationale: task.rationale,
          acceptanceCriteria: task.acceptanceCriteria,
        })),
      };
      const launchKey = managerLaunchKey || crypto.randomUUID();
      if (!managerLaunchKey) setManagerLaunchKey(launchKey);
      const result = await api<ManagerLaunchResponse>("/api/manager/launch", {
        method: "POST",
        body: JSON.stringify({ goal: managerGoal.trim(), plan: planPayload, launchKey }),
      });
      setManagerLaunchResult(result);
      setManagerPlan(null);
      setManagerLaunchKey("");
      setManagerFinalReviewResult(null);
      setError(result.queueWarning || "");
      setNotice(result.workflowMessage || `Rencana berhasil diluncurkan: ${result.subtasks.length} subtugas dibuat. Lihat ringkasan di bawah atau buka Papan Tugas.`);
      void refreshOperationalData().catch(() => {});
      window.setTimeout(() => {
        document.getElementById("manager-launch-result")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rencana Nara gagal diluncurkan.");
      // Pertahankan launchKey saat permintaan gagal agar retry identik tetap idempoten.
    } finally {
      managerLaunchInFlight.current = false;
      setManagerLaunchLoading(false);
    }
  }

  async function generateManagerFinalReview(parentTaskId: string) {
    if (managerFinalReviewLoading) return;
    const parent = tasks.find((task) => task.id === parentTaskId);
    const childTasks = tasks.filter((task) => task.parentTaskId === parentTaskId);
    if (parent && childTasks.length > 0 && childTasks.some((task) => task.status !== "COMPLETED")) {
      setError("Paket final baru dapat disusun setelah semua subtugas selesai dan disetujui.");
      return;
    }
    setManagerFinalReviewLoading(parentTaskId);
    setError("");
    setNotice("Nara sedang membaca artefak spesialis dan menyusun paket final. Proses ini menggunakan kredit OpenAI jika belum ada paket final tersimpan.");
    try {
      const result = await api<ManagerFinalReviewResponse>(`/api/manager/tasks/${encodeURIComponent(parentTaskId)}/final-review`, { method: "POST" });
      setManagerFinalReviewResult(result);
      setNotice(result.reused
        ? "Paket final yang sudah tersimpan dibuka kembali; tidak ada pemanggilan OpenAI baru."
        : "Nara menyelesaikan final review. Paket final tersimpan dan masih menunggu pemeriksaan manusia.");
      await refreshOperationalData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nara gagal menyusun paket final.");
    } finally {
      setManagerFinalReviewLoading(null);
    }
  }

  function handleLogout() {
    clearToken();
    setTokenState(null);
    setUser(null);
    setAgents([]);
    setTasks([]);
    setDepartments([]);
    setSelectedAgent(null);
    setView("office");
  }
  async function createAgent(values: {
    name: string;
    role: string;
    departmentCode: string;
    description: string;
    systemPrompt: string;
  }) {
    setError("");
    const created = await api<Agent>("/api/agents", {
      method: "POST",
      body: JSON.stringify({ ...values, allowedTools: [] }),
    });
    setAgents((prev) => [...prev, created]);
    setShowAgentForm(false);
    setNotice(`${created.name} ditambahkan ke registry.`);
  }
  async function toggleAgent(agent: Agent) {
    setError("");
    const updated = await api<Agent>(
      `/api/agents/${agent.id}/${agent.enabled ? "disable" : "enable"}`,
      { method: "POST" },
    );
    setAgents((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)),
    );
    if (selectedAgent?.id === updated.id) setSelectedAgent(updated);
    setNotice(
      `${updated.name} ${updated.enabled ? "diaktifkan" : "dinonaktifkan"}.`,
    );
  }
  async function createTask(values: {
    title: string;
    instruction: string;
    priority: string;
    assignedAgentId: string;
    submitNow: boolean;
  }) {
    setError("");
    const task = await api<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        ...values,
        assignedAgentId: values.assignedAgentId || null,
      }),
    });
    setTasks((prev) => [task, ...prev.filter((item) => item.id !== task.id)]);
    setShowTaskForm(false);
    setView("tasks");
    if (task.queueWarning) setError(task.queueWarning);
    setNotice(
      task.status === "QUEUED"
        ? "Tugas masuk antrean BullMQ. Worker M2 akan membuat laporan dry-run tanpa memanggil AI."
        : task.status === "BLOCKED"
          ? "Tugas tersimpan tetapi belum dapat diproses. Periksa status Redis/worker."
          : "Draft tugas tersimpan.",
    );
    void refreshOperationalData();
  }
  async function changeTaskStatus(task: Task, status: string) {
    try {
      const updated = await api<Task>(`/api/tasks/${task.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setTasks((prev) =>
        prev.map((item) => (item.id === task.id ? updated : item)),
      );
      if (updated.managerPlanReleaseWarning) setError(updated.managerPlanReleaseWarning);
      else setError("");
      setNotice(updated.managerPlanReleasedSubtasks && updated.managerPlanReleasedSubtasks > 0
        ? `Hasil prasyarat disetujui. ${updated.managerPlanReleasedSubtasks} subtugas lanjutan menerima konteks dan masuk antrean.`
        : `Status tugas diperbarui: ${statusTitles[status] || status}.`);
      void refreshOperationalData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Tidak dapat mengubah status tugas.",
      );
    }
  }
  async function handleTaskAction(
    task: Task,
    action: "queue" | "pause" | "resume" | "cancel" | "retry" | "complete",
  ) {
    if (
      action === "cancel" &&
      !window.confirm(`Batalkan tugas “${task.title}”?`)
    )
      return;
    if (action === "complete") {
      await changeTaskStatus(task, "COMPLETED");
      return;
    }
    const endpoint =
      action === "queue"
        ? "queue"
        : action === "pause"
          ? "pause"
          : action === "resume"
            ? "resume"
            : action === "cancel"
              ? "cancel"
              : "retry";
    try {
      setError("");
      const updated = await api<Task>(`/api/tasks/${task.id}/${endpoint}`, {
        method: "POST",
      });
      setTasks((prev) =>
        prev.map((item) => (item.id === task.id ? updated : item)),
      );
      if (updated.queueWarning) setError(updated.queueWarning);
      const messages: Record<
        "queue" | "pause" | "resume" | "cancel" | "retry",
        string
      > = {
        queue: "Tugas ditambahkan ke antrean BullMQ.",
        pause: "Permintaan jeda tersimpan.",
        resume: "Tugas dilanjutkan dan dimasukkan kembali ke antrean.",
        cancel: "Tugas dibatalkan.",
        retry: "Tugas dicoba kembali melalui antrean.",
      };
      setNotice(updated.queueWarning || messages[action]);
      await refreshOperationalData();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Aksi task gagal dijalankan.",
      );
    }
  }
  async function toggleTaskRuns(taskId: string) {
    if (expandedRunTask === taskId) {
      setExpandedRunTask(null);
      return;
    }
    setExpandedRunTask(taskId);
    setTaskRunsLoading((prev) => ({ ...prev, [taskId]: true }));
    try {
      const runs = await api<TaskRun[]>(`/api/tasks/${taskId}/runs`);
      setTaskRuns((prev) => ({ ...prev, [taskId]: runs }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Riwayat run tidak dapat dimuat.",
      );
    } finally {
      setTaskRunsLoading((prev) => ({ ...prev, [taskId]: false }));
    }
  }
  async function downloadArtifact(artifact: TaskArtifact) {
    try {
      const response = await fetch(
        `${API_URL}/api/artifacts/${artifact.id}/download`,
        { headers: { Authorization: `Bearer ${getToken() || ""}` } },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message || `Unduhan gagal (${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = artifact.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setNotice(`Artefak ${artifact.name} diunduh.`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Artefak tidak dapat diunduh.",
      );
    }
  }

  if (!token)
    return (
      <LoginScreen
        onLogin={handleLogin}
        loading={loading}
        error={error}
        apiOnline={apiOnline}
      />
    );

  return (
    <div className="app-frame">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Command size={21} />
          </div>
          <div>
            <b>KantorAI</b>
            <span>VIRTUAL WORKSPACE</span>
          </div>
          <button
            className="mobile-close"
            onClick={() => setMobileNav(false)}
            aria-label="Tutup navigasi"
          >
            <X size={17} />
          </button>
        </div>
        <div className="workspace-switch">
          <div className="workspace-logo">KA</div>
          <div className="workspace-meta">
            <b>KantorAI Studio</b>
            <span>Workspace lokal</span>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-group">
          <div className="nav-caption">WORKSPACE</div>
          <NavButton
            active={view === "office"}
            icon={<LayoutDashboard size={18} />}
            label="Kantor Virtual"
            onClick={() => {
              setView("office");
              setMobileNav(false);
            }}
          />
          <NavButton
            active={view === "tasks"}
            icon={<ListTodo size={18} />}
            label="Papan Tugas"
            count={tasks.length}
            onClick={() => {
              setView("tasks");
              setMobileNav(false);
            }}
          />
          <NavButton
            active={view === "manager"}
            icon={<WandSparkles size={18} />}
            label="Manager AI"
            onClick={() => {
              setView("manager");
              setMobileNav(false);
            }}
          />
          <NavButton
            active={view === "team"}
            icon={<Users size={18} />}
            label="Tim AI"
            count={agents.length}
            onClick={() => {
              setView("team");
              setMobileNav(false);
            }}
          />
          <NavButton
            active={view === "activity"}
            icon={<Activity size={18} />}
            label="Riwayat & Event"
            onClick={() => {
              setView("activity");
              setMobileNav(false);
            }}
          />
        </div>
        <div className="nav-group">
          <div className="nav-caption">SISTEM</div>
          <NavButton
            active={view === "settings"}
            icon={<Settings2 size={18} />}
            label="Pengaturan"
            onClick={() => {
              setView("settings");
              setMobileNav(false);
            }}
          />
          <div className="system-health">
            <div className="system-health-top">
              <span className={`health-dot ${apiOnline ? "good" : "bad"}`} />
              <b>API {apiOnline ? "tersambung" : "terputus"}</b>
            </div>
            <span>
              Socket {socketOnline ? "realtime aktif" : "menunggu koneksi"}
            </span>
          </div>
        </div>
        <div className="sidebar-spacer" />
        <div className="security-note">
          <ShieldCheck size={17} />
          <div>
            <b>Local development</b>
            <span>API terikat ke localhost</span>
          </div>
        </div>
        <div className="user-profile">
          <div className="user-avatar">
            {user?.name?.slice(0, 1).toUpperCase() || "K"}
          </div>
          <div className="user-meta">
            <b>{user?.name || "Workspace Owner"}</b>
            <span>{user?.email}</span>
          </div>
          <button className="icon-soft" title="Logout" onClick={handleLogout}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <button
            className="mobile-menu"
            aria-label="Buka navigasi"
            onClick={() => setMobileNav(true)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            KantorAI <span>/</span>{" "}
            <b>
              {
                (
                  {
                    office: "Kantor Virtual",
                    tasks: "Papan Tugas",
                    manager: "Manager AI",
                    team: "Registry AI Employee",
                    activity: "Event Realtime",
                    settings: "Pengaturan",
                  } as Record<string, string>
                )[view]
              }
            </b>
          </div>
          <div className="topbar-right">
            <div className={`live-pill ${apiOnline ? "" : "offline"}`}>
              <i />
              {apiOnline ? "API Terhubung" : "API Offline"}
            </div>
            <button
              className="icon-soft"
              title="Muat ulang data"
              onClick={() => void loadData().catch(() => {})}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        {error && (
          <div className="alert alert-error">
            <AlertTriangle size={17} />
            <span>{error}</span>
            <button onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {notice && (
          <div className="alert alert-note">
            <CircleCheck size={17} />
            <span>{notice}</span>
            <button onClick={() => setNotice("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {loading && (
          <div className="loading-strip">
            <LoaderCircle size={15} className="spin" /> Memuat data workspace…
          </div>
        )}
        {view === "office" && (
          <>
            <div className="page-title-row">
              <div>
                <div className="eyebrow">KANTOR VIRTUAL · MILESTONE M3</div>
                <h1>
                  Selamat datang, {user?.name?.split(" ")[0] || "Owner"}{" "}
                  <Sparkles size={24} />
                </h1>
                <p>
                  Registry persisten dan task worker aktif. Lingkungan kantor 3D
                  akan mengikuti status pekerjaan yang tercatat di backend.
                </p>
              </div>
              <div className="title-actions">
                <button
                  className="button-secondary"
                  onClick={() => setShowAgentForm(true)}
                >
                  <Plus size={16} /> Tambah agent
                </button>
                <button
                  className="button-primary"
                  onClick={() => setShowTaskForm(true)}
                >
                  <Plus size={16} /> Tugas baru
                </button>
              </div>
            </div>
            <div className="stats-grid">
              <StatCard
                icon={<Bot size={17} />}
                label="AI employee"
                value={agents.length}
                hint={`${activeAgents.length} agent aktif`}
                tone="mint"
              />
              <StatCard
                icon={<ListTodo size={17} />}
                label="Semua tugas"
                value={tasks.length}
                hint="Tercatat di PostgreSQL"
                tone="lilac"
              />
              <StatCard
                icon={<Activity size={17} />}
                label="Sedang berjalan"
                value={runningTasks.length}
                hint="Status task dari worker diagnostik M2"
                tone="blue"
              />
              <StatCard
                icon={<ShieldCheck size={17} />}
                label="Perlu review"
                value={reviewTasks.length}
                hint={`${completedTasks.length} tugas selesai tercatat`}
                tone="peach"
              />
            </div>
            <section className="panel scene-panel">
              <div className="panel-heading">
                <div>
                  <h2>Kantor 3D</h2>
                  <p>
                    Dunia 3D awal dengan ruang kerja, furnitur, koridor, dan
                    karakter yang bergerak saat idle.
                  </p>
                </div>
                <div className="scene-badges">
                  <span>
                    <i className="health-dot good" /> {agents.length} agent
                  </span>
                  <span>12 zona</span>
                </div>
              </div>
              <OfficeScene agents={agents} onSelectAgent={setSelectedAgent} />
              <div className="panel-footnote">
                <Sparkles size={14} /> Worker menyinkronkan status kerja. Mode
                aktif: {queueStatus?.executorMode || "dry-run"}. Saat mode
                OpenAI aktif, keluaran teks disimpan sebagai artefak untuk
                review manusia.
              </div>
            </section>
            <div className="lower-grid">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Agent terbaru</h2>
                    <p>Diambil langsung dari database.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setView("team")}
                  >
                    Lihat semua <ArrowUpRight size={14} />
                  </button>
                </div>
                <div className="compact-agent-list">
                  {agents.slice(0, 5).map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      onSelect={setSelectedAgent}
                    />
                  ))}
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Tugas terbaru</h2>
                    <p>Task registry · bukan eksekusi AI.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setView("tasks")}
                  >
                    Lihat semua <ArrowUpRight size={14} />
                  </button>
                </div>
                <div className="recent-tasks">
                  {tasks.slice(0, 5).map((task) => (
                    <div className="recent-task" key={task.id}>
                      <div className="task-file-icon">
                        <FileText size={16} />
                      </div>
                      <div className="recent-task-main">
                        <b>{task.title}</b>
                        <span>
                          {task.assignedAgent?.name || "Belum ditugaskan"} ·{" "}
                          {new Date(task.createdAt).toLocaleDateString("id-ID")}
                        </span>
                      </div>
                      <span className={statusClass(task.status)}>
                        {statusTitles[task.status] || task.status}
                      </span>
                    </div>
                  ))}
                  {tasks.length === 0 && (
                    <EmptyState text="Belum ada tugas. Buat tugas pertama untuk menguji task registry." />
                  )}
                </div>
              </section>
            </div>
          </>
        )}
        {view === "manager" && (
          <>
            <div className="page-title-row">
              <div>
                <div className="eyebrow">M4 · MANAGER AI & DELEGASI</div>
                <h1>Manager AI</h1>
                <p>
                  Berikan satu tujuan kepada Nara. Tinjau rencana dan penugasan agent sebelum subtugas dibuat dan dikirim ke antrean.
                </p>
              </div>
              <div className="title-actions">
                <span className={`connection-chip ${queueStatus?.providerCanExecute ? "connected" : ""}`}>
                  <i /> {queueStatus?.executorMode === "openai" && queueStatus?.aiProviderConfigured ? "OpenAI aktif" : "OpenAI belum siap"}
                </span>
              </div>
            </div>

            {(!queueStatus?.providerCanExecute) && (
              <div className="info-banner">
                <AlertTriangle size={18} />
                <div>
                  <b>Mode OpenAI diperlukan</b>
                  <span>
                    Endpoint Manager AI hanya membuat rencana jika OPENAI_API_KEY valid dan TASK_EXECUTOR_MODE=openai. Periksa Pengaturan sebelum membuat rencana; membuat rencana dan menjalankan subtugas menggunakan kredit API.
                  </span>
                </div>
              </div>
            )}

            <section className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-heading">
                <div>
                  <h2>Brief untuk Nara</h2>
                  <p>Tujuan akan dikirim ke OpenAI untuk dibuat menjadi rencana terstruktur; belum ada tugas yang dibuat pada langkah ini.</p>
                </div>
              </div>
              <form className="form-stack" style={{ padding: "0 20px 20px" }} onSubmit={(event) => { event.preventDefault(); void generateManagerPlan(); }}>
                <label>
                  Tujuan pekerjaan
                  <textarea
                    value={managerGoal}
                    onChange={(event) => {
                      setManagerGoal(event.target.value);
                      setManagerPlan(null);
                      setManagerLaunchKey("");
                      setManagerLaunchResult(null);
                    }}
                    minLength={10}
                    maxLength={5000}
                    rows={5}
                    required
                    placeholder="Contoh: Buat paket konten edukasi perlindungan merek untuk UMKM, terdiri dari analisis audiens, outline carousel, dan naskah video. Jangan melakukan publikasi."
                  />
                </label>
                <div className="form-grid">
                  <label>
                    Maksimum subtugas
                    <select value={managerMaxTasks} onChange={(event) => setManagerMaxTasks(Number(event.target.value))}>
                      {[2, 3, 4, 5, 6].map((count) => <option value={count} key={count}>{count} subtugas</option>)}
                    </select>
                  </label>
                  <div className="form-hint" style={{ alignSelf: "end", paddingBottom: 9 }}>
                    {activeAgents.length} agent aktif tersedia · maksimal 6 subtugas per rencana.
                  </div>
                </div>
                <div className="modal-actions" style={{ padding: 0 }}>
                  <button type="button" className="button-secondary" disabled={managerPlanLoading || managerLaunchLoading} onClick={() => { setManagerPlan(null); setManagerLaunchKey(""); setManagerLaunchResult(null); setManagerFinalReviewResult(null); setNotice(""); }}>
                    Hapus rencana lokal
                  </button>
                  <button className="button-primary" disabled={managerPlanLoading || managerLaunchLoading || managerGoal.trim().length < 10 || !queueStatus?.providerCanExecute}>
                    {managerPlanLoading ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />} Buat rencana Nara
                  </button>
                </div>
              </form>
            </section>

            {managerPlan && (
              <section className="panel" style={{ marginBottom: 16 }}>
                <div className="panel-heading">
                  <div>
                    <h2>Periksa rencana sebelum diluncurkan</h2>
                    <p>{managerPlan.manager?.name || "Nara"} · {managerPlan.model || "OpenAI"}{managerPlan.usage?.totalTokens ? ` · ${managerPlan.usage.totalTokens.toLocaleString("id-ID")} token` : ""}</p>
                  </div>
                  <span className="status-pill status-review_required">Menunggu persetujuan</span>
                </div>
                <div className="form-stack" style={{ padding: "0 20px 20px" }}>
                  <label>
                    Nama rencana
                    <input value={managerPlan.planTitle} maxLength={180} onChange={(event) => { setManagerLaunchKey(crypto.randomUUID()); setManagerPlan((current) => current ? { ...current, planTitle: event.target.value } : current); }} />
                  </label>
                  <label>
                    Ringkasan rencana
                    <textarea value={managerPlan.summary} maxLength={3000} rows={3} onChange={(event) => { setManagerLaunchKey(crypto.randomUUID()); setManagerPlan((current) => current ? { ...current, summary: event.target.value } : current); }} />
                  </label>
                  {managerPlan.tasks.map((task, index) => (
                    <article key={`${index}-${task.title}`} style={{ padding: 15, border: "1px solid var(--line)", borderRadius: 14, background: "var(--surface-2)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
                        <b>Subtugas {index + 1}</b>
                        <span className="pill-small">Perlu ditinjau</span>
                      </div>
                      <div className="form-stack">
                        <label>
                          Judul tugas
                          <input value={task.title} minLength={3} maxLength={160} onChange={(event) => updateManagerPlanTask(index, { title: event.target.value })} />
                        </label>
                        <label>
                          Instruksi agent
                          <textarea value={task.instruction} minLength={10} maxLength={6000} rows={4} onChange={(event) => updateManagerPlanTask(index, { instruction: event.target.value })} />
                        </label>
                        <div className="form-grid">
                          <label>
                            Penanggung jawab
                            <select value={task.assignedAgentId} onChange={(event) => updateManagerPlanTask(index, { assignedAgentId: event.target.value })}>
                              <option value="">Pilih agent aktif</option>
                              {activeAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name} · {agent.role}</option>)}
                            </select>
                          </label>
                          <label>
                            Prioritas
                            <select value={task.priority} onChange={(event) => updateManagerPlanTask(index, { priority: event.target.value as ManagerPlanTask["priority"] })}>
                              <option value="LOW">Rendah</option>
                              <option value="NORMAL">Normal</option>
                              <option value="HIGH">Tinggi</option>
                              <option value="URGENT">Mendesak</option>
                            </select>
                          </label>
                        </div>
                        <label>
                          Alasan penugasan
                          <textarea value={task.rationale} maxLength={1200} rows={2} onChange={(event) => updateManagerPlanTask(index, { rationale: event.target.value })} />
                        </label>
                        <label>
                          Kriteria penerimaan hasil
                          <textarea value={task.acceptanceCriteria} maxLength={1200} rows={2} onChange={(event) => updateManagerPlanTask(index, { acceptanceCriteria: event.target.value })} />
                        </label>
                      </div>
                    </article>
                  ))}
                  <div className="info-banner">
                    <ShieldCheck size={18} />
                    <div>
                      <b>Persetujuan manusia diwajibkan</b>
                      <span>Alur M4.1: subtugas 1 dijalankan lebih dahulu. Susun analisis/riset sebagai subtugas 1. Subtugas berikutnya menunggu subtugas 1 selesai dan disetujui; setelah itu konteks hasilnya dilampirkan dan subtugas lanjutan masuk antrean. Semua hasil tetap membutuhkan review manusia.</span>
                    </div>
                  </div>
                  <div className="modal-actions" style={{ padding: 0 }}>
                    <button type="button" className="button-secondary" disabled={managerPlanLoading || managerLaunchLoading} onClick={() => void generateManagerPlan()}>
                      {managerPlanLoading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={15} />} Buat ulang rencana
                    </button>
                    <button type="button" className="button-primary" disabled={managerLaunchLoading || managerPlanLoading || !managerPlan.planTitle.trim() || managerPlan.tasks.some((task) => task.title.trim().length < 3 || task.instruction.trim().length < 10 || !activeAgents.some((agent) => agent.id === task.assignedAgentId))} onClick={() => void launchManagerPlan()}>
                      {managerLaunchLoading ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Setujui & luncurkan {managerPlan.tasks.length} subtugas
                    </button>
                  </div>
                </div>
              </section>
            )}

            {(tasks.some((task) => !task.parentTaskId && task.metadata?.managerPlan === true) || managerLaunchResult) && (
              <section className="panel" id="manager-launch-result">
                <div className="panel-heading">
                  <div>
                    <h2>Rencana Manager AI tersimpan</h2>
                    <p>Subtugas, konteks kolaborasi, dan artefak final dipantau dari data persisten PostgreSQL.</p>
                  </div>
                  <button type="button" className="button-secondary" onClick={() => { setView("tasks"); void refreshOperationalData(); }}>Buka Papan Tugas <ArrowUpRight size={14} /></button>
                </div>
                <div style={{ padding: "0 20px 20px", display: "grid", gap: 16 }}>
                  {(tasks.filter((task) => !task.parentTaskId && task.metadata?.managerPlan === true).concat(
                    managerLaunchResult && !tasks.some((task) => task.id === managerLaunchResult.parent.id) ? [managerLaunchResult.parent] : [],
                  )).map((parent) => {
                    const persistedChildren = tasks.filter((task) => task.parentTaskId === parent.id).sort((a, b) => {
                      const seqA = Number(a.metadata?.sequence || 999);
                      const seqB = Number(b.metadata?.sequence || 999);
                      return seqA - seqB || a.createdAt.localeCompare(b.createdAt);
                    });
                    const children = persistedChildren.length > 0
                      ? persistedChildren
                      : managerLaunchResult?.parent.id === parent.id ? managerLaunchResult.subtasks : [];
                    const allChildrenCompleted = children.length > 0 && children.length === Number(parent.metadata?.childTaskCount || children.length) && children.every((task) => task.status === "COMPLETED");
                    const finalReview = managerFinalReviewResult?.parentTaskId === parent.id ? managerFinalReviewResult : null;
                    const finalReviewStored = parent.metadata?.managerFinalReviewStatus === "READY_FOR_REVIEW";
                    return (
                      <article key={parent.id} style={{ border: "1px solid var(--line)", borderRadius: 14, padding: 14, background: "var(--surface-2)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                          <div>
                            <b>{parent.title}</b>
                            <div className="form-hint" style={{ marginTop: 5 }}>{children.length} subtugas · Status induk: {statusTitles[parent.status] || parent.status}{finalReviewStored ? " · Paket final tersedia" : ""}</div>
                          </div>
                          <button type="button" className="button-primary" disabled={!allChildrenCompleted || managerFinalReviewLoading !== null} onClick={() => void generateManagerFinalReview(parent.id)}>
                            {managerFinalReviewLoading === parent.id ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />} {finalReviewStored ? "Buka / periksa paket final" : "Susun paket final dengan Nara"}
                          </button>
                        </div>
                        <div className="table-scroll" style={{ marginTop: 12 }}>
                          <table className="data-table">
                            <thead><tr><th>Subtugas</th><th>Agent</th><th>Status</th><th>ID</th></tr></thead>
                            <tbody>
                              {children.map((task) => (
                                <tr key={task.id}>
                                  <td><b>{task.title}</b><small>{task.instruction.slice(0, 150)}{task.instruction.length > 150 ? "…" : ""}</small></td>
                                  <td>{task.assignedAgent?.name || activeAgents.find((agent) => agent.id === task.assignedAgentId)?.name || "Belum ditugaskan"}</td>
                                  <td><span className={statusClass(task.status)}>{statusTitles[task.status] || task.status}</span><small>{task.metadata?.managerPlanStage === "WAITING_FOR_PREREQUISITE_REVIEW" && task.status === "DRAFT" ? "Menunggu konteks subtugas 1" : task.metadata?.managerPlanContextSourceTaskId ? "Konteks sumber dilampirkan" : ""}</small></td>
                                  <td><code>{task.id.slice(0, 10)}</code></td>
                                </tr>
                              ))}
                              {children.length === 0 && <tr><td colSpan={4}>Data subtugas sedang dimuat. Tekan Refresh pada Papan Tugas bila belum muncul.</td></tr>}
                            </tbody>
                          </table>
                        </div>
                        <p className="panel-footnote">{allChildrenCompleted ? "Semua subtugas telah disetujui. Nara dapat menggabungkan artefak aktual dan menandai klaim yang masih perlu diverifikasi." : "Tahap pertama berjalan lebih dahulu. Setelah hasilnya disetujui, sistem meneruskan konteks dan melepas subtugas lanjutan; paket final tersedia setelah seluruh subtugas berstatus Selesai."}</p>
                        {finalReview && (
                          <div style={{ marginTop: 12, padding: 13, border: "1px solid var(--line)", borderRadius: 12, background: "var(--surface)" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                              <div><b>✓ Paket final Nara siap ditinjau</b><div className="form-hint">{finalReview.artifact.name} · {finalReview.reused ? "Artefak tersimpan, tanpa pemanggilan AI baru" : `Model ${finalReview.model || "OpenAI"}`}</div></div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <button type="button" className="button-secondary" onClick={() => void downloadArtifact(finalReview.artifact)}><Download size={14} /> Unduh paket final</button>
                                <button type="button" className="button-primary" disabled={parent.status === "COMPLETED" || parent.metadata?.managerFinalReviewStatus !== "READY_FOR_REVIEW"} onClick={() => { if (window.confirm(`Setujui paket final “${parent.title}” dan tandai workflow Manager AI selesai?`)) void changeTaskStatus(parent, "COMPLETED"); }}><Check size={14} /> {parent.status === "COMPLETED" ? "Paket final disetujui" : "Setujui paket final"}</button>
                              </div>
                            </div>
                            <pre style={{ marginTop: 12, maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 10, lineHeight: 1.6, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 9, padding: 12 }}>{finalReview.outputPreview}</pre>
                            <p className="panel-footnote">Ini draf untuk review manusia, bukan persetujuan publikasi otomatis.</p>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}

        {view === "team" && (
          <>
            <div className="page-title-row">
              <div>
                <div className="eyebrow">AGENT REGISTRY · POSTGRESQL</div>
                <h1>
                  AI employee{" "}
                  <span className="title-count">{agents.length}</span>
                </h1>
                <p>
                  Tambahkan dan kelola spesialis AI. Prompt lengkap tidak pernah
                  dikirim ke UI list.
                </p>
              </div>
              <button
                className="button-primary"
                onClick={() => setShowAgentForm(true)}
              >
                <Plus size={16} /> Tambah agent
              </button>
            </div>
            <div className="info-banner">
              <ShieldCheck size={18} />
              <div>
                <b>Registry persisten aktif</b>
                <span>
                  Konfigurasi agent disimpan di database. Worker M2 tersedia;
                  OpenAI Responses API dapat digunakan pada M3 setelah
                  konfigurasi key dan mode executor.
                </span>
              </div>
            </div>
            <div className="agent-card-grid">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onSelect={setSelectedAgent}
                  onToggle={toggleAgent}
                />
              ))}
            </div>
            {agents.length === 0 && (
              <EmptyState text="Belum ada agent di workspace. Tambahkan agent pertama." />
            )}
          </>
        )}
        {view === "tasks" && (
          <>
            <div className="page-title-row">
              <div>
                <div className="eyebrow">M3 · OPENAI TASK EXECUTION</div>
                <h1>Papan Tugas</h1>
                <p>
                  Task worker memakai Redis/BullMQ, menyimpan run dan artefak ke
                  PostgreSQL. Mode executor mengikuti konfigurasi lokal;
                  keluaran OpenAI tetap memerlukan review manusia.
                </p>
              </div>
              <div className="title-actions">
                <span
                  className={`connection-chip ${queueStatus?.workerOnline ? "connected" : ""}`}
                >
                  <i />{" "}
                  {queueStatus?.workerOnline
                    ? "Worker online"
                    : "Worker offline"}
                </span>
                <button
                  className="button-primary"
                  onClick={() => setShowTaskForm(true)}
                >
                  <Plus size={16} /> Tugas baru
                </button>
              </div>
            </div>
            <div className="queue-summary">
              <div>
                <span>Redis queue</span>
                <b>
                  {queueStatus?.redis === "connected"
                    ? "Terhubung"
                    : "Tidak tersedia"}
                </b>
              </div>
              <div>
                <span>Menunggu</span>
                <b>{queueStatus?.counts?.waiting ?? 0}</b>
              </div>
              <div>
                <span>Aktif</span>
                <b>{queueStatus?.counts?.active ?? 0}</b>
              </div>
              <div>
                <span>Run di review</span>
                <b>{reviewTasks.length}</b>
              </div>
              <div>
                <span>Mode executor</span>
                <b>{queueStatus?.executorMode || "dry-run"}</b>
              </div>
            </div>
            <div
              className={`dry-run-banner ${queueStatus?.executorMode === "openai" && queueStatus?.aiProviderConfigured ? "provider-live-banner" : ""}`}
            >
              <AlertTriangle size={17} />
              <div>
                <b>
                  {queueStatus?.executorMode === "openai" &&
                  queueStatus?.aiProviderConfigured
                    ? "Mode OpenAI aktif — hasil tetap perlu review"
                    : "Mode diagnostik dry-run — bukan hasil AI"}
                </b>
                <span>
                  {queueStatus?.executorMode === "openai" &&
                  queueStatus?.aiProviderConfigured
                    ? `Worker mengirim instruksi ke ${queueStatus.openAiModel || "model OpenAI"} dan menyimpan keluaran teks sebagai artefak. Tidak ada tools eksternal atau eksekusi kode yang diaktifkan pada M3.`
                    : "Worker hanya memverifikasi antrean, progress, run event, dan penyimpanan artefak. Tambahkan OPENAI_API_KEY, uji koneksi, lalu ubah TASK_EXECUTOR_MODE=openai untuk menjalankan instruksi dengan model AI."}
                </span>
              </div>
            </div>
            <div className="task-board-grid">
              {[
                ["DRAFT", "Draft"],
                ["QUEUED", "Antrian"],
                ["RUNNING", "Dikerjakan"],
                ["REVIEW_REQUIRED", "Review / diagnostik"],
                ["BLOCKED", "Terhambat"],
                ["FAILED", "Gagal"],
                ["PAUSED", "Dijeda"],
                ["COMPLETED", "Selesai"],
                ["CANCELLED", "Dibatalkan"],
              ].map(([code, title]) => (
                <section className="task-column" key={code}>
                  <div className="task-column-title">
                    <b>{title}</b>
                    <span>
                      {tasks.filter((task) => task.status === code).length}
                    </span>
                  </div>
                  {tasks
                    .filter((task) => task.status === code)
                    .map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onAction={handleTaskAction}
                        onToggleRuns={toggleTaskRuns}
                        runs={taskRuns[task.id]}
                        runsLoading={Boolean(taskRunsLoading[task.id])}
                        runsExpanded={expandedRunTask === task.id}
                        onDownloadArtifact={downloadArtifact}
                      />
                    ))}
                  {tasks.every((task) => task.status !== code) && (
                    <div className="column-empty">Belum ada tugas</div>
                  )}
                </section>
              ))}
            </div>
            <section className="panel all-task-panel">
              <div className="panel-heading">
                <div>
                  <h2>Semua tugas</h2>
                  <p>
                    Daftar persisten dari PostgreSQL, termasuk status worker dan
                    riwayat run.
                  </p>
                </div>
                <button
                  className="button-secondary"
                  onClick={() => void refreshOperationalData()}
                >
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Nama tugas</th>
                      <th>Agent</th>
                      <th>Prioritas</th>
                      <th>Status</th>
                      <th>Run / artefak</th>
                      <th>Dibuat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <b>{task.title}</b>
                          <small>{task.instruction}</small>
                          {task.metadata?.diagnosticOnly === true && (
                            <small className="diagnostic-label">
                              Run terakhir adalah dry-run diagnostik; bukan
                              hasil AI.
                            </small>
                          )}
                        </td>
                        <td>{task.assignedAgent?.name || "—"}</td>
                        <td>
                          <PriorityBadge priority={task.priority} />
                        </td>
                        <td>
                          <span className={statusClass(task.status)}>
                            {statusTitles[task.status] || task.status}
                          </span>
                        </td>
                        <td>
                          {task._count?.runs ?? 0} run ·{" "}
                          {task._count?.artifacts ?? 0} artefak
                        </td>
                        <td>
                          {new Date(task.createdAt).toLocaleString("id-ID", {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tasks.length === 0 && (
                  <EmptyState text="Belum ada tugas pada workspace ini." />
                )}
              </div>
            </section>
          </>
        )}
        {view === "activity" && (
          <>
            <div className="page-title-row">
              <div>
                <div className="eyebrow">M2 · EXECUTION TRACE</div>
                <h1>Riwayat & event</h1>
                <p>
                  Riwayat run, progress worker, perubahan status, dan artefak
                  yang tercatat di database.
                </p>
              </div>
              <div className="title-actions">
                <span
                  className={`connection-chip ${socketOnline ? "connected" : ""}`}
                >
                  <i />{" "}
                  {socketOnline ? "Realtime tersambung" : "Menunggu realtime"}
                </span>
                <button
                  className="button-secondary"
                  onClick={() => void refreshOperationalData()}
                >
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>
            </div>
            <div className="queue-summary">
              <div>
                <span>Worker</span>
                <b>{queueStatus?.workerOnline ? "Online" : "Offline"}</b>
              </div>
              <div>
                <span>Redis</span>
                <b>
                  {queueStatus?.redis === "connected"
                    ? "Connected"
                    : "Unavailable"}
                </b>
              </div>
              <div>
                <span>Menunggu</span>
                <b>{queueStatus?.counts?.waiting ?? 0}</b>
              </div>
              <div>
                <span>Aktif</span>
                <b>{queueStatus?.counts?.active ?? 0}</b>
              </div>
              <div>
                <span>Executor</span>
                <b>{queueStatus?.executorMode || "dry-run"}</b>
              </div>
            </div>
            <div className="info-banner">
              <Activity size={18} />
              <div>
                <b>Trace persisten dari PostgreSQL</b>
                <span>
                  Worker mengirim event lewat Redis Pub/Sub ke Socket.IO. M2
                  tidak memanggil provider AI; event dan artefak dry-run hanya
                  membuktikan jalur eksekusi.
                </span>
              </div>
            </div>
            <div className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Event terbaru</h2>
                  <p>
                    {workspaceEvents.length} event terbaru · diperbarui otomatis
                    setiap 4 detik.
                  </p>
                </div>
                <button
                  className="button-secondary"
                  onClick={() => void refreshOperationalData()}
                >
                  <RefreshCw size={15} /> Refresh
                </button>
              </div>
              <div className="event-list">
                {workspaceEvents.map((event) => (
                  <div className="event-row" key={event.id}>
                    <div className="event-icon">
                      {event.eventType.includes("run") ||
                      event.eventType.includes("queue") ? (
                        <Activity size={16} />
                      ) : (
                        <ListTodo size={16} />
                      )}
                    </div>
                    <div>
                      <b>
                        {event.eventType} ·{" "}
                        {event.task?.title ||
                          `Task ${event.taskId.slice(0, 8)}`}
                      </b>
                      <span>
                        {event.message || event.task?.status || "Event task"} ·{" "}
                        {event.actorType}
                        {event.run?.status ? ` · Run ${event.run.status}` : ""}
                      </span>
                    </div>
                    <time>
                      {new Date(event.createdAt).toLocaleString("id-ID", {
                        dateStyle: "short",
                        timeStyle: "medium",
                      })}
                    </time>
                  </div>
                ))}
                {workspaceEvents.length === 0 && (
                  <div className="empty-state">
                    <div>
                      <Activity size={20} />
                    </div>
                    <p>
                      Belum ada event. Buat tugas uji lalu masukkan ke antrean
                      agar worker M2 menulis trace.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        {view === "settings" && (
          <>
            <div className="page-title-row">
              <div>
                <div className="eyebrow">KONFIGURASI LOKAL</div>
                <h1>Pengaturan</h1>
                <p>Status komponen dan langkah keamanan pengembangan.</p>
              </div>
            </div>
            <div className="settings-grid">
              <SettingCard
                icon={<DatabaseIcon />}
                title="PostgreSQL"
                value={apiOnline ? "API terkoneksi" : "Tidak tersedia"}
                desc="Sumber data registry agent, task, dan audit log."
                good={apiOnline}
              />
              <SettingCard
                icon={<Activity size={19} />}
                title="Socket.IO"
                value={socketOnline ? "Tersambung" : "Belum tersambung"}
                desc="Kanal event workspace untuk sinkronisasi status."
                good={socketOnline}
              />
              <SettingCard
                icon={<Command size={19} />}
                title="Mesin 3D"
                value="Three.js aktif"
                desc="Scene berbasis procedural geometry. Model GLB dan navmesh masuk M1."
                good
              />
              <SettingCard
                icon={<Activity size={19} />}
                title="Task worker"
                value={
                  queueStatus?.workerOnline ? "BullMQ aktif" : "Worker offline"
                }
                desc={`${queueStatus?.redis === "connected" ? "Redis tersambung" : "Redis belum tersambung"}. Menunggu ${queueStatus?.counts?.waiting ?? 0}, aktif ${queueStatus?.counts?.active ?? 0}.`}
                good={Boolean(queueStatus?.workerOnline)}
              />
              <SettingCard
                icon={<Bot size={19} />}
                title="Provider AI"
                value={
                  queueStatus?.aiProviderConfigured
                    ? `OpenAI · ${queueStatus.openAiModel || "gpt-5.5"}`
                    : "API key belum diatur"
                }
                desc={
                  queueStatus?.aiProviderConfigured
                    ? `API key terdeteksi di backend. Executor: ${queueStatus.executorMode || "dry-run"}. Kunci tidak ditampilkan ke browser.`
                    : "Tambahkan OPENAI_API_KEY ke .env lokal, lalu restart API dan worker."
                }
                good={Boolean(queueStatus?.aiProviderConfigured)}
              />
            </div>
            <section className="panel provider-tools-panel">
              <div className="panel-heading">
                <div>
                  <h2>Integrasi OpenAI</h2>
                  <p>
                    Tes ini mengirim satu permintaan singkat dan dapat
                    menggunakan sedikit kuota API. API key hanya dibaca oleh
                    backend dari .env.
                  </p>
                </div>
                <button
                  className="button-secondary"
                  disabled={
                    !queueStatus?.aiProviderConfigured || providerTestLoading
                  }
                  onClick={() => void testOpenAIProvider()}
                >
                  {providerTestLoading ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Activity size={14} />
                  )}{" "}
                  Uji koneksi OpenAI
                </button>
              </div>
              {providerTestStatus && (
                <div
                  className={`provider-test-result ${providerTestStatus.good ? "good" : "bad"}`}
                  role="status"
                >
                  <span>{providerTestStatus.good ? "✓" : "!"}</span>
                  <p>{providerTestStatus.message}</p>
                </div>
              )}
              <div className="provider-config-note">
                <b>Untuk mengaktifkan tugas AI:</b> isi OPENAI_API_KEY dan
                OPENAI_MODEL pada .env; uji koneksi dahulu dengan executor tetap
                dry-run, lalu ubah TASK_EXECUTOR_MODE=openai dan restart seluruh
                proses.
              </div>
            </section>
            <div className="security-checklist panel">
              <div className="panel-heading">
                <div>
                  <h2>Checklist sebelum deployment</h2>
                  <p>
                    Jangan membuka API publik sampai semua kontrol inti siap.
                  </p>
                </div>
              </div>
              {[
                "Ganti seluruh nilai CHANGE_ME di .env lokal.",
                "Jangan commit file .env atau API key.",
                "Tambahkan rate limiting, rotasi token, dan pengelolaan session sebelum publikasi.",
                "Jalankan programmer agent hanya dalam sandbox/container terisolasi.",
                "Wajibkan approval manusia untuk publikasi, deployment, penghapusan, email, atau pembayaran.",
                "Siapkan backup, restore, logging, dan monitoring sebelum produksi.",
              ].map((text, index) => (
                <div className="checklist-row" key={text}>
                  <span>{index + 1}</span>
                  <p>{text}</p>
                </div>
              ))}
            </div>
          </>
        )}
        <footer className="app-footer">
          <span>✳ KantorAI · Manager AI M4</span>
          <span>Local development · data persisten</span>
        </footer>
      </main>
      {showAgentForm && (
        <AgentForm
          departments={departments}
          onClose={() => setShowAgentForm(false)}
          onSubmit={createAgent}
          onError={setError}
        />
      )}
      {showTaskForm && (
        <TaskForm
          agents={activeAgents}
          onClose={() => setShowTaskForm(false)}
          onSubmit={createTask}
          onError={setError}
        />
      )}
      {selectedAgent && (
        <AgentDrawer
          agent={selectedAgent}
          department={selectedDepartment}
          onClose={() => setSelectedAgent(null)}
          onToggle={toggleAgent}
        />
      )}
    </div>
  );
}

function NavButton({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {count !== undefined && <small>{count}</small>}
    </button>
  );
}
function StatCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
  hint: string;
  tone: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-head">
        <span>{label}</span>
        <div className={`stat-icon ${tone}`}>{icon}</div>
      </div>
      <strong>{value}</strong>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}
function AgentRow({
  agent,
  onSelect,
}: {
  agent: Agent;
  onSelect: (agent: Agent) => void;
}) {
  const color = String(agent.visualConfig?.shirt || "#ca826c");
  return (
    <button className="compact-agent-row" onClick={() => onSelect(agent)}>
      <div className="tiny-person" style={{ background: color }}>
        {agent.name.slice(0, 1)}
      </div>
      <div className="compact-agent-meta">
        <b>{agent.name}</b>
        <span>{agent.role}</span>
      </div>
      <span className={`status-dot ${agent.enabled ? "online" : "offline"}`}>
        {agent.enabled ? "Aktif" : "Nonaktif"}
      </span>
    </button>
  );
}
function AgentCard({
  agent,
  onSelect,
  onToggle,
}: {
  agent: Agent;
  onSelect: (agent: Agent) => void;
  onToggle: (agent: Agent) => void | Promise<void>;
}) {
  const color = String(agent.visualConfig?.shirt || "#ca826c");
  return (
    <article className={`agent-card ${agent.enabled ? "" : "disabled"}`}>
      <div className="agent-card-top">
        <button
          className="agent-avatar-big"
          style={{ background: `${color}24`, color }}
          onClick={() => onSelect(agent)}
        >
          {agent.name.slice(0, 1)}
        </button>
        <div className="agent-card-title">
          <h3>{agent.name}</h3>
          <span>{agent.role}</span>
        </div>
        <span className={`status-dot ${agent.enabled ? "online" : "offline"}`}>
          {agent.enabled ? "Aktif" : "Nonaktif"}
        </span>
      </div>
      <p>{agent.description || "Belum ada deskripsi agent."}</p>
      <div className="agent-card-dept">
        <BriefcaseBusiness size={14} />
        {agent.department?.name || "Belum ada departemen"}
      </div>
      <div className="agent-tools">
        {agent.allowedTools.slice(0, 3).map((tool) => (
          <span key={tool}>{tool}</span>
        ))}
        {agent.allowedTools.length === 0 && <span>Tools belum diizinkan</span>}
      </div>
      <div className="agent-card-foot">
        <button className="text-button" onClick={() => onSelect(agent)}>
          Detail agent <ArrowUpRight size={14} />
        </button>
        <button className="small-toggle" onClick={() => void onToggle(agent)}>
          <Power size={14} />
          {agent.enabled ? "Nonaktifkan" : "Aktifkan"}
        </button>
      </div>
    </article>
  );
}
function TaskCard({
  task,
  onAction,
  onToggleRuns,
  runs,
  runsLoading,
  runsExpanded,
  onDownloadArtifact,
}: {
  task: Task;
  onAction: (
    task: Task,
    action: "queue" | "pause" | "resume" | "cancel" | "retry" | "complete",
  ) => void | Promise<void>;
  onToggleRuns: (taskId: string) => void | Promise<void>;
  runs?: TaskRun[];
  runsLoading: boolean;
  runsExpanded: boolean;
  onDownloadArtifact: (artifact: TaskArtifact) => void | Promise<void>;
}) {
  const diagnosticOnly = task.metadata?.diagnosticOnly === true;
  const actions: Array<{
    key: "queue" | "pause" | "resume" | "cancel" | "retry" | "complete";
    label: string;
    icon: ReactNode;
    tone?: string;
  }> = [];
  if (task.status === "DRAFT")
    actions.push(
      { key: "queue", label: "Masukkan antrean", icon: <Play size={13} /> },
      {
        key: "cancel",
        label: "Batalkan",
        icon: <Ban size={13} />,
        tone: "danger",
      },
    );
  else if (task.status === "QUEUED")
    actions.push(
      { key: "pause", label: "Jeda", icon: <PauseCircle size={13} /> },
      {
        key: "cancel",
        label: "Batalkan",
        icon: <Ban size={13} />,
        tone: "danger",
      },
    );
  else if (["PLANNING", "RUNNING"].includes(task.status))
    actions.push(
      { key: "pause", label: "Jeda", icon: <PauseCircle size={13} /> },
      {
        key: "cancel",
        label: "Batalkan",
        icon: <Ban size={13} />,
        tone: "danger",
      },
    );
  else if (task.status === "PAUSED")
    actions.push(
      { key: "resume", label: "Lanjutkan", icon: <Play size={13} /> },
      {
        key: "cancel",
        label: "Batalkan",
        icon: <Ban size={13} />,
        tone: "danger",
      },
    );
  else if (["FAILED", "BLOCKED"].includes(task.status))
    actions.push(
      { key: "retry", label: "Coba lagi", icon: <RotateCcw size={13} /> },
      {
        key: "cancel",
        label: "Batalkan",
        icon: <Ban size={13} />,
        tone: "danger",
      },
    );
  else if (task.status === "REVIEW_REQUIRED" && diagnosticOnly)
    actions.push(
      { key: "retry", label: "Jalankan ulang", icon: <RotateCcw size={13} /> },
      {
        key: "cancel",
        label: "Batalkan",
        icon: <Ban size={13} />,
        tone: "danger",
      },
    );
  else if (task.status === "REVIEW_REQUIRED" && !diagnosticOnly)
    actions.push({
      key: "complete",
      label: "Setujui selesai",
      icon: <Check size={13} />,
    });
  const outputDescription = diagnosticOnly
    ? "Run terakhir hanya diagnostik M2. Belum ada hasil tugas dari model AI pada run tersebut."
    : null;
  return (
    <article className="task-card">
      <div className="task-card-top">
        <span className="priority-mark">
          {priorityTitles[task.priority] || task.priority}
        </span>
        <span className={statusClass(task.status)}>
          {statusTitles[task.status] || task.status}
        </span>
      </div>
      <h3>{task.title}</h3>
      <p>{task.instruction}</p>
      <div className="task-assignee">
        <div className="task-assignee-avatar">
          {task.assignedAgent?.name?.slice(0, 1) || "?"}
        </div>
        <span>{task.assignedAgent?.name || "Belum ditugaskan"}</span>
      </div>
      {outputDescription && (
        <div className="diagnostic-callout">
          <AlertTriangle size={14} />
          <span>{outputDescription}</span>
        </div>
      )}
      {actions.length > 0 && (
        <div className="task-actions">
          {actions.map((action) => (
            <button
              type="button"
              key={action.key}
              className={`task-action ${action.tone || ""}`}
              onClick={() => void onAction(task, action.key)}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="runs-toggle"
        onClick={() => void onToggleRuns(task.id)}
      >
        <Activity size={14} />
        {runsExpanded
          ? "Sembunyikan riwayat"
          : `Run & artefak (${task._count?.runs ?? 0} / ${task._count?.artifacts ?? 0})`}
        {runsLoading ? (
          <LoaderCircle size={13} className="spin" />
        ) : (
          <ChevronDownIcon size={14} />
        )}
      </button>
      {runsExpanded && (
        <div className="run-details">
          {runsLoading ? (
            <div className="run-empty">
              <LoaderCircle size={14} className="spin" /> Memuat riwayat run…
            </div>
          ) : !runs || runs.length === 0 ? (
            <div className="run-empty">
              Belum ada run. Masukkan task ke antrean agar worker mengambilnya.
            </div>
          ) : (
            runs.map((run, index) => {
              const output =
                run.output && typeof run.output === "object"
                  ? (run.output as Record<string, unknown>)
                  : null;
              const diagnostic =
                output?.diagnosticOnly === true || output?.mode === "dry-run";
              return (
                <div className="run-item" key={run.id}>
                  <div className="run-item-head">
                    <b>
                      Run {runs.length - index} · {run.agent?.name || "Agent"}
                    </b>
                    <span
                      className={`status-pill status-${run.status.toLowerCase()}`}
                    >
                      {run.status}
                    </span>
                  </div>
                  <div className="run-meta">
                    Mulai{" "}
                    {new Date(run.startedAt).toLocaleString("id-ID", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                    {run.finishedAt
                      ? ` · Selesai ${new Date(run.finishedAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
                      : " · berjalan"}
                  </div>
                  {run.errorMessage && (
                    <p className="run-error">{run.errorMessage}</p>
                  )}
                  {diagnostic && (
                    <div className="diagnostic-callout">
                      <AlertTriangle size={14} />
                      <span>
                        Diagnostik worker sukses, tetapi instruksi belum
                        dikerjakan oleh model AI pada run ini.
                      </span>
                    </div>
                  )}
                  {output && (
                    <details className="run-output">
                      <summary>Lihat output run</summary>
                      <pre>{JSON.stringify(output, null, 2)}</pre>
                    </details>
                  )}
                  {run.artifacts.length > 0 && (
                    <div className="artifact-list">
                      {run.artifacts.map((artifact) => (
                        <button
                          type="button"
                          className="artifact-download"
                          key={artifact.id}
                          onClick={() => void onDownloadArtifact(artifact)}
                        >
                          <Download size={13} />
                          <span>{artifact.name}</span>
                          <small>
                            {artifact.sizeBytes
                              ? `${Math.max(1, Math.round(Number(artifact.sizeBytes) / 1024))} KB`
                              : "Artefak"}
                          </small>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="run-event-list">
                    {run.events.slice(-5).map((event) => (
                      <div key={event.id}>
                        <span>
                          {new Date(event.createdAt).toLocaleTimeString(
                            "id-ID",
                            {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            },
                          )}
                        </span>
                        {event.message || event.eventType}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </article>
  );
}
function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span className={`priority-pill priority-${priority.toLowerCase()}`}>
      {priorityTitles[priority] || priority}
    </span>
  );
}
function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <div>
        <Search size={20} />
      </div>
      <p>{text}</p>
    </div>
  );
}
function SettingCard({
  icon,
  title,
  value,
  desc,
  good,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  desc: string;
  good: boolean;
}) {
  return (
    <div className="setting-card">
      <div className="setting-top">
        <div className="setting-icon">{icon}</div>
        <span className={`status-dot ${good ? "online" : "offline"}`}>
          {good ? "Ready" : "Belum siap"}
        </span>
      </div>
      <h3>{title}</h3>
      <b>{value}</b>
      <p>{desc}</p>
    </div>
  );
}
function DatabaseIcon() {
  return <FileText size={19} />;
}

function LoginScreen({
  onLogin,
  loading,
  error,
}: {
  onLogin: (email: string, password: string) => void;
  loading: boolean;
  error: string;
  apiOnline: boolean;
}) {
  const [email, setEmail] = useState("admin@kantorai.local");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  return (
    <div className="login-page">
      <div className="login-visual">
        <div className="login-brand">
          <div className="brand-mark">
            <Command size={22} />
          </div>
          <div>
            <b>KantorAI</b>
            <span>VIRTUAL AI OFFICE</span>
          </div>
        </div>
        <div className="login-copy">
          <div className="eyebrow">YOUR DIGITAL TEAM</div>
          <h1>
            Satu kantor.
            <br />
            <em>Banyak kemungkinan.</em>
          </h1>
          <p>
            Bangun tim AI yang bekerja bersama, dikelola dari satu ruang kerja
            virtual.
          </p>
          <div className="login-mini-scene">
            <div className="mini-floor">
              <span className="mini-desk d1" />
              <span className="mini-desk d2" />
              <span className="mini-desk d3" />
              <span className="mini-person p1" />
              <span className="mini-person p2" />
              <span className="mini-person p3" />
              <span className="mini-plant" />
            </div>
          </div>
        </div>
        <div className="login-footer">
          PRIVATE WORKSPACE · LOCAL DEVELOPMENT
        </div>
      </div>
      <div className="login-side">
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            onLogin(email, password);
          }}
        >
          <div className="login-tag">
            <ShieldCheck size={15} /> AMAN · WORKSPACE PRIBADI
          </div>
          <h2>Masuk ke kantor Anda</h2>
          <p>Gunakan akun bootstrap dari file .env lokal Anda.</p>
          {error && (
            <div className="form-error">
              <AlertTriangle size={15} />
              {error}
            </div>
          )}
          <label>
            Email workspace
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <div className="password-field">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? "Sembunyikan" : "Lihat"}
              </button>
            </div>
          </label>
          <button className="button-primary login-button" disabled={loading}>
            {loading ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <DoorOpen size={17} />
            )}{" "}
            Masuk ke workspace
          </button>
          <div className="login-help">
            <CircleHelp size={15} />
            <span>
              Akun awal dibuat melalui <code>npm run db:seed</code>. Password
              dibaca dari <code>.env</code>; tidak ada password default yang
              disematkan di UI.
            </span>
          </div>
        </form>
        <div className="login-side-footer">
          KantorAI · Milestone M2 · Build lokal
        </div>
      </div>
    </div>
  );
}

function AgentForm({
  departments,
  onClose,
  onSubmit,
  onError,
}: {
  departments: Department[];
  onClose: () => void;
  onSubmit: (values: {
    name: string;
    role: string;
    departmentCode: string;
    description: string;
    systemPrompt: string;
  }) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [departmentCode, setDepartmentCode] = useState("engineering");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    onError("");
    try {
      await onSubmit({ name, role, departmentCode, description, systemPrompt });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Agent gagal disimpan.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="Tambah AI employee"
      subtitle="Simpan spesialis baru secara permanen ke registry PostgreSQL."
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-stack">
        <div className="form-grid">
          <label>
            Nama karakter *
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              maxLength={60}
              placeholder="Contoh: Ardi"
              required
              autoFocus
            />
          </label>
          <label>
            Jabatan *
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              minLength={2}
              maxLength={100}
              placeholder="Contoh: Software Engineer AI"
              required
            />
          </label>
        </div>
        <label>
          Departemen *
          <select
            value={departmentCode}
            onChange={(e) => setDepartmentCode(e.target.value)}
          >
            {departments.map((dep) => (
              <option value={dep.code} key={dep.id}>
                {dep.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Deskripsi tanggung jawab
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Jelaskan peran dan batasan pekerjaan agent."
          />
        </label>
        <details>
          <summary>Instruksi sistem (opsional)</summary>
          <label className="inner-label">
            Instruksi untuk agent
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
              maxLength={12000}
              placeholder="Pedoman perilaku, sumber data, batasan, dan output yang diharapkan."
            />
          </label>
          <small>
            Instruksi disimpan di backend; tidak dikirim utuh melalui endpoint
            daftar agent.
          </small>
        </details>
        <div className="modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="button-primary" disabled={saving}>
            {saving ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Plus size={16} />
            )}{" "}
            Simpan agent
          </button>
        </div>
      </form>
    </Modal>
  );
}
function TaskForm({
  agents,
  onClose,
  onSubmit,
  onError,
}: {
  agents: Agent[];
  onClose: () => void;
  onSubmit: (values: {
    title: string;
    instruction: string;
    priority: string;
    assignedAgentId: string;
    submitNow: boolean;
  }) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [assignedAgentId, setAssignedAgentId] = useState("");
  const [submitNow, setSubmitNow] = useState(false);
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    onError("");
    try {
      await onSubmit({
        title,
        instruction,
        priority,
        assignedAgentId,
        submitNow,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Tugas gagal disimpan.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="Buat tugas"
      subtitle="Task disimpan di PostgreSQL. Worker mengikuti executor aktif: dry-run diagnostik atau OpenAI untuk menghasilkan keluaran teks yang perlu direview."
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-stack">
        <label>
          Nama tugas *
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            minLength={3}
            maxLength={180}
            placeholder="Contoh: Analisis tren dan siapkan ringkasan"
            required
            autoFocus
          />
        </label>
        <label>
          Instruksi / brief *
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            minLength={3}
            maxLength={12000}
            rows={4}
            placeholder="Jelaskan tujuan, file input, batasan, dan format hasil."
            required
          />
        </label>
        <div className="form-grid">
          <label>
            Agent penanggung jawab
            <select
              value={assignedAgentId}
              onChange={(e) => setAssignedAgentId(e.target.value)}
            >
              <option value="">Belum ditugaskan</option>
              {agents.map((agent) => (
                <option value={agent.id} key={agent.id}>
                  {agent.name} · {agent.role}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prioritas
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            >
              <option value="LOW">Rendah</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">Tinggi</option>
              <option value="URGENT">Mendesak</option>
            </select>
          </label>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={submitNow}
            onChange={(e) => setSubmitNow(e.target.checked)}
          />
          <span>
            <b>Masukkan ke antrian</b>
            <small>
              Worker mengambil tugas dari antrean. Dalam mode OpenAI, instruksi
              dikirim ke model dan hasilnya disimpan sebagai artefak; pada
              dry-run hanya laporan diagnostik.
            </small>
          </span>
        </label>
        <div className="modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="button-primary" disabled={saving}>
            {saving ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Plus size={16} />
            )}{" "}
            Simpan tugas
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-panel" role="dialog" aria-modal="true">
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            className="icon-soft"
            onClick={onClose}
            aria-label="Tutup modal"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function AgentDrawer({
  agent,
  department,
  onClose,
  onToggle,
}: {
  agent: Agent;
  department?: Department;
  onClose: () => void;
  onToggle: (agent: Agent) => void | Promise<void>;
}) {
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="agent-drawer">
        <div className="drawer-heading">
          <div>
            <span className="eyebrow">AGENT DETAIL</span>
            <h2>{agent.name}</h2>
          </div>
          <button className="icon-soft" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="drawer-identity">
          <div
            className="drawer-avatar"
            style={{
              background: String(agent.visualConfig?.shirt || "#ca826c"),
            }}
          >
            {agent.name.slice(0, 1)}
          </div>
          <div>
            <b>{agent.role}</b>
            <span>
              {department?.name || agent.department?.name || "Tanpa departemen"}
            </span>
            <span
              className={`status-dot ${agent.enabled ? "online" : "offline"}`}
            >
              {agent.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
        </div>
        <p className="drawer-description">
          {agent.description || "Belum ada deskripsi."}
        </p>
        <div className="drawer-section">
          <h3>Konfigurasi model</h3>
          <div className="detail-line">
            <span>Provider</span>
            <b>{agent.provider || "Belum dikonfigurasi"}</b>
          </div>
          <div className="detail-line">
            <span>Model</span>
            <b>{agent.model || "Belum dikonfigurasi"}</b>
          </div>
          <div className="detail-line">
            <span>System prompt</span>
            <b>
              {agent.hasSystemPrompt ? "Tersimpan di backend" : "Belum diisi"}
            </b>
          </div>
        </div>
        <div className="drawer-section">
          <h3>Tools diizinkan</h3>
          <div className="agent-tools">
            {agent.allowedTools.map((tool) => (
              <span key={tool}>{tool}</span>
            ))}
            {agent.allowedTools.length === 0 && (
              <span>Belum ada tools yang diizinkan.</span>
            )}
          </div>
        </div>
        <div className="drawer-callout">
          <ShieldCheck size={18} />
          <span>
            Agent ini sudah terdaftar. Pada M3, agent menggunakan OpenAI untuk
            menghasilkan draf teks. Penggunaan tools, perubahan berkas, dan
            eksekusi kode belum aktif; hasil tetap perlu review manusia.
          </span>
        </div>
        <button
          className="button-secondary drawer-toggle"
          onClick={() => void onToggle(agent)}
        >
          <Power size={16} />
          {agent.enabled ? "Nonaktifkan agent" : "Aktifkan agent"}
        </button>
      </aside>
    </div>
  );
}
