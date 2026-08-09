import { useEffect, useMemo, useRef, useState } from "react";

import type { ConfigurableProviderId, EvidenceView, GraphView, ImportedRepositoryFile, ProductAnalysisDepth, ProductChangeSetSource, ProductDecisionView, ProductIntent, ProductReviewView, ProductRunJobView, ProductRunView, ProjectView, ProviderModelProfileView, ProviderModelsView, ProviderRole, ProviderRoleAssignmentView, ProviderSetView, ProviderSettingsView, RuntimeModeView, SaveProviderSettingsInput } from "../../src/web/contracts.js";
import { isSensitiveRepositoryPath } from "../../src/security/sensitive-repository-path.js";
import { api } from "./api.js";

const DEFAULT_ASK = "Where is bootstrapSession called?";
const DEFAULT_INVESTIGATE = "Why might authentication disappear after refresh?";
const DEFAULT_TASK = "Fix authentication disappearing after refresh.";
const PROVIDER_ROLES: readonly ProviderRole[] = ["investigator", "skeptic", "architect", "verifier", "judge", "planner", "implementer", "reviewer"];
const IGNORED_IMPORT_SEGMENTS = new Set([".git", ".conclave", "node_modules", "dist", "build", ".next", "coverage"]);
const DEPTH_COPY: Readonly<Record<ProductAnalysisDepth, { readonly title: string; readonly detail: string }>> = {
  auto: { title: "Auto", detail: "Chooses the smallest useful reasoning workflow." },
  fast: { title: "Fast", detail: "Prioritizes static evidence and minimal model calls." },
  balanced: { title: "Balanced", detail: "Uses additional reasoning when evidence needs it." },
  deep: { title: "Deep", detail: "Adds adversarial review and may take significantly longer." },
};

type WorkspaceTab = "verdict" | "evidence" | "graph" | "retrieval" | "task" | "review" | "decide" | "settings";
type Permissions = { allowFileEdits: boolean; allowCommands: boolean; allowRepositoryScripts: boolean; allowNetwork: boolean };
type IconName = "ask" | "chevron" | "code" | "evidence" | "folder" | "graph" | "info" | "investigate" | "repo" | "retrieval" | "settings" | "spark" | "task" | "verdict" | "x";

const INTENT_COPY: Record<ProductIntent, { readonly eyebrow: string; readonly title: string; readonly detail: string }> = {
  ask: { eyebrow: "Ask Conclave", title: "Ask your codebase", detail: "Get a concise answer grounded in exact source evidence." },
  investigate: { eyebrow: "Deep investigation", title: "Trace the cause", detail: "Compare hypotheses, challenge assumptions, and surface uncertainty." },
  task: { eyebrow: "Bounded task", title: "Plan or change code safely", detail: "Choose permissions explicitly. Changes stay isolated from your repository." },
};

function Icon({ name, size = 17 }: { readonly name: IconName; readonly size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "ask") return <svg {...common}><path d="M7.5 18.5 3 21l1.3-5.1A8.5 8.5 0 1 1 7.5 18.5Z" /><path d="M8 10.5h8M8 14h5" /></svg>;
  if (name === "investigate") return <svg {...common}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5M10.5 7.5v6M7.5 10.5h6" /></svg>;
  if (name === "task") return <svg {...common}><rect x="5" y="4" width="14" height="17" rx="3" /><path d="M9 4.5V3h6v1.5M8.5 10l1.5 1.5 3-3M8.5 16h7" /></svg>;
  if (name === "graph") return <svg {...common}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="m8.4 6.2 7.1.6M7.4 8l3.4 7.8M16.8 9l-3.5 6.8" /></svg>;
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7a7.8 7.8 0 0 0-.7-1.7l.9-1.9-2.1-2.1-1.9.9a7.8 7.8 0 0 0-1.7-.7l-.7-2h-3l-.7 2a7.8 7.8 0 0 0-1.7.7l-1.9-.9-2.1 2.1.9 1.9a7.8 7.8 0 0 0-.7 1.7l-2 .7v3l2 .7c.2.6.4 1.2.7 1.7l-.9 1.9 2.1 2.1 1.9-.9c.5.3 1.1.5 1.7.7l.7 2h3l.7-2c.6-.2 1.2-.4 1.7-.7l1.9.9 2.1-2.1-.9-1.9c.3-.5.5-1.1.7-1.7l2-.7Z" /></svg>;
  if (name === "repo") return <svg {...common}><path d="M5 3.5h11a3 3 0 0 1 3 3V20H7a2 2 0 0 1-2-2V3.5Z" /><path d="M5 17.5A2.5 2.5 0 0 1 7.5 15H19M9 7h6" /></svg>;
  if (name === "folder") return <svg {...common}><path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z" /><path d="M3 9h18" /></svg>;
  if (name === "spark") return <svg {...common}><path d="m12 2 1.5 5.1L18 9.5 13.5 12 12 17l-1.5-5L6 9.5l4.5-2.4L12 2Z" /><path d="m19 15 .7 2.3L22 18.5l-2.3 1.2L19 22l-.7-2.3-2.3-1.2 2.3-1.2L19 15Z" /></svg>;
  if (name === "verdict") return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
  if (name === "evidence") return <svg {...common}><path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>;
  if (name === "retrieval") return <svg {...common}><path d="M4 6h16M7 11h10M9 16h6M11 21h2" /></svg>;
  if (name === "code") return <svg {...common}><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16" /></svg>;
  if (name === "info") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
  if (name === "x") return <svg {...common}><path d="m7 7 10 10M17 7 7 17" /></svg>;
  return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
}

function statusLabel(status: string): string { return status.replaceAll("-", " ").toUpperCase(); }

function Empty({ title, detail }: { readonly title: string; readonly detail: string }) {
  return <section className="empty"><span className="empty-icon"><Icon name="spark" size={24} /></span><h2>{title}</h2><p>{detail}</p></section>;
}

function AnalysisDepthSelector({ value, onChange, disabled }: { readonly value: ProductAnalysisDepth; readonly onChange: (depth: ProductAnalysisDepth) => void; readonly disabled: boolean }) {
  return <fieldset className="analysis-depth"><legend>Analysis depth</legend><div>{(Object.keys(DEPTH_COPY) as ProductAnalysisDepth[]).map((depth) => <label className={value === depth ? "selected" : ""} key={depth}><input type="radio" name="analysis-depth" value={depth} checked={value === depth} disabled={disabled} onChange={() => onChange(depth)} /><span><strong>{DEPTH_COPY[depth].title}</strong><small>{DEPTH_COPY[depth].detail}</small></span></label>)}</div></fieldset>;
}

function EvidencePanel({ evidence, selected, onSelect }: { readonly evidence: readonly EvidenceView[]; readonly selected: string | undefined; readonly onSelect: (id: string) => void }) {
  const current = evidence.find((item) => item.id === selected) ?? evidence[0];
  if (current === undefined) return <Empty title="No evidence yet" detail="Run an Ask, Investigate, or Task workflow to inspect bounded repository evidence." />;
  return <section className="evidence-layout" aria-label="Evidence viewer"><div className="evidence-list"><div className="panel-label">Sources · {evidence.length}</div>{evidence.map((item) => <button type="button" className={`evidence-link ${current.id === item.id ? "selected" : ""}`} onClick={() => onSelect(item.id)} key={item.id}><span><Icon name="code" size={14} />{item.path}</span><small>{item.startLine}–{item.endLine}{item.symbol === undefined ? "" : ` · ${item.symbol}`}</small></button>)}</div><article className="code-card"><header><span>{current.path}</span><span>Lines {current.startLine}–{current.endLine}</span></header><pre><code>{current.excerpt}</code></pre><footer><span className="provenance-dot" />Provenance · {current.origin}</footer></article></section>;
}

