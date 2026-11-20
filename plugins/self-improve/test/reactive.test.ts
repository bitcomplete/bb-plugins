import { expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerReactive } from "../src/reactive.js";
import { defaultConfig } from "../src/config.js";
import { MIGRATIONS, Store } from "../src/store.js";
import { Accounting } from "../src/costs.js";

it("does not read context or reserve detector cost while scheduled learning is paused", async () => {
  const list=vi.fn(async()=>[]), enqueue=vi.fn();
  const {bb,harness}=createFakePluginHost({pluginId:"self-improve",sdk:{threads:{events:{list}}}});
  try {
    const db=bb.storage.database();bb.storage.migrate(db,MIGRATIONS);const store=new Store(db);
    const config=defaultConfig();config.laya={enabled:true,endpoint:"https://example.invalid",minConfidence:.8};config.budgets.allowUnknown=true;
    const accounting=new Accounting(store,()=>config.budgets);
    registerReactive({bb,store,accounting,config:()=>config,enabled:()=>false,privacy:()=>({}),redact:s=>s,owns:()=>false,enqueue});
    const result=await harness.behavior.emitThreadEvent("experimental_thread.events",{thread:makeThreadResponse({id:"ordinary-thread"}),sequence:10});
    expect(result.errors).toEqual([]);expect(list).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();expect(accounting.summary().pending).toEqual([]);expect(accounting.summary().events).toEqual([]);
  } finally {await harness.lifecycle.dispose();}
});
