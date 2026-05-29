import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";

type Role = "viewer" | "editor" | "owner";
type WorkspaceView =
  | "overview"
  | "workflows"
  | "builder"
  | "runs"
  | "dlq"
  | "profile"
  | "settings";

type AppRoute =
  | { kind: "login" }
  | { kind: "signup" }
  | { kind: "workspace"; view: WorkspaceView };

type Toast = {
  id: string;
  tone: "info" | "success" | "error";
  message: string;
};

type Workflow = {
  id: string;
  tenant_id: string;
  name: string;
  draft_updated_at: string;
  created_at: string;
  updated_at: string;
};

type WorkflowDetail = Workflow & {
  draft_graph: unknown;
};

type WorkflowVersion = {
  id: string;
  tenant_id: string;
  workflow_id: string;
  version: number;
  graph: unknown;
  created_at?: string;
  published_at?: string;
};

type AuthMe = {
  tenant_id: string;
  user_id: string;
  email: string;
  name: string;
  role: Role;
};

type NodeType = "delay" | "http_request" | "condition" | "notify";

type CanvasPoint = { x: number; y: number };

type GraphNode = {
  id: string;
  type: NodeType;
  config: Record<string, unknown>;
  position: CanvasPoint;
};

type GraphEdge = {
  from: string;
  to: string;
  when?: string;
};

type Run = {
  id: string;
  workflow_version_id?: string;
  workflow_id?: string;
  status: string;
  started_at?: string;
  created_at?: string;
  finished_at?: string;
};

type RunDetail = {
  id: string;
  status: string;
  started_at?: string;
  created_at?: string;
  finished_at?: string;
};

type NodeRun = {
  id: string;
  node_id?: string;
  node_type?: string;
  status?: string;
  outcome?: string;
  attempt?: number;
  max_attempts?: number;
  queued_at?: string;
  finished_at?: string;
};

type NodeLog = {
  id: string;
  level?: string;
  ts?: string;
  data?: unknown;
  message?: string;
};

type AuthBootstrapResponse = {
  tenant: { id: string; name?: string; slug?: string };
  api_key: { token: string };
  user: { id: string; email: string; name: string };
  role: Role;
};

type DlqItem = {
  id: string;
  name: string;
  state: string;
  data: {
    tenant_id?: string;
    node_run_id?: string;
    workflow_run_id?: string;
    node_id?: string;
    node_type?: string;
    reason?: string;
    error?: unknown;
  };
  attemptsMade: number;
  failedReason?: string;
  timestamp?: number;
};

