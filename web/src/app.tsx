import { useEffect, useMemo, useState } from "react";

import type {
  EvidenceView,
  GraphView,
  ProductIntent,
  ProductRunView,
  ProjectView,
  RuntimeModeView,
  ValidationRequestView,
  ValidationRunView,
} from "../../src/web/contracts.js";
import { api } from "./api.js";

const DEFAULT_VALIDATE = "Verify that this change resolves its stated objective without unrelated regressions.";
const DEFAULT_ASK = "Where is bootstrapSession called?";
const DEFAULT_INVESTIGATE = "Why might authentication disappear after refresh?";
const DEFAULT_TASK = "Fix authentication disappearing after refresh.";

type WorkspaceTab = "verdict" | "findings" | "claims" | "impact" | "raw" | "evidence" | "graph" | "retrieval" | "task" | "settings";
type Permissions = { allowFileEdits: boolean; allowCommands: boolean; allowRepositoryScripts: boolean; allowNetwork: boolean };

function statusLabel(status: string): string { return status.replaceAll("-", " ").toUpperCase(); }

function IntentButton({ intent, active, onSelect }: { readonly intent: ProductIntent; readonly active: boolean; readonly onSelect: (intent: ProductIntent) => void }) {
  return <button type="button" className={`intent-button ${active ? "active" : ""}`} aria-pressed={active} onClick={() => onSelect(intent)}>{intent === "validate" ? "Validate" : intent === "ask" ? "Ask" : intent === "investigate" ? "Investigate" : "Task"}</button>;
}

function Empty({ title, detail }: { readonly title: string; readonly detail: string }) {
  return <section className="empty"><h2>{title}</h2><p>{detail}</p></section>;
}

function EvidencePanel({ evidence, selected, onSelect }: { readonly evidence: readonly EvidenceView[]; readonly selected: string | undefined; readonly onSelect: (id: string) => void }) {
  const current = evidence.find((item) => item.id === selected) ?? evidence[0];
  if (current === undefined) return <Empty title="No evidence yet" detail="Run an Ask, Investigate, or Task workflow to inspect bounded repository evidence." />;
  return <section className="evidence-layout" aria-label="Evidence viewer"><div className="evidence-list">{evidence.map((item) => <button type="button" className={`evidence-link ${current.id === item.id ? "selected" : ""}`} onClick={() => onSelect(item.id)} key={item.id}><span>{item.path}</span><small>{item.startLine}–{item.endLine}{item.symbol === undefined ? "" : ` · ${item.symbol}`}</small></button>)}</div><article className="code-card"><header><span>{current.path}</span><span>lines {current.startLine}–{current.endLine}</span></header><pre><code>{current.excerpt}</code></pre><footer>Provenance: {current.origin}</footer></article></section>;
}

function Claims({ run, onEvidence }: { readonly run: ProductRunView; readonly onEvidence: (id: string) => void }) {
  if (run.claims.length === 0) return <Empty title="No verified claims" detail="Conclave did not accept a claim for this run." />;
  return <div className="claims">{run.claims.map((claim) => <article className={`claim ${claim.status}`} key={claim.id}><header><span className="claim-status" aria-label={claim.status}>{claim.status === "supported" ? "✓ supported" : claim.status === "rejected" ? "× rejected" : "? uncertain"}</span><span>{claim.role}</span></header><p>{claim.statement}</p><footer>{claim.evidenceIds.map((id) => <button type="button" onClick={() => onEvidence(id)} key={id}>Evidence</button>)}<span>{claim.challengeCount} challenges · {claim.verificationCount} verifications</span></footer></article>)}</div>;
}

function GraphPanel({ graph, onSearch }: { readonly graph: GraphView; readonly onSearch: (value: string) => void }) {
  const [symbol, setSymbol] = useState(graph.query);
  useEffect(() => setSymbol(graph.query), [graph.query]);
  return <section className="graph-panel" aria-label="Graph explorer"><form onSubmit={(event) => { event.preventDefault(); onSearch(symbol); }}><label htmlFor="graph-symbol">Scoped symbol</label><div><input id="graph-symbol" value={symbol} onChange={(event) => setSymbol(event.target.value)} /><button type="submit">Explore</button></div></form><p className="muted">{graph.message ?? `${String(graph.nodes.length)} bounded nodes · ${String(graph.edges.length)} relations`}</p><div className="graph-canvas">{graph.nodes.map((node) => <div className="graph-node" key={node.id}><strong>{node.label}</strong><small>{node.path}</small></div>)}</div><div className="graph-edges">{graph.edges.map((edge) => <div key={edge.id}><span>{edge.relation}</span><small>{edge.provenance} · {edge.from.slice(0, 8)} → {edge.to.slice(0, 8)}</small></div>)}</div></section>;
}

