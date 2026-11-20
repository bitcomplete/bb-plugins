import { useEffect, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, experimental_PermissionModePicker as PermissionModePicker, useRpc, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract.js";
import type { ExecutionSettingsView } from "../native-execution.js";

export function ExecutionSettings({ refreshKey, onSaved }: { refreshKey: number; onSaved(): void }) {
  const rpc=useRpc<typeof rpcContract>();
  const [saved,setSaved]=useState<ExecutionSettingsView|null>(null),[error,setError]=useState("");
  const [selection,setSelection]=useState<ExperimentalProviderModelPickerValue>({providerId:"",model:"",reasoningLevel:"medium"});
  const [permission,setPermission]=useState<"accept-edits"|"auto"|"full">("accept-edits");
  const [busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[notice,setNotice]=useState(""),[stale,setStale]=useState(false);
  const [target,setTarget]=useState({projectId:"",environmentId:""});
  const [options,setOptions]=useState<{projects:Array<{id:string;name:string}>;environments:Array<{id:string;projectId:string;label:string}>}|null>(null);
  useEffect(()=>{let live=true;void rpc.call("workerOptions",{}).then(value=>{if(live)setOptions(value);}).catch(()=>{if(live)setOptions({projects:[],environments:[]});});return ()=>{live=false;};},[rpc,refreshKey]);
  useEffect(()=>{
    let live=true;
    void rpc.call("getExecution",{}).then(value=>{if(!live)return;if(dirty){if(saved?.revision !== value.revision){setStale(true);setError("Configuration changed while you were editing. Reload before saving.");}return;}setSaved(value);setTarget({projectId:value.projectId,environmentId:value.environmentId});setSelection(value.selection);setPermission(value.permissionMode);setError("");setStale(false);}).catch(()=>{if(live)setError("Execution settings could not be loaded.");});
    return ()=>{live=false;};
  },[rpc,refreshKey,dirty,saved?.revision]);
  const ready=!!target.projectId&&!!target.environmentId;
  const routing=target.environmentId?{kind:"environment" as const,environmentId:target.environmentId}:undefined;
  const environments=options?.environments.filter(e=>e.projectId===target.projectId)??[];
  const save=async()=>{
    if(!saved||!ready||busy||stale)return;setBusy(true);setError("");setNotice("");
    try {
      const value=await rpc.call("setExecution",{expectedRevision:saved.revision,selection:{...selection,permissionMode:permission,projectId:target.projectId,environmentId:target.environmentId}});
      setSaved(value);setSelection(value.selection);setPermission(value.permissionMode);setDirty(false);setNotice("Execution settings saved. Existing evidence keeps its original provider and model.");onSaved();
    } catch(e) {setError(e instanceof Error?e.message.slice(0,300):"Execution settings could not be saved.");}
    finally {setBusy(false);}
  };
  return <section className="si-root si-execution" aria-label="Self improve execution settings"><details open={!saved?.selection.model||undefined}><summary>Execution · {saved?.selection.providerId||"Choose a BB provider"}{saved?.selection.model?` / ${saved.selection.model}`:""}</summary>
    <p>Agent work runs in the environment you choose here, with its ordinary tools. A scratch environment is safest: in accept-edits mode agents can change its files. Self improve uses your existing BB sign-in.</p>
    <div className="si-header-actions">
      <label className="si-filter"><span>Project</span><select value={target.projectId} disabled={busy||stale||!options} onChange={e=>{setTarget({projectId:e.target.value,environmentId:""});setDirty(true);setNotice("");}}>
        <option value="">{options?"Choose a project":"Loading…"}</option>{options?.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="si-filter"><span>Environment</span><select value={target.environmentId} disabled={busy||stale||!target.projectId} onChange={e=>{setTarget({...target,environmentId:e.target.value});setDirty(true);setNotice("");}}>
        <option value="">{target.projectId&&!environments.length?"No ready environments":"Choose an environment"}</option>{environments.map(e=><option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
      <ProviderModelPicker value={selection} onChange={value=>{setSelection(value);setDirty(true);setNotice("");}} routing={routing} disabled={!ready||busy||stale}/>
      <PermissionModePicker providerId={selection.providerId} value={permission} onChange={value=>{setPermission(value);setDirty(true);setNotice("");}} routing={routing} disabled={!ready||!selection.providerId||busy||stale}/>
      <button className="si-button si-button-primary" onClick={()=>void save()} disabled={!ready||!selection.providerId||!selection.model||busy||!dirty||stale}>{busy?"Saving…":"Save execution"}</button>
    </div>
    {error&&<p role="alert">{error}</p>}{stale&&<button className="si-button" onClick={()=>{setDirty(false);setNotice("");}}>Reload execution settings</button>}{notice&&<p role="status">{notice}</p>}
  </details></section>;
}