function Claims({ run, onEvidence }: { readonly run: ProductRunView; readonly onEvidence: (id: string) => void }) {
  if (run.claims.length === 0) return <Empty title="No verified claims" detail="Conclave did not accept a claim for this run." />;
  const group = (status: "supported" | "rejected" | "uncertain", title: string, empty: string) => {
    const claims = run.claims.filter((claim) => claim.status === status);
    return <section className={`claim-group ${status}`}><div className="section-heading"><div><span className="eyebrow">{status === "supported" ? "Main evidence" : status === "rejected" ? "Rejected hypotheses" : "Remaining uncertainty"}</span><h3>{title}</h3></div><span>{claims.length}</span></div>{claims.length === 0 ? <p className="muted">{empty}</p> : <div className="claims">{claims.map((claim) => <article className={`claim ${claim.status}`} key={claim.id}><header><span className="claim-status" aria-label={claim.status}><i />{claim.status}</span><span className="role-pill">{claim.role}</span></header><p>{claim.statement}</p><footer>{claim.evidenceIds.map((id) => <button type="button" onClick={() => onEvidence(id)} key={id}><Icon name="evidence" size={13} />Evidence</button>)}<span>{claim.challengeCount} challenges · {claim.verificationCount} verifications</span></footer></article>)}</div>}</section>;
  };
  return <section className="claims-section">{group("supported", "Supported findings", "No material claim was fully supported.")}{group("rejected", "What the evidence ruled out", "No material hypothesis was rejected.")}{group("uncertain", "What is still unresolved", "No material uncertainty remains in the bounded conclusion.")}</section>;
}

function GraphPanel({ graph, onSearch }: { readonly graph: GraphView; readonly onSearch: (value: string) => void }) {
  const [symbol, setSymbol] = useState(graph.query);
  useEffect(() => setSymbol(graph.query), [graph.query]);
  return <section className="graph-panel" aria-label="Graph explorer"><div className="panel-heading"><span className="panel-heading-icon"><Icon name="graph" /></span><div><span className="eyebrow">Repository graph</span><h2>Explore a symbol</h2></div></div><form onSubmit={(event) => { event.preventDefault(); onSearch(symbol); }}><label className="sr-only" htmlFor="graph-symbol">Scoped symbol</label><div><Icon name="investigate" size={16} /><input id="graph-symbol" aria-label="Scoped symbol" placeholder="Search a symbol" value={symbol} onChange={(event) => setSymbol(event.target.value)} /><button type="submit">Explore</button></div></form><p className="muted">{graph.message ?? `${String(graph.nodes.length)} bounded nodes · ${String(graph.edges.length)} relations`}</p><div className="graph-canvas">{graph.nodes.length === 0 ? <div className="graph-placeholder"><Icon name="graph" size={28} /><span>No bounded neighbors for this symbol.</span></div> : graph.nodes.map((node) => <div className="graph-node" key={node.id}><strong>{node.label}</strong><small>{node.path}</small></div>)}</div><div className="graph-edges">{graph.edges.map((edge) => <div key={edge.id}><span>{edge.relation}</span><small>{edge.provenance} · {edge.from.slice(0, 8)} → {edge.to.slice(0, 8)}</small></div>)}</div></section>;
}

function RetrievalPanel({ run }: { readonly run: ProductRunView }) {
  return <section className="retrieval-panel"><div className="panel-heading"><span className="panel-heading-icon"><Icon name="retrieval" /></span><div><span className="eyebrow">Context audit</span><h2>Retrieval inspector</h2></div></div><p className="muted">Why these evidence units were selected instead of a larger context dump.</p><ul>{run.retrieval.operations.map((item, index) => <li key={`${item.label}-${String(index)}`}><span className={`operation-status ${item.status}`}><Icon name={item.status === "executed" ? "verdict" : "chevron"} size={14} /></span><strong>{item.label}</strong><small>{item.status}</small></li>)}</ul><dl><div><dt>Evidence</dt><dd>{run.retrieval.evidenceCount}</dd></div><div><dt>Source bytes</dt><dd>{run.retrieval.sourceBytes}</dd></div><div><dt>Approx. tokens</dt><dd>{run.retrieval.approximateTokens}</dd></div></dl></section>;
}

function TaskPanel({ run }: { readonly run: ProductRunView }) {
  const task = run.task;
  if (task === undefined) return <Empty title="No task state" detail="Select Task mode to request an explicit plan or bounded execution." />;
  return <section className="task-panel"><div className="task-column"><div className="panel-heading compact"><span className="panel-heading-icon"><Icon name="task" /></span><div><span className="eyebrow">Scope</span><h2>Verified plan</h2></div></div><p>{task.plan.summary}</p><h3>Requirements</h3><ul>{task.plan.requirements.map((item) => <li key={item}>{item}</li>)}</ul><h3>Expected files</h3>{task.plan.steps.map((step) => <div className="step" key={step.description}><strong>{step.description}</strong><span>{step.files.join(", ")}</span></div>)}</div><div className="task-column"><div className="panel-heading compact"><span className="panel-heading-icon"><Icon name="spark" /></span><div><span className="eyebrow">Execution</span><h2>Actual progress</h2></div></div><ol className="progress">{task.progress.map((item) => <li className={item.state} key={item.stage}><i /><div><strong>{item.stage}</strong><span>{item.detail}</span></div></li>)}</ol><h3>Verification</h3><p>{task.revisionRounds} revision round{task.revisionRounds === 1 ? "" : "s"}</p>{task.checks.length === 0 ? <p className="muted">No repository code checks were permitted.</p> : task.checks.map((check) => <p key={check.id}>{check.status}: {check.kind} — {check.reason}</p>)}</div><div className="task-column diff"><div className="panel-heading compact"><span className="panel-heading-icon"><Icon name="code" /></span><div><span className="eyebrow">Isolated output</span><h2>Final patch</h2></div></div><p className="muted">This patch has not modified the original repository.</p>{task.diff.length === 0 ? <p className="muted">No isolated patch was produced.</p> : task.diff.map((file, index) => <article key={`${file.path}-${String(index)}`}><header><strong>{file.path}</strong><span>+{file.additions} / −{file.deletions}</span></header>{!file.expected && <p className="warning">Unexpected file — review required.</p>}<pre><code>{file.patch}</code></pre></article>)}</div></section>;
}

type DraftProviderConnection = Omit<ProviderSetView["providers"][number], "baseUrl"> & { readonly baseUrl: string | undefined; readonly apiKey: string };
type DraftProviderSet = Omit<ProviderSetView, "providers" | "roles"> & {
  readonly providers: readonly DraftProviderConnection[];
  readonly roles: readonly ProviderRoleAssignmentView[];
};
type CatalogStatus = { readonly kind: "loading" | "success" | "error"; readonly message: string };

function draftId(prefix: "set" | "provider"): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function editableSet(set: ProviderSetView): DraftProviderSet {
  return { ...set, providers: set.providers.map((provider) => ({ ...provider, baseUrl: provider.baseUrl, apiKey: "" })) };
}