function RetrievalPanel({ run }: { readonly run: ProductRunView }) {
  return <section className="retrieval-panel"><h2>Retrieval inspector</h2><p className="muted">Why these evidence units, not a larger context dump.</p><ul>{run.retrieval.operations.map((item, index) => <li key={`${item.label}-${String(index)}`}><span>{item.status === "executed" ? "✓" : "○"}</span>{item.label} <small>{item.status}</small></li>)}</ul><dl><div><dt>Evidence</dt><dd>{run.retrieval.evidenceCount}</dd></div><div><dt>Source bytes</dt><dd>{run.retrieval.sourceBytes}</dd></div><div><dt>Approx. tokens</dt><dd>{run.retrieval.approximateTokens}</dd></div></dl></section>;
}

function TaskPanel({ run }: { readonly run: ProductRunView }) {
  const task = run.task;
  if (task === undefined) return <Empty title="No task state" detail="Select Task mode to request an explicit plan or bounded execution." />;
  return <section className="task-panel"><div className="task-column"><h2>Plan</h2><p>{task.plan.summary}</p><h3>Requirements</h3><ul>{task.plan.requirements.map((item) => <li key={item}>{item}</li>)}</ul><h3>Expected files</h3>{task.plan.steps.map((step) => <div className="step" key={step.description}><strong>{step.description}</strong><span>{step.files.join(", ")}</span></div>)}</div><div className="task-column"><h2>Actual progress</h2><ol className="progress">{task.progress.map((item) => <li className={item.state} key={item.stage}><strong>{item.stage}</strong><span>{item.detail}</span></li>)}</ol><h3>Verification</h3><p>{task.revisionRounds} revision round{task.revisionRounds === 1 ? "" : "s"}</p>{task.checks.length === 0 ? <p className="muted">No repository code checks were permitted.</p> : task.checks.map((check) => <p key={check.id}>{check.status}: {check.kind} — {check.reason}</p>)}</div><div className="task-column diff"><h2>Final isolated patch</h2><p className="muted">This patch has not modified the original repository.</p>{task.diff.length === 0 ? <p className="muted">No isolated patch was produced.</p> : task.diff.map((file, index) => <article key={`${file.path}-${String(index)}`}><header><strong>{file.path}</strong><span>+{file.additions} / −{file.deletions}</span></header>{!file.expected && <p className="warning">Unexpected file — review required.</p>}<pre><code>{file.patch}</code></pre></article>)}</div></section>;
}


function ValidationTabs({ tab, onSelect }: { readonly tab: WorkspaceTab; readonly onSelect: (tab: WorkspaceTab) => void }) {
  const tabs: readonly { readonly id: WorkspaceTab; readonly label: string }[] = [
    { id: "verdict", label: "Summary" },
    { id: "findings", label: "Findings" },
    { id: "claims", label: "Claims" },
    { id: "impact", label: "Impact" },
    { id: "raw", label: "Raw report" },
  ];
  return <div className="result-tabs validation-tabs" role="tablist" aria-label="Validation result views">{tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}</div>;
}

