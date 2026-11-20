import { ActivityCosts, RecentAgentRuns } from "./activity-costs.js";
import { SetupGuide } from "./setup-guide.js";
import { ImprovementsPanel } from "./improvements-panel.js";
import { LoopIcon } from "./loop-icon.js";
import { ProblemLocationSection } from "./problem-location.js";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Problem, Solution, Vote } from "../domain/types.js";
import type { DashboardApi, DashboardData, Selection } from "./types.js";
import { ObjectiveForm } from "./objective-form.js";
import { Performance } from "./performance.js";
import { ExportSolution } from "./export-solution.js";
import "./styles.css";

type Tab = "problems" | "testing" | "established" | "performance";
const TABS: Array<{id:Tab;label:string}> = [{id:"problems",label:"Problems"},{id:"testing",label:"Testing"},{id:"established",label:"Established"},{id:"performance",label:"Performance"}];
const keyOf = (s: Selection) => `${s.kind}:${s.id}`;
const established = (s: Solution) => s.status === "active" || s.status === "proven";
const problemTitle = (p: Problem, data?: DashboardData|null) => data?.objectives?.find(o => o.problemId === p.id)?.title ?? p.causes[0]?.text ?? p.id;
const errorText = (e: unknown) => e instanceof Error ? e.message.slice(0,500) : "Something went wrong. Try again.";
function date(value: number): string { return Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}) : "Not recorded"; }
function money(micros: number, currency: string): string {
  if (!Number.isFinite(micros)) return "Unknown";
  try { return new Intl.NumberFormat(undefined,{style:"currency",currency,maximumFractionDigits:micros > 0 && micros < 10_000 ? 4 : 2}).format(micros/1_000_000); }
  catch { return `${(micros/1_000_000).toFixed(2)} ${currency}`; }
}
function safeUrl(value: string): string | null { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; } }
function Glyph({kind="loop"}:{kind?:"loop"|"problem"|"flask"|"check"|"chat"|"arrow"}) {
  const paths = { loop:"M19 7a8 8 0 0 0-13-2L3 8m0-5v5h5m-3 9a8 8 0 0 0 13 2l3-3m0 5v-5h-5", problem:"M12 8v5m0 3h.01M10.3 3.8 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.8a2 2 0 0 0-3.4 0", flask:"M9 3h6m-5 0v7L4 19a1.5 1.5 0 0 0 1.3 2h13.4a1.5 1.5 0 0 0 1.3-2l-6-9V3M7 16h10", check:"m5 12 4 4L19 6", chat:"M21 11a8 8 0 0 1-8 8H7l-5 3V11a9 9 0 0 1 19 0Z", arrow:"M5 12h14m-5-5 5 5-5 5" };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>;
}
function Badge({children,tone="neutral"}:{children:ReactNode;tone?:"neutral"|"good"|"warn"|"bad"}) { return <span className={`si-badge si-badge-${tone}`}>{children}</span>; }
const CANDIDATE_LABELS: Record<Solution["candidateState"], string> = { proposed: "Proposed", eligible: "Ready to test", deferred: "Waiting", rejected: "Not pursued", built: "Tested" };
function SolutionStatus({solution,inactive=false,applied}:{solution:Solution;inactive?:boolean;applied?:{enabled:boolean}}) {
  if (applied) return <Badge tone={applied.enabled?"good":"neutral"}>{applied.enabled?"Applied":"Disabled"}</Badge>;
  if (inactive && solution.status === "active") return <Badge tone="warn">From an earlier version · not applied</Badge>;
  if (inactive && solution.status === "proven") return <Badge>Earlier measured improvement</Badge>;
  if (solution.status === "proven") return <Badge tone="good">Measured improvement</Badge>;
  if (solution.status === "active") return <Badge>Active</Badge>;
  if (solution.status === "removed") return <Badge>Removed</Badge>;
  if (solution.status === "fixing") return <Badge tone="warn">Needs attention</Badge>;
  return <Badge tone={solution.candidateState === "rejected" ? "bad" : "neutral"}>{CANDIDATE_LABELS[solution.candidateState] ?? solution.candidateState}</Badge>;
}
function Empty({title,children}:{title:string;children:ReactNode}) { return <div className="si-empty"><span className="si-empty-mark"><Glyph/></span><h3>{title}</h3><p>{children}</p></div>; }