function ConfigurationPanel({ runtime, onRuntimeChange }: { readonly runtime: RuntimeModeView | undefined; readonly onRuntimeChange: (runtime: RuntimeModeView) => void }) {
  const [settings, setSettings] = useState<ProviderSettingsView>();
  const [sets, setSets] = useState<readonly DraftProviderSet[]>([]);
  const [activeSetId, setActiveSetId] = useState<string>();
  const [selectedId, setSelectedId] = useState("environment");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [modelCatalogs, setModelCatalogs] = useState<Readonly<Record<string, ProviderModelsView>>>({});
  const [loadingModels, setLoadingModels] = useState<ReadonlySet<string>>(new Set());
  const [appliedProfiles, setAppliedProfiles] = useState<Readonly<Record<string, string>>>({});
  const [catalogStatuses, setCatalogStatuses] = useState<Readonly<Record<string, CatalogStatus>>>({});
  const catalogRequests = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    void api.providerSettings().then((next) => {
      if (cancelled) return;
      setSettings(next);
      setSets(next.sets.map(editableSet));
      setActiveSetId(next.activeSetId);
      setSelectedId(next.activeSetId ?? next.sets[0]?.id ?? "environment");
    }).catch((error: unknown) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not load provider settings."); });
    return () => { cancelled = true; };
  }, []);

  if (settings === undefined) return <section className="retrieval-panel configuration-panel" aria-label="Provider and role configuration"><div className="panel-heading"><span className="panel-heading-icon"><Icon name="settings" /></span><div><span className="eyebrow">Local configuration</span><h2>Providers & roles</h2></div></div>{message === "" ? <p className="muted">Loading local provider settings…</p> : <p className="warning"><Icon name="info" size={14} />{message}</p>}</section>;

  const selected = sets.find((set) => set.id === selectedId);
  const selectedIsEnvironment = selectedId === "environment";
  const updateSet = (id: string, change: (current: DraftProviderSet) => DraftProviderSet) => setSets((current) => current.map((set) => set.id === id ? change(set) : set));
  const clearModelCatalog = (connectionId: string) => {
    setModelCatalogs((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== connectionId)));
    setAppliedProfiles((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== connectionId)));
    setCatalogStatuses((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== connectionId)));
  };
  const addSet = () => {
    if (sets.length >= settings.maximumSets) return;
    const setId = draftId("set");
    const connectionId = draftId("provider");
    const first = settings.catalog[0];
    if (first === undefined) return;
    const next: DraftProviderSet = {
      id: setId,
      name: `Personal set ${String(sets.length + 1)}`,
      providers: [{ id: connectionId, provider: first.id, model: first.modelPlaceholder, baseUrl: first.defaultBaseUrl, apiKeyConfigured: false, apiKey: "" }],
      roles: PROVIDER_ROLES.map((role) => ({ role, connectionId, model: first.modelPlaceholder })),
    };
    setSets((current) => [...current, next]);
    setSelectedId(setId);
    setActiveSetId(setId);
    setMessage("New personal set created. Add your key, load the models, and choose a profile.");
  };
  const removeSet = (id: string) => {
    setSets((current) => current.filter((set) => set.id !== id));
    if (activeSetId === id) setActiveSetId(undefined);
    setSelectedId("environment");
    setMessage("Set removed locally. Save changes to confirm.");
  };
  const addConnection = () => {
    if (selected === undefined || selected.providers.length >= 5) return;
    const first = settings.catalog[0];
    if (first === undefined) return;
    updateSet(selected.id, (current) => ({ ...current, providers: [...current.providers, { id: draftId("provider"), provider: first.id, model: first.modelPlaceholder, baseUrl: first.defaultBaseUrl, apiKeyConfigured: false, apiKey: "" }] }));
  };
  const removeConnection = (connectionId: string) => {
    if (selected === undefined || selected.providers.length <= 1) return;
    updateSet(selected.id, (current) => {
      const providers = current.providers.filter((provider) => provider.id !== connectionId);
      const fallback = providers[0];
      if (fallback === undefined) return current;
      return { ...current, providers, roles: current.roles.map((assignment) => assignment.connectionId === connectionId ? { ...assignment, connectionId: fallback.id, model: fallback.model } : assignment) };
    });
    clearModelCatalog(connectionId);
  };
  const loadModels = async (setId: string, connection: DraftProviderConnection) => {
    if ((connection.provider !== "openai" && connection.provider !== "openrouter") || catalogRequests.current.has(connection.id)) return;
    catalogRequests.current.add(connection.id);
    setLoadingModels((current) => new Set([...current, connection.id]));
    setCatalogStatuses((current) => ({ ...current, [connection.id]: { kind: "loading", message: `Connecting to ${connection.provider === "openai" ? "OpenAI" : "OpenRouter"} and loading your models…` } }));
    setMessage("");
    try {
      const catalog = await api.providerModels({
        provider: connection.provider,
        setId,
        connectionId: connection.id,
        ...(connection.apiKey.trim() === "" ? {} : { apiKey: connection.apiKey }),
      });
      setModelCatalogs((current) => ({ ...current, [connection.id]: catalog }));
      setCatalogStatuses((current) => ({ ...current, [connection.id]: { kind: "success", message: `${String(catalog.models.length)} models loaded. Choose a profile or search by name.` } }));
    } catch (error) {
      setCatalogStatuses((current) => ({ ...current, [connection.id]: { kind: "error", message: error instanceof Error ? error.message : "Could not load provider models." } }));
    } finally {
      catalogRequests.current.delete(connection.id);
      setLoadingModels((current) => {
        const next = new Set(current);
        next.delete(connection.id);
        return next;
      });
    }
  };
  const applyProfile = (setId: string, connectionId: string, profile: ProviderModelProfileView) => {
    updateSet(setId, (current) => ({
      ...current,
      providers: current.providers.map((provider) => provider.id === connectionId ? { ...provider, model: profile.defaultModel } : provider),
      roles: profile.assignments,
    }));
    setAppliedProfiles((current) => ({ ...current, [connectionId]: profile.id }));
    setMessage(`${profile.name} applied to every role. Save to activate it over .env.`);
  };
  const useForEveryRole = (setId: string, connection: DraftProviderConnection) => {
    updateSet(setId, (current) => ({
      ...current,
      roles: PROVIDER_ROLES.map((role) => ({ role, connectionId: connection.id, model: connection.model })),
    }));
    setAppliedProfiles((current) => ({ ...current, [connection.id]: "custom" }));
    setMessage(`${connection.model} will be used for every role after saving.`);
  };
  const save = async () => {
    setSaving(true);
    setMessage("");
    const payload: SaveProviderSettingsInput = {
      ...(activeSetId === undefined ? {} : { activeSetId }),
      sets: sets.map((set) => ({
        id: set.id,
        name: set.name,
        providers: set.providers.map((provider) => ({ id: provider.id, provider: provider.provider, model: provider.model, ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }), ...(provider.apiKey.trim() === "" ? {} : { apiKey: provider.apiKey }) })),
        roles: set.roles,
      })),
    };
    try {
      const next = await api.saveProviderSettings(payload);
      setSettings(next);
      setSets(next.sets.map(editableSet));
      setActiveSetId(next.activeSetId);
      onRuntimeChange(await api.runtime());
      setMessage(next.activeSetId === undefined ? "Saved. The .env fallback is active." : "Saved. This personal set now overrides .env.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save provider settings.");
    } finally {
      setSaving(false);
    }
  };

  return <section className="configuration-panel" aria-label="Provider and role configuration">
    <header className="settings-hero"><div className="panel-heading"><span className="panel-heading-icon"><Icon name="settings" /></span><div><span className="eyebrow">Local configuration</span><h2>Model profiles</h2></div></div><p>Add your own OpenAI or OpenRouter key, load the models available to your account, then choose one profile. You can keep up to five sets; the active one overrides <code>.env</code>, and credentials never come back to the browser.</p><div className="settings-status"><span className={activeSetId === undefined ? "environment" : "personal"}><i />{activeSetId === undefined ? "Using .env fallback" : `${sets.find((set) => set.id === activeSetId)?.name ?? "Personal set"} is active`}</span><small>{runtime?.available ? "Runtime ready" : "Runtime needs configuration"}</small></div></header>
    {message !== "" && <div className="settings-message" role="status"><Icon name="info" size={15} />{message}</div>}
    <div className="settings-layout"><aside className="settings-list" aria-label="Provider sets"><div className="settings-list-heading"><span>Configurations</span><small>{sets.length}/{settings.maximumSets}</small></div><button type="button" className={selectedIsEnvironment ? "selected" : ""} onClick={() => setSelectedId("environment")}><span className="set-symbol environment">E</span><span><strong>{settings.environment.label}</strong><small>{settings.environment.mode === "free" ? "Host-controlled ensemble" : "Read-only .env"}</small></span>{activeSetId === undefined && <i className="active-dot" />}</button>{sets.map((set) => <button type="button" className={!selectedIsEnvironment && selected?.id === set.id ? "selected" : ""} onClick={() => setSelectedId(set.id)} key={set.id}><span className="set-symbol">{set.name.slice(0, 1).toUpperCase()}</span><span><strong>{set.name}</strong><small>{set.providers.length} provider{set.providers.length === 1 ? "" : "s"}</small></span>{activeSetId === set.id && <i className="active-dot" />}</button>)}<button type="button" className="add-set-button" onClick={addSet} disabled={sets.length >= settings.maximumSets}>+ New provider set</button></aside>
      <div className="settings-detail">{selectedIsEnvironment ? <section className="environment-detail"><div className="settings-detail-header"><div><span className="eyebrow">Protected fallback</span><h3>{settings.environment.label}</h3><p>{settings.environment.message}</p></div><span className="locked-pill">Locked</span></div><div className="environment-overview"><div><span>Provider</span><strong>{settings.environment.provider ?? "Not configured"}</strong></div><div><span>Default model</span><strong>{settings.environment.model ?? "Fixed by server"}</strong></div><div><span>Credential</span><strong>{settings.environment.credentialConfigured ? "Configured" : "Missing"}</strong></div></div><p className="secure-note"><Icon name="info" size={15} />The server-owned Free credential is locked to the host configuration and never returned to the browser. To customize provider or model, create a personal set with your own key.</p><details className="readonly-routing"><summary>View host role routing</summary><div className="role-readonly">{settings.environment.roles.length === 0 ? <p className="muted">No environment roles are available.</p> : settings.environment.roles.map((role) => <div key={role.role}><strong>{role.role}</strong><span>{role.provider}</span><small>{role.model}</small></div>)}</div></details><button type="button" className="activate-button" onClick={() => setActiveSetId(undefined)}>Use .env fallback</button></section> : selected === undefined ? null : <section className="personal-detail">
        <div className="settings-detail-header"><div className="set-name-field"><label htmlFor="set-name">Profile set name</label><input id="set-name" value={selected.name} maxLength={48} onChange={(event) => updateSet(selected.id, (current) => ({ ...current, name: event.target.value }))} /></div><div className="set-actions"><button type="button" className={activeSetId === selected.id ? "active activate-button" : "activate-button"} onClick={() => setActiveSetId(selected.id)}>{activeSetId === selected.id ? "Active after save" : "Make active"}</button><button type="button" className="remove-set" onClick={() => removeSet(selected.id)}>Delete</button></div></div>
        <div className="setup-guide" aria-label="Provider setup steps"><span><i>1</i>Add your key</span><span><i>2</i>Load models</span><span><i>3</i>Choose a profile</span></div>
        <div className="connection-list">{selected.providers.map((connection, index) => {
          const item = settings.catalog.find((candidate) => candidate.id === connection.provider);
          const modelCatalog = modelCatalogs[connection.id];
          const supportsCatalog = connection.provider === "openai" || connection.provider === "openrouter";
          const isLoading = loadingModels.has(connection.id);
          const catalogStatus = catalogStatuses[connection.id];
          const listId = `model-list-${connection.id}`;
          return <article className="connection-card model-setup-card" key={connection.id}>
            <header><span className="connection-number">{String(index + 1).padStart(2, "0")}</span><strong>{item?.name ?? connection.provider}</strong>{connection.apiKeyConfigured && <span className="key-saved">Key saved</span>}{selected.providers.length > 1 && <button type="button" aria-label={`Remove ${item?.name ?? connection.provider}`} onClick={() => removeConnection(connection.id)}><Icon name="x" size={14} /></button>}</header>
            <div className="connection-primary-fields">
              <label><span>Provider</span><select aria-label={`Provider ${String(index + 1)}`} value={connection.provider} onChange={(event) => {
                const provider = event.target.value as ConfigurableProviderId;
                const catalog = settings.catalog.find((candidate) => candidate.id === provider);
                setMessage("");
                clearModelCatalog(connection.id);
                updateSet(selected.id, (current) => ({
                  ...current,
                  providers: current.providers.map((candidate) => candidate.id === connection.id ? { ...candidate, provider, model: catalog?.modelPlaceholder ?? "", baseUrl: catalog?.defaultBaseUrl, apiKey: "", apiKeyConfigured: false } : candidate),
                  roles: current.roles.map((role) => role.connectionId === connection.id ? { ...role, model: catalog?.modelPlaceholder ?? "" } : role),
                }));
              }}>{settings.catalog.map((catalog) => <option value={catalog.id} key={catalog.id}>{catalog.name}</option>)}</select></label>
              {item?.requiresApiKey !== false && <label className="api-key-field"><span>Your personal API key</span><input aria-label={`${item?.name ?? connection.provider} personal API key`} type="password" autoComplete="off" value={connection.apiKey} placeholder={connection.apiKeyConfigured ? "Saved — leave blank to reuse" : "Paste your key"} onChange={(event) => { setCatalogStatuses((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== connection.id))); updateSet(selected.id, (current) => ({ ...current, providers: current.providers.map((candidate) => candidate.id === connection.id ? { ...candidate, apiKey: event.target.value } : candidate) })); }} onBlur={() => { if (supportsCatalog && (connection.apiKey.trim().length >= 8 || connection.apiKeyConfigured) && modelCatalog === undefined) void loadModels(selected.id, connection); }} /></label>}
              {supportsCatalog && <button type="button" className="load-models-button" onClick={() => void loadModels(selected.id, connection)} disabled={isLoading || (connection.apiKey.trim() === "" && !connection.apiKeyConfigured)}>{isLoading ? <><span className="spinner" />Loading…</> : modelCatalog === undefined ? "Load models" : "Refresh list"}</button>}
            </div>
            {catalogStatus !== undefined && <div className={`catalog-status ${catalogStatus.kind}`} role={catalogStatus.kind === "error" ? "alert" : "status"}><Icon name={catalogStatus.kind === "success" ? "verdict" : "info"} size={14} /><span>{catalogStatus.message}</span></div>}
            {supportsCatalog && modelCatalog === undefined && <p className="catalog-hint">Use your own {connection.provider === "openai" ? "OpenAI" : "OpenRouter"} key. The available models and ready-made profiles will appear here.</p>}
            {modelCatalog !== undefined && <div className="catalog-results">
              <div className="model-picker"><label htmlFor={`model-${connection.id}`}><span>Search or choose a model</span><small>{modelCatalog.models.length} available to this key</small></label><div><input id={`model-${connection.id}`} aria-label={`${item?.name ?? connection.provider} model`} list={listId} value={connection.model} placeholder="Start typing a model name…" onChange={(event) => { const model = event.target.value; updateSet(selected.id, (current) => ({ ...current, providers: current.providers.map((candidate) => candidate.id === connection.id ? { ...candidate, model } : candidate) })); setAppliedProfiles((current) => ({ ...current, [connection.id]: "custom" })); }} /><datalist id={listId}>{modelCatalog.models.map((model) => <option value={model.id} key={model.id}>{model.name}{model.contextLength === undefined ? "" : ` · ${String(Math.round(model.contextLength / 1_000))}k context`}</option>)}</datalist><button type="button" onClick={() => useForEveryRole(selected.id, { ...connection, model: connection.model })}>Use for every role</button></div></div>
              <div className="profile-heading"><div><span className="eyebrow">Ready-made routing</span><h4>Choose one profile</h4></div><small>You can fine-tune roles later</small></div>
              <div className="profile-grid">{modelCatalog.profiles.map((profile) => <button type="button" className={appliedProfiles[connection.id] === profile.id ? "selected" : ""} aria-pressed={appliedProfiles[connection.id] === profile.id} onClick={() => applyProfile(selected.id, connection.id, profile)} key={profile.id}><span><strong>{profile.name}</strong>{profile.id === "balanced" && <i>Recommended</i>}</span><p>{profile.description}</p><small>{profile.defaultModel}</small></button>)}</div>
            </div>}
            {!supportsCatalog && <div className="manual-model-field"><label><span>Model name</span><input value={connection.model} placeholder={item?.modelPlaceholder} onChange={(event) => updateSet(selected.id, (current) => ({ ...current, providers: current.providers.map((candidate) => candidate.id === connection.id ? { ...candidate, model: event.target.value } : candidate) }))} /></label><button type="button" onClick={() => useForEveryRole(selected.id, connection)}>Use for every role</button></div>}
            <details className="connection-advanced"><summary>Connection options</summary><label><span>Base URL</span><input value={connection.baseUrl ?? ""} placeholder={item?.defaultBaseUrl ?? "https://…/v1"} onChange={(event) => updateSet(selected.id, (current) => ({ ...current, providers: current.providers.map((candidate) => candidate.id === connection.id ? { ...candidate, baseUrl: event.target.value } : candidate) }))} /></label></details>
          </article>;
        })}</div>
        <details className="advanced-routing"><summary><span><strong>Advanced routing</strong><small>Override provider and model for each role</small></span><Icon name="chevron" size={15} /></summary><div className="advanced-routing-content"><div className="settings-section-heading roles-heading"><div><span className="eyebrow">Per-role controls</span><h4>Providers and models</h4></div><button type="button" onClick={addConnection} disabled={selected.providers.length >= 5}>+ Add provider</button></div><div className="role-editor">{selected.roles.map((assignment) => {
          const assignedConnection = selected.providers.find((provider) => provider.id === assignment.connectionId);
          const assignedCatalog = assignedConnection === undefined ? undefined : modelCatalogs[assignedConnection.id];
          const roleListId = assignedConnection === undefined ? undefined : `model-list-${assignedConnection.id}`;
          return <div className="role-row" key={assignment.role}><div><span className="role-mark">{assignment.role.slice(0, 1).toUpperCase()}</span><strong>{assignment.role}</strong></div><label><span>Provider</span><select aria-label={`${assignment.role} provider`} value={assignment.connectionId} onChange={(event) => { const nextConnection = selected.providers.find((provider) => provider.id === event.target.value); updateSet(selected.id, (current) => ({ ...current, roles: current.roles.map((role) => role.role === assignment.role ? { ...role, connectionId: event.target.value, model: nextConnection?.model ?? role.model } : role) })); }}>{selected.providers.map((provider) => <option value={provider.id} key={provider.id}>{settings.catalog.find((catalog) => catalog.id === provider.provider)?.name ?? provider.provider}</option>)}</select></label><label><span>Model</span><input aria-label={`${assignment.role} model`} list={assignedCatalog === undefined ? undefined : roleListId} value={assignment.model} onChange={(event) => updateSet(selected.id, (current) => ({ ...current, roles: current.roles.map((role) => role.role === assignment.role ? { ...role, model: event.target.value } : role) }))} /></label></div>;
        })}</div></div></details>
        <p className="secure-note"><Icon name="info" size={15} />Personal keys are stored by the local server with owner-only file permissions. They are used only for your set and model lookup, and are never included in settings responses. The host Free key remains inaccessible.</p>
      </section>}</div></div>
    <footer className="settings-footer"><span>Personal sets have priority over <code>.env</code> only when active.</span><button type="button" className="save-settings" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save provider settings"}</button></footer>
  </section>;
}