function ValidationSummary({ result }: { readonly result: ValidationRunView }) {
  const report = result.report;
  const trust = report.trustBoundary;
  const claimCopy = result.counts.totalClaims === 0
    ? "No explicit claims"
    : `${String(result.counts.supportedClaims)}/${String(result.counts.totalClaims)} claims proved`;
  return <section className={`validation-summary validation-${result.verdict}`} aria-label="Validation summary">
    <header className="decision-header"><span className="decision-kicker">Independent verdict</span><div><span className={`decision-badge ${result.verdict}`}>{result.verdict.toUpperCase()}</span>{result.demo && <span className="demo-badge">DEMO FIXTURE</span>}</div><h2>{result.headline}</h2><p>{result.explanation}</p></header>
    <div className="decision-metrics">
      <article><strong>{report.metrics.filesChanged}</strong><span>files changed</span></article>
      <article><strong>{report.metrics.impactedFiles}</strong><span>files impacted</span></article>
      <article><strong>{result.counts.blocking}</strong><span>blocking findings</span></article>
      <article><strong>{claimCopy}</strong><span>completion evidence</span></article>
    </div>
    <section className={`largest-risk ${result.largestRisk?.severity ?? "clear"}`}>
      <span>Largest remaining risk</span>
      <h3>{result.largestRisk?.title ?? "No deterministic risk found"}</h3>
      <p>{result.largestRisk?.detail ?? "The graph and contract checks found no unresolved contradiction in the collected change."}</p>
    </section>
    <div className="recommendation"><strong>Recommendation</strong><p>{result.recommendation}</p></div>
    <footer className="validation-footnote">
      <p>Objective: {report.objective}</p>
      <p>Knowledge: {trust.knowledge.parser} parser, {trust.knowledge.graph} graph, {trust.knowledge.embedding.kind} embeddings. Reasoning model calls: {trust.reasoningModelCalls}; remote embedding calls: {trust.knowledge.embedding.remoteCalls}; repository scripts: not executed.</p>
      <p>Guarantee: this is deterministic structural evidence, not proof of arbitrary runtime behavior.</p>
    </footer>
  </section>;
}

function ValidationFindings({ result }: { readonly result: ValidationRunView }) {
  if (result.report.findings.length === 0) return <Empty title="No findings" detail="Conclave found no deterministic contradiction or graph risk in this change." />;
  return <section className="validation-list" aria-label="Validation findings">{result.report.findings.map((finding) => <article className={`finding-card ${finding.severity}`} key={finding.id}><header><span>{finding.severity}</span><small>{finding.kind}</small></header><h2>{finding.title}</h2><p>{finding.detail}</p><div className="remediation"><strong>Next action</strong><p>{finding.remediation}</p></div>{finding.evidence.length > 0 && <ul>{finding.evidence.map((item, index) => <li key={`${item.path}-${String(index)}`}><code>{item.path}</code>{item.startLine === undefined ? "" : `:${String(item.startLine)}`}{item.symbol === undefined ? "" : ` · ${item.symbol}`}<small>{item.reason}</small></li>)}</ul>}</article>)}</section>;
}

function ValidationClaims({ result }: { readonly result: ValidationRunView }) {
  if (result.report.claims.length === 0) return <Empty title="No explicit completion claims" detail="The structural review still ran. Add a validation contract to challenge concrete agent claims." />;
  return <section className="validation-list" aria-label="Validation claims">{result.report.claims.map((item) => <article className={`claim-card ${item.outcome}`} key={item.claim.id}><header><span>{item.outcome}</span><small>{item.claim.check.kind}</small></header><h2>{item.claim.statement}</h2><p>{item.explanation}</p>{item.evidence.length > 0 && <ul>{item.evidence.map((evidence, index) => <li key={`${evidence.path}-${String(index)}`}><code>{evidence.path}</code>{evidence.startLine === undefined ? "" : `:${String(evidence.startLine)}`}<small>{evidence.reason}</small></li>)}</ul>}</article>)}</section>;
}

function ValidationImpact({ result }: { readonly result: ValidationRunView }) {
  const report = result.report;
  return <section className="impact-view" aria-label="Change impact">
    <div className="impact-metrics"><article><strong>{report.metrics.symbolsChanged}</strong><span>symbols changed</span></article><article><strong>{report.metrics.impactedSymbols}</strong><span>symbols impacted</span></article><article><strong>{report.metrics.graphEdgesInspected}</strong><span>graph relations inspected</span></article><article><strong>{report.metrics.deterministicChecks}</strong><span>deterministic checks</span></article></div>
    <div className="impact-columns"><article><h2>Changed files</h2><ul>{report.changeSet.files.map((file) => <li key={file.path}><code>{file.path}</code><span>{file.status}</span></li>)}</ul></article><article><h2>Impacted files</h2><ul>{report.impact.impactedFiles.map((path) => <li key={path}><code>{path}</code></li>)}</ul></article></div>
    <details><summary>Impacted symbols ({report.impact.impactedSymbols.length})</summary><div className="symbol-cloud">{report.impact.impactedSymbols.map((symbol) => <code key={symbol}>{symbol}</code>)}</div></details>
  </section>;
}