type GraphTemplate = {
  trigger: {
    enabled: boolean;
    webhook_secret: string;
    schedule_cron: string;
  };
  entry_node_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

const nodeCatalog: Record<
  NodeType,
  {
    title: string;
    description: string;
    defaultConfig: Record<string, unknown>;
  }
> = {
  delay: {
    title: "Delay",
    description: "Pause before continuing.",
    defaultConfig: { seconds: 30 },
  },
  http_request: {
    title: "HTTP request",
    description: "Call an external API.",
    defaultConfig: { method: "GET", url: "https://example.com" },
  },
  condition: {
    title: "Condition",
    description: "Branch based on a comparison.",
    defaultConfig: {
      base: "context",
      path: "nodes.http-1.output.status",
      op: "eq",
      value: 200,
    },
  },
  notify: {
    title: "Notify",
    description: "Send a notification.",
    defaultConfig: {
      provider: "email",
      to: "",
      subject: "Flow update",
    },
  },
};

const backendBaseUrl =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

const storageKeys = {
  token: "flow-ui-token",
  tenantId: "flow-ui-tenant-id",
};

const starterDraftGraph: GraphTemplate = {
  trigger: {
    enabled: true,
    webhook_secret: "",
    schedule_cron: "",
  },
  entry_node_id: "delay-1",
  nodes: [
    {
      id: "delay-1",
      type: "delay",
      config: { seconds: 2 },
      position: { x: 120, y: 160 },
    },
    {
      id: "notify-1",
      type: "notify",
      config: {
        provider: "email",
        to: "",
        subject: "Flow notification",
      },
      position: { x: 420, y: 160 },
    },
  ],
  edges: [{ from: "delay-1", to: "notify-1" }],
};

async function apiFetch<T>(
  path: string,
  options: {
    token?: string;
    tenantId?: string;
    method?: string;
    body?: unknown;
  } = {},
): Promise<T> {
  const response = await fetch(`${backendBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.tenantId ? { "x-tenant-id": options.tenantId } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  return (text ? JSON.parse(text) : null) as T;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusTone(status: string) {
  if (["SUCCEEDED", "completed"].includes(status)) return "chip chip-good";
  if (["FAILED", "FAILED_FINAL", "failed"].includes(status)) {
    return "chip chip-bad";
  }
  if (["RUNNING", "IN_PROGRESS", "active", "READY"].includes(status)) {
    return "chip chip-warm";
  }
  return "chip";
}

function safeParseJson(text: string): unknown {
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function roleAtLeast(role: Role | null | undefined, minRole: Role) {
  if (!role) return false;
  const rank: Record<Role, number> = {
    viewer: 0,
    editor: 1,
    owner: 2,
  };
  return rank[role] >= rank[minRole];
}

function panelClassName(extra = "") {
  return extra ? `panel ${extra}` : "panel";
}

function normalizeGraph(graph: unknown): GraphTemplate {
  const fallback = starterDraftGraph;
  if (!graph || typeof graph !== "object") {
    return fallback;
  }

  const candidate = graph as Partial<GraphTemplate> & {
    nodes?: Array<Partial<GraphNode>>;
    edges?: Array<Partial<GraphEdge>>;
  };

  const nodes = Array.isArray(candidate.nodes)
    ? candidate.nodes
        .filter((node) => !!node && !!node.id)
        .map((node, index) => ({
          id: String(node.id),
          type: nodeCatalog[String(node.type) as NodeType]
            ? (String(node.type) as NodeType)
            : "delay",
          config:
            node.config && typeof node.config === "object"
              ? (node.config as Record<string, unknown>)
              : {},
          position:
            node.position &&
            typeof node.position === "object" &&
            typeof node.position.x === "number" &&
            typeof node.position.y === "number"
              ? { x: node.position.x, y: node.position.y }
              : {
                  x: 96 + (index % 3) * 220,
                  y: 96 + Math.floor(index / 3) * 160,
                },
        }))
    : fallback.nodes;

  const edges = Array.isArray(candidate.edges)
    ? candidate.edges
        .filter((edge) => !!edge && !!edge.from && !!edge.to)
        .map((edge) => ({ from: String(edge.from), to: String(edge.to) }))
    : fallback.edges;

  return {
    trigger: {
      enabled: candidate.trigger?.enabled !== false,
      webhook_secret:
        typeof candidate.trigger?.webhook_secret === "string"
          ? candidate.trigger.webhook_secret
          : "",
      schedule_cron:
        typeof candidate.trigger?.schedule_cron === "string"
          ? candidate.trigger.schedule_cron
          : "",
    },
    entry_node_id:
      typeof candidate.entry_node_id === "string"
        ? candidate.entry_node_id
        : (nodes[0]?.id ?? ""),
    nodes,
    edges,
  };
}

function nodeAccent(type: NodeType) {
  switch (type) {
    case "delay":
      return "#5eead4";
    case "http_request":
      return "#60a5fa";
    case "condition":
      return "#fbbf24";
    case "notify":
      return "#fb7185";
  }
}

function nodeSubtitle(type: NodeType) {
  return nodeCatalog[type]?.description ?? type;
}

function pathToRoute(pathname: string): AppRoute {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts[0] === "signup") return { kind: "signup" };
  if (parts[0] === "login" || parts.length === 0) return { kind: "login" };

  if (parts[0] === "app") {
    const view = parts[1] ?? "overview";
    if (
      view === "workflows" ||
      view === "builder" ||
      view === "runs" ||
      view === "dlq" ||
      view === "profile" ||
      view === "settings"
    ) {
      return { kind: "workspace", view };
    }
    return { kind: "workspace", view: "overview" };
  }

  return { kind: "login" };
}

function routeToPath(route: AppRoute) {
  if (route.kind === "login") return "/login";
  if (route.kind === "signup") return "/signup";
  return route.view === "overview" ? "/app" : `/app/${route.view}`;
}

function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem(storageKeys.token) ?? "",
  );
  const [tenantId, setTenantId] = useState(
    () => localStorage.getItem(storageKeys.tenantId) ?? "",
  );
  const [tenantSlug, setTenantSlug] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [userName, setUserName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [me, setMe] = useState<AuthMe | null>(null);
  const [tenantLabel, setTenantLabel] = useState<string>("");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [dlqItems, setDlqItems] = useState<DlqItem[]>([]);
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(
    null,
  );
  const [workflowVersions, setWorkflowVersions] = useState<WorkflowVersion[]>(
    [],
  );
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [nodeRuns, setNodeRuns] = useState<NodeRun[]>([]);
  const [nodeLogs, setNodeLogs] = useState<NodeLog[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [selectedNodeRunId, setSelectedNodeRunId] = useState<string>("");
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [workflowNameInput, setWorkflowNameInput] = useState("");
  const [draftGraphInput, setDraftGraphInput] = useState(
    JSON.stringify(starterDraftGraph, null, 2),
  );
  const [draftError, setDraftError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"register" | "login">("register");
  const [loading, setLoading] = useState(false);
  const [panelLoading, setPanelLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [runActionLoading, setRunActionLoading] = useState<string | null>(null);
  const [dlqActionLoading, setDlqActionLoading] = useState<string | null>(null);
  const [route, setRoute] = useState<AppRoute>(() =>
    pathToRoute(window.location.pathname),
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [pendingEdgeSourceId, setPendingEdgeSourceId] = useState<string>("");
  const [canvasDragging, setCanvasDragging] = useState<{
    nodeId: string;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasScale, setCanvasScale] = useState<number>(1);
  const [canvasOffset, setCanvasOffset] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const panState = useRef<{
    active: boolean;
    startX: number;
    startY: number;
  } | null>(null);
  const draftGraphTextRef = useRef(draftGraphInput);
  const toastTimerRef = useRef<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  function navigate(nextRoute: AppRoute, replace = false) {
    const nextPath = routeToPath(nextRoute);
    if (replace) {
      window.history.replaceState({}, "", nextPath);
    } else {
      window.history.pushState({}, "", nextPath);
    }
    setRoute(nextRoute);
  }

  function pushToast(message: string, tone: Toast["tone"] = "info") {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3600);
  }

  useEffect(() => {
    const handlePopState = () =>
      setRoute(pathToRoute(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (route.kind === "signup") {
      setAuthMode("register");
    } else if (route.kind === "login") {
      setAuthMode("login");
    }
  }, [route.kind]);

  const activeView = route.kind === "workspace" ? route.view : "overview";

  useEffect(() => {
    draftGraphTextRef.current = draftGraphInput;
  }, [draftGraphInput]);

  const graphDraft = useMemo(() => {
    try {
      return normalizeGraph(safeParseJson(draftGraphInput));
    } catch {
      return null;
    }
  }, [draftGraphInput]);

  const graphNodes = graphDraft?.nodes ?? [];
  const graphEdges = graphDraft?.edges ?? [];
  const selectedGraphNode = useMemo(
    () => graphNodes.find((node) => node.id === selectedNodeId) ?? null,
    [graphNodes, selectedNodeId],
  );

  const isReady = token.trim().length > 0 && tenantId.trim().length > 0;
  const canEdit = roleAtLeast(me?.role, "editor");
  const canResolveDlq = roleAtLeast(me?.role, "owner");

  useEffect(() => {
    if (!isReady && route.kind === "workspace") {
      navigate({ kind: "login" }, true);
    }
  }, [isReady, route.kind]);

  const selectedWorkflow = useMemo(
    () =>
      workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows],
  );

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const selectedNodeRun = useMemo(
    () => nodeRuns.find((nodeRun) => nodeRun.id === selectedNodeRunId) ?? null,
    [nodeRuns, selectedNodeRunId],
  );

  const stats = useMemo(() => {
    const activeRuns = runs.filter((run) => run.status === "RUNNING").length;
    const pausedRuns = runs.filter((run) => run.status === "PAUSED").length;
    const failedRuns = runs.filter((run) =>
      ["FAILED", "FAILED_FINAL"].includes(run.status),
    ).length;

    return {
      workflows: workflows.length,
      runs: runs.length,
      activeRuns,
      pausedRuns,
      failedRuns,
      dlq: dlqItems.length,
    };
  }, [dlqItems.length, runs, workflows.length]);

  const triggerSummary = useMemo(() => {
    try {
      const graph = safeParseJson(draftGraphInput) as any;
      const trigger = graph?.trigger ?? {};

      return {
        enabled: trigger.enabled !== false,
        webhook:
          typeof trigger.webhook_secret === "string" &&
          trigger.webhook_secret.trim()
            ? "set"
            : "unset",
        schedule:
          typeof trigger.schedule_cron === "string" &&
          trigger.schedule_cron.trim()
            ? trigger.schedule_cron
            : "unset",
      };
    } catch {
      return {
        enabled: false,
        webhook: "invalid JSON",
        schedule: "invalid JSON",
      };
    }
  }, [draftGraphInput]);

  useEffect(() => {
    localStorage.setItem(storageKeys.token, token.trim());
  }, [token]);

  useEffect(() => {
    localStorage.setItem(storageKeys.tenantId, tenantId.trim());
  }, [tenantId]);

  async function refreshWorkspace(options?: {
    skipMe?: boolean;
    meOverride?: AuthMe | null;
  }) {
    if (!isReady) return;

    setLoading(true);
    setError(null);

    try {
      let nextMe = options?.meOverride ?? me;
      if (!options?.skipMe) {
        nextMe = await apiFetch<AuthMe>("/v1/auth/me", { token, tenantId });
        setMe(nextMe);
      }

      const [workflowResponse, runResponse, dlqResponse] = await Promise.all([
        apiFetch<{ items: Workflow[] }>("/v1/workflows", { token, tenantId }),
        apiFetch<{ items: Run[] }>("/v1/runs", { token, tenantId }),
        nextMe?.role === "owner"
          ? apiFetch<{ items: DlqItem[] }>("/v1/dlq?limit=8", {
              token,
              tenantId,
            })
          : Promise.resolve<{ items: DlqItem[] }>({ items: [] }),
      ]);

      setWorkflows(workflowResponse.items ?? []);
      setRuns(runResponse.items ?? []);
      setDlqItems(dlqResponse.items ?? []);
      setLastSyncedAt(new Date().toISOString());

      if (!selectedWorkflowId && workflowResponse.items?.length) {
        setSelectedWorkflowId(workflowResponse.items[0].id);
      }

      if (!selectedRunId && runResponse.items?.length) {
        setSelectedRunId(runResponse.items[0].id);
      }

      if (nextMe?.role !== "owner") {
        setDlqItems([]);
      }

      if (nextMe && tenantLabel.trim().length === 0) {
        setTenantLabel(`Tenant ${tenantId.slice(0, 8)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadWorkflowBundle(workflowId: string) {
    if (!isReady || !workflowId) return;

    setPanelLoading(true);
    setError(null);

    try {
      const [detail, versions] = await Promise.all([
        apiFetch<WorkflowDetail>(`/v1/workflows/${workflowId}`, {
          token,
          tenantId,
        }),
        apiFetch<{ items: WorkflowVersion[] }>(
          `/v1/workflows/${workflowId}/versions`,
          { token, tenantId },
        ),
      ]);

      setWorkflowDetail(detail);
      setWorkflowNameInput(detail.name);
      setDraftGraphInput(prettyJson(detail.draft_graph ?? starterDraftGraph));
      setWorkflowVersions(versions.items ?? []);

      const latestVersionId = versions.items?.[0]?.id ?? "";
      setSelectedVersionId(latestVersionId);
      setSelectedWorkflowId(workflowId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not_found") || message.includes("404")) {
        setSelectedWorkflowId(workflows[0]?.id ?? "");
        setWorkflowDetail(null);
        setWorkflowVersions([]);
        setSelectedVersionId("");
        setDraftGraphInput(JSON.stringify(starterDraftGraph, null, 2));
        setError(
          "The selected workflow no longer exists. A different workflow has been selected.",
        );
        return;
      }
      setError(message);
    } finally {
      setPanelLoading(false);
    }
  }

  async function loadRunBundle(runId: string) {
    if (!isReady || !runId) return;

    setPanelLoading(true);
    setError(null);

    try {
      const [detail, nodes] = await Promise.all([
        apiFetch<RunDetail>(`/v1/runs/${runId}`, { token, tenantId }),
        apiFetch<{ items: NodeRun[] }>(`/v1/runs/${runId}/node-runs`, {
          token,
          tenantId,
        }),
      ]);

      setRunDetail(detail);
      setNodeRuns(nodes.items ?? []);
      setSelectedNodeRunId(nodes.items?.[0]?.id ?? "");
      setNodeLogs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPanelLoading(false);
    }
  }

  async function loadNodeLogs(nodeRunId: string) {
    if (!isReady || !nodeRunId) return;

    setPanelLoading(true);
    setError(null);

    try {
      const logs = await apiFetch<{ items: NodeLog[] }>(
        `/v1/runs/node-runs/${nodeRunId}/logs`,
        { token, tenantId },
      );
      setNodeLogs(logs.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPanelLoading(false);
    }
  }

  useEffect(() => {
    if (isReady) {
      void refreshWorkspace();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedWorkflowId) {
      void loadWorkflowBundle(selectedWorkflowId);
    } else {
      setWorkflowDetail(null);
      setWorkflowVersions([]);
      setDraftGraphInput(JSON.stringify(starterDraftGraph, null, 2));
      setWorkflowNameInput("");
      setSelectedVersionId("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkflowId]);

  useEffect(() => {
    if (selectedRunId) {
      void loadRunBundle(selectedRunId);
    } else {
      setRunDetail(null);
      setNodeRuns([]);
      setSelectedNodeRunId("");
      setNodeLogs([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  useEffect(() => {
    if (selectedNodeRunId) {
      void loadNodeLogs(selectedNodeRunId);
    } else {
      setNodeLogs([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeRunId]);

  async function bootstrapAccess() {
    setAuthLoading(true);
    setError(null);

    try {
      const body =
        authMode === "register"
          ? {
              tenant: {
                slug: tenantSlug.trim(),
                name: tenantName.trim(),
              },
              user: {
                name: userName.trim(),
                email: email.trim(),
                password,
              },
            }
          : {
              tenant_slug: tenantSlug.trim(),
              email: email.trim(),
              password,
            };

      const response = await apiFetch<AuthBootstrapResponse>(
        authMode === "register" ? "/v1/auth/register" : "/v1/auth/login",
        {
          method: "POST",
          body,
        },
      );

      setTenantId(response.tenant.id);
      setToken(response.api_key.token);
      const authenticatedMe = {
        tenant_id: response.tenant.id,
        user_id: response.user.id,
        email: response.user.email,
        name: response.user.name,
        role: response.role,
      };

      setMe(authenticatedMe);
      setTenantLabel(
        response.tenant.name ?? response.tenant.slug ?? response.tenant.id,
      );
      navigate({ kind: "workspace", view: "overview" }, true);
      pushToast(
        authMode === "register" ? "Workspace created." : "Signed in.",
        "success",
      );

      await refreshWorkspace({ skipMe: true, meOverride: authenticatedMe });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushToast(message, "error");
    } finally {
      setAuthLoading(false);
    }
  }

  async function createWorkflow() {
    if (!isReady || !canEdit || !newWorkflowName.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const created = await apiFetch<Workflow>("/v1/workflows", {
        token,
        tenantId,
        method: "POST",
        body: { name: newWorkflowName.trim() },
      });

      setNewWorkflowName("");
      setSelectedWorkflowId(created.id);
      pushToast("Workflow created.", "success");
      await refreshWorkspace({ skipMe: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushToast(message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function saveWorkflow() {
    if (!isReady || !canEdit || !workflowDetail) return;

    try {
      const draftGraph = safeParseJson(draftGraphInput);
      setDraftError(null);
      setLoading(true);
      setError(null);

      await apiFetch(`/v1/workflows/${workflowDetail.id}`, {
        token,
        tenantId,
        method: "PATCH",
        body: {
          name: workflowNameInput.trim() || workflowDetail.name,
          draft_graph: draftGraph,
        },
      });

      await refreshWorkspace({ skipMe: true });
      await loadWorkflowBundle(workflowDetail.id);
      pushToast("Workflow draft saved.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDraftError(message);
      pushToast(message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function publishWorkflow() {
    if (!isReady || !canEdit || !workflowDetail) return;

    try {
      const draftGraph = safeParseJson(draftGraphInput);
      setDraftError(null);
      setLoading(true);
      setError(null);

      await apiFetch(`/v1/workflows/${workflowDetail.id}/publish`, {
        token,
        tenantId,
        method: "POST",
        body: { draft_graph: draftGraph },
      });

      await refreshWorkspace({ skipMe: true });
      await loadWorkflowBundle(workflowDetail.id);
      pushToast("Workflow published.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDraftError(message);
      pushToast(message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function runPublishedVersion() {
    if (!isReady || !canEdit || !workflowDetail || !selectedVersionId) return;

    setLoading(true);
    setError(null);

    try {
      await apiFetch(
        `/v1/workflows/${workflowDetail.id}/versions/${selectedVersionId}/runs`,
        {
          token,
          tenantId,
          method: "POST",
          body: { input: {} },
        },
      );

      await refreshWorkspace({ skipMe: true });
      pushToast("Run created from published version.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushToast(message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function performRunAction(
    action: "start" | "pause" | "resume" | "cancel",
  ) {
    if (!isReady || !selectedRunId) return;

    setRunActionLoading(action);
    setError(null);

    try {
      await apiFetch(`/v1/runs/${selectedRunId}/${action}`, {
        token,
        tenantId,
        method: "POST",
      });

      await refreshWorkspace({ skipMe: true });
      await loadRunBundle(selectedRunId);
      pushToast(`Run ${action} requested.`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushToast(message, "error");
    } finally {
      setRunActionLoading(null);
    }
  }

  async function resolveDlqItem(jobId: string) {
    if (!isReady || !jobId || !canResolveDlq) return;

    setDlqActionLoading(jobId);
    setError(null);

    try {
      await apiFetch(`/v1/dlq/${jobId}/resolve`, {
        token,
        tenantId,
        method: "POST",
      });

      await refreshWorkspace({ skipMe: true });
      pushToast("DLQ item resolved.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushToast(message, "error");
    } finally {
      setDlqActionLoading(null);
    }
  }

  function applyStarterGraph() {
    const graph: GraphTemplate = {
      ...starterDraftGraph,
      nodes: [
        starterDraftGraph.nodes[0],
        {
          ...starterDraftGraph.nodes[1],
          config: {
            ...starterDraftGraph.nodes[1].config,
            to: me?.email ?? "",
          },
        },
      ],
    };

    setDraftGraphInput(JSON.stringify(graph, null, 2));
    setDraftError(null);
    setSelectedNodeId(graph.entry_node_id || graph.nodes[0]?.id || "");
    setPendingEdgeSourceId("");
    pushToast("Starter graph loaded.", "info");
  }

  function resetSession() {
    setToken("");
    setTenantId("");
    setTenantLabel("");
    setMe(null);
    setWorkflows([]);
    setRuns([]);
    setDlqItems([]);
    setWorkflowDetail(null);
    setWorkflowVersions([]);
    setRunDetail(null);
    setNodeRuns([]);
    setNodeLogs([]);
    setSelectedWorkflowId("");
    setSelectedRunId("");
    setSelectedNodeRunId("");
    setSelectedVersionId("");
    setSelectedNodeId("");
    setPendingEdgeSourceId("");
    setCanvasDragging(null);
    setError(null);
    setDraftError(null);
    navigate({ kind: "login" }, true);
  }

  function syncGraphDraft(updater: (graph: GraphTemplate) => GraphTemplate) {
    try {
      const currentGraph = normalizeGraph(
        safeParseJson(draftGraphTextRef.current),
      );
      let nextGraph = updater(currentGraph);

      // Normalize missing 'when' on condition outgoing edges.
      try {
        nextGraph = normalizeConditionEdges(nextGraph);
      } catch {}

      const nextText = JSON.stringify(nextGraph, null, 2);
      draftGraphTextRef.current = nextText;
      setDraftGraphInput(nextText);
      setDraftError(null);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    }
  }

  function normalizeConditionEdges(graph: GraphTemplate) {
    const g = {
      ...graph,
      edges: Array.isArray(graph.edges) ? [...graph.edges] : [],
    };
    for (const node of g.nodes || []) {
      if (node.type !== "condition") continue;
      const outs = g.edges
        .map((e, i) => ({ ...e, _i: i }))
        .filter((e) => e.from === node.id);
      let assignedTrue = outs.some((o) => String(o.when) === "true");
      let assignedFalse = outs.some((o) => String(o.when) === "false");
      for (const o of outs) {
        if (o.when == null || String(o.when) === "") {
          if (!assignedTrue) {
            g.edges[o._i] = { ...g.edges[o._i], when: "true" };
            assignedTrue = true;
          } else if (!assignedFalse) {
            g.edges[o._i] = { ...g.edges[o._i], when: "false" };
            assignedFalse = true;
          } else {
            // leave blank for additional edges
          }
        }
      }
    }
    return g;
  }

  function addCanvasNode(type: NodeType, position?: CanvasPoint) {
    syncGraphDraft((graph) => {
      const nextIndex = graph.nodes.length + 1;
      const nodeId = `${type}-${nextIndex}-${Math.random().toString(36).slice(2, 6)}`;
      const nextNode: GraphNode = {
        id: nodeId,
        type,
        config: JSON.parse(JSON.stringify(nodeCatalog[type].defaultConfig)),
        position:
          position ??
          ({
            x: 96 + (graph.nodes.length % 3) * 220,
            y: 96 + Math.floor(graph.nodes.length / 3) * 160,
          } as CanvasPoint),
      };

      return {
        ...graph,
        entry_node_id: graph.entry_node_id || nextNode.id,
        nodes: [...graph.nodes, nextNode],
      };
    });
  }

  function connectCanvasNodes(from: string, to: string) {
    if (!from || !to || from === to) return;
    syncGraphDraft((graph) => {
      const hasEdge = graph.edges.some(
        (edge) => edge.from === from && edge.to === to,
      );
      if (hasEdge) return graph;

      // If the source node is a condition, try to set a sensible default
      // `when` value: first new outgoing gets "true", second gets "false".
      const srcNode = graph.nodes.find((n) => n.id === from);
      let when: string | undefined = undefined;
      if (srcNode && srcNode.type === "condition") {
        const outs = graph.edges.filter((e) => e.from === from);
        const hasTrue = outs.some((e) => String(e.when) === "true");
        const hasFalse = outs.some((e) => String(e.when) === "false");
        if (!hasTrue) when = "true";
        else if (!hasFalse) when = "false";
        else when = "";
      }

      const edge: any = { from, to };
      if (when !== undefined) edge.when = when;

      return {
        ...graph,
        edges: [...graph.edges, edge],
      };
    });
    setPendingEdgeSourceId("");
  }

  function moveCanvasNode(nodeId: string, position: CanvasPoint) {
    syncGraphDraft((graph) => ({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, position } : node,
      ),
    }));
  }

  function removeCanvasNode(nodeId: string) {
    syncGraphDraft((graph) => {
      const nextNodes = graph.nodes.filter((node) => node.id !== nodeId);
      return {
        ...graph,
        entry_node_id:
          graph.entry_node_id === nodeId
            ? (nextNodes[0]?.id ?? "")
            : graph.entry_node_id,
        nodes: nextNodes,
        edges: graph.edges.filter(
          (edge) => edge.from !== nodeId && edge.to !== nodeId,
        ),
      };
    });

    if (selectedNodeId === nodeId) {
      setSelectedNodeId("");
    }
    if (pendingEdgeSourceId === nodeId) {
      setPendingEdgeSourceId("");
    }
  }

  function updateSelectedNodeConfig(patch: Record<string, unknown>) {
    if (!selectedGraphNode) return;

    syncGraphDraft((graph) => ({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === selectedGraphNode.id
          ? { ...node, config: { ...node.config, ...patch } }
          : node,
      ),
    }));
  }

  function createCanvasNodeFromDrop(
    type: NodeType,
    event: DragEvent<HTMLDivElement>,
  ) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    addCanvasNode(type, {
      x: Math.max(12, event.clientX - rect.left - 110),
      y: Math.max(12, event.clientY - rect.top - 58),
    });
  }

  useEffect(() => {
    if (!graphNodes.length) {
      setSelectedNodeId("");
      return;
    }

    if (
      !selectedNodeId ||
      !graphNodes.some((node) => node.id === selectedNodeId)
    ) {
      setSelectedNodeId(graphDraft?.entry_node_id || graphNodes[0].id);
    }
  }, [graphDraft?.entry_node_id, graphNodes, selectedNodeId]);

  useEffect(() => {
    if (!canvasDragging) return;

    const handleMove = (event: PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      moveCanvasNode(canvasDragging.nodeId, {
        x: Math.max(12, event.clientX - rect.left - canvasDragging.offsetX),
        y: Math.max(12, event.clientY - rect.top - canvasDragging.offsetY),
      });
    };

    const handleUp = () => setCanvasDragging(null);

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [canvasDragging]);

  if (!isReady || !me) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="hero-copy">
            <div className="eyebrow">Flow builder</div>
            <h1>
              {authMode === "register"
                ? "Sign up, build workflows, publish, run."
                : "Sign in to your workspace."}
            </h1>
            <p>
              {authMode === "register"
                ? "Create a workspace, sign in, and move directly into the workflow playground."
                : "Enter your credentials to access your workspace."}
            </p>
          </div>

          <div className="auth-card auth-card-compact">
            <div className="auth-helper">
              {authMode === "login" ? (
                <>
                  <span>Not registered yet?</span>
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => navigate({ kind: "signup" })}
                  >
                    Sign up
                  </button>
                </>
              ) : (
                <>
                  <span>Already have an account?</span>
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => navigate({ kind: "login" })}
                  >
                    Sign in
                  </button>
                </>
              )}
            </div>
            <div className="form-grid">
              <label>
                <span>Tenant slug</span>
                <input
                  value={tenantSlug}
                  onChange={(e) => setTenantSlug(e.target.value)}
                />
              </label>
              {authMode === "register" ? (
                <label>
                  <span>Tenant name</span>
                  <input
                    value={tenantName}
                    onChange={(e) => setTenantName(e.target.value)}
                  />
                </label>
              ) : null}
              {authMode === "register" ? (
                <label>
                  <span>Your name</span>
                  <input
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                  />
                </label>
              ) : null}
              <label>
                <span>Email</span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>

            <div className="button-row">
              <button
                type="button"
                className="button button-primary"
                onClick={() => void bootstrapAccess()}
                disabled={authLoading}
              >
                {authLoading
                  ? authMode === "register"
                    ? "Signing up..."
                    : "Signing in..."
                  : authMode === "register"
                    ? "Sign up"
                    : "Sign in"}
              </button>
            </div>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="workspace-shell">
      <header className="workspace-header compact-header">
        <div>
          <div className="eyebrow">FLOW</div>
          {/* <h1>
            {activeView === "overview"
              ? "Overview"
              : activeView === "workflows"
                ? "Workflows"
                : activeView === "builder"
                  ? "Builder"
                  : activeView === "runs"
                    ? "Runs"
                    : activeView === "dlq"
                      ? "DLQ"
                      : activeView === "profile"
                        ? "Profile"
                        : "Settings"}
          </h1>
          <p>
            {activeView === "overview"
              ? "One home for your current workspace, with the rest split into dedicated screens."
              : activeView === "builder"
                ? "Build and publish workflow drafts with a focused canvas screen."
                : activeView === "profile"
                  ? "Your signed-in identity and tenant context."
                  : "A focused screen for the current task."}
          </p> */}
        </div>
        {/* <div
          className="hero-card-grid compact-cards"
          style={{
            display: "flex",
            gap: "16px",
            width: "300px",
          }}
        >
          <div className="summary-card">
            <span>Identity</span>
            <strong>{me.name}</strong>
            <p>{me.role}</p>
          </div>
          <div className="summary-card">
            <span>Workspace</span>
            <strong>{tenantLabel || tenantId.slice(0, 8)}</strong>
            <p>{tenantId}</p>
          </div>
        </div> */}
      </header>

      <section className="workspace-revamp">
        <aside className={panelClassName("workspace-sidebar")}>
          <div className="workspace-user">
            <strong>{me.name}</strong>
            <small>{me.email}</small>
            <small>
              {tenantLabel || tenantId.slice(0, 8)} · {me.role}
            </small>
          </div>

          <nav className="workspace-nav-tabs">
            {(
              [
                ["overview", "Overview"],
                ["workflows", "Workflows"],
                ["builder", "Builder"],
                ["runs", "Runs"],
                ["dlq", "DLQ"],
                ["profile", "Profile"],
                ["settings", "Settings"],
              ] as Array<[WorkspaceView, string]>
            ).map(([view, label]) => (
              <button
                key={view}
                type="button"
                className={`workspace-nav-tab ${activeView === view ? "active" : ""}`}
                onClick={() => navigate({ kind: "workspace", view })}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="workspace-sidebar-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void refreshWorkspace()}
            >
              Sync now
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={resetSession}
            >
              Sign out
            </button>
          </div>
        </aside>

        <section className="workspace-stage">
          {error ? <div className="error-banner">{error}</div> : null}

          {activeView === "overview" ? (
            <section className="stack">
              <section className="status-strip">
                <article className="status-card">
                  <span>Workflows</span>
                  <strong>{stats.workflows}</strong>
                  <small>Draft-first definitions</small>
                </article>
                <article className="status-card">
                  <span>Runs</span>
                  <strong>{stats.runs}</strong>
                  <small>
                    {stats.activeRuns} running, {stats.pausedRuns} paused
                  </small>
                </article>
                <article className="status-card">
                  <span>Failures</span>
                  <strong>{stats.failedRuns}</strong>
                  <small>Terminal workflow runs</small>
                </article>
                <article className="status-card">
                  <span>DLQ</span>
                  <strong>{stats.dlq}</strong>
                  <small>
                    {canResolveDlq ? "Owner triage enabled" : "Owner only"}
                  </small>
                </article>
              </section>

              <article className={panelClassName()}>
                <div className="panel-head">
                  <div>
                    <h2>Quick actions</h2>
                    <p>Start from workflows, then move into the builder.</p>
                  </div>
                </div>
                <div
                  className="button-row"
                  style={{
                    marginTop: "18px",
                  }}
                >
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() =>
                      navigate({ kind: "workspace", view: "workflows" })
                    }
                  >
                    Open workflows
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      navigate({ kind: "workspace", view: "builder" })
                    }
                  >
                    Open builder
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      navigate({ kind: "workspace", view: "runs" })
                    }
                  >
                    Open runs
                  </button>
                </div>
              </article>
            </section>
          ) : null}

          {activeView === "workflows" ? (
            <section className="single-column">
              <article className={panelClassName()}>
                <div className="panel-head">
                  <div>
                    <h2>Workflows</h2>
                    <p>
                      Create a workflow, then select one to open the builder.
                    </p>
                  </div>
                </div>
              </article>

              <article className={panelClassName("workflows-create-card")}>
                <div className="panel-head compact">
                  <div>
                    <h3>New workflow</h3>
                    <p>Enter a name and create a draft workflow.</p>
                  </div>
                </div>

                <div className="workflow-create-form">
                  <input
                    value={newWorkflowName}
                    onChange={(e) => setNewWorkflowName(e.target.value)}
                    placeholder="New workflow name"
                    disabled={!canEdit}
                  />
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => void createWorkflow()}
                    disabled={!canEdit || loading}
                  >
                    Create workflow
                  </button>
                </div>
              </article>

              <article className={panelClassName("workflows-list-card")}>
                <div className="panel-head compact">
                  <div>
                    <h3>Workflow list</h3>
                    <p>Pick one workflow to continue in Builder.</p>
                  </div>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void refreshWorkspace()}
                  >
                    Refresh list
                  </button>
                </div>

                <div
                  className="list-stack workflows-list-stack"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "14px",
                    padding: "8px 4px",
                  }}
                >
                  {workflows.map((workflow) => {
                    const isSelected = selectedWorkflowId === workflow.id;

                    return (
                      <button
                        key={workflow.id}
                        type="button"
                        className={`list-card workflow-list-card ${isSelected ? "list-card-selected" : ""}`}
                        onClick={() => {
                          setSelectedWorkflowId(workflow.id);
                          navigate({ kind: "workspace", view: "builder" });
                        }}
                      >
                        <div className="workflow-card-main">
                          <strong className="workflow-card-title">
                            {workflow.name}
                          </strong>

                          <span className="workflow-card-subtitle">
                            {workflow.id}
                          </span>
                        </div>

                        <div className="workflow-card-meta">
                          <small className="workflow-card-label">
                            Draft Updated
                          </small>

                          <strong className="workflow-card-date">
                            {formatDate(workflow.draft_updated_at)}
                          </strong>
                        </div>
                      </button>
                    );
                  })}

                  {!workflows.length ? (
                    <div className="workflow-empty-state empty-state">
                      No workflows yet. Create one above to start building.
                    </div>
                  ) : null}
                </div>
              </article>
            </section>
          ) : null}

          {activeView === "builder" ? (
            <section className="single-column">
              <article className={panelClassName("panel-wide")}>
                <div className="panel-head">
                  <div>
                    <h2>Builder</h2>
                    <p>
                      Edit draft graphs, publish versions, and run selected
                      versions.
                    </p>
                  </div>
                  <div className="button-row compact">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() =>
                        void loadWorkflowBundle(selectedWorkflowId)
                      }
                      disabled={!selectedWorkflowId}
                    >
                      Reload
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={applyStarterGraph}
                      disabled={!canEdit}
                    >
                      Load template
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void saveWorkflow()}
                      disabled={!canEdit || !workflowDetail || loading}
                    >
                      Save draft
                    </button>
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => void publishWorkflow()}
                      disabled={!canEdit || !workflowDetail || loading}
                    >
                      Publish
                    </button>
                  </div>
                </div>

                {workflowDetail ? (
                  <div className="workflow-layout">
                    <div className="form-grid">
                      <label>
                        <span>Name</span>
                        <input
                          value={workflowNameInput}
                          onChange={(e) => setWorkflowNameInput(e.target.value)}
                          disabled={!canEdit}
                        />
                      </label>
                      <div
                        className="hint-row"
                        style={{
                          marginTop: "10px",
                        }}
                      >
                        <span>
                          Draft updated{" "}
                          {formatDate(workflowDetail.draft_updated_at)}
                        </span>
                        <span>
                          Created {formatDate(workflowDetail.created_at)}
                        </span>
                      </div>
                    </div>

                    <div className="summary-strip">
                      <div>
                        <span>Trigger</span>
                        <strong>
                          {triggerSummary.enabled ? "enabled" : "disabled"}
                        </strong>
                      </div>
                      <div>
                        <span>Webhook secret</span>
                        <strong>{triggerSummary.webhook}</strong>
                      </div>
                      <div>
                        <span>Schedule</span>
                        <strong>{triggerSummary.schedule}</strong>
                      </div>
                    </div>

                    <section className="canvas-workspace">
                      <div className="canvas-toolbar">
                        <div>
                          <h3>Workflow canvas</h3>
                          <p>
                            Drag nodes from the palette, move them on the board,
                            and wire connectors.
                          </p>
                        </div>
                        {pendingEdgeSourceId ? (
                          <div className="canvas-hint">
                            Connecting from{" "}
                            <strong>{pendingEdgeSourceId}</strong>
                          </div>
                        ) : null}
                      </div>

                      <div
                        className="canvas-layout"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "12px",
                        }}
                      >
                        <aside
                          className="node-palette"
                          style={{
                            display: "flex",
                            flexDirection: "row",
                            gap: "12px",
                          }}
                        >
                          {Object.entries(nodeCatalog).map(([type, meta]) => (
                            <button
                              key={type}
                              type="button"
                              className="palette-card"
                              draggable={canEdit}
                              onDragStart={(event) => {
                                event.dataTransfer.setData(
                                  "application/x-flow-node-type",
                                  type,
                                );
                                event.dataTransfer.effectAllowed = "copy";
                              }}
                              onClick={() =>
                                canEdit && addCanvasNode(type as NodeType)
                              }
                              disabled={!canEdit}
                            >
                              <strong>{meta.title}</strong>
                              <small>{meta.description}</small>
                              <span>{type}</span>
                            </button>
                          ))}
                        </aside>

                        <div
                          style={{
                            display: "flex",
                            width: "100%",
                          }}
                        >
                          <div
                            // take max space, but allow inspector to shrink if needed
                            style={{
                              width: "100%",
                            }}
                            ref={canvasRef}
                            className="canvas-board"
                            onWheel={(e) => {
                              // zoom with ctrl/cmd + wheel
                              if (!(e.ctrlKey || e.metaKey)) return;
                              e.preventDefault();
                              const rect =
                                canvasRef.current?.getBoundingClientRect();
                              if (!rect) return;
                              const mouseX = e.clientX - rect.left;
                              const mouseY = e.clientY - rect.top;
                              const scaleFactor = 1 - e.deltaY * 0.0012;
                              const next = Math.max(
                                0.4,
                                Math.min(2.2, canvasScale * scaleFactor),
                              );

                              // adjust offset so zoom focuses on cursor
                              const offsetX =
                                mouseX -
                                (mouseX - canvasOffset.x) *
                                  (next / canvasScale);
                              const offsetY =
                                mouseY -
                                (mouseY - canvasOffset.y) *
                                  (next / canvasScale);
                              setCanvasScale(next);
                              setCanvasOffset({ x: offsetX, y: offsetY });
                            }}
                            onPointerDown={(e) => {
                              // middle mouse or space+left-drag (space handling not implemented here)
                              if (e.button === 1) {
                                panState.current = {
                                  active: true,
                                  startX: e.clientX,
                                  startY: e.clientY,
                                };
                                (e.target as Element).setPointerCapture(
                                  e.pointerId,
                                );
                              }
                            }}
                            onPointerMove={(e) => {
                              if (!panState.current?.active) return;
                              const dx = e.clientX - panState.current.startX;
                              const dy = e.clientY - panState.current.startY;
                              panState.current.startX = e.clientX;
                              panState.current.startY = e.clientY;
                              setCanvasOffset((o) => ({
                                x: o.x + dx,
                                y: o.y + dy,
                              }));
                            }}
                            onPointerUp={(e) => {
                              if (panState.current?.active) {
                                panState.current = null;
                                try {
                                  (e.target as Element).releasePointerCapture(
                                    e.pointerId,
                                  );
                                } catch {}
                              }
                            }}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                              event.preventDefault();
                              if (!canEdit) return;
                              const nodeType = event.dataTransfer.getData(
                                "application/x-flow-node-type",
                              ) as NodeType;
                              if (nodeType) {
                                createCanvasNodeFromDrop(nodeType, event);
                              }
                            }}
                          >
                            <div
                              className="canvas-transform"
                              style={{
                                transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${canvasScale})`,
                                transformOrigin: "0 0",
                              }}
                            >
                              <svg className="canvas-edges" aria-hidden="true">
                                {graphEdges.map((edge) => {
                                  const fromNode = graphNodes.find(
                                    (node) => node.id === edge.from,
                                  );
                                  const toNode = graphNodes.find(
                                    (node) => node.id === edge.to,
                                  );
                                  if (!fromNode?.position || !toNode?.position)
                                    return null;

                                  const startX = fromNode.position.x + 216;
                                  const startY = fromNode.position.y + 56;
                                  const endX = toNode.position.x;
                                  const endY = toNode.position.y + 56;
                                  const curve = `M ${startX} ${startY} C ${startX + 72} ${startY}, ${endX - 72} ${endY}, ${endX} ${endY}`;

                                  return (
                                    <path
                                      key={`${edge.from}-${edge.to}`}
                                      d={curve}
                                      className="canvas-edge"
                                    />
                                  );
                                })}
                              </svg>
                              {graphNodes.map((node) => {
                                const isSelected = selectedNodeId === node.id;
                                const isSource =
                                  pendingEdgeSourceId === node.id;
                                const accent = nodeAccent(node.type);

                                return (
                                  <article
                                    key={node.id}
                                    className={`canvas-node ${isSelected ? "selected" : ""} ${isSource ? "source" : ""}`}
                                    style={{
                                      left: node.position?.x ?? 0,
                                      top: node.position?.y ?? 0,
                                      borderColor: accent,
                                    }}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => setSelectedNodeId(node.id)}
                                    onPointerDown={(event) => {
                                      if (!canEdit) return;
                                      const rect =
                                        canvasRef.current?.getBoundingClientRect();
                                      if (!rect) return;
                                      setCanvasDragging({
                                        nodeId: node.id,
                                        offsetX:
                                          event.clientX -
                                          rect.left -
                                          (node.position?.x ?? 0),
                                        offsetY:
                                          event.clientY -
                                          rect.top -
                                          (node.position?.y ?? 0),
                                      });
                                      setSelectedNodeId(node.id);
                                    }}
                                  >
                                    <div className="canvas-node-head">
                                      <strong>
                                        {nodeCatalog[node.type].title}
                                      </strong>
                                      <span>{node.id}</span>
                                    </div>
                                    <p>{nodeSubtitle(node.type)}</p>
                                    <pre>{prettyJson(node.config)}</pre>
                                    <div className="canvas-node-actions">
                                      <button
                                        type="button"
                                        className="node-port input-port"
                                        onPointerDown={(event) =>
                                          event.stopPropagation()
                                        }
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          if (
                                            pendingEdgeSourceId &&
                                            pendingEdgeSourceId !== node.id
                                          ) {
                                            connectCanvasNodes(
                                              pendingEdgeSourceId,
                                              node.id,
                                            );
                                          } else {
                                            setPendingEdgeSourceId(node.id);
                                          }
                                        }}
                                      >
                                        In
                                      </button>
                                      <button
                                        type="button"
                                        className="node-port output-port"
                                        onPointerDown={(event) =>
                                          event.stopPropagation()
                                        }
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setPendingEdgeSourceId(node.id);
                                        }}
                                      >
                                        Out
                                      </button>
                                      <button
                                        type="button"
                                        className="node-port ghost-port"
                                        onPointerDown={(event) =>
                                          event.stopPropagation()
                                        }
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          removeCanvasNode(node.id);
                                        }}
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </article>
                                );
                              })}

                              {!graphNodes.length ? (
                                <div className="canvas-empty-state">
                                  Drop a node from the palette to begin building
                                  the flow.
                                </div>
                              ) : null}
                            </div>
                          </div>

                          <aside className="node-inspector">
                            <div className="subpanel-head compact">
                              <div>
                                <h3>Inspector</h3>
                                <p>
                                  {selectedGraphNode
                                    ? selectedGraphNode.id
                                    : "Select a node to edit its config."}
                                </p>
                              </div>
                            </div>

                            {selectedGraphNode ? (
                              <div className="node-editor">
                                <div className="summary-card compact">
                                  <span>Type</span>
                                  <strong>
                                    {nodeCatalog[selectedGraphNode.type].title}
                                  </strong>
                                  <p>{nodeSubtitle(selectedGraphNode.type)}</p>
                                </div>

                                {selectedGraphNode.type === "delay" ? (
                                  <label>
                                    <span>Seconds</span>
                                    <input
                                      type="number"
                                      value={String(
                                        selectedGraphNode.config.seconds ?? 30,
                                      )}
                                      onChange={(event) =>
                                        updateSelectedNodeConfig({
                                          seconds: Number(event.target.value),
                                        })
                                      }
                                      disabled={!canEdit}
                                    />
                                  </label>
                                ) : null}

                                {selectedGraphNode.type === "http_request" ? (
                                  <>
                                    <label>
                                      <span>Method</span>
                                      <input
                                        value={String(
                                          selectedGraphNode.config.method ??
                                            "GET",
                                        )}
                                        onChange={(event) =>
                                          updateSelectedNodeConfig({
                                            method: event.target.value,
                                          })
                                        }
                                        disabled={!canEdit}
                                      />
                                    </label>
                                    <label>
                                      <span>URL</span>
                                      <input
                                        value={String(
                                          selectedGraphNode.config.url ?? "",
                                        )}
                                        onChange={(event) =>
                                          updateSelectedNodeConfig({
                                            url: event.target.value,
                                          })
                                        }
                                        disabled={!canEdit}
                                      />
                                    </label>
                                  </>
                                ) : null}

                                {selectedGraphNode.type === "condition" ? (
                                  <>
                                    <label>
                                      <span>Base</span>
                                      <input
                                        value={String(
                                          selectedGraphNode.config.base ??
                                            "context",
                                        )}
                                        onChange={(event) =>
                                          updateSelectedNodeConfig({
                                            base: event.target.value,
                                          })
                                        }
                                        disabled={!canEdit}
                                      />
                                    </label>
                                    <label>
                                      <span>Path</span>
                                      <input
                                        value={String(
                                          selectedGraphNode.config.path ?? "",
                                        )}
                                        onChange={(event) =>
                                          updateSelectedNodeConfig({
                                            path: event.target.value,
                                          })
                                        }
                                        disabled={!canEdit}
                                      />
                                    </label>
                                    <label>
                                      <span>Operator</span>
                                      <input
                                        value={String(
                                          selectedGraphNode.config.op ?? "eq",
                                        )}
                                        onChange={(event) =>
                                          updateSelectedNodeConfig({
                                            op: event.target.value,
                                          })
                                        }
                                        disabled={!canEdit}
                                      />
                                    </label>
                                    <label>
                                      <span>Value</span>
                                      <input
                                        value={String(
                                          selectedGraphNode.config.value ?? "",
                                        )}
                                        onChange={(event) =>
                                          updateSelectedNodeConfig({
                                            value: event.target.value,
                                          })
                                        }
                                        disabled={!canEdit}
                                      />
                                    </label>
                                    {/* Outgoing edges / branching for condition nodes */}
                                    <div style={{ marginTop: 12 }}>
                                      <h4 style={{ margin: "6px 0" }}>
                                        Branches
                                      </h4>
                                      {(graphEdges || [])
                                        .filter(
                                          (e) =>
                                            e.from === selectedGraphNode.id,
                                        )
                                        .map((e, idx) => {
                                          const target = graphNodes.find(
                                            (n) => n.id === e.to,
                                          );
                                          return (
                                            <div
                                              key={`${e.from}-${e.to}-${idx}`}
                                              style={{
                                                display: "flex",
                                                gap: 8,
                                                alignItems: "center",
                                                marginBottom: 6,
                                              }}
                                            >
                                              <div style={{ flex: 1 }}>
                                                <small
                                                  style={{ color: "#666" }}
                                                >
                                                  to
                                                </small>
                                                <div>
                                                  {target
                                                    ? `${target.id} (${nodeCatalog[target.type].title})`
                                                    : e.to}
                                                </div>
                                              </div>
                                              <div style={{ width: 160 }}>
                                                <label
                                                  style={{
                                                    display: "block",
                                                    fontSize: 12,
                                                    color: "#666",
                                                    marginBottom: 4,
                                                  }}
                                                  title='When must be the string "true" or "false" (no quotes in dropdown)'
                                                >
                                                  when
                                                </label>
                                                <select
                                                  value={String(e.when ?? "")}
                                                  onChange={(ev) => {
                                                    const whenVal =
                                                      ev.target.value;
                                                    syncGraphDraft((graph) => {
                                                      let occ = 0;
                                                      return {
                                                        ...graph,
                                                        edges: graph.edges.map(
                                                          (edge) => {
                                                            if (
                                                              edge.from ===
                                                                e.from &&
                                                              edge.to === e.to
                                                            ) {
                                                              if (occ === idx) {
                                                                occ++;
                                                                return whenVal ===
                                                                  ""
                                                                  ? {
                                                                      ...edge,
                                                                      when: undefined,
                                                                    }
                                                                  : {
                                                                      ...edge,
                                                                      when: whenVal,
                                                                    };
                                                              }
                                                              occ++;
                                                              return edge;
                                                            }
                                                            return edge;
                                                          },
                                                        ),
                                                      };
                                                    });
                                                  }}
                                                  disabled={!canEdit}
                                                  title='Select branch outcome: "true" or "false". Leave blank for default.'
                                                >
                                                  <option value="">
                                                    (default)
                                                  </option>
                                                  <option value="true">
                                                    true
                                                  </option>
                                                  <option value="false">
                                                    false
                                                  </option>
                                                </select>
                                                <div
                                                  style={{
                                                    fontSize: 11,
                                                    color: "#888",
                                                    marginTop: 6,
                                                  }}
                                                  title="Edges use string outcomes: engine matches edge.when === node_runs.outcome"
                                                >
                                                  Use "true"/"false" to route
                                                  condition outcomes
                                                </div>
                                              </div>
                                              <button
                                                onClick={() => {
                                                  syncGraphDraft((graph) => {
                                                    let occ = 0;
                                                    return {
                                                      ...graph,
                                                      edges: graph.edges.filter(
                                                        (edge) => {
                                                          if (
                                                            edge.from ===
                                                              e.from &&
                                                            edge.to === e.to
                                                          ) {
                                                            if (occ === idx) {
                                                              occ++;
                                                              return false; // remove this occurrence
                                                            }
                                                            occ++;
                                                            return true; // keep other occurrences
                                                          }
                                                          return true;
                                                        },
                                                      ),
                                                    };
                                                  });
                                                }}
                                                disabled={!canEdit}
                                              >
                                                Remove
                                              </button>
                                            </div>
                                          );
                                        })}
                                    </div>
                                  </>
                                ) : null}

                                {selectedGraphNode.type === "notify" ? (
                                  <>
                                    <label>
                                      <span>Provider</span>
                                      <input
                                        value={String(
                                          selectedGraphNode.config.provider ??
                                            "email",
                                        )}
                                        onChange={(event) =>
                                          updateSelectedNodeConfig({
                                            provider: event.target.value,
                                          })
                                        }
                                        disabled={!canEdit}
                                      />
                                    </label>
                                    <label>
                                      <span>To</span>
                                      <input
                                        value={String(
                                          selectedGraphNode.config.to ?? "",
                                        )}
                                        onChange={(event) =>
                                          updateSelectedNodeConfig({
                                            to: event.target.value,
                                          })
                                        }
                                        disabled={!canEdit}
                                      />
                                    </label>
                                    <label>
                                      <span>Subject</span>
                                      <input
                                        value={String(
                                          selectedGraphNode.config.subject ??
                                            "",
                                        )}
                                        onChange={(event) =>
                                          updateSelectedNodeConfig({
                                            subject: event.target.value,
                                          })
                                        }
                                        disabled={!canEdit}
                                      />
                                    </label>
                                  </>
                                ) : null}

                                <div className="button-row compact">
                                  <button
                                    type="button"
                                    className="button button-secondary"
                                    onClick={() =>
                                      setSelectedNodeId(
                                        graphDraft?.entry_node_id ??
                                          graphNodes[0]?.id ??
                                          "",
                                      )
                                    }
                                    disabled={!graphNodes.length}
                                  >
                                    Focus entry
                                  </button>
                                  <button
                                    type="button"
                                    className="button button-secondary"
                                    onClick={() =>
                                      setPendingEdgeSourceId(
                                        selectedGraphNode.id,
                                      )
                                    }
                                  >
                                    Start edge
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="empty-state">
                                Add or select a node to edit its settings.
                              </div>
                            )}
                          </aside>
                        </div>
                      </div>

                      <details className="advanced-card">
                        <summary>JSON source</summary>
                        <div className="details-gap">
                          <label className="editor-block">
                            <span>Draft graph JSON</span>
                            <textarea
                              value={draftGraphInput}
                              onChange={(e) => {
                                setDraftGraphInput(e.target.value);
                                setDraftError(null);
                              }}
                              disabled={!canEdit}
                            />
                          </label>
                        </div>
                      </details>
                    </section>

                    {draftError ? (
                      <div className="error-banner">{draftError}</div>
                    ) : null}

                    <div className="subpanel-head">
                      <div>
                        <h3>Published versions</h3>
                        <p>
                          Runs can be created from any published version below.
                        </p>
                      </div>
                    </div>

                    <div className="list-stack runs-version-stack">
                      {workflowVersions.map((version) => {
                        const isSelected = selectedVersionId === version.id;

                        return (
                          <button
                            key={version.id}
                            type="button"
                            className={`version-card run-version-card ${
                              isSelected ? "list-card-selected" : ""
                            }`}
                            onClick={() => setSelectedVersionId(version.id)}
                          >
                            <div className="card-row run-version-top">
                              <div className="run-version-title-group">
                                <strong className="run-version-title">
                                  Version {version.version}
                                </strong>

                                <span className="run-version-subtitle">
                                  {version.id.slice(0, 8)}
                                </span>
                              </div>

                              <div className="run-version-pill">Published</div>
                            </div>

                            <div className="run-version-meta-grid">
                              <div className="run-meta-card">
                                <span>Published</span>
                                <strong>
                                  {formatDate(version.published_at)}
                                </strong>
                              </div>
                              <div className="run-meta-card">
                                <span>Created</span>
                                <strong>
                                  {formatDate(version.created_at)}
                                </strong>
                              </div>
                            </div>
                          </button>
                        );
                      })}

                      {!workflowVersions.length ? (
                        <div className="run-empty-state empty-state">
                          Publish this workflow to create a version.
                        </div>
                      ) : null}
                    </div>

                    <div className="button-row compact">
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={() => void runPublishedVersion()}
                        disabled={!canEdit || !selectedVersionId || loading}
                      >
                        Run selected version
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="empty-state">
                    Select a workflow to inspect its draft and versions.
                  </div>
                )}
              </article>
            </section>
          ) : null}

          {activeView === "runs" ? (
            <section className="details-grid runs-layout">
              <article className={panelClassName()}>
                <div className="panel-head">
                  <div>
                    <h2>Runs</h2>
                    <p>
                      Inspect execution timeline and pick a run for full detail.
                    </p>
                  </div>
                </div>

                <div
                  className="list-stack runs-list-stack"
                  style={{
                    marginTop: "18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "16px",
                  }}
                >
                  {runs.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      className={`run-card run-list-card ${selectedRunId === run.id ? "list-card-selected" : ""}`}
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      <div className="run-list-main">
                        <div className="card-row run-list-top">
                          <div className="run-list-title-group">
                            <strong className="run-list-title">
                              Run {run.id.slice(0, 8)}
                            </strong>
                            <span className="run-list-subtitle">
                              {(run.workflow_version_id ?? "").slice(0, 8)}
                            </span>
                          </div>
                          <span className={statusTone(run.status)}>
                            {run.status}
                          </span>
                        </div>

                        <div className="run-list-meta-grid">
                          <div className="run-meta-card">
                            <span>Started</span>
                            <strong>
                              {formatDate(run.started_at ?? run.created_at)}
                            </strong>
                          </div>
                          <div className="run-meta-card">
                            <span>Finished</span>
                            <strong>{formatDate(run.finished_at)}</strong>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                  {!runs.length ? (
                    <div className="run-empty-state empty-state">
                      No runs yet. Start a workflow to see execution history
                      here.
                    </div>
                  ) : null}
                </div>
              </article>

              <article
                className={panelClassName("panel-tall")}
                style={{ marginTop: "18px" }}
              >
                <div className="panel-head">
                  <div>
                    <h2>Run detail</h2>
                    <p>Node timeline and logs for the selected execution.</p>
                  </div>
                  <div className="button-row compact">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void loadRunBundle(selectedRunId)}
                      disabled={!selectedRunId}
                    >
                      Reload
                    </button>
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => void performRunAction("start")}
                      disabled={!selectedRunId || runActionLoading !== null}
                    >
                      Start
                    </button>
                  </div>
                </div>

                {runDetail ? (
                  <div
                    className="run-detail-shell"
                    style={{ marginTop: "12px" }}
                  >
                    <div className="run-detail-summary">
                      <div className="run-summary-card">
                        <span>Status</span>
                        <strong>{runDetail.status}</strong>
                      </div>
                      <div className="run-summary-card">
                        <span>Started</span>
                        <strong>
                          {formatDate(
                            runDetail.started_at ?? runDetail.created_at,
                          )}
                        </strong>
                      </div>
                      <div className="run-summary-card">
                        <span>Finished</span>
                        <strong>{formatDate(runDetail.finished_at)}</strong>
                      </div>
                    </div>

                    <div className="run-detail-actions button-row compact">
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void performRunAction("pause")}
                        disabled={!selectedRunId || runActionLoading !== null}
                      >
                        {runActionLoading === "pause" ? "Pausing..." : "Pause"}
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void performRunAction("resume")}
                        disabled={!selectedRunId || runActionLoading !== null}
                      >
                        {runActionLoading === "resume"
                          ? "Resuming..."
                          : "Resume"}
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void performRunAction("cancel")}
                        disabled={!selectedRunId || runActionLoading !== null}
                      >
                        {runActionLoading === "cancel"
                          ? "Cancelling..."
                          : "Cancel"}
                      </button>
                    </div>

                    <div className="run-detail-section-head">
                      <div>
                        <h3>Node timeline</h3>
                        <p>Pick a node to inspect its structured logs.</p>
                      </div>
                      <div className="run-detail-hint">
                        {nodeRuns.length} node run
                        {nodeRuns.length === 1 ? "" : "s"}
                      </div>
                    </div>

                    <div
                      className="list-stack runs-timeline-stack"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "18px",
                      }}
                    >
                      {nodeRuns.map((nodeRun) => (
                        <button
                          key={nodeRun.id}
                          type="button"
                          className={`node-card run-node-card ${selectedNodeRunId === nodeRun.id ? "list-card-selected" : ""}`}
                          onClick={() => setSelectedNodeRunId(nodeRun.id)}
                        >
                          <div className="run-node-top">
                            <div className="run-node-title-group">
                              <strong className="run-node-title">
                                {nodeRun.node_id}
                              </strong>
                              <span className="run-node-subtitle">
                                {nodeRun.node_type}
                              </span>
                            </div>
                            <span
                              className={statusTone(String(nodeRun.status))}
                            >
                              {nodeRun.status}
                            </span>
                          </div>

                          <div className="run-node-meta-grid">
                            <div className="run-meta-card">
                              <span>Attempt</span>
                              <strong>
                                {nodeRun.attempt} / {nodeRun.max_attempts}
                              </strong>
                            </div>
                            <div className="run-meta-card">
                              <span>Queued</span>
                              <strong>{formatDate(nodeRun.queued_at)}</strong>
                            </div>
                            <div className="run-meta-card">
                              <span>Finished</span>
                              <strong>{formatDate(nodeRun.finished_at)}</strong>
                            </div>
                          </div>
                        </button>
                      ))}
                      {!nodeRuns.length ? (
                        <div className="run-empty-state empty-state">
                          This run has no node records yet.
                        </div>
                      ) : null}
                    </div>

                    <div className="run-detail-section-head">
                      <div>
                        <h3>Logs</h3>
                        <p>
                          {selectedNodeRun
                            ? selectedNodeRun.node_id
                            : "Select a node run"}
                        </p>
                      </div>
                      {selectedNodeRun ? (
                        <div className="run-detail-hint">
                          {selectedNodeRun.node_type} · attempt{" "}
                          {selectedNodeRun.attempt}
                        </div>
                      ) : null}
                    </div>

                    <div className="run-log-feed">
                      {nodeLogs.map((log) => (
                        <div key={log.id} className="log-card run-log-card">
                          <div className="run-log-top">
                            <div className="run-log-title-group">
                              <strong className="run-log-level">
                                {log.level}
                              </strong>
                              <span className="run-log-message">
                                {log.message}
                              </span>
                            </div>
                            <span className="run-log-ts">
                              {formatDate(log.ts)}
                            </span>
                          </div>

                          <pre>{prettyJson(log.data)}</pre>
                        </div>
                      ))}
                      {!nodeLogs.length ? (
                        <div className="run-empty-state empty-state">
                          No logs loaded for the selected node.
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="empty-state">
                    Select a run to inspect its node timeline.
                  </div>
                )}
              </article>
            </section>
          ) : null}

          {activeView === "dlq" ? (
            <section className="single-column">
              <article
                className={panelClassName(canResolveDlq ? "" : "panel-muted")}
              >
                <div className="panel-head">
                  <div>
                    <h2>DLQ</h2>
                    <p>Final failures waiting for owner triage.</p>
                  </div>
                </div>

                <div
                  className="list-stack"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "16px",
                    padding: "10px 6px",
                  }}
                >
                  {dlqItems.map((item) => (
                    <div
                      key={item.id}
                      className="dlq-card"
                      style={{
                        padding: "16px 18px",
                        borderRadius: "14px",
                        border: "1px solid rgba(255,255,255,0.06)",
                        background: "rgba(255,255,255,0.02)",
                        boxShadow: "0 8px 22px rgba(0,0,0,0.14)",
                      }}
                    >
                      <div
                        className="card-row"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "12px",
                        }}
                      >
                        <strong style={{ fontSize: "0.98rem" }}>
                          {item.name}
                        </strong>
                        <span
                          style={{ marginLeft: "12px" }}
                          className={statusTone(item.state)}
                        >
                          {item.state}
                        </span>
                      </div>

                      <small
                        style={{
                          display: "block",
                          marginTop: "8px",
                          color: "rgba(226,232,240,0.65)",
                          fontSize: "0.92rem",
                        }}
                      >
                        {item.data.reason ??
                          item.failedReason ??
                          "final_failure"}
                      </small>

                      <div
                        className="meta-row"
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: "12px",
                          marginTop: "10px",
                          color: "rgba(226,232,240,0.64)",
                          fontSize: "0.9rem",
                        }}
                      >
                        <span
                          style={{
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.data.node_type ?? "node"}
                        </span>
                        <span
                          style={{
                            fontFamily: "SFMono-Regular, Consolas, monospace",
                            opacity: 0.9,
                          }}
                        >
                          {item.data.node_run_id ?? item.id}
                        </span>
                      </div>

                      <div
                        className="button-row compact"
                        style={{
                          marginTop: "12px",
                          display: "flex",
                          gap: "10px",
                        }}
                      >
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => setError(prettyJson(item))}
                          style={{ padding: "8px 12px", minHeight: "36px" }}
                        >
                          View payload
                        </button>
                        {canResolveDlq ? (
                          <button
                            type="button"
                            className="button button-primary"
                            onClick={() => void resolveDlqItem(String(item.id))}
                            disabled={dlqActionLoading === String(item.id)}
                            style={{ padding: "8px 12px", minHeight: "36px" }}
                          >
                            {dlqActionLoading === String(item.id)
                              ? "Resolving..."
                              : "Resolve"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {!dlqItems.length ? (
                    <div
                      className="empty-state"
                      style={{
                        padding: "24px",
                        borderRadius: "14px",
                        border: "1px dashed rgba(255,255,255,0.06)",
                        background: "rgba(255,255,255,0.02)",
                        textAlign: "center",
                        color: "rgba(255,255,255,0.6)",
                      }}
                    >
                      No DLQ items at the moment.
                    </div>
                  ) : null}
                </div>
              </article>
            </section>
          ) : null}

          {activeView === "settings" ? (
            <section className="single-column">
              <article className={panelClassName()}>
                <div className="panel-head">
                  <div>
                    <h2>Session settings</h2>
                    <p>Manage your workspace session and sync behavior.</p>
                  </div>
                </div>

                <div
                  className="summary-grid compact"
                  style={{ marginTop: "18px" }}
                >
                  <div className="summary-card">
                    <span>API base</span>
                    <strong>{backendBaseUrl}</strong>
                    <p>Connected backend endpoint</p>
                  </div>
                  <div className="summary-card">
                    <span>Tenant</span>
                    <strong>{tenantLabel || tenantId.slice(0, 8)}</strong>
                    <p>{tenantId}</p>
                  </div>
                  <div className="summary-card">
                    <span>Role</span>
                    <strong>{me.role}</strong>
                    <p>{me.email}</p>
                  </div>
                </div>

                <div
                  className="button-row"
                  style={{
                    marginTop: "18px",
                  }}
                >
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void refreshWorkspace()}
                  >
                    Sync now
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={resetSession}
                  >
                    Clear session
                  </button>
                </div>
              </article>
            </section>
          ) : null}

          {activeView === "profile" ? (
            <section className="single-column">
              <article className={panelClassName()}>
                <div className="panel-head">
                  <div>
                    <h2>Profile</h2>
                    <p>Minimal signed-in identity and workspace context.</p>
                  </div>
                </div>

                <div
                  className="summary-grid compact"
                  style={{ marginTop: "18px" }}
                >
                  <div className="summary-card">
                    <span>Name</span>
                    <strong>{me.name}</strong>
                    <p>Signed-in user</p>
                  </div>
                  <div className="summary-card">
                    <span>Email</span>
                    <strong>{me.email}</strong>
                    <p>Login email</p>
                  </div>
                  <div className="summary-card">
                    <span>Role</span>
                    <strong>{me.role}</strong>
                    <p>{canEdit ? "Workflow editing enabled" : "Read only"}</p>
                  </div>
                  <div className="summary-card">
                    <span>Tenant</span>
                    <strong>{tenantLabel || tenantId.slice(0, 8)}</strong>
                    <p>{tenantId}</p>
                  </div>
                </div>
              </article>
            </section>
          ) : null}
        </section>
      </section>

      <div className="toast-stack" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>

      {panelLoading || loading ? (
        <div className="floating-status">Syncing workspace...</div>
      ) : lastSyncedAt ? (
        <div className="floating-status">
          Last synced {formatDate(lastSyncedAt)}
        </div>
      ) : null}
    </main>
  );
}

export default App;