function WelcomeState({ intent }: { readonly intent: ProductIntent }) {
  return <section className="welcome-state"><div className="welcome-orbit" aria-hidden="true"><span /><span /><span /><Icon name="spark" size={28} /></div><span className="eyebrow">Project Knowledge ready</span><h2>{intent === "ask" ? "One answer, cited to source." : intent === "investigate" ? "Make uncertainty visible." : "Change code with a clear boundary."}</h2><p>Conclave has already indexed the repository structure. It will query that knowledge first and invoke only the reasoning roles the evidence justifies.</p><div className="welcome-features"><span><Icon name="evidence" size={15} />Exact evidence</span><span><Icon name="investigate" size={15} />Adaptive depth</span><span><Icon name="verdict" size={15} />Explicit verdict</span></div></section>;
}

function TechnicalDetails({ run }: { readonly run: ProductRunView }) {
  return <details className="technical-details"><summary>How Conclave analyzed this · Technical details</summary>{run.analysis !== undefined && <section className="analysis-summary"><div><strong>Analysis: {run.analysis.selectedDepth}</strong><span>{run.analysis.requestedDepth === "auto" ? "Auto selected" : "User forced"}</span></div><p>{run.analysis.why.join(" · ")}</p><p>{run.analysis.conductorReason}</p>{run.analysis.earlyExitReason !== undefined && <p>Early exit: {run.analysis.earlyExitReason}</p>}{run.analysis.models.length > 0 && <div className="model-routing"><strong>Capability-driven model route</strong>{run.analysis.models.map((item) => <p key={item.role}><b>{item.role}</b> · {item.provider}/{item.model} · {String(item.calls)} call{item.calls === 1 ? "" : "s"} · {String(Math.round(item.latencyMs))} ms<br /><small>{item.requirement} · {item.selectionReason}</small></p>)}</div>}{run.analysis.reviewRecommended && <aside><strong>Independent review recommended</strong>{run.analysis.reviewReasons.map((reason) => <p key={reason}>{reason}</p>)}{run.analysis.reviewHandoff !== undefined && <details><summary>Portable review handoff</summary><pre>{run.analysis.reviewHandoff}</pre></details>}</aside>}</section>}<section className="trace"><div className="section-heading"><div><span className="eyebrow">Execution trace</span><h3>Bounded role route</h3></div></div>{run.trace.map((item) => <div key={item.role}><strong>{item.role}</strong><span className={item.status}>{item.status === "ran" ? "✓ Ran" : "○ Skipped"}</span><small>{item.reason}</small></div>)}</section><section className="metrics">{run.metrics.map((metric) => <div key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></div>)}</section></details>;
}