function ValidationWorkspace({ result, tab, onSelect }: { readonly result: ValidationRunView; readonly tab: WorkspaceTab; readonly onSelect: (tab: WorkspaceTab) => void }) {
  return <><ValidationTabs tab={tab} onSelect={onSelect} />{tab === "findings" ? <ValidationFindings result={result} /> : tab === "claims" ? <ValidationClaims result={result} /> : tab === "impact" ? <ValidationImpact result={result} /> : tab === "raw" ? <section className="raw-report" aria-label="Raw validation report"><header><h2>Machine-readable report</h2><p>The UI above is derived from this exact object.</p></header><pre><code>{JSON.stringify(result.report, null, 2)}</code></pre></section> : <ValidationSummary result={result} />}</>;
}

function ConfigurationPanel({ runtime }: { readonly runtime: RuntimeModeView | undefined }) {
  if (runtime === undefined) return <Empty title="Configuration unavailable" detail="The server runtime has not responded yet." />;
  return <section className="retrieval-panel configuration-panel" aria-label="Provider and role configuration"><h2>Provider and role configuration</h2><p className="muted">Configuration belongs to the local server. Browser code never receives provider credentials.</p><div className="provider-grid"><article className={runtime.active === "free" ? "active" : ""}><strong>Free Mode</strong><p>Hosted free access is not enabled in this local-first release.</p></article><article className={runtime.active === "api" ? "active" : ""}><strong>API Mode</strong><p>Configure an API key in the server environment; it remains unavailable to the browser.</p></article><article className={runtime.active === "local" ? "active" : ""}><strong>Local Mode</strong><p>Configure an OpenAI-compatible local endpoint in the server environment.</p></article></div><dl><div><dt>Active mode</dt><dd>{runtime.active}</dd></div><div><dt>Server configured</dt><dd>{runtime.available ? "yes" : "no"}</dd></div></dl><p className="warning">Role prompts and model settings are server-owned in Phase 5; changing them from the browser is intentionally unsupported.</p></section>;
}

