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
  useEffect(()=>{
    let live=true;
    void rpc.call("getExecution",{}).then(value=>{if(!live)return;if(dirty){if(saved?.revision !== value.revision){setStale(true);setError("Configuration changed while you were editing. Reload before saving.");}return;}setSaved(value);setSelection(value.selection);setPermission(value.permissionMode);setError("");setStale(false);}).catch(()=>{if(live)setError("Execution settings could not be loaded.");});
    return ()=>{live=false;};
  },[rpc,refreshKey,dirty,saved?.revision]);
  const ready=!!saved?.projectId&&!!saved?.environmentId;
  const routing=saved?.environmentId?{kind:"environment" as const,environmentId:saved.environmentId}:undefined;
  const save=async()=>{
    if(!saved||!ready||busy||stale)return;setBusy(true);setError("");setNotice("");
    try {
      const value=await rpc.call("setExecution",{expectedRevision:saved.revision,selection:{...selection,permissionMode:permission,projectId:saved.projectId,environmentId:saved.environmentId}});
      setSaved(value);setSelection(value.selection);setPermission(value.permissionMode);setDirty(false);setNotice("Execution settings saved. Existing evidence keeps its original provider and model.");onSaved();
    } catch(e) {setError(e instanceof Error?e.message.slice(0,300):"Execution settings could not be saved.");}
    finally {setBusy(false);}
  };
  return <section className="si-root si-execution" aria-label="Self improve execution settings"><details><summary>Execution · {saved?.selection.providerId||"Choose a BB provider"}{saved?.selection.model?` / ${saved.selection.model}`:""}</summary>
    <p>Use your existing BB sign-in and provider routing. Ordinary workspace instructions and tools may remain available.</p>
    {!ready&&<p>Choose a worker project and environment in Self improve’s Configuration setting first. Provider choices are resolved for that environment.</p>}
    <div className="si-header-actions">
      <ProviderModelPicker value={selection} onChange={value=>{setSelection(value);setDirty(true);setNotice("");}} routing={routing} disabled={!ready||busy||stale}/>
      <PermissionModePicker providerId={selection.providerId} value={permission} onChange={value=>{setPermission(value);setDirty(true);setNotice("");}} routing={routing} disabled={!ready||!selection.providerId||busy||stale}/>
      <button className="si-button si-button-primary" onClick={()=>void save()} disabled={!ready||!selection.providerId||!selection.model||busy||!dirty||stale}>{busy?"Saving…":"Save execution"}</button>
    </div>
    {error&&<p role="alert">{error}</p>}{stale&&<button className="si-button" onClick={()=>{setDirty(false);setNotice("");}}>Reload execution settings</button>}{notice&&<p role="status">{notice}</p>}
  </details></section>;
}