function RunProgress({ job, onCancel }: { readonly job: ProductRunJobView; readonly onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(job.startedAt)) / 1_000));
  const label = elapsed < 60 ? `${String(elapsed)}s elapsed` : `${String(Math.floor(elapsed / 60))}m ${String(elapsed % 60).padStart(2, "0")}s elapsed`;
  return <section className="run-progress-card" aria-live="polite" aria-label="Analysis progress"><header><span className="progress-orb"><span className="spinner" /></span><div><span className="eyebrow">{job.status === "cancelling" ? "Preserving partial results" : `Analysis · ${DEPTH_COPY[job.depth ?? "auto"].title}`}</span><h2>{job.intent === "ask" ? "Building an evidence-backed answer" : job.intent === "task" ? "Planning and executing within the task boundary" : "Investigating repository evidence"}</h2><p>{label} · Repository evidence and provider work are bounded.</p></div><button type="button" className="cancel-run" disabled={job.status === "cancelling"} onClick={onCancel}>{job.status === "cancelling" ? "Cancelling…" : job.intent === "task" ? "Cancel task" : "Cancel analysis"}</button></header><ol>{job.progress.length === 0 ? <li className="current"><i /><div><strong>Reading Project Knowledge</strong><span>Checking indexed symbols and structural relationships first.</span></div></li> : job.progress.map((item) => <li className={item.state} key={`${String(item.sequence)}-${item.stage}`}><i /><div><strong>{item.stage}</strong><span>{item.detail}</span></div></li>)}</ol>{job.snapshot !== undefined && (job.snapshot.supportedClaims.length > 0 || job.snapshot.uncertainClaims.length > 0) && <section className="partial-results"><span className="eyebrow">Evidence-backed snapshot</span>{job.snapshot.supportedClaims.length > 0 && <><h3>Already confirmed</h3><ul>{job.snapshot.supportedClaims.map((claim) => <li key={claim.id}>✓ {claim.statement}</li>)}</ul></>}{job.snapshot.uncertainClaims.length > 0 && <><h3>Not completed</h3><ul>{job.snapshot.uncertainClaims.map((claim) => <li key={claim.id}>? {claim.statement}</li>)}</ul></>}{job.snapshot.remainingChecks.length > 0 && <p>{job.snapshot.remainingChecks.join(" · ")}</p>}</section>}<footer>Only structured claims and repository evidence are shown — never private chain-of-thought.</footer></section>;
}