export function App() {
  const [project, setProject] = useState<ProjectView>();
  const [runtime, setRuntime] = useState<RuntimeModeView>();
  const [intent, setIntent] = useState<ProductIntent>("validate");
  const [input, setInput] = useState(DEFAULT_VALIDATE);
  const [run, setRun] = useState<ProductRunView>();
  const [validationRun, setValidationRun] = useState<ValidationRunView>();
  const [sourceKind, setSourceKind] = useState<ValidationRequestView["source"]["kind"]>("branch");
  const [sourceRef, setSourceRef] = useState("master");
  const [contractText, setContractText] = useState("");
  const [tab, setTab] = useState<WorkspaceTab>("verdict");
  const [selectedEvidence, setSelectedEvidence] = useState<string>();
  const [localPath, setLocalPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [planOnly, setPlanOnly] = useState(true);
  const [permissions, setPermissions] = useState<Permissions>({ allowFileEdits: false, allowCommands: false, allowRepositoryScripts: false, allowNetwork: false });

  const openDemo = async () => { setBusy(true); try { const opened = await api.demo(); setProject(opened); setNotice("Demo Mode uses deterministic repository and change fixtures. Validation makes no model call."); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not open Demo Mode."); } finally { setBusy(false); } };
  useEffect(() => { void api.runtime().then(setRuntime).catch(() => undefined); void openDemo(); }, []);
  const modeCopy = useMemo(() => intent === "validate" ? "Independent change verdict" : intent === "ask" ? "Evidence-backed answer" : intent === "investigate" ? "Structured causal analysis" : "Explicit isolated code change", [intent]);
  const setActiveIntent = (next: ProductIntent) => { setIntent(next); setInput(next === "validate" ? DEFAULT_VALIDATE : next === "ask" ? DEFAULT_ASK : next === "investigate" ? DEFAULT_INVESTIGATE : DEFAULT_TASK); setTab(next === "task" ? "task" : "verdict"); };
  const openLocal = async () => { if (localPath.trim() === "") return; setBusy(true); try { setProject(await api.open(localPath)); setNotice("Local project indexed through the server boundary."); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not open local folder."); } finally { setBusy(false); } };
  const submit = async () => {
    if (project === undefined) return;
    setBusy(true);
    setNotice("");
    try {
      if (intent === "validate") {
        let source: ValidationRequestView["source"];
        if (sourceKind === "branch") source = { kind: "branch", base: sourceRef.trim() };
        else if (sourceKind === "commit") source = { kind: "commit", commit: sourceRef.trim() };
        else source = { kind: sourceKind };
        const next = await api.validate(project.id, source, input, contractText);
        setValidationRun(next);
        setTab("verdict");
      } else {
        const next = intent === "task"
          ? await api.task(project.id, input, planOnly, permissions)
          : await api.run(project.id, intent, input);
        setRun(next);
        setSelectedEvidence(next.evidence[0]?.id);
        setTab(intent === "task" ? "task" : "verdict");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not start Conclave.");
    } finally {
      setBusy(false);
    }
  };
  const explore = async (symbol: string) => { if (project === undefined) return; try { const next = await api.graph(project.id, symbol); setRun((current) => current === undefined ? current : { ...current, graph: next }); setTab("graph"); } catch (error) { setNotice(error instanceof Error ? error.message : "Graph lookup failed."); } };
  const permissionChange = (key: keyof Permissions, value: boolean) => setPermissions((current) => ({ ...current, [key]: value, ...(key === "allowCommands" && !value ? { allowRepositoryScripts: false, allowNetwork: false } : {}), ...(key === "allowRepositoryScripts" && !value ? { allowNetwork: false } : {}) }));
  const showResults = tab !== "settings" && run !== undefined;

  return <main className="app-shell"><aside className="sidebar"><div className="brand"><span className="mark">C</span><div><strong>Conclave</strong><small>AI writes. Conclave verifies.</small></div></div><nav aria-label="Workspace navigation"><button className={intent === "validate" ? "nav-active" : ""} onClick={() => setActiveIntent("validate")}>Validate</button><button onClick={() => setActiveIntent("ask")}>Ask</button><button onClick={() => setActiveIntent("investigate")}>Investigate</button><button onClick={() => setActiveIntent("task")}>Task</button><button onClick={() => setTab("graph")}>Graph</button><button disabled>History <small>soon</small></button><button onClick={() => setTab("settings")}>Settings <small>server</small></button></nav><section className="repo-picker"><h2>Repository</h2><button type="button" onClick={() => void openDemo()} disabled={busy}>Open deterministic demo</button><label htmlFor="local-folder">Local folder</label><div><input id="local-folder" placeholder="/path/to/repository" value={localPath} onChange={(event) => setLocalPath(event.target.value)} /><button type="button" onClick={() => void openLocal()} disabled={busy}>Open</button></div><p>Local folders are validated by the server's allowed-root policy. No remote cloning is implied.</p></section></aside><section className="workspace"><header className="topbar"><div>{project === undefined ? <span>Opening project…</span> : <><strong>{project.name}</strong><span>{project.path}</span></>}</div><div className="mode-badge">{runtime?.active === "local" ? "LOCAL MODEL" : runtime?.available ? "SERVER CONFIGURED" : "DEMO READY"}</div></header>{notice !== "" && <div className="notice" role="status">{notice}</div>}<section className="composer" aria-label="Conclave composer"><div className="intent-switch"><IntentButton intent="validate" active={intent === "validate"} onSelect={setActiveIntent} /><IntentButton intent="ask" active={intent === "ask"} onSelect={setActiveIntent} /><IntentButton intent="investigate" active={intent === "investigate"} onSelect={setActiveIntent} /><IntentButton intent="task" active={intent === "task"} onSelect={setActiveIntent} /></div><div className="composer-title"><h1>{modeCopy}</h1><p>{intent === "validate" ? "Compare the actual Git change with its objective, claims, and project-wide graph impact." : intent === "task" ? "Task never starts from Ask or Investigate. Select permissions explicitly." : "The core returns bounded evidence, claims, verification, and a verdict."}</p></div><label className="sr-only" htmlFor="query">Question or task</label><textarea id="query" value={input} onChange={(event) => setInput(event.target.value)} rows={3} />{intent === "validate" && <><div className="validation-controls"><label htmlFor="change-source">Compare</label><select id="change-source" value={sourceKind} onChange={(event) => { const next = event.target.value as ValidationRequestView["source"]["kind"]; setSourceKind(next); if (next === "branch") setSourceRef("master"); else if (next === "commit") setSourceRef("HEAD"); }}><option value="branch">Current branch against base</option><option value="working">Working tree against HEAD</option><option value="staged">Staged changes</option><option value="commit">Checked-out commit</option></select>{(sourceKind === "branch" || sourceKind === "commit") && <><label htmlFor="source-ref">{sourceKind === "branch" ? "Base branch" : "Commit"}</label><input id="source-ref" value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} /></>}</div><details className="contract-editor"><summary>Optional contract: scope and completion claims</summary><p>Paste the same JSON accepted by the CLI. The objective above takes precedence.</p><textarea aria-label="Optional validation contract" value={contractText} onChange={(event) => setContractText(event.target.value)} rows={7} placeholder={'{"allowedPathPrefixes":[],"claims":[]}'}/></details></>}{intent === "task" && <fieldset className="permissions"><legend>Task permissions</legend><label><input type="checkbox" checked={planOnly} onChange={(event) => setPlanOnly(event.target.checked)} /> Plan only — no mutation</label><label><input type="checkbox" checked={permissions.allowFileEdits} disabled={planOnly} onChange={(event) => permissionChange("allowFileEdits", event.target.checked)} /> Allow scoped file edits</label><label><input type="checkbox" checked={permissions.allowCommands} disabled={planOnly} onChange={(event) => permissionChange("allowCommands", event.target.checked)} /> Allow static checks</label><label className="danger"><input type="checkbox" checked={permissions.allowRepositoryScripts} disabled={planOnly || !permissions.allowCommands} onChange={(event) => permissionChange("allowRepositoryScripts", event.target.checked)} /> Allow repository scripts</label><label className="danger"><input type="checkbox" checked={permissions.allowNetwork} disabled={planOnly || !permissions.allowRepositoryScripts} onChange={(event) => permissionChange("allowNetwork", event.target.checked)} /> Allow network</label><p className="warning">Repository scripts execute repository code and are not fully sandboxed. They remain disabled by default.</p></fieldset>}<button type="button" className="run-button" onClick={() => void submit()} disabled={busy || project === undefined}>{busy ? "Working…" : intent === "validate" ? "Validate change" : intent === "task" ? (planOnly ? "Create verified plan" : "Run bounded task") : `Run ${intent}`}</button></section><section className="project-stats">{project !== undefined && <><span>{project.indexedFiles} files indexed</span><span>{project.symbols} symbols</span><span>{project.graphNodes} graph nodes</span><span>{project.graphEdges} graph edges</span></>}</section>{tab === "settings" ? <ConfigurationPanel runtime={runtime} /> : intent === "validate" ? (validationRun === undefined ? <Empty title="Validate the change, not the agent confidence" detail="Choose a Git comparison, describe the intended resolution, and run an independent deterministic review." /> : <ValidationWorkspace result={validationRun} tab={tab} onSelect={setTab} />) : !showResults ? <Empty title="Ask your code. Let the models argue." detail="Open the deterministic demo or a permitted local folder, then select an explicit intent." /> : <><div className="result-tabs" role="tablist" aria-label="Result views"><button role="tab" aria-selected={tab === "verdict"} onClick={() => setTab("verdict")}>Verdict</button><button role="tab" aria-selected={tab === "evidence"} onClick={() => setTab("evidence")}>Evidence</button><button role="tab" aria-selected={tab === "graph"} onClick={() => setTab("graph")}>Graph</button><button role="tab" aria-selected={tab === "retrieval"} onClick={() => setTab("retrieval")}>Retrieval</button>{run.intent === "task" && <button role="tab" aria-selected={tab === "task"} onClick={() => setTab("task")}>Task workspace</button>}</div>{run.error !== undefined ? <section className="error-card"><span>Error · {run.error.code}</span><h2>{run.title}</h2><p>{run.error.message}</p><p>{run.error.action}</p></section> : tab === "verdict" ? <section className="verdict"><header><span className={`verdict-status ${run.status}`}>{statusLabel(run.status)}</span><h2>{run.title}</h2></header><p className="answer">{run.answer}</p><Claims run={run} onEvidence={(id) => { setSelectedEvidence(id); setTab("evidence"); }} /><section className="trace"><h3>Bounded role route</h3>{run.trace.map((item) => <div key={item.role}><strong>{item.role}</strong><span>{item.status === "ran" ? "✓ ran" : "○ skipped"}</span><small>{item.reason}</small></div>)}</section><section className="metrics">{run.metrics.map((metric) => <div key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></div>)}</section></section> : tab === "evidence" ? <EvidencePanel evidence={run.evidence} selected={selectedEvidence} onSelect={setSelectedEvidence} /> : tab === "graph" ? <GraphPanel graph={run.graph} onSearch={(value) => void explore(value)} /> : tab === "retrieval" ? <RetrievalPanel run={run} /> : <TaskPanel run={run} />}</>}</section></main>;
}
