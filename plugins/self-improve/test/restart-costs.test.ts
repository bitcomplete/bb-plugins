import {expect,it} from "vitest";
import Database from "better-sqlite3";
import {Store,MIGRATIONS} from "../src/store.js";
import {Accounting} from "../src/costs.js";
it("reconciles interrupted calls as unknown and retains their budget headroom",()=>{
  const db=new Database(":memory:");MIGRATIONS.forEach(sql=>db.exec(sql));
  try{
    const store=new Store(db),policy=()=>({currency:"USD",dailyMicros:200,monthlyMicros:200,maxDailyCalls:10,allowUnknown:false,prices:{model:{input:1,output:1,cacheRead:1,cacheWrite:1,version:"price-v1"}}});
    const before=new Accounting(store,policy);before.reserve({id:"first",model:"model",inputBound:100,outputBound:100,scope:"builder"});
    const after=new Accounting(store,policy);expect(after.recoverInterrupted()).toBe(1);expect(after.recoverInterrupted()).toBe(0);
    expect(after.summary().pending).toHaveLength(0);expect(after.summary().totals[0].unknownAttempts).toBe(1);
    expect(()=>after.reserve({id:"next",model:"model",inputBound:1,outputBound:1,scope:"builder"})).toThrow("budget-exhausted");
  }finally{db.close();}
});