function ReviewWorkspace({ project, depth, onDepthChange, onNotice }: {
  readonly project: ProjectView | undefined;
  readonly depth: ProductAnalysisDepth;
  readonly onDepthChange: (depth: ProductAnalysisDepth) => void;
  readonly onNotice: (notice: string) => void;
}) {
  const [kind, setKind] = useState<ProductChangeSetSource["kind"]>("working-tree");
  const [base, setBase] = useState("main");
  const [target, setTarget] = useState("HEAD");
  const [objective, setObjective] = useState("");
  const [diff, setDiff] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProductReviewView>();
  const source = (): ProductChangeSetSource => {
    if (kind === "branch") return { kind, base, ...(target.trim() === "" ? {} : { head: target }) };
    if (kind === "commit") return { kind, base, target };
    if (kind === "explicit") return { kind, label: "web workspace" };
    return { kind };
  };
  const submit = async () => {
    if (project === undefined || busy) return;
    setBusy(true);
    onNotice("");
    try {
      setResult(await api.review(project.id, source(), diff, objective, depth));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Review could not be completed.");
    } finally {
      setBusy(false);
    }
  };
  return <section className="validation-workspace" aria-label="Review workspace"><header className="validation-hero"><span className="composer-icon"><Icon name="verdict" size={19} /></span><div><span className="eyebrow">Validation-first Review</span><h1>Review a real ChangeSet</h1><p>Project Knowledge inspects the diff and its impact before adaptive reasoning is considered.</p></div></header><div className="validation-grid"><form className="validation-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label>ChangeSet source<select aria-label="ChangeSet source" value={kind} onChange={(event) => setKind(event.target.value as ProductChangeSetSource["kind"])}><option value="working-tree">Working tree</option><option value="staged">Staged changes</option><option value="branch">Branch comparison</option><option value="commit">Commit comparison</option><option value="explicit">Explicit unified diff</option></select></label>{(kind === "branch" || kind === "commit") && <div className="field-row"><label>{kind === "branch" ? "Base branch" : "Base commit"}<input value={base} onChange={(event) => setBase(event.target.value)} /></label><label>{kind === "branch" ? "Head branch" : "Target commit"}<input value={target} onChange={(event) => setTarget(event.target.value)} /></label></div>}<label>Objective <span className="muted">(optional)</span><textarea rows={2} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="What should this change accomplish?" /></label>{kind === "explicit" && <label>Unified diff<textarea className="diff-input" rows={10} value={diff} onChange={(event) => setDiff(event.target.value)} placeholder={'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@'} /></label>}<AnalysisDepthSelector value={depth} onChange={onDepthChange} disabled={busy} /><button className="run-button" type="submit" disabled={busy || project === undefined}>{busy ? "Reviewing…" : "Run Review"}</button></form><div className="validation-result">{result === undefined ? <Empty title="No ReviewVerdict yet" detail="Choose a Git source or paste a unified diff. Safe deterministic results may complete with zero model calls." /> : <><header><span className={`verdict-status ${result.status}`}><i />{statusLabel(result.status)}</span><h2>{result.summary}</h2><p className="muted">{result.analysis.route} · {result.analysis.selectedDepth}</p></header><section className="metrics">{result.metrics.map((metric) => <div key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></div>)}</section><section><h3>Findings</h3>{result.findings.length === 0 ? <p className="muted">No concrete repository consequence was found.</p> : result.findings.map((finding) => <article className={`validation-item ${finding.severity}`} key={finding.id}><strong>{finding.severity} · {finding.category}</strong><p>{finding.statement}</p><small>{finding.consequence}{finding.path === undefined ? "" : ` · ${finding.path}${finding.line === undefined ? "" : `:${String(finding.line)}`}`}</small></article>)}</section><section><h3>Confirmed properties</h3>{result.confirmedProperties.length === 0 ? <p className="muted">No property could be confirmed deterministically.</p> : <ul>{result.confirmedProperties.map((property) => <li key={`${property.method}-${property.statement}`}>✓ {property.statement} <small>({property.method})</small></li>)}</ul>}</section>{result.uncertainty.length > 0 && <section><h3>Uncertainty</h3><ul>{result.uncertainty.map((item) => <li key={item.statement}>? {item.statement}</li>)}</ul></section>}<section><h3>Bounded impact</h3><p>{result.changedFiles.length} files · {result.changedSymbols.length} changed symbols · {result.impactedSymbols.length} impacted symbols{result.impactTruncated ? " · truncated at safety bound" : ""}</p>{result.changedSymbols.slice(0, 12).map((symbol) => <p className="symbol-row" key={`${symbol.path}-${symbol.symbol}`}>{symbol.symbol} <small>{symbol.symbolKind} · {symbol.path}</small></p>)}</section>{result.revisionHandoff !== undefined && <section><h3>Revision handoff</h3><pre className="handoff">{result.revisionHandoff}</pre></section>}</>}</div></div></section>;
}

function DecideWorkspace({ project, depth, onDepthChange, onNotice }: {
  readonly project: ProjectView | undefined;
  readonly depth: ProductAnalysisDepth;
  readonly onDepthChange: (depth: ProductAnalysisDepth) => void;
  readonly onNotice: (notice: string) => void;
}) {
  const [proposal, setProposal] = useState("- bootstrapSession exists\n- bootstrapSession has no callers");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProductDecisionView>();
  const submit = async () => {
    if (project === undefined || busy) return;
    setBusy(true);
    onNotice("");
    try {
      setResult(await api.decide(project.id, proposal, objective, depth));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Decision validation could not be completed.");
    } finally {
      setBusy(false);
    }
  };
  return <section className="validation-workspace" aria-label="Decide workspace"><header className="validation-hero"><span className="composer-icon"><Icon name="investigate" size={19} /></span><div><span className="eyebrow">Decision Validation</span><h1>Challenge a proposal before implementation</h1><p>Conclave decomposes the proposal into explicit claims, tests assumptions against Project Knowledge, then reasons adaptively only where needed.</p></div></header><div className="validation-grid"><form className="validation-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label>Proposal<textarea rows={10} value={proposal} onChange={(event) => setProposal(event.target.value)} placeholder="One explicit claim per line works best." /></label><label>Objective <span className="muted">(optional)</span><textarea rows={2} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="What outcome should this proposal serve?" /></label><AnalysisDepthSelector value={depth} onChange={onDepthChange} disabled={busy} /><button className="run-button" type="submit" disabled={busy || project === undefined}>{busy ? "Validating…" : "Validate decision"}</button></form><div className="validation-result">{result === undefined ? <Empty title="No DecisionVerdict yet" detail="State a proposal as explicit, falsifiable claims to verify it before implementation." /> : <><header><span className={`verdict-status ${result.status}`}><i />{statusLabel(result.status)}</span><h2>{result.summary}</h2><p className="muted">{result.analysis.deterministic ? "Project Knowledge" : "Adaptive orchestration"} · {result.analysis.selectedDepth}</p></header><section className="metrics">{result.metrics.map((metric) => <div key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></div>)}</section><section><h3>Claims</h3>{result.claims.map((claim) => <article className={`validation-item ${claim.status}`} key={claim.id}><strong>{claim.status} · {claim.kind}</strong><p>{claim.statement}</p><small>{claim.explanation}{claim.deterministic ? " · deterministic" : ""}</small></article>)}</section>{result.challengedAssumptions.length > 0 && <section><h3>Challenged assumptions</h3><ul>{result.challengedAssumptions.map((item) => <li key={item}>{item}</li>)}</ul></section>}{result.uncertainty.length > 0 && <section><h3>Uncertainty</h3><ul>{result.uncertainty.map((item) => <li key={item}>{item}</li>)}</ul></section>}{result.implementationHandoff !== undefined && <section><h3>Implementation handoff</h3><pre className="handoff">{result.implementationHandoff}</pre></section>}{result.revisionHandoff !== undefined && <section><h3>Revision handoff</h3><pre className="handoff">{result.revisionHandoff}</pre></section>}</>}</div></div></section>;
}