function Portability({declaration}:{declaration:Solution["portability"]}) {
  const headingId = useId();
  const requirementKinds = { capability:"Capability", plugin:"Plugin", skill:"Skill", configuration:"Configuration", provider:"Provider", environment:"Environment" };
  return <section aria-labelledby={headingId}>
    <h3 id={headingId}>Portability</h3>
    <Badge>{declaration ? "Unverified declaration" : "Unknown · no declaration"}</Badge>
    {declaration && <><h4>Declared scope</h4><p>{declaration.scope}</p></>}
    <h4>Requires</h4>
    {!declaration ? <p>Requirements are unknown. This record has no portability declaration.</p>
      : <>
        <p>{declaration.dependencyStatus === "none-known" ? "No dependencies are known to the proposer. This does not establish independence."
          : declaration.dependencyStatus === "unknown" ? "Dependency information is incomplete. Any known requirements are listed below."
          : "These requirements were declared by the proposer and have not been independently verified."}</p>
        {declaration.requirements.length > 0 && <ul className="si-prose-list">{declaration.requirements.map((requirement,index)=><li key={index}>
          <strong>{requirement.identity}</strong>
          <small>{requirementKinds[requirement.kind]} · {requirement.versionConstraint === null ? "Version requirement unknown" : `Version constraint: ${requirement.versionConstraint}`}</small>
          <p>{requirement.setup}</p>
        </li>)}</ul>}
      </>}
    <h4>Tested on</h4>
    <p>No verified environment is recorded.</p>
    <p className="si-section-note">The packaged artifact and its behavior still need to be checked in the claimed environment. A successful solution attempt or a recorded provider does not establish portability.</p>
    <h4>Not yet tested</h4>
    {declaration?.untestedConfigurations.length ? <ul className="si-prose-list">{declaration.untestedConfigurations.map((configuration,index)=><li key={index}>{configuration}</li>)}</ul>
      : <p>Untested configurations have not been specified.</p>}
    {declaration && <details className="si-metadata"><summary>Proposed portability checks</summary>
      <h4>Minimal environment</h4><p>{declaration.testProposal.minimalEnvironment}</p>
      <h4>Packaged artifact</h4><p>{declaration.testProposal.packagedArtifact}</p>
      <h4>Portability assumptions</h4>{declaration.assumptions.length ? <ul className="si-prose-list">{declaration.assumptions.map((assumption,index)=><li key={index}>{assumption}</li>)}</ul> : <p>No portability assumptions were declared.</p>}
    </details>}
    <p className="si-section-note">Ordinary BB, provider, user and workspace context may have been available during proposal generation. A declaration does not prove that all dependencies were disclosed.</p>
  </section>;
}