export function App() {
  const [project, setProject] = useState<ProjectView>();
  const [runtime, setRuntime] = useState<RuntimeModeView>();
  const [intent, setIntent] = useState<ProductIntent>("ask");
  const [depth, setDepth] = useState<ProductAnalysisDepth>("auto");
  const [input, setInput] = useState(DEFAULT_ASK);
  const [run, setRun] = useState<ProductRunView>();
  const [activeRun, setActiveRun] = useState<ProductRunJobView>();
  const [tab, setTab] = useState<WorkspaceTab>("verdict");
  const [selectedEvidence, setSelectedEvidence] = useState<string>();
  const folderInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [planOnly, setPlanOnly] = useState(true);
  const [permissions, setPermissions] = useState<Permissions>({ allowFileEdits: false, allowCommands: false, allowRepositoryScripts: false, allowNetwork: false });

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, []);

  const openDemo = async () => { setBusy(true); setNotice("Understanding repository…"); try { const opened = await api.demo(); setProject(opened); setNotice(`Project Knowledge ready · ${String(opened.indexedFiles)} files · ${String(opened.symbols)} symbols · ${String(opened.graphEdges)} structural relationships. Demo inference is deterministic.`); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not open Demo Mode."); } finally { setBusy(false); } };
  useEffect(() => { void api.runtime().then(setRuntime).catch(() => undefined); void openDemo(); }, []);
  const modeCopy = useMemo(() => INTENT_COPY[intent], [intent]);
  const runInProgress = activeRun !== undefined && activeRun.status !== "completed";
  useEffect(() => {
    if (activeRun === undefined || activeRun.status === "completed") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.runStatus(activeRun.id);
        if (cancelled) return;
        setActiveRun(next);
        if (next.result !== undefined) { setRun(next.result); setSelectedEvidence(next.result.evidence[0]?.id); setTab(next.result.intent === "task" ? "task" : "verdict"); }
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : "Could not read run progress.");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 900);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeRun?.id, activeRun?.status]);
  const setActiveIntent = (next: ProductIntent) => { if (runInProgress) return; setIntent(next); setInput(next === "ask" ? DEFAULT_ASK : next === "investigate" ? DEFAULT_INVESTIGATE : DEFAULT_TASK); setRun(undefined); setSelectedEvidence(undefined); setTab(next === "task" ? "task" : "verdict"); };
  const chooseRepository = async () => {
    if (busy) return;
    if (window.conclaveDesktop !== undefined) {
      setBusy(true);
      try {
        const path = await window.conclaveDesktop.pickRepository();
        if (path !== undefined) { setNotice("Understanding repository…"); const opened = await api.open(path); setProject(opened); setNotice(`Project Knowledge ready · ${String(opened.indexedFiles)} files · ${String(opened.symbols)} symbols · ${String(opened.graphEdges)} structural relationships.`); }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not open the selected repository.");
      } finally {
        setBusy(false);
      }
      return;
    }
    folderInput.current?.click();
  };
  const importRepository = async (files: FileList | null) => {
    if (files === null || files.length === 0) return;
    setBusy(true);
    setNotice("Importing the selected folder securely…");
    try {
      const selected = Array.from(files).filter((file) => {
        const parts = (file.webkitRelativePath || file.name).split("/");
        const repositoryPath = parts.length > 1 ? parts.slice(1).join("/") : parts.join("/");
        return !parts.some((part) => IGNORED_IMPORT_SEGMENTS.has(part)) && !isSensitiveRepositoryPath(repositoryPath);
      });
      if (selected.length > 4_000) throw new Error("This folder has more than 4,000 source files. Use the Electron app for large repositories.");
      const firstPath = selected[0]?.webkitRelativePath || selected[0]?.name || "repository";
      const rootName = firstPath.split("/")[0] || "repository";
      const imported: ImportedRepositoryFile[] = await Promise.all(selected.map(async (file) => {
        const rawPath = file.webkitRelativePath || file.name;
        const parts = rawPath.split("/");
        const path = parts.length > 1 ? parts.slice(1).join("/") : rawPath;
        return { path, content: await file.text() };
      }));
      const opened = await api.importFolder(rootName, imported);
      setProject(opened);
      setNotice(`Project Knowledge ready · ${String(opened.indexedFiles)} files · ${String(opened.symbols)} symbols · ${String(opened.graphEdges)} structural relationships. Original files were not modified.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not import the selected folder.");
    } finally {
      setBusy(false);
      if (folderInput.current !== null) folderInput.current.value = "";
    }
  };
  const submit = async () => { if (project === undefined || input.trim() === "" || runInProgress) return; setBusy(true); setNotice(""); try { const next = intent === "task" ? await api.startTask(project.id, input, planOnly, permissions, depth) : await api.startRun(project.id, intent, input, depth); setActiveRun(next); setRun(undefined); setSelectedEvidence(undefined); setTab(intent === "task" ? "task" : "verdict"); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not start Conclave."); } finally { setBusy(false); } };
  const cancelRun = async () => { if (activeRun === undefined || activeRun.status === "completed") return; try { setActiveRun(await api.cancelRun(activeRun.id)); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not cancel this analysis."); } };
  const explore = async (symbol: string) => { if (project === undefined) return; try { const next = await api.graph(project.id, symbol); setRun((current) => current === undefined ? current : { ...current, graph: next }); setTab("graph"); } catch (error) { setNotice(error instanceof Error ? error.message : "Graph lookup failed."); } };
  const permissionChange = (key: keyof Permissions, value: boolean) => setPermissions((current) => ({ ...current, [key]: value, ...(key === "allowCommands" && !value ? { allowRepositoryScripts: false, allowNetwork: false } : {}), ...(key === "allowRepositoryScripts" && !value ? { allowNetwork: false } : {}) }));
  const showResults = tab !== "settings" && tab !== "review" && tab !== "decide" && run !== undefined;
  const activeNav = tab === "settings" || tab === "graph" || tab === "review" || tab === "decide" ? tab : intent;

  if (runInProgress) {
    return <main className="app-shell"><section className="workspace"><header className="topbar"><div className="project-title">{project === undefined ? <span>Understanding repository…</span> : <><span className="project-dot" /><div><strong>{project.name}</strong><span>{project.path}</span></div></>}</div><div className="topbar-meta"><div className="mode-badge online"><i />Analysis active</div></div></header><div className="content"><RunProgress job={activeRun} onCancel={() => void cancelRun()} /></div></section></main>;
  }

  return <main className="app-shell"><aside className="sidebar"><div className="window-controls" aria-hidden="true"><i /><i /><i /></div><div className="brand"><span className="mark"><span>C</span></span><div><strong>Conclave</strong><small>Evidence before confidence</small></div></div><nav aria-label="Workspace navigation"><span className="nav-section-label">Workspace</span><button type="button" className={activeNav === "ask" ? "active" : ""} aria-current={activeNav === "ask" ? "page" : undefined} onClick={() => setActiveIntent("ask")}><Icon name="ask" /><span>Ask</span></button><button type="button" className={activeNav === "investigate" ? "active" : ""} aria-current={activeNav === "investigate" ? "page" : undefined} onClick={() => setActiveIntent("investigate")}><Icon name="investigate" /><span>Investigate</span></button><button type="button" className={activeNav === "task" ? "active" : ""} aria-current={activeNav === "task" ? "page" : undefined} onClick={() => setActiveIntent("task")}><Icon name="task" /><span>Task</span></button><button type="button" className={activeNav === "review" ? "active" : ""} aria-current={activeNav === "review" ? "page" : undefined} onClick={() => setTab("review")}><Icon name="verdict" /><span>Review</span></button><button type="button" className={activeNav === "decide" ? "active" : ""} aria-current={activeNav === "decide" ? "page" : undefined} onClick={() => setTab("decide")}><Icon name="investigate" /><span>Decide</span></button><span className="nav-section-label secondary">Explore</span><button type="button" className={activeNav === "graph" ? "active" : ""} aria-current={activeNav === "graph" ? "page" : undefined} onClick={() => setTab("graph")}><Icon name="graph" /><span>Graph</span></button><section className="sidebar-bottom"><button type="button" className={`settings-button ${activeNav === "settings" ? "active" : ""}`} aria-current={activeNav === "settings" ? "page" : undefined} onClick={() => setTab("settings")}><Icon name="settings" /><span>Settings</span></button><section className="repo-card"><div className="repo-summary"><span className="repo-icon"><Icon name="repo" /></span><div>{project === undefined ? <><strong>Opening project…</strong><small>Please wait</small></> : <><strong>Current repository</strong><small>{project.indexedFiles} files · {project.gitStatus}</small></>}</div><Icon name="chevron" size={14} /></div><button type="button" className="demo-button" onClick={() => void openDemo()} disabled={busy}>Open deterministic demo</button><button type="button" className="local-project-button" onClick={() => void chooseRepository()} disabled={busy}><Icon name="folder" size={14} />{busy ? "Opening…" : "Choose repository"}</button><input ref={folderInput} className="folder-picker-input" type="file" multiple aria-label="Repository folder" onChange={(event) => void importRepository(event.target.files)} /></section></section></nav></aside><section className="workspace"><header className="topbar"><div className="project-title">{project === undefined ? <span>Opening project…</span> : <><span className="project-dot" /><div><strong>{project.name}</strong><span>{project.path}</span></div></>}</div><button type="button" className="topbar-open" aria-label="Choose repository" onClick={() => void chooseRepository()} disabled={busy}><Icon name="folder" size={16} /></button><div className="topbar-meta">{project !== undefined && <div className="project-stats"><span>{project.symbols} symbols</span><i /><span>{project.graphNodes} nodes</span></div>}<div className={`mode-badge ${runtime?.available ? "online" : "demo"}`}><i />{runtime?.active === "local" ? "Local model" : runtime?.available ? "Server ready" : "Demo ready"}</div></div></header><div className="content">{notice !== "" && <div className="notice" role="status"><Icon name="info" size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}><Icon name="x" size={15} /></button></div>}<section hidden={tab === "settings" || tab === "review" || tab === "decide"} className={`composer intent-${intent}`} aria-label="Conclave composer"><div className="composer-header"><div className="composer-heading"><span className="composer-icon"><Icon name={intent === "ask" ? "ask" : intent === "investigate" ? "investigate" : "task"} size={19} /></span><div><span className="eyebrow">{modeCopy.eyebrow}</span><h1>{modeCopy.title}</h1><p>{modeCopy.detail}</p></div></div>{project !== undefined && <span className="context-pill"><span className="context-dot" />Indexed context</span>}</div><label className="sr-only" htmlFor="query">Question or task</label><textarea id="query" value={input} placeholder={intent === "task" ? "Describe the outcome you want…" : "Ask anything about this repository…"} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }} rows={4} /><AnalysisDepthSelector value={depth} onChange={setDepth} disabled={busy || runInProgress} />{intent === "task" && <fieldset className="permissions"><legend>Task permissions</legend><div className="permission-list"><label className="permission-row"><span><strong>Plan only</strong><small>Create a verified plan without modifying files.</small></span><input aria-label="Plan only — no mutation" type="checkbox" checked={planOnly} onChange={(event) => setPlanOnly(event.target.checked)} /></label><label className="permission-row"><span><strong>Scoped file edits</strong><small>Write only to files included in the verified scope.</small></span><input aria-label="Allow scoped file edits" type="checkbox" checked={permissions.allowFileEdits} disabled={planOnly} onChange={(event) => permissionChange("allowFileEdits", event.target.checked)} /></label><label className="permission-row"><span><strong>Static checks</strong><small>Run bounded, non-repository validation commands.</small></span><input aria-label="Allow static checks" type="checkbox" checked={permissions.allowCommands} disabled={planOnly} onChange={(event) => permissionChange("allowCommands", event.target.checked)} /></label><label className="permission-row danger"><span><strong>Repository scripts</strong><small>Execute code provided by this repository.</small></span><input aria-label="Allow repository scripts" type="checkbox" checked={permissions.allowRepositoryScripts} disabled={planOnly || !permissions.allowCommands} onChange={(event) => permissionChange("allowRepositoryScripts", event.target.checked)} /></label><label className="permission-row danger"><span><strong>Network access</strong><small>Allow repository scripts to reach the network.</small></span><input aria-label="Allow network" type="checkbox" checked={permissions.allowNetwork} disabled={planOnly || !permissions.allowRepositoryScripts} onChange={(event) => permissionChange("allowNetwork", event.target.checked)} /></label></div><p className="warning"><Icon name="info" size={14} />Repository scripts execute repository code and are not fully sandboxed. They remain disabled by default.</p></fieldset>}<div className="composer-footer"><span className="keyboard-hint"><kbd>⌘</kbd><kbd>↵</kbd> to run</span><button type="button" className="run-button" onClick={() => void submit()} disabled={busy || project === undefined || input.trim() === ""}>{busy ? <><span className="spinner" />Working…</> : <><Icon name="spark" size={16} />{intent === "task" ? (planOnly ? "Create verified plan" : "Run bounded task") : `Run ${intent}`}</>}</button></div></section>{tab === "review" ? <ReviewWorkspace project={project} depth={depth} onDepthChange={setDepth} onNotice={setNotice} /> : tab === "decide" ? <DecideWorkspace project={project} depth={depth} onDepthChange={setDepth} onNotice={setNotice} /> : tab === "settings" ? <ConfigurationPanel runtime={runtime} onRuntimeChange={setRuntime} /> : !showResults ? <WelcomeState intent={intent} /> : <><div className="result-toolbar"><div className="result-tabs" role="tablist" aria-label="Result views"><button role="tab" aria-selected={tab === "verdict"} onClick={() => setTab("verdict")}><Icon name="verdict" size={14} />Verdict</button><button role="tab" aria-selected={tab === "evidence"} onClick={() => setTab("evidence")}><Icon name="evidence" size={14} />Evidence <span>{run.evidence.length}</span></button><button role="tab" aria-selected={tab === "graph"} onClick={() => setTab("graph")}><Icon name="graph" size={14} />Graph</button><button role="tab" aria-selected={tab === "retrieval"} onClick={() => setTab("retrieval")}><Icon name="retrieval" size={14} />Retrieval</button>{run.intent === "task" && <button role="tab" aria-selected={tab === "task"} onClick={() => setTab("task")}><Icon name="task" size={14} />Task workspace</button>}</div><span className="run-status"><i />Run complete</span></div>{run.error !== undefined ? <section className="error-card"><span>Error · {run.error.code}</span><h2>{run.title}</h2><p>{run.error.message}</p><p>{run.error.action}</p></section> : tab === "verdict" ? <section className="verdict"><header><div><span className={`verdict-status ${run.status}`}><i />{statusLabel(run.status)}</span><h2>{run.title}</h2></div></header><section className="conclusion-section"><span className="eyebrow">Conclusion</span><div className="answer"><span className="answer-icon"><Icon name="spark" /></span><p>{run.answer}</p></div></section><Claims run={run} onEvidence={(id) => { setSelectedEvidence(id); setTab("evidence"); }} />{run.suggestedNextAction !== undefined && <section className="next-action"><span className="eyebrow">Suggested next action</span><p>{run.suggestedNextAction}</p></section>}<TechnicalDetails run={run} /></section> : tab === "evidence" ? <EvidencePanel evidence={run.evidence} selected={selectedEvidence} onSelect={setSelectedEvidence} /> : tab === "graph" ? <GraphPanel graph={run.graph} onSearch={(value) => void explore(value)} /> : tab === "retrieval" ? <RetrievalPanel run={run} /> : <TaskPanel run={run} />}</>}</div></section></main>;
}