export function Dashboard({api,projectId,refreshKey,renderChat,onOpenThread,settings}:{
  api:DashboardApi; projectId:string|null; refreshKey:number; renderChat:(threadId:string)=>ReactNode; onOpenThread:(threadId:string)=>void;
  /** Execution settings: shown inside Get started until set up, then behind the header's Settings button. */
  settings?:ReactNode;
}) {
  const [data,setData] = useState<DashboardData|null>(null);
  const [settingsOpen,setSettingsOpen] = useState(false);
  const [loading,setLoading] = useState(true), [loadError,setLoadError] = useState("");
  const [tab,setTab] = useState<Tab>("problems"), [search,setSearch] = useState(""), [filter,setFilter] = useState("all");
  const [selection,setSelection] = useState<Selection|null>(null);
  const [busy,setBusy] = useState<Record<string,boolean>>({}), [messages,setMessages] = useState<Record<string,{text:string;error:boolean}>>({});
  const [queued,setQueued] = useState<Record<string,string>>({}), [chats,setChats] = useState<Record<string,string>>({});
  const [chatOpen,setChatOpen] = useState(false);
  const chatProjectId = data?.health.workerProjectId || projectId;
  useEffect(()=>setChatOpen(false),[chatProjectId]);
  const [intakeOpen,setIntakeOpen] = useState(false), [intakeNotice,setIntakeNotice] = useState("");
  const live = useRef(true), loadSequence = useRef(0), inFlight = useRef(new Set<string>());
  const detailRef = useRef<HTMLElement>(null), recordsRef = useRef<HTMLElement>(null);
  const id = useId();
  useEffect(() => { live.current=true; return () => { live.current=false; loadSequence.current++; }; },[]);
  const reload = useCallback(async () => {
    const sequence=++loadSequence.current; setLoading(true);
    try { const result=await api.dashboard({}); if (live.current && sequence===loadSequence.current) { setData(result); setLoadError(""); } }
    catch(e) { if(live.current && sequence===loadSequence.current)setLoadError(errorText(e)); }
    finally { if(live.current && sequence===loadSequence.current)setLoading(false); }
  },[api]);
  useEffect(() => { void reload(); },[reload,refreshKey]);
  const choose = (value:Selection) => { setSelection(value); setChatOpen(false); };
  const changeTab = (next:Tab) => { setTab(next); setFilter("all"); setSelection(null); setChatOpen(false); };
  const selectSolution = (s:Solution) => { setTab(established(s)?"established":"testing");setFilter("all");setSearch("");choose({kind:"solution",id:s.id}); };
  const selectProblem = (p:Problem) => { setTab("problems");setFilter("all");setSearch("");choose({kind:"problem",id:p.id}); };
  const selectedProblem = selection?.kind==="problem" ? data?.problems.find(p=>p.id===selection.id) : undefined;
  const selectedSolution = selection?.kind==="solution" ? data?.solutions.find(s=>s.id===selection.id) : undefined;
  const activeKey = selection ? `${chatProjectId??""}:${keyOf(selection)}` : "";
  const selectedChat = chats[activeKey];
  const retest = async (solution:Solution) => {
    const key=`retest:${solution.id}`; if(inFlight.current.has(key))return;
    const version=data?.versions[`solutions:${solution.id}`]; if(!version)return;
    inFlight.current.add(key);setBusy(x=>({...x,[key]:true}));setMessages(x=>({...x,[key]:{text:"",error:false}}));
    try {
      const result=await api.retest({solutionId:solution.id,expectedVersion:version,reason:"Requested from the solution dashboard"});
      if(live.current){setQueued(x=>({...x,[solution.id]:result.jobId}));setMessages(x=>({...x,[key]:{text:"Re-test queued. Earlier results are preserved.",error:false}}));}
    } catch(e) {if(live.current)setMessages(x=>({...x,[key]:{text:errorText(e),error:true}}));}
    finally {inFlight.current.delete(key);if(live.current){setBusy(x=>({...x,[key]:false}));void reload();}}
  };
  const startChat = async () => {
    if(!selection || !chatProjectId)return;
    const captured={...selection}, entityKey=`${chatProjectId}:${keyOf(captured)}`, key=`chat:${entityKey}`;
    if(inFlight.current.has(key))return;
    // The server owns conversation selection and privacy revocation. Resolve it
    // again on every open; a cached thread may belong to an older privacy policy.
    setChats(x=>{const next={...x};delete next[entityKey];return next;});
    inFlight.current.add(key);setBusy(x=>({...x,[key]:true}));setChatOpen(true);setMessages(x=>({...x,[key]:{text:"",error:false}}));
    try { const result=await api.startChat({...captured,projectId:chatProjectId});if(live.current)setChats(x=>({...x,[entityKey]:result.threadId})); }
    catch(e){if(live.current)setMessages(x=>({...x,[key]:{text:errorText(e),error:true}}));}
    finally{inFlight.current.delete(key);if(live.current)setBusy(x=>({...x,[key]:false}));}
  };
  const setupReady=!!data?.setup?.worker&&!!data?.setup?.model;
  const groups=useMemo(()=>data ? {problems:data.problems,testing:data.solutions.filter(s=>!established(s)),established:data.solutions.filter(established)} : {problems:[],testing:[],established:[]},[data]);
  const query=search.trim().toLocaleLowerCase();
  const items = tab==="problems" ? groups.problems.filter(p=>(filter==="all"||p.status===filter)&&[p.id,p.category,problemTitle(p,data??undefined),...p.causes.map(c=>c.text),...p.symptoms.map(s=>s.text)].join(" ").toLocaleLowerCase().includes(query))
    : tab==="performance" ? [] : groups[tab].filter(s=>(filter==="all"||(s.status??s.candidateState)===filter)&&[s.id,s.title,s.mechanism,...s.problemIds].join(" ").toLocaleLowerCase().includes(query));
  const filters=tab==="problems"?["open","monitoring","resolved"]:tab==="established"?["active","proven"]:["proposed","eligible","deferred","rejected","built","fixing","removed"];
  const unknown=data?.costs.totals.reduce((sum,t)=>sum+t.unknownAttempts+(t.unknownExternalCosts??0),0)??0;
  const selectedGone=selection && !selectedProblem && !selectedSolution;
  const title=selectedProblem?problemTitle(selectedProblem,data):selectedSolution?.title;
  useEffect(()=>{if(selection&&window.innerWidth<=760){detailRef.current?.focus({preventScroll:true});detailRef.current?.scrollIntoView?.({block:"start"});}},[selection,title]);
  return <main className="si-root" data-bb-plugin="self-improve" aria-label="Self improve ledgers">
    <header className="si-header"><div className="si-brand"><span className="si-brand-icon"><LoopIcon size={26}/></span><div><h1>Self improve</h1><p>Find patterns. Test ideas. Keep the evidence.</p></div></div><div className="si-header-actions">{data&&<Badge tone={data.health.issues.length?"warn":data.health.enabled?"good":"neutral"}>{data.health.issues.length?"Needs attention":data.health.enabled?"Learning enabled":"Learning paused"}</Badge>}{setupReady&&settings&&<button className="si-button si-button-quiet" aria-expanded={settingsOpen} onClick={()=>setSettingsOpen(open=>!open)}>Settings</button>}<button className="si-button si-button-quiet" onClick={()=>void reload()} disabled={loading}>{loading?"Refreshing…":"Refresh"}</button><button className="si-button si-button-primary" onClick={()=>{setIntakeOpen(true);setIntakeNotice("");}} disabled={intakeOpen}>Add problem / goal</button></div></header>
    {data&&<SetupGuide data={data} api={api} onQueued={()=>void reload()} settings={settings}/>}
    {settingsOpen&&setupReady&&<section className="si-settings-panel" aria-label="Self improve settings">{settings}</section>}
    {intakeOpen&&<ObjectiveForm api={api} onClose={()=>setIntakeOpen(false)} onCreated={recordId=>{setIntakeOpen(false);setIntakeNotice("Added to the ledger. It is ready to explore.");setTab("problems");setSearch("");setFilter("all");choose({kind:"problem",id:recordId});void reload();}}/>}
    {intakeNotice&&<p role="status" className="si-notice">{intakeNotice}</p>}
    {loadError&&<div className="si-notice si-notice-bad" role="alert"><span>{loadError}{data?" Showing the last loaded snapshot.":""}</span><button className="si-button" onClick={()=>void reload()}>Try again</button></div>}
    {!data ? <div className="si-loading" role="status">{loading?"Loading your learning history…":"The ledgers could not be loaded."}</div> : <>
      {data.health.issues.length>0&&<details className="si-health" open><summary>{data.health.issues.length} {data.health.issues.length===1?"thing needs":"things need"} your attention</summary><ul>{data.health.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul></details>}
      {!!data.health.notes?.length&&<details className="si-health si-health-notes"><summary>Notes about what Self improve can see</summary><ul>{data.health.notes.map((note,i)=><li key={i}>{note}</li>)}</ul></details>}
      <section className="si-metrics" aria-label="Ledger summary">
        <div><span className="si-metric-label"><Glyph kind="problem"/>Problems and goals</span><strong>{groups.problems.length}</strong><small>Observed patterns and owner requests</small></div>
        <div><span className="si-metric-label"><Glyph kind="flask"/>Solutions to explore</span><strong>{groups.testing.length}</strong><small>Proposals, tests and retained history</small></div>
        <div><span className="si-metric-label"><Glyph kind="check"/>Established solutions</span><strong>{groups.established.length}</strong><small>{groups.established.filter(s=>s.status==="proven").length} with measured improvement</small></div>
        <div><span className="si-metric-label">Tracked cost</span>{data.costs.totals.length?data.costs.totals.map(t=><strong className="si-cost-total" key={t.currency}>{money(t.reportedMicros+t.estimatedMicros,t.currency)}</strong>):<strong className="si-metric-empty">{data.costs.activity?.unknownBillingActivities ? "Billing unknown" : "No cost records yet"}</strong>}<small>Owner-reported charges + estimates{unknown>0?`; ${unknown} unknown`:""}{data.costs.pending?.length?`; ${data.costs.pending.length} pending`:""}</small>{(data.costs.unmeteredAccessRequests??0)>0&&<small>{data.costs.unmeteredAccessRequests} research access requests without per-request prices</small>}<ActivityCosts value={data.costs.activity}/></div>
      </section>
      <ImprovementsPanel data={data} api={api} onChanged={()=>void reload()}/>
      <RecentAgentRuns runs={data.costs.recentRuns} titles={Object.fromEntries(data.solutions.map(s=>[s.id,s.title]))}/>
      <div className="si-tabs" role="tablist" aria-label="Ledger view">{TABS.map((t,index)=><button key={t.id} id={`${id}-${t.id}`} role="tab" aria-selected={tab===t.id} aria-controls={`${id}-panel`} tabIndex={tab===t.id?0:-1} onClick={()=>changeTab(t.id)} onKeyDown={e=>{const next=e.key==="ArrowRight"?(index+1)%TABS.length:e.key==="ArrowLeft"?(index+TABS.length-1)%TABS.length:e.key==="Home"?0:e.key==="End"?TABS.length-1:null;if(next!==null){e.preventDefault();changeTab(TABS[next]!.id);document.getElementById(`${id}-${TABS[next]!.id}`)?.focus();}}}>{t.label}{t.id!=="performance"&&<span>{groups[t.id].length}</span>}</button>)}</div>
      <section id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="si-panel">
        {tab==="performance"?<Performance api={api} solutions={data.solutions} refreshKey={loadSequence.current}/>:<>
        <div className="si-toolbar"><label className="si-search"><span className="si-sr-only">Search ledgers</span><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search a problem, solution or ID…"/></label><label className="si-filter"><span>Status</span><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All statuses</option>{filters.map(f=><option key={f} value={f}>{f}</option>)}</select></label><span className="si-result-count">{items.length} {items.length===1?"record":"records"}</span></div>
        <div className={`si-workspace${chatOpen?" si-workspace-chat":""}`}>
          <aside ref={recordsRef} tabIndex={-1} className="si-records" aria-label={`${TABS.find(t=>t.id===tab)!.label} records`}>
            {!items.length ? query||filter!=="all" ? <Empty title="No matches">Try a different search, or <button className="si-link-button" onClick={()=>{setSearch("");setFilter("all");}}>Clear filters</button>.</Empty> : <Empty title={tab==="problems"?"No problems recorded yet":tab==="established"?"No established solutions yet":"No solution candidates yet"}>{tab==="problems"?"Use Find problems to look through your recent threads, or add a problem yourself.":tab==="established"?"Solutions appear here after validated adoption. Their measured efficacy stays visible separately.":"Paper scouting and zero-shot invention produce candidates for the build queue."}</Empty>
              : items.map(item=>"causes" in item ? <button className={`si-record${selectedProblem?.id===item.id?" si-record-selected":""}`} key={item.id} onClick={()=>choose({kind:"problem",id:item.id})} aria-label={`Open problem ${problemTitle(item,data)}`} aria-pressed={selectedProblem?.id===item.id}><div className="si-record-top"><span className="si-record-id">{item.id}</span><Badge tone={item.status==="resolved"?"good":"neutral"}>{item.status}</Badge></div><strong>{problemTitle(item,data)}</strong><p>{item.symptoms[0]?.text??"No symptom description recorded"}</p><footer><span>{item.category}</span><span>{item.solutionIds.length} linked {item.solutionIds.length===1?"solution":"solutions"}</span></footer></button>
                : <button className={`si-record${selectedSolution?.id===item.id?" si-record-selected":""}`} key={item.id} onClick={()=>choose({kind:"solution",id:item.id})} aria-label={`Open solution ${item.title}`} aria-pressed={selectedSolution?.id===item.id}><div className="si-record-top"><span className="si-record-id">{item.id}</span><SolutionStatus applied={data.improvements?.applied.find(a=>a.solutionId===item.id)} solution={item} inactive={!!data.activation?.[item.id]}/></div><strong>{item.title}</strong><p>{item.mechanism}</p><footer><span>{item.origin==="inventor"?"Invented":"From research"}</span><span>{item.attempts.length} {item.attempts.length===1?"attempt":"attempts"}</span></footer></button>)}
          </aside>
          <article ref={detailRef} tabIndex={-1} className="si-detail" aria-label="Selected record details">
            {selectedGone?<Empty title="This record changed">Refresh or choose another record to continue.</Empty>:!title?<Empty title="A little curiosity goes a long way">Choose a record to follow the evidence, explore related ideas, or start a conversation.</Empty>:<>
              <header className="si-detail-header"><button className="si-button si-button-quiet si-back-button" onClick={()=>{recordsRef.current?.focus({preventScroll:true});recordsRef.current?.scrollIntoView?.({block:"start"});}}>Back to records</button><div className="si-eyebrow">{selection?.kind==="problem"?"Problem":"Solution"} <span>{selection?.id}</span></div><h2>{title}</h2><div className="si-detail-actions">{selectedSolution&&<SolutionStatus applied={data.improvements?.applied.find(a=>a.solutionId===selectedSolution.id)} solution={selectedSolution} inactive={!!data.activation?.[selectedSolution.id]}/>}<button className="si-button si-button-primary" onClick={()=>void startChat()} disabled={!chatProjectId||!!busy[`chat:${activeKey}`]}><Glyph kind="chat"/>{busy[`chat:${activeKey}`]?"Opening chat…":"Explore and edit in chat"}</button>{!chatProjectId&&<span className="si-muted">Configure a worker project to start an editing chat.</span>}</div>{messages[`chat:${activeKey}`]?.text&&<p role="alert" className="si-action-error">{messages[`chat:${activeKey}`]!.text}</p>}</header>
              {selectedProblem&&<ProblemDetail api={api} problem={selectedProblem} data={data} selectSolution={selectSolution} onOpenThread={onOpenThread}/>}
              {selectedSolution&&<SolutionDetail key={selectedSolution.id} api={api} solution={selectedSolution} data={data} selectProblem={selectProblem} retest={()=>void retest(selectedSolution)} retestBusy={!!busy[`retest:${selectedSolution.id}`]} queuedJob={queued[selectedSolution.id]} message={messages[`retest:${selectedSolution.id}`]}/>}
            </>}
          </article>
          {chatOpen&&selection&&<section className="si-chat" aria-label="Editing chat"><header><span><Glyph kind="chat"/>Explore and edit</span><button className="si-button si-button-quiet" onClick={()=>setChatOpen(false)}>Close chat</button></header><p className="si-chat-context">{selection.kind==="problem"?"Problem":"Solution"}: {title??selection.id}. Edits are recorded; evidence and validation remain separate.</p><div className="si-native-chat">{selectedChat?renderChat(selectedChat):<p role="status" className="si-muted">{messages[`chat:${activeKey}`]?.error?"Chat could not open. Retry from the record.":"Preparing your conversation…"}</p>}</div></section>}
        </div>
        </>}
      </section>
      <footer className="si-page-footer"><span>{unknown>0?`${unknown} unknown cost ${unknown===1?"record":"records"}`:"Costs are tracked across the improvement loop."}</span></footer>
    </>}
  </main>;
}

function ProblemDetail({api,problem,data,selectSolution,onOpenThread}:{api:DashboardApi;problem:Problem;data:DashboardData;selectSolution:(s:Solution)=>void;onOpenThread:(id:string)=>void}) {
  const objective=data.objectives?.find(o=>o.problemId===problem.id);
  const votes=(data.votes??[]).filter(v=>v.problemId===problem.id).sort((a,b)=>b.occurredAtMs-a.occurredAtMs);
  return <div className="si-detail-body">
    {objective&&<section><h3>{objective.kind==="goal"?"Owner optimization goal":"Owner-reported problem"}</h3><p>{objective.description}</p><Badge>{objective.focus&&objective.focus.priority>0?"Owner focus":"Normal exploration"}</Badge>{objective.metric&&<dl className="si-kpi"><dt>{objective.metric.name}</dt><dd>Target {objective.metric.target} {objective.metric.unit} · {objective.metric.direction} is better</dd></dl>}<p className="si-section-note">This is an owner request. It does not count as observed failure evidence.</p></section>}
    <section><h3>What happened</h3><ul className="si-prose-list">{problem.symptoms.map(s=><li key={s.id}>{s.text}</li>)}</ul></section>
    <ProblemLocationSection api={api} problem={problem}/>
    <section><h3>Likely cause</h3><p className="si-section-note">A best guess from the evidence, not a confirmed cause.</p>{problem.causes.map(c=><div className="si-hypothesis" key={c.id}>{c.text}</div>)}</section>
    <section><h3>Linked solutions <span>{problem.solutionIds.length}</span></h3>{problem.solutionIds.length?<div className="si-linked-list">{problem.solutionIds.map(id=>{const s=data.solutions.find(s=>s.id===id);return s?<button key={id} className="si-linked" aria-label={`View solution ${s.title}`} onClick={()=>selectSolution(s)}><span>{s.title}<small>{s.origin==="inventor"?"Invented hypothesis":"Research-inspired hypothesis"}</small></span><Glyph kind="arrow"/></button>:<p key={id} className="si-muted">{id} · record unavailable</p>;})}</div>:<p className="si-muted">No solution is linked yet.</p>}</section>
    <section><h3>Evidence <span>{votes.length}</span></h3>{data.votes===undefined?<p className="si-muted">Evidence pointers were not included in this snapshot.</p>:!votes.length?<p className="si-muted">No vote evidence recorded for this problem.</p>:<ol className="si-evidence">{votes.slice(0,20).map(v=><Evidence key={v.id} vote={v} onOpenThread={onOpenThread}/>)}</ol>}{votes.length>20&&<p className="si-muted">Showing the latest 20 pointers. Ledger exports retain all {votes.length}.</p>}</section>
    <details className="si-metadata"><summary>Record details</summary><dl><dt>Recorded</dt><dd>{date(problem.createdAtMs)}</dd><dt>Category</dt><dd>{problem.category}</dd><dt>Aliases</dt><dd>{problem.aliases.join(", ")||"None"}</dd></dl></details>
  </div>;
}
function Evidence({vote,onOpenThread}:{vote:Vote;onOpenThread:(id:string)=>void}) {
  const e=vote.evidence;
  return <li><div><strong>{vote.kind.replaceAll("_"," ")}</strong><time dateTime={Number.isFinite(new Date(vote.occurredAtMs).getTime())?new Date(vote.occurredAtMs).toISOString():undefined}>{date(vote.occurredAtMs)}</time></div>{e.kind==="thread"?<><button className="si-link-button" aria-label={`Open thread ${e.threadId}`} onClick={()=>onOpenThread(e.threadId)}>{e.threadId}</button><small>Turn index {e.turnIndex} · event {e.eventId}</small></>:<><code>{e.kind==="task"?e.taskId:e.jobId}</code><small>Run {e.runId}</small></>}</li>;
}
function SolutionDetail({api,solution:s,data,selectProblem,retest,retestBusy,queuedJob,message}:{api:DashboardApi;solution:Solution;data:DashboardData;selectProblem:(p:Problem)=>void;retest:()=>void;retestBusy:boolean;queuedJob?:string;message?:{text:string;error:boolean}}) {
  const ranking=data.ranking.find(r=>r.solutionId===s.id), verification=data.verifications?.[s.id];
  const retests=(data.retests??[]).filter(r=>r.solutionId===s.id).sort((a,b)=>b.atMs-a.atMs);
  const pending=retests.find(r=>r.status==="queued"||r.status==="running");
  const localPending=!!queuedJob&&!retests.some(r=>r.jobId===queuedJob);
  const historyIds=new Set([s.id,...s.aliases]);
  const costs=data.costs.events?.filter(e=>e.solutionId!==undefined&&historyIds.has(e.solutionId))??[];
  const url=s.sourcePaper?safeUrl(s.sourcePaper.url):null;
  return <div className="si-detail-body">
    {data.activation?.[s.id] && <section><h3>Current activation</h3><Badge tone="warn">From an earlier version · not applied</Badge><p>{data.activation[s.id]!.reason}</p></section>}
    {(established(s)||s.status==="fixing")&&<section className="si-retest"><div><h3>Does it still work?</h3><p>A fresh validation run keeps earlier results in the history.</p></div><button className="si-button" onClick={retest} disabled={retestBusy||!!pending||localPending||!data.versions[`solutions:${s.id}`]}>{retestBusy?"Queuing re-test…":pending?.status==="running"?"Re-test running":pending||localPending?"Re-test queued":"Re-test solution"}</button>{!data.versions[`solutions:${s.id}`]&&<p className="si-muted">Refresh to load an editable record version.</p>}{message?.text&&<p className={message.error?"si-action-error":"si-action-success"} role={message.error?"alert":"status"}>{message.text}</p>}</section>}
    <section><h3>The idea</h3><p>{s.mechanism}</p><div className="si-origin"><Badge>{s.origin==="inventor"?"Invented":"From research"}</Badge>{url&&<a href={url} target="_blank" rel="noopener noreferrer">Read source paper ↗</a>}{s.sourcePaper&&<span className="si-muted">Credibility: {s.sourcePaper.credibility.status}</span>}</div></section>
    <section><h3>Expected change</h3><p>{s.prediction.change}</p><dl className="si-kpi"><dt>{s.prediction.kpi.name}</dt><dd>Target {s.prediction.kpi.target} · {s.prediction.kpi.direction} is better</dd></dl><p className="si-section-note">A prediction becomes evidence only after testing and observation.</p></section>
    <section><h3>Test plan</h3><p>{s.testPlan}</p>{s.assumptions.length>0&&<details className="si-metadata"><summary>Assumptions</summary><ul className="si-prose-list">{s.assumptions.map((a,i)=><li key={i}>{a}</li>)}</ul></details>}</section>
    <Portability declaration={s.portability}/>
    {ranking&&<section><h3>Build queue</h3><p>{ranking.rank===null?"Not currently ranked":`Position ${ranking.rank}`}{ranking.score===null?" · score unavailable":` · score ${ranking.score.toFixed(3)}`}</p>{ranking.reasons.length>0&&<ul className="si-prose-list">{ranking.reasons.map((r,i)=><li key={i}>{r}</li>)}</ul>}{ranking.missingFactors.length>0&&<p className="si-muted">Unknown factors: {ranking.missingFactors.join(", ")}</p>}</section>}
    <section><h3>Measured effect</h3>{verification?<><Badge tone={verification.verdict==="WORSE"?"bad":verification.verdict==="SOLVED"||verification.verdict==="REDUCED"?"good":"neutral"}>{verification.verdict}</Badge><dl className="si-rate-grid"><div><dt>Before · votes/session</dt><dd>{verification.beforeRate===null?"Unknown":verification.beforeRate.toFixed(3)}</dd></div><div><dt>After · votes/session</dt><dd>{verification.afterRate===null?"Unknown":verification.afterRate.toFixed(3)}</dd></div></dl>{[...verification.reasons,...verification.confounders].map((r,i)=><p className="si-muted" key={i}>{r}</p>)}</>:<p className="si-muted">No before/after verification is included in this snapshot. A successful test alone does not establish long-term improvement.</p>}</section>
    <section><h3>Problems it targets</h3><div className="si-linked-list">{s.problemIds.map(id=>{const p=data.problems.find(p=>p.id===id);return p?<button key={id} className="si-linked" aria-label={`View problem ${problemTitle(p,data)}`} onClick={()=>selectProblem(p)}><span>{problemTitle(p,data)}</span><Glyph kind="arrow"/></button>:<p key={id} className="si-muted">{id} · record unavailable</p>;})}</div></section>
    <section><h3>Attempts and re-tests</h3>{!s.attempts.length&&!retests.length?<p className="si-muted">No completed attempts recorded yet.</p>:<ol className="si-history">{[...s.attempts].sort((a,b)=>b.atMs-a.atMs).map(a=><li key={a.id}><span className={`si-history-dot${a.outcome==="failed"?" si-history-dot-bad":""}`}/><div><div className="si-history-heading"><strong>{a.outcome}</strong><time>{date(a.atMs)}</time></div><p>{a.reason}</p><small>{a.model.provider} · {a.model.model}</small>{a.evidenceIds.length>0&&<details><summary>Evidence references</summary><ul>{a.evidenceIds.map(id=><li key={id}><code>{id}</code></li>)}</ul></details>}</div></li>)}{retests.map(r=><li key={r.jobId}><span className="si-history-dot"/><div><div className="si-history-heading"><strong>Re-test · {r.status.replaceAll("-", " ")}</strong><time>{date(r.atMs)}</time></div><p>{r.reason}</p>{r.evidenceKind && <p>Test run · {r.observationVerdict==="gain-without-regression"?"passed":r.observationVerdict?"did not pass":"outcome pending"}.</p>}<code>{r.jobId}</code></div></li>)}</ol>}</section>
    {s.revisitHistory.length>0&&<section><h3>Model and provider revisits</h3><ul className="si-prose-list">{s.revisitHistory.map((r,i)=><li key={i}><strong>{r.decision}</strong> · {r.reason}<small>{r.from.provider}/{r.from.model} → {r.to.provider}/{r.to.model} · {date(r.atMs)}</small></li>)}</ul></section>}
    <section><h3>Cost of this solution</h3>{s.aliases.length>0&&<p className="si-section-note">Includes retained solution aliases. Original attribution stays in the ledger.</p>}{costs.length?<><ul className="si-cost-list">{[...new Set(costs.map(c=>c.currency))].map(currency=>{const entries=costs.filter(c=>c.currency===currency);return <li key={currency}><strong>{money(entries.reduce((sum,e)=>sum+(e.amountMicros??0),0),currency)}</strong><span>owner-reported charges + estimates · {entries.filter(e=>e.amountMicros===null).length} unknown</span></li>;})}</ul><p className="si-section-note">Shared mining and scouting costs remain in the overall total.</p></>:<p className="si-muted">No directly attributed costs recorded. Shared or unknown costs may still apply.</p>}<ActivityCosts value={data.costs.activityBySolution?.[s.id]}/></section>
    <details className="si-metadata"><summary>Record details</summary><dl><dt>Wired at</dt><dd>{s.wiring?.location??"Not wired"}</dd><dt>Observed executions</dt><dd>{s.wiring?.executionCount??"Not recorded"}</dd><dt>How to undo</dt><dd>{s.wiring?.undo??"Not recorded"}</dd><dt>Built with</dt><dd>{s.builtWith?`${s.builtWith.provider} / ${s.builtWith.model}`:"Not built"}</dd><dt>Validated with</dt><dd>{s.validatedWith?`${s.validatedWith.provider} / ${s.validatedWith.model}`:"Not validated"}</dd><dt>Aliases</dt><dd>{s.aliases.join(", ")||"None"}</dd></dl></details>
    {established(s)&&<ExportSolution api={api} repositories={data.health.publicationRepositories} solutionId={s.id} expectedVersion={data.versions[`solutions:${s.id}`]}/>}
  </div>;
}
